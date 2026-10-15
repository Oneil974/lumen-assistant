// OCR stays on the local auxiliary vision process, independent of the chat backend.
export function selectedOcrModel() { try { return localStorage.getItem('studiesOcrModel') || 'glm-ocr'; } catch { return 'glm-ocr'; } }
export function selectOcrModel(id) { try { localStorage.setItem('studiesOcrModel', id); } catch {} }
export function mountOcrControls(root, invoke, listen, tt = value => value) {
  let models = [], current = null, disposed = false, unlisten, installing = false;
  const select = root.querySelector('[data-ocr-select]'), button = root.querySelector('[data-ocr-install]'), status = root.querySelector('[data-ocr-status]');
  const update = () => {
    current = models.find(m => m.id === select.value) || models[0];
    if (!current) return;
    selectOcrModel(current.id);
    status.textContent = `${current.license} · ≈ ${(current.size / 1e9).toFixed(2)} Go · ${tt(current.installed ? 'Installé' : 'Modèle et projecteur à télécharger')}`;
    button.hidden = current.installed; button.disabled = false;
  };
  const load = async () => {
    models = await invoke('ocr_models');
    if (disposed) return;
    select.replaceChildren(...models.map(m => new Option(m.name, m.id)));
    select.value = models.some(m => m.id === selectedOcrModel()) ? selectedOcrModel() : models[0]?.id;
    update();
  };
  select.onchange = update;
  button.onclick = async () => {
    if (!current || installing) return;
    const m = current; installing = true; button.disabled = true; select.disabled = true;
    status.textContent = tt('Téléchargement…');
    try {
      await invoke('llama_download_model', { request: { id: `studies-ocr-${m.id}`, url: m.url, filename: m.filename, mmprojUrl: m.mmproj_url, mmprojFilename: m.mmproj_filename } });
      await load();
    } catch (error) { if (!disposed) status.textContent = String(error.message || error); }
    finally { installing = false; if (!disposed) { button.disabled = false; select.disabled = false; } }
  };
  Promise.resolve(listen?.('llama-download-progress', event => {
    if (event.payload?.id === `studies-ocr-${current?.id}` && !disposed) status.textContent = `${tt('Téléchargement…')} ${Math.floor(event.payload.percent || 0)} %`;
  })).then(fn => { if (disposed) fn?.(); else unlisten = fn; });
  load().catch(error => { if (!disposed) status.textContent = String(error.message || error); });
  return {
    get busy() { return installing; },
    disable() { select.disabled = button.disabled = true; },
    dispose() { disposed = true; unlisten?.(); if (installing && current) invoke('llama_cancel_download', { id: `studies-ocr-${current.id}` }).catch(() => {}); },
  };
}
export function checkCancelled(signal) { if (signal?.aborted) throw new DOMException('Numérisation annulée.', 'AbortError'); }
export async function recognizeImage(invoke, image, { model = selectedOcrModel(), signal } = {}) {
  checkCancelled(signal);
  const models = await invoke('ocr_models');
  const entry = models.find(m => m.id === model);
  if (!entry?.installed) throw new Error('Installez le modèle OCR et son projecteur depuis le Catalogue → OCR ou le sélecteur d’import.');
  const result = await invoke('vision_ocr', { model, image });
  checkCancelled(signal);
  return String(result?.text || '').trim();
}
export async function imageDataUrl(bytes) {
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Image non prise en charge.')); image.src = url; });
    const scale = Math.min(1, 2200 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .94);
  } finally { URL.revokeObjectURL(url); }
}
export async function renderPage(page) {
  const raw = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2.5, 2200 / Math.max(raw.width, raw.height)) });
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#fff' }).promise;
    return canvas.toDataURL('image/jpeg', .94);
  } finally { canvas.width = canvas.height = 0; }
}

/** Mixed PDFs preserve native text and OCR only pages without usable text. */
export async function extractPdfDocument(doc, { ocrPage, onProgress, signal } = {}) {
  let out = '';
  if (doc.numPages > 200) throw new Error('Ce document dépasse 200 pages. Importez-le en plusieurs parties.');
  for (let n = 1; n <= doc.numPages; n++) {
    checkCancelled(signal);
    const page = await doc.getPage(n);
    try {
      const tc = await page.getTextContent();
      let text = tc.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('').trim();
      const needsOcr = text.replace(/\s/g, '').length < 20;
      onProgress?.(n, doc.numPages, needsOcr);
      if (needsOcr) {
        if (!ocrPage) throw new Error(`La page ${n} nécessite un modèle OCR.`);
        text = await ocrPage(page, n);
      }
      checkCancelled(signal);
      if (out.length + text.length > 400000) throw new Error('Le texte dépasse la limite de 400 000 caractères. Importez le document en plusieurs parties.');
      out += `\n\n[Page ${n}]\n${text}`;
    } finally { page.cleanup?.(); }
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}
