// Page-scoped snapshots for markup undo/redo. Ink paths can be large, so a change on page 59 should
// not clone every annotation in a 500-page document. `order` keeps the global annotation order
// stable when a snapshot is restored.

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function captureAnnotationPages(annotations, pages) {
  const selectedPages = new Set(pages || annotations.map(annotation => annotation.page));
  return {
    pages: [...selectedPages],
    items: clone(annotations.filter(annotation => selectedPages.has(annotation.page))),
    order: annotations.map(annotation => annotation.id)
  };
}

export function restoreAnnotationPages(annotations, snapshot) {
  const pages = new Set(snapshot.pages);
  const merged = [
    ...annotations.filter(annotation => !pages.has(annotation.page)),
    ...clone(snapshot.items)
  ];
  const rank = new Map(snapshot.order.map((id, index) => [id, index]));
  merged.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  return merged;
}
