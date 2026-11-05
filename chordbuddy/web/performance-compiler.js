// Turns a saved performance and the song's musical grid into the path the music actually takes: an ordered list of segments, each a stretch of
// source frames with its own timed actions and the planned state at its start. The same source bar can appear many times; each appearance is
// its own segment with its own identity, so "bar 9 on pass 3" is never confused with "bar 9 on pass 1".
// Half-open ranges [start, end). Addresses become integer frames here and nowhere else. Pure.
import {applyToState,checkAction,emptyState,isOneShot,writesOf} from './performance-actions.js';
import {LIVE_BUDGET,beatValue} from './performance-model.js';
import {secondsAtAddress} from './musical-grid.js';

export const RATE=44100;
const MAX_SEGMENTS=20000;

const frame=seconds=>Math.round(seconds*RATE);

/** A short identity for the grid: when it changes, saved addresses need a look. */
export function gridFingerprint(measures){
  let h=2166136261;
  for(const m of measures||[]){
    const text=`${m.id}:${frame(m.start)}:${frame(m.end)}:${m.beats?.length??0};`;
    for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  }
  return (h>>>0).toString(16).padStart(8,'0');
}

/** Frames of an address, or null when the bar is gone or the beat isn't in it. */
export function addressFrame(measures,at){
  if(!at||!at.beat||!Number.isFinite(at.beat.n)||!Number.isFinite(at.beat.d)||at.beat.d<=0)return null;
  try{return frame(secondsAtAddress(measures,{measure_id:at.measure,beat:beatValue(at)}));}catch{return null;}
}
const position=measures=>at=>{const f=addressFrame(measures,at);return f===null?NaN:f;};
export const addressPosition=position;
/** Whether an address falls exactly on a barline. */
export function onBarline(measures,at){
  const m=measures.find(x=>x.id===at?.measure);if(!m)return false;
  const v=beatValue(at);return v===0||v===m.beats.length;
}
/** Beat counts from a start bar that end on a barline: what a beat-length repeat may be. A beat length that lands inside a bar has no exit. */
export function validBeatLengths(measures,startMeasure,limit=64){
  const i=measures.findIndex(m=>m.id===startMeasure),out=[];let beats=0;
  if(i<0)return out;
  for(let k=i;k<measures.length&&beats<limit;k++){beats+=measures[k].beats.length;if(beats<=limit)out.push(beats);}
  return out;
}
/** The address `beats` beats after the start of a bar, or an error saying which lengths work. */
export function endForBeats(measures,startMeasure,beats){
  const valid=validBeatLengths(measures,startMeasure,Math.max(beats,64));
  if(!valid.includes(beats)){const near=validBeatLengths(measures,startMeasure,64).slice(0,6).join(', ');return {error:`This beat length ends inside a bar. Try ${near} beats.`};}
  const i=measures.findIndex(m=>m.id===startMeasure);let left=beats,k=i;
  while(left>0){left-=measures[k].beats.length;k++;}
  return {end:k<measures.length?{measure:measures[k].id,beat:{n:0,d:1}}:{measure:measures.at(-1).id,beat:{n:measures.at(-1).beats.length,d:1}}};
}

const issue=(list,code,message,ref=null)=>list.push({code,message,ref});

function checkCue(cue,measures,errors,where){
  const problem=checkAction(cue.action);
  if(problem)issue(errors,'action',`${where}: ${problem}`,cue.id);
  if(addressFrame(measures,cue.at)===null)issue(errors,'anchor',`${where}: its bar is no longer in the song. Choose a new place for it.`,cue.id);
}

function resolveRegions(performance,measures,errors){
  const out=[];
  for(const region of performance.regions){
    const start=addressFrame(measures,region.start),end=addressFrame(measures,region.end);
    if(start===null||end===null){issue(errors,'anchor','A repeat’s bars are no longer in the song. Choose its range again.',region.id);continue;}
    if(end<=start){issue(errors,'range','A repeat must end after it starts.',region.id);continue;}
    if(!onBarline(measures,region.start)||!onBarline(measures,region.end)){issue(errors,'barline','A repeat must start and end on a barline, because leaving it is a jump.',region.id);continue;}
    if(region.plays!=='live'&&!(Number.isInteger(region.plays)&&region.plays>=1)){issue(errors,'plays','Choose how many times this repeat plays.',region.id);continue;}
    out.push({region,start,end});
  }
  out.sort((a,b)=>a.start-b.start);
  for(let i=1;i<out.length;i++)if(out[i].start<out[i-1].end)issue(errors,'overlap','Two repeats overlap. Repeats can follow each other, but not sit inside one another yet.',out[i].region.id);
  return out;
}

/** The order of a list of compiled actions at one place: entry state first, then by explicit order, then as listed. */
function sortActions(list){return list.map((a,i)=>[a,i]).sort(([a,i],[b,j])=>a.frame-b.frame||(a.rank-b.rank)||(a.order??0)-(b.order??0)||i-j).map(([a])=>a);}

function cueApplies(cue,{passId,visit}){
  const when=cue.when;
  if(cue.enabled===false)return false;
  if(!when||when.every)return true;
  if(when.first)return visit===1;
  if(when.passes)return when.passes.includes(passId);
  return true;
}
function compileCue(cue,measures,rank=1){
  return {id:cue.id,frame:addressFrame(measures,cue.at),action:cue.action,order:cue.order,rank,leadMs:cue.leadMs??0,oneShot:isOneShot(cue.action)};
}

function conflicts(actions,errors,segmentKey){
  const seen=new Map();
  for(const a of actions){
    if(a.rank===0)continue;                     // a pass's entry state is meant to be replaced by a cue on the same spot
    for(const [property] of writesOf(a.action)){
      const key=`${a.frame}|${property}`,other=seen.get(key);
      if(other&&!(Number.isFinite(a.order)&&Number.isFinite(other.order)&&a.order!==other.order))issue(errors,'conflict','Two actions set the same thing at the same moment. Move one, or put them in order.',a.id);
      seen.set(key,a);
    }
  }
}

/** One pass of a region as a segment. */
function passSegment({performance,measures,span,pass,index,visit,live,further=false,errors}){
  const {region,start,end}=span;
  const source=pass.program||performance.cues;
  const inside=source.filter(c=>{const f=addressFrame(measures,c.at);return f!==null&&f>=start&&f<end;});
  const actions=[];
  for(const a of pass.entry||[])actions.push({id:`${pass.id||'further'}:entry:${actions.length}`,frame:start,action:a,rank:0,leadMs:0,oneShot:isOneShot(a)});
  for(const c of inside)if(cueApplies(c,{passId:pass.id,visit}))actions.push(compileCue(c,measures));
  const sorted=sortActions(actions);
  if(errors)conflicts(sorted,errors,region.id);
  return {kind:'music',key:`${region.id}/${further?`further-${index}`:pass.id}/${visit}`,start,end,regionId:region.id,passId:further?null:pass.id,passIndex:index,visit,live,family:region.family,further,actions:sorted};
}

function plainSegment({measures,performance,start,end,visits,errors}){
  const actions=[];
  for(const c of performance.cues){
    const f=addressFrame(measures,c.at);
    if(f!==null&&f>=start&&f<end&&cueApplies(c,{passId:null,visit:(visits.get(`${start}`)||0)+1}))actions.push(compileCue(c,measures));
  }
  visits.set(`${start}`,(visits.get(`${start}`)||0)+1);
  const sorted=sortActions(actions);
  conflicts(sorted,errors,'song');
  return {kind:'music',key:`song/${start}/${visits.get(`${start}`)}`,start,end,regionId:null,passId:null,passIndex:null,visit:visits.get(`${start}`),live:false,family:null,further:false,actions:sorted};
}

/** Adds the planned state at each segment's start, walking the path in order. */
export function attachStates(segments,initial=emptyState()){
  let state=initial;
  for(const segment of segments){
    segment.state=state;
    for(const a of segment.actions||[])if(!a.oneShot)state=applyToState(state,a.action);
  }
  return state;
}

/**
 * performance: as saved; grid: {measures, frames (the song's length)}.
 * Returns {ok, errors, warnings, needsReview, segments, initialState, requiresLiveControl, unknownWait, fingerprint, frames}.
 * Errors stop a performance from running; each says what to do.
 */
export function compilePerformance(performance,{measures,frames}){
  const errors=[],warnings=[];
  if(!measures?.length||!Number.isSafeInteger(frames)||frames<=0)return {ok:false,errors:[{code:'grid',message:'This song has no musical grid yet. Analyze it first.',ref:null}],warnings,needsReview:false,segments:[],initialState:emptyState(),requiresLiveControl:false,unknownWait:false,fingerprint:null,frames:frames||0};
  const fingerprint=gridFingerprint(measures);
  const moved=!!performance.grid&&performance.grid!==fingerprint;
  for(const c of performance.cues)checkCue(c,measures,errors,'An action');
  for(const a of performance.initial){const p=checkAction(a);if(p)issue(errors,'action',`A starting setting: ${p}`);}
  for(const r of performance.regions){
    for(const p of [...r.passes,r.further]){
      for(const c of p?.program||[])checkCue(c,measures,errors,'An action in a pass');
      for(const a of p?.entry||[]){const x=checkAction(a);if(x)issue(errors,'action',`A pass’s starting setting: ${x}`,r.id);}
    }
    for(const a of r.onExit||[]){const x=checkAction(a);if(x)issue(errors,'action',`An exit action: ${x}`,r.id);}
  }
  const spans=resolveRegions(performance,measures,errors);
  const atFrame=new Map();                       // source frame -> what happens when the music reaches it
  const add=(f,item)=>{if(!atFrame.has(f))atFrame.set(f,[]);atFrame.get(f).push(item);};
  for(const span of spans)add(span.start,{type:'region',span});
  for(const jump of performance.jumps||[]){
    const at=addressFrame(measures,jump.at),to=addressFrame(measures,jump.to);
    if(at===null||to===null){issue(errors,'anchor','A jump’s bars are no longer in the song. Choose them again.',jump.id);continue;}
    if(!onBarline(measures,jump.at)||!onBarline(measures,jump.to)){issue(errors,'barline','A jump must leave and land on a barline.',jump.id);continue;}
    if(!(Number.isInteger(jump.times)&&jump.times>=1)){issue(errors,'cycle','A jump needs a set number of times, or it could never finish.',jump.id);continue;}
    if(spans.some(s=>(at>s.start&&at<s.end)||(to>s.start&&to<s.end))){issue(errors,'overlap','A jump can’t leave or land in the middle of a repeat.',jump.id);continue;}
    add(at,{type:'jump',jump,to});
  }
  for(const hold of performance.holds||[]){
    const at=addressFrame(measures,hold.at);
    if(at===null){issue(errors,'anchor','A hold’s bar is no longer in the song. Choose it again.',hold.id);continue;}
    if(!onBarline(measures,hold.at)){issue(errors,'barline','A hold must fall on a barline.',hold.id);continue;}
    if(hold.seconds!==null&&!(Number.isFinite(hold.seconds)&&hold.seconds>0)){issue(errors,'hold','A hold needs a length, or to wait for a control.',hold.id);continue;}
    add(at,{type:'hold',hold});
  }
  const stops=[...atFrame.keys()].sort((a,b)=>a-b);
  const segments=[],visits=new Map(),jumpsUsed=new Map(),regionVisits=new Map(),holdsDone=new Set();
  let pos=0,requiresLiveControl=false,unknownWait=false,guard=0;
  while(pos<frames){
    if(++guard>MAX_SEGMENTS){issue(errors,'cycle','These jumps would go round too many times to finish. Lower how many times they repeat.');break;}
    const here=atFrame.get(pos)||[];
    let jumped=false;
    for(const item of here){
      if(item.type==='hold'&&!holdsDone.has(item.hold.id)){
        holdsDone.add(item.hold.id);
        const control=item.hold.seconds===null;
        if(control){requiresLiveControl=true;if(!Number.isFinite(item.hold.expected))unknownWait=true;}
        segments.push({kind:'hold',key:`hold/${item.hold.id}`,id:item.hold.id,seconds:control?null:item.hold.seconds,expected:control?item.hold.expected??null:null,actions:[]});
      }
      if(item.type==='jump'){
        const used=jumpsUsed.get(item.jump.id)||0;
        if(used<item.jump.times){jumpsUsed.set(item.jump.id,used+1);pos=item.to;jumped=true;break;}
      }
    }
    if(jumped)continue;
    const regionItem=here.find(i=>i.type==='region');
    if(regionItem){
      const {span}=regionItem,{region}=span,visit=(regionVisits.get(region.id)||0)+1;regionVisits.set(region.id,visit);
      const live=region.plays==='live';
      if(live)requiresLiveControl=true;
      const count=live?Math.max(LIVE_BUDGET,region.passes.length):region.plays;
      region.passes.slice(0,count).forEach((pass,index)=>segments.push(passSegment({performance,measures,span,pass,index,visit,live,errors})));
      if(region.onExit?.length){
        segments.at(-1).onExit=region.onExit.map((a,i)=>({id:`${region.id}:exit:${i}`,frame:span.end,action:a,rank:2,leadMs:0,oneShot:isOneShot(a)}));
      }
      pos=span.end;continue;
    }
    const next=stops.find(f=>f>pos)??frames,end=Math.min(next,frames);
    segments.push(plainSegment({measures,performance,start:pos,end,visits,errors}));
    pos=end;
  }
  // onExit runs where the region ends, whatever comes next: fold it into the state walk by placing it on the following segment.
  segments.forEach((s,i)=>{if(s.onExit){const after=segments[i+1];if(after?.kind==='music')after.actions=[...s.onExit.map(a=>({...a,frame:after.start,rank:0})),...after.actions];}});
  const initialState=(performance.initial||[]).reduce(applyToState,emptyState());
  attachStates(segments,initialState);
  if(moved&&!errors.length)warnings.push({code:'moved',message:'The song’s bars changed since this performance was saved. Check that its actions are still in the right places.',ref:null});
  const needsReview=moved||errors.some(e=>e.code==='anchor');
  return {ok:!errors.length,errors,warnings,needsReview,segments,initialState,requiresLiveControl,unknownWait,fingerprint,frames};
}

/** A further pass of a released loop, past the planned ones. Called only when it actually starts. index: 0 for the first pass of the region. */
export function furtherPass(performance,{measures},regionId,index,visit){
  const region=performance.regions.find(r=>r.id===regionId);if(!region)return null;
  const start=addressFrame(measures,region.start),end=addressFrame(measures,region.end);
  const explicit=region.passes[index];
  const pass=explicit||region.further||{entry:[],program:null};
  const fallback=!explicit&&!pass.program&&!(pass.entry||[]).length?region.passes.at(-1):pass;
  return passSegment({performance,measures,span:{region,start,end},pass:fallback,index,visit,live:true,further:!explicit});
}
