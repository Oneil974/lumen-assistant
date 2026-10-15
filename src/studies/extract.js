// Texte d'un cours à partir d'un fichier de sandbox, entièrement en local :
// PDF (pdf.js), Word et PowerPoint (lib/office), texte, Markdown, notes Lumen.

import { readSandboxBytes } from "../lib/office/ooxml.js";
import { recognizeImage, imageDataUrl, renderPage, extractPdfDocument } from './ocr.js';

const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tex", "html", "htm", "json"]);
export const COURSE_EXT = ["pdf", "docx", "pptx", "lumenpages", "lumenkey", "png", "jpg", "jpeg", "webp", "bmp", ...TEXT_EXT];

function htmlToText(html) {
  const d = new DOMParser().parseFromString(String(html || ""), "text/html");
  d.querySelectorAll("script,style").forEach((n) => n.remove());
  return (d.body?.innerText || d.body?.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

function creativeText(doc) {
  return (doc.pages || []).map((p, i) => {
    const els = [...(p.elements || [])].sort((a, b) => a.y - b.y || a.x - b.x);
    const text = els.map((el) => el.type === "text" ? htmlToText(el.html) : el.type === "table" ? el.rows.map((r) => r.map(htmlToText).join(" | ")).join("\n") : "").filter(Boolean).join("\n");
    if (!text.trim() && !p.notes) return "";
    return `[${i + 1}]\n${text}${p.notes ? `\nNotes : ${p.notes}` : ""}`;
  }).filter(Boolean).join("\n\n");
}

export async function extractText(invoke, sandboxId, path, options = {}) {
  const ext = String(path).split(".").pop().toLowerCase();
  if (['png','jpg','jpeg','webp','bmp'].includes(ext)) {
    options.onProgress?.(1, 1, true);
    const bytes = await readSandboxBytes(invoke, sandboxId, path);
    return recognizeImage(invoke, await imageDataUrl(bytes), options);
  }
  if (ext === "pdf") {
    const pdfjs = await import("../lib/vendor/pdfjs/pdf.min.js");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("../lib/vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;
    const bytes = await readSandboxBytes(invoke, sandboxId, path);
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    try {
      return await extractPdfDocument(doc, { ...options, ocrPage: async page => recognizeImage(invoke, await renderPage(page), options) });
    } finally { await doc.destroy(); }
  }
  if (ext === "docx" || ext === "pptx") {
    const bytes = await readSandboxBytes(invoke, sandboxId, path);
    const mod = ext === "docx" ? await import("../lib/office/docx.js") : await import("../lib/office/pptx.js");
    const doc = ext === "docx" ? await mod.docxToCreative(bytes) : await mod.pptxToCreative(bytes);
    return creativeText(doc);
  }
  const file = await invoke("sandbox_read_file", { id: sandboxId, path });
  if (ext === "lumenpages" || ext === "lumenkey") {
    try { const data = JSON.parse(file.content); return data.doc ? creativeText(data.doc) : htmlToText(data.html); } catch { return ""; }
  }
  if (ext === "html" || ext === "htm") return htmlToText(file.content);
  return String(file.content || "");
}
