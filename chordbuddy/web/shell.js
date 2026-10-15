import {hydrateIcons} from './icons.js';
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
  setSide(remember.get('cb-side', 'open') !== 'closed', false);
  setRack(remember.get('cb-rack', 'open') !== 'closed', false);
};
applyPrefs();
remember.onLoad(applyPrefs);
$('rack-toggle').onclick = () => setRack(false);
$('rack-open').onclick = () => setRack(true);
for (const button of document.querySelectorAll('[data-theme-pick]')) button.onclick = () => setTheme(button.dataset.themePick);
$('side-toggle').onclick = () => setSide(false);
$('side-open').onclick = () => setSide(true);

// Export PDF prints only the chart page (see the @media print rules in shell.css). WebView2's print dialog offers "Save as PDF".
// The app decides what to print (it opens the chart and Navigate mode first); this button only asks.
$('export-pdf').onclick = () => document.dispatchEvent(new CustomEvent('chordbuddy:export-pdf'));

// Close the "more tools" menu when clicking elsewhere.
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('details.more[open]')) if (!menu.contains(event.target)) menu.open = false;
});

// Generated rows (set lists, songs) ask for icons after they render.
new MutationObserver(() => hydrateIcons()).observe(document.body, {childList: true, subtree: true});
