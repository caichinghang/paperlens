// Builds a plain image-only PDF: one JPEG per page, no text layer. Used to download a document
// with approved redactions, so the hidden text is really gone instead of being covered by a box.

const encoder = new TextEncoder();

function ascii(text) {
  return encoder.encode(text);
}

function byteLength(part) {
  return part instanceof Blob ? part.size : part.byteLength;
}

// Builds a PDF as Blob parts while pages are rendered. JPEGs stay as blobs instead of becoming
// base64 strings and then being copied into several document-sized byte arrays.
export function createImagePdfBuilder(pageCount, { title = "" } = {}) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("An image PDF needs at least one page.");
  }
  const catalogId = 1;
  const pagesId = 2;
  const infoId = pageCount * 3 + 3;
  const pageIds = Array.from({ length: pageCount }, (_, index) => index * 3 + 5);
  const safeTitle = title.replace(/[()\\]/g, "").replace(/[^\x20-\x7e]/g, "");
  const header = ascii("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const parts = [header];
  const offsets = [];
  let offset = header.length;
  let nextId = 1;
  let addedPages = 0;

  const addObject = (id, bodyParts) => {
    if (id !== nextId) {
      throw new Error(`PDF object ${id} was added out of order.`);
    }
    offsets.push(offset);
    const wrapped = [ascii(`${id} 0 obj\n`), ...bodyParts, ascii("\nendobj\n")];
    parts.push(...wrapped);
    offset += wrapped.reduce((sum, part) => sum + byteLength(part), 0);
    nextId += 1;
  };

  addObject(catalogId, [ascii(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)]);
  addObject(pagesId, [ascii(`<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] >>`)]);

  return {
    addPage({ jpeg, width, height, pixelWidth, pixelHeight }) {
      if (addedPages >= pageCount || !(jpeg instanceof Blob || ArrayBuffer.isView(jpeg))) {
        throw new Error("Invalid or extra image PDF page.");
      }
      const imageId = addedPages * 3 + 3;
      const contentId = imageId + 1;
      const pageId = imageId + 2;
      addObject(imageId, [
        ascii(`<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${byteLength(jpeg)} >>\nstream\n`),
        jpeg,
        ascii("\nendstream")
      ]);
      const content = ascii(`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} 0 0 cm /Im0 Do Q`);
      addObject(contentId, [ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii("\nendstream")]);
      addObject(pageId, [ascii(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width.toFixed(2)} ${height.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
      )]);
      addedPages += 1;
    },

    finish() {
      if (addedPages !== pageCount) {
        throw new Error(`Expected ${pageCount} image PDF pages, received ${addedPages}.`);
      }
      addObject(infoId, [ascii(`<< /Producer (PaperLens) ${safeTitle ? `/Title (${safeTitle})` : ""} >>`)]);

      const xrefOffset = offset;
      let xref = `xref\n0 ${nextId}\n0000000000 65535 f \n`;
      for (const position of offsets) {
        xref += `${String(position).padStart(10, "0")} 00000 n \n`;
      }
      xref += `trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
      parts.push(ascii(xref));
      return new Blob(parts, { type: "application/pdf" });
    }
  };
}
