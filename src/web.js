// Web access for the assistant: search (Tavily when the reader adds a key, then Bing's and
// DuckDuckGo's result pages) and plain-text extraction for reading a page. Requests run from the
// extension page, whose host permissions allow them. Responses are parsed with DOMParser, which
// never runs scripts or loads subresources.

const TAVILY_URL = "https://api.tavily.com/search";
const BING_URL = "https://www.bing.com/search";
const BING_NEWS_URL = "https://www.bing.com/news/search";
// Bing News matches best on a few keywords; words like these only narrow a query to nothing.
const NEWS_FILLER = /\b(?:news|latest|today|today's|todays|this week|recent|recently|breaking|headlines?|major|biggest|big|top|announcements?|updates?)\b|新闻|最新|今天|今日|本周|头条|頭條|新聞/gi;
const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";
const TIMEOUT_MS = 15_000;
const MAX_PAGE_CHARS = 12_000;
const BLOCK_ELEMENTS = "p, div, li, dt, dd, h1, h2, h3, h4, h5, h6, br, tr, section, article, blockquote, pre, table, ul, ol";
const NOISE_ELEMENTS = "script, style, noscript, template, svg, canvas, iframe, object, nav, header, footer, aside, form, button, [hidden], [aria-hidden='true']";

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
// link-local and private networks, including when a public address redirects to one.
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
  const url = publicWebUrl(address);
  let response;
  try {
    // Browsers hide redirect responses from `redirect: "manual"` (status 0, no Location header), so
    // redirects are followed and the final address is checked before any of the body is used.
    response = await fetch(url.href, { credentials: "omit", redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? "The request timed out." : failure);
  }
  try {
    publicWebUrl(response.url || url.href);
  } catch (error) {
    response.body?.cancel().catch(() => {});
    throw error;
  }
  return response;
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

// News cards carry the article address, headline, publisher and age ("6 hours ago") as attributes.
function parseBingNews(html, limit) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const results = [];
  for (const card of doc.querySelectorAll(".news-card")) {
    const url = card.getAttribute("data-url") || card.getAttribute("url") || card.querySelector("a.title")?.getAttribute("href") || "";
    const title = clean(card.getAttribute("data-title") || card.querySelector("a.title")?.textContent);
    if (!/^https?:\/\//i.test(url) || !title) {
      continue;
    }
    results.push({
      title,
      url,
      snippet: clean(card.querySelector(".snippet")?.textContent),
      source: clean(card.getAttribute("data-author")),
      published: clean(card.querySelector(".source span[aria-label]")?.getAttribute("aria-label"))
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

async function searchBingNews(query, limit) {
  const run = async text => {
    const response = await request(`${BING_NEWS_URL}?q=${encodeURIComponent(text)}`, "Couldn't reach Bing News.");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return parseBingNews(await response.text(), limit);
  };
  const results = await run(query);
  const shorter = clean(query.replace(NEWS_FILLER, " "));
  return results.length || !shorter || shorter === query ? results : run(shorter);
}

async function searchTavilyNews(query, limit, key) {
  const response = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: limit, search_depth: "basic", topic: "news" }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  }).catch(error => {
    throw new Error(error?.name === "TimeoutError" ? "The request timed out." : "Couldn't reach Tavily.");
  });
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403 ? "the API key was rejected" : `HTTP ${response.status}`);
  }
  const payload = await response.json();
  return (payload.results || [])
    .filter(item => /^https?:\/\//i.test(item?.url || ""))
    .slice(0, limit)
    .map(item => ({ title: clean(item.title), url: item.url, snippet: clean(item.content).slice(0, 500), ...(item.published_date ? { published: clean(item.published_date) } : {}) }));
}

// Tries each engine in turn and returns the first non-empty result list, with the engine that found it.
// `news` asks news indexes first, for current events; the general web engines stay as a fallback.
export async function searchWeb(query, limit = 6, { tavilyKey = "", news = false } = {}) {
  const engines = [
    ...(news && tavilyKey ? [["Tavily News", () => searchTavilyNews(query, limit, tavilyKey)]] : []),
    ...(news ? [["Bing News", () => searchBingNews(query, limit)]] : []),
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
  if (!text.trim()) {
    // Some sites (MSN articles, for one) build their text with scripts, which aren't run here.
    throw new Error("The page has no readable text without JavaScript. Use the search snippet, or read another result.");
  }
  const truncated = text.length > MAX_PAGE_CHARS;
  return {
    url: finalUrl,
    site: new URL(finalUrl).hostname.replace(/^www\./, ""),
    title,
    text: truncated ? `${text.slice(0, MAX_PAGE_CHARS)}…` : text,
    truncated
  };
}
