// The stem mixer for a performance: everything PcmMixer does, plus two things a show needs.
//   Prepared jumps: a jump is decided in advance for an exact source frame, and happens inside the audio queue. The music plays up to
//   that frame and the next sample is the target's first, with no stop, no re-prime and no wait on the server. The target's audio must
//   already be here (played recently, queued, or fetched ahead with addPrepared); if it is not, the jump is refused and the music carries
//   on, so the caller can pick a later barline. A loop wrap, a loop exit and a loop switch are all this same operation.
//   Timed actions: a mix or other change tied to a frame of the output path (`played`, which counts every frame ever rendered and never
//   goes back), applied on that exact frame by splitting the render block there. Applied before any time stretch, so a change stays on
//   the same samples at every speed.
// Pure: no network, DOM or clock. Practice playback uses PcmMixer and is not touched by any of this.
import {MAX_FRAMES,MEMORY_FILL_FRAMES,PcmMixer,RATE} from './pcm-mixer-core.js';
import {loopEngaged,validLoop} from './pcm-stream.js';

export const PREPARED_LIMIT_FRAMES=RATE*12;     // audio fetched ahead of a jump (about 34 MB), oldest dropped first
export const READY_FRAMES=RATE;                 // a jump needs this much target audio on hand, so the stream can catch up behind it
export const HORIZON_FRAMES=256;                // a boundary this close is too late to change safely: at least one render block away

function cut(chunk,from,count){
 if(from===0&&count===chunk.count)return chunk;
 const data=new Float32Array(count*16),span=chunk.count*2;
 for(let t=0;t<8;t++)data.set(chunk.data.subarray(t*span+from*2,t*span+(from+count)*2),t*count*2);
 return {data,count,start:chunk.start+from};
}

export class PathMixer extends PcmMixer{
 reset(message){
  if(message.runId!==this.runId)this.prepared=[];
  this.preparedFrames=this.runId===message.runId?this.preparedFrames||0:0;
  this.actions=[];
  super.reset(message);
 }
 // Where the next rendered frame comes from.
 get position(){return this.queue.length?this.queue[0].start+this.offset:this.wrapNext?this.loop.start:this.end;}
 // The queue walks through a wrap, so the same source frame can come round twice: past the song end only a queued chunk says what is next.
 get finished(){return !this.queue.length&&super.finished;}
 /** Keep audio for a jump that may come. Same checks as enqueue, and no need to be contiguous with what is playing. */
 addPrepared({runId,startFrame,frameCount,buffer}){
  if(runId!==this.runId)return false;
  if(!Number.isSafeInteger(startFrame)||!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>RATE||buffer.byteLength!==frameCount*64||startFrame<0||startFrame+frameCount>this.total)throw Error('Invalid PCM chunk length');
  const data=new Float32Array(buffer);
  for(let i=0;i<data.length;i++)if(!Number.isFinite(data[i]))throw Error('Nonfinite PCM');
  this.prepared.push({data,count:frameCount,start:startFrame});this.preparedFrames+=frameCount;
  while(this.preparedFrames>PREPARED_LIMIT_FRAMES&&this.prepared.length>1)this.preparedFrames-=this.prepared.shift().count;
  return true;
 }
 /** How many contiguous frames from `frame` on are here already (played, queued or prepared). */
 readyFrames(frame,limit=READY_FRAMES){
  const known=[...this.prepared,...this.history,...this.queue];let pos=frame,have=0;
  while(have<limit){const c=known.find(k=>k.start<=pos&&pos<k.start+k.count);if(!c)break;const n=c.start+c.count-pos;have+=n;pos+=n;}
  return Math.min(have,limit);
 }
 /** Frames still to render before the queue next reaches source frame `at` (a boundary: the frame after the last one kept), or null. */
 framesUntil(at){
  let pos=this.position,ahead=0;
  for(const [i,chunk] of this.queue.entries()){
   const from=i===0?this.offset:0,begin=chunk.start+from,finish=chunk.start+chunk.count;
   pos=begin;
   if(at>begin&&at<=finish)return ahead+at-begin;
   ahead+=finish-begin;pos=finish;
  }
  return null;
 }
 /** Jump at source frame `at` (the first frame not played) to `to`, adopting `loop` there.
  * Returns {status:'committed', startFrame, sent, consumed, engaged, atPlayed, ...} for the fetch worker, or, leaving everything as it was:
  * 'later' the boundary is not queued yet; 'missed' it is too close or already gone; 'waiting' the target's audio is not here yet. */
 jump({generation,at,to,loop=null}){
  if(!validLoop(loop,this.total)||!Number.isSafeInteger(at)||!Number.isSafeInteger(to)||to<0||to>this.total)throw Error('Invalid PCM timeline');
  const until=this.framesUntil(at);
  if(until===null)return {status:this.position>=at&&!this.loop?'missed':'later'};
  if(until<HORIZON_FRAMES)return {status:'missed'};
  const ready=to>=this.total?READY_FRAMES:this.readyFrames(to);
  if(ready<Math.min(READY_FRAMES,this.total-to))return {status:'waiting',ready};
  const kept=[];let left=until,queued=0,offset=this.offset;
  for(const [i,chunk] of this.queue.entries()){
   if(left<=0)break;
   const from=i===0?this.offset:0,count=Math.min(left,chunk.count-from);
   if(from>0||count<chunk.count){kept.push(cut(chunk,from,count));if(i===0)offset=0;}else kept.push(chunk);
   left-=count;queued+=count;
  }
  const known=[...this.prepared,...this.history,...this.queue].reverse();let pos=to,filled=0;
  const engaged=loopEngaged(loop,to);
  while(filled<MEMORY_FILL_FRAMES&&queued<MAX_FRAMES&&pos<this.total){
   const c=known.find(k=>k.start<=pos&&pos<k.start+k.count);if(!c)break;
   const limit=engaged&&pos<loop.end?loop.end:this.total,count=Math.min(c.start+c.count,limit,pos+MEMORY_FILL_FRAMES-filled,pos+MAX_FRAMES-queued)-pos;
   if(count<1)break;
   kept.push(cut(c,pos-c.start,count));queued+=count;filled+=count;pos+=count;
   if(engaged&&pos===loop.end){pos=loop.start;break;}
  }
  const atPlayed=this.played+until;
  this.generation=generation;this.queue=kept;this.offset=offset;this.queued=queued;this.end=pos;this.wrapNext=false;
  this.loop=loop?{start:loop.start,end:loop.end}:null;this.engaged=engaged;
  return {status:'committed',startFrame:pos,sent:this.played+queued,consumed:this.played,engaged,atPlayed};
 }
 /** Run apply() when output frame `atPlayed` is about to render. Late ones run at once, on the next block. */
 schedule(atPlayed,apply,id=null){
  const action={atPlayed,apply,id};let i=this.actions.length;
  while(i>0&&this.actions[i-1].atPlayed>atPlayed)i--;
  this.actions.splice(i,0,action);
 }
 cancel(test){this.actions=this.actions.filter(a=>!test(a));}
 runDue(){while(this.actions.length&&this.actions[0].atPlayed<=this.played)this.actions.shift().apply(this);}
 pieces(left,right,render){
  let at=0;
  while(at<left.length){
   this.runDue();
   const room=left.length-at,next=this.actions[0]?.atPlayed,n=Number.isFinite(next)?Math.min(room,Math.max(1,next-this.played)):room;
   const before=this.played;
   render(left.subarray(at,at+n),right.subarray(at,at+n));
   at+=n;
   // paused or starved: nothing moved, so nothing more can fall due in this block
   if(this.played===before&&n<room){render(left.subarray(at),right.subarray(at));break;}
  }
 }
 render(left,right){this.pieces(left,right,(l,r)=>super.render(l,r));}
 pullMixed(left,right){let first=null;this.pieces(left,right,(l,r)=>{const f=super.pullMixed(l,r);if(first===null)first=f;});return first;}
}
