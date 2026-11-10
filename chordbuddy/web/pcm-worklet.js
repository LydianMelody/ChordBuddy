import {StemPlayer} from './pcm-player.js';
import {HORIZON_FRAMES,PathMixer} from './pcm-path.js';
import {loadStretchEngine} from './time-stretch.js';
loadStretchEngine(sampleRate);   // Signalsmith Stretch for practice speeds; it takes a moment, and the simpler stretcher covers until then
class StemProcessor extends AudioWorkletProcessor{
 constructor(){super();this.player=new StemPlayer();this.mixer=this.player.mixer;this.tick=0;this.stream=null;this.ready=false;this.port.onmessage=e=>this.command(e.data);}
 command(m){
  try{
   if(m.type==='connect'){this.stream=m.port;this.stream.onmessage=e=>this.command(e.data);this.stream.start();return;}
   if(m.type==='reset'){this.player.reset(m);this.ready=false;this.port.postMessage({type:'reset-ack',generation:m.generation,runId:m.runId});return;}
   // A loop change while streaming: the queued audio keeps playing and the fetch worker carries on from where the new loop needs it.
   if(m.type==='loop'){
    if(m.previous!==this.mixer.generation||m.runId!==this.mixer.runId)throw Error('The loop changed while the stream restarted. Press Play to retry.');
    const plan=this.mixer.splice(m);
    this.stream.postMessage({type:'splice',previous:m.previous,generation:m.generation,runId:m.runId,loop:m.loop,...plan});return;
   }
   if(m.generation!==this.mixer.generation||m.runId!==this.mixer.runId)return;
   if(m.type==='chunk'){
    this.mixer.enqueue(m);
    if(!this.ready&&(this.mixer.queuedFrames>=44100||this.mixer.end===this.mixer.total)){this.ready=true;this.port.postMessage({type:'ready',generation:m.generation,runId:m.runId});}
   }
   if(m.type==='play'){this.holdUntil=m.value&&Number.isFinite(m.at)?m.at:0;this.mixer.setPlaying(m.value);}   // at: the frame to start on, after a count-in
   if(m.type==='mix')this.mixer.setMix(m.value);
   if(m.type==='mode')this.mixer.setMode(m.value);
   if(m.type==='rate')this.player.setRate(m.value);
   if(m.type==='error'){this.mixer.setPlaying(false);this.port.postMessage(m);}
  }catch(error){this.mixer.setPlaying(false);this.port.postMessage({type:'error',generation:this.mixer.generation,runId:this.mixer.runId,error:error.message});}
 }
 process(inputs,outputs){
  const out=outputs[0];if(!out?.length)return true;
  // waiting out a count-in: silence until the frame it ends on, then the music from its first sample
  const left=out[0],right=out[1]||out[0],wait=Math.max(0,Math.min(left.length,(this.holdUntil||0)-currentFrame));
  if(wait<left.length)this.player.render(wait?left.subarray(wait):left,wait?right.subarray(wait):right);
  if(wait){left.fill(0,0,wait);if(right!==left)right.fill(0,0,wait);}
  this.tick+=left.length;
  if(this.tick>=2048){this.tick=0;const m={type:'position',hold:Math.max(0,(this.holdUntil||0)-currentFrame),generation:this.mixer.generation,runId:this.mixer.runId,sourceFrame:this.player.sourceFrame,played:this.mixer.played,levels:this.mixer.takeLevels(),contextFrame:currentFrame,state:this.player.state,stretcher:this.player.stretcher,queuedFrames:this.mixer.queuedFrames};this.port.postMessage(m);this.stream?.postMessage(m);}
  return true;
 }
}
registerProcessor('stem-mixer',StemProcessor);

// The player for a performance (pcm-path.js). Two players on one output timeline, so the next song can start on an exact sample: the current
// one renders up to the handoff frame, an optional gap of silence follows, and the next one fills the rest of that same block. Commands
// arrive in advance and carry the output frame they belong to; nothing here waits on anything. Practice playback never comes through here.
class PathProcessor extends AudioWorkletProcessor{
 constructor(){
  super();this.slots=[0,1].map(()=>({player:new StemPlayer(new PathMixer()),stream:null,lastLag:0}));
  this.active=0;this.handoff=null;this.gap=0;this.tick=0;this.port.onmessage=e=>this.command(e.data);
 }
 answer(id,result){if(id!==undefined)this.port.postMessage({type:'answer',id,result});}
 streamMessage(slot,m){
  const s=this.slots[slot],mixer=s.player.mixer;
  try{
   if(m.type==='prepared'){mixer.addPrepared(m);this.port.postMessage({type:'prepared',slot,startFrame:m.startFrame,frameCount:m.frameCount});return;}
   if(m.type==='prepare-failed'){this.port.postMessage({type:'prepare-failed',slot,startFrame:m.startFrame,error:m.error});return;}
   if(m.type==='error'){this.port.postMessage({type:'error',slot,error:m.error});return;}
   if(m.generation!==mixer.generation||m.runId!==mixer.runId)return;
   if(m.type==='chunk'){
    mixer.enqueue(m);
    if(!s.ready&&(mixer.queuedFrames>=44100||mixer.end===mixer.total)){s.ready=true;this.port.postMessage({type:'ready',slot,generation:m.generation,runId:m.runId});}
   }
  }catch(error){mixer.setPlaying(false);this.port.postMessage({type:'error',slot,error:error.message});}
 }
 apply(slot,payload){
  const {player}=this.slots[slot];
  if(payload.kind==='mix')player.mixer.setMix(payload.mix);
  else if(payload.kind==='rate')player.setRate(payload.percent/100);
  else if(payload.kind==='hold')player.mixer.setPlaying(false);
 }
 command(m){
  const s=this.slots[m.slot??this.active],mixer=s?.player.mixer;
  try{
   switch(m.type){
    case 'connect':s.stream=m.port;s.stream.onmessage=e=>this.streamMessage(m.slot,e.data);s.stream.start();break;
    case 'reset':s.player.reset(m);s.ready=false;this.answer(m.id,{status:'reset'});break;
    case 'play':mixer.setPlaying(m.value);break;
    case 'mode':mixer.setMode(m.value);break;
    case 'mix':mixer.setMix(m.value);break;
    case 'rate':s.player.setRate(m.value);break;
    case 'schedule':mixer.schedule(m.atPlayed,()=>this.apply(m.slot,m.payload),m.id);break;
    case 'cancel':mixer.cancel(a=>String(a.id).startsWith(m.prefix));break;
    case 'cancel-from':mixer.cancel(a=>a.atPlayed>=m.atPlayed);break;
    case 'mark':{const until=mixer.framesUntil(m.at);this.answer(m.id,until===null?{status:'later'}:until<HORIZON_FRAMES?{status:'missed'}:{status:'committed',atPlayed:mixer.played+until});break;}
    case 'jump':case 'jump-now':{
     const previous=mixer.generation,result=m.type==='jump'?mixer.jump({generation:m.generation,at:m.at,to:m.to}):mixer.jumpNow({generation:m.generation,to:m.to});
     if(result.status==='committed')s.stream.postMessage({type:'splice',previous,generation:m.generation,runId:mixer.runId,loop:null,startFrame:result.startFrame,sent:result.sent,consumed:result.consumed,engaged:false});
     this.answer(m.id,result);break;
    }
    case 'handoff':this.handoff={from:m.slot,to:m.to,atPlayed:m.atPlayed,gap:m.gap||0};break;
    case 'cancel-handoff':this.handoff=null;this.gap=0;break;
    case 'lead-in':this.gap=m.frames;break;                 // the first song of a show waits this long for its count-in
    default:break;
   }
  }catch(error){mixer?.setPlaying(false);this.port.postMessage({type:'error',slot:m.slot,id:m.id,error:error.message});}
 }
 process(inputs,outputs){
  const out=outputs[0];if(!out?.length)return true;
  const left=out[0],right=out[1]||out[0];let at=0;
  while(at<left.length){
   const room=left.length-at;
   if(this.gap>0){const n=Math.min(room,this.gap);left.fill(0,at,at+n);if(right!==left)right.fill(0,at,at+n);this.gap-=n;at+=n;if(this.gap===0&&this.waitingFor!==undefined){this.startNext();}continue;}
   const s=this.slots[this.active],h=this.handoff,mixer=s.player.mixer;
   const until=h&&h.from===this.active?h.atPlayed-mixer.played:Infinity;
   if(until<=0){
    this.handoff=null;mixer.setPlaying(false);
    this.waitingFor=h.to;this.port.postMessage({type:'handed-off',from:h.from,to:h.to,gap:h.gap,contextFrame:currentFrame+at});
    if(h.gap>0){this.gap=h.gap;continue;}
    this.startNext();continue;
   }
   const n=Math.min(room,until);
   s.player.render(left.subarray(at,at+n),right===left?left.subarray(at,at+n):right.subarray(at,at+n));
   at+=n;
  }
  this.tick+=left.length;
  if(this.tick>=2048){this.tick=0;for(const [slot,s] of this.slots.entries()){
   const mixer=s.player.mixer;if(mixer.runId===null||mixer.runId===undefined)continue;
   const heard=s.player.sourceFrame,lag=s.player.stretching?mixer.frame-heard:0;
   if(lag>=0&&lag<44100*2)s.lastLag=lag;
   const m={type:'position',slot,active:slot===this.active,generation:mixer.generation,runId:mixer.runId,sourceFrame:mixer.frame,heardFrame:heard,played:mixer.played,heardPlayed:mixer.played-s.lastLag,levels:mixer.takeLevels(),contextFrame:currentFrame,state:s.player.state,stretcher:s.player.stretcher,queuedFrames:mixer.queuedFrames,gap:slot===this.active?this.gap:0};
   this.port.postMessage(m);s.stream?.postMessage(m);
  }}
  return true;
 }
 startNext(){
  this.active=this.waitingFor;this.waitingFor=undefined;
  this.slots[this.active].player.mixer.setPlaying(true);
 }
}
registerProcessor('stem-path',PathProcessor);

// A zero-output automatic-pull node keeps interactive contexts on the device
// clock during silence. Chromium's silent sink otherwise switches to a timer
// after 30 seconds; minimized Windows playback can then lose rendered time.
// This processor emits no samples and never advances the source cursor.
class StemClockProcessor extends AudioWorkletProcessor{
 constructor(){super();this.active=true;this.port.onmessage=e=>{if(e.data.type==='dispose')this.active=false;};}
 process(){return this.active;}
}
registerProcessor('stem-clock',StemClockProcessor);

