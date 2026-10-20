// The vertical tool rail, shared by the chord chart and the lead sheet. Each view hands in its own groups of tools and what to do when one
// is picked; the look, the tooltips (with their little pictures) and the way the rail shrinks to fit are the same everywhere.
import {TOOLS,TOOL_ART,toolIcon} from './tool-icons.js';

const el=(tag,cls='',text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};

// The rail fits the height it is given: full tiles with names, smaller tiles, tiles alone, and finally two columns.
export function fitRail(dock){
  const room=dock?.parentElement?.clientHeight;
  if(!room||!dock.dataset)return;
  dock.dataset.fit=room>=520?'full':room>=440?'compact':room>=360?'tiny':'wide';
}
const watched=new WeakMap();
export function watchRail(dock){
  if(typeof ResizeObserver!=='function'||!dock?.parentElement)return;
  watched.get(dock)?.disconnect();                      // the chart is mounted again for each song: keep one observer per rail, not one per mount
  const observer=new ResizeObserver(()=>fitRail(dock));observer.observe(dock.parentElement);watched.set(dock,observer);
}

// groups: [[tool names], …]; active: the held tool; onPick(name); actions: [{id, label, title, body, art, run}] buttons at the foot that do
// something once instead of being held (like "Open in another editor").
export function renderRail(dock,{groups,active,onPick,actions=[],disabled=[]}){
  const focused=dock.contains?.(document.activeElement)?document.activeElement.dataset?.tool:null;   // rebuilding the rail must not drop keyboard focus
  dock.replaceChildren();
  const tray=el('div','tool-tray');
  const button=(name,info,{held,run,art,kind})=>{
    const b=el('button','tool-btn'+(held?' on':'')+(kind==='action'?' tool-action':''));b.type='button';b.dataset.tool=name;
    if(kind!=='action')b.setAttribute('aria-pressed',String(held));
    b.setAttribute('aria-label',info.title+(info.key?' ('+info.key+')':''));
    b.dataset.tip=info.body;b.dataset.tipTitle=info.title;if(info.key)b.dataset.tipKey=info.key;b.dataset.tipArt=art||'';b.dataset.tipSide='right';
    const tile=el('span','tool-tile');tile.innerHTML=toolIcon(name);
    b.append(tile,el('small','',info.label));if(info.key)b.append(el('kbd','',info.key));
    if(disabled.includes(name)){b.disabled=true;b.classList.add('off');}
    b.onclick=run;return b;
  };
  groups.forEach((names,i)=>{
    if(i>0)tray.append(el('span','tool-sep'));
    for(const name of names)tray.append(button(name,TOOLS[name],{held:name===active,run:()=>onPick(name),art:TOOL_ART[name]}));
  });
  if(actions.length){
    if(groups.length)tray.append(el('span','tool-sep'));
    for(const action of actions)tray.append(button(action.id,{label:action.label,title:action.title,body:action.body},{held:false,run:action.run,art:TOOL_ART[action.id],kind:'action'}));
  }
  dock.append(tray);fitRail(dock);
  if(focused)[...tray.querySelectorAll('button')].find(b=>b.dataset.tool===focused&&!b.disabled)?.focus();
  return tray;
}
