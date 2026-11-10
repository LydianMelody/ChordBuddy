// What a performance and a show are, as saved. Pure: every edit returns a new value (so undo is just keeping the old one).
//
// Performance: one song's named arrangement.
//   initial: actions in force when the song starts
//   cues: [{id, at:{measure, beat:{n,d}}, action, when?, order?, enabled?, leadMs?}] the shared program, by musical address
//   regions: repeats. Each has start/end addresses, plays (a count, or 'live' for until released), family ('bars' answers to L, 'section' to R)
//     and passes: [{id, entry:[actions], program}], one per planned play. program null means the pass still follows the shared cues in its
//     range; the first edit turns it into its own copy, so editing Pass 2 can never change Pass 1. Pass ids stay with a pass through reorders.
//     further: the template for passes past the planned ones of a 'live' region. onExit: actions at the end of the region.
//   jumps: [{id, at, to, times}], holds: [{id, at, seconds, expected}] (seconds null: wait for a control; expected: the planning estimate)
// A cue's when: undefined or {every:true} on every traversal; {first:true} only on the first visit; {passes:[ids]} only in those passes.
// Show: an ordered list of entries, each naming a performance, which plays as it is now (its draft, if it has one). `revision` is kept because saved shows name one, but it doesn't choose what plays. Entries have their own ids, so a song can appear twice.
export const SCHEMA=1;
export const LIVE_BUDGET=4;                     // an until-released loop is planned as four plays in all: an estimate, never a stop
export const MAX_PLAYS=256;
const clone=value=>structuredClone(value);
const defaultId=()=>globalThis.crypto.randomUUID().replaceAll('-','').slice(0,16);

export const address=(measure,n=0,d=1)=>({measure,beat:{n,d}});
export const beatValue=a=>a.beat.n/a.beat.d;

export function newPerformance({songId,name='Original arrangement',id=defaultId()}){
  return {schema:SCHEMA,id,songId,name,grid:null,initial:[],cues:[],regions:[],jumps:[],holds:[]};
}
export function newShow({name,sourceList=null,id=defaultId()}){
  return {schema:SCHEMA,id,name,sourceList,entries:[],target:null,policy:defaultPolicy(),transitions:{kind:'immediate',seconds:0},devices:[],keepVisualsWhenMuted:false,carryOverrides:false};
}
export function newEntry({songId,performanceId,revision,transition=null,id=defaultId()}){
  return {id,songId,performanceId,revision,transition};
}
export const POLICIES=Object.freeze(['until-released','next-cue','next-section','locked']);
export function defaultPolicy(){return {all:'until-released',tracks:null,visuals:null,midi:null,rate:null,structure:null};}

function regionOf(performance,regionId){
  const region=performance.regions.find(r=>r.id===regionId);
  if(!region)throw Error('That repeat is gone.');
  return region;
}
const emptyPass=id=>({id,entry:[],program:null});
function fitPasses(region,uid){
  const want=region.plays==='live'?Math.max(LIVE_BUDGET,region.passes.length):region.plays;
  while(region.passes.length<want)region.passes.push(emptyPass(uid()));
  if(region.plays!=='live')region.passes.length=Math.min(region.passes.length,want);
}

/** Repeat a stretch of the song. plays: total plays including the first, or 'live'. */
export function addRepeat(performance,{start,end,plays,family='bars',id},uid=defaultId){
  if(plays!=='live'&&!(Number.isInteger(plays)&&plays>=1&&plays<=MAX_PLAYS))throw Error(`Choose between 1 and ${MAX_PLAYS} plays.`);
  const next=clone(performance);
  const region={id:id||uid(),start:clone(start),end:clone(end),plays,family,passes:[],further:{entry:[],program:null},onExit:[]};
  fitPasses(region,uid);next.regions.push(region);
  return next;
}
export function setPlays(performance,regionId,plays,uid=defaultId){
  if(plays!=='live'&&!(Number.isInteger(plays)&&plays>=1&&plays<=MAX_PLAYS))throw Error(`Choose between 1 and ${MAX_PLAYS} plays.`);
  const next=clone(performance),region=regionOf(next,regionId);
  region.plays=plays;fitPasses(region,uid);
  return next;
}
export const removeRegion=(performance,regionId)=>({...clone(performance),regions:performance.regions.filter(r=>r.id!==regionId).map(clone)});

/** The address order, for working out what lies inside a region. position(address) -> seconds, from the compiler or the editor. */
export function sharedCuesInRegion(performance,region,position){
  const from=position(region.start),to=position(region.end);
  return performance.cues.filter(c=>{const t=position(c.at);return t>=from&&t<to;});
}
/** A pass's own actions play only inside its repeat. Any that end up outside it (added, pasted or moved there while editing a pass) go to Every play, where they do play. */
export function rehomeStrayCues(performance,position){
  const next=clone(performance);let moved=0;
  for(const region of next.regions||[]){
    const from=position(region.start),to=position(region.end);
    for(const pass of [...(region.passes||[]),region.further]){
      if(!pass?.program)continue;
      pass.program=pass.program.filter(c=>{const t=position(c.at);if(!Number.isFinite(t)||(t>=from&&t<to))return true;const {from:copiedFrom,...cue}=c;void copiedFrom;next.cues.push(cue);moved++;return false;});
    }
  }
  return {performance:moved?next:performance,moved};
}
/** A pass's own program, copied from the shared cues on first need. */
function ownProgram(performance,region,pass,position,uid){
  if(!pass.program)pass.program=sharedCuesInRegion(performance,region,position).map(c=>({...clone(c),id:uid(),from:c.id}));
  return pass.program;
}
/** Edit one pass: edit(program, pass) changes its own copy. No other pass, and not the shared program, can change. */
export function editPass(performance,regionId,passId,edit,position,uid=defaultId){
  const next=clone(performance),region=regionOf(next,regionId);
  const pass=passId==='further'?region.further:region.passes.find(p=>p.id===passId);
  if(!pass)throw Error('That pass is gone.');
  edit(ownProgram(next,region,pass,position,uid),pass);
  return next;
}
export function copyPass(performance,regionId,fromId,toIds,position,uid=defaultId){
  const next=clone(performance),region=regionOf(next,regionId);
  const find=id=>{const p=id==='further'?region.further:region.passes.find(x=>x.id===id);if(!p)throw Error('That pass is gone.');return p;};
  const from=find(fromId),program=from.program?from.program:sharedCuesInRegion(next,region,position).map(c=>({...clone(c),from:c.id}));
  for(const id of toIds){if(id===fromId)continue;const to=find(id);to.program=program.map(c=>({...clone(c),id:uid()}));to.entry=clone(from.entry);}
  return next;
}
export const copyPreviousPass=(performance,regionId,passId,position,uid=defaultId)=>{
  const passes=regionOf(performance,regionId).passes,i=passes.findIndex(p=>p.id===passId);
  if(i<1)throw Error('The first pass has nothing before it to copy.');
  return copyPass(performance,regionId,passes[i-1].id,[passId],position,uid);
};
/** Back to following the shared cues. */
export function resetPass(performance,regionId,passId){
  const next=clone(performance),region=regionOf(next,regionId),pass=passId==='further'?region.further:region.passes.find(p=>p.id===passId);
  if(!pass)throw Error('That pass is gone.');
  pass.program=null;pass.entry=[];
  return next;
}
export function movePass(performance,regionId,passId,toIndex){
  const next=clone(performance),passes=regionOf(next,regionId).passes,i=passes.findIndex(p=>p.id===passId);
  if(i<0||toIndex<0||toIndex>=passes.length)throw Error('That pass cannot move there.');
  passes.splice(toIndex,0,passes.splice(i,1)[0]);
  return next;
}
export function removePass(performance,regionId,passId){
  const next=clone(performance),region=regionOf(next,regionId),i=region.passes.findIndex(p=>p.id===passId);
  if(i<0)throw Error('That pass is gone.');
  if(region.plays!=='live'&&region.plays<=1)throw Error('A repeat needs at least one play.');
  region.passes.splice(i,1);
  if(region.plays!=='live')region.plays=region.passes.length;
  return next;
}
/** Passes that have their own program: a shared edit leaves these alone unless named in propagateTo. */
export const customizedPasses=region=>region.passes.filter(p=>p.program).map(p=>p.id);
/** Change the shared cues in a region. Passes that still follow them change at once; customized passes change only if named, by adding the cue. */
export function editShared(performance,edit,{regionId=null,propagateTo=[],position=null,uid=defaultId}={}){
  const next=clone(performance),before=new Set(next.cues.map(c=>c.id));
  edit(next.cues);
  if(regionId&&propagateTo.length){
    const region=regionOf(next,regionId);
    for(const id of propagateTo){
      const pass=region.passes.find(p=>p.id===id);if(!pass?.program)continue;
      const after=new Map(next.cues.map(c=>[c.id,c]));
      pass.program=pass.program.filter(c=>!c.from||after.has(c.from)||!before.has(c.from)).map(c=>c.from&&after.has(c.from)?{...clone(after.get(c.from)),id:c.id,from:c.from}:c);
      const has=new Set(pass.program.map(c=>c.from));
      const from=position(region.start),to=position(region.end);
      for(const c of next.cues)if(!before.has(c.id)&&!has.has(c.id)&&position(c.at)>=from&&position(c.at)<to)pass.program.push({...clone(c),id:uid(),from:c.id});
    }
  }
  return next;
}

/** Copies of some actions, moved by a number of bars. A copy that would fall off the song is left out, and counted. measures: the song's bars. */
export function copyCues(cues,measures,bars,makeId=defaultId){
  const out=[];let skipped=0;
  for(const cue of cues){
    const i=measures.findIndex(m=>m.id===cue.at.measure),target=measures[i+bars];
    if(i<0||!target||beatValue(cue.at)>=target.beats.length){skipped++;continue;}
    out.push({...clone(cue),id:makeId(),at:{measure:target.id,beat:{...cue.at.beat}},from:undefined});
  }
  return {copies:out,skipped};
}
/** The action moved to another bar, keeping its place in the bar, or null if that place isn't in the new bar. */
export function moveCue(cue,measure){
  if(beatValue(cue.at)>=measure.beats.length)return null;
  return {...clone(cue),at:{measure:measure.id,beat:{...cue.at.beat}}};
}
/** Which key leaves or switches to a region: an explicit choice, default by its kind. */
export const loopKey=region=>region.family==='section'?'R':'L';
