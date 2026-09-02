// =====================================================================
// KIDS TV — GOOGLE DRIVE VIDEO LINK RESOLVER
// =====================================================================
// What this does, in plain terms: the TV app asks this tiny helper
// "where's the real video for this Drive file?" and this helper does the
// annoying part — talking to Google Drive on the TV's behalf — and sends
// back a "go look over there" answer pointing at the real video.
//
// Why this exists: Google Drive shows a "Google Drive can't scan this
// file for viruses" warning page instead of the actual video for larger
// files (which lesson videos almost always are) — a real, well-known
// Drive quirk, not a mistake in the sharing settings. A web page's own
// JavaScript is blocked by browser security rules (CORS) from reading
// that warning page itself to work around it. A tiny helper running on
// Netlify's servers has no such restriction, so it does the same thing a
// real person would do by hand — open the warning page, find the actual
// "download anyway" link hidden in it, and follow that instead — and
// hands the TV the resolved link. This is the same technique used by
// gdown, a well-known, actively-maintained open-source tool built
// specifically to reliably download Google Drive files programmatically;
// this function re-implements its approach in JavaScript.
//
// This file changes nothing about how Mom uploads videos — she still
// just drags files into the Google Drive folders, same as always. This
// only affects the small plumbing step of how the TV fetches the actual
// video bytes once a teacher presses a button.
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
  // Unescapes both the two sequences Google's own pages are known to use
  // ( = for "=", & for "&" ) and, defensively, a literal "\/"
  // (a common — if here unconfirmed — way JSON gets embedded inside a
  // <script> block); harmless if a given page never uses that form.
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

// (Exported alongside `handler` purely so this logic can be exercised by an
// automated test without hitting real Google Drive — Netlify only ever
// looks up `exports.handler`, so this has no effect on how the function runs.)
exports.resolveNextUrlFromHtml = resolveNextUrlFromHtml;
exports.collectCookies = collectCookies;

exports.handler = async (event) => {
  const fileId = event.queryStringParameters && event.queryStringParameters.id;

  if (!fileId || !FILE_ID_PATTERN.test(fileId)) {
    return { statusCode: 400, body: "Missing or invalid Drive file id." };
  }

  let url = `https://drive.google.com/uc?id=${encodeURIComponent(fileId)}`;
  let cookieHeader = "";

  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      });

      cookieHeader = collectCookies(response, cookieHeader);
      const contentType = response.headers.get("content-type") || "";

      // Not an HTML confirmation page — this is the real video, sitting
      // right where we asked for it. Send the TV straight there instead
      // of relaying the (potentially huge) video through this helper.
      if (!contentType.startsWith("text/html")) {
        return {
          statusCode: 302,
          headers: { Location: response.url || url, "Cache-Control": "no-store" },
          body: "",
        };
      }

      const html = await response.text();
      const nextUrl = resolveNextUrlFromHtml(html);

      if (!nextUrl) {
        return {
          statusCode: 502,
          body:
            "Couldn't find a download link on Google Drive's page for this file. " +
            "Ask your director to check it's still shared as \"Anyone with the link.\"",
        };
      }

      url = nextUrl;
    }

    return { statusCode: 504, body: "Google Drive kept redirecting without ever reaching the file." };
  } catch (err) {
    return { statusCode: 502, body: "Drive link resolution failed: " + (err && err.message ? err.message : String(err)) };
  }
};
