// Builds a plain image-only PDF: one JPEG per page, no text layer. Used to download a document
// with approved redactions, so the hidden text is really gone instead of being covered by a box.

const encoder = new TextEncoder();

function ascii(text) {
  return encoder.encode(text);
}

function concat(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// pages: [{ jpeg: Uint8Array, width, height (points), pixelWidth, pixelHeight }]
export function buildImagePdf(pages, { title = "" } = {}) {
  const objects = [];
  const add = parts => {
    objects.push(parts);
    return objects.length;
  };

  const catalogId = add(null);
  const pagesId = add(null);
  const pageIds = [];

  for (const page of pages) {
    const imageId = add([
      ascii(`<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`),
      page.jpeg,
      ascii("\nendstream")
    ]);
    const content = ascii(`q ${page.width.toFixed(2)} 0 0 ${page.height.toFixed(2)} 0 0 cm /Im0 Do Q`);
    const contentId = add([ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii("\nendstream")]);
    const pageId = add([ascii(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
    )]);
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = [ascii(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)];
  objects[pagesId - 1] = [ascii(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] >>`)];

  const safeTitle = title.replace(/[()\\]/g, "").replace(/[^\x20-\x7e]/g, "");
  const infoId = add([ascii(`<< /Producer (PDF viewer) ${safeTitle ? `/Title (${safeTitle})` : ""} >>`)]);

  const chunks = [ascii("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let offset = chunks[0].length;
  const offsets = [];

  objects.forEach((parts, index) => {
    offsets.push(offset);
    const body = concat([ascii(`${index + 1} 0 obj\n`), ...parts, ascii("\nendobj\n")]);
    chunks.push(body);
    offset += body.length;
  });

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const position of offsets) {
    xref += `${String(position).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(ascii(xref));

  return concat(chunks);
}
