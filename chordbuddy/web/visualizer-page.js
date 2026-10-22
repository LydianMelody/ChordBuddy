// The pop-out visualizer window. Full screen fills whichever monitor the window is on (button, F, or double-click; Esc leaves).
import {mountVisualizer} from './visualizer-view.js';

const stage=document.getElementById('visualizer'),view=mountVisualizer(stage);
const button=document.createElement('button');button.type='button';button.title='Full screen (F)';button.textContent='Full screen';view.toolbar.append(button);
const toggle=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen().catch(()=>{});
button.onclick=toggle;stage.ondblclick=toggle;
document.addEventListener('keydown',event=>{if((event.key==='f'||event.key==='F')&&!event.ctrlKey&&!event.metaKey)toggle();});
document.addEventListener('fullscreenchange',()=>{button.textContent=document.fullscreenElement?'Exit full screen':'Full screen';});
