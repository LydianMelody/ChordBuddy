// Runs one song's performance: decides what plays next, and tells the audio engine in advance. Pure: no DOM, clock or audio; everything comes
// in through tick() and the press functions, and goes out through the engine object and out().
//
// The path is a list: segments still to come, plus two markers that stay until something ends them. A 'loopback' marker repeats a live loop;
// a 'more' marker adds a further pass of an until-released region. Peeking the path says what follows the current segment, so changing your
// mind (exit, switch, jump) is only a change to the list. Until the boundary is close enough to commit, nothing has reached the engine.
//
// Time: `played` counts every frame rendered and never goes back, so "when" is always a played frame. Source frames say what is heard.
// engine: {jump({at,to}), mark(at), prepare(frame), schedule(atPlayed,payload,id), cancel(prefix), play(bool)}; jump and mark may answer at once or
// through the callback they are given; a late answer for an old generation is ignored.
import {STEM_ROLES,applyToState,audibleGains,domainOfProperty,fadeMix,isOneShot,mixFromState,writesOf} from './performance-actions.js';
import {furtherPass} from './performance-compiler.js';
import {pathSeconds} from './performance-duration.js';

export const RATE=44100;
export const COMMIT_WINDOW=RATE*2;              // a boundary this close gets committed in the engine
export const PREPARE_WINDOW=RATE*10;            // a target this close gets its audio fetched
export const SCHEDULE_WINDOW=RATE*2;            // timed actions this close go to the engine
export const COMMIT_HORIZON=256;
const WAIT_MARGIN=Math.round(RATE*.15);
const RAMP_STEP=441;                            // a ramp is one small mixer step every 10 ms
const MAX_LOG=5000;
const MIX_ACTIONS=new Set(['track.set','master.set','mix.set']);

const clone=v=>structuredClone(v);

// ---- which bars a key loops
/** L: the four bars (or `count`) around the playhead, counted from the section's first bar; real measures, across a section edge if it must, and the last
 *  ones at the end of the song. Fewer only when the song itself has fewer. */
export function fourBarRange(measures,sections,frame,count=4){
  const seconds=frame/RATE,at=measures.findIndex(m=>seconds>=m.start&&seconds<m.end);
  const here=at<0?measures.length-1:at;
  const section=(sections||[]).find(s=>seconds>=s.start&&seconds<s.end);
  const first=section?Math.max(0,measures.findIndex(m=>m.end>section.start+.05)):0;
  const inSection=Math.max(0,here-first);
  let start=first+inSection-inSection%count;
  if(start+count>measures.length)start=Math.max(0,measures.length-count);
  const bars=measures.slice(start,start+count);
  return {kind:'bars',start:Math.round(bars[0].start*RATE),end:Math.round(bars.at(-1).end*RATE),firstBar:bars[0].number,lastBar:bars.at(-1).number,short:bars.length<count,label:bars.length===1?`bar ${bars[0].number}`:`bars ${bars[0].number}–${bars.at(-1).number}`};
}
/** R: the section around the playhead, on barlines, leaving out a fade the caller's trim() found (shown in the label, never silently). */
export function sectionRange(measures,sections,frame,{trim=null}={}){
  const seconds=frame/RATE,section=(sections||[]).find(s=>seconds>=s.start&&seconds<s.end);
  if(!section)return null;
  const trimmed=trim?trim(section):null,want=trimmed||{start:section.start,end:section.end};
  const nearest=t=>measures.reduce((best,m)=>Math.abs(m.start-t)<Math.abs(best.start-t)?m:best,measures[0]);
  const first=nearest(want.start);
  const atEnd=Math.abs(measures.at(-1).end-want.end)<Math.abs(nearest(want.end).start-want.end);
  const afterIndex=atEnd?measures.length:measures.indexOf(nearest(want.end));
  const last=measures[Math.max(measures.indexOf(first),afterIndex-1)];
  const faded=!!trimmed&&(trimmed.start!==section.start||trimmed.end!==section.end);
  const bars=first===last?`bar ${first.number}`:`bars ${first.number}–${last.number}`;
  return {kind:'section',name:section.name,start:Math.round(first.start*RATE),end:Math.round(last.end*RATE),firstBar:first.number,lastBar:last.number,faded,label:`${section.name} · ${bars}${faded?' (fade left out)':''}`};
}
/** The next barline a change can use: starts of bars after `frame`, plus the end of the song. */
/** A flag that starts a loop, as pressing L or R does. */
const startsLoop=action=>action?.type==='command'&&(action.command==='loop-bars'||action.command==='loop-section');
export function nextBarline(measures,frame){
  for(const m of measures){const f=Math.round(m.start*RATE);if(f>frame)return f;}
  const end=Math.round(measures.at(-1).end*RATE);
  return end>frame?end:null;
}
const barAt=(measures,frame)=>{const s=frame/RATE,i=measures.findIndex(m=>s>=m.start&&s<m.end);return i<0?(s>=measures.at(-1).end?measures.length-1:0):i;};

/** After the last planned pass of an until-released region, a marker that adds a further pass each time one actually begins. */
function withMoreMarkers(segments){
  const out=[];
  segments.forEach((s,i)=>{
    out.push({...s});
    const next=segments[i+1];
    if(s.kind==='music'&&s.live&&!(next?.regionId===s.regionId&&next?.visit===s.visit))out.push({kind:'more',regionId:s.regionId,index:s.passIndex+1,visit:s.visit});
  });
  return out;
}

// ---- the override policy
export function policyFor(policy,domain){return policy?.[domain]||policy?.all||'until-released';}

export class PerformanceRunner{
  constructor({performance,compiled,grid,engine,out=()=>{},policy=null,sections=[],baseMix,trim=null,runId='run',entryId='entry'}){
    Object.assign(this,{performance,compiled,grid,engine,out,policy:policy||{all:'until-released'},sections,baseMix,trim,runId,entryId});
    this.measures=grid.measures;
    this.path=withMoreMarkers(compiled.segments);
    this.status='armed';this.played=0;this.heard=0;this.source=0;this.current=null;this.boundary=null;this.generation=1;this.traversal=0;
    this.history=[];                            // segments as actually played, for capture and backward seeks
    this.overrides=new Map();                   // property -> {value, policy, section}
    this.planned=clone(compiled.initialState);  // what the program wants now, whatever the overrides say
    this.done=new Set();                        // one-shots already sent
    this.prepared=new Set();
    this.log=[];this.queuedActions=[];this.loop=null;this.pendingLoop=null;this.departure=null;this.pendingNav=null;this.playedSeconds=0;this.lastPlayedAt=0;this.rate=this.planned.rate??100;
    this.consumed=new Set();this.liveRate=false;this.currentSection=null;this.waiting=null;
  }

  // ---- logging and snapshots
  note(type,details={}){
    if(this.log.length>=MAX_LOG)this.log.splice(0,1000);
    this.log.push({type,played:this.played,source:this.source,run:this.runId,entry:this.entryId,occurrence:this.current?.key??null,traversal:this.traversal,...details});
  }
  /** What every view needs to show. */
  snapshot(){
    const s={status:this.status,played:this.played,source:this.heard,section:this.sectionAt(this.heard)?.name??null,bar:this.measures[barAt(this.measures,this.heard)]?.number??null,
      occurrence:this.current?{key:this.current.key,regionId:this.current.regionId,passId:this.current.passId,passIndex:this.current.passIndex,traversal:this.traversal}:null,
      loop:this.loopNow(),
      pending:this.pendingText(),waiting:this.waiting,holding:this.status==='holding'?{seconds:this.hold?.left??null,waiting:this.hold?.segment.seconds===null}:null,overrides:[...this.overrides.entries()].map(([property,o])=>({property,value:o.value,policy:o.policy})),rate:this.rate};
    return {...s,...this.durations()};
  }
  /** The loop going round now, as the pages show it: its bars (frames), how many times it has gone back, and how many plays it has in all (null: until you leave it). */
  loopNow(){return this.loop&&this.pendingLoop?.type!=='exit'?{kind:this.loop.kind,label:this.loop.label,start:this.loop.start,end:this.loop.end,pass:this.loop.pass,plays:this.loop.plays??null}:null;}
  /** What a page's loop count shows now: the bars going round (frames), the plays still to come counting this one (null: until you leave
   *  it; 1 once you've pressed to leave), and the planned loop's id when it's the plan going round. A live loop wins over the plan it replaced. */
  loopShown(){
    const leaving=this.pendingLoop?.type==='exit';
    if(this.loop){const l=this.loop;return {start:l.start,end:l.end,label:l.label,regionId:null,left:leaving||l.last?1:l.plays?Math.max(1,l.plays-l.pass):null};}
    const c=this.current;if(!c?.regionId)return null;
    const r=this.performance.regions?.find(x=>x.id===c.regionId),range=this.regionRange({regionId:c.regionId,visit:c.visit});
    return {start:range?.start??c.start,end:range?.end??c.end,label:range?.label??'',regionId:c.regionId,left:leaving?1:Number.isInteger(r?.plays)?Math.max(1,r.plays-(c.passIndex??0)):null};
  }
  pendingText(){
    if(this.pendingNav)return {type:'jump',target:this.pendingNav.target,bar:this.measures[barAt(this.measures,this.pendingNav.target)]?.number,boundary:this.boundary?.at??null};
    if(this.pendingLoop)return {type:this.pendingLoop.type,kind:this.pendingLoop.kind,label:this.pendingLoop.range?.label??null};
    return null;
  }
  /** Music left is the rest of this pass plus the path after it; it grows only when a further pass actually begins. */
  durations(){
    const items=this.path.filter(p=>p.kind==='music'||p.kind==='hold');
    const here=this.current?[this.current]:[];
    const list=[...here,...items];
    const r=pathSeconds(list,{index:0,frame:this.current?this.source:null,rate:this.rate,fixedRate:this.liveRate});
    return {musicLeft:r.music,plannedLeft:r.planned,estimated:r.estimated||!!this.loop||this.path.some(p=>p.kind==='loopback'||p.kind==='more'),unknownWait:r.unknown,musicPlayed:this.playedSeconds,totalMusic:this.playedSeconds+r.music};
  }
  sectionAt(frame){const t=frame/RATE;return this.sections.find(s=>t>=s.start&&t<s.end)||null;}

  // ---- start and report
  /** Begin at the start of the path. The engine is already primed at frame `from` with the first audio. */
  start(from=0){
    this.status='playing';this.source=from;this.heard=from;
    const first=this.peek();this.pop(first);
    this.advance(first,0,from,true);
    this.engine.play(true);
    this.applyWhole(0);
    return this;
  }
  /** Begin from a bar in the middle (a preview): with the plan as it stands there, and nothing before it played. */
  startAt(frame){
    this.status='playing';this.source=frame;this.heard=frame;
    const landing=this.findOccurrence(frame);
    this.path=landing.rest;
    this.advance(landing.segment,0,frame,true);
    this.engine.play(true);
    this.applyWhole(0);
    return this;
  }
  /** report: {played, source (next frame to render), heard (what is coming out of the speakers now), state ('playing','paused','buffering','ended')}. */
  tick(report){
    const before=this.played;
    this.played=report.played;this.source=report.source;this.heard=report.heard??report.source;
    const seconds=(this.played-before)/RATE;if(seconds>0)this.playedSeconds+=seconds;
    if(this.status==='finished'||this.status==='stopped')return;
    if(this.status==='holding'){this.tickHold(report);return;}
    if(report.state==='buffering'&&this.status==='playing'){this.status='buffering';this.note('buffering');}
    else if(report.state==='playing'&&this.status==='buffering'){this.status='playing';this.note('buffer-recovered');}
    this.crossBoundaries();
    this.settleIntent();
    this.releaseBySection();
    this.applyDue();
    this.prepareTargets();
    this.commitNext();
    this.scheduleWindow();
    this.scheduleGlides();
    if(report.state==='ended'&&!this.boundary&&!this.peek())this.finish();
  }
  /** A queued loop becomes the loop in force at its barline; a queued exit is over when the pass ends. Until then the same key takes it back. */
  settleIntent(){
    const p=this.pendingLoop;
    if(p?.settlesAt===undefined||this.played<p.settlesAt)return;
    if(p.type==='exit')this.loop=null;
    this.pendingLoop=null;
    this.note('loop-settled',{intent:p.type,kind:p.kind});
  }
  finish(){this.status='finished';this.note('finished');this.current=null;this.out({type:'finished'});}
  stop(){this.status='stopped';this.glides=[];this.engine.cancel('');this.engine.play(false);this.note('stopped');this.out({type:'cleanup'});}
  pause(){
    if(this.status==='holding'){this.holdPaused=true;if(this.hold)this.hold.last=null;this.note('paused');return;}   // a timed hold waits too
    if(this.status==='playing'||this.status==='buffering'){this.status='paused';this.engine.play(false);this.note('paused');}
  }
  resume(){
    if(this.status==='holding'){this.holdPaused=false;this.note('resumed');return;}
    if(this.status==='paused'){this.status='playing';this.engine.play(true);this.note('resumed');}
  }

  // ---- the path
  /** What follows the current segment. Markers stay in the path, so a loop repeats until something removes its marker. */
  peek(){
    const item=this.path[0];
    if(!item)return null;
    if(item.kind==='loopback')return this.loopSegment(item.loop);
    if(item.kind==='more')return this.morePass(item);
    return item;
  }
  pop(segment){
    const item=this.path[0];
    if(!item)return;
    // a loop with a number of plays lets go of its marker as its last time round begins, so the music carries on after it
    if(item.kind==='loopback'){if(segment.loopId===item.loop.id){item.loop.pass++;if(item.loop.plays&&item.loop.pass>=item.loop.plays-1){this.path.shift();item.loop.last=true;}}return;}
    if(item.kind==='more'){if(segment.regionId===item.regionId)item.index++;return;}
    if(item===segment||item.key===segment.key)this.path.shift();
  }
  morePass(item){
    const segment=furtherPass(this.performance,this.grid,item.regionId,item.index,item.visit);
    if(!segment)return null;
    // A further pass starts from what the plan says at that moment.
    segment.state=this.endStateOfCurrent();
    return segment;
  }
  /** A live loop's next pass: the same captured program, every time. */
  loopSegment(loop){
    const n=loop.pass+1;
    return {kind:'music',key:`live/${loop.id}/${n}`,start:loop.start,end:loop.end,regionId:null,passId:null,passIndex:n,visit:1,live:true,family:loop.kind,loopId:loop.id,replay:loop.id,state:loop.startState,actions:loop.program.filter(a=>!a.first&&!startsLoop(a.action)).map(a=>({...a,id:`${a.id}@${n}`}))};   // going round again is never "the first time"; and a loop flag inside the loop isn't pressed again each time round (it would leave the loop it started)
  }
  /** The plan when the current segment is over. */
  endStateOfCurrent(){
    let state=this.current?.state??this.planned;
    for(const a of this.current?.actions||[])if(!a.oneShot)state=applyToState(state,a.action);
    return state;
  }
  /** Where the audio goes when the current segment ends: {to, segment}, or null for the end of the song. */
  nextStep(){
    if(this.pendingNav){
      return {at:this.pendingNav.at,to:this.pendingNav.target,segment:this.pendingNav.segment,nav:this.pendingNav};
    }
    const next=this.peek();
    return next?{at:this.current?.end,to:next.kind==='hold'?this.current?.end:next.start,segment:next}:null;
  }
  commitNext(){
    if(!this.current||this.status==='paused')return;
    const step=this.nextStep();if(!step)return;
    const boundary=step.at??this.current.end;
    if(this.boundary&&this.boundary.at===boundary&&this.boundary.segment.key===step.segment.key)return;
    const until=this.current.startPlayed+(boundary-this.current.start)-this.played;
    if(until>COMMIT_WINDOW)return;
    // Going straight on needs no jump, unless a jump is already in the engine for this barline: then only another jump can replace it.
    const replaces=this.boundary?.at===boundary&&this.boundary.jumped;
    // One question at a time: the engine acts on every jump it is sent, so the same request is never sent twice while its answer is on the way.
    const asking=`${boundary}|${step.to}|${step.segment.key}`;
    if(this.asking===asking)return;
    this.asking=asking;
    const generation=++this.generation,contiguous=step.to===boundary&&!replaces;
    const answer=result=>{if(this.asking===asking)this.asking=null;this.answered(result,{step,boundary,generation});};
    if(contiguous)this.engine.mark(boundary,answer,generation);else this.engine.jump({generation,at:boundary,to:step.to},answer);
  }
  answered(result,{step,boundary,generation}){
    if(generation!==this.generation||!result)return;
    if(result.status==='committed'){
      if(this.boundary)this.withdrawFrom(Math.min(this.boundary.atPlayed,result.atPlayed));
      this.boundary={at:boundary,atPlayed:result.atPlayed,segment:step.segment,nav:step.nav||null,jumped:step.to!==boundary};
      this.waiting=null;
      this.prepareBoundary(this.boundary);
      this.note('boundary',{at:boundary,to:step.to,atPlayed:result.atPlayed,key:step.segment.key});
      return;
    }
    if(result.status==='waiting'){
      this.waiting={at:boundary,target:step.to};this.note('waiting-audio',{at:boundary,target:step.to});
      // what was fetched ahead for it may have been dropped to make room: ask again, about once a second while it waits
      if(this.refetch?.target!==step.to||this.played-this.refetch.at>RATE){this.refetch={target:step.to,at:this.played};this.engine.prepare(step.to);}
      // Audio is usually a moment away: keep asking on each report, and give up on this barline only when it is nearly here.
      if(this.current.startPlayed+(boundary-this.current.start)-this.played<WAIT_MARGIN)this.moveBoundaryLater(step,boundary);
      return;
    }
    if(result.status==='missed'){this.note('missed-boundary',{at:boundary});this.moveBoundaryLater(step,boundary);return;}
    // 'later': the boundary isn't queued yet; the next tick asks again.
  }
  /** Too late, or the audio isn't here: the music carries on, and the change waits for the next barline. Never late, in the middle of a bar. */
  moveBoundaryLater(step,boundary){
    if(this.pendingNav&&step.nav){
      const later=nextBarline(this.measures,Math.max(boundary,this.source));
      if(later!==null)this.pendingNav.at=later;
      if(this.current&&later>this.current.end)this.current={...this.current,end:later};
      return;
    }
    if(!this.current)return;
    if(this.boundary&&this.boundary.at===boundary)return;   // the earlier commit stands, and this change takes the next one
    const later=nextBarline(this.measures,Math.max(boundary,this.source));
    if(later!==null)this.current={...this.current,end:later};
  }
  /** A new decision replaced what was queued from this output frame on: take back what hasn't happened. */
  withdrawFrom(atPlayed){
    this.engine.cancelFrom(atPlayed);
    this.queuedActions=this.queuedActions.filter(q=>{if(q.at<atPlayed)return true;this.sentKeys?.delete(q.key);if(q.action.oneShot)this.done.delete(`${this.runId}|${this.entryId}|${q.key}`);return false;});
    this.pendingWrites=(this.pendingWrites||[]).filter(w=>w.at<atPlayed);
    this.glides=(this.glides||[]).filter(g=>g.start<atPlayed);for(const g of this.glides)g.next=Math.min(g.next,atPlayed);
    this.out({type:'withdrawn',atPlayed});
  }
  prepareTargets(){
    if(!this.current)return;
    const left=this.current.end-this.source;
    const step=this.nextStep();
    const want=[];
    if(left<PREPARE_WINDOW&&step)want.push(step.to);
    if(this.path[0]?.kind==='loopback'||this.path[0]?.kind==='more'||this.current.live)want.push(this.current.end);   // leaving is always possible
    for(const frame of want)if(Number.isSafeInteger(frame)&&!this.prepared.has(frame)){this.prepared.add(frame);this.engine.prepare(frame);}
  }
  crossBoundaries(){
    while(this.boundary&&this.played>=this.boundary.atPlayed){
      const b=this.boundary;this.boundary=null;
      this.applyDue(b.atPlayed-1);
      if(b.nav){this.commitNavigation(b);continue;}
      this.pop(b.segment);
      this.advance(b.segment,b.atPlayed,b.segment.start,b.jumped);
    }
    // the end of the song, with nothing after it: the engine reports 'ended'.
  }
  advance(segment,atPlayed,from,restart=false){
    if(!segment)return;
    if(this.loop?.last&&segment.loopId!==this.loop.id){this.note('loop-played-out',{kind:this.loop.kind,plays:this.loop.plays});this.loop=null;}   // its plays are done: the music has moved on
    const d=this.departure;
    if(d){d.fresh=false;if(!(segment.loopId&&segment.loopId===d.loopId)&&!(segment.regionId===d.regionId&&segment.visit===d.visit)&&this.loop?.id!==d.loopId)this.departure=null;}   // a planned loop you left behind: the music moved on
    if(segment.kind==='hold'){this.beginHold(segment);return;}
    if(restart&&segment.state){this.planned=clone(segment.state);this.pendingWrites=[];}
    this.traversal++;
    if(this.current)this.history.push({key:this.current.key,start:this.current.start,end:this.current.end,regionId:this.current.regionId,passId:this.current.passId,passIndex:this.current.passIndex,actions:this.current.actions,state:this.current.state,visit:this.current.visit,live:this.current.live,family:this.current.family});
    this.current={...segment,start:from,startPlayed:atPlayed,sent:new Set()};
    this.prepared.delete(segment.start);
    this.out({type:'segment',atPlayed,key:segment.key,regionId:segment.regionId,passId:segment.passId,passIndex:segment.passIndex,traversal:this.traversal,start:from,end:segment.end,live:!!segment.live});
    if(segment.replay)this.out({type:'loop-replay',atPlayed,loop:segment.replay,pass:segment.passIndex,start:segment.start,end:segment.end,state:this.withOverrides(segment.state)});
    if(segment.loopId&&this.pendingLoop?.type==='activate')this.pendingLoop=null;
    if(segment.loopId&&this.pendingLoop?.type==='switch'&&this.pendingLoop.loop?.id===segment.loopId)this.pendingLoop=null;
  }

  // ---- states and actions
  withOverrides(state){const out={...state};for(const [property,o] of this.overrides)out[property]=o.value;return out;}
  /** Sets everything at a boundary: the plan here, with live changes on top. */
  applyWhole(atPlayed){
    const state=this.withOverrides(this.current?.state??this.planned);
    this.planned=clone(this.current?.state??this.planned);
    this.engine.schedule(atPlayed,{kind:'mix',mix:mixFromState(state,this.baseMix)},`mix:${atPlayed}:whole`);
    if(state.rate!==undefined){this.engine.schedule(atPlayed,{kind:'rate',percent:state.rate},`rate:${atPlayed}`);this.rate=state.rate;}
    this.out({type:'state',atPlayed,state});
    this.queuedActions=[];
  }
  /** After a boundary is committed: a segment that isn't simply the next stretch of the same plan gets its state set there. */
  prepareBoundary(boundary){
    const seg=boundary.segment;
    // a move you made, or a live loop, leaves the planned path, and a fade that was under way ends where it stood
    if((boundary.nav||seg.loopId)&&this.glides?.length){this.glides=[];this.engine.cancelFrom(boundary.atPlayed);}
    if(seg.kind==='hold')this.engine.schedule(boundary.atPlayed,{kind:'hold'},`hold:${boundary.atPlayed}`);
    if(seg.kind==='music'&&(boundary.jumped||boundary.nav)&&seg.state)this.scheduleWhole(boundary.atPlayed,seg);
  }
  scheduleWhole(atPlayed,segment){
    const state=this.withOverrides(segment.state);
    this.engine.schedule(atPlayed,{kind:'mix',mix:mixFromState(state,this.baseMix)},`mix:${atPlayed}:whole`);
    if(state.rate!==undefined)this.engine.schedule(atPlayed,{kind:'rate',percent:state.rate},`rate:${atPlayed}`);
    this.out({type:'state',atPlayed,state});
  }
  scheduleWindow(){
    const list=[this.current,this.boundary?this.boundary.segment:null];
    list.forEach((segment,i)=>{
      if(!segment||segment.kind!=='music')return;
      for(const a of segment.actions||[]){
        const start=i===0?this.current.start:segment.start,end=i===0?this.current.end:segment.end;
        if(a.frame<start||a.frame>=end)continue;
        const at=(i===0?this.current.startPlayed+(a.frame-start):this.boundary.atPlayed+(a.frame-start));
        if(at>this.played+SCHEDULE_WINDOW)continue;
        const keyed=`${segment.key}|${a.id}|${i===0?this.traversal:this.traversal+1}`;
        const sent=this.sentKeys||(this.sentKeys=new Set());
        if(sent.has(keyed))continue;
        sent.add(keyed);
        this.queuedActions.push({at,action:a,key:keyed,segmentKey:segment.key,traversal:i===0?this.traversal:this.traversal+1});
        this.dispatch({at,action:a,key:keyed});
      }
    });
    this.queuedActions.sort((a,b)=>a.at-b.at);
  }
  /** Sends one timed action to where it runs, leaving out what a live change has taken over. */
  dispatch({at,action,key}){
    const type=action.action.type;
    if(type==='mix.glide'){this.beginGlide(at,action);return;}
    if(isOneShot(action.action)){
      const identity=`${this.runId}|${this.entryId}|${key}`;
      if(this.done.has(identity))return;
      this.done.add(identity);
      this.out({type:'oneshot',atPlayed:at,action:action.action,id:identity,leadMs:action.leadMs,frame:action.frame});   // frame: where in the song the flag sits
      return;
    }
    const suppressed=writesOf(action.action).filter(([p])=>this.isOverridden(p));
    for(const [property] of suppressed)this.note('suppressed',{property,cue:action.id});
    if(suppressed.length===writesOf(action.action).length&&suppressed.length){this.out({type:'suppressed',atPlayed:at,action:action.action});return;}
    if(MIX_ACTIONS.has(type)){this.scheduleMixChange(at,action);return;}
    if(type==='rate.set'){this.engine.schedule(at,{kind:'rate',percent:action.action.percent},`rate:${at}`);this.out({type:'rate',atPlayed:at,percent:action.action.percent});return;}
    this.out({type:type.startsWith('midi.')?'midi':'visual',atPlayed:at,action:action.action,id:key,leadMs:action.leadMs});
  }
  isOverridden(property){
    const o=this.overrides.get(property);
    if(!o)return false;
    if(o.policy==='next-cue')return false;      // the next planned write takes it back, when it runs
    return true;
  }
  /** A fade through to a planned mixer change. It moves how loud each track really is, so going in or out of a mute fades too; the change itself lands at its flag. */
  beginGlide(at,action){
    const {target,frames,skip=0}=action.action,before=this.withOverrides(this.plannedThrough(at));
    (this.glides||(this.glides=[])).push({id:action.id,start:at,end:at+frames,next:at,skip,target,from:mixFromState(before,this.baseMix)});
  }
  /** The steps of a fade go to the engine a little at a time, so a long one costs nothing, a jump can drop it, and a live change is heard in the steps still to come. */
  scheduleGlides(){
    if(!this.glides?.length)return;
    for(const g of this.glides){
      while(g.next<g.end&&g.next<=this.played+SCHEDULE_WINDOW){
        this.engine.schedule(g.next,{kind:'mix',mix:this.glideMix(g,g.next)},`mix:glide:${g.id}:${g.next}`);
        g.next+=RAMP_STEP;
      }
    }
    this.glides=this.glides.filter(g=>g.end>this.played);
  }
  /** The mixer partway through a fade: how loud each track really is by then. What you've changed by hand stays as you set it. */
  glideMix(g,at){
    const hand=[...this.overrides.keys()];
    const goal=mixFromState({...this.withOverrides(this.planned),...Object.fromEntries(writesOf(g.target)),...Object.fromEntries(hand.map(p=>[p,this.overrides.get(p).value]))},this.baseMix);
    const f=g.skip+(1-g.skip)*(at-g.start)/(g.end-g.start),mix=fadeMix(g.from,goal,f),after=audibleGains(goal);
    STEM_ROLES.forEach((role,i)=>{if(hand.some(p=>p.startsWith(`track.${role}.`)))mix.gains[i]=mix.mutes[i]||mix.solos.some(Boolean)?goal.gains[i]:after[i];});
    if(hand.includes('master'))mix.master=goal.master;
    return mix;
  }
  /** What the mixer should show at this output frame while a fade runs, or null when none is. */
  fadingMix(at){
    const g=(this.glides||[]).find(x=>x.start<=at&&at<x.end);
    return g?this.glideMix(g,at):null;
  }
  /** The mixer's setting for a planned change: the plan so far, with this change and any live changes on top. Steps for a ramp. */
  scheduleMixChange(at,action){
    const ramp=action.action.ramp||0;
    const before=this.plannedThrough(at);
    const after=applyToState(before,action.action);
    const ending=new Set(writesOf(action.action).map(([p])=>p).filter(p=>this.overrides.get(p)?.policy==='next-cue'));
    const live=state=>{const out={...state};for(const [p,o] of this.overrides)if(!ending.has(p))out[p]=o.value;return out;};
    if(ramp>0){
      const steps=Math.max(1,Math.round(ramp*RATE/RAMP_STEP));
      const from=mixFromState(this.withOverrides(before),this.baseMix),to=mixFromState(live(after),this.baseMix);
      for(let i=1;i<=steps;i++){
        const f=i/steps,mix=clone(to);
        mix.master=from.master+(to.master-from.master)*f;
        mix.gains=to.gains.map((g,k)=>from.gains[k]+(g-from.gains[k])*f);
        this.engine.schedule(at+i*RAMP_STEP-RAMP_STEP,{kind:'mix',mix},`mix:${at}:${action.id}:${i}`);
      }
    }else this.engine.schedule(at,{kind:'mix',mix:mixFromState(live(after),this.baseMix)},`mix:${at}:${action.id}`);
    this.pendingWrites=this.pendingWrites||[];
    this.pendingWrites.push({at,action:action.action});
  }
  /** The plan as it will stand at played frame `at`. */
  plannedThrough(at){
    let state=this.planned;
    for(const w of [...(this.pendingWrites||[])].sort((a,b)=>a.at-b.at))if(w.at<=at)state=applyToState(state,w.action);
    return state;
  }
  /** Timed actions whose moment has passed become part of the plan. */
  applyDue(limit=this.played){
    while(this.queuedActions.length&&this.queuedActions[0].at<=limit){
      const {action,at}=this.queuedActions.shift();
      if(action.oneShot)continue;
      for(const [property] of writesOf(action.action)){
        const o=this.overrides.get(property);
        if(o?.policy==='next-cue'){this.overrides.delete(property);this.note('override-ended',{property,reason:'next planned change'});}
      }
      this.planned=applyToState(this.planned,action.action);
      if(action.action.type==='rate.set'&&!this.isOverridden('rate'))this.rate=action.action.percent;
      this.pendingWrites=(this.pendingWrites||[]).filter(w=>!(w.at===at&&w.action===action.action));
      this.note('action',{cue:action.id,at});
    }
  }

  // ---- live changes
  /** A deliberate change by hand. Returns {accepted, reason?}. Locked domains refuse it, and say so; Emergency Stop and Pause are never locked. */
  setLive(property,value){
    const domain=domainOfProperty(property),policy=policyFor(this.policy,domain);
    if(policy==='locked'){this.note('input-locked',{property});return {accepted:false,reason:`${domain} controls are locked by this show’s settings`};}
    this.overrides.set(property,{value,policy,section:this.sectionAt(this.heard)?.id??null});
    this.note('override',{property,value,policy});
    this.pushEffective(property);
    return {accepted:true};
  }
  /** A change that isn't held: it shows now, and the next planned change replaces it. Taking it also gives up any hold on that property. */
  nudge(property,value){
    if(this.overrides.delete(property))this.out({type:'overrides',overrides:[...this.overrides.keys()]});
    this.note('nudge',{property,value});
    this.out({type:'live',atPlayed:this.played,property,value});
    return {accepted:true};
  }
  /** Back to the plan: one property, a whole domain, or everything. */
  release({property=null,domain=null}={}){
    const names=[...this.overrides.keys()].filter(p=>property?p===property:domain?domainOfProperty(p)===domain:true);
    for(const p of names){this.overrides.delete(p);this.note('override-released',{property:p});this.pushEffective(p);}
    return names;
  }
  /** Change the policy during a run. Live values stay, under the new policy, unless asked to resume the plan. */
  setPolicy(policy,{resume=false}={}){
    this.policy=policy;
    for(const [p,o] of this.overrides)o.policy=policyFor(policy,domainOfProperty(p));
    if(resume)this.release();
    this.note('policy',{policy});
  }
  pushEffective(property){
    const state=this.withOverrides(this.plannedThrough(this.played));
    const at=this.played;
    if(property==='master'||property.startsWith('track.')){
      this.engine.cancel('mix:');
      for(const g of this.glides||[])g.next=Math.max(g.start,Math.min(g.next,at));
      this.engine.schedule(at,{kind:'mix',mix:mixFromState(state,this.baseMix)},`mix:${at}:live`);
      // what was already on its way is sent again, now under this change
      const waiting=this.queuedActions.filter(q=>q.at>at&&MIX_ACTIONS.has(q.action.action.type));
      this.pendingWrites=(this.pendingWrites||[]).filter(w=>w.at<=at);
      for(const q of waiting){if(writesOf(q.action.action).every(([p])=>this.isOverridden(p)))continue;this.scheduleMixChange(q.at,q.action);}
    }else if(property==='rate'){
      const value=state.rate??100;this.rate=value;this.liveRate=this.overrides.has('rate');
      this.engine.cancel('rate:');this.engine.schedule(at,{kind:'rate',percent:value},`rate:${at}:live`);
    }else this.out({type:'live',atPlayed:at,property,value:state[property]??null});
    this.out({type:'overrides',overrides:[...this.overrides.keys()]});
  }
  releaseBySection(){
    const section=this.sectionAt(this.heard)?.id??null;
    if(section===this.currentSection)return;
    const had=this.currentSection!==null;this.currentSection=section;
    if(!had)return;
    for(const [p,o] of [...this.overrides])if(o.policy==='next-section'){this.overrides.delete(p);this.note('override-ended',{property:p,reason:'next section'});this.pushEffective(p);}
  }

  // ---- L and R
  /** The loop going on now: a live one, or the authored region of this pass. */
  activeLoop(){
    if(this.loop)return {live:true,kind:this.loop.kind};
    const c=this.current;
    if(c?.regionId)return {live:false,kind:c.family||'bars',regionId:c.regionId,visit:c.visit};
    return null;
  }
  rangeFor(kind,frame){
    return kind==='bars'?fourBarRange(this.measures,this.sections,frame,this.loopBars||4):sectionRange(this.measures,this.sections,frame,{trim:this.trim});
  }
  /** L (kind 'bars') or R (kind 'section'). See the table in the plan: same key leaves after this pass, other key switches after it. */
  /** plays: how many times the loop's music plays in all, counting the time through it you're in; none, until you leave it. */
  /** at: the song frame to measure the loop from. A flag gives its own place: when it runs, what's heard is still a moment before it, and a flag on bar 131's first beat would otherwise loop the four bars ending at 130. */
  pressLoop(kind,{bars=4,plays=null,at=null}={}){
    this.loopBars=bars;this.loopPlays=Number.isInteger(plays)&&plays>=2?plays:null;this.loopAt=Number.isFinite(at)?at:null;
    if(this.departure&&this.departure.key===kind)return this.stepDeparture();
    this.departure=null;                        // the other key: the usual rules from here
    if(this.pendingLoop&&this.pendingLoop.pressed===kind&&this.undoLoopIntent())return {type:'cancelled'};
    if(this.pendingLoop&&this.pendingLoop.pressed!==kind)this.undoLoopIntent();
    const active=this.activeLoop();
    if(!active)return this.queueActivate(kind);
    if(!active.live)return this.depart(kind,active);
    if(active.kind===kind)return this.queueExit(kind,active);
    return this.queueSwitch(kind,active);
  }
  // ---- leaving a planned loop: three presses of the same key, round and round.
  // R: loop the whole section instead (until you leave it); again: leave it after this pass (×1!!); again: back to the plan.
  // L: keep going round these same bars until you leave them (∞); again: leave after this pass; again: back to the plan.
  // An until-released plan is already ∞, so L goes straight to leaving it. "Back to the plan" is exact while you're still in the pass where you
  // first pressed; after that the loop has gone round, so it keeps the loop going instead (and L's loop takes the plan's count of plays again).
  /** Everything a press changes, so a later press can put it all back. */
  keep(){return {path:this.path.slice(),loop:this.loop,currentEnd:this.current?.end,consumed:new Set(this.consumed),pendingLoop:this.pendingLoop};}
  restore(k){
    this.path=k.path.slice();this.loop=k.loop;this.consumed=new Set(k.consumed);this.pendingLoop=k.pendingLoop;
    if(k.currentEnd!==undefined&&this.current)this.current={...this.current,end:k.currentEnd};
    this.note('loop-plan-back');this.recommit();
  }
  /** The bars of the planned loop going round now, as a range like L's. */
  regionRange(active){
    const spans=(this.compiled.segments||[]).filter(s=>s.regionId===active.regionId&&s.visit===active.visit);
    if(!spans.length)return null;
    const start=Math.min(...spans.map(s=>s.start)),end=Math.max(...spans.map(s=>s.end));
    const first=this.measures[barAt(this.measures,start)],last=this.measures[barAt(this.measures,end-1)];
    return {kind:'bars',start,end,firstBar:first.number,lastBar:last.number,label:first===last?`bar ${first.number}`:`bars ${first.number}–${last.number}`};
  }
  depart(kind,active){
    const plan=this.keep(),c=this.current,region=this.performance.regions?.find(r=>r.id===active.regionId);
    const planLeft=region&&Number.isInteger(region.plays)?Math.max(1,region.plays-(c?.passIndex??0)):null;
    const d={key:kind,plan,regionId:active.regionId,visit:active.visit,fresh:true,planLeft,step:'looping',loopId:null};
    let result;
    if(kind==='bars'&&planLeft===null){result=this.queueExit(kind,active);d.step='leaving';}   // already until released: L leaves it
    else{
      result=kind==='bars'?this.queueActivate(kind,this.regionRange(active)):this.queueActivate(kind);
      if(!result)return null;
      this.pendingLoop=null;                    // this loop is in force now: the next press of the key leaves it, and doesn't just take this one back
      d.loopId=this.loop?.id??null;
    }
    this.departure=d;
    return {...result,departed:true};
  }
  stepDeparture(){
    const d=this.departure;
    if(d.step==='looping'){
      d.step='leaving';
      if(d.fresh){this.restore(d.plan);return {...this.queueExit(d.key,this.activeLoop()),departed:true};}   // still the pass you pressed in: the plan's pass is the last
      if(this.pendingLoop)this.undoLoopIntent();
      return {...this.queueExit(d.key,{live:true,kind:this.loop?.kind??d.key}),departed:true};
    }
    // leaving, pressed again: the plan again
    this.departure=null;
    if(d.fresh){this.restore(d.plan);return {type:'resumed'};}
    this.undoLoopIntent();
    if(this.loop&&d.key==='bars'&&d.planLeft){
      this.loop.plays=d.planLeft;
      if(this.loop.pass>=this.loop.plays-1){this.path=this.path.filter(p=>p.kind!=='loopback');this.loop.last=true;}
      this.recommit();
    }
    return {type:'resumed'};
  }
  /** Leave whatever loop is on, whichever key it answers to. */
  pressExit(){
    this.departure=null;
    if(this.pendingLoop?.type==='exit'){this.undoLoopIntent();return {type:'cancelled'};}
    if(this.pendingLoop)this.undoLoopIntent();
    const active=this.activeLoop();
    return active?this.queueExit(active.kind,active):null;
  }
  /** Where a loop is measured from: a flag's own place once, else what's heard now. */
  takeLoopAt(){const at=this.loopAt??this.heard;this.loopAt=null;return at;}
  remember(type,kind,extra){this.pendingLoop={type,kind,pressed:kind,before:this.path.slice(),loopBefore:this.loop,...extra};this.noteIntent();return this.pendingLoop;}
  noteIntent(){this.note('loop-intent',{intent:this.pendingLoop?.type??null,kind:this.pendingLoop?.kind??null,label:this.pendingLoop?.range?.label??null});this.recommit();}
  undoLoopIntent(){
    const p=this.pendingLoop;if(!p)return false;
    this.path=p.before;this.loop=p.loopBefore;this.pendingLoop=null;
    if(p.currentEnd!==undefined&&this.current)this.current={...this.current,end:p.currentEnd};
    if(p.consumed)this.consumed=p.consumed;
    this.note('loop-intent-cancelled',{intent:p.type});this.recommit();
    return true;
  }
  /** The path changed: if the next boundary no longer matches, it gets committed again on the next tick (still in time, or the change waits). */
  recommit(){this.generation++;this.commitNext();}
  /** What's played so far, then what's still to come: the stretch of music around the playhead, however many planned segments it crosses. */
  capture(range){
    const before=[...this.history,this.current?{...this.current}:null].filter(Boolean);
    const slices=[];
    // backward from the playhead, while the frames run on from one another
    let want=range.start;
    const pieces=[];
    for(let i=before.length-1;i>=0;i--){
      const s=before[i];
      if(s.end<=range.start||s.start>=range.end)break;
      pieces.unshift(s);
      if(s.start<=want)break;
    }
    for(const s of pieces)slices.push(s);
    let reach=slices.at(-1)?.end??range.start;
    if(reach<range.end)for(const s of this.path){
      if(s.kind!=='music')break;
      if(s.start!==reach)break;
      slices.push(s);reach=s.end;
      if(reach>=range.end)break;
    }
    const program=[];let startState=null;
    for(const s of slices){
      if(!startState&&s.start<=range.start){
        startState=clone(s.state??this.planned);
        for(const a of s.actions||[])if(!a.oneShot&&a.frame<range.start)startState=applyToState(startState,a.action);
      }
      for(const a of s.actions||[])if(a.frame>=range.start&&a.frame<range.end)program.push({...a,id:`${s.key}|${a.id}`});
    }
    if(!startState)startState=clone(this.planned);
    want=null;
    return {program:program.sort((a,b)=>a.frame-b.frame),startState,slices:slices.map(s=>({key:s.key,start:Math.max(s.start,range.start),end:Math.min(s.end,range.end),passId:s.passId??null}))};
  }
  /** The plan after the loop's end, with the interrupted region's other passes gone: releasing a live loop never re-arms what it replaced. */
  tailAfter(range){
    const region=this.current?.regionId;
    if(region)this.consumed.add(`${region}/${this.current.visit}`);
    const rest=[];let reached=this.current&&this.current.end>=range.end&&this.current.start<=range.end?this.current:null;
    if(reached&&reached.end>range.end)rest.push({...reached,key:`${reached.key}/tail`,start:range.end,regionId:null,passId:null,live:false,actions:(reached.actions||[]).filter(a=>a.frame>=range.end),state:null});
    let source=reached?reached.end:range.end;
    for(const item of this.path){
      if(item.kind==='loopback'||item.kind==='more')continue;
      if(item.kind==='hold'){rest.push(item);continue;}
      if(region&&item.regionId===region&&item.visit===this.current.visit)continue;
      if(item.end<=range.end&&item.start>=(this.current?.start??0)&&!reached){continue;}
      if(item.start<range.end&&item.end>range.end){rest.push({...item,key:`${item.key}/tail`,start:range.end,actions:(item.actions||[]).filter(a=>a.frame>=range.end)});reached=item;source=item.end;continue;}
      if(item.start>=range.end||reached)rest.push(item);
    }
    void source;
    return rest;
  }
  makeLoop(kind,range){
    const captured=this.capture(range);
    return {id:`${this.traversal}-${kind}-${range.start}`,kind,label:range.label,start:range.start,end:range.end,range,pass:0,plays:this.loopPlays??null,...captured};
  }
  queueActivate(kind,given=null){
    const at=this.takeLoopAt(),range=given||this.rangeFor(kind,at);
    if(!range)return null;
    const loop=this.makeLoop(kind,range);
    const before=this.path.slice(),loopBefore=this.loop,currentEnd=this.current?.end,consumed=new Set(this.consumed);
    const tail=this.tailAfter(range);
    const through=[];
    let reach=this.current?Math.min(this.current.end,range.end):range.end;
    const region=this.current?.regionId,visit=this.current?.visit;   // the planned loop's own further passes aren't the music after it
    if(reach<range.end)for(const s of this.path){if(region&&s.regionId===region&&s.visit===visit)continue;if(s.kind==='more'&&s.regionId===region)continue;if(s.kind!=='music'||s.start!==reach)break;through.push(s.end>range.end?{...s,end:range.end}:s);reach=Math.min(s.end,range.end);if(reach>=range.end)break;}
    if(this.current&&this.current.end>range.end)this.current={...this.current,end:range.end};
    this.path=[...through,{kind:'loopback',loop},...tail];
    this.loop=loop;
    const bar=nextBarline(this.measures,this.source);
    this.pendingLoop={type:'activate',kind,pressed:kind,range,before,loopBefore,currentEnd,consumed,settlesAt:bar===null?undefined:this.played+(Math.min(bar,range.end)-this.source)};
    this.noteIntent();
    return {type:'activate',kind,label:range.label,boundary:range.end};
  }
  queueExit(kind,active){
    const before=this.path.slice(),loopBefore=this.loop;
    if(this.current?.regionId&&active.live===false)this.consumed.add(`${active.regionId}/${active.visit}`);
    if(active.live)this.path=this.path.filter(p=>p.kind!=='loopback');
    else this.path=this.path.filter(p=>!(p.kind==='more'&&p.regionId===active.regionId)&&!(p.regionId===active.regionId&&p.visit===active.visit));
    this.pendingLoop={type:'exit',kind,pressed:kind,before,loopBefore,settlesAt:this.current?this.current.startPlayed+(this.current.end-this.current.start):undefined};
    this.noteIntent();
    return {type:'exit',kind,boundary:this.current?.end};
  }
  queueSwitch(kind,active){
    const range=this.rangeFor(kind,this.takeLoopAt());
    if(!range)return null;
    const before=this.path.slice(),loopBefore=this.loop;
    const loop=this.makeLoop(kind,range);
    if(!active.live)this.consumed.add(`${active.regionId}/${active.visit}`);
    const remaining=this.path.filter(p=>p.kind!=='loopback'&&p.kind!=='more'&&!(active.regionId&&p.regionId===active.regionId&&p.visit===active.visit));
    const tail=remaining.flatMap(item=>{
      if(item.kind!=='music')return [item];
      if(item.end<=range.end&&item.end>range.start)return [];
      if(item.start<range.end&&item.end>range.end)return [{...item,key:`${item.key}/tail`,start:range.end,actions:(item.actions||[]).filter(a=>a.frame>=range.end)}];
      return [item];
    });
    this.path=[{kind:'loopback',loop},...tail];
    this.loop=loop;
    this.pendingLoop={type:'switch',kind,pressed:kind,range,loop,before,loopBefore};
    this.noteIntent();
    return {type:'switch',kind,label:range.label,boundary:this.current?.end};
  }

  // ---- navigation
  /** Step the queued target by bars (or section starts), or the playhead when nothing is queued. */
  /** Where the next arrow press counts from: the jump already queued, or, just after one lands (before it's heard), where it went. */
  navFrom(){
    if(this.pendingNav)return this.pendingNav.target;
    if(this.landedAt!==undefined&&this.played-this.landedAt<RATE/2)return this.barStartAt(this.source);
    return this.barStartAt(this.heard);
  }
  stepBars(direction){
    const from=this.navFrom();
    const i=this.measures.findIndex(m=>Math.round(m.start*RATE)===from);
    const next=this.measures[Math.max(0,Math.min(this.measures.length-1,i+direction))];
    return this.navigate(Math.round(next.start*RATE));
  }
  stepSections(direction){
    const starts=this.sections.map(s=>this.barStartAt(Math.round(s.start*RATE)));
    const from=this.navFrom();
    const list=direction>0?starts.filter(f=>f>from):starts.filter(f=>f<from).reverse();
    return list.length?this.navigate(list[0]):null;
  }
  barStartAt(frame){return Math.round(this.measures[barAt(this.measures,frame)].start*RATE);}
  /** Jump to the bar holding `frame`, at the next barline that can make it. The latest request replaces the one before. Paused: it moves now. */
  navigate(frame){
    const target=this.barStartAt(frame);
    const landing=this.findOccurrence(target);
    if(this.status==='paused')return this.jumpWhilePaused(target,landing);
    let at=nextBarline(this.measures,this.source+COMMIT_HORIZON);
    // a jump already in the engine for a coming barline: this press changes where that one goes, rather than adding another a bar later
    if(this.boundary?.nav&&this.boundary.at>this.source&&(at===null||this.boundary.at<at))at=this.boundary.at;
    if(at===null)return null;
    this.pendingNav={target,at,segment:landing.segment,rest:landing.rest};
    if(this.current&&at>this.current.end)this.current={...this.current,end:at};
    this.note('jump-queued',{target,at});
    this.prepared.add(target);this.engine.prepare(target);   // always asked for again: the player keeps only a few seconds fetched ahead, so audio asked for earlier may be gone
    this.generation++;
    this.commitNext();
    return {type:'jump',target,boundary:this.pendingNav?.at??at};
  }
  /** Take back a queued jump. If it already reached the engine, the music is sent on to where it was going anyway, at the same barline. */
  cancelNavigation(){
    if(!this.pendingNav)return false;
    const committed=this.boundary?.nav?this.boundary:null;
    this.note('jump-cancelled');
    if(!committed){this.pendingNav=null;this.generation++;this.commitNext();return true;}
    const landing=this.findOccurrence(committed.at);
    this.pendingNav={target:committed.at,at:committed.at,segment:landing.segment,rest:landing.rest,cancels:true};
    if(!this.prepared.has(committed.at)){this.prepared.add(committed.at);this.engine.prepare(committed.at);}
    this.generation++;this.commitNext();
    return true;
  }
  /** Which authored visit a jump lands in: the next one coming, else the one most recently played, else the first in the plan. */
  findOccurrence(frame){
    const inside=s=>s.kind==='music'&&s.start<=frame&&frame<s.end;
    const ahead=this.path.findIndex(inside);
    const make=(segment,rest)=>{
      const state=clone(segment.state??this.planned);
      let at=state;for(const a of segment.actions||[])if(!a.oneShot&&a.frame<frame)at=applyToState(at,a.action);
      // landing in the middle of a fade: the rest of it still runs
      const inFade=(segment.actions||[]).filter(a=>a.glide&&a.frame<frame&&a.frame+a.action.frames>frame).map(a=>({...a,frame,action:{...a.action,frames:a.frame+a.action.frames-frame,skip:(frame-a.frame)/a.action.frames}}));
      return {segment:{...segment,start:frame,state:at,actions:[...inFade,...(segment.actions||[]).filter(a=>a.frame>=frame)],key:`${segment.key}/at${frame}`},rest};
    };
    const planned=list=>list.filter(p=>p.kind!=='loopback');
    if(this.current&&inside(this.current)&&!this.current.loopId)return make(this.current,planned(this.path));
    if(ahead>=0)return make(this.path[ahead],planned(this.path.slice(ahead+1)));
    const back=this.compiled.segments.findLastIndex(s=>{
      if(!inside(s))return false;
      return this.history.some(h=>h.key===s.key);
    });
    const first=back>=0?back:this.compiled.segments.findIndex(inside);
    if(first<0){const whole={kind:'music',key:`song/${frame}`,start:frame,end:this.grid.frames,actions:[],state:this.planned};return make(whole,[]);}
    const rest=this.compiled.segments.slice(first+1).filter(s=>!(s.regionId&&this.consumed.has(`${s.regionId}/${s.visit}`)));
    return make(this.compiled.segments[first],rest.map(s=>({...s})));
  }
  /** Nothing is moving, so there is no barline to wait for: the music is simply at the new bar when it resumes. */
  jumpWhilePaused(target,landing){
    this.engine.jumpNow({to:target},result=>{
      if(result?.status!=='committed'){this.waiting={at:null,target};this.note('waiting-audio',{target});return;}
      this.waiting=null;
      this.withdrawFrom(this.played);this.boundary=null;this.pendingNav=null;this.pendingLoop=null;this.loop=null;this.departure=null;
      this.path=landing.rest;
      this.advance(landing.segment,this.played,target,true);
      this.applyWhole(this.played);
      this.source=target;this.heard=target;
      this.note('jump-committed',{target,paused:true});
    });
    return {type:'jump',target,boundary:null};
  }
  commitNavigation(boundary){
    const nav=boundary.nav;
    // only the jump that landed is done: a press since then queued a newer one, which still goes at its own barline
    const newer=this.pendingNav&&this.pendingNav!==nav?this.pendingNav:null;
    this.pendingNav=newer;this.pendingLoop=null;this.landedAt=boundary.atPlayed;
    if(this.loop){this.loop=null;}
    this.departure=null;
    this.path=nav.rest;
    this.advance(nav.segment,boundary.atPlayed,nav.segment.start,true);
    // its barline was counted where the music was before this jump: it goes at the first barline after where the music landed
    if(newer){const later=nextBarline(this.measures,nav.target+COMMIT_HORIZON);if(later===null)this.pendingNav=null;else newer.at=later;}
    if(this.pendingNav&&this.current&&this.pendingNav.at>this.current.end)this.current={...this.current,end:this.pendingNav.at};
    this.note('jump-committed',{target:nav.target,at:boundary.at,atPlayed:boundary.atPlayed});
    if(this.pendingNav){this.generation++;this.commitNext();}
  }

  beginHold(segment){
    this.note('hold',{id:segment.id,seconds:segment.seconds});
    this.out({type:'hold',seconds:segment.seconds,expected:segment.expected});
    if(this.path[0]?.key===segment.key)this.path.shift();
    this.status='holding';this.hold={segment,left:segment.seconds,last:null};
  }
  tickHold(report){
    const h=this.hold;
    if(this.holdPaused)return;
    if(h.segment.seconds!==null&&Number.isFinite(report.now)){
      if(h.last!==null)h.left-=report.now-h.last;
      h.last=report.now;
      if(h.left<=0)this.endHold();
    }
  }
  /** Go on from a hold: its time ran out, or the control was pressed. */
  endHold(){
    if(this.status!=='holding')return false;
    this.note('hold-ended',{id:this.hold.segment.id});this.hold=null;this.status='playing';
    this.current={...this.current,end:this.source,start:this.source,startPlayed:this.played,actions:[]};
    this.engine.play(true);
    const next=this.peek();
    if(next?.kind==='music'&&next.start===this.source){this.pop(next);this.advance(next,this.played,next.start);}
    return true;
  }
}
