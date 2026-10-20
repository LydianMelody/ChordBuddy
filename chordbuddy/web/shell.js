import {hydrateIcons,icon} from './icons.js';
import {prefs as remember} from './prefs.js';

// Theme and folded panels are remembered with the library (see prefs.js), not in the browser.
const THEMES = ['tomato', 'forest', 'plum'];
const root = document.documentElement;
const $ = id => document.getElementById(id);

function setTheme(name, save = true) {
  if (!THEMES.includes(name)) name = 'plum';
  root.dataset.theme = name;
  for (const button of document.querySelectorAll('[data-theme-pick]')) {
    const on = button.dataset.themePick === name;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }
  if (save) remember.set('cb-theme', name);
}

// Light or dark. The light look is the default (the neo-brutalist design is drawn for it), whatever the computer's own setting;
// choosing dark is remembered with the library.
function setScheme(choice, save = true) {
  const scheme = choice === 'dark' ? 'dark' : 'light';
  root.dataset.scheme = scheme;
  const button = $('scheme-toggle');
  if (button) {
    button.innerHTML = icon(scheme === 'dark' ? 'sun' : 'moon');
    button.dataset.tip = scheme === 'dark' ? 'Switch to the light look.' : 'Switch to the dark look.';
    button.setAttribute('aria-pressed', String(scheme === 'dark'));
  }
  if (save) remember.set('cb-scheme', scheme);
}
// Printing (Export PDF) is always the light, paper look.
let printedScheme = null;
window.addEventListener('beforeprint', () => { printedScheme = root.dataset.scheme; root.dataset.scheme = 'light'; });
window.addEventListener('afterprint', () => { if (printedScheme) root.dataset.scheme = printedScheme; printedScheme = null; });

function setSide(open, save = true) {
  $('app').dataset.side = open ? 'open' : 'closed';
  $('side-open').classList.toggle('hidden', open);
  $('side-toggle').setAttribute('aria-expanded', String(open));
  if (save) remember.set('cb-side', open ? 'open' : 'closed');
}

function setRack(open, save = true) {
  $('app').dataset.rack = open ? 'open' : 'closed';
  $('rack-toggle').setAttribute('aria-expanded', String(open));
  if (save) remember.set('cb-rack', open ? 'open' : 'closed');
}

hydrateIcons();
const applyPrefs = () => {
  // Only a choice you make is saved; applying what was remembered (or the defaults) must never overwrite it.
  setTheme(remember.get('cb-theme', 'plum'), false);
  setScheme(remember.get('cb-scheme', 'light'), false);
  setSide(remember.get('cb-side', 'open') !== 'closed', false);
  setRack(remember.get('cb-rack', 'open') !== 'closed', false);
};
applyPrefs();
remember.onLoad(applyPrefs);
$('rack-toggle').onclick = () => setRack(false);
$('rack-open').onclick = () => setRack(true);
for (const button of document.querySelectorAll('[data-theme-pick]')) button.onclick = () => setTheme(button.dataset.themePick);
$('scheme-toggle').onclick = () => setScheme(root.dataset.scheme === 'dark' ? 'light' : 'dark');
$('side-toggle').onclick = () => setSide(false);
$('side-open').onclick = () => setSide(true);

// Everything in the Export menu is handled by the app, which knows what each view needs (see runExport in app.js).

// Close the "more tools" menu when clicking elsewhere.
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('details.more[open]')) if (!menu.contains(event.target)) menu.open = false;
});

// Generated rows (set lists, songs) ask for icons after they render.
let hydrateQueued = false;
new MutationObserver(mutations => {
  if (hydrateQueued || !mutations.some(m => m.addedNodes.length)) return;
  hydrateQueued = true;
  requestAnimationFrame(() => { hydrateQueued = false; hydrateIcons(); });   // once per frame, and only when something was added
}).observe(document.body, {childList: true, subtree: true});
