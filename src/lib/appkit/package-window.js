// Compatibility host for native shortcuts to catalogue applications. Release
// builds retain their URLs, while application code stays in installed packages.
import { refreshInstalled, openInstalledApp, onInstalledChange } from './installed.js';
import { FRAME_PERMS } from '../app-navigation.js';

const root = document.getElementById('package-window');
const id = document.body.dataset.appId;
const en = (localStorage.getItem('lang') || navigator.language || '').startsWith('en');
let dispose = null;
let currentVersion = null;
let pending = false;
let refreshAgain = false;
function render() {
  if (pending) { refreshAgain = true; return; }
  pending = true;
  Promise.resolve().then(async () => {
    const apps = await refreshInstalled();
    const app = apps.find(app => app.id === id);
    const version = app ? `${app.id}@${app.version}` : '';
    if (version === currentVersion) return;
    dispose?.(); dispose = null;
    currentVersion = version;
    root.replaceChildren();
    if (app) {
      openInstalledApp(app, {
        createWindow: () => ({ body: root, setTitle: title => { document.title = title; }, onClose: callback => { dispose = callback; } }),
        focusWindow() {}, openWindows: new Map(), framePermissions: FRAME_PERMS,
      });
      return;
    }
    const empty = document.createElement('section');
    empty.className = 'package-empty';
    const title = document.createElement('h1');
    title.textContent = en ? 'Install this application' : 'Installer cette application';
    const hint = document.createElement('p');
    hint.textContent = en ? 'This application is available in the Lumen catalog.' : 'Cette application est disponible dans le catalogue Lumen.';
    const button = document.createElement('button');
    button.className = 'ui-btn'; button.type = 'button';
    button.textContent = en ? 'Open catalog' : 'Ouvrir le catalogue';
    button.addEventListener('click', () => { location.href = `/market/market.html?app=${encodeURIComponent(id)}`; });
    empty.append(title, hint, button); root.append(empty);
  }).catch(error => {
    currentVersion = null;
    root.textContent = `${en ? 'Unable to load application' : 'Impossible de charger l’application'} : ${error.message}`;
  }).finally(() => { pending = false; if (refreshAgain) { refreshAgain = false; render(); } });
}
const unsubscribe = onInstalledChange(render);
window.addEventListener('pagehide', () => { unsubscribe(); dispose?.(); }, { once: true });
render();
