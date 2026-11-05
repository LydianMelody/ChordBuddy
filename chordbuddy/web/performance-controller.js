// Runs a whole show: resolves its entries, checks they can play, and moves from song to song with one Start. One controller lives for the whole run,
// whichever view is open. Everything the player can be told goes through here, so keys, buttons, the chart, a pop-out visualizer and MIDI share one path.
// The runner (performance-runner.js) decides inside a song; this decides between songs. No DOM. deps are injected, so tests run it on fakes:
//   createSession({onPosition,onError,onHandoff}), loadEntry(entry)->{song,performance,compiled,grid,sections,manifest,trim,baseMix}, now()->seconds on a clock
//   that never jumps, out(event): every timed event for the visual and MIDI adapters, onChange(snapshot), onSong(songId): show this song in the app's views.
import {PerformanceRunner,nextBarline} from './performance-runner.js';
import {pathSeconds} from './performance-duration.js';
import {showSeconds,timing} from './performance-duration.js';
import {domainOfProperty,STEM_ROLES} from './performance-actions.js';

const RATE=44100;
export const STATES=Object.freeze(['idle','preparing','armed','playing','paused','gap','waiting','buffering','finished','stopped','error']);
const PRELOAD_SECONDS=20;                       // the next song starts loading this long before it is needed, at the latest
const HANDOFF_WINDOW=RATE*2;

/** Checks everything a show needs before Start. Returns {ready, blocking:[...], notes:[...], live, assumptions}. checks: extra facts from the app. */
export function preflight(loaded,{devices=[],keepAwake=null,missingScenes=[],policy='continue'}={}){
  const blocking=[],notes=[];let live=false,unknown=false,estimated=false;
  loaded.forEach((item,i)=>{
    const name=item.song?.title||`Song ${i+1}`;
    if(item.error){blocking.push(`${name}: ${item.error}`);return;}
    if(!item.manifest)blocking.push(`${name}: its audio isn’t ready. Analyze it first.`);
    if(!item.compiled.ok)for(const e of item.compiled.errors)blocking.push(`${name}: ${e.message}`);
    if(item.compiled.needsReview)notes.push(`${name}: the song’s bars changed since this was saved. Check its actions in Prepare.`);
    for(const w of item.compiled.warnings)if(w.code!=='moved')notes.push(`${name}: ${w.message}`);
    if(item.compiled.requiresLiveControl)live=true;
    if(item.compiled.unknownWait)unknown=true;
    if(item.compiled.segments.some(s=>s.live||s.kind==='hold'&&s.seconds===null))estimated=true;
  });
  for(const scene of missingScenes)blocking.push(`The “${scene}” visualization isn’t installed.`);
  for(const d of devices){
    if(d.connected)continue;
    if(d.critical||policy==='stop')blocking.push(`${d.name} isn’t connected, and this show needs it.`);
    else notes.push(`${d.name} isn’t connected. The show will play without it and list what it missed.`);
  }
  if(keepAwake===false)notes.push('This computer may still go to sleep during the show: keeping it awake didn’t work.');
  return {ready:!blocking.length,blocking,notes,live,estimated,unknown,keepAwake};
}

export class ShowController{
  constructor({createSession,loadEntry,now,out=()=>{},onChange=()=>{},onSong=()=>{},power=null,policy=null}){
    Object.assign(this,{createSession,loadEntry,now,out,onChange,onSong,power,policy});
    this.status='idle';this.entries=[];this.index=-1;this.loaded=new Map();this.session=null;this.runner=null;this.slot=0;this.log=[];this.handoffPlanned=null;this.pendingNext=null;this.handoffRequest=0;
    this.deadline=null;this.gapLeft=null;this.lastError=null;this.completedMusic=0;this.skipped=[];
  }
  note(type,details={}){if(this.log.length>5000)this.log.splice(0,1000);this.log.push({type,at:this.now(),entry:this.current?.id??null,...details});}
  get current(){return this.entries[this.index]||null;}
  get next(){return this.entries[this.index+1]||null;}

  // ---- getting ready
  /** Resolve every entry of a show; nothing plays. show: {entries, target, policy, keepVisualsWhenMuted, ...}. */
  async arm(show,checks={}){
    this.status='preparing';this.show=show;this.entries=show.entries.map(e=>({...e}));this.policy=show.policy||this.policy;this.emit();
    const items=await Promise.all(this.entries.map(async entry=>{
      try{const item=await this.loadEntry(entry);this.loaded.set(entry.id,item);return item;}
      catch(error){const item={error:error.message,song:{title:entry.title||entry.songId},compiled:{ok:false,errors:[],warnings:[],segments:[]}};this.loaded.set(entry.id,item);return item;}
    }));
    this.check=preflight(items,checks);
    this.status=this.check.ready?'armed':'preparing';
    this.note('armed',{ready:this.check.ready});this.emit();
    return this.check;
  }
  /** Start a run. Slot time (if the show has a target) counts from here. */
  async start(){
    if(this.status!=='armed')throw Error('This show isn’t ready to start.');
    this.setDeadline();
    this.session=await this.createSession({onPosition:m=>this.position(m),onError:(e,slot,soft)=>this.engineError(e,slot,soft),onHandoff:m=>this.handedOff(m)});
    this.power?.acquire?.();
    await this.session.resume();
    this.index=0;this.slot=0;
    await this.startCurrent();
    this.note('started');
    this.preloadNext();
    this.emit();
  }
  setDeadline(){
    const t=this.show.target;
    if(t?.slotSeconds)this.deadline=this.now()+t.slotSeconds;
    else if(Number.isFinite(t?.finishAtEpoch)&&this.epochNow)this.deadline=this.now()+(t.finishAtEpoch-this.epochNow())/1000;
    else this.deadline=null;
  }
  async startCurrent(){
    const item=this.loaded.get(this.current.id);
    await this.session.load(this.slot,item.manifest,0);
    this.makeRunner(this.slot,item);
    this.session.mix(this.slot,item.baseMix);
    this.runner.start(0);
    this.status='playing';
    this.onSong(this.current.songId,item);
  }
  makeRunner(slot,item){
    const entry=this.current;
    this.runner=new PerformanceRunner({performance:item.performance,compiled:item.compiled,grid:item.grid,engine:this.session.engine(slot),out:e=>this.out({...e,entry:entry.id,slot}),policy:this.policy,sections:item.sections,baseMix:item.baseMix,trim:item.trim,runId:this.show.id||'show',entryId:entry.id});
    this.handoffPlanned=null;
  }
  /** Keep the next song loading in the other slot, so a change never waits. Failure doesn't touch the song playing. */
  async preloadNext(){
    const next=this.next;if(!next||this.session===null)return;
    const slot=1-this.slot,item=this.loaded.get(next.id);
    if(!item?.manifest){this.note('next-not-ready',{next:next.id});return;}
    if(this.preloading===next.id||this.readySlot===next.id)return;
    this.preloading=next.id;
    try{await this.session.load(slot,item.manifest,0);if(this.next?.id===next.id){this.readySlot=next.id;this.session.mix(slot,item.baseMix);this.note('next-ready',{next:next.id});}}
    catch(error){this.note('next-load-failed',{next:next.id,error:error.message});}
    finally{if(this.preloading===next.id)this.preloading=null;this.emit();}
  }

  // ---- reports from the engine
  position(m){
    if(!this.session||this.status==='finished'||this.status==='stopped')return;
    if(m.slot!==this.slot)return;
    const rate=(this.runner?.rate??100)/100;
    this.lastReport=m;
    this.runner?.tick({played:m.played,source:m.sourceFrame,heard:Math.max(0,m.heardFrame-Math.round((m.latency||0)*RATE*rate)),state:m.state,now:this.now()});
    if(this.status==='playing'&&this.runner?.status==='buffering')this.status='buffering';
    else if(this.status==='buffering'&&this.runner?.status==='playing')this.status='playing';
    this.planHandoff();
    this.emit();
  }
  /** The song's last boundary is near, or Next song is queued: tell the engine exactly where the next one begins. */
  planHandoff(){
    const r=this.runner;if(!r||!r.current||this.handoffPlanned)return;
    if(this.pendingNext){
      const at=this.pendingNext.at;
      const until=r.current.startPlayed+(at-r.current.start)-r.played;
      if(until>HANDOFF_WINDOW)return;
      this.requestHandoff(at);return;
    }
    if(r.peek())return;                          // more of this song to come
    const end=r.current.end;
    const until=r.current.startPlayed+(end-r.current.start)-r.played;
    if(until>HANDOFF_WINDOW)return;
    const next=this.next;
    if(!next){return;}                           // the show ends with the song; the runner says when
    const t=this.transitionOf(next);
    if(t.kind==='control'||this.readySlot!==next.id){this.waitingAtEnd=true;return;}
    this.requestHandoff(end,t);
  }
  transitionOf(entry){const t=entry.transition||this.show.transitions||{};return {kind:t.kind||'immediate',seconds:Number.isFinite(t.seconds)?t.seconds:0,countIn:Number.isFinite(t.countIn)?t.countIn:0,expected:t.expected};}
  requestHandoff(at,transition=null){
    const r=this.runner,next=this.next;if(!next||this.readySlot!==next.id)return;
    const t=transition||{...this.transitionOf(next),seconds:this.transitionOf(next).kind==='gap'?this.transitionOf(next).seconds:0};
    const engine=this.session.engine(this.slot),request=++this.handoffRequest;
    this.handoffPlanned={asking:true,at};
    engine.mark(at,answer=>{
      if(request!==this.handoffRequest)return;
      if(answer?.status!=='committed'){
        this.handoffPlanned=null;
        // too close to make: the next barline instead, never the middle of a bar
        if(answer?.status==='missed'&&this.pendingNext)this.pendingNext.at=nextBarline(r.measures,at)??r.grid.frames;
        return;
      }
      const gap=Math.round(((t.seconds||0)+(t.countIn||0))*RATE);
      this.session.handoff(this.slot,{to:1-this.slot,atPlayed:answer.atPlayed,gap});
      this.handoffPlanned={at,atPlayed:answer.atPlayed,gap};
      r.withdrawFrom?.(answer.atPlayed);
      this.note('handoff-planned',{at,atPlayed:answer.atPlayed,gap});
    });
  }
  handedOff(m){
    if(this.handoffPlanned===null&&!this.pendingNext)return;
    const finished=this.current;
    this.completedMusic+=this.runner?.playedSeconds??0;
    this.note('song-ended',{entry:finished?.id,next:m.to});
    this.runner?.out?.({type:'cleanup'});
    this.pendingNext=null;this.handoffPlanned=null;this.waitingAtEnd=false;
    this.index++;this.slot=m.to;this.readySlot=null;
    const item=this.loaded.get(this.current.id);
    this.makeRunner(this.slot,item);
    // The next song's first sound comes after the gap: the worklet holds its start until then.
    this.runner.start(0);
    this.status=m.gap>0?'gap':'playing';this.gapEnds=m.gap>0?this.now()+m.gap/RATE:null;
    this.onSong(this.current.songId,item);
    this.preloadNext();
    this.emit();
  }
  engineError(message,slot,soft){
    if(soft){this.note('prepare-failed',{message,slot});return;}
    this.note('engine-error',{message,slot});
    this.lastError=message;
    if(slot===this.slot){this.status='error';this.power?.release?.();this.out({type:'cleanup'});}
    this.emit();
  }

  // ---- what the performer can do
  togglePlay(){if(this.status==='paused')this.resume();else this.pause();}
  /** Immediate: music, cues and a running gap all stop. The slot clock keeps counting. */
  pause(){
    if(!['playing','gap','buffering','waiting'].includes(this.status))return;
    this.beforePause=this.status;this.status='paused';this.runner?.pause();
    if(this.beforePause==='gap'){this.gapLeftAtPause=Math.max(0,this.gapEnds-this.now());this.session?.suspend?.();}
    this.note('paused');this.emit();
  }
  resume(){
    if(this.status!=='paused')return;
    this.status=this.beforePause||'playing';this.runner?.resume();
    if(this.beforePause==='gap'){this.gapEnds=this.now()+this.gapLeftAtPause;this.session?.resume?.();}
    this.note('resumed');this.emit();
  }
  /** Stop everything now. Never locked, never quantized. */
  stop(){
    this.runner?.stop();this.status='stopped';this.power?.release?.();this.note('stopped');
    this.session?.dispose?.();this.session=null;this.out({type:'cleanup'});this.emit();
  }
  pressLoop(kind){return this.runner?.pressLoop(kind)??null;}
  exitLoop(){return this.runner?.pressExit()??null;}
  navigate(frame){return this.runner?.navigate(frame)??null;}
  stepBars(direction){return this.runner?.stepBars(direction)??null;}
  stepSections(direction){return this.runner?.stepSections(direction)??null;}
  cancelJump(){if(this.pendingNext){this.cancelNext();return true;}return this.runner?.cancelNavigation()??false;}
  setLive(property,value){return this.runner?.setLive(property,value)??{accepted:false,reason:'Nothing is playing.'};}
  release(selector){return this.runner?.release(selector)??[];}
  setPolicy(policy,options){this.policy=policy;this.runner?.setPolicy(policy,options);this.emit();}
  /** From the mixer by hand: every stem property that differs becomes a live change. */
  handMix(mix,was){
    let accepted=true,reason=null;
    const apply=(p,v)=>{const r=this.setLive(p,v);if(!r.accepted){accepted=false;reason=r.reason;}};
    STEM_ROLES.forEach((role,i)=>{
      if(mix.gains[i]!==was.gains[i])apply(`track.${role}.gain`,mix.gains[i]);
      if(mix.mutes[i]!==was.mutes[i])apply(`track.${role}.mute`,mix.mutes[i]);
      if(mix.solos[i]!==was.solos[i])apply(`track.${role}.solo`,mix.solos[i]);
    });
    if(mix.master!==was.master)apply('master',mix.master);
    return {accepted,reason};
  }
  /** Move on to the next song: at the next barline, or at once from a wait or between songs. */
  nextSong(){
    if(!this.next)return null;
    if(this.waitingAtEnd||this.status==='waiting')return this.goFromWait();
    const r=this.runner;if(!r?.current)return null;
    const at=nextBarline(r.measures,r.source+256)??r.grid.frames;
    this.pendingNext={at};this.note('next-queued',{at});
    if(r.pendingNav)r.cancelNavigation();
    if(this.readySlot!==this.next.id)this.preloadNext();
    this.planHandoff();this.emit();
    return {type:'next',boundary:at};
  }
  cancelNext(){
    if(!this.pendingNext)return false;
    this.pendingNext=null;this.handoffRequest++;
    if(this.handoffPlanned?.atPlayed!==undefined)this.session.cancelHandoff();
    this.handoffPlanned=null;this.note('next-cancelled');this.emit();
    return true;
  }
  goFromWait(){
    const next=this.next;if(!next||this.readySlot!==next.id)return null;
    const engine=this.session.engine(this.slot);
    this.handoffPlanned={at:this.runner.source,atPlayed:this.runner.played,gap:0};
    this.session.handoff(this.slot,{to:1-this.slot,atPlayed:this.runner.played,gap:0});
    engine.play(false);this.note('next-from-wait');
    return {type:'next',boundary:null};
  }

  // ---- changing the set during the run
  /** Future entries can be added, removed and reordered at once; the song playing and what's already played stay put. */
  setQueue(ids){
    const done=this.entries.slice(0,this.index+1),byId=new Map(this.entries.map(e=>[e.id,e]));
    const future=ids.map(id=>byId.get(id)).filter(e=>e&&!done.includes(e));
    this.entries=[...done,...future];
    this.afterQueueChange();
  }
  async addEntry(entry,atIndex=null){
    const place=atIndex===null?this.entries.length:Math.max(this.index+1,atIndex);
    this.entries.splice(place,0,{...entry});
    try{this.loaded.set(entry.id,await this.loadEntry(entry));}catch(error){this.loaded.set(entry.id,{error:error.message,compiled:{ok:false,errors:[],warnings:[],segments:[]}});}
    this.afterQueueChange();
  }
  /** The song playing can't vanish: it comes off after it ends. */
  removeEntry(id){
    if(this.current?.id===id){this.removeAfter=id;this.note('remove-after-song',{id});this.emit();return 'after-this-song';}
    this.entries=this.entries.filter(e=>e.id!==id);this.afterQueueChange();return 'removed';
  }
  afterQueueChange(){
    const next=this.next;
    if(this.readySlot&&this.readySlot!==next?.id){this.readySlot=null;if(this.handoffPlanned){this.session.cancelHandoff();this.handoffPlanned=null;this.handoffRequest++;}}
    this.preloadNext();this.note('queue-changed',{ids:this.entries.map(e=>e.id)});this.emit();
  }

  // ---- what's shown
  totals(){
    const list=this.entries.slice(Math.max(0,this.index)).map((entry,i)=>{
      const item=this.loaded.get(entry.id);
      return {segments:i===0&&this.runner?this.remainingSegments():item?.compiled?.segments||[],position:i===0&&this.runner?this.remainingPosition():undefined,transition:i===0?null:this.transitionOf(entry)};
    });
    return showSeconds(list,{gapLeft:this.status==='gap'||this.gapLeftAtPause&&this.beforePause==='gap'?Math.max(0,(this.gapEnds??this.now())-this.now()):null});
  }
  remainingSegments(){const r=this.runner;return [...(r.current?[r.current]:[]),...r.path.filter(p=>p.kind==='music'||p.kind==='hold')];}
  remainingPosition(){const r=this.runner;return {index:0,frame:r.current?r.source:null,rate:r.rate,fixedRate:r.liveRate};}
  /** Everything a view needs, in one value. */
  snapshot(){
    const totals=this.status==='idle'?null:this.totals();
    const clock=totals?timing(totals,{now:this.now(),deadline:this.deadline}):null;
    return {status:this.status,index:this.index,count:this.entries.length,entries:this.entries.map((e,i)=>({id:e.id,songId:e.songId,performanceId:e.performanceId??null,revision:e.revision??null,done:i<this.index,now:i===this.index,title:this.loaded.get(e.id)?.song?.title??e.songId,artist:this.loaded.get(e.id)?.song?.artist??'',performance:this.loaded.get(e.id)?.performance?.name??'Original arrangement',transition:this.transitionOf(e),seconds:pathSeconds(this.loaded.get(e.id)?.compiled?.segments||[]).music})),
      song:this.runner?.snapshot()??null,clock,check:this.check??null,error:this.lastError,pendingNext:this.pendingNext,removeAfter:this.removeAfter??null,policy:this.policy,gapLeft:this.status==='gap'?Math.max(0,this.gapEnds-this.now()):null,waiting:!!this.waitingAtEnd};
  }
  emit(){this.onChange(this.snapshot());}
}
export {domainOfProperty};
