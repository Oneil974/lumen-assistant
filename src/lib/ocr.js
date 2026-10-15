// Reconnaissance de texte (OCR) par le MODÈLE DE VISION, pour ce que
// l'extracteur de texte ne sait pas lire :
//   • PDF scannés (pages-images, sans couche texte) : chaque page est rendue
//     par pdf.js (vendorisé) puis transcrite ;
//   • images d'une sandbox (photo d'un document, capture d'écran).
// Le modèle actif doit accepter les images (Ollama/llama.cpp multimodal, API
// cloud, Apple FM) ; sinon la transcription revient vide et on le dit.

import { llmChat } from "../llm.js";
import { PROMPTS as CORE_PROMPTS } from "./core-prompts.js";


function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/^data:[^,]+,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let pdfjsPromise = null;
async function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("./vendor/pdfjs/pdf.min.js").then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;
      return m;
    });
  }
  return pdfjsPromise;
}

async function transcribe(imageB64, lang) {
  const { messages, opts } = CORE_PROMPTS["core.ocr"].build({ image: imageB64, lang: lang === "en" ? "en" : "fr" });
  const { content } = await llmChat(messages, { ...opts, rawSystem: true, source: "ocr" });
  return String(content || "").trim();
}

/**
 * Texte d'un fichier de sandbox par OCR.
 * @returns {Promise<{ text: string, pages: number, total: number }>}
 */
export async function ocrSandboxFile(invoke, { id, path }, { lang = "fr", maxPages = 6, onProgress } = {}) {
  const ext = String(path).split(".").pop().toLowerCase();
  if (ext === "pdf") {
    const b64 = await invoke("sandbox_read_b64", { id, path });
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: b64ToBytes(b64) }).promise;
    const total = doc.numPages;
    const n = Math.min(total, maxPages);
    const parts = [];
    for (let i = 1; i <= n; i++) {
      onProgress?.(i, n);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // ~1400 px de large : lisible pour le modèle, raisonnable en jetons.
      const viewport = page.getViewport({ scale: Math.min(2.5, 1400 / base.width) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const img = canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
      const text = await transcribe(img, lang);
      parts.push(`--- Page ${i} ---\n${text}`);
    }
    return { text: parts.join("\n\n"), pages: n, total };
  }
  // Image : on la réduit côté Rust (max 1600 px) avant de l'envoyer.
  const raw = await invoke("sandbox_read_image_b64", { id, path, maxPx: 1600 });
  onProgress?.(1, 1);
  const img = String(raw).replace(/^data:[^,]+,/, "");
  return { text: await transcribe(img, lang), pages: 1, total: 1 };
}

/** Le texte obtenu est-il exploitable (et pas un refus du modèle) ? */
export function ocrUsable(text) {
  const t = String(text || "").replace(/---\s*Page \d+\s*---/g, "").replace(/\((page sans texte|page without text)\)/gi, "").trim();
  return t.replace(/[^\p{L}\p{N}]/gu, "").length >= 20;
}
