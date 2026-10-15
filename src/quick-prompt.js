import { llmChat, llmBackend } from './llm.js';
const api = window.__TAURI__;
const invoke = api?.core?.invoke;
const $ = id => document.getElementById(id);
let controller = null, turn = 0, answer = '';
const english = (localStorage.getItem('lang') || navigator.language).startsWith('en');
const text = (fr, en) => english ? en : fr;
if (english) {
  document.documentElement.lang = 'en';
  $('prompt').placeholder = 'A quick question…'; $('prompt').setAttribute('aria-label', 'Quick question');
  $('answer').setAttribute('aria-label', 'Answer'); $('send').setAttribute('aria-label', 'Send');
  $('close').setAttribute('aria-label', 'Close'); $('copy').textContent = 'Copy';
  document.querySelector('.hint').textContent = 'Esc to dismiss';
}
function backend() {
  const b = llmBackend();
  $('backend').textContent = `${['api','lumen'].includes(b.source || localStorage.getItem('aiSource')) ? text('Serveur configuré', 'Configured server') : text('Local', 'Local')} · ${b.model || text('modèle actif', 'active model')}`;
}
function resize() { invoke?.('quick_prompt_resize', { height: Math.min(380, Math.max(128, $('panel').scrollHeight + 18)) }).catch(() => {}); }
function cancel() { turn++; controller?.abort(); controller = null; $('send').disabled = false; $('status').textContent = ''; }
async function hide() { cancel(); await invoke?.('quick_prompt_hide'); }
function render(value) { answer = value; $('answer').textContent = value; $('answer').hidden = !value; $('copy').hidden = !value; resize(); }
$('prompt-form').addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt || controller) return;
  const id = ++turn;
  controller = new AbortController(); $('send').disabled = true;
  $('status').className = ''; $('status').textContent = text('Réponse…', 'Answering…'); render(''); backend();
  try {
    const result = await llmChat([
      { role: 'system', content: text('Réponds directement et brièvement, en quelques phrases. Pas de préambule. Ne prétends pas exécuter des actions : cet accès rapide sert uniquement à répondre.', 'Answer directly and briefly in a few sentences, without preamble. Do not claim to perform actions: this quick prompt only answers questions.') },
      { role: 'user', content: prompt },
    ], { rawSystem: true, maxTokens: 512, think: false, signal: controller.signal, onDelta: value => { if (id === turn) render(value); } });
    if (id === turn) { render(result.content || answer); $('status').textContent = ''; }
  } catch (error) {
    if (id === turn && error.name !== 'AbortError') { $('status').className = 'error'; $('status').textContent = String(error.message || error); resize(); }
  } finally { if (id === turn) { controller = null; $('send').disabled = false; } }
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('prompt-form').requestSubmit(); }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); hide(); } });
$('close').onclick = hide;
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(answer); $('status').textContent = text('Copié', 'Copied'); } catch { $('status').textContent = text('Sélectionnez le texte pour le copier.', 'Select the text to copy it.'); } };
api?.event?.listen('quick-prompt-hidden', cancel);
api?.event?.listen('quick-prompt-focus', () => { backend(); $('prompt').focus(); $('prompt').select(); });
backend(); $('prompt').focus();
