// The Stream controls window (obs-sound.html): the visualizer's picker, with no picture and no mixer of its own (the main window's mixer is right there), for what OBS shows.
import {mountVisualizer} from './visualizer-view.js';
import {playbackAction} from './playback-keys.js';
import {hydrateIcons} from './icons.js';
import {CHANNEL} from './visual-bridge.js';

// the main window's theme and light/dark look (kept in this origin's storage; the storage event follows a change made there)
const theme=()=>{try{const root=document.documentElement;root.dataset.theme=localStorage.getItem('cb-theme')||'plum';root.dataset.scheme=localStorage.getItem('cb-scheme')||'light';}catch{/* blocked storage: the defaults */}};
theme();window.addEventListener('storage',event=>{if(event.key==='cb-theme'||event.key==='cb-scheme')theme();});

// in the desktop app this window is also the sound for OBS (a browser needs none: OBS can pick the browser itself)
const sound=document.getElementById('stream-sound');
sound.hidden=new URLSearchParams(location.search).get('sound')!=='1';
// the note is open the first time, and stays the way you left it (only this window needs it, so this browser's storage is enough)
try{if(localStorage.getItem('cb-stream-sound-note')==='closed')sound.open=false;}catch{/* blocked storage: open */}
sound.addEventListener('toggle',()=>{try{localStorage.setItem('cb-stream-sound-note',sound.open?'open':'closed');}catch{/* blocked storage */}});
hydrateIcons();
// Always on top: the desktop app keeps this window above the others (the main window asks it; a browser can't)
const bridge=new BroadcastChannel(CHANNEL);
const keepOnTop=sound.hidden?null:on=>bridge.postMessage({type:'ontop',on});
const view=mountVisualizer(document.getElementById('stream-controls'),{kind:'controls',keepOnTop});
// Space, R, L and the arrows work here too: the player in the main window carries them out.
document.addEventListener('keydown',event=>{
  const action=playbackAction(event);if(!action)return;
  event.preventDefault();if(!action.repeat)view.command(action);
});
