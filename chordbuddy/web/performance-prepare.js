// The Prepare page: a song's arrangement, laid out the way the chart is, with its section names, wrapped rows of bars, zoom and snap. Each bar shows its chords, a colored flag
// per action at its place in the bar, and a strip where it repeats. Everything that can be dragged or clicked can also be typed into: the action list and
// inspector on the right reach every action, by keyboard. Play follows the arrangement, flags and all, with a playhead on the bars. Each edit is saved as a draft at once;
// Save makes a revision a show can use. Pure parts (lanes, Undo) are exported so they can be tested without a page.
import {askChoice,askText} from './dialogs.js';
import {openActionEditor} from './action-editor.js';
import {beatAt,chordsInMeasure,isNoChordLabel} from './chart-layout.js';
import {applyRows} from './row-layout.js';
import {DEFAULT_ZOOM,autoSnap,barTargets,beatPx,nearestTarget,stepZoom} from './timing-geometry.js';
import {SNAP_QUARTERS} from './musical-grid.js';
import {LANES,NEW_ACTION,isOlderMixerFlag,keyframeForFlag,laneOf,plannedMixAt} from './performance-plan.js';
import {icon} from './icons.js';
import {renderRail,watchRail} from './tool-rail.js';
import {describeAction} from './performance-actions.js';
import {addressPosition,compilePerformance,endForBeats,gridFingerprint} from './performance-compiler.js';
import {clockText,pathSeconds} from './performance-duration.js';
import {fourBarRange,sectionRange} from './performance-runner.js';
import {messagesFor,tempoAt} from './performance-midi.js';
import {addRepeat,rehomeStrayCues,address,beatValue,copyCues,copyPass,copyPreviousPass,editPass,newEntry,newPerformance,removePass,removeRegion,resetPass,setPlays,movePass,customizedPasses} from './performance-model.js';

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

export {LANES,NEW_ACTION,laneOf};
export const POLICY_LABELS=Object.freeze({'until-released':'You win until you release it (usual)','next-cue':'Until the next planned change','next-section':'Until the next section','locked':'Follow the plan only (controls locked)'});

/** Undo for whole values, by name: every edit keeps the value before it and a name for the change, like the chart's history.
 *  merge: a change with the same name as the last one, made right after it (typing a number), adds to that step instead of making another. */
export class History{
  constructor(value,limit=200){this.value=value;this.past=[];this.future=[];this.limit=limit;}
  push(next,label='Change the arrangement',{merge=false}={}){
    if(next===this.value)return next;
    if(merge&&this.past.at(-1)?.label===label){this.value=next;this.future=[];return next;}
    this.past.push({value:this.value,label});if(this.past.length>this.limit)this.past.shift();this.future=[];this.value=next;return next;
  }
  undo(){if(!this.past.length)return null;const step=this.past.pop();this.future.push({value:this.value,label:step.label});this.value=step.value;return this.value;}
  redo(){if(!this.future.length)return null;const step=this.future.pop();this.past.push({value:this.value,label:step.label});this.value=step.value;return this.value;}
  get canUndo(){return this.past.length>0;}
  get canRedo(){return this.future.length>0;}
  /** The names: what Undo takes back, newest first, and what Redo puts back, next first. */
  get undoLabels(){return this.past.map(s=>s.label).reverse();}
  get redoLabels(){return this.future.map(s=>s.label).reverse();}
}
/** A change to an arrangement, in words, worked out from before and after: what the History menu and Undo call it. */
export function changeLabel(before,after,position,measures){
  if(!before||!after)return 'Change the arrangement';
  if(before.name!==after.name)return `Rename to ${after.name}`;   // the menu and the note put the whole name of a step in quotes
  const barOf=seconds=>(measures.find(m=>seconds>=m.start&&seconds<m.end)||measures.at(-1))?.number;
  const listOf=p=>new Map(allActions(p,position).map(x=>[x.cue.id,x]));
  const was=listOf(before),now=listOf(after);
  const added=[...now.values()].filter(x=>!was.has(x.cue.id)),removed=[...was.values()].filter(x=>!now.has(x.cue.id));
  const moved=[],changed=[];
  for(const [id,x] of now){const old=was.get(id);if(!old)continue;if(JSON.stringify(old.cue.action)!==JSON.stringify(x.cue.action))changed.push(x);else if(JSON.stringify(old.cue.at)!==JSON.stringify(x.cue.at))moved.push(x);}
  const one=(verb,x,where=true)=>`${verb} ${describeAction(x.cue.action)}${where?` at bar ${barOf(x.seconds)}`:''}`;
  const regionsBefore=before.regions.length,regionsAfter=after.regions.length;
  if(regionsAfter>regionsBefore)return regionsAfter-regionsBefore===1?'Add a loop':`Add ${regionsAfter-regionsBefore} loops`;
  if(regionsAfter<regionsBefore)return 'Remove a loop';
  if(added.length===1&&!removed.length)return one('Add',added[0]);
  if(removed.length===1&&!added.length)return one('Remove',removed[0]);
  if(added.length&&!removed.length)return `Add ${added.length} actions`;
  if(removed.length&&!added.length)return `Remove ${removed.length} actions`;
  if(added.length||removed.length)return 'Change the actions in a pass';
  if(changed.length===1)return one('Change',changed[0]);
  if(moved.length===1)return `Move ${describeAction(moved[0].cue.action)} to bar ${barOf(moved[0].seconds)}`;
  if(changed.length||moved.length)return `Change ${changed.length+moved.length} actions`;
  if(JSON.stringify(before.regions)!==JSON.stringify(after.regions))return 'Change a loop';
  return 'Change the arrangement';
}
/** A planned loop's size, as the player's loop readout names it: four bars or fewer, or longer. */
export const loopFamily=bars=>bars<=4?'bars':'section';
const isLoopFlag=a=>a?.type==='command'&&(a.command==='loop-bars'||a.command==='loop-section');
/** Loop flags from before planned loops: each becomes a loop over the same bars, playing the same number of times (none: until you
 *  leave it), so it plays as it did. One that would overlap a loop already there stays a flag (it still works); a second flag for the
 *  same bars, which only cancelled the first, goes. Only Every play's flags: a pass's own loop flag stays as it is. */
export function loopFlagsToLoops(performance,measures,sections,position){
  const SR=44100,next=structuredClone(performance);let made=0,kept=0;
  const spans=()=>next.regions.map(r=>[position(r.start),position(r.end)]);
  for(const cue of performance.cues){
    const a=cue.action;if(a?.type!=='command'||(a.command!=='loop-bars'&&a.command!=='loop-section'))continue;
    const at=position(cue.at);if(!Number.isFinite(at))continue;
    const range=a.command==='loop-bars'?fourBarRange(measures,sections,Math.round(at*SR),a.params?.bars??4):sectionRange(measures,sections,Math.round(at*SR));
    if(!range){kept++;continue;}
    const start=range.start/SR,end=range.end/SR,same=spans().some(([x,y])=>Math.abs(x-start)<.002&&Math.abs(y-end)<.002);
    if(!same&&spans().some(([x,y])=>x<end-.002&&y>start+.002)){kept++;continue;}
    next.cues=next.cues.filter(c=>c.id!==cue.id);
    if(same)continue;
    const first=measures.findIndex(m=>Math.abs(m.start-start)<.002),last=measures.findIndex(m=>Math.abs(m.end-end)<.002);
    if(first<0||last<0){next.cues.push(cue);kept++;continue;}
    const to=measures[last],endAt=last===measures.length-1?{measure:to.id,beat:{n:to.beats.length,d:1}}:address(measures[last+1].id);
    const plays=Number.isInteger(a.params?.plays)&&a.params.plays>=2?a.params.plays:'live';
    const added=addRepeat(next,{start:address(measures[first].id),end:endAt,plays,family:loopFamily(last-first+1),id:`loop-${cue.id}`});
    next.regions=added.regions;made++;
  }
  return {performance:next,made,kept};
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
const nameKey=name=>String(name||'').toLowerCase().replace(/[^a-z]/g,'');
let rememberedZoom=Math.min(DEFAULT_ZOOM,1),rememberedSnap=true,rememberedList=false;   // the list of every action starts hidden: the flags on the bars are the plan
/** Which plays an action happens on, in words, for the list and the flags. */
export function playWords(cue,scope,region){
  const base=scopeWords(scope,region),first=cue.when?.first?(scope.kind==='shared'?'First time only':`${base}, first time only`):base;
  return cue.enabled===false?`Off · ${first}`:first;
}
/** The list's words for a planned loop. */
export function repeatWords(region,firstBar,lastBar){
  const bars=firstBar===lastBar?`bar ${firstBar}`:`bars ${firstBar} to ${lastBar}`;
  return {title:`Loop ${bars}`,plays:region.plays==='live'?'Until you leave it':`${region.plays} plays in all`};
}
const barAtFrame=(measures,seconds)=>measures.find(m=>seconds>=m.start&&seconds<m.end)||measures.at(-1);

/** The Prepare page. deps: {api, songId, scenes(): [{id,name}], devices(): [names], grid (loadSongGrid's result), onClose, playhead(): the song's position in seconds, playing(), seek(seconds), onPlanChange(): the arrangement to play changed, showError}. */
export function mountPrepare(root,deps){
  const {api,grid,songId}=deps,measures=grid.measures,position=at=>{const f=addressPosition(measures)(at);return f/44100;};
  let records=[],record=null,history=null,selection={kind:'none'},scope={kind:'shared'},regionId=null,tool='select',disposed=false,saveTimer=null,filter='all',status='',listFocus=null,movedNote=null;
  let zoom=rememberedZoom,snapping=rememberedSnap,showList=rememberedList,editorOpen=null;

  const panel=el('div','vx pf');panel.setAttribute('role','region');panel.setAttribute('aria-label','Prepare');
  const bar=el('header','vx-bar');
  const pick=el('label','vx-pick'),choice=el('select','vx-visual');pick.append(el('span','vx-cap','Performance'),choice);choice.title='Which saved arrangement of this song to edit. Original arrangement plays the song as it is.';
  const newB=btn('','New','Make a new arrangement of this song, starting from the song as it is',()=>makeNew());
  const dup=menuItem('Duplicate…','Make a copy of this arrangement under a new name',()=>duplicate());
  const ren=menuItem('Rename…','Give this arrangement a different name',()=>rename());
  const del=menuItem('Delete…','Remove this arrangement. A show that already uses it keeps working.',()=>remove(),true);
  const saved=el('span','pf-saved');saved.setAttribute('role','status');
  const saveB=btn('hot','Save','Save this arrangement as a version you can come back to. Shows already play it as it is now, saved or not.',()=>save());
  const performB=btn('hot','Perform','',()=>deps.performSet?.run(),'play');
  const facts=el('span','pf-facts');const musicLength=el('b'),problems=el('div','pf-problems');problems.setAttribute('role','status');
  facts.title='How long the music lasts, played as this arrangement';facts.append(el('span','vx-cap','Music'),musicLength);
  const midiSetup=btn('','MIDI setup','Connect a pedal or controller, and teach its switches to run Chord Buddy during a show',()=>deps.onMidiSetup());
  // what you changed by hand while it plays here (the mixer, the speed) wins over the plan until you let go of it: this lets go of all of it
  const defaultsB=btn('','Switch to song defaults','Let go of every change you made by hand while it plays, so it goes back to what you planned for it',()=>deps.releaseLive?.());defaultsB.hidden=true;
  bar.append(pick,newB,menu('More for this arrangement',[dup,ren,el('hr','more-sep'),del]),facts,saved,saveB,defaultsB,midiSetup,performB);   // Undo, Redo and History are the top bar's, as in every view
  const stage=el('div','pf-prepare');
  const rail=el('nav','tool-rail');rail.setAttribute('aria-label','Prepare tools');
  const left=el('section','vx-col pf-timeline');const passBar=el('div','pf-passes');const scroller=el('div','pf-scroll'),legend=el('div','pf-legend');left.append(passBar,legend,scroller);
  const side=el('section','vx-col pf-sidebar');const inspector=el('div','pf-inspector'),listHead=el('div','vx-head'),listFilter=el('select','vx-visual pf-filter'),list=el('ol','pf-list');
  listFilter.setAttribute('aria-label','Which actions to list');for(const [v,t] of [['all','All kinds'],...LANES.map(([k,l])=>[k,l])]){const o=el('option','',t);o.value=v;listFilter.append(o);}listFilter.onchange=()=>{filter=listFilter.value;drawList();};
  listHead.append(el('b','','Actions'),listFilter);
  const closeSide=btn('sq pf-side-close','','Close: clear the selection (Esc)',()=>{selection={kind:'none'};paint();},'x');closeSide.setAttribute('aria-label','Close');
  side.append(closeSide,inspector,listHead,list);
  stage.append(rail,left,side);
  panel.append(bar,problems,stage);root.replaceChildren(panel);watchRail(rail);

  function keydown(event){
    const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='z'){if(!typing){event.preventDefault();event.stopPropagation();event.shiftKey?redo():undo();}return;}
    if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='c'&&!typing&&selectedIds().length){event.preventDefault();event.stopPropagation();copySelected();return;}
    if((event.ctrlKey||event.metaKey)&&String(event.key).toLowerCase()==='v'&&!typing&&clipboard&&selection.kind==='bars'){event.preventDefault();event.stopPropagation();pasteAt(selection.from);return;}
    if(typing||event.ctrlKey||event.altKey||event.metaKey)return;
    const k=String(event.key).toLowerCase();
    if(k==='v'){setTool('select');event.stopPropagation();}else if(k==='a'){setTool('action');event.stopPropagation();}
    else if(event.key==='Delete'&&selection.kind==='cue'){deleteSelected();event.stopPropagation();}
    else if(event.key==='Delete'&&selection.kind==='cues'){deleteMany(selection.ids);event.stopPropagation();}
    else if(event.key==='Escape'){selection={kind:'none'};paint();event.stopPropagation();}
  }

  const perf=()=>history?.value||null;
  const compiled=()=>perf()?compilePerformance(perf(),{measures,frames:grid.frames}):null;
  function setTool(name){tool=name;paint();}
  function drawRail(){renderRail(rail,{groups:[['prepare-select','prepare-action']],active:{select:'prepare-select',action:'prepare-action'}[tool],onPick:name=>setTool({'prepare-select':'select','prepare-action':'action'}[name])});}

  // ---- records
  async function reload(chooseId=null){
    records=await api('/api/performances/'+encodeURIComponent(songId));
    const id=chooseId||record?.id||records[0]?.id||null;
    await open(id);
  }
  async function open(id){
    clearTimeout(saveTimer);
    if(!id){record=null;history=null;selection={kind:'none'};status='';paint();deps.onPlanChange?.();return;}
    const full=await api('/api/performance/'+encodeURIComponent(id));
    record=full;history=new History(full.draft||full.body);selection={kind:'none'};scope={kind:'shared'};regionId=null;status=full.draft?'Draft kept. Shows play it as it is now. Save to keep a version you can go back to.':'Saved';
    const fixed=rehomeStrayCues(history.value,position);
    if(fixed.moved){change(fixed.performance);status=moveWords(fixed.moved);movedNote={id,status};}
    const loops=loopFlagsToLoops(history.value,measures,grid.sections,position);
    if(loops.made||loops.performance.cues.length!==history.value.cues.length){change(loops.performance);status=`${loops.made===1?'A loop flag is':`${loops.made} loop flags are`} now ${loops.made===1?'a loop':'loops'} (the purple bands), playing the same bars the same number of times. Undo puts ${loops.made===1?'it':'them'} back.`;movedNote={id,status};}
    else if(movedNote?.id===id){status=movedNote.status;movedNote=null;}   // opened again straight after: still say what moved
    paint();deps.onPlanChange?.();
  }
  const moveWords=n=>`${n===1?'An action':`${n} actions`} past the end of a loop ${n===1?'was':'were'} filed under one of its passes, where ${n===1?'it':'they'} couldn’t play. Moved to Every play.`;
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
    try{const r=await api('/api/performance/save',{body:{...perf(),grid:gridFingerprint(measures)},base:record.head});record={...record,...r};records=records.map(x=>x.id===record.id?{...x,has_draft:false,head:r.head}:x);status=`Saved · version ${r.head}`;paint();}
    catch(error){status='Not saved';deps.showError(error);paint();}
  }
  function change(next){
    if(!history)return;
    const fixed=rehomeStrayCues(next,position);next=fixed.performance;
    const label=changeLabel(history.value,next,position,measures),now=Date.now(),merge=now-lastChangeAt<1500;lastChangeAt=now;
    history.push(next,label,{merge});status=fixed.moved?moveWords(fixed.moved):'Draft not saved yet';
    if(fixed.moved&&scope.kind==='pass')scope={kind:'shared'};
    clearTimeout(saveTimer);saveTimer=setTimeout(saveDraft,600);paint();deps.onPlanChange?.();
  }
  async function saveDraft(){if(!record||!history)return;try{await api('/api/performance/draft',{body:perf(),base:record.head});if(!disposed&&status==='Draft not saved yet'){status='Draft kept. Shows play it as it is now. Save to keep a version you can go back to.';saved.textContent=status;}}catch(error){status='Draft not saved';deps.showError(error);if(!disposed)paint();}}
  let lastChangeAt=0;
  // each step says what it was (deps.onStepped), so the app can show "Undid …" with a way back, as the other views do
  function undo(){lastChangeAt=0;const label=history?.undoLabels[0];if(history?.undo()){deps.onStepped?.({undid:true,count:1,label});clearSelectionIfGone();status='Draft not saved yet';clearTimeout(saveTimer);saveTimer=setTimeout(saveDraft,600);paint();deps.onPlanChange?.();}}
  function redo(){lastChangeAt=0;const label=history?.redoLabels[0];if(history?.redo()){deps.onStepped?.({undid:false,count:1,label});clearSelectionIfGone();status='Draft not saved yet';clearTimeout(saveTimer);saveTimer=setTimeout(saveDraft,600);paint();deps.onPlanChange?.();}}
  function clearSelectionIfGone(){if(selection.kind==='cue'&&!allActions(perf(),position).some(x=>x.cue.id===selection.id))selection={kind:'none'};}

  // ---- editing actions, in whichever scope they belong to
  function programEdit(targetScope,edit){
    if(targetScope.kind==='shared'){const next=structuredClone(perf());edit(next.cues);change(next);return;}
    change(editPass(perf(),targetScope.regionId,targetScope.passId,program=>edit(program),position,uid));
  }
  const editorContext=frame=>({tempo:tempoAt({measures,bpm:grid.tempo?.bpm,constant:grid.tempo?.constant},frame/44100),scenes:deps.scenes,inputs:wants=>inputChoices(deps.scenes(),wants),device:deps.devices()[0],mix:plannedMixAt(compiled(),frame),currentMix:deps.currentMix});
  /** The action screen, for something new at this spot. */
  function chooseAction(measure,beat={n:0,d:1}){
    if(!perf()){makeNew();return;}
    const value=beat.n/beat.d,at={measure:measure.id,beat};
    openActionEditor({title:`What should happen at bar ${measure.number}${value?`, beat ${value+1}`:''}?`,ctx:editorContext(position(at)*44100),
      onAdd:action=>{if(disposed)return;if(scope.kind==='shared'&&isLoopFlag(action)){addLoopAt(measure,action);return;}const id=uid();programEdit(scope,cues=>cues.push({id,at,action}));selection={kind:'cue',id};paint();}});
  }
  /** A loop chosen in the Action picker, for every play: a planned loop (the purple band) from the start of this bar, over its number of bars
   *  or this whole section. A pass's own loop action stays a flag, pressed as L or R would be when the music gets there. */
  function addLoopAt(measure,action){
    const p=action.params||{},i=measures.indexOf(measure);
    let first=i,last=Math.min(measures.length-1,i+Math.max(1,p.bars??4)-1);
    if(action.command==='loop-section'){
      const range=sectionRange(measures,grid.sections,Math.round(measure.start*SR));
      if(range){first=measures.findIndex(m=>Math.round(m.start*SR)===range.start);last=measures.findIndex(m=>Math.round(m.end*SR)===range.end);}
      if(first<0||last<0){first=i;last=i;}
    }
    const start=measures[first].start,end=measures[last].end;
    const clash=perf().regions.find(r=>position(r.start)<end-.002&&position(r.end)>start+.002);
    if(clash){const a=barAtFrame(measures,position(clash.start)),b=barAtFrame(measures,position(clash.end)-.001);status=`That loop would overlap the one at ${a===b?`bar ${a.number}`:`bars ${a.number} to ${b.number}`}. Change or remove that one first.`;paint();return;}
    const to=measures[last],endAt=last===measures.length-1?{measure:to.id,beat:{n:to.beats.length,d:1}}:address(measures[last+1].id);
    const id=uid();
    change(addRepeat(perf(),{start:address(measures[first].id),end:endAt,plays:Number.isInteger(p.plays)&&p.plays>=2?p.plays:'live',family:loopFamily(last-first+1),id},uid));
    scope={kind:'shared'};selection={kind:'none'};paint();
  }
  /** The action screen, for one already on the song. */
  function openCue(id){
    const item=find(id);if(!item)return;
    selection={kind:'cue',id};paint();
    editorOpen?.close();
    const m=measures.find(x=>x.id===item.cue.at.measure);
    const frame=position(item.cue.at)*44100;
    editorOpen=openActionEditor({title:`At bar ${m?.number??'?'}`,action:item.cue.action,ctx:editorContext(frame),
      onChange:action=>updateCue(id,()=>({action})),extras:host=>drawTiming(host,id),
      tools:[btn('','Copy','Copy this action, to paste at another bar (Ctrl+C). Select a bar, then Paste.',()=>{copySelected();editorOpen?.close();}),btn('danger','Delete','Remove this action. Undo brings it back.',()=>{editorOpen?.close();deleteSelected();})],
      onClose:()=>{editorOpen=null;paint();}});
  }
  const find=id=>allActions(perf(),position).find(x=>x.cue.id===id);
  function updateCue(id,patch){const item=find(id);if(!item)return;programEdit(item.scope,cues=>{const c=cues.find(x=>x.id===id);Object.assign(c,patch(c));});}
  function deleteSelected(){const item=find(selection.id);if(!item)return;programEdit(item.scope,cues=>{cues.splice(cues.findIndex(c=>c.id===item.cue.id),1);});selection={kind:'none'};paint();}

  let dragging=null,clipboard=null,sweep=null,swept=false;
  document.addEventListener('pointerup',()=>{if(sweep){const moved=selection.kind==='bars'&&selection.from!==selection.to;sweep=null;if(moved){swept=true;paint();setTimeout(()=>{swept=false;},0);}}});
  function markBars(){for(const b of scroller.querySelectorAll('.pf-bar')){const m=measures.find(x=>String(x.id)===b.dataset.bar);b.classList.toggle('on',selection.kind==='bars'&&m&&m.start>=selection.from.start&&m.start<=selection.to.start);}}
  const FINEST=64;
  /** The place in a bar under the pointer, the way the chart's Timing finds it. Magnet on: the nearest line of the grid the zoom draws, or a chord. Off: exactly where it's dropped. */
  function beatUnder(node,measure,clientX){
    const box=node.getBoundingClientRect(),beats=measure.beats.length,x=clientX-box.left,width=Math.max(1,box.width);
    const onsets=chordsInMeasure(grid.chords||[],measure).filter(c=>!c.continued).map(c=>c.start);
    const target=snapping?nearestTarget(barTargets(measure,{snap:autoSnap(zoom),onsets}).filter(t=>t.beat<beats-1e-6),x,width,beats):null;
    const beat=target?target.beat:Math.max(0,Math.min(beats,x/width*beats));
    return {n:Math.min(beats*FINEST-1,Math.round(beat*FINEST)),d:FINEST};
  }
  /** While a flag is dragged, a line shows where it would land. */
  function markDrop(bar,measure,clientX){
    const beat=beatUnder(bar,measure,clientX);
    let mark=bar.querySelector('.pf-drop-mark');
    if(!mark){mark=el('span','pf-drop-mark');bar.append(mark);}
    mark.style.left=`${beat.n/beat.d/measure.beats.length*100}%`;
  }
  function dropOn(measure,beat){
    const item=dragging&&find(dragging);dragging=null;if(!item)return;
    updateCue(item.cue.id,()=>({at:{measure:measure.id,beat}}));
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

  // ---- the timeline: the chart's sections and rows of bars
  function layOut(){for(const row of scroller.querySelectorAll('.bars'))applyRows(row);placeLoopCounts();}
  function drawTimeline(){
    const p=perf(),flow=el('div','chart-flow pf-flow');flow.style.setProperty('--beat',beatPx(zoom)+'px');
    const inScope=item=>scope.kind==='shared'?item.scope.kind==='shared':item.scope.regionId===scope.regionId&&item.scope.passId===scope.passId;
    const items=p?allActions(p,position):[];
    const ownPass=scope.kind==='pass'?perf().regions.find(r=>r.id===scope.regionId):null,pass=ownPass?(scope.passId==='further'?ownPass.further:ownPass.passes.find(x=>x.id===scope.passId)):null;
    const followShared=scope.kind==='pass'&&!pass?.program;
    const shown=items.filter(x=>inScope(x)||(followShared&&x.scope.kind==='shared'));
    const loops=loopBands(shown);
    // each bar in the section it starts in; bars before the first section sit in a row of their own
    const groups=[];
    for(const m of measures){
      const section=grid.sections.find(x=>m.start>=x.start-1e-6&&m.start<x.end-1e-6)||null;
      if(groups.at(-1)?.section!==section)groups.push({section,bars:[]});
      groups.at(-1).bars.push(m);
    }
    for(const {section,bars} of groups){
      const sec=el('section','sec pf-sec');sec.dataset.name=nameKey(section?.name);
      if(section){
        const head=el('div','sec-head'),name=el('button','sec-name',section.name);name.type='button';name.title=`${section.name}: bars ${bars[0].number} to ${bars.at(-1).number}. Click to select these bars.`;
        name.onclick=()=>{selection={kind:'bars',from:bars[0],to:bars.at(-1),name:section.name};paint();deps.seek?.(bars[0].start);};
        head.append(name,el('span','sec-time',clockText(section.start)));sec.append(head);
      }
      const row=el('div','bars'+(bars.some(m=>loops.some(l=>inLoop(l,m)))?' has-loop':''));
      bars.forEach((m,i)=>row.append(drawBar(m,i===bars.length-1,shown,loops)));
      sec.append(row);flow.append(sec);
    }
    legend.replaceChildren();
    for(const [kind,name,tip] of LANES){const key=el('span',`pf-key kind-${kind}`);key.title=tip;key.insertAdjacentHTML('afterbegin',icon('flag'));key.append(name);legend.append(key);}
    if(p&&!items.length)legend.append(el('span','pf-none',tool==='action'?'Nothing planned yet. Click a place in a bar to choose what should happen there.':'Nothing planned yet. Choose the Action tool, then click a place in a bar.'));
    const keep=scroller.scrollTop;
    scroller.replaceChildren(flow);layOut();scroller.scrollTop=keep;
  }
  function drawBar(m,last,shown,loops){
    const inSelection=selection.kind==='bars'&&m.start>=selection.from.start&&m.start<=selection.to.start;
    const bar=el('div','bar tbar pf-bar'+(last?' last':'')+(inSelection?' on':''));bar.dataset.bar=m.id;bar.style.setProperty('--beats',m.beats.length);
    bar.style.setProperty('--bp',beatPx(zoom)+'px');bar.style.setProperty('--sp',beatPx(zoom)*SNAP_QUARTERS[autoSnap(zoom)]+'px');
    bar.title=tool==='action'?`Click a place in bar ${m.number} to choose what should happen there`:`Click to select bar ${m.number}. Drag across bars to select several.`;
    // click a bar; drag across bars, or Shift-click a second one, for a range (From bar and To bar on the right do the same)
    bar.onpointerdown=event=>{if(event.button===0&&!event.shiftKey&&tool!=='action'&&!event.target.closest('button'))sweep=m;};
    bar.onpointerenter=()=>{if(sweep&&sweep!==m){const a=sweep;selection={kind:'bars',from:a.start<=m.start?a:m,to:a.start<=m.start?m:a};markBars();}};
    const pick=event=>{
      if(swept){swept=false;paint();return;}
      if(tool==='action'){chooseAction(m,beatUnder(bar,m,event.clientX));return;}
      if(event.shiftKey&&selection.kind==='bars'){const a=selection.from,z=m;selection={kind:'bars',from:a.start<=z.start?a:z,to:a.start<=z.start?z:a};}
      else{selection={kind:'bars',from:m,to:m};deps.seek?.(m.start);}   // the playhead comes here, and Play goes on from here
      paint();
    };
    bar.onclick=event=>{if(!event.target.closest('button'))pick(event);};
    bar.ondragover=event=>{if(dragging){event.preventDefault();bar.classList.add('drop');markDrop(bar,m,event.clientX);}};
    bar.ondragleave=event=>{if(bar.contains(event.relatedTarget))return;bar.classList.remove('drop');bar.querySelector('.pf-drop-mark')?.remove();};
    bar.ondrop=event=>{event.preventDefault();bar.classList.remove('drop');bar.querySelector('.pf-drop-mark')?.remove();dropOn(m,beatUnder(bar,m,event.clientX));};
    const number=el('button','bar-no',String(m.number));number.type='button';number.setAttribute('aria-label',tool==='action'?`Bar ${m.number}: choose what should happen here`:`Select bar ${m.number}`);
    number.onclick=event=>{if(tool==='action')chooseAction(m);else pick(event);};
    const chords=el('div','pf-chord-line');
    for(const c of chordsInMeasure(grid.chords||[],m)){
      if(c.continued||isNoChordLabel(c.label))continue;
      const chord=el('span','pf-chord',c.label);chord.style.left=`${c.beat/m.beats.length*100}%`;chord.dataset.start=c.start;chord.dataset.end=c.end;chords.append(chord);
    }
    const flags=el('div','pf-flag-line'),taken=new Map();
    for(const x of shown){
      if(x.cue.at.measure!==m.id)continue;
      const kind=laneOf(x.cue.action),kindName=LANES.find(([k])=>k===kind)[1],words=`${kindName}: ${describeAction(x.cue.action)}`,spot=beatValue(x.cue.at);
      const flag=el('button',`pf-flag kind-${kind}`+(selection.kind==='cue'&&selection.id===x.cue.id?' on':'')+(x.scope.kind==='shared'&&scope.kind==='pass'?' shared':'')+(x.cue.when?.first?' first':''));flag.type='button';flag.title=`${words}. ${playWords(x.cue,x.scope,perf().regions.find(r=>r.id===x.scope.regionId))}. Click to change it, or drag it to another place.`;flag.setAttribute('aria-label',words);flag.insertAdjacentHTML('afterbegin',icon('flag'));
      const before=taken.get(spot)||0;taken.set(spot,before+1);
      flag.style.left=`calc(${spot/m.beats.length*100}% + ${before*16}px)`;
      flag.onclick=()=>openCue(x.cue.id);
      flag.draggable=true;flag.ondragstart=event=>{dragging=x.cue.id;event.dataTransfer?.setData('text/plain',x.cue.id);if(event.dataTransfer)event.dataTransfer.effectAllowed='move';};flag.ondragend=()=>{dragging=null;};
      flags.append(flag);
      if(x.cue.action?.type==='marker.text'){   // a note reads like a chart cue: its words beside its flag, lit while its bar plays
        const note=el('button','pf-note'+(x.cue.enabled===false?' off':''),x.cue.action.text||'');note.type='button';note.title=`A note in this arrangement. During a show it shows on the chart here, and in Coming up before it. Click to change it.`;
        note.style.left=`calc(${spot/m.beats.length*100}% + ${before*16+14}px)`;note.onclick=()=>openCue(x.cue.id);flags.append(note);
      }
    }
    bar.append(number,flags,chords);
    for(const loop of loops)if(inLoop(loop,m))bar.append(drawLoopPiece(loop,m));
    return bar;
  }

  // ---- loops: a purple band of flags over the bars a loop flag goes round (the timeline's loop is purple too), with how many times
  // it plays. While that loop is going round, the count lights up, counts down the plays still to come (×1!! on the last) and bumps on
  // every beat, as a repeat's count does on the Chart tab. A loop you start with L or R while playing gets a band too, while it lasts.
  const SR=44100,near=(a,b)=>Math.abs(a-b)<.002;
  let loopBadges=[],drawnLive='';
  const liveKey=live=>live?`${live.start}-${live.end}`:'';
  const inLoop=(loop,m)=>m.start>=loop.start-1e-6&&m.start<loop.end-1e-6;
  function loopBands(shown){
    const shownNow=deps.loopShown?.(),live=shownNow&&!shownNow.regionId?shownNow:null,out=[];drawnLive=liveKey(live);
    for(const x of shown){
      const a=x.cue.action;if(a?.type!=='command'||(a.command!=='loop-bars'&&a.command!=='loop-section'))continue;
      const at=position(x.cue.at);if(!Number.isFinite(at))continue;
      const range=a.command==='loop-bars'?fourBarRange(measures,grid.sections,Math.round(at*SR),a.params?.bars??4):sectionRange(measures,grid.sections,Math.round(at*SR));
      if(!range||out.some(l=>near(l.start,range.start/SR)&&near(l.end,range.end/SR)))continue;
      const plays=Number.isInteger(a.params?.plays)&&a.params.plays>=2?a.params.plays:null;
      out.push({start:range.start/SR,end:range.end/SR,plays,label:range.label,cueId:x.cue.id});
    }
    // a planned loop (the Loop tool): the same band, and its count opens it to change it or edit a pass
    for(const r of perf()?.regions||[]){
      const start=position(r.start),end=position(r.end);if(!Number.isFinite(start)||!Number.isFinite(end))continue;
      const first=barAtFrame(measures,start),last=barAtFrame(measures,Math.max(start,end-.001));
      out.push({start,end,plays:r.plays==='live'?null:r.plays,label:first===last?`bar ${first.number}`:`bars ${first.number}–${last.number}`,cueId:null,regionId:r.id});
    }
    // a loop you start with L or R takes the place of any planned one under it while it lasts: one band, never one over another
    if(live&&!out.some(l=>near(l.start,live.start/SR)&&near(l.end,live.end/SR))){
      const a=live.start/SR,b=live.end/SR;
      for(let i=out.length-1;i>=0;i--)if(out[i].start<b-.002&&out[i].end>a+.002)out.splice(i,1);
      out.push({start:a,end:b,plays:null,label:live.label,cueId:null});
    }
    for(const l of out)l.bars=measures.filter(m=>inLoop(l,m));
    loopBadges=[];
    return out;
  }
  const loopFlag=end=>`<svg class="pf-loop-flag ${end}" viewBox="0 0 28 40" aria-hidden="true"><path d="M2 1V40"/><path d="M2 1.5h24l-6 7.5 6 7.5H2z"/></svg>`;
  function drawLoopPiece(loop,m){
    const piece=el('div','pf-loop'),i=loop.bars.indexOf(m),n=loop.bars.length;
    const times=loop.plays?`${loop.plays} times`:'until you leave it';
    piece.title=loop.regionId||loop.cueId?`Loops ${loop.label}, ${times}. Click its flags, band or count to change it.`:`You’re looping ${loop.label}. Press the same loop key again to leave it.`;
    if(loop.regionId||loop.cueId){piece.classList.add('editable');piece.onclick=event=>{event.stopPropagation();openLoopBand(loop);};}   // like any flag: its flags, band and count open its action
    piece.append(el('i','pf-loop-band'));
    if(i===0)piece.insertAdjacentHTML('beforeend',loopFlag('start'));
    if(i===n-1)piece.insertAdjacentHTML('beforeend',loopFlag('end'));
    if(i===Math.floor(n/2)){
      const text=loop.plays?`×${loop.plays}`:'∞',badge=el('button','pf-loop-count'+(n%2?'':' edge')+(loop.regionId&&regionId===loop.regionId?' on':''),text);badge.type='button';
      badge.title=loop.regionId||loop.cueId?`Plays ${times}. While it plays, this counts down the plays still to come. Click to change the loop.`:`Loops ${times}.`;
      badge.setAttribute('aria-label',`Loop: ${loop.label}, ${times}`);
      if(!loop.regionId&&!loop.cueId)badge.disabled=true;
      piece.append(badge);loopBadges.push({node:badge,loop,text,beat:null});
    }
    return piece;
  }
  /** A loop's count sits in the middle of the last row its band reaches, so it's never cut off at a row's edge. Runs after rows are laid out. */
  function placeLoopCounts(){
    for(const b of loopBadges){
      const nodes=b.loop.bars.map(m=>scroller.querySelector(`.pf-bar[data-bar="${CSS.escape(String(m.id))}"]`)).filter(Boolean);if(!nodes.length)continue;
      const top=Math.max(...nodes.map(n=>n.offsetTop)),row=nodes.filter(n=>Math.abs(n.offsetTop-top)<4);
      const host=row[Math.floor(row.length/2)]?.querySelector('.pf-loop');if(!host)continue;
      b.node.classList.toggle('edge',row.length%2===0);
      if(b.node.parentNode!==host)host.append(b.node);
    }
  }
  /** The action screen for a loop, as for any flag: Loop bars, its number of bars and plays. A planned loop's passes are in the panel on the right. */
  function openLoopBand(loop){
    if(loop.cueId){openCue(loop.cueId);return;}
    const r=perf().regions.find(x=>x.id===loop.regionId);if(!r)return;
    const id=r.id,first=barAtFrame(measures,position(r.start)),last=barAtFrame(measures,position(r.end)-.001),count=measures.indexOf(last)-measures.indexOf(first)+1;
    regionId=id;if(selection.kind==='region')selection={kind:'none'};paint();
    editorOpen?.close();
    const passes=btn('','Edit one pass…','Give one time round its own actions, or choose what happens when the loop ends, in the panel on the right',()=>{editorOpen?.close();scope={kind:'pass',regionId:id,passId:perf().regions.find(x=>x.id===id)?.passes[0]?.id,index:0};selection={kind:'region',id};paint();});
    editorOpen=openActionEditor({title:`At bar ${first.number}`,action:{type:'command',command:'loop-bars',params:{bars:count,...(Number.isInteger(r.plays)&&r.plays>=2?{plays:r.plays}:{})}},ctx:editorContext(first.start*SR),
      onChange:action=>changeLoop(id,action),
      tools:[passes,btn('danger','Delete','Remove this loop, and every pass’s own actions with it. Undo brings it back.',()=>{editorOpen?.close();regionId=null;scope={kind:'shared'};selection={kind:'none'};change(removeRegion(perf(),id));})],
      onClose:()=>{editorOpen=null;if(selection.kind!=='region')regionId=null;paint();}});
  }
  /** A change made in a loop's action screen. Another number of bars or plays changes the loop; another kind of action replaces it with a flag. */
  function changeLoop(id,action){
    const r=perf().regions.find(x=>x.id===id);if(!r)return;
    const firstI=measures.indexOf(barAtFrame(measures,position(r.start)));
    if(!isLoopFlag(action)){
      const cue=uid(),next=removeRegion(perf(),id);next.cues.push({id:cue,at:structuredClone(r.start),action});
      editorOpen?.close();regionId=null;scope={kind:'shared'};change(next);openCue(cue);return;
    }
    let lastI=Math.min(measures.length-1,firstI+Math.max(1,action.params?.bars??4)-1);
    if(action.command==='loop-section'){const range=sectionRange(measures,grid.sections,Math.round(measures[firstI].start*SR));const e=range&&measures.findIndex(m=>Math.round(m.end*SR)===range.end);if(e>=firstI)lastI=e;}
    const start=measures[firstI].start,end=measures[lastI].end;
    if(perf().regions.some(x=>x.id!==id&&position(x.start)<end-.002&&position(x.end)>start+.002)){status='That would overlap another loop. Make this one shorter, or remove the other first.';paint();return;}
    const next=structuredClone(perf()),region=next.regions.find(x=>x.id===id),to=measures[lastI];
    region.end=lastI===measures.length-1?{measure:to.id,beat:{n:to.beats.length,d:1}}:address(measures[lastI+1].id);region.family=loopFamily(lastI-firstI+1);
    const plays=Number.isInteger(action.params?.plays)&&action.params.plays>=2?action.params.plays:'live';
    change(plays===region.plays?next:setPlays(next,id,plays,uid));
  }
  /** Every 40 ms, with the playhead: the count of the loop going round now. */
  function paintLoopCount(seconds){
    const now=deps.loopShown?.()??null,live=now&&!now.regionId?now:null;
    if(liveKey(live)!==drawnLive){drawTimeline();return;}   // a loop you started (or that ended) gets its band (or loses it)
    if(!loopBadges.length)return;
    const playing=!!deps.playing?.();let beat=null;
    if(playing){
      const m=measures.find(m=>seconds>=m.start&&seconds<m.end);
      if(m){const points=[...m.beats,m.end];let i=0;while(i<points.length-2&&points[i+1]<=seconds)i++;beat={key:m.id+':'+i,length:Math.max(.08,points[i+1]-points[i])};}
    }
    for(const b of loopBadges){
      // lit: the plan going round, or a live loop over these same bars (L in a planned loop keeps going round it, ∞)
      const on=playing&&!!now&&(now.regionId?b.loop.regionId===now.regionId:near(b.loop.start,now.start/SR)&&near(b.loop.end,now.end/SR));
      const left=on?now.left:null;
      const text=on?(left?'×'+left+(left===1?'!!':''):'∞'):(b.loop.plays?`×${b.loop.plays}`:'∞');
      if(b.text!==text){b.text=text;b.node.textContent=text;}
      b.node.classList.toggle('live',on);b.node.classList.toggle('last',on&&left===1);
      if(on&&beat&&b.beat!==beat.key){
        b.beat=beat.key;b.node.style.setProperty('--beat-len',beat.length.toFixed(3)+'s');
        b.node.dataset.beat=b.node.dataset.beat==='a'?'b':'a';                 // a fresh animation name restarts the bump on the beat
      }else if(!on&&b.beat){b.beat=null;delete b.node.dataset.beat;}
    }
  }

  function drawPasses(){
    passBar.replaceChildren();
    const zoomButton=(direction,label,iconName)=>{const b=btn('sq','',`${label} (Ctrl+wheel)`,()=>zoomBy(direction),iconName);b.setAttribute('aria-label',label);return b;};
    const magnet=btn('sq magnet'+(snapping?' on':''),'',`Snap to the grid. On: a dragged flag lands on the ${autoSnap(zoom)} grid, which gets finer as you zoom in. Off: it lands exactly where you drop it.`,()=>{snapping=rememberedSnap=!snapping;paint();},'magnet');magnet.setAttribute('aria-label','Snap to the grid');magnet.setAttribute('aria-pressed',String(snapping));
    const count=perf()?allActions(perf(),position).length+perf().regions.length:0;
    const listB=btn('pf-list-toggle'+(showList?' on':''),`Actions${count?` (${count})`:''}`,showList?'Hide the list of every action and loop. The flags on the bars still show them all.':'Show every action and loop in a list, in song order, to find one, or tick several to copy or delete them together',()=>{showList=rememberedList=!showList;paint();},'list');
    listB.setAttribute('aria-pressed',String(showList));if(!perf())listB.hidden=true;
    const zooms=el('span','pf-zoom');zooms.append(listB,magnet,zoomButton(-1,'Zoom out, to see more of the song','minus'),zoomButton(1,'Zoom in, to place actions more finely','plus'));
    const p=perf();if(!p){passBar.append(zooms);return;}
    queueMicrotask(()=>{passBar.querySelector('.pf-zoom')?.remove();passBar.append(zooms);});
    const region=p.regions.find(r=>r.id===regionId);
    const tab=(text,on,run,tip,custom=false)=>{const b=el('button','btn pf-tab'+(on?' on':'')+(custom?' custom':''),text);b.type='button';b.setAttribute('aria-pressed',String(on));b.title=tip;b.onclick=run;return b;};
    passBar.append(el('span','vx-cap','Editing'));
    passBar.append(tab('Every play',scope.kind==='shared',()=>{scope={kind:'shared'};regionId=null;selection={kind:'none'};paint();},'Actions for every time the music passes them. A pass that has its own actions keeps them.'));
    if(!region)return;
    region.passes.forEach((pass,i)=>passBar.append(tab(`Pass ${i+1}`,scope.passId===pass.id,()=>{scope={kind:'pass',regionId:region.id,passId:pass.id,index:i};selection={kind:'region',id:region.id};paint();},`Edit only pass ${i+1}. Nothing you do here touches another pass.${pass.program?' This pass has its own actions.':' It follows Every play until you change it.'}`,!!pass.program)));
    if(region.plays==='live')passBar.append(tab('Further passes',scope.passId==='further',()=>{scope={kind:'pass',regionId:region.id,passId:'further',index:null};paint();},'Used by every pass after the planned ones, until you leave the loop.',!!region.further?.program));
  }

  function zoomBy(direction){const next=stepZoom(zoom,direction);if(next===zoom)return;zoom=rememberedZoom=next;paint();}
  scroller.addEventListener('wheel',event=>{if(!event.ctrlKey)return;event.preventDefault();event.stopPropagation();zoomBy(event.deltaY<0?1:-1);},{passive:false});
  const watchWidth=typeof ResizeObserver==='function'?new ResizeObserver(()=>layOut()):null;watchWidth?.observe(scroller);

  // ---- the inspector
  function field(labelText,control,help){const row=el('label','pf-field');row.append(el('span','pf-field-name',labelText),control);if(help)row.title=help;return row;}
  function numberInput(value,{min,max,step},onChange,optional=false){const i=el('input');i.type='number';if(min!==undefined)i.min=min;if(max!==undefined)i.max=max;if(step!==undefined)i.step=step;i.value=value??'';i.onchange=()=>{if(i.value===''&&optional){onChange(undefined);return;}const v=Number(i.value);if(Number.isFinite(v))onChange(v);};return i;}
  /** Where and when an action happens, in the Details pane of the action screen. */
  function drawTiming(host,id){
    const item=find(id);if(!item)return;
    const box=el('div','pf-timing');host.append(el('h3','vx-cap','When'),box);
    const m=measures.find(x=>x.id===item.cue.at.measure);
    const barInput=numberInput(m?.number,{min:measures[0].number,max:measures.at(-1).number,step:1},v=>{const t=measures.find(x=>x.number===v);if(t)updateCue(id,c=>({at:address(t.id,c.at.beat.n,c.at.beat.d)}));});
    const beatInput=numberInput(beatValue(item.cue.at)+1,{min:1,max:(m?.beats.length||4)+.99,step:.25},v=>updateCue(id,c=>({at:{measure:c.at.measure,beat:{n:Math.round((v-1)*16),d:16}}})));
    const when=el('select');when.title='Whether this happens each time the music gets here, or only the first time. Going round a loop counts as getting here again.';for(const [v,t] of [['every','Every time it comes round'],['first','The first time only']]){const n=el('option','',t);n.value=v;when.append(n);}when.value=item.cue.when?.first?'first':'every';when.onchange=()=>updateCue(id,()=>({when:when.value==='first'?{first:true}:undefined}));
    const lead=numberInput(item.cue.leadMs??0,{min:0,max:2000,step:5},v=>updateCue(id,()=>({leadMs:v})));
    const order=numberInput(item.cue.order,{min:0,max:99,step:1},v=>updateCue(id,()=>({order:v})),true);
    const enabled=el('input');enabled.type='checkbox';enabled.checked=item.cue.enabled!==false;enabled.onchange=()=>updateCue(id,()=>({enabled:enabled.checked}));
    box.append(field('Bar',barInput),field('Beat',beatInput,'1 is the start of the bar'),field('When',when),field('Early by (ms)',lead,'Do it this much ahead of the beat, for a pedal or preset that takes a moment to change'),field('Order on this spot',order,'For two actions that set the same thing at the same moment: the lower number goes first'),field('On',enabled,'Off: the action stays on the song but does nothing'));
    const action=item.cue.action;
    if(isOlderMixerFlag(action))box.append(btn('','Turn into a mixer keyframe','Replace this with a keyframe of the whole mixer as it stands here, with this change in it',()=>{const action=keyframeForFlag(compiled(),position(item.cue.at)*44100,item.cue.action);updateCue(id,()=>({action}));editorOpen?.close();openCue(id);}));
    if(action.device){
      const wire=el('details','pf-wire');wire.append(el('summary','','Exact MIDI bytes'),el('code','',messagesFor(action,0).map(x=>x.bytes.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ')).join('  ·  ')));
      const said=el('small','');said.setAttribute('role','status');
      const send=btn('','Send this now','Send it to the device right now, to try it. This does change what the device is doing.',async()=>{
        const a=find(id)?.cue.action;if(!a)return;
        try{const c=await api('/api/midi/connect',{name:a.device});if(!c.output){said.textContent=c.error||`${a.device} isn’t connected.`;return;}
          const {clock}=await api('/api/midi/status');await api('/api/midi/schedule',{device:a.device,events:messagesFor(a,clock+.01)});said.textContent='Sent. That means it left this computer, not that the device acted on it.';}
        catch(error){deps.showError(error);}
      });
      box.append(wire,send,said);
    }
  }
  function drawInspector(){
    inspector.replaceChildren();
    const p=perf();
    if(!p){
      inspector.append(el('h3','pf-title','Original arrangement'),el('p','pf-none','The song as it is, start to finish. To add loops, mutes, visuals or MIDI, make an arrangement. The chart and the recording don’t change.'),btn('hot','Make an arrangement','Start a named arrangement of this song',()=>makeNew(),'plus'));
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
      inspector.append(el('h3','pf-title',describeAction(item.cue.action)),el('p','pf-scope',`Bar ${m?.number??'?'} · ${playWords(item.cue,item.scope,p.regions.find(r=>r.id===item.scope.regionId))}`));
      const row=el('div','pf-add-actions');
      row.append(btn('hot','Change…','Open this action’s details',()=>openCue(item.cue.id)),btn('','Copy','Copy this action, to paste at another bar (Ctrl+C). Select a bar, then Paste.',()=>copySelected()),btn('danger','Delete','Remove it (Delete). Undo brings it back.',()=>deleteSelected()));
      inspector.append(row);
      return;
    }
    if(selection.kind==='bars'){   // selecting bars moves the playhead; with something copied, it's where Paste puts it
      const {from,to}=selection;
      if(clipboard?.length){inspector.append(el('h3','pf-title',from===to?`Bar ${from.number}`:`Bars ${from.number} to ${to.number}`),btn('',`Paste ${clipboard.length===1?'the copied action':`${clipboard.length} copied actions`} here`,'Put copies here (Ctrl+V), keeping their places in the bar and their spacing',()=>pasteAt(from)));}
      return;
    }
    if(selection.kind==='region'){
      const r=p.regions.find(x=>x.id===selection.id);if(!r){selection={kind:'none'};return drawInspector();}
      const first=barAtFrame(measures,position(r.start)),last=barAtFrame(measures,position(r.end)-.001);
      inspector.append(el('h3','pf-title',`Loop: bars ${first.number} to ${last.number}`));
      inspector.append(el('p','pf-hint',`${r.plays==='live'?'Plays until you leave it':`${r.plays} plays`}. Choose a pass above to give it its own actions.`),btn('','Change the loop…','Its number of bars and plays, or delete it',()=>openLoopBand({regionId:r.id})));
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
      exit.append(btn('','Add…','Choose something to happen at the end of the loop, however you left it',()=>openActionEditor({title:'What should happen when this loop ends?',ctx:editorContext(position(r.end)*44100),onAdd:action=>{const next=structuredClone(perf());next.regions.find(x=>x.id===r.id).onExit.push(action);change(next);}})));
      inspector.append(exit);
      return;
    }
    inspector.append(el('p','pf-none','Choose the Action tool to add an action or a loop. Click a flag to change it.'));
  }
  function drawList(){
    const keep=document.activeElement?.dataset?.cue;
    list.replaceChildren();
    const p=perf();if(!p)return;
    const items=allActions(p,position).filter(x=>filter==='all'||laneOf(x.cue.action)===filter);
    // repeats change what plays as much as any flag does, so they're listed with them, in song order
    const repeats=filter==='all'||filter==='control'?p.regions:[];
    if(!items.length&&!repeats.length)list.append(el('li','pf-none','None yet.'));
    const addRepeatRow=r=>{
      const first=barAtFrame(measures,position(r.start)),last=barAtFrame(measures,position(r.end)-.001),words=repeatWords(r,first.number,last.number),li=el('li','pf-list-item pf-list-repeat');
      const b=el('button','pf-list-row'+(selection.kind==='region'&&selection.id===r.id?' on':''));b.type='button';b.dataset.region=r.id;b.title='Click to change or remove this loop';
      b.append(el('b','',`Bar ${first.number}`),el('span','',words.title),el('small','',words.plays));
      b.onclick=()=>{openLoopBand({regionId:r.id});scroller.querySelector('.pf-loop-count.on')?.scrollIntoView({block:'nearest'});};
      li.append(b);list.append(li);
    };
    const waiting=[...repeats].sort((a,c)=>position(a.start)-position(c.start));
    const errors=new Set(compiled()?.errors.map(e=>e.ref));
    for(const x of items){
      while(waiting.length&&position(waiting[0].start)<=x.seconds)addRepeatRow(waiting.shift());
      const m=barAtFrame(measures,x.seconds),li=el('li');
      const b=el('button','pf-list-row'+(selection.kind==='cue'&&selection.id===x.cue.id?' on':''));b.type='button';b.dataset.cue=x.cue.id;
      b.append(el('b','',`Bar ${m.number}`),el('span','',describeAction(x.cue.action)),el('small','',playWords(x.cue,x.scope,p.regions.find(r=>r.id===x.scope.regionId))));
      if(errors.has(x.cue.id))b.append(el('em','pf-warn','Needs a look'));
      b.onclick=()=>{if(x.scope.kind==='pass'){regionId=x.scope.regionId;scope=x.scope;}else if(scope.kind==='pass'){scope={kind:'shared'};}openCue(x.cue.id);scroller.querySelector('.pf-flag.on')?.scrollIntoView({block:'nearest'});};
      const tick=el('input');tick.type='checkbox';tick.className='pf-tick';tick.setAttribute('aria-label',`Select: bar ${m.number}, ${describeAction(x.cue.action)}`);tick.title='Tick several to copy or delete them together';
      tick.checked=selection.kind==='cues'?selection.ids.includes(x.cue.id):false;
      tick.onchange=()=>{const now=new Set(selection.kind==='cues'?selection.ids:selection.kind==='cue'?[selection.id]:[]);if(tick.checked)now.add(x.cue.id);else now.delete(x.cue.id);selection=now.size?{kind:'cues',ids:[...now]}:{kind:'none'};paint();};
      li.className='pf-list-item';li.append(tick,b);list.append(li);
    }
    waiting.forEach(addRepeatRow);
    if(keep)list.querySelector(`[data-cue="${CSS.escape(keep)}"]`)?.focus();
    void listFocus;
  }
  function paint(){
    if(disposed)return;
    const opts=[el('option','','Original arrangement')];opts[0].value='';
    for(const r of records){const o=el('option','',r.name+(r.has_draft?' (draft)':''));o.value=r.id;opts.push(o);}
    choice.replaceChildren(...opts);choice.value=record?.id||'';
    choice.onchange=()=>open(choice.value||null).catch(deps.showError);
    const editing=!!perf();
    const setName=deps.performSet?.name();performB.disabled=!setName;performB.lastChild.textContent=setName?`Perform ${setName}`:'Perform';
    performB.title=setName?`Get the set list “${setName}” ready to play. It plays the saved version of each song’s arrangement, and nothing plays until you press Start.`:'Choose a set list on the left to perform it.';
    for(const b of [dup,ren,del,saveB])b.disabled=!editing;
    saved.textContent=status;
    const c=compiled();
    musicLength.textContent=clockText(c?pathSeconds(c.segments).music:grid.frames/44100)+(c&&c.requiresLiveControl?' (estimated; needs you there)':'');
    problems.replaceChildren();
    for(const e of c?.errors||[])problems.append(el('p','pf-problem',e.message));
    for(const w of c?.warnings||[])problems.append(el('p','pf-note',w.message));
    saved.title=status;
    // With the list open, the column on the right holds it and what you selected. With it closed, the bars get the room, and what you
    // select opens over their right edge, so selecting a bar never moves the bars under your pointer.
    listHead.hidden=list.hidden=!showList;
    const floating=editing&&!showList;
    stage.classList.toggle('no-list',floating);side.hidden=floating&&(selection.kind==='none'||(selection.kind==='bars'&&!clipboard?.length));
    drawRail();drawPasses();drawTimeline();drawInspector();drawList();
    deps.onHistory?.();
  }
  const devices=el('datalist');devices.id='pf-devices';for(const d of deps.devices())devices.append(Object.assign(el('option'),{value:d}));panel.append(devices);
  paint();
  reload().catch(deps.showError);
  // the playhead: where the song is, playing or not, on the bars as they're laid out here
  const head=el('span','pf-playhead');head.setAttribute('aria-hidden','true');
  let headBar=null,headTick=0;
  function drawHead(){
    if(disposed)return;
    const seconds=deps.playhead?.();if(!Number.isFinite(seconds))return;
    paintLoopCount(seconds);
    defaultsB.hidden=!(deps.liveChanges?.()>0);
    const m=seconds<measures[0].start?measures[0]:barAtFrame(measures,seconds);
    if(m!==headBar||!head.isConnected){
      scroller.querySelector('.pf-bar.now')?.classList.remove('now');
      for(const chord of scroller.querySelectorAll('.pf-chord.now'))chord.classList.remove('now');   // the bar it leaves lets go of its chord
      const node=scroller.querySelector(`.pf-bar[data-bar="${CSS.escape(String(m.id))}"]`);if(!node)return;
      const moved=m!==headBar;headBar=m;node.classList.add('now');node.append(head);
      if(moved&&deps.playing?.())node.scrollIntoView({block:'nearest'});
    }
    const inBar=Math.max(m.start,Math.min(m.end,seconds));
    head.style.left=`${(inBar>=m.end?m.beats.length:beatAt(m,inBar))/m.beats.length*100}%`;
    for(const chord of headBar&&scroller.querySelector('.pf-bar.now')?.querySelectorAll('.pf-chord')||[])chord.classList.toggle('now',seconds>=Number(chord.dataset.start)&&seconds<Number(chord.dataset.end));
  }
  headTick=setInterval(drawHead,40);
  /** The top bar's Undo, Redo and History, for this page: the names of the steps, and going several at once. */
  const historyApi={
    get canUndo(){return !!history?.canUndo;},get canRedo(){return !!history?.canRedo;},
    get undoLabels(){return history?.undoLabels??[];},get redoLabels(){return history?.redoLabels??[];},
    undo,redo,
    /** steps: back (negative) or forward (positive) through the history, in one go. */
    go(steps){if(!history)return;lastChangeAt=0;const labels=steps<0?history.undoLabels:history.redoLabels,label=labels[Math.min(Math.abs(steps),labels.length)-1];let moved=false;for(let i=0;i<Math.abs(steps);i++)moved=(steps<0?history.undo():history.redo())!==null||moved;if(moved){deps.onStepped?.({undid:steps<0,count:Math.abs(steps),label});clearSelectionIfGone();status='Draft not saved yet';clearTimeout(saveTimer);saveTimer=setTimeout(saveDraft,600);paint();deps.onPlanChange?.();}},
  };
  return {paint,keydown,history:historyApi,get performance(){return perf();},
    /** What Play should follow: the arrangement as it stands, or null for the song as it is, or while it has a problem. */
    plan(){const c=compiled();return perf()&&c?.ok?perf():null;},
    get selection(){return selection;},setSelection(value){selection=value;paint();},change,dispose(){disposed=true;clearInterval(headTick);editorOpen?.close();watchWidth?.disconnect();clearTimeout(saveTimer);if(status==='Draft not saved yet')saveDraft();root.replaceChildren();}};
}

const pad2=n=>String(n).padStart(2,'0');
export const clockValue=epoch=>{const d=new Date(epoch);return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;};
/** The next time this clock time comes round, as epoch ms: later today, or tomorrow if it has passed. */
export function nextTimeOfDay(text,now){
  const [h,m]=String(text).split(':').map(Number),d=new Date(now);d.setHours(h,m,0,0);
  if(d.getTime()<=now)d.setDate(d.getDate()+1);
  return d.getTime();
}
