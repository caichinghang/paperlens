// Ordered notebook tree. Pages and folders share sibling positions; only folders can be parents.
export function outlineItem(data, id) {
  return data.notes.find(note => note.id === id) || data.folders.find(folder => folder.id === id);
}

export function outlineParent(item) {
  return item && ("folderId" in item ? item.folderId : item.parentId) || null;
}

export function outlineChildren(data, parentId = null) {
  return [...data.notes.filter(note => (note.folderId || null) === parentId),
    ...data.folders.filter(folder => (folder.parentId || null) === parentId)]
    .sort((a, b) => (Number.isFinite(a.order) ? a.order : Infinity) - (Number.isFinite(b.order) ? b.order : Infinity)
      || (b.createdAt || 0) - (a.createdAt || 0));
}

export function normalizeOutline(data, lastId = null) {
  const folderIds = new Set(data.folders.map(folder => folder.id));
  for (const note of data.notes) {
    if (note.folderId && !folderIds.has(note.folderId)) note.folderId = null;
    if (note.id === lastId && !Number.isFinite(note.order)) note.order = Number.MAX_SAFE_INTEGER;
  }
  for (const folder of data.folders) {
    const seen = new Set([folder.id]);
    let cursor = folder.parentId;
    while (cursor && folderIds.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = data.folders.find(parent => parent.id === cursor)?.parentId;
    }
    if (cursor && (!folderIds.has(cursor) || seen.has(cursor))) folder.parentId = null;
  }
  const assign = parentId => {
    outlineChildren(data, parentId).forEach((item, index) => {
      item.order = index;
      if (data.folders.includes(item)) assign(item.id);
    });
  };
  assign(null);
}

export function moveOutline(data, id, parentId, beforeId = null) {
  const item = outlineItem(data, id);
  if (!item || id === beforeId) return false;
  if (parentId && !data.folders.some(folder => folder.id === parentId)) return false;
  if (data.folders.includes(item)) {
    const seen = new Set();
    let cursor = parentId;
    while (cursor && !seen.has(cursor)) {
      if (cursor === id) return false;
      seen.add(cursor);
      cursor = data.folders.find(folder => folder.id === cursor)?.parentId || null;
    }
  }
  const oldParent = outlineParent(item);
  const siblings = outlineChildren(data, parentId).filter(entry => entry.id !== id);
  const at = beforeId ? siblings.findIndex(entry => entry.id === beforeId) : -1;
  siblings.splice(at < 0 ? siblings.length : at, 0, item);
  if (data.folders.includes(item)) item.parentId = parentId;
  else item.folderId = parentId;
  siblings.forEach((entry, index) => { entry.order = index; });
  if (oldParent !== parentId) outlineChildren(data, oldParent).forEach((entry, index) => { entry.order = index; });
  return true;
}
