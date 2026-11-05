// The Prepare page: a song's arrangement on a timeline, and the Show page: songs in order, with how long it all takes. The sections run along the
// top, one column per bar; below them the Arrangement lane holds repeats, and the Tracks, Visuals, MIDI and Markers lanes hold actions. Everything that can be
// dragged or clicked can also be typed into: the action list and inspector on the right reach every action, by keyboard. Each edit is saved as a draft at once;
// Save makes a revision a show can use. Pure parts (lanes, Undo) are exported so they can be tested without a page.
import {askChoice,askText} from './dialogs.js';
import {icon} from './icons.js';
import {renderRail,watchRail} from './tool-rail.js';
import {ACTIONS,STEM_ROLES,checkAction,describeAction,domainOf} from './performance-actions.js';
import {addressPosition,compilePerformance,endForBeats,gridFingerprint} from './performance-compiler.js';
import {clockText,pathSeconds,showSeconds,spareText} from './performance-duration.js';
import {COMMANDS,learnFrom} from './performance-midi.js';
import {messagesFor} from './performance-midi.js';
import {addRepeat,address,copyCues,moveCue,copyPass,copyPreviousPass,defaultPolicy,editPass,newEntry,newPerformance,newShow,removePass,removeRegion,resetPass,setPlays,POLICIES,movePass,customizedPasses} from './performance-model.js';

const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const btn=(cls,text,title,run,iconName)=>{const b=el('button','btn '+cls,text);b.type='button';if(iconName)b.insertAdjacentHTML('afterbegin',icon(iconName));if(title)b.title=title;if(run)b.onclick=run;return b;};
/** A small menu, the way the top bar does it. */
function menu(label,items){
  const d=el('details','more pf-menu'),summary=el('summary','btn sq');summary.title=label;summary.setAttribute('aria-label',label);summary.innerHTML=icon('more');
  const pop=el('div','more-pop');pop.append(...items);d.append(summary,pop);
  pop.addEventListener('click',()=>{d.open=false;});
  return d;
}
function menuItem(text,title,run,danger=false){const b=el('button','text-button'+(danger?' danger':''),text);b.type='button';b.title=title;b.onclick=run;return b;}
const uid=()=>globalThis.crypto.randomUUID().replaceAll('-','').slice(0,16);

export const LANES=Object.freeze([['tracks','Tracks','Mutes, levels and solos'],['visuals','Visuals','Which visualization, and what it does'],['midi','MIDI','Messages to a pedal or other device'],['markers','Markers','Notes on the stage screen']]);
export const laneOf=action=>{const d=domainOf(action);return d==='tracks'||d==='rate'?'tracks':d==='visuals'?'visuals':d==='midi'?'midi':'markers';};
export const POLICY_LABELS=Object.freeze({'until-released':'You win until you release it (usual)','next-cue':'Until the next planned change','next-section':'Until the next section','locked':'Follow the plan only (controls locked)'});
const STEM_NAMES={bass:'Bass',drums:'Drums',other:'Other',vocals:'Vocals',piano:'Piano',lead:'Lead guitar',rhythm:'Rhythm guitar'};

// A new action of each kind, ready to adjust.
export const NEW_ACTION={
  'track.set':()=>({type:'track.set',track:'lead',mute:true}),
  'master.set':()=>({type:'master.set',value:1,ramp:0}),
  'rate.set':()=>({type:'rate.set',percent:100}),
  'visual.scene':({scenes})=>({type:'visual.scene',scene:scenes[0]?.id||'abstract'}),
  'visual.switch':()=>({type:'visual.switch',name:'lyrics',value:true}),
  'visual.patch':()=>({type:'visual.patch',patch:'song'}),
  'visual.input':()=>({type:'visual.input',input:'',value:1,ramp:0}),
  'visual.trigger':()=>({type:'visual.trigger',input:''}),
  'midi.helix':({device})=>({type:'midi.helix',device:device||'Line 6 Helix',channel:1,snapshot:1}),
  'midi.cc':({device})=>({type:'midi.cc',device:device||'Line 6 Helix',channel:1,controller:1,value:127}),
  'midi.pc':({device})=>({type:'midi.pc',device:device||'Line 6 Helix',channel:1,program:0}),
  'midi.note':({device})=>({type:'midi.note',device:device||'Line 6 Helix',channel:1,note:60,velocity:100,length:.5}),
  'marker.text':()=>({type:'marker.text',text:'Note'}),
};
const LANE_TYPES={tracks:['track.set','master.set','rate.set'],visuals:['visual.scene','visual.patch','visual.switch','visual.input','visual.trigger'],midi:['midi.helix','midi.cc','midi.pc','midi.note'],markers:['marker.text']};
// The fields each action shows in the inspector. kind: number, text, check, track, optional-number.
const FIELDS={
  'track.set':[['track','track','Track'],['mute','tristate','Mute'],['solo','tristate','Solo'],['gain','optional','Level (0 to 1)',{min:0,max:1,step:.05}],['ramp','optional','Over this many seconds',{min:0,max:600,step:.5}]],
  'master.set':[['value','number','Overall volume (0 to 1)',{min:0,max:1,step:.05}],['ramp','optional','Over this many seconds (a fade)',{min:0,max:600,step:.5}]],
  'rate.set':[['percent','number','Speed (%)',{min:50,max:125,step:5}]],
  'visual.scene':[['scene','scene','Visualization']],
  'visual.switch':[['name','choice','What',{choices:[['lyrics','The lyrics'],['calm','Calm mode']]}],['value','check','On']],
  'visual.patch':[['patch','choice','Connections',{choices:[['song','This song’s own'],['usual','Your usual ones'],['default','The defaults']]}]],
  'visual.input':[['input','input','Part of the visualization',{wants:'level'}],['value','number','Value (0 to 1)',{min:0,max:1,step:.05}],['ramp','optional','Over this many seconds',{min:0,max:600,step:.5}]],
  'visual.trigger':[['input','input','Effect to fire',{wants:'trigger'}]],
  'midi.helix':[['device','device','Device'],['channel','number','MIDI channel',{min:1,max:16,step:1}],['setlist','optional','Setlist (1 to 8)',{min:1,max:8,step:1}],['preset','optional','Preset (1 to 128)',{min:1,max:128,step:1}],['snapshot','optional','Snapshot (1 to 8)',{min:1,max:8,step:1}]],
  'midi.cc':[['device','device','Device'],['channel','number','MIDI channel',{min:1,max:16,step:1}],['controller','number','Controller',{min:0,max:127,step:1}],['value','number','Value',{min:0,max:127,step:1}]],
  'midi.pc':[['device','device','Device'],['channel','number','MIDI channel',{min:1,max:16,step:1}],['program','number','Program',{min:0,max:127,step:1}]],
  'midi.note':[['device','device','Device'],['channel','number','MIDI channel',{min:1,max:16,step:1}],['note','number','Note (60 is middle C)',{min:0,max:127,step:1}],['velocity','number','Velocity',{min:1,max:127,step:1}],['length','number','Length (seconds)',{min:.01,max:60,step:.05}]],
  'marker.text':[['text','text','Note to show']],
};

/** Undo for whole values: every edit keeps the value before it. */
export class History{
  constructor(value,limit=200){this.value=value;this.past=[];this.future=[];this.limit=limit;}
  push(next){if(next===this.value)return next;this.past.push(this.value);if(this.past.length>this.limit)this.past.shift();this.future=[];this.value=next;return next;}
  undo(){if(!this.past.length)return null;this.future.push(this.value);this.value=this.past.pop();return this.value;}
  redo(){if(!this.future.length)return null;this.past.push(this.value);this.value=this.future.pop();return this.value;}
  get canUndo(){return this.past.length>0;}
  get canRedo(){return this.future.length>0;}
}
/** What differs between a show's songs and its set list's. */
export function listDiff(showSongs,listSongs){
  const have=[...showSongs],added=[];
  for(const id of listSongs){const i=have.indexOf(id);if(i<0)added.push(id);else have.splice(i,1);}
  return {added,removed:have};
}
/** The show with the list's songs, in the list's order. An entry stays with its song, keeping its arrangement and gap. Repeats beyond the list go. */
export function applyListDiff(show,listSongs,makeId){
  const spare=[...show.entries];
  const entries=listSongs.map(songId=>{const i=spare.findIndex(e=>e.songId===songId);return i>=0?spare.splice(i,1)[0]:newEntry({songId,performanceId:null,revision:null,id:makeId()});});
  return {...structuredClone(show),entries:structuredClone(entries)};
}
/** Every action in a performance, wherever it lives, in time order. scope: 'shared', or a pass. */
export function allActions(performance,position){
  const out=[];
  for(const c of performance.cues)out.push({cue:c,scope:{kind:'shared'},seconds:position(c.at)});
  for(const r of performance.regions){
    r.passes.forEach((p,i)=>{for(const c of p.program||[])out.push({cue:c,scope:{kind:'pass',regionId:r.id,passId:p.id,index:i},seconds:position(c.at)});});
    for(const c of r.further?.program||[])out.push({cue:c,scope:{kind:'pass',regionId:r.id,passId:'further',index:null},seconds:position(c.at)});
  }
  return out.sort((a,b)=>a.seconds-b.seconds);
}
export const scopeWords=(scope,region)=>{
  if(scope.kind==='shared')return 'Every play';
  if(scope.passId==='further')return 'Further passes';
  return `Pass ${scope.index+1}${region?` of ${region.plays==='live'?'until released':region.plays}`:''}`;
};
/** The parts of the visualizations an action can reach: [input key, "Starlane: Melody rings"]. wants 'trigger': what fires; 'level': what holds a value. */
export function inputChoices(scenes,wants){
  const out=[];
  for(const scene of scenes)for(const input of scene.inputs||[]){
    if(input.type==='notes')continue;
    if(wants==='trigger'&&input.type!=='trigger')continue;
    if(wants==='level'&&input.type==='trigger')continue;
    out.push([input.key,`${scene.name||scene.id}: ${input.label||input.key}`]);
  }
  return out;
}
const barAtFrame=(measures,seconds)=>measures.find(m=>seconds>=m.start&&seconds<m.end)||measures.at(-1);

/** The Prepare page. deps: {api, songId, scenes(): [{id,name}], devices(): [names], grid (loadSongGrid's result), onClose, onPreview(performance, fromSeconds, sendMidi), onStopPreview, previewing(), showError}. */
export function mountPrepare(root,deps){
  const {api,grid,songId}=deps,measures=grid.measures,position=at=>{const f=addressPosition(measures)(at);return f/44100;};
  let records=[],record=null,history=null,selection={kind:'none'},scope={kind:'shared'},regionId=null,tool='select',disposed=false,saveTimer=null,filter='all',status='',sendMidi=false,listFocus=null;
  let wide=46;

  const panel=el('div','vx pf');panel.setAttribute('role','region');panel.setAttribute('aria-label','Prepare');
  const bar=el('header','vx-bar');
  const title=el('h2','vx-title','Prepare');title.insertAdjacentHTML('afterbegin',icon('layers'));
  const pick=el('label','vx-pick'),choice=el('select','vx-visual');pick.append(el('span','vx-cap','Performance'),choice);choice.title='Which saved arrangement of this song to edit. Original arrangement plays the song as it is.';
  const newB=btn('','New','Make a new arrangement of this song, starting from the song as it is',()=>makeNew());
  const dup=menuItem('Duplicate…','Make a copy of this arrangement under a new name',()=>duplicate());
  const ren=menuItem('Rename…','Give this arrangement a different name',()=>rename());
  const del=menuItem('Delete…','Remove this arrangement. A show that already uses it keeps working.',()=>remove(),true);
  const saved=el('span','pf-saved');saved.setAttribute('role','status');
  const undoB=btn('sq','', 'Undo your last change here (Ctrl+Z)',()=>undo(),'undo');undoB.setAttribute('aria-label','Undo');
  const redoB=btn('sq','', 'Redo (Ctrl+Shift+Z)',()=>redo(),'redo');redoB.setAttribute('aria-label','Redo');
  const saveB=btn('hot','Save','Save this arrangement as a new version that a show can use',()=>save());
  const close=btn('sq','', 'Close and go back to the chart. Your work stays as a draft.',()=>deps.onClose(),'x');close.setAttribute('aria-label','Close Prepare');
  bar.append(title,pick,newB,menu('More for this arrangement',[dup,ren,el('hr','more-sep'),del]),el('span','vx-gap'),saved,undoB,redoB,saveB,close);
  const facts=el('div','pf-facts');const musicLength=el('b'),problems=el('div','pf-problems');problems.setAttribute('role','status');
  const preview=btn('','Preview from here','Play this arrangement from the selected bar. MIDI stays off unless you tick Send to hardware.',()=>startPreview(),'play');
  const stopPreview=btn('','Stop','Stop the preview',()=>{deps.onStopPreview?.();paint();});
  const hw=el('label','pf-check'),hwBox=el('input');hwBox.type='checkbox';hwBox.onchange=()=>{sendMidi=hwBox.checked;};hw.append(hwBox,el('span','','Send to hardware'));hw.title='While previewing, also send this arrangement’s MIDI to your devices. Off, nothing reaches them.';
  facts.append(el('span','vx-cap','Music'),musicLength,el('span','vx-gap'),preview,stopPreview,hw);
  const stage=el('div','pf-prepare');
  const rail=el('nav','tool-rail');rail.setAttribute('aria-label','Prepare tools');
  const left=el('section','vx-col pf-timeline');const passBar=el('div','pf-passes');const scroller=el('div','pf-scroll');left.append(passBar,scroller);
  const side=el('section','vx-col pf-sidebar');const inspector=el('div','pf-inspector'),listHead=el('div','vx-head'),listFilter=el('select','vx-visual pf-filter'),list=el('ol','pf-list');
  listFilter.setAttribute('aria-label','Which actions to list');for(const [v,t] of [['all','All lanes'],...LANES.map(([k,l])=>[k,l])]){const o=el('option','',t);o.value=v;listFilter.append(o);}listFilter.onchange=()=>{filter=listFilter.value;drawList();};
  listHead.append(el('b','','Actions'),listFilter);
  side.append(inspector,listHead,list);
  stage.append(rail,left,side);
  panel.append(bar,facts,problems,stage);root.replaceChildren(panel);watchRail(rail);

  function keydown(event){
    const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='z'){if(!typing){event.preventDefault();event.stopPropagation();event.shiftKey?redo():undo();}return;}
    if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='c'&&!typing&&selectedIds().length){event.preventDefault();event.stopPropagation();copySelected();return;}
    if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='v'&&!typing&&clipboard&&selection.kind==='bars'){event.preventDefault();event.stopPropagation();pasteAt(selection.from);return;}
    if(typing||event.ctrlKey||event.altKey||event.metaKey)return;
    const k=String(event.key).toLowerCase();
    if(k==='v'){setTool('select');event.stopPropagation();}else if(k==='n'){setTool('repeat');event.stopPropagation();}else if(k==='a'){setTool('action');event.stopPropagation();}
    else if(event.key==='Delete'&&selection.kind==='cue'){deleteSelected();event.stopPropagation();}
    else if(event.key==='Delete'&&selection.kind==='cues'){deleteMany(selection.ids);event.stopPropagation();}
    else if(event.key==='Escape'){selection={kind:'none'};paint();event.stopPropagation();}
  }

  const perf=()=>history?.value||null;
  const compiled=()=>perf()?compilePerformance(perf(),{measures,frames:grid.frames}):null;
  function setTool(name){tool=name;drawRail();}
  function drawRail(){renderRail(rail,{groups:[['prepare-select','prepare-repeat','prepare-action']],active:{select:'prepare-select',repeat:'prepare-repeat',action:'prepare-action'}[tool],onPick:name=>setTool({'prepare-select':'select','prepare-repeat':'repeat','prepare-action':'action'}[name])});}

  // ---- records
  async function reload(chooseId=null){
    records=await api('/api/performances/'+encodeURIComponent(songId));
    const id=chooseId||record?.id||records[0]?.id||null;
    await open(id);
  }
  async function open(id){
    clearTimeout(saveTimer);
    if(!id){record=null;history=null;selection={kind:'none'};paint();return;}
    const full=await api('/api/performance/'+encodeURIComponent(id));
    record=full;history=new History(full.draft||full.body);selection={kind:'none'};scope={kind:'shared'};regionId=null;status=full.draft?'Draft kept. Save to make a version a show can use.':'Saved';paint();
  }
  const askName=(titleText,value='')=>askText({title:titleText,label:'Name',value,action:'OK'});
  async function makeNew(){
    const name=await askName('A name for this arrangement','Live version');if(!name)return;
    const body={...newPerformance({songId,name,id:uid()}),grid:gridFingerprint(measures)};
    try{const r=await api('/api/performance/save',{body,base:0});await reload(r.id);}catch(error){deps.showError(error);}
  }
  async function duplicate(){
    if(!perf())return;const name=await askName('A name for the copy',`${perf().name} copy`);if(!name)return;
    try{const r=await api('/api/performance/save',{body:{...structuredClone(perf()),id:uid(),name},base:0});await reload(r.id);}catch(error){deps.showError(error);}
  }
  async function rename(){if(!perf())return;const name=await askName('A new name',perf().name);if(!name)return;change({...perf(),name});}
  async function remove(){
    if(!record)return;
    if(await askChoice({title:`Remove “${perf().name}”?`,message:'A show that already uses it keeps working.',choices:[{id:'remove',label:'Remove',kind:'danger'}]})!=='remove')return;
    try{await api('/api/performance/delete',{id:record.id});record=null;history=null;await reload();}catch(error){deps.showError(error);}
  }
  async function save(){
    if(!record)return;clearTimeout(saveTimer);
    try{const r=await api('/api/performance/save',{body:{...perf(),grid:gridFingerprint(measures)},base:record.head});record={...record,...r};status=`Saved · version ${r.head}`;paint();}
    catch(error){status='Not saved';deps.showError(error);paint();}
  }
  function change(next){
    if(!history)return;history.push(next);status='Draft not saved yet';
    clearTimeout(saveTimer);saveTimer=setTimeout(saveDraft,600);paint();
  }
  async function saveDraft(){if(!record||!history)return;try{await api('/api/performance/draft',{body:perf(),base:record.head});if(!disposed&&status==='Draft not saved yet'){status='Draft kept. Save to make a version a show can use.';saved.textContent=status;}}catch(error){status='Draft not saved';deps.showError(error);if(!disposed)paint();}}
  function undo(){if(history?.undo()){clearSelectionIfGone();status='Draft not saved yet';clearTimeout(saveTimer);saveTimer=setTimeout(saveDraft,600);paint();}}
  function redo(){if(history?.redo()){clearSelectionIfGone();status='Draft not saved yet';clearTimeout(saveTimer);saveTimer=setTimeout(saveDraft,600);paint();}}
  function clearSelectionIfGone(){if(selection.kind==='cue'&&!allActions(perf(),position).some(x=>x.cue.id===selection.id))selection={kind:'none'};}

  // ---- editing actions, in whichever scope they belong to
  function programEdit(targetScope,edit){
    if(targetScope.kind==='shared'){const next=structuredClone(perf());edit(next.cues);change(next);return;}
    change(editPass(perf(),targetScope.regionId,targetScope.passId,program=>edit(program),position,uid));
  }
  function addActionAt(measure,type){
    if(!perf()){makeNew();return;}
    const action=NEW_ACTION[type]({scenes:deps.scenes(),device:deps.devices()[0]});
    const id=uid();
    programEdit(scope,cues=>cues.push({id,at:address(measure.id),action}));
    selection={kind:'cue',id};paint();
  }
  const find=id=>allActions(perf(),position).find(x=>x.cue.id===id);
  function updateCue(id,patch){const item=find(id);if(!item)return;programEdit(item.scope,cues=>{const c=cues.find(x=>x.id===id);Object.assign(c,patch(c));});}
  function deleteSelected(){const item=find(selection.id);if(!item)return;programEdit(item.scope,cues=>{cues.splice(cues.findIndex(c=>c.id===item.cue.id),1);});selection={kind:'none'};paint();}

  let dragging=null,clipboard=null,sweep=null,swept=false;
  document.addEventListener('pointerup',()=>{if(sweep){const moved=selection.kind==='bars'&&selection.from!==selection.to;sweep=null;if(moved){swept=true;paint();setTimeout(()=>{swept=false;},0);}}});
  function markBars(){for(const b of scroller.querySelectorAll('.pf-bar')){const m=measures.find(x=>String(x.id)===b.dataset.bar);b.classList.toggle('on',selection.kind==='bars'&&m&&m.start>=selection.from.start&&m.start<=selection.to.start);}}
  function dropOn(measure){
    const item=dragging&&find(dragging);dragging=null;if(!item)return;
    const moved=moveCue(item.cue,measure);
    if(!moved){status=`That spot isn’t in bar ${measure.number}: it has fewer beats.`;saved.textContent=status;return;}
    updateCue(item.cue.id,()=>({at:moved.at}));
  }
  // Several actions at once: tick them in the list. Copy and paste go by bars, so a copy keeps its place in the bar.
  const selectedIds=()=>selection.kind==='cues'?selection.ids:selection.kind==='cue'?[selection.id]:[];
  function copySelected(){
    const items=selectedIds().map(find).filter(Boolean);if(!items.length)return false;
    clipboard=items.map(x=>structuredClone(x.cue));status=`${items.length===1?'One action':`${items.length} actions`} copied. Select a bar, then Paste.`;saved.textContent=status;paint();
    return true;
  }
  function pasteAt(measure){
    if(!clipboard?.length)return;
    const first=Math.min(...clipboard.map(c=>measures.findIndex(m=>m.id===c.at.measure)));
    const {copies,skipped}=copyCues(clipboard,measures,measures.indexOf(measure)-first,uid);
    programEdit(scope,cues=>cues.push(...copies));
    selection=copies.length===1?{kind:'cue',id:copies[0].id}:{kind:'cues',ids:copies.map(c=>c.id)};
    if(skipped){status=`${skipped} didn’t fit in the song and ${skipped===1?'was':'were'} left out.`;saved.textContent=status;}
    paint();
  }
  function deleteMany(ids){
    for(const id of ids){const item=find(id);if(item)programEdit(item.scope,cues=>{cues.splice(cues.findIndex(c=>c.id===id),1);});}
    selection={kind:'none'};paint();
  }

  // ---- the timeline
  function drawTimeline(){
    const p=perf(),rows=[];
    const grid_=el('div','pf-grid');grid_.style.setProperty('--bars',measures.length);grid_.style.setProperty('--bar',wide+'px');
    const col=m=>measures.indexOf(m)+2;
    const label=(text,tip)=>{const n=el('div','pf-lane-name',text);if(tip)n.title=tip;return n;};
    // sections
    grid_.append(label('Sections','The song’s sections, from the chart. Click one to select its bars.'));
    for(const s of grid.sections){
      const first=barAtFrame(measures,s.start),last=barAtFrame(measures,Math.max(s.start,s.end-.001));
      const b=el('button','pf-section-block',s.name);b.type='button';b.style.gridColumn=`${col(first)} / ${col(last)+1}`;b.style.gridRow='1';b.title=`${s.name}: bars ${first.number} to ${last.number}. Click to select these bars.`;
      b.onclick=()=>{selection={kind:'bars',from:first,to:last,name:s.name};paint();};
      grid_.append(b);
    }
    // bar numbers
    grid_.append(label('Bars'));
    for(const m of measures){
      const b=el('button','pf-bar',String(m.number));b.type='button';b.style.gridColumn=String(col(m));b.style.gridRow='2';b.setAttribute('aria-label',`Bar ${m.number}`);b.dataset.bar=m.id;
      const inSelection=selection.kind==='bars'&&m.start>=selection.from.start&&m.start<=selection.to.start;
      b.classList.toggle('on',inSelection);
      // click a bar; drag across bars, or Shift-click a second one, for a range (From bar and To bar on the right do the same)
      b.onpointerdown=event=>{if(event.button===0&&!event.shiftKey){sweep=m;}};
      b.onpointerenter=()=>{if(sweep&&sweep!==m){const a=sweep;selection={kind:'bars',from:a.start<=m.start?a:m,to:a.start<=m.start?m:a};markBars();}};
      b.onclick=event=>{
        if(swept){swept=false;paint();return;}
        if(event.shiftKey&&selection.kind==='bars'){const a=selection.from,z=m;selection={kind:'bars',from:a.start<=z.start?a:z,to:a.start<=z.start?z:a};}
        else selection={kind:'bars',from:m,to:m};
        paint();
      };
      grid_.append(b);
    }
    // arrangement
    grid_.append(label('Arrangement','Repeats. Select some bars, then choose Repeat to add one.'));
    for(const r of p?.regions||[]){
      const start=position(r.start),end=position(r.end);
      if(!Number.isFinite(start)||!Number.isFinite(end))continue;
      const first=barAtFrame(measures,start),last=barAtFrame(measures,Math.max(start,end-.001));
      const b=el('button','pf-repeat'+(regionId===r.id?' on':''),r.plays==='live'?'Until released':`× ${r.plays}`);b.type='button';b.style.gridColumn=`${col(first)} / ${col(last)+1}`;b.style.gridRow='3';b.title=`Repeats bars ${first.number} to ${last.number}. Click to choose a pass and edit it.`;
      b.onclick=()=>{regionId=r.id;scope={kind:'pass',regionId:r.id,passId:r.passes[0]?.id,index:0};selection={kind:'region',id:r.id};paint();};
      grid_.append(b);
    }
    // lanes
    const inScope=item=>scope.kind==='shared'?item.scope.kind==='shared':item.scope.regionId===scope.regionId&&item.scope.passId===scope.passId;
    const items=p?allActions(p,position):[];
    const ownPass=scope.kind==='pass'?perf().regions.find(r=>r.id===scope.regionId):null,pass=ownPass?(scope.passId==='further'?ownPass.further:ownPass.passes.find(x=>x.id===scope.passId)):null;
    const followShared=scope.kind==='pass'&&!pass?.program;
    LANES.forEach(([key,name,tip],i)=>{
      const rowIndex=4+i;
      grid_.append(label(name,tip));
      for(const m of measures){
        const cell=el('button','pf-cell');cell.type='button';cell.style.gridColumn=String(col(m));cell.style.gridRow=String(rowIndex);cell.setAttribute('aria-label',`${name}, bar ${m.number}: add an action`);cell.title=tool==='action'?`Add to ${name} at bar ${m.number}`:'';
        cell.onclick=()=>{
          if(tool==='action'){addActionAt(m,LANE_TYPES[key][0]);return;}
          selection={kind:'bars',from:m,to:m};paint();
        };
        cell.ondragover=event=>{if(dragging){event.preventDefault();cell.classList.add('drop');}};
        cell.ondragleave=()=>cell.classList.remove('drop');
        cell.ondrop=event=>{event.preventDefault();cell.classList.remove('drop');dropOn(m);};
        grid_.append(cell);
      }
      const shown=items.filter(x=>laneOf(x.cue.action)===key&&(inScope(x)||(followShared&&x.scope.kind==='shared')));
      for(const x of shown){
        const m=barAtFrame(measures,x.seconds);if(!m)continue;
        const chip=el('button','pf-chip'+(selection.kind==='cue'&&selection.id===x.cue.id?' on':'')+(x.scope.kind==='shared'&&scope.kind==='pass'?' shared':''),describeAction(x.cue.action));chip.type='button';chip.style.gridColumn=String(col(m));chip.style.gridRow=String(rowIndex);chip.title=describeAction(x.cue.action);
        chip.onclick=()=>{selection={kind:'cue',id:x.cue.id};paint();};
        chip.draggable=true;chip.ondragstart=()=>{dragging=x.cue.id;};chip.ondragend=()=>{dragging=null;};
        grid_.append(chip);
      }
    });
    const keep=scroller.scrollLeft;
    scroller.replaceChildren(grid_);scroller.scrollLeft=keep;
    void rows;
  }

  function drawPasses(){
    passBar.replaceChildren();
    const zoom=(delta,label,iconName)=>{const b=btn('sq','',label,()=>{wide=Math.max(30,Math.min(160,wide+delta));paint();},iconName);b.setAttribute('aria-label',label);return b;};
    const zooms=el('span','pf-zoom');zooms.append(el('span','vx-cap','Bars'),zoom(-16,'Make the bars narrower, to see more of the song','down'),zoom(16,'Make the bars wider, to read the actions in them','up'));
    const p=perf();if(!p){passBar.append(zooms);return;}
    queueMicrotask(()=>passBar.append(zooms));
    const region=p.regions.find(r=>r.id===regionId);
    const tab=(text,on,run,tip,custom=false)=>{const b=el('button','btn pf-tab'+(on?' on':'')+(custom?' custom':''),text);b.type='button';b.setAttribute('aria-pressed',String(on));b.title=tip;b.onclick=run;return b;};
    passBar.append(el('span','vx-cap','Editing'));
    passBar.append(tab('Every play',scope.kind==='shared',()=>{scope={kind:'shared'};regionId=null;selection={kind:'none'};paint();},'Actions for every time the music passes them. A pass that has its own actions keeps them.'));
    if(!region)return;
    region.passes.forEach((pass,i)=>passBar.append(tab(`Pass ${i+1}`,scope.passId===pass.id,()=>{scope={kind:'pass',regionId:region.id,passId:pass.id,index:i};selection={kind:'region',id:region.id};paint();},`Edit only pass ${i+1}. Nothing you do here touches another pass.${pass.program?' This pass has its own actions.':' It follows Every play until you change it.'}`,!!pass.program)));
    if(region.plays==='live')passBar.append(tab('Further passes',scope.passId==='further',()=>{scope={kind:'pass',regionId:region.id,passId:'further',index:null};paint();},'Used by every pass after the planned ones, until you leave the loop.',!!region.further?.program));
  }

  // ---- the inspector
  function field(labelText,control,help){const row=el('label','pf-field');row.append(el('span','pf-field-name',labelText),control);if(help)row.title=help;return row;}
  function numberInput(value,{min,max,step},onChange,optional=false){const i=el('input');i.type='number';if(min!==undefined)i.min=min;if(max!==undefined)i.max=max;if(step!==undefined)i.step=step;i.value=value??'';i.onchange=()=>{if(i.value===''&&optional){onChange(undefined);return;}const v=Number(i.value);if(Number.isFinite(v))onChange(v);};return i;}
  function drawActionFields(item){
    const a=item.cue.action,frag=[];
    const set=patch=>updateCue(item.cue.id,c=>{const action={...c.action,...patch};for(const k of Object.keys(action))if(action[k]===undefined)delete action[k];return {action};});
    const typeSel=el('select');
    const lane=laneOf(a);for(const t of LANE_TYPES[lane]){const o=el('option','',ACTIONS[t].label);o.value=t;typeSel.append(o);}
    typeSel.value=a.type;typeSel.onchange=()=>updateCue(item.cue.id,()=>({action:NEW_ACTION[typeSel.value]({scenes:deps.scenes(),device:deps.devices()[0]})}));
    frag.push(field('What',typeSel));
    for(const [key,kind,name,o={}] of FIELDS[a.type]||[]){
      let control;
      if(kind==='number')control=numberInput(a[key],o,v=>set({[key]:v}));
      else if(kind==='optional')control=numberInput(a[key],o,v=>set({[key]:v}),true);
      else if(kind==='text'){control=el('input');control.value=a[key]??'';control.onchange=()=>set({[key]:control.value});}
      else if(kind==='check'){control=el('input');control.type='checkbox';control.checked=!!a[key];control.onchange=()=>set({[key]:control.checked});}
      else if(kind==='tristate'){control=el('select');for(const [v,t] of [['','No change'],['on','On'],['off','Off']]){const n=el('option','',t);n.value=v;control.append(n);}control.value=a[key]===undefined?'':a[key]?'on':'off';control.onchange=()=>set({[key]:control.value===''?undefined:control.value==='on'});}
      else if(kind==='track'){control=el('select');for(const r of STEM_ROLES){const n=el('option','',STEM_NAMES[r]);n.value=r;control.append(n);}control.value=a[key];control.onchange=()=>set({[key]:control.value});}
      else if(kind==='choice'){control=el('select');for(const [v,t] of o.choices){const n=el('option','',t);n.value=v;control.append(n);}control.value=a[key];control.onchange=()=>set({[key]:control.value});}
      else if(kind==='scene'){control=el('select');for(const s of deps.scenes()){const n=el('option','',s.name||s.id);n.value=s.id;control.append(n);}control.value=a[key];control.onchange=()=>set({[key]:control.value});}
      else if(kind==='device'){control=el('input');control.setAttribute('list','pf-devices');control.value=a[key]??'';control.onchange=()=>set({[key]:control.value});}
      else {
        const parts=inputChoices(deps.scenes(),o.wants);
        control=el('select');const none=el('option','','Choose…');none.value='';control.append(none);
        for(const [v,t] of parts){const n=el('option','',t);n.value=v;control.append(n);}
        if(a[key]&&!parts.some(([v])=>v===a[key])){const n=el('option','',a[key]);n.value=a[key];control.append(n);}
        control.value=a[key]??'';control.onchange=()=>set({[key]:control.value});
      }
      frag.push(field(name,control));
    }
    return frag;
  }
  function drawInspector(){
    inspector.replaceChildren();
    const p=perf();
    if(!p){
      inspector.append(el('h3','pf-title','Original arrangement'),el('p','pf-none','The song as it is, start to finish. To add repeats, mutes, visuals or MIDI, make an arrangement. The chart and the recording don’t change.'),btn('hot','Make an arrangement','Start a named arrangement of this song',()=>makeNew(),'plus'));
      return;
    }
    if(selection.kind==='cues'){
      inspector.append(el('h3','pf-title',`${selection.ids.length} actions`));
      const row=el('div','pf-add-actions');
      row.append(btn('','Copy','Copy these, to paste at another bar (Ctrl+C). Select a bar, then Paste.',()=>copySelected()),btn('danger','Delete','Remove these actions (Delete). Undo brings them back.',()=>deleteMany(selection.ids)));
      inspector.append(row);
      return;
    }
    if(selection.kind==='cue'){
      const item=find(selection.id);if(!item)return;
      const m=measures.find(x=>x.id===item.cue.at.measure);
      const barInput=numberInput(m?.number,{min:measures[0].number,max:measures.at(-1).number,step:1},v=>{const t=measures.find(x=>x.number===v);if(t)updateCue(item.cue.id,()=>({at:address(t.id,item.cue.at.beat.n,item.cue.at.beat.d)}));});
      const beatInput=numberInput(item.cue.at.beat.n/item.cue.at.beat.d+1,{min:1,max:(m?.beats.length||4)+.99,step:.5},v=>{updateCue(item.cue.id,()=>({at:{measure:item.cue.at.measure,beat:{n:Math.round((v-1)*16),d:16}}}));});
      const when=el('select');for(const [v,t] of [['every','Every time it comes round'],['first','The first time only']]){const n=el('option','',t);n.value=v;when.append(n);}when.value=item.cue.when?.first?'first':'every';when.onchange=()=>updateCue(item.cue.id,()=>({when:when.value==='first'?{first:true}:undefined}));
      const lead=numberInput(item.cue.leadMs??0,{min:0,max:2000,step:5},v=>updateCue(item.cue.id,()=>({leadMs:v})));
      const order=numberInput(item.cue.order,{min:0,max:99,step:1},v=>updateCue(item.cue.id,()=>({order:v})),true);
      const enabled=el('input');enabled.type='checkbox';enabled.checked=item.cue.enabled!==false;enabled.onchange=()=>updateCue(item.cue.id,()=>({enabled:enabled.checked}));
      const problem=checkAction(item.cue.action);
      inspector.append(el('h3','pf-title',describeAction(item.cue.action)),el('p','pf-scope',scopeWords(item.scope,p.regions.find(r=>r.id===item.scope.regionId))),...drawActionFields(item),field('Bar',barInput),field('Beat',beatInput,'1 is the start of the bar'),field('When',when),field('Early by (ms)',lead,'Send it this much ahead of the beat, for a pedal or preset that takes a moment to change'),field('Order on this spot',order,'For two actions that set the same thing at the same moment: the lower number goes first'),field('On',enabled));
      if(problem)inspector.append(el('p','pf-problem',problem));
      if(!problem&&item.cue.action.device){
        const wire=el('details','pf-wire');wire.append(el('summary','','Exact MIDI bytes'),el('code','',messagesFor(item.cue.action,0).map(m=>m.bytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ')).join('  ·  ')));
        const send=btn('','Send this now','Send it to the device right now, to try it. This does change what the device is doing.',async()=>{
          try{const c=await api('/api/midi/connect',{name:item.cue.action.device});if(!c.output){status=c.error||`${item.cue.action.device} isn’t connected.`;saved.textContent=status;return;}
            const {clock}=await api('/api/midi/status');await api('/api/midi/schedule',{device:item.cue.action.device,events:messagesFor(item.cue.action,clock+.01)});status='Sent. That means it left this computer, not that the device acted on it.';saved.textContent=status;}
          catch(error){deps.showError(error);}
        });
        inspector.append(wire,send);
      }
      inspector.append(btn('','Copy','Copy this action, to paste at another bar (Ctrl+C). Select a bar, then Paste.',()=>copySelected()));
      inspector.append(btn('danger','Delete this action','Remove it (Delete). Undo brings it back.',()=>deleteSelected()));
      return;
    }
    if(selection.kind==='bars'){
      const {from,to}=selection,count=measures.indexOf(to)-measures.indexOf(from)+1;
      const seconds=to.end-from.start;
      inspector.append(el('h3','pf-title',count===1?`Bar ${from.number}`:`Bars ${from.number} to ${to.number}`));
      const setRange=(a,b)=>{const low=measures.find(x=>x.number===a),high=measures.find(x=>x.number===b);if(low&&high&&low.start<=high.start){selection={kind:'bars',from:low,to:high};paint();}};
      const fromBar=numberInput(from.number,{min:measures[0].number,max:measures.at(-1).number,step:1},v=>setRange(v,Math.max(v,to.number)));
      const toBar=numberInput(to.number,{min:measures[0].number,max:measures.at(-1).number,step:1},v=>setRange(Math.min(v,from.number),v));
      inspector.append(field('From bar',fromBar),field('To bar',toBar));
      const plays=numberInput(2,{min:1,max:256,step:1},()=>paintRepeatHint());plays.setAttribute('aria-label','Total plays');
      const until=el('input');until.type='checkbox';
      const key=el('select');for(const [v,t] of [['bars','L leaves or switches it'],['section','R leaves or switches it']]){const n=el('option','',t);n.value=v;key.append(n);}key.value=count>4?'section':'bars';
      const hint=el('p','pf-hint');
      const paintRepeatHint=()=>{const n=Number(plays.value)||1;plays.disabled=until.checked;hint.textContent=until.checked?`Plays until you leave it. Planned as four plays (${clockText(seconds*4)}), an estimate that grows if you stay longer.`:`The original play and ${n-1} repeat${n===2?'':'s'}: adds ${clockText(seconds*(n-1))}.`;};
      until.onchange=paintRepeatHint;paintRepeatHint();
      const beats=numberInput('',{min:1,max:64,step:1},()=>{},true);
      const add=btn('hot','Repeat','Repeat these bars',()=>{
        let end=to===measures.at(-1)?{measure:to.id,beat:{n:to.beats.length,d:1}}:address(measures[measures.indexOf(to)+1].id);
        if(beats.value!==''){const r=endForBeats(measures,from.id,Number(beats.value));if(r.error){hint.textContent=r.error;return;}end=r.end;}
        try{const id=uid();change(addRepeat(perf(),{start:address(from.id),end,plays:until.checked?'live':Number(plays.value)||1,family:key.value,id},uid));regionId=id;scope={kind:'shared'};selection={kind:'region',id};paint();}catch(error){hint.textContent=error.message;}
      },'loop');
      inspector.append(field('Total plays',plays,'Counting the first play'),field('Until released',until,'Keep repeating until you leave it during the show'),field('Or just the first (beats)',beats,'Repeat only this many beats from the start of the selection. It must end on a bar line.'),field('Leaving it',key),hint,add);
      if(clipboard?.length)inspector.append(btn('',`Paste ${clipboard.length===1?'the copied action':`${clipboard.length} copied actions`} here`,'Put copies here (Ctrl+V), keeping their places in the bar and their spacing',()=>pasteAt(from)));
      const here=el('div','pf-add-actions');inspector.append(el('h3','vx-cap','Add at the start'));
      for(const [k,name] of LANES){const b=btn('',name,`Add to ${name} at bar ${from.number}`,()=>addActionAt(from,LANE_TYPES[k][0]));here.append(b);}inspector.append(here);
      return;
    }
    if(selection.kind==='region'){
      const r=p.regions.find(x=>x.id===selection.id);if(!r){selection={kind:'none'};return drawInspector();}
      const first=barAtFrame(measures,position(r.start)),last=barAtFrame(measures,position(r.end)-.001);
      inspector.append(el('h3','pf-title',`Repeat: bars ${first.number} to ${last.number}`));
      const plays=numberInput(r.plays==='live'?4:r.plays,{min:1,max:256,step:1},v=>change(setPlays(perf(),r.id,v,uid)));plays.disabled=r.plays==='live';
      const until=el('input');until.type='checkbox';until.checked=r.plays==='live';until.onchange=()=>change(setPlays(perf(),r.id,until.checked?'live':Math.max(1,r.passes.length),uid));
      const key=el('select');for(const [v,t] of [['bars','L leaves or switches it'],['section','R leaves or switches it']]){const n=el('option','',t);n.value=v;key.append(n);}key.value=r.family;key.onchange=()=>{const next=structuredClone(perf());next.regions.find(x=>x.id===r.id).family=key.value;change(next);};
      inspector.append(field('Total plays',plays),field('Until released',until),field('Leaving it',key));
      if(scope.kind==='pass'){
        const words=el('p','pf-hint',customizedPasses(r).includes(scope.passId)?'This pass has its own actions.':'This pass follows Every play until you change it.');
        const row=el('div','pf-add-actions');
        const i=r.passes.findIndex(x=>x.id===scope.passId);
        row.append(btn('','Copy previous','Replace this pass with a copy of the one before it',()=>change(copyPreviousPass(perf(),r.id,scope.passId,position,uid))));
        row.lastChild.disabled=i<1;
        const others=r.passes.filter(x=>x.id!==scope.passId),ticks=new Map();
        const targets=el('div','pf-targets');targets.append(el('span','vx-cap','Copy this pass to'));
        others.forEach(x=>{const label=el('label','pf-check'),box=el('input');box.type='checkbox';ticks.set(x.id,box);label.append(box,el('span','',`Pass ${r.passes.indexOf(x)+1}`));targets.append(label);});
        if(r.plays==='live'){const label=el('label','pf-check'),box=el('input');box.type='checkbox';ticks.set('further',box);label.append(box,el('span','','Further passes'));targets.append(label);}
        targets.append(btn('','Copy to ticked passes','Replace those passes’ actions with a copy of this pass’s. The other passes stay as they are.',()=>{const ids=[...ticks].filter(([,b])=>b.checked).map(([id])=>id);if(ids.length)change(copyPass(perf(),r.id,scope.passId,ids,position,uid));}));
        if(others.length||r.plays==='live')inspector.append(targets);
        row.append(btn('','Reset','Go back to following Every play',()=>change(resetPass(perf(),r.id,scope.passId))));
        const earlier=btn('sq','', 'Move this pass earlier',()=>change(movePass(perf(),r.id,scope.passId,i-1)),'up');earlier.disabled=i<1;earlier.setAttribute('aria-label','Move this pass earlier');
        const later=btn('sq','', 'Move this pass later',()=>change(movePass(perf(),r.id,scope.passId,i+1)),'down');later.disabled=i<0||i>=r.passes.length-1;later.setAttribute('aria-label','Move this pass later');
        const dropPass=btn('','Remove pass','Take out this play',()=>{try{const next=removePass(perf(),r.id,scope.passId);scope={kind:'shared'};change(next);}catch(error){words.textContent=error.message;paint();}});
        row.append(earlier,later,dropPass);
        inspector.append(words,row);
      }
      const exit=el('div','pf-exit');exit.append(el('h3','vx-cap','When it ends'));
      const exitItems=r.onExit||[];
      exitItems.forEach((a,i)=>{const line=el('div','pf-exit-row');line.append(el('span','',describeAction(a)),btn('sq','', 'Remove',()=>{const next=structuredClone(perf());next.regions.find(x=>x.id===r.id).onExit.splice(i,1);change(next);},'x'));exit.append(line);});
      const kind=el('select');kind.setAttribute('aria-label','An action for when this repeat ends');for(const [t,def] of Object.entries(ACTIONS))if(t!=='visual.input'&&t!=='visual.trigger'){const o=el('option','',def.label);o.value=t;kind.append(o);}
      exit.append(kind,btn('','Add','Runs at the end of the repeat, however you left it',()=>{const next=structuredClone(perf());next.regions.find(x=>x.id===r.id).onExit.push(NEW_ACTION[kind.value]({scenes:deps.scenes(),device:deps.devices()[0]}));change(next);}));
      inspector.append(exit,btn('danger','Remove this repeat','Take the repeat out, and every pass’s own actions with it. Undo brings it back.',()=>{regionId=null;scope={kind:'shared'};selection={kind:'none'};change(removeRegion(perf(),r.id));}));
      return;
    }
    inspector.append(el('p','pf-none','Select some bars to repeat them or add actions, or click an action to change it.'));
  }
  function drawList(){
    const keep=document.activeElement?.dataset?.cue;
    list.replaceChildren();
    const p=perf();if(!p)return;
    const items=allActions(p,position).filter(x=>filter==='all'||laneOf(x.cue.action)===filter);
    if(!items.length)list.append(el('li','pf-none','None yet.'));
    const errors=new Set(compiled()?.errors.map(e=>e.ref));
    for(const x of items){
      const m=barAtFrame(measures,x.seconds),li=el('li');
      const b=el('button','pf-list-row'+(selection.kind==='cue'&&selection.id===x.cue.id?' on':''));b.type='button';b.dataset.cue=x.cue.id;
      b.append(el('b','',`Bar ${m.number}`),el('span','',describeAction(x.cue.action)),el('small','',scopeWords(x.scope,p.regions.find(r=>r.id===x.scope.regionId))));
      if(errors.has(x.cue.id))b.append(el('em','pf-warn','Needs a look'));
      b.onclick=()=>{selection={kind:'cue',id:x.cue.id};if(x.scope.kind==='pass'){regionId=x.scope.regionId;scope=x.scope;}else if(scope.kind==='pass'){scope={kind:'shared'};}paint();scroller.querySelector('.pf-chip.on')?.scrollIntoView({block:'nearest',inline:'center'});};
      const tick=el('input');tick.type='checkbox';tick.className='pf-tick';tick.setAttribute('aria-label',`Select: bar ${m.number}, ${describeAction(x.cue.action)}`);tick.title='Tick several to copy or delete them together';
      tick.checked=selection.kind==='cues'?selection.ids.includes(x.cue.id):false;
      tick.onchange=()=>{const now=new Set(selection.kind==='cues'?selection.ids:selection.kind==='cue'?[selection.id]:[]);if(tick.checked)now.add(x.cue.id);else now.delete(x.cue.id);selection=now.size?{kind:'cues',ids:[...now]}:{kind:'none'};paint();};
      li.className='pf-list-item';li.append(tick,b);list.append(li);
    }
    if(keep)list.querySelector(`[data-cue="${CSS.escape(keep)}"]`)?.focus();
    void listFocus;
  }
  function startPreview(){
    if(!perf())return;
    const from=selection.kind==='bars'?selection.from.start:selection.kind==='cue'?find(selection.id)?.seconds??0:0;
    deps.onPreview?.(perf(),from,sendMidi);paint();
  }
  function paint(){
    if(disposed)return;
    const opts=[el('option','','Original arrangement')];opts[0].value='';
    for(const r of records){const o=el('option','',r.name+(r.has_draft?' (draft)':''));o.value=r.id;opts.push(o);}
    choice.replaceChildren(...opts);choice.value=record?.id||'';
    choice.onchange=()=>open(choice.value||null).catch(deps.showError);
    const editing=!!perf();
    for(const b of [dup,ren,del,saveB])b.disabled=!editing;
    undoB.disabled=!history?.canUndo;redoB.disabled=!history?.canRedo;saved.textContent=status;
    const c=compiled();
    musicLength.textContent=clockText(c?pathSeconds(c.segments).music:grid.frames/44100)+(c&&c.requiresLiveControl?' (estimated; needs you there)':'');
    problems.replaceChildren();
    for(const e of c?.errors||[])problems.append(el('p','pf-problem',e.message));
    for(const w of c?.warnings||[])problems.append(el('p','pf-note',w.message));
    const previewing=!!deps.previewing?.();preview.hidden=previewing;stopPreview.hidden=!previewing;preview.disabled=!editing||(c&&!c.ok);
    drawRail();drawPasses();drawTimeline();drawInspector();drawList();
  }
  const devices=el('datalist');devices.id='pf-devices';for(const d of deps.devices())devices.append(Object.assign(el('option'),{value:d}));panel.append(devices);
  paint();
  reload().catch(deps.showError);
  // while a preview plays, the bar it's on lights up
  let wasPreviewing=false;
  const previewTimer=setInterval(()=>{
    const now=!!deps.previewing?.();
    if(now!==wasPreviewing){wasPreviewing=now;preview.hidden=now;stopPreview.hidden=!now;}
    const frame=deps.previewFrame?.();
    for(const b of scroller.querySelectorAll('.pf-bar.now'))b.classList.remove('now');
    if(!Number.isFinite(frame))return;
    const m=barAtFrame(measures,frame/44100),b=m&&scroller.querySelector(`.pf-bar[data-bar="${CSS.escape(String(m.id))}"]`);
    if(b){b.classList.add('now');const left=b.offsetLeft-scroller.scrollLeft;if(left<96||left>scroller.clientWidth-60)scroller.scrollLeft=b.offsetLeft-120;}
  },200);
  return {paint,keydown,get performance(){return perf();},get selection(){return selection;},setSelection(value){selection=value;paint();},change,dispose(){disposed=true;clearInterval(previewTimer);clearTimeout(saveTimer);saveDraft();root.replaceChildren();}};
}

const pad2=n=>String(n).padStart(2,'0');
export const clockValue=epoch=>{const d=new Date(epoch);return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;};
/** The next time this clock time comes round, as epoch ms: later today, or tomorrow if it has passed. */
export function nextTimeOfDay(text,now){
  const [h,m]=String(text).split(':').map(Number),d=new Date(now);d.setHours(h,m,0,0);
  if(d.getTime()<=now)d.setDate(d.getDate()+1);
  return d.getTime();
}
/** The next message a device sends, or null after 15 seconds. */
async function nextInput(api){
  const {last}=await api('/api/midi/events?after=999999999');
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    const r=await api(`/api/midi/events?after=${last}&wait=1`);
    const press=r.events.find(e=>(e.bytes[0]&0xF0)!==0x80&&(e.bytes[2]??1)>0);
    if(press)return press;
  }
  return null;
}
/** The Show page: the set in order, its timing, its rules, and Perform. deps: {api, songs(): [{id,title,artist}], setlists(): [{id,name,song_ids}], onClose, onPerform(show), showError, midi: {ports(), connect(name)}}. */
export function mountShow(root,deps){
  const {api}=deps;
  let batch=new Set(),shows=[],record=null,show=null,history=null,timer=null,performances=new Map(),lengths=new Map(),status='',disposed=false,ports=null,dragging=null;
  const panel=el('div','vx pf');panel.setAttribute('role','region');panel.setAttribute('aria-label','Shows');
  const bar=el('header','vx-bar'),title=el('h2','vx-title','Shows');title.insertAdjacentHTML('afterbegin',icon('list'));
  const pick=el('label','vx-pick'),choice=el('select','vx-visual');choice.setAttribute('aria-label','Which saved show to edit');pick.append(choice);choice.title='Which saved show to edit';
  const newB=btn('','New','Make a new show, from a set list or empty',()=>make());
  const del=menuItem('Delete…','Remove this show',()=>remove(),true);
  const saved=el('span','pf-saved');saved.setAttribute('role','status');
  const undoB=btn('sq','', 'Undo',()=>undo(),'undo');undoB.setAttribute('aria-label','Undo');const redoB=btn('sq','', 'Redo',()=>redo(),'redo');redoB.setAttribute('aria-label','Redo');
  const saveB=btn('','Save','Save this show',()=>save());
  const fromList=menuItem('Update from set list…','See what has changed in the set list this show came from, and choose whether to bring it in. It never changes by itself.',()=>updateFromList());
  const exportB=menuItem('Export to a file','Save this show and its arrangements to a file, to keep or to use on another computer. The recordings aren’t included.',()=>exportShow());
  const importB=menuItem('Import from a file…','Bring in a show from a file. Its songs must already be in this library.',()=>importInput.click());
  const importInput=el('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;importInput.onchange=()=>importShow();
  const go=btn('hot','Perform','Save this show and open Perform. Nothing plays until you press Start there.',()=>perform(),'play');
  const close=btn('sq','', 'Close and go back to the chart',()=>deps.onClose(),'x');close.setAttribute('aria-label','Close the show page');
  bar.append(title,pick,newB,menu('More for this show',[fromList,exportB,importB,el('hr','more-sep'),del]),importInput,el('span','vx-gap'),saved,undoB,redoB,saveB,go,close);
  const body=el('div','pf-show-body'),left=el('section','vx-col pf-entries'),right=el('section','vx-col pf-settings');
  const rows=el('ol','pf-rows'),add=el('div','pf-add'),footer=el('div','pf-footer');left.append(el('div','vx-head'),rows,add,footer);left.firstChild.append(el('b','','The set'));
  body.append(left,right);panel.append(bar,body);root.replaceChildren(panel);
  const change=next=>{history.push(next);show=history.value;status='Draft not saved yet';clearTimeout(timer);timer=setTimeout(draft,600);paint();};
  async function draft(){if(disposed||!record)return;try{await api('/api/show/draft',{body:show,base:record.head});}catch(error){deps.showError(error);}}
  function undo(){if(history?.undo()){show=history.value;paint();}}
  function redo(){if(history?.redo()){show=history.value;paint();}}
  async function reload(chooseId=null){shows=await api('/api/shows');await open(chooseId||record?.id||shows[0]?.id||null);}
  async function open(id){
    if(!id){record=null;show=null;history=null;paint();return;}
    const r=await api('/api/show/'+encodeURIComponent(id));record=r;show=r.draft||r.body;history=new History(show);status=r.draft?'Draft not saved yet':'Saved';await loadFacts();paint();
  }
  async function make(){
    const lists=deps.setlists().filter(l=>l.id!=='default');
    const name=await askText({title:'A name for this show',label:'Name',value:'Friday set',action:'Next'});if(!name)return;
    let chosen=lists[0]?.id??'';
    const answer=lists.length?await askChoice({title:'Start from a set list?',message:'It fills the show with that list’s songs, in order. Later changes to the list won’t touch the show.',choices:[{id:'list',label:'Use this set list',kind:'primary'},{id:'empty',label:'Start empty'}],radios:{label:'Set list',value:chosen,options:lists.map(l=>({id:l.id,label:l.name})),onChange:id=>{chosen=id;}}}):'empty';
    if(answer===null)return;
    const list=answer==='list'?lists.find(l=>l.id===chosen):null;
    const body={...newShow({name,sourceList:list?.id??null,id:uid()})};
    body.entries=(list?.song_ids||[]).map(songId=>newEntry({songId,performanceId:null,revision:null,id:uid()}));
    try{const r=await api('/api/show/save',{body,base:0});await reload(r.id);}catch(error){deps.showError(error);}
  }
  async function remove(){if(!record)return;if(await askChoice({title:`Remove the show “${show.name}”?`,choices:[{id:'remove',label:'Remove',kind:'danger'}]})!=='remove')return;try{await api('/api/show/delete',{id:record.id});record=null;show=null;await reload();}catch(error){deps.showError(error);}}
  async function save(){if(!record)return null;clearTimeout(timer);try{const r=await api('/api/show/save',{body:show,base:record.head});record={...record,...r};status=`Saved · version ${r.head}`;paint();return r;}catch(error){status='Not saved';deps.showError(error);paint();return null;}}
  async function perform(){const r=await save();if(r)deps.onPerform(r.body);}
  async function updateFromList(){
    const list=deps.setlists().find(l=>l.id===show?.sourceList);
    if(!list){await askChoice({title:'No set list to update from',message:'This show wasn’t made from a set list, or that list is gone.',choices:[],cancel:'OK'});return;}
    const diff=listDiff(show.entries.map(e=>e.songId),list.song_ids),name=id=>deps.songs().find(s=>s.id===id)?.title??'A song';
    if(!diff.added.length&&!diff.removed.length){await askChoice({title:'Nothing has changed',message:`“${list.name}” has the same songs as this show.`,choices:[],cancel:'OK'});return;}
    const message=[diff.added.length?`New in the list: ${diff.added.map(name).join(', ')}.`:'',diff.removed.length?`No longer in the list: ${diff.removed.map(name).join(', ')}.`:'','Songs already in the show keep their arrangements and gaps.'];
    if(await askChoice({title:`Update from “${list.name}”?`,message,choices:[{id:'update',label:'Update the show',kind:'primary'}]})!=='update')return;
    change(applyListDiff(show,list.song_ids,uid));loadFacts().then(paint);
  }
  async function exportShow(){
    if(!record)return;
    try{const bundle=await api(`/api/show/${encodeURIComponent(record.id)}/export`);const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,1)],{type:'application/json'}));const a=el('a');a.href=url;a.download=`${show.name.replace(/[\\/:*?"<>|]/g,'-')}.show.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
    catch(error){deps.showError(error);}
  }
  async function importShow(){
    const file=importInput.files?.[0];importInput.value='';if(!file)return;
    try{
      if(file.size>8*1024*1024)throw Error('That file is too large to be a show.');
      const bundle=JSON.parse(await file.text()),r=await api('/api/show/import',{bundle});
      if(r.missing_songs?.length){await askChoice({title:'Some songs aren’t in this library',message:[`Import these first, then import the show again: ${r.missing_songs.map(x=>x.title||x.id).join(', ')}.`],choices:[],cancel:'OK'});return;}
      const installed=new Set((deps.scenes?.()||[]).map(x=>x.id)),absent=(r.required_scenes||[]).filter(id=>!installed.has(id));
      if(absent.length)await askChoice({title:'Some visualizations aren’t here',message:[`This show uses: ${absent.join(', ')}.`,'A show file carries their names and connections, never their code. Add them to the My Visuals folder, or the show won’t start until they’re changed in Prepare.'],choices:[],cancel:'OK'});
      await reload(r.show_id);
    }catch(error){deps.showError(error);}
  }
  async function loadFacts(){
    if(!show)return;
    await Promise.all([...new Set(show.entries.map(e=>e.songId))].map(async id=>{if(!performances.has(id)){try{performances.set(id,await api('/api/performances/'+encodeURIComponent(id)));}catch{performances.set(id,[]);}}}));
    await Promise.all(show.entries.map(async e=>{
      const key=`${e.songId}|${e.performanceId}|${e.revision}`;if(lengths.has(key))return;
      try{lengths.set(key,await deps.entryLength(e));}catch{lengths.set(key,null);}
    }));
  }
  const entryChange=(i,patch)=>{const next=structuredClone(show);Object.assign(next.entries[i],patch);change(next);loadFacts().then(paint);};
  function totals(){
    const list=show.entries.map((e,i)=>{const r=lengths.get(`${e.songId}|${e.performanceId}|${e.revision}`);return {segments:r?.segments||[],transition:i===0?null:e.transition||show.transitions};});
    return showSeconds(list);
  }
  function paint(){
    if(disposed)return;
    choice.replaceChildren(...shows.map(s=>{const o=el('option','',s.name);o.value=s.id;return o;}));choice.value=record?.id||'';choice.onchange=()=>open(choice.value).catch(deps.showError);
    for(const b of [del,saveB,go,exportB])b.disabled=!show;fromList.disabled=!show?.sourceList;undoB.disabled=!history?.canUndo;redoB.disabled=!history?.canRedo;saved.textContent=status;
    rows.replaceChildren();add.replaceChildren();footer.replaceChildren();right.replaceChildren();
    if(!show){rows.append(el('p','pf-none','Make a new show to start: a set list can fill it for you.'));return;}
    const songs=deps.songs();
    show.entries.forEach((e,i)=>{
      const song=songs.find(s=>s.id===e.songId),length=lengths.get(`${e.songId}|${e.performanceId}|${e.revision}`);
      const row=el('li','pf-row');row.draggable=true;row.ondragstart=()=>{dragging=i;};row.ondragover=event=>event.preventDefault();row.ondrop=()=>{if(dragging===null||dragging===i)return;const next=structuredClone(show);next.entries.splice(i,0,next.entries.splice(dragging,1)[0]);dragging=null;change(next);};
      const words=el('div','pf-set-words');words.append(el('b','',`${i+1}. ${song?.title??'A song that’s gone'}`),el('small','',song?.artist||''));
      const which=el('select');which.setAttribute('aria-label',`Which arrangement of ${song?.title??'this song'}`);const originals=el('option','','Original arrangement');originals.value='';which.append(originals);
      const saved_=performances.get(e.songId)||[];
      for(const p of saved_){const o=el('option','',`${p.name} (version ${p.head})`);o.value=`${p.id}|${p.head}`;which.append(o);}
      which.value=e.performanceId?`${e.performanceId}|${e.revision}`:'';if(e.performanceId&&which.value===''){const o=el('option','',`Version ${e.revision} (older)`);o.value=`${e.performanceId}|${e.revision}`;which.append(o);which.value=o.value;}
      which.onchange=()=>{const [id,rev]=which.value.split('|');entryChange(i,{performanceId:id||null,revision:id?Number(rev):null});};
      const gap=el('select');gap.setAttribute('aria-label',`How ${song?.title??'this song'} starts`);for(const [v,t] of [['immediate','Right after the last song'],['gap','After a gap'],['control','When you press Next song']]){const o=el('option','',t);o.value=v;gap.append(o);}
      gap.value=e.transition?.kind||'immediate';gap.onchange=()=>entryChange(i,{transition:{kind:gap.value,seconds:gap.value==='gap'?(e.transition?.seconds??5):0,expected:gap.value==='control'?30:undefined}});
      const seconds=numberField(e.transition?.seconds??5,0,600,v=>entryChange(i,{transition:{...e.transition,kind:'gap',seconds:v}}));seconds.hidden=gap.value!=='gap';seconds.setAttribute('aria-label','Gap in seconds');seconds.title='Seconds of silence before this song';
      const countIn=numberField(e.transition?.countIn??0,0,60,v=>entryChange(i,{transition:{kind:e.transition?.kind||'immediate',seconds:e.transition?.seconds??0,...e.transition,countIn:v}}));countIn.setAttribute('aria-label',`Count-in seconds for ${song?.title??'this song'}`);countIn.title='More silence just before this song, to count yourself in. 0 for none. A count-in on the recording itself plays as usual.';
      const pickBatch=el('input');pickBatch.type='checkbox';pickBatch.className='pf-tick';pickBatch.checked=batch.has(e.id);pickBatch.setAttribute('aria-label',`Select ${song?.title??'this song'} to set its start along with others`);pickBatch.title='Tick several to set how they start, all at once';pickBatch.onchange=()=>{if(pickBatch.checked)batch.add(e.id);else batch.delete(e.id);paint();};
      const up=btn('sq','', 'Earlier in the set',()=>{const next=structuredClone(show);next.entries.splice(i-1,0,next.entries.splice(i,1)[0]);change(next);},'up');up.disabled=i===0;up.setAttribute('aria-label',`Move ${song?.title??'this song'} earlier`);
      const down=btn('sq','', 'Later in the set',()=>{const next=structuredClone(show);next.entries.splice(i+1,0,next.entries.splice(i,1)[0]);change(next);},'down');down.disabled=i===show.entries.length-1;down.setAttribute('aria-label',`Move ${song?.title??'this song'} later`);
      const out=btn('sq','', 'Take this song out of the show',()=>{const next=structuredClone(show);next.entries.splice(i,1);change(next);},'x');out.setAttribute('aria-label',`Take ${song?.title??'this song'} out`);
      const time=el('span','pf-length',length?clockText(length.music):'…');
      const flags=el('small','pf-flag',length?.live?'Needs you there':'');
      const line=el('div','pf-row-start');
      const labelled=(text,control,unit)=>{const l=el('label','pf-inline');l.append(el('span','',text),control);if(unit)l.append(el('span','',unit));return l;};
      if(i===0)line.append(el('span','pf-note-plain','Starts when you press Start'));
      else{const secondsLabel=labelled('',seconds,'seconds');secondsLabel.hidden=gap.value!=='gap';line.append(labelled('Starts',gap),secondsLabel,labelled('Count-in',countIn,'seconds'));}
      const mine=saved_.find(p=>p.id===e.performanceId);
      if(mine&&mine.head>e.revision)line.append(btn('',`Use version ${mine.head}`,`A newer version of “${mine.name}” is saved. This show still plays version ${e.revision}, as it was when you picked it.`,()=>entryChange(i,{revision:mine.head})));
      if(mine?.has_draft)line.append(el('span','pf-flag','Has unsaved changes in Prepare'));
      row.append(pickBatch,words,which,time,flags,up,down,out,line);rows.append(row);
    });
    const addSong=el('select','vx-visual');addSong.setAttribute('aria-label','A song to add');for(const s of songs){const o=el('option','',s.title);o.value=s.id;addSong.append(o);}
    const addB=btn('','Add song','Add this song to the end. The same song can go in twice, each with its own arrangement.',()=>{const next=structuredClone(show);next.entries.push(newEntry({songId:addSong.value,performanceId:null,revision:null,id:uid()}));change(next);loadFacts().then(paint);});
    add.append(addSong,addB);
    if(batch.size){
      const kind=el('select');kind.setAttribute('aria-label','How the ticked songs start');for(const [v,t] of [['immediate','Right after the last song'],['gap','After a gap'],['control','When you press Next song']]){const o=el('option','',t);o.value=v;kind.append(o);}
      const secs=numberField(5,0,600,()=>{});secs.setAttribute('aria-label','Gap in seconds for the ticked songs');
      add.append(el('span','vx-cap',`${batch.size} ticked`),kind,secs,btn('','Set for ticked','Give all the ticked songs this start',()=>{const next=structuredClone(show);for(const e of next.entries)if(batch.has(e.id))e.transition={kind:kind.value,seconds:kind.value==='gap'?Number(secs.value)||0:0,expected:kind.value==='control'?30:undefined,countIn:e.transition?.countIn??0};batch=new Set();change(next);}));
    }
    const t=totals();
    const fact=(label,value)=>{const n=el('div','pf-fact');n.append(el('span','vx-cap',label),el('b','',value));return n;};
    footer.append(fact('Music',clockText(t.music)),fact('Gaps',clockText(t.gaps+t.holds)),fact('Planned total',t.unknown?`${clockText(t.planned)} and a wait`:clockText(t.planned)));
    const slotMinutes=show.target?.slotSeconds?show.target.slotSeconds/60:'';
    if(slotMinutes)footer.append(fact('In your slot',spareText(show.target.slotSeconds-t.planned)));
    if(Number.isFinite(show.target?.finishAtEpoch))footer.append(fact('If you start now',spareText((show.target.finishAtEpoch-Date.now())/1000-t.planned)));
    if(show.entries.some(e=>lengths.get(`${e.songId}|${e.performanceId}|${e.revision}`)?.live)||show.entries.some(e=>e.transition?.kind==='control'))footer.append(el('p','pf-note','Needs you there: it has a loop or a wait that lasts until you release it, so the finish time is an estimate.'));
    // settings
    right.append(el('h3','pf-title','This show'));
    right.append(field2('Slot length (minutes)',numberField(slotMinutes,0,600,v=>{const next=structuredClone(show);next.target=v?{slotSeconds:v*60}:null;change(next);},true),'How long you have, counted from when you press Start. The clocks count down to this during the show.'));
    const finishAt=el('input');finishAt.type='time';finishAt.value=Number.isFinite(show.target?.finishAtEpoch)?clockValue(show.target.finishAtEpoch):'';
    finishAt.onchange=()=>{const next=structuredClone(show);next.target=finishAt.value?{finishAtEpoch:nextTimeOfDay(finishAt.value,Date.now()),finishText:finishAt.value}:null;change(next);};
    right.append(field2('Or finish by (clock time)',finishAt,'A time on the clock instead of a length. The next time it comes round. Setting this replaces the slot length.'));
    const nameInput=el('input');nameInput.value=show.name;nameInput.onchange=()=>{if(nameInput.value.trim())change({...structuredClone(show),name:nameInput.value.trim()});};right.append(field2('Name',nameInput));
    const keep=el('input');keep.type='checkbox';keep.checked=!!show.keepVisualsWhenMuted;keep.onchange=()=>change({...structuredClone(show),keepVisualsWhenMuted:keep.checked});
    right.append(field2('Keep visuals when a stem is muted',keep,'Off: muting a stem also stops what it moves in the visuals. On: its visuals keep going, handy when you play that part yourself.'));
    const clockDevice=el('input');clockDevice.setAttribute('list','pf-show-devices');clockDevice.value=show.midiClock?.device||'';clockDevice.placeholder='Off';clockDevice.onchange=()=>change({...structuredClone(show),midiClock:clockDevice.value.trim()?{device:clockDevice.value.trim()}:null});
    right.append(field2('Send MIDI clock to',clockDevice,'A device name. Delays and the like on it can then follow the song’s real tempo. Leave empty for none.'));
    const carry=el('input');carry.type='checkbox';carry.checked=!!show.carryOverrides;carry.onchange=()=>change({...structuredClone(show),carryOverrides:carry.checked});
    right.append(field2('Keep live changes into the next song',carry,'Off: each song starts from its plan. On: what you changed by hand stays until you release it.'));
    right.append(el('h3','vx-cap','When you change something by hand'));
    const policy=show.policy||defaultPolicy();
    const policySelect=(key,label)=>{const s=el('select');s.className='pf-wide';if(key!=='all'){const o=el('option','','Same as above');o.value='';s.append(o);}for(const v of POLICIES){const o=el('option','',POLICY_LABELS[v]);o.value=v;s.append(o);}s.value=policy[key]||'';s.onchange=()=>{const next=structuredClone(show);next.policy={...policy,[key]:s.value||null};change(next);};return field2(label,s);};
    right.append(policySelect('all','Usually'),policySelect('tracks','Tracks'),policySelect('visuals','Visuals'),policySelect('midi','MIDI'),policySelect('rate','Speed'));
    right.append(el('h3','vx-cap','MIDI devices'));
    const portList=el('div','pf-ports');right.append(portList);
    const refresh=btn('','Find devices','List the MIDI devices connected to this computer',()=>findPorts(portList));portList.append(refresh);
    if(ports)drawPorts(portList);
  }
  function field2(labelText,control,help){const row=el('label','pf-field');row.append(el('span','pf-field-name',labelText),control);if(help)row.title=help;return row;}
  function numberField(value,min,max,onChange,optional=false){const i=el('input');i.type='number';i.min=min;i.max=max;i.value=value;i.onchange=()=>{if(i.value===''&&optional){onChange(null);return;}const v=Number(i.value);if(Number.isFinite(v))onChange(v);};return i;}
  async function findPorts(node){try{ports=await api('/api/midi/ports');drawPorts(node);}catch(error){deps.showError(error);}}
  function drawPorts(node){
    node.replaceChildren();
    if(!ports.available){node.append(el('p','pf-note',ports.reason));return;}
    const names=[...new Set([...ports.outputs,...ports.inputs].map(p=>p.name))];
    if(!names.length)node.append(el('p','pf-none','No MIDI devices found.'));
    for(const name of names){
      const row=el('div','pf-port');const on=ports.outputs.concat(ports.inputs).some(p=>p.name===name&&p.open);
      const needs=el('label','pf-check'),needBox=el('input');needBox.type='checkbox';needBox.checked=!!show?.devices?.find?.(d=>d.name===name&&d.critical);
      needBox.onchange=()=>{const next=structuredClone(show);next.devices=[...(next.devices||[]).filter(d=>d.name!==name),...(needBox.checked?[{name,critical:true}]:[])];change(next);};
      needs.append(needBox,el('span','','This show needs it'));needs.title='Ticked: the show won’t start without it, and stops at the next bar if it’s disconnected. Not ticked: the show plays on without it and lists what it missed.';
      row.append(el('span','',name),el('small','',on?'Connected':'Not connected'),needs,btn('',on?'Disconnect':'Connect',on?'Let go of this device so another program can use it':'Open this device. Nothing is sent to it until a show or a preview does.',async()=>{try{const r=await api(on?'/api/midi/disconnect':'/api/midi/connect',{name});if(r.error)deps.showError(Error(r.error));await findPorts(node);}catch(error){deps.showError(error);}}));
      node.append(row);
    }
    node.append(btn('','Look again','List the MIDI devices again',()=>findPorts(node)));
    const monitor=el('pre','pf-monitor');monitor.hidden=true;
    const watching=btn('','Watch incoming MIDI','For 20 seconds, list every message arriving from connected devices, to check they reach this computer. Nothing is sent.',async()=>{
      monitor.hidden=false;monitor.textContent='Listening…';watching.disabled=true;
      try{
        let {last}=await api('/api/midi/events?after=999999999');const lines=[],deadline=Date.now()+20000;
        while(Date.now()<deadline&&!disposed){const r=await api(`/api/midi/events?after=${last}&wait=1`);last=r.last;for(const e of r.events)lines.push(`${e.device}: ${e.bytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ')}`);monitor.textContent=lines.length?lines.slice(-12).join('\n'):'Listening… nothing yet.';}
        const status=await api('/api/midi/status'),clocks=Object.entries(status.clock_in||{}).filter(([,c])=>c.seconds_ago<3).map(([n])=>n);
        const clockLine=clocks.length?`MIDI clock is arriving from ${clocks.join(', ')}, so it is reaching this computer.`:'';
        monitor.textContent=lines.length?[`${lines.length} messages:`,...lines.slice(-12),clockLine].filter(Boolean).join('\n'):clockLine?`${clockLine}\nNothing else arrived: no buttons or foot switches pressed.`:'Nothing arrived. Its clock may be off, and a foot switch only sends once it’s set up on the device.';
      }catch(error){monitor.textContent=error.message;}
      watching.disabled=false;
    });
    node.append(watching,monitor);
    node.append(el('h3','vx-cap','Foot switches and buttons'));
    const open=ports.inputs.some(p=>p.open);
    if(!open)node.append(el('p','pf-none','Connect a device to teach it controls.'));
    for(const [command,label] of Object.entries(COMMANDS)){
      const mapped=deps.mappings().filter(m=>m.command===command);
      const row=el('div','pf-port');row.append(el('span','',label),el('small','',mapped.length?mapped.map(m=>`${m.device}: ${(m.status&0xF0)===0xB0?`CC ${m.data1}`:`message ${m.status} ${m.data1}`}, channel ${(m.status&15)+1}`).join('; '):'Not set'));
      const learn=btn('','Learn','Press this, then the switch or button on your device. Only a control you teach here does anything in a show.',async()=>{
        learn.textContent='Press it now…';learn.disabled=true;
        try{const event=await nextInput(api);if(event)deps.saveMappings([...deps.mappings().filter(m=>m.command!==command),learnFrom(event,command)]);}catch(error){deps.showError(error);}
        drawPorts(node);
      });learn.disabled=!open;row.append(learn);
      if(mapped.length)row.append(btn('','Forget','Stop this control doing anything',()=>{deps.saveMappings(deps.mappings().filter(m=>m.command!==command));drawPorts(node);}));
      node.append(row);
    }
  }
  function keydown(event){
    if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='z'&&!/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)){event.preventDefault();event.stopPropagation();if(event.shiftKey)redo();else undo();}
  }
  paint();reload().catch(deps.showError);
  return {paint,keydown,get show(){return show;},dispose(){disposed=true;clearTimeout(timer);draft();root.replaceChildren();}};
}
