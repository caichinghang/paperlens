// The floating and header buttons show their name in a styled tag after a short hover (see the
// tooltip rules in viewer.css). The tag reads data-tip, so the native title, which appears sooner and
// would show twice, is moved there. Titles set later by the page are moved too.
const SELECTOR = ".dock-button, .corner-button, .panel-icon-button, .segmented button, .ai-title-button, .composer-icon, .thinking-button";

function adopt(element) {
  if (!element.matches?.(SELECTOR) || !element.hasAttribute("title")) {
    return;
  }
  const tip = element.getAttribute("title");
  element.removeAttribute("title");
  if (tip) {
    element.dataset.tip = tip;
  } else {
    delete element.dataset.tip;
  }
}

export function initTooltips(root = document.body) {
  root.querySelectorAll(SELECTOR).forEach(adopt);
  new MutationObserver(records => records.forEach(record => adopt(record.target)))
    .observe(root, { subtree: true, attributes: true, attributeFilter: ["title"] });
}
