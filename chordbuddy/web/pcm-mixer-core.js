import {loopEngaged,validLoop} from './pcm-stream.js';
// Pure common-cursor renderer. No network, DOM or wall-clock scheduling.
export const RATE=44100,TRACK_COUNT=8,MAX_FRAMES=441000,RAMP=441;
export const defaultMix=()=>({gains:Array(7).fill(1),mutes:Array(7).fill(false),solos:Array(7).fill(false),master:1});
export class PcmMixer{
 constructor(){this.mix=defaultMix();this.weights=new Float64Array(7).fill(1);this.targets=new Float64Array(7).fill(1);this.mode='original';this.blend=0;this.master=1;this.last=[0,0];this.peaks=new Float32Array(7);this.reset({generation:0,runId:null,startFrame:0,totalFrames:0,commonGain:1});}
 reset({generation,runId,startFrame,totalFrames,commonGain,loop=null}){
  if(!Number.isSafeInteger(startFrame)||!Number.isSafeInteger(totalFrames)||startFrame<0||startFrame>totalFrames||!Number.isFinite(commonGain)||commonGain<0||commonGain>1||!validLoop(loop,totalFrames))throw Error('Invalid PCM timeline');
  this.generation=generation;this.runId=runId;this.frame=startFrame;this.total=totalFrames;this.gain=commonGain;this.queue=[];this.end=startFrame;this.offset=0;this.loop=loop?{start:loop.start,end:loop.end}:null;this.engaged=loopEngaged(this.loop,startFrame);this.wrapNext=false;this.queued=0;this.played=0;this.playIntent=false;this.state='paused';this.envelope=0;this.last=[0,0];
 }
 get queuedFrames(){return this.queued;}
 // Loudest each stem has been (after its fader, mute/solo, blend and master) since the last call, then starts over. Drives the meters.
 takeLevels(){const out=Array.from(this.peaks);this.peaks.fill(0);return out;}
 enqueue(message){
  if(message.generation!==this.generation||message.runId!==this.runId)return false;
  const {startFrame,frameCount,buffer}=message;
  if(!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>RATE||buffer.byteLength!==frameCount*64)throw Error('Invalid PCM chunk length');
  const expected=this.wrapNext?this.loop.start:this.end;
  if(startFrame!==expected)throw Error('PCM chunks must be contiguous');
  if(startFrame+frameCount>this.total||this.queued+frameCount>MAX_FRAMES)throw Error('PCM queue bound exceeded');
  if(this.loop&&startFrame<this.loop.end&&startFrame+frameCount>this.loop.end)throw Error('PCM chunk crosses the loop end');
  const data=new Float32Array(buffer);
  for(let i=0;i<data.length;i++)if(!Number.isFinite(data[i]))throw Error('Nonfinite PCM');
  this.queue.push({data,count:frameCount,start:startFrame});this.end=startFrame+frameCount;this.queued+=frameCount;this.wrapNext=!!this.loop&&startFrame<this.loop.end&&this.end===this.loop.end;return true;
 }
 setMode(mode){if(!['original','stems'].includes(mode))throw Error('Invalid mode');this.mode=mode;if(!this.playIntent&&this.envelope===0)this.blend=mode==='stems'?1:0;}
 setMix(value){
  for(const name of ['gains','mutes','solos'])if(!Array.isArray(value[name])||value[name].length!==7)throw Error('Invalid mix');
  if(!value.gains.every(x=>Number.isFinite(x)&&x>=0&&x<=1)||!Number.isFinite(value.master)||value.master<0||value.master>1)throw Error('Invalid gain');
  if(!value.mutes.every(x=>typeof x==='boolean')||!value.solos.every(x=>typeof x==='boolean'))throw Error('Invalid mute/solo');
  this.mix={gains:[...value.gains],mutes:[...value.mutes],solos:[...value.solos],master:value.master};const solo=value.solos.some(Boolean);
  for(let i=0;i<7;i++)this.targets[i]=value.mutes[i]||solo&&!value.solos[i]?0:value.gains[i];
  if(!this.playIntent&&this.envelope===0){this.master=value.master;this.weights.set(this.targets);}
 }
 setPlaying(value){this.playIntent=!!value;if(!value)this.state='paused';}
 // Mixed frames for the time-stretch path: identical mixing and smoothing to render(), but no play/pause envelope and no state
 // changes to playIntent (the caller fades after stretching and decides when playback has really ended).
 // Returns the source frame of the first frame produced.
 pullMixed(left,right){
  const targetBlend=this.mode==='stems'?1:0;let first=null;
  for(let i=0;i<left.length;i++){
   const finished=this.frame>=this.total&&!(this.loop&&this.engaged);
   if(!this.queue.length||finished){this.state=finished?'ended':'buffering';left[i]=0;right[i]=0;continue;}
   this.state='playing';
   const chunk=this.queue[0],at=this.offset*2,span=chunk.count*2;
   if(this.offset===0)this.frame=chunk.start;
   if(first===null)first=this.frame;
   const remaining=this.queued,fade=remaining<=RAMP?remaining/RAMP:1;
   this.blend+=Math.max(-1/RAMP,Math.min(1/RAMP,targetBlend-this.blend));
   this.master+=Math.max(-1/RAMP,Math.min(1/RAMP,this.mix.master-this.master));
   for(let t=0;t<7;t++)this.weights[t]+=Math.max(-1/RAMP,Math.min(1/RAMP,this.targets[t]-this.weights[t]));
   const scale=this.blend*this.gain*this.master;
   for(let channel=0;channel<2;channel++){
    let stems=0;for(let t=0;t<7;t++){const v=chunk.data[(t+1)*span+at+channel]*this.weights[t];stems+=v;const a=Math.abs(v)*scale;if(a>this.peaks[t])this.peaks[t]=a;}
    (channel===0?left:right)[i]=(chunk.data[at+channel]*(1-this.blend)+stems*this.blend)*this.gain*this.master*fade;
   }
   this.frame++;this.offset++;this.queued--;this.played++;
   if(this.offset===chunk.count){this.queue.shift();this.offset=0;}
  }
  return first===null?this.frame:first;
 }
 render(left,right){
  const targetBlend=this.mode==='stems'?1:0;
  for(let i=0;i<left.length;i++){
   const finished=this.frame>=this.total&&!(this.loop&&this.engaged);
   if(!this.playIntent||!this.queue.length||finished){
    this.state=finished?'ended':this.playIntent?'buffering':'paused';
    if(this.state==='ended')this.playIntent=false;
    this.envelope=Math.max(0,this.envelope-1/RAMP);
    left[i]=this.last[0]*this.envelope;right[i]=this.last[1]*this.envelope;continue;
   }
   this.state='playing';
   const remaining=this.queuedFrames;
   const envelopeTarget=remaining<=RAMP?remaining/RAMP:1;
   this.envelope=Math.min(envelopeTarget,this.envelope+1/RAMP);
   this.blend+=Math.max(-1/RAMP,Math.min(1/RAMP,targetBlend-this.blend));
   this.master+=Math.max(-1/RAMP,Math.min(1/RAMP,this.mix.master-this.master));
   for(let t=0;t<7;t++)this.weights[t]+=Math.max(-1/RAMP,Math.min(1/RAMP,this.targets[t]-this.weights[t]));
   const chunk=this.queue[0],at=this.offset*2,span=chunk.count*2;
   if(this.offset===0)this.frame=chunk.start;
   const scale=this.blend*this.gain*this.master;
   for(let channel=0;channel<2;channel++){
    let stems=0;for(let t=0;t<7;t++){const v=chunk.data[(t+1)*span+at+channel]*this.weights[t];stems+=v;const a=Math.abs(v)*scale;if(a>this.peaks[t])this.peaks[t]=a;}
    const value=(chunk.data[at+channel]*(1-this.blend)+stems*this.blend)*this.gain*this.master;
    this.last[channel]=value;(channel===0?left:right)[i]=value*this.envelope;
   }
   this.frame++;this.offset++;this.queued--;this.played++;
   if(this.offset===chunk.count){this.queue.shift();this.offset=0;}
  }
 }
}

