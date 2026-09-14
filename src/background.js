const VIEWER_PAGE = "viewer.html";

function isExtensionViewer(url) {
  return url.startsWith(chrome.runtime.getURL(VIEWER_PAGE));
}

function isLikelyPdfUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return parsed.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function buildViewerUrl(pdfUrl) {
  return chrome.runtime.getURL(`${VIEWER_PAGE}?src=${encodeURIComponent(pdfUrl)}`);
}

async function openPdfInViewer(tabId, pdfUrl) {
  if (!tabId || isExtensionViewer(pdfUrl)) {
    return;
  }

  const viewerUrl = buildViewerUrl(pdfUrl);
  try {
    await chrome.tabs.update(tabId, { url: viewerUrl });
  } catch {
    // The tab may have closed during navigation; there is nothing useful to recover.
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId < 0 || details.type !== "main_frame" || isExtensionViewer(details.url)) {
      return;
    }

    const contentTypeHeader = details.responseHeaders?.find(header => {
      return header.name.toLowerCase() === "content-type";
    });
    const contentType = contentTypeHeader?.value?.toLowerCase() || "";

    if (contentType.includes("application/pdf") || isLikelyPdfUrl(details.url)) {
      openPdfInViewer(details.tabId, details.url);
    }
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["responseHeaders"]
);

chrome.action.onClicked.addListener(async tab => {
  const url = tab?.url || "";

  if (isExtensionViewer(url)) {
    return;
  }

  if (isLikelyPdfUrl(url)) {
    await openPdfInViewer(tab.id, url);
    return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL(VIEWER_PAGE) });
});
