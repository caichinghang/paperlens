// Web access for the assistant: search (Tavily when the reader adds a key, then Bing's and
// DuckDuckGo's result pages) and plain-text extraction for reading a page. Requests run from the
// extension page, whose host permissions allow them. Responses are parsed with DOMParser, which
// never runs scripts or loads subresources.

const TAVILY_URL = "https://api.tavily.com/search";
const BING_URL = "https://www.bing.com/search";
const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";
const TIMEOUT_MS = 15_000;
const MAX_PAGE_CHARS = 12_000;
const BLOCK_ELEMENTS = "p, div, li, dt, dd, h1, h2, h3, h4, h5, h6, br, tr, section, article, blockquote, pre, table, ul, ol";
const NOISE_ELEMENTS = "script, style, noscript, template, svg, canvas, iframe, object, nav, header, footer, aside, form, button, [hidden], [aria-hidden='true']";
const MAX_REDIRECTS = 5;

function clean(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function blockedIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a >= 224;
}

function blockedIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) {
    return false;
  }
  if (host === "::" || host === "::1" || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") || /^[fd]/.test(host)) {
    return true;
  }
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? blockedIpv4(mapped[1]) : false;
}

// Extension fetches can reach hosts ordinary pages cannot. Keep the model away from loopback,
// link-local and private networks, and re-run this check for every redirect.
export function publicWebUrl(address, base) {
  let url;
  try {
    url = new URL(String(address ?? "").trim(), base);
  } catch {
    throw new Error("Pass a full http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https pages can be read.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.username || url.password || hostname === "localhost" || hostname.endsWith(".localhost") || blockedIpv4(hostname) || blockedIpv6(hostname)) {
    throw new Error("Local and private-network addresses can't be read.");
  }
  return url;
}

async function request(address, failure) {
  let url = publicWebUrl(address);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response;
    try {
      response = await fetch(url.href, { credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new Error(error?.name === "TimeoutError" ? "The request timed out." : failure);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      // Some fetch implementations expose the final URL even without a visible redirect response.
      publicWebUrl(response.url || url.href);
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("The page redirected without a destination.");
    }
    url = publicWebUrl(location, url.href);
  }
  throw new Error("The page redirected too many times.");
}

// Result links go through a DuckDuckGo redirect that carries the real address in `uddg`.
function resultUrl(href) {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    return url.searchParams.get("uddg") || url.href;
  } catch {
    return "";
  }
}

async function searchTavily(query, limit, key) {
  let response;
  try {
    response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: limit, search_depth: "basic" }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? "The request timed out." : "Couldn't reach Tavily.");
  }
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403 ? "the API key was rejected" : `HTTP ${response.status}`);
  }
  const payload = await response.json();
  return (payload.results || [])
    .filter(item => /^https?:\/\//i.test(item?.url || ""))
    .slice(0, limit)
    .map(item => ({ title: clean(item.title), url: item.url, snippet: clean(item.content).slice(0, 500) }));
}

// Bing wraps result links in a click-tracking redirect whose `u` parameter is "a1" + base64url(address).
function bingTarget(href) {
  try {
    const url = new URL(href, "https://www.bing.com");
    const encoded = url.hostname.endsWith("bing.com") ? url.searchParams.get("u") : null;
    if (encoded?.startsWith("a1")) {
      const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      return new TextDecoder().decode(Uint8Array.from(atob(padded), character => character.charCodeAt(0)));
    }
    return url.hostname.endsWith("bing.com") ? "" : url.href;
  } catch {
    return "";
  }
}

async function searchBing(query, limit) {
  const response = await request(`${BING_URL}?q=${encodeURIComponent(query)}&count=${Math.max(limit, 10)}`, "Couldn't reach Bing.");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const doc = new DOMParser().parseFromString(await response.text(), "text/html");
  const results = [];
  for (const item of doc.querySelectorAll("#b_results > li.b_algo")) {
    const link = item.querySelector("h2 a");
    const url = link ? bingTarget(link.getAttribute("href")) : "";
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    const snippet = item.querySelector(".b_caption p, [class*='b_lineclamp'], .b_algoSlug, p");
    results.push({ title: clean(link.textContent), url, snippet: clean(snippet?.textContent) });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

// Tries each engine in turn and returns the first non-empty result list, with the engine that found it.
export async function searchWeb(query, limit = 6, { tavilyKey = "" } = {}) {
  const engines = [
    ...(tavilyKey ? [["Tavily", () => searchTavily(query, limit, tavilyKey)]] : []),
    ["Bing", () => searchBing(query, limit)],
    ["DuckDuckGo", () => searchDuckDuckGo(query, limit)]
  ];
  const failures = [];
  let answered = false;
  for (const [engine, run] of engines) {
    try {
      const results = await run();
      answered = true;
      if (results.length) {
        return { engine, results };
      }
    } catch (error) {
      failures.push(`${engine}: ${error.message}`);
    }
  }
  if (answered) {
    return { engine: "", results: [] };
  }
  throw new Error(`Web search failed (${failures.join("; ")}). Try again later, or answer without web results.`);
}

async function searchDuckDuckGo(query, limit) {
  const response = await request(`${DUCKDUCKGO_URL}?q=${encodeURIComponent(query)}`, "Couldn't reach DuckDuckGo.");
  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const results = [];
  for (const item of doc.querySelectorAll(".result")) {
    if (item.classList.contains("result--ad")) {
      continue;
    }
    const link = item.querySelector(".result__a");
    const url = link ? resultUrl(link.getAttribute("href")) : "";
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    results.push({ title: clean(link.textContent), url, snippet: clean(item.querySelector(".result__snippet")?.textContent) });
    if (results.length >= limit) {
      break;
    }
  }

  // DuckDuckGo answers suspected bots with a challenge page (HTTP 202) instead of results.
  if (!results.length && (response.status === 202 || /anomaly/i.test(html))) {
    throw new Error("it refused the request as automated");
  }
  if (!response.ok && !results.length) {
    throw new Error(`HTTP ${response.status}`);
  }
  return results;
}

function readableText(root) {
  for (const element of root.querySelectorAll(BLOCK_ELEMENTS)) {
    element.after("\n");
  }
  return root.textContent
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readWebpage(address) {
  const url = publicWebUrl(address);

  const response = await request(url.href, "Couldn't load the page.");
  if (!response.ok) {
    throw new Error(`The page returned HTTP ${response.status}.`);
  }
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (type.includes("pdf")) {
    throw new Error("That link is a PDF, which can't be read as a web page.");
  }
  if (type && !/html|xml|text\/|json/.test(type)) {
    throw new Error(`Unsupported content type (${type.split(";")[0]}).`);
  }

  const body = await response.text();
  let title = "";
  let text = body;
  if (!type || type.includes("html")) {
    const doc = new DOMParser().parseFromString(body, "text/html");
    title = clean(doc.title);
    for (const element of doc.querySelectorAll(NOISE_ELEMENTS)) {
      element.remove();
    }
    text = readableText(doc.querySelector("article, main, [role='main']") || doc.body || doc.documentElement);
  }

  const finalUrl = publicWebUrl(response.url || url.href).href;
  const truncated = text.length > MAX_PAGE_CHARS;
  return {
    url: finalUrl,
    site: new URL(finalUrl).hostname.replace(/^www\./, ""),
    title,
    text: truncated ? `${text.slice(0, MAX_PAGE_CHARS)}…` : text,
    truncated
  };
}
