// The patch bay: a floating panel in the visualizer, like the mixer (visual-mixer.js), for wiring sounds and signals to the parts of the
// shown visualization that can be wired (its `inputs`; the engine is visual-patch.js). Sources run down the left (the song, the stems,
// the melodies, your own MIDI), the visualization's inputs down the right, and cables hang between them, colored by type. Every row has
// a small light showing its value as the song plays. Click a source, then an input, to connect them (or drag from one to the other);
// click an input to see what drives it and adjust or unplug each cable. Changes save at once: to the song's own patch when it has one,
// else to the usual patch for this visualization ("Editing visuals for: This song only / Every song" switches between them).
import {canConnect,adapterSettings,SETTINGS,defaultPatch,fitUnit,outsideDefault} from './visual-patch.js';
import {icon} from './icons.js';

const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const withIcon=(node,name)=>{node.insertAdjacentHTML('afterbegin',icon(name));return node;};
const SVG='http://www.w3.org/2000/svg';
// note names for ranges of notes (middle C, 60, is C4), and reading one back: "C4", "c#3", "Db5" or a plain MIDI number
const NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const noteName=n=>NAMES[((Math.round(n)%12)+12)%12]+(Math.floor(Math.round(n)/12)-1);
export function readNote(text){
  const t=String(text).trim();if(/^\d{1,3}$/.test(t))return +t<=127?+t:null;
  const m=/^([A-Ga-g])([#b]?)(-?\d)$/.exec(t);if(!m)return null;
  const n=[0,2,4,5,7,9,11]['CDEFGAB'.indexOf(m[1].toUpperCase())]+(m[2]==='#'?1:m[2]==='b'?-1:0)+(+m[3]+1)*12;
  return n>=0&&n<=127?n:null;
}
export const TYPE_WORDS={trigger:'moments',gate:'on/off',amount:'a level',bend:'a bend (centered)',notes:'a melody'};

/** How a cable converts its source for its input, in plain words (shown under each cable). */
export function conversion(from,to){
  if(from===to)return {trigger:'Each moment passes straight through.',gate:'On and off pass straight through.',amount:'The level passes straight through.',
    bend:'The bend passes straight through.',notes:'The notes pass straight through.'}[from];
  if(to==='trigger')return from==='gate'?'Fires each time it turns on.':'Fires each time it rises past the threshold.';
  if(to==='gate')return from==='trigger'?'Each moment turns it on for the hold time.':'On while the level is above the threshold.';
  if(from==='trigger')return 'Each moment lights it up, then it fades.';
  if(from==='gate')return 'Full while on, nothing while off.';
  if(from==='bend')return 'Centered is halfway; bent down is low, bent up is high.';
  return 'Centered (halfway) means no bend.';
}

/** The Advanced Visuals Editor: the patch bay as a whole page in the main window, in place of the chart (app.js opens and closes it).
 *  container: where it goes. onSave(songId or null, visual id, patch or null). stored(songId or null, visual id): the patch saved there
 *  now, or null (the defaults), so Undo can put it back exactly. onChoose(visual id): show another visualization (every visualizer
 *  follows). onPopOut(): open the visualizer in its own window. onClose(): back to the chart.
 *  Its preview (a corner of the page) is where the visualizer draws: the returned `preview` element. */
export function mountPatchBay(container,{onSave,stored=()=>null,onChoose=()=>{},defaultVisualMenu=null,onPopOut=()=>{},onClose=()=>{}}){
  const panel=el('div','vx');panel.setAttribute('role','region');panel.setAttribute('aria-label','Advanced Visuals Editor');
  // ---- the bar along the top: which visualization, whose patch (this song's or every song's), Undo/Redo, the defaults, Pop out, Close ----
  const bar=el('header','vx-bar'),title=withIcon(el('h2','vx-title','Visuals editor'),'layers');
  const pick=el('label','vx-pick'),choice=el('select','vx-visual');pick.append(el('span','vx-cap','Editing'),choice);
  choice.title='Which visualization to edit. It is also the one every visualizer shows.';
  choice.onchange=()=>onChoose(choice.value);
  // whose patch is being edited: one switch, Every song (off) or This song only (on). Its knob carries the notes: four beamed notes for
  // every song, gathering into one quarter note as it slides over to this song.
  const which=el('span','vx-cap','for');
  const scope=el('button','bay-scope');scope.type='button';scope.setAttribute('role','switch');scope.setAttribute('aria-label','Editing visuals for this song only');
  const knob=el('span','bay-knob'),scopeText=el('span','bay-scope-text');
  knob.innerHTML=`<svg viewBox="0 0 26 16" aria-hidden="true">${[0,1,2,3].map(i=>`<g class="bay-note" style="--fan:${(i-1.5)*6}px"><ellipse cx="13" cy="12.8" rx="2.6" ry="1.9" transform="rotate(-22 13 12.8)"/><rect x="14.7" y="2" width="1.2" height="10.8"/></g>`).join('')}<rect class="bay-beam" x="5.7" y="2" width="19.2" height="2.2"/></svg>`;
  scope.append(knob,scopeText);
  const button=(className,text,iconName,title)=>{const b=el('button',className,text);b.type='button';if(iconName)withIcon(b,iconName);if(title)b.title=title;return b;};
  const undoButton=button('btn sq bay-undo','', 'undo'),redoButton=button('btn sq bay-redo','','redo');
  undoButton.setAttribute('aria-label','Undo');redoButton.setAttribute('aria-label','Redo');
  const reset=button('btn bay-reset','Back to the defaults');
  const popOut=button('btn vx-popout','Pop out','expand','Open the visualizer in its own window, to put on another monitor or full screen. The preview here keeps going.');
  const close=button('btn sq vx-close','','x','Close the editor and go back to the chart (your changes are already saved)');close.setAttribute('aria-label','Close the editor');
  popOut.onclick=()=>onPopOut();close.onclick=()=>onClose();
  const defaultPick=el('label','vx-pick');defaultPick.title='The visualization this song opens with. The same choice as the menu under the mixer.';if(defaultVisualMenu)defaultPick.append(el('span','vx-cap','Default Visualization'),defaultVisualMenu);
  bar.append(title,pick,defaultPick,which,scope,el('span','vx-gap'),undoButton,redoButton,reset,popOut,close);
  const note=el('p','vx-note');
  // ---- three columns: the sources, the visualization's inputs, and the preview with the chosen input's settings under it ----
  const body=el('div','vx-body');
  const left=el('section','vx-col vx-sources'),middle=el('section','vx-col vx-inputs'),side=el('section','vx-col vx-side');
  const sourcesHead=el('div','vx-head'),sourcesCount=el('small','vx-count'),inputsHead=el('div','vx-head'),inputsTitle=el('b','',''),inputsCount=el('small','vx-count');
  sourcesHead.append(el('b','','Sources'),sourcesCount);inputsHead.append(inputsTitle,inputsCount);
  const sourcesList=el('div','bay-sources'),inputsList=el('div','bay-inputs');
  // finding a source among hundreds (a whole DAW project): search, and "In use" for just the connected ones
  const find=el('div','bay-find'),search=el('input','bay-search'),inUse=button('btn bay-in-use','In use');
  search.type='search';search.placeholder='Find a source…';search.setAttribute('aria-label','Find a source by name');
  search.title='Type part of a name: a track, a stem, a controller ("sustain", "cc1", "kick"). Esc clears it.';
  inUse.title='Show only the sources that are connected to something';inUse.setAttribute('aria-pressed','false');
  find.append(search,inUse);left.append(sourcesHead,find,sourcesList);
  const hint=el('p','bay-hint','Click a source on the left, then an input here, to connect them (or drag one across). Click an input to see and adjust what moves it.');
  middle.append(inputsHead,hint,inputsList);
  const preview=el('div','vx-preview');preview.setAttribute('aria-label','Preview');
  const editor=el('div','bay-editor'),mixerSlot=el('div','vx-mixer');    // the mixer goes under the preview (visualizer-view.js)
  side.append(preview,mixerSlot,editor);
  const wires=document.createElementNS(SVG,'svg');wires.setAttribute('class','bay-wires');wires.setAttribute('aria-hidden','true');
  body.append(left,middle,side,wires);
  panel.append(bar,note,body);container.append(panel);
  // Esc lets go of a chosen source
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'&&armed){arm(null);event.stopPropagation();}});

  let open=true,view=null,signature='',armed=null,selected=null,hovered=null,dragFrom=null,query='',onlyUsed=false;
  const sourceRows=new Map(),inputRows=new Map(),lights=new Map();
  // the source tree: a group (Song, Stems, Your MIDI…) holds parts (a track, a stem, a melody), each holding its signals. Folded parts keep the
  // list short however many tracks there are; what was opened or closed by hand is remembered here ('group' or 'group/part' -> open?).
  const opened=new Map(),anchors=new Map();     // anchors: a source in a folded part -> the heading its cable hangs from
  const refresh=()=>{renderSources();requestAnimationFrame(()=>drawWires());};
  search.oninput=()=>{query=search.value;refresh();};
  search.onkeydown=event=>{if(event.key==='Escape'&&search.value){search.value='';query='';refresh();event.stopPropagation();}};
  inUse.onclick=()=>{onlyUsed=!onlyUsed;inUse.setAttribute('aria-pressed',String(onlyUsed));refresh();};
  const typeOf=id=>view?.byId.get(id)?.type;

  // ---- what is shown: the visualization, its inputs and patch, and the song's sources ----
  function setVisual(next){
    view=next?{...next,byId:new Map(next.catalog.map(s=>[s.id,s]))}:null;
    if(next&&next.songId!==historySong){historySong=next.songId;past=[];future=[];showHistory();}
    const sig=JSON.stringify(next?[next.visual?.id,next.catalog.map(s=>s.id),next.inputs,next.patch,next.scope,next.songId]:null);
    if(sig===signature)return;signature=sig;render();
  }
  // ---- Undo and Redo (buttons, and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y while the bay is open): every change, "This song only" and Back to the
  // defaults included, is kept as what was saved at that place before and after. Several moves of one control within a moment count as one.
  // Kept for the open song only, since a song's own patch can only be changed while it is open.
  let past=[],future=[],historySong;
  function store(songId,visualId,patch,label){
    const before=stored(songId,visualId),top=past[past.length-1],now=Date.now();
    if(top&&top.songId===songId&&top.visual===visualId&&top.label===label&&now-top.at<1500){top.after=patch;top.at=now;}
    else past.push({songId,visual:visualId,name:view?.visual?.name||'',before:before&&structuredClone(before),after:patch,label,at:now});
    if(past.length>200)past.shift();
    future=[];onSave(songId,visualId,patch);showHistory();
  }
  function step(back){
    const from=back?past:future,to=back?future:past,entry=from.pop();if(!entry)return;
    to.push(entry);entry.at=0;onSave(entry.songId,entry.visual,back?entry.before:entry.after);showHistory();
  }
  function showHistory(){
    const u=past[past.length-1],r=future[future.length-1];
    undoButton.disabled=!u;redoButton.disabled=!r;
    undoButton.title=u?`Undo: ${u.label} (${u.name}). Ctrl+Z also does this while the editor is open.`:'Nothing to undo yet: your changes in this editor can be undone here.';
    redoButton.title=r?`Redo: ${r.label} (${r.name}). Ctrl+Shift+Z or Ctrl+Y also does this.`:'Nothing to redo: this puts back a change you just undid.';
  }
  undoButton.onclick=()=>step(true);redoButton.onclick=()=>step(false);
  // the keys work anywhere in this window while the bay is open (not only on the panel), and never reach the chart's own Undo behind it;
  // a text box keeps its own undo
  const keys=event=>{
    if(!open||!(event.ctrlKey||event.metaKey)||event.altKey)return;
    const key=String(event.key).toLowerCase(),redo=(key==='z'&&event.shiftKey)||(key==='y'&&!event.shiftKey);
    if(!redo&&!(key==='z'&&!event.shiftKey))return;
    if(event.target?.matches?.('input[type=text],input[type=search],textarea,[contenteditable=""],[contenteditable=true]'))return;
    event.preventDefault();event.stopPropagation();step(!redo);
  };
  container.ownerDocument.addEventListener('keydown',keys,true);
  const scopeAt=()=>view.scope==='song'?view.songId:null;
  function save(patch,label){
    if(!view)return;
    patch={...patch,inputs:view.inputs.map(i=>i.key)};    // what it knew, so an input the visualization gains later starts plugged in
    view.patch=patch;store(scopeAt(),view.visual.id,patch,label);render();
  }
  // this song keeps its own copy from now on / back to the usual patch (this song's own is removed; Undo brings it back)
  scope.onclick=()=>{
    if(!view?.songId)return;
    if(view.scope==='song')store(view.songId,view.visual.id,null,'Every song');
    else store(view.songId,view.visual.id,structuredClone(view.patch),'This song only');
  };
  // the defaults: a song's own patch becomes the defaults (it stays this song's own); the usual one is removed, which means the defaults
  reset.onclick=()=>{
    if(!view)return;
    if(view.scope==='song'){save(defaultPatch(view.inputs),'Back to the defaults');return;}
    view.patch=defaultPatch(view.inputs);store(null,view.visual.id,null,'Back to the defaults');render();
  };

  function render(){
    const has=!!view&&view.inputs.length>0;
    // with nothing to patch, the page still shows its bar and the preview; the columns say why they are empty
    note.hidden=has;left.hidden=middle.hidden=editor.hidden=!has;which.hidden=scope.hidden=reset.hidden=!has;
    if(!view){note.textContent='Waiting for a song… open one in the sidebar.';drawWires();return;}
    if(!has){note.textContent=`${view.visual?.name||'This visualization'} has nothing to patch: it always reacts the way it was made to. Choose another one under Editing.`;drawWires();return;}
    inputsTitle.textContent=`${view.visual.name}’s inputs`;inputsCount.textContent=String(view.inputs.length);
    sourcesCount.textContent=String(view.catalog.length);
    const own=view.scope==='song';
    scope.setAttribute('aria-checked',String(own));scope.disabled=!view.songId;scopeText.textContent=own?'This song only':'Every song';
    scope.title=!view.songId?'Open a song to give it a patch of its own'
      :own?`Your changes to ${view.visual.name} affect only this song. Click to go back to the patch every song uses (this song’s own is removed; Undo brings it back).`
      :`Your changes to ${view.visual.name} affect every song without a patch of its own. Click to give this song its own, starting as a copy of this one.`;
    reset.title=`Put every cable back the way ${view.visual.name} comes, ${view.scope==='song'?'for this song':'for every song without its own patch'}`;
    if(selected&&!view.inputs.some(i=>i.key===selected))selected=null;
    renderSources();renderInputs();renderEditor();requestAnimationFrame(()=>drawWires());
  }
  // the visualizations to choose from, and the one showing (from the visualizer: it changes when a file is added or another is chosen)
  function setScenes(list,currentId){
    const sig=JSON.stringify([list.map(s=>[s.id,s.name]),currentId]);if(sig===setScenes.sig)return;setScenes.sig=sig;
    choice.replaceChildren(...list.map(s=>{const o=el('option','',s.name);o.value=s.id;return o;}));
    if(currentId)choice.value=currentId;
  }
  function renderSources(){
    sourceRows.clear();anchors.clear();sourcesList.replaceChildren();
    const used=new Set(view.patch.cables.map(c=>c.from)),fitting=view.inputs.find(i=>i.key===selected);
    const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches=s=>(!onlyUsed||used.has(s.id))&&words.every(w=>[s.label,s.group,s.part||'',s.short||'',s.help||''].join(' ').toLowerCase().includes(w));
    const filtering=words.length>0||onlyUsed;
    // the catalog's order, grouped: group -> part -> sources
    const groups=new Map();
    for(const s of view.catalog){
      if(!matches(s))continue;
      if(!groups.has(s.group))groups.set(s.group,new Map());
      const parts=groups.get(s.group),key=s.part??'';if(!parts.has(key))parts.set(key,[]);parts.get(key).push(s);
    }
    if(!groups.size){sourcesList.append(el('p','bay-help bay-none',onlyUsed&&!words.length?'Nothing is connected yet.':`Nothing matches “${query.trim()}”.`));return;}
    const isOpen=(key,fallback)=>filtering||(opened.has(key)?opened.get(key):fallback);
    const heading=(className,key,label,list,openNow)=>{
      const h=el('button',className);h.type='button';h.setAttribute('aria-expanded',String(openNow));
      const n=list.length,on=list.filter(s=>used.has(s.id)).length;
      h.append(el('span','bay-fold'),el('span','bay-label',label),el('small','bay-count',on?`${on} of ${n} in use`:String(n)));
      h.classList.toggle('used',on>0);
      h.title=filtering?`${label}: showing what matches`:`${openNow?'Fold away':'Show'} ${label}: ${n} source${n===1?'':'s'}${on?`, ${on} connected`:''}`;
      h.onclick=()=>{if(filtering)return;opened.set(key,!openNow);refresh();};
      sourcesList.append(h);return h;
    };
    for(const [group,parts] of groups){
      const all=[...parts.values()].flat(),groupOpen=isOpen(group,true);
      const gh=heading('bay-group',group,group,all,groupOpen);
      if(!groupOpen){for(const s of all)anchors.set(s.id,gh);continue;}
      for(const [part,list] of parts){
        if(part){
          const key=group+'/'+part,partOpen=isOpen(key,list.some(s=>used.has(s.id)));   // a part with a cable starts open
          const ph=heading('bay-part',key,part,list,partOpen);
          if(!partOpen){for(const s of list)anchors.set(s.id,ph);continue;}
        }
        for(const s of list){
          const row=el('button','bay-source');row.type='button';row.dataset.type=s.type;row.dataset.source=s.id;row.classList.toggle('nested',!!part);
          const fits=!fitting||canConnect(s.type,fitting.type);row.classList.toggle('unfit',!fits);
          row.title=`${s.label}: ${s.help}. It sends ${TYPE_WORDS[s.type]}.`+(fits?' Click, then click a part on the right to connect it.':` It cannot drive ${fitting.label}, which takes ${TYPE_WORDS[fitting.type]}.`);
          const light=el('span','bay-light'),jack=el('span','bay-jack');
          row.append(light,el('span','bay-label',part?s.short||s.label:s.label),jack);row.classList.toggle('used',used.has(s.id));
          row.setAttribute('aria-pressed',String(armed===s.id));
          row.onclick=()=>arm(armed===s.id?null:s.id);
          row.onpointerdown=event=>startDrag(event,s.id);
          sourcesList.append(row);sourceRows.set(s.id,row);
        }
      }
    }
  }
  // each input: its jack (where the cables plug in), its name and a light; the cables of the one under the mouse stand out
  function renderInputs(){
    inputRows.clear();inputsList.replaceChildren();
    for(const input of view.inputs){
      const row=el('button','bay-input');row.type='button';row.dataset.type=input.type;row.dataset.input=input.key;
      const cables=view.patch.cables.filter(c=>c.to===input.key).length;
      row.title=`${input.help||input.label}. It takes ${TYPE_WORDS[input.type]}. `+(armed?'Click to connect the chosen source here.':'Click to see and adjust what moves it.');
      row.append(el('span','bay-jack'),el('span','bay-label',input.label),el('span','bay-light'));
      if(cables>1)row.append(el('small','bay-many','×'+cables));
      row.setAttribute('aria-pressed',String(selected===input.key));
      const fits=!armed||canConnect(typeOf(armed),input.type);row.classList.toggle('unfit',!fits);
      row.onclick=()=>{if(armed){if(fits)connect(armed,input.key);return;}selected=selected===input.key?null:input.key;render();};
      row.onpointerenter=()=>{hovered=input.key;drawWires();};row.onpointerleave=()=>{if(hovered===input.key){hovered=null;drawWires();}};
      inputsList.append(row);inputRows.set(input.key,row);
    }
  }
  function arm(id){armed=id;panel.classList.toggle('arming',!!id);if(view)render();}
  function connect(from,to){
    armed=null;panel.classList.remove('arming');selected=to;
    if(view.patch.cables.some(c=>c.from===from&&c.to===to)){render();return;}
    save({cables:[...view.patch.cables,{from,to}]},`Connect ${view.byId.get(from)?.label||'a source'} to ${view.inputs.find(i=>i.key===to)?.label||to}`);
  }
  // drag from a source and let go over an input (a click without moving arms the source instead, through the row's click)
  function startDrag(event,id){
    if(event.button!==0)return;
    const move=e=>{dragFrom=id;panel.classList.add('dragging-cable');drawWires(e);},up=e=>{
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);panel.classList.remove('dragging-cable');
      const dragged=dragFrom;dragFrom=null;
      const target=document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.bay-input');
      const input=target&&view?.inputs.find(i=>i.key===target.dataset.input);
      if(dragged&&input&&canConnect(typeOf(dragged),input.type))connect(dragged,input.key);else drawWires();
    };
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);
  }

  // ---- the selected input's cables, each with its settings ----
  function renderEditor(){
    editor.replaceChildren();
    const input=view.inputs.find(i=>i.key===selected);
    if(!input){editor.append(el('p','bay-hint','Choose an input to see and adjust what moves it.'));return;}
    editor.append(el('b','bay-editing',input.label),el('p','bay-help',(input.help?input.help+'. ':'')+`It takes ${TYPE_WORDS[input.type]}.`));
    const cables=view.patch.cables.filter(c=>c.to===input.key);
    if(!cables.length){
      const def=input.default&&view.byId.get(input.default);
      editor.append(el('p','bay-help','Nothing is connected, so this part stays still.'+(def?` It comes connected to “${def.label}”; Back to the defaults puts that back.`:'')));
    }
    for(const cable of cables){
      const source=view.byId.get(cable.from),row=el('div','bay-cable');row.dataset.type=source?.type||'';
      const name=el('span','bay-from',source?source.label:`${cable.from.split('/').map(decodeURIComponent).slice(1).join(': ')} (not in this song)`);
      const unplug=el('button','bay-unplug','Unplug');unplug.type='button';unplug.title=`Disconnect ${source?.label||'this source'} from ${input.label}`;
      unplug.onclick=()=>save({cables:view.patch.cables.filter(c=>!(c.from===cable.from&&c.to===cable.to))},`Unplug ${source?.label||'a source'} from ${input.label}`);
      row.append(name,unplug);
      if(!source){row.append(el('small','bay-help','This song has no such source, so this cable waits for a song that does.'));editor.append(row);continue;}
      row.append(el('small','bay-help',conversion(source.type,input.type)));
      if(fitUnit(cable.from,source.type))row.append(fitRow(cable,source));
      for(const key of adapterSettings(source.type,input.type)||[]){
        if(key==='max')continue;                                  // Min and Max share one slider with two handles
        row.append(key==='min'?minMax(cable,input):setting(cable,key,input));
      }
      editor.append(row);
    }
  }
  // Range ("Set from range"): which part of a MIDI signal counts as its full range (visual-patch.js, fit). Notes: a range of notes (the
  // others are left out); everything else: a span of its level, stretched to full scale. Measured from the song, or typed.
  function fitRow(cable,source){
    const unit=fitUnit(cable.from,source.type),notes=unit==='note',midi=unit==='midi',span=view.range?.(cable.from);
    // notes by name; your MIDI's velocities, controllers and pressure 0-127, as MIDI writes them; anything else in percent
    const show=v=>notes?noteName(v):midi?String(Math.round(v*127)):Math.round(v*100)+'%';
    const read=text=>{
      if(notes)return readNote(text);
      const m=/^\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/.exec(text);if(!m)return null;
      return midi?(+m[1]>=0&&+m[1]<=127?+m[1]/127:null):+m[1]/100;
    };
    const row=el('div','bay-fit');
    const edit=(changes,drop=[])=>save({cables:view.patch.cables.map(c=>c.from===cable.from&&c.to===cable.to
      ?Object.fromEntries(Object.entries({...c,...changes}).filter(([k])=>!drop.includes(k))):c)},`Change the range of ${source.label}`);
    const change=fit=>fit?edit({fit}):edit({},['fit','outside']);
    const outside=cable.outside||outsideDefault(source.type);
    const what=(source.type==='notes'?'It becomes the melody’s bottom and top. ':notes?'The lowest note here is the bottom, the highest the top. ':'This span is stretched to the full range. ')
      +(outside==='drop'?(source.type==='notes'?'Notes outside it are left out.':source.type==='trigger'?'Hits outside it are left out.':'Outside it, it reads as nothing.')
        :(source.type==='notes'?'Notes outside it are held at its bottom or top note.':'Outside it, it is held at the bottom or the top.'));
    row.append(el('span','bay-fit-label','Range'));
    if(cable.fit){
      const box=(value,which)=>{const input=el('input','bay-fit-box');input.type='text';input.value=show(value);input.size=5;
        input.setAttribute('aria-label',`${which} of the range for ${source.label}`);input.title=notes?'A note name such as C3 or F#4 (middle C is C4), or a MIDI number':midi?'A MIDI value from 0 to 127':'A percentage';
        input.onchange=()=>{const v=read(input.value),next=[...cable.fit];next[which==='Bottom'?0:1]=v;
          if(v===null||!(next[1]>next[0])){input.value=show(value);return;}change(next);};return input;};
      row.append(box(cable.fit[0],'Bottom'),el('span','bay-help bay-fit-to','to'),box(cable.fit[1],'Top'));
    }else row.append(el('small','bay-help bay-fit-all','All of it'));
    const set=el('button','bay-unplug','Set from range');set.type='button';set.disabled=!span;
    set.title=span?`Use what ${source.label} really covers in this song (${show(span.low)} to ${show(span.high)}). ${what}`
      :`${source.label} does not change in this song, so there is no range to set from`;
    set.onclick=()=>span&&change([span.low,span.high]);row.append(set);
    if(cable.fit){
      const clear=el('button','bay-unplug','Use all of it');clear.type='button';clear.title='Go back to using its whole range';clear.onclick=()=>change(null);row.append(clear);
      // outside the range: clip (held at the edge) or leave out
      const choice=el('div','bay-outside');choice.setAttribute('role','group');choice.setAttribute('aria-label',`Outside the range of ${source.label}`);
      for(const [value,label,title] of [['clip','Clip','Values past the range are held at its edge: above the top counts as the top, below the bottom as the bottom'],
        ['drop','Leave out',source.type==='notes'?'Notes outside the range are ignored':source.type==='trigger'?'Hits outside the range are ignored':'Outside the range it reads as nothing']]){
        const b=el('button','bay-unplug',label);b.type='button';b.title=title;b.setAttribute('aria-pressed',String(outside===value));
        b.onclick=()=>outside!==value&&edit({outside:value});choice.append(b);
      }
      row.append(el('span','bay-fit-label','Outside'),choice);
    }
    row.append(el('small','bay-help bay-fit-note',cable.fit?what:'Set from range picks the part of it this song really uses; you can then type your own.'));
    return row;
  }
  // A cable's settings change in place (no redraw, so the control being dragged keeps the pointer); the cable is found by where it runs,
  // since every save makes a new copy of it.
  function update(cable,changes,label){
    view.patch={cables:view.patch.cables.map(c=>c.from===cable.from&&c.to===cable.to?{...c,...changes}:c)};
    store(scopeAt(),view.visual.id,view.patch,label);
  }
  // Min and Max: one slider with two handles; the stretch between them, in the cable's color, is the range it sends.
  function minMax(cable,input){
    const lo=SETTINGS.min,hi=SETTINGS.max,row=el('div','bay-setting bay-minmax');row.title='Drag the left handle to set the lowest value it sends (Min) and the right one for the highest (Max)';
    const track=el('div','bay-dual'),fill=el('span','bay-dual-fill'),out=el('output');
    const handle=(spec,key,value)=>{const r=el('input');r.type='range';r.min=spec.min;r.max=spec.max;r.step=spec.step;r.value=value;
      r.setAttribute('aria-label',`${spec.label} for ${input.label}`);r.title=spec.help;return r;};
    const a=handle(lo,'min','min' in cable?cable.min:lo.value),b=handle(hi,'max','max' in cable?cable.max:hi.value);
    const paint=()=>{const x=+a.value,y=+b.value;fill.style.left=x*100+'%';fill.style.right=(1-y)*100+'%';out.textContent=`${x.toFixed(2)}–${y.toFixed(2)}`;
      a.style.zIndex=x>0.5?3:2;};                                  // near the top, the Min handle sits above so both can still be reached
    a.oninput=()=>{if(+a.value>+b.value)a.value=b.value;paint();};
    b.oninput=()=>{if(+b.value<+a.value)b.value=a.value;paint();};
    a.onchange=b.onchange=()=>update(cable,{min:+a.value,max:+b.value},`Change Min / Max for ${input.label}`);
    track.append(fill,a,b);row.append(el('span','','Min / Max'),track,out);paint();
    return row;
  }
  function setting(cable,key,input){
    const spec=SETTINGS[key],label=el('label','bay-setting');label.title=spec.help;
    const value=key in cable?cable[key]:spec.value;
    const change=v=>update(cable,{[key]:v},`Change ${spec.label} for ${input.label}`);
    if(spec.boolean){
      const box=el('input');box.type='checkbox';box.checked=!!value;box.onchange=()=>change(box.checked);
      label.append(box,el('span','',spec.label));return label;
    }
    const range=el('input'),out=el('output');range.type='range';range.min=spec.min;range.max=spec.max;range.step=spec.step;range.value=value;
    range.setAttribute('aria-label',`${spec.label} for ${input.label}`);
    const show=v=>out.textContent=(+v).toFixed(spec.step<0.1?2:1)+(spec.unit||'');show(value);
    range.oninput=()=>show(range.value);range.onchange=()=>change(Number(range.value));
    label.append(el('span','',spec.label),range,out);return label;
  }

  // A 3.5mm plug, drawn pointing into its jack at (x, y): dir 1 when the cable leaves to the right (a source's jack), -1 to the left (an
  // input's). Tip with its two rings, collar, a barrel in the cable's color, and the strain relief the cable comes out of, PLUG long.
  const PLUG=27;
  function plug(x,y,dir,type,extra){
    const g=document.createElementNS(SVG,'g');g.setAttribute('class',`bay-plug ${extra}`);g.dataset.type=type;
    g.setAttribute('transform',`translate(${x},${y}) scale(${dir},1)`);
    g.innerHTML='<path class="bay-plug-tip" d="M-1.5,-1.7 H7 V1.7 H-1.5 A1.7,1.7 0 0 1 -1.5,-1.7 Z"/><path class="bay-plug-ring" d="M1.6,-1.7 V1.7 M4.2,-1.7 V1.7"/>'
      +'<rect class="bay-plug-collar" x="7" y="-3" width="3" height="6" rx="0.8"/><rect class="bay-plug-barrel" x="10" y="-4.6" width="11" height="9.2" rx="2.2"/>'
      +`<path class="bay-plug-boot" d="M21,-3.6 L${PLUG},-2 V2 L21,3.6 Z"/>`;
    wires.append(g);
  }
  // ---- the cables, hanging between the columns from plug to plug; the chosen input's (and the one under the mouse) stand out ----
  function drawWires(pointer){
    wires.replaceChildren();if(!view||left.hidden)return;
    const box=body.getBoundingClientRect(),lists=[sourcesList.getBoundingClientRect(),inputsList.getBoundingClientRect()];
    wires.setAttribute('viewBox',`0 0 ${box.width} ${box.height}`);wires.setAttribute('width',box.width);wires.setAttribute('height',box.height);
    // where a cable meets its row: the row's jack, or the right edge of a folded heading; kept inside the list's visible part (dotted if not)
    const end=(row,side)=>{
      const list=lists[side?0:1],jack=row.querySelector('.bay-jack'),r=(jack||row).getBoundingClientRect();
      const x=jack?r.left+r.width/2-box.left:r.right-box.left-6,y=r.top+r.height/2-box.top;
      return {x,y:Math.max(list.top-box.top+4,Math.min(list.bottom-box.top-4,y)),off:r.bottom<list.top||r.top>list.bottom||!jack};
    };
    // a cable runs from the end of one plug's boot to the other's (a loose cable's far end is the pointer: no plug there). An end whose
    // row is scrolled out of sight or folded away has no plug either: its cable just runs to the edge, until the row is on show
    const hang=(a,b,type,extra='',plugged=true)=>{
      const x0=a.off?a.x:a.x+PLUG,x1=plugged&&!b.off?b.x-PLUG:b.x,sag=Math.min(60,Math.abs(x1-x0)*0.25+20),p=document.createElementNS(SVG,'path');
      p.setAttribute('d',`M${x0},${a.y} C${x0+40},${a.y+sag} ${x1-40},${b.y+sag} ${x1},${b.y}`);
      p.setAttribute('class',`bay-wire ${extra}`);p.dataset.type=type;wires.append(p);
      if(!a.off)plug(a.x,a.y,1,type,extra);if(plugged&&!b.off)plug(b.x,b.y,-1,type,extra);
    };
    // the standing-out ones last, so they lie on top
    const lit=c=>c.to===selected||c.to===hovered;
    for(const cable of [...view.patch.cables.filter(c=>!lit(c)),...view.patch.cables.filter(lit)]){
      const s=sourceRows.get(cable.from)||anchors.get(cable.from),i=inputRows.get(cable.to);if(!s||!i)continue;
      const a=end(s,true),b=end(i,false);
      hang(a,b,typeOf(cable.from),(a.off||b.off?'offscreen ':'')+(lit(cable)?'chosen':selected||hovered?'faded':''));
    }
    // a cable being dragged, or one waiting in a chosen source's jack, follows the pointer
    const loose=sourceRows.get(dragFrom||armed);
    if(loose&&pointer?.clientX!==undefined)hang(end(loose,true),{x:pointer.clientX-box.left,y:pointer.clientY-box.top},loose.dataset.type,'loose',false);
  }
  sourcesList.addEventListener('scroll',()=>drawWires(),{passive:true});
  inputsList.addEventListener('scroll',()=>drawWires(),{passive:true});
  body.addEventListener('pointermove',e=>{if(armed)drawWires(e);});
  const onResize=()=>drawWires();window.addEventListener('resize',onResize);

  // ---- the lights: each source's and input's value as the song plays (triggers flash and fade) ----
  function glow(node,key,value,type,dt){
    let v=type==='trigger'?(value?.length?Math.max(...value):0):type==='gate'?(value?1:0):type==='notes'?(value?.active?.length?1:0):type==='bend'?Math.abs(value||0):(value||0);
    const was=lights.get(key)||0;if(type==='trigger')v=Math.max(v,was*Math.exp(-dt/0.18));lights.set(key,v);
    node.style.setProperty('--glow',Math.max(0,Math.min(1,v)).toFixed(2));
  }
  function showLevels(values,inputs,dt){
    if(!open||!view)return;
    for(const [id,row] of sourceRows){const light=row.firstChild;if(values.has(id))glow(light,'s:'+id,values.get(id),row.dataset.type,dt);}
    for(const [key,row] of inputRows)glow(row.querySelector('.bay-light'),'i:'+key,inputs[key],row.dataset.type,dt);
  }

  render();showHistory();
  return {
    setVisual,setScenes,showLevels,redraw:()=>drawWires(),
    visibleSources:()=>[...sourceRows.keys()],          // only these need their lights worked out (folded parts and other songs' don't)
    get open(){return open;},
    element:panel,preview,mixerSlot,
    dispose(){open=false;window.removeEventListener('resize',onResize);container.ownerDocument.removeEventListener('keydown',keys,true);panel.remove();},
  };
}
