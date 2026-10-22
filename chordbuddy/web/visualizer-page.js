// The pop-out visualizer window. Full screen fills whichever monitor the window is on (button, F, or double-click; Esc leaves).
// In the desktop app the window itself goes full screen (the page cannot do that inside WebView2); in a browser, the page does.
import {mountVisualizer} from './visualizer-view.js';
import {desktopWindow} from './visual-bridge.js';

const stage=document.getElementById('visualizer'),view=mountVisualizer(stage);
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
