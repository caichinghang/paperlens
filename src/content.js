function isDirectPdfLink(url) {
  try {
    const parsed = new URL(url, window.location.href);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function openInViewer(url) {
  const viewerUrl = chrome.runtime.getURL(`viewer.html?src=${encodeURIComponent(url)}`);
  window.location.assign(viewerUrl);
}

document.addEventListener(
  "click",
  event => {
    const link = event.target?.closest?.("a[href]");

    if (!link || event.defaultPrevented || event.button !== 0) {
      return;
    }

    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const href = link.href;
    if (!isDirectPdfLink(href)) {
      return;
    }

    event.preventDefault();
    openInViewer(href);
  },
  true
);
