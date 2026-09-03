// =====================================================================
// KIDS TV — GOOGLE DRIVE VIDEO STREAMER (Cloudflare Pages Function)
// =====================================================================
// This is the exact same job netlify/edge-functions/stream-video.js does —
// find Google Drive's real download link for a video and hand the bytes
// straight to the TV — just running on Cloudflare instead of Netlify.
//
// WHY THIS FILE EXISTS: Netlify's free plan bills by "credits" (bandwidth,
// deploys, requests all draw from the same pool), and when that pool hits
// zero, Netlify takes the ENTIRE site offline — not just video, the whole
// dashboard — until the next monthly reset, with no free way to get more
// credits early. That happened twice. Cloudflare Pages' free plan doesn't
// bill for bandwidth at all, so the exact same kind of month, repeated,
// can't lock the TVs out again.
//
// A file placed at functions/watch-video.js in this repo is automatically
// served at the path /watch-video by Cloudflare Pages — no separate setup,
// no config file, nothing else to wire up. index.html already asks for
// "/watch-video?id=..." as its last-resort video source, so it finds this
// automatically once this whole repo is deployed to Cloudflare Pages
// instead of Netlify. Nothing in index.html needs to change for this part.
//
// Everything below (finding Google's real link, following its warning
// page, streaming the bytes through) is identical in spirit to the Netlify
// version — only the outer "here's how Cloudflare hands me a request"
// wrapper at the bottom is different, because that's the one part that
// really does vary between hosts. The actual fetch()/Response/Headers
// objects used throughout are the same standard web APIs on both, so the
// logic underneath didn't need to change at all.
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

// When none of resolveNextUrlFromHtml's three known "here's the real
// download link" shapes match, that alone doesn't say WHY — it could be a
// wrong/deleted file id, a file that was never actually shared publicly, or
// some other Google page we've never seen. Rather than send back one generic
// guess every time, look at what Google actually did and say THAT.
function classifyUnresolvedPage(html, finalUrl) {
  if (finalUrl && /accounts\.google\.com/.test(finalUrl)) {
    return (
      'Google asked us to sign in before it would show this file — meaning this ' +
      'specific file isn\'t shared as "Anyone with the link," even though the folder ' +
      'it\'s in might be. Ask your director to open this exact file in Google Drive, ' +
      'click Share, and set it to "Anyone with the link" (Viewer is enough).'
    );
  }

  if (/not found|no longer available|may have been removed|doesn['’]t exist|does not exist/i.test(html)) {
    return (
      "Google says this file doesn't exist anymore — the file ID in the Google Sheet may " +
      "have a typo, or the video may have been deleted (including moved to the trash). " +
      "Ask your director to re-copy the file's link from Google Drive and update the sheet."
    );
  }

  if (/request access|you (need|['’]ll need) (access|permission)/i.test(html)) {
    return (
      'Google says whoever opens this link would need to "request access" — this file is ' +
      'set to "Restricted" instead of "Anyone with the link." Ask your director to open it ' +
      'in Google Drive, click Share, and change it to "Anyone with the link."'
    );
  }

  return null;
}

// (Exported alongside the handler purely so this logic can be exercised by an
// automated test without hitting real Google Drive.)
export { resolveNextUrlFromHtml, collectCookies, classifyUnresolvedPage };

const RESOLVED_CACHE_MS = 4 * 60 * 1000; // 4 minutes
const resolvedCache = new Map(); // fileId -> { url, cookieHeader, expiresAt }

async function resolveAndStream(startUrl, startCookieHeader, rangeHeader) {
  let url = startUrl;
  let cookieHeader = startCookieHeader;

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

    if (!contentType.startsWith("text/html")) {
      const headers = new Headers();
      ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"].forEach((h) => {
        const v = response.headers.get(h);
        if (v) headers.set(h, v);
      });
      return {
        found: true,
        resolvedUrl: url,
        cookieHeader,
        response: new Response(response.body, { status: response.status, headers }),
      };
    }

    const html = await response.text();
    const nextUrl = resolveNextUrlFromHtml(html);

    if (!nextUrl) {
      const specific = classifyUnresolvedPage(html, response.url);
      let message = specific;
      if (!message) {
        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null;
        message =
          "Couldn't find a download link on Google Drive's page for this file. " +
          'Ask your director to check it\'s still shared as "Anyone with the link."' +
          (title ? ` (Google's page was titled "${title}".)` : "");
      }
      return { found: false, response: new Response(message, { status: 502 }) };
    }

    url = nextUrl;
  }

  return {
    found: false,
    response: new Response("Google Drive kept redirecting without ever reaching the file.", { status: 504 }),
  };
}

// If a Google API key is available (set it in Cloudflare Pages under
// Settings → Environment variables, named GOOGLE_API_KEY), skip the whole
// business of reading Google's warning page and just ask Google's official
// API for the file. Optional — with no key set, everything below works
// exactly as if this function had never heard of it.
async function streamByApi(fileId, apiKey, rangeHeader) {
  const apiUrl =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(fileId) +
    "?alt=media&key=" + encodeURIComponent(apiKey);

  const response = await fetch(apiUrl, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT, ...(rangeHeader ? { Range: rangeHeader } : {}) },
  });

  if (response.ok || response.status === 206) {
    const headers = new Headers();
    ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"].forEach((h) => {
      const v = response.headers.get(h);
      if (v) headers.set(h, v);
    });
    return new Response(response.body, { status: response.status, headers });
  }

  let detail = "";
  try {
    const body = await response.json();
    detail = (body && body.error && body.error.message) || "";
  } catch (e) {}

  if (response.status === 404) {
    return new Response(
      "Google says this file doesn't exist. The file ID in the Google Sheet may be wrong, or the " +
        "video was deleted or moved to the trash. " + detail,
      { status: 502 }
    );
  }
  if (response.status === 403) {
    return new Response(
      'Google refused this file. Usually that means it is not shared as "Anyone with the link," or ' +
        "the API key is restricted. " + detail,
      { status: 502 }
    );
  }
  return new Response("Google returned an error (" + response.status + "). " + detail, { status: 502 });
}

// Cloudflare Pages Functions receive one "context" object per request,
// with the request itself, environment variables, and a few other things
// bundled inside it — this is the one piece that's genuinely different
// from Netlify's version (which read env vars via a Netlify- or Deno-
// specific global instead of a parameter it's simply handed directly).
export async function onRequestGet(context) {
  const { request, env } = context;
  const fileId = new URL(request.url).searchParams.get("id");

  if (!fileId || !FILE_ID_PATTERN.test(fileId)) {
    return new Response("Missing or invalid Drive file id.", { status: 400 });
  }

  const rangeHeader = request.headers.get("range");

  try {
    const apiKey = (env && env.GOOGLE_API_KEY) || "";
    if (apiKey) return await streamByApi(fileId, apiKey, rangeHeader);

    const now = Date.now();
    const cached = resolvedCache.get(fileId);

    if (cached && cached.expiresAt > now) {
      const attempt = await resolveAndStream(cached.url, cached.cookieHeader, rangeHeader);
      if (attempt.found) {
        resolvedCache.set(fileId, {
          url: attempt.resolvedUrl,
          cookieHeader: attempt.cookieHeader,
          expiresAt: now + RESOLVED_CACHE_MS,
        });
        return attempt.response;
      }
      resolvedCache.delete(fileId);
    }

    const fresh = await resolveAndStream(
      `https://drive.google.com/uc?id=${encodeURIComponent(fileId)}`,
      "",
      rangeHeader
    );
    if (fresh.found) {
      resolvedCache.set(fileId, {
        url: fresh.resolvedUrl,
        cookieHeader: fresh.cookieHeader,
        expiresAt: now + RESOLVED_CACHE_MS,
      });
    }
    return fresh.response;
  } catch (err) {
    return new Response("Drive link resolution failed: " + (err && err.message ? err.message : String(err)), {
      status: 502,
    });
  }
}
