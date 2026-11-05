// The pop-out visualizer window. Full screen fills whichever monitor the window is on (button, F, or double-click; Esc leaves).
// In the desktop app the window itself goes full screen (the page cannot do that inside WebView2); in a browser, the page does.
import {mountVisualizer} from './visualizer-view.js';
import {desktopWindow,viewerRelay} from './visual-bridge.js';
import {playbackAction} from './playback-keys.js';

// The main window's theme and light/dark look, so the mixer and controls match it (the main window keeps them in this origin's
// storage, and the storage event follows a change made there while this window is open).
const theme=()=>{try{const root=document.documentElement;root.dataset.theme=localStorage.getItem('cb-theme')||'plum';root.dataset.scheme=localStorage.getItem('cb-scheme')||'light';}catch{/* blocked storage: the defaults */}};
theme();window.addEventListener('storage',event=>{if(event.key==='cb-theme'||event.key==='cb-scheme')theme();});

const stage=document.getElementById('visualizer');
// ?stream=<key>: an OBS Browser Source (Visualizer → Stream to OBS in the main window). It follows the player through the server and
// shows no controls; OBS sets its size.
const streamKey=new URLSearchParams(location.search).get('stream');
// When Chord Buddy is closed, the stream goes blank (transparent, so OBS shows what is under it) instead of going on drawing its last
// moment; it comes back by itself when the app runs again. A moment's grace keeps a hiccup from blinking it.
if(streamKey){
  document.body.classList.add('streaming');
  let lost=0;
  const link=up=>{clearTimeout(lost);if(up)document.body.classList.remove('offline');else lost=setTimeout(()=>document.body.classList.add('offline'),2000);};
  mountVisualizer(stage,{open:()=>viewerRelay(streamKey,{onLink:link}),stream:true});
}
else popOut();
function popOut(){
  const view=mountVisualizer(stage);
  const button=document.createElement('button');button.type='button';button.title='Full screen (F)';button.textContent='Full screen';view.toolbar.append(button);
  const label=on=>{button.textContent=on?'Exit full screen':'Full screen';};
  async function isFull(){const desktop=desktopWindow();return desktop?!!(await desktop.is_fullscreen()):!!document.fullscreenElement;}
  async function toggle(){
    const desktop=desktopWindow();
    if(desktop){label(await desktop.toggle_fullscreen());return;}
    if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen().catch(()=>{});
  }
  button.onclick=()=>{toggle();};
  stage.ondblclick=event=>{if(!event.target.closest('.visualizer-mixer,.visualizer-toolbar'))toggle();};
  document.addEventListener('keydown',async event=>{
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='f'||event.key==='F')toggle();
    else if(event.key==='Escape'&&desktopWindow()&&await isFull())toggle();     // the browser handles Esc itself
  });
  document.addEventListener('fullscreenchange',()=>label(!!document.fullscreenElement));
  // Space, R, L and the arrows work here too: the player in the main window carries them out.
  document.addEventListener('keydown',event=>{
    const action=playbackAction(event);if(!action)return;
    event.preventDefault();if(!action.repeat)view.command(action);
  });
}
