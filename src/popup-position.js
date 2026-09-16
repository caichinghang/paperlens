function usable(rect) {
  return rect && Number.isFinite(rect.left) && Number.isFinite(rect.bottom)
    && rect.bottom > 0 && rect.left >= 0 && rect.height > 0;
}

export function popupNearCaret(caret, fallback, box, viewport) {
  const anchor = usable(caret) ? caret : fallback;
  if (!usable(anchor)) return { left: 8, top: 8 };
  const below = anchor.bottom + 8;
  const top = below + box.height > viewport.height - 8
    ? Math.max(8, anchor.top - box.height - 8) : below;
  const left = Math.max(8, Math.min(anchor.left, viewport.width - box.width - 8));
  return { left, top };
}
