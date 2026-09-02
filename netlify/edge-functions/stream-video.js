// =====================================================================
// KIDS TV — GOOGLE DRIVE VIDEO STREAMER (runs at Netlify's network edge)
// =====================================================================
// What this does, in plain terms: the TV asks this helper "play this
// video for me," and it does two jobs in a single round trip — it finds
// Google Drive's real, per-request download link (the same job the
// older resolve-video.js function did), AND it then actually fetches
// the video itself and hands the bytes straight to the TV as they
// arrive, as if the video had been sitting on this same website the
// whole time.
//
// Why the extra step — a redirect to Google wasn't enough, even though
// it looked like it should be: real Chrome browsers (including the one
// inside the onn TV's kiosk app) have a security feature called ORB
// (Opaque Response Blocking) that silently blocks a <video> tag from
// playing a file that comes back from ANOTHER website, unless that
// website specifically says it's okay to share (via headers Google
// Drive's own servers don't send). Confirmed directly — not guessed —
// by watching Chrome's own Network panel: every attempt at a direct
// Google redirect showed up there as "(failed) net::ERR_BLOCKED_BY_ORB."
// Having this helper fetch the video itself and pass its bytes straight
// through makes the request look, to the browser, exactly like any
// other file already sitting on this same site — nothing "foreign" left
// for that safety feature to block.
//
// Why this lives in netlify/edge-functions (not netlify/functions,
// where resolve-video.js lives): confirmed directly against Netlify's
// own current docs that the older, classic kind of function caps a
// streamed response at 20MB and 60 seconds — nowhere near enough for a
// real lesson video. Netlify's edge functions (this file) run on a
// different, Deno-based runtime with no such response-size limit
// documented, which is exactly what letting a whole video stream
// through requires.
//
// This file changes nothing about how Mom uploads videos — she still
// just drags files into the Google Drive folders, same as always. It
// also changes nothing for teachers — same buttons, same screen. It's
// purely the plumbing of how the video's bytes physically travel from
// Google to the TV.
// =====================================================================

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_HOPS = 5;
const FILE_ID_PATTERN = /^[a-zA-Z0-9_-]{10,100}$/; // sanity check, not a security boundary

// Combines Set-Cookie headers from a response into a single "name=value; name2=value2"
// string suitable for a follow-up request's Cookie header — Google's confirmation
// flow can depend on a short-lived cookie set on the warning page.
function collectCookies(response, existingCookieHeader) {
  const jar = new Map();
  if (existingCookieHeader) {
    existingCookieHeader.split(";").forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx > -1) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    });
  }
  let setCookieValues = [];
  if (typeof response.headers.getSetCookie === "function") {
    setCookieValues = response.headers.getSetCookie();
  } else {
    const raw = response.headers.get("set-cookie");
    if (raw) setCookieValues = [raw];
  }
  setCookieValues.forEach((line) => {
    const firstPair = line.split(";")[0];
    const idx = firstPair.indexOf("=");
    if (idx > -1) jar.set(firstPair.slice(0, idx).trim(), firstPair.slice(idx + 1).trim());
  });
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// Mirrors gdown's get_url_from_gdrive_confirmation(): looks for Google's
// confirmation link in whichever of its three known shapes shows up on
// the warning page, and reconstructs a complete, self-contained URL
// (including whatever confirmation token Google generated) from it.
function resolveNextUrlFromHtml(html) {
  // Shape 1: a plain anchor pointing at the real download path.
  let m = html.match(/href="(\/uc\?export=download[^"]+)"/);
  if (m) {
    return "https://docs.google.com" + m[1].replace(/&amp;/g, "&");
  }

  // Shape 2: a <form id="download-form" action="..."> with hidden <input>
  // fields that all need to be folded into the final URL's query string.
  const formMatch = html.match(/<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
  if (formMatch) {
    const action = formMatch[1].replace(/&amp;/g, "&");
    const formBody = formMatch[2];
    const params = new URL(action, "https://docs.google.com").searchParams;
    const inputPattern = /<input[^>]*type="hidden"[^>]*>/g;
    let inputTag;
    while ((inputTag = inputPattern.exec(formBody))) {
      const nameMatch = inputTag[0].match(/name="([^"]*)"/);
      const valueMatch = inputTag[0].match(/value="([^"]*)"/);
      if (nameMatch) params.set(nameMatch[1], valueMatch ? valueMatch[1] : "");
    }
    const resolvedUrl = new URL(action, "https://docs.google.com");
    resolvedUrl.search = params.toString();
    return resolvedUrl.toString();
  }

  // Shape 3: the real URL sitting inside a chunk of embedded page JSON.
  m = html.match(/"downloadUrl":"([^"]+)"/);
  if (m) {
    return m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  }

  // A named error Google shows directly on the page (e.g. sharing was
  // changed, or too many people have viewed it) — surface it as-is.
  m = html.match(/<p class="uc-error-subcaption">(.*?)<\/p>/);
  if (m) {
    throw new Error(m[1].replace(/<[^>]+>/g, "").trim());
  }

  return null;
}

// (Exported alongside the handler purely so this logic can be exercised by an
// automated test without hitting real Google Drive — Netlify only ever looks
// for the default export, so this has no effect on how the function runs.)
export { resolveNextUrlFromHtml, collectCookies };

export default async (req) => {
  const fileId = new URL(req.url).searchParams.get("id");

  if (!fileId || !FILE_ID_PATTERN.test(fileId)) {
    return new Response("Missing or invalid Drive file id.", { status: 400 });
  }

  // Forwarded on every hop below. The early hops are just small HTML
  // confirmation pages (a Range header there is harmless and ignored),
  // but the final hop is the real video — carrying the TV's own Range
  // request through to it is what makes seeking/scrubbing work, instead
  // of the TV always having to restart the file from byte zero.
  const rangeHeader = req.headers.get("range");

  let url = `https://drive.google.com/uc?id=${encodeURIComponent(fileId)}`;
  let cookieHeader = "";

  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(rangeHeader ? { Range: rangeHeader } : {}),
        },
      });

      cookieHeader = collectCookies(response, cookieHeader);
      const contentType = response.headers.get("content-type") || "";

      // Not an HTML confirmation page — this is the real video. Stream it
      // straight through as our own response instead of redirecting the TV
      // to go fetch it separately (see the file header comment for why a
      // redirect alone doesn't work). Headers are mirrored faithfully from
      // Google's real response rather than assumed, so a 206 partial-content
      // reply (from the Range header above) comes through correctly too.
      if (!contentType.startsWith("text/html")) {
        const headers = new Headers();
        ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"].forEach((h) => {
          const v = response.headers.get(h);
          if (v) headers.set(h, v);
        });
        return new Response(response.body, { status: response.status, headers });
      }

      const html = await response.text();
      const nextUrl = resolveNextUrlFromHtml(html);

      if (!nextUrl) {
        return new Response(
          "Couldn't find a download link on Google Drive's page for this file. " +
            'Ask your director to check it\'s still shared as "Anyone with the link."',
          { status: 502 }
        );
      }

      url = nextUrl;
    }

    return new Response("Google Drive kept redirecting without ever reaching the file.", { status: 504 });
  } catch (err) {
    return new Response("Drive link resolution failed: " + (err && err.message ? err.message : String(err)), {
      status: 502,
    });
  }
};

export const config = { path: "/watch-video" };
