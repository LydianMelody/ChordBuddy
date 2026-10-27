import {StemPlayer} from './pcm-player.js';
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
   if(m.type==='play')this.mixer.setPlaying(m.value);
   if(m.type==='mix')this.mixer.setMix(m.value);
   if(m.type==='mode')this.mixer.setMode(m.value);
   if(m.type==='rate')this.player.setRate(m.value);
   if(m.type==='error'){this.mixer.setPlaying(false);this.port.postMessage(m);}
  }catch(error){this.mixer.setPlaying(false);this.port.postMessage({type:'error',generation:this.mixer.generation,runId:this.mixer.runId,error:error.message});}
 }
 process(inputs,outputs){
  const out=outputs[0];if(!out?.length)return true;
  this.player.render(out[0],out[1]||out[0]);this.tick+=out[0].length;
  if(this.tick>=2048){this.tick=0;const m={type:'position',generation:this.mixer.generation,runId:this.mixer.runId,sourceFrame:this.player.sourceFrame,played:this.mixer.played,levels:this.mixer.takeLevels(),contextFrame:currentFrame,state:this.player.state,queuedFrames:this.mixer.queuedFrames};this.port.postMessage(m);this.stream?.postMessage(m);}
  return true;
 }
}
registerProcessor('stem-mixer',StemProcessor);

// A zero-output automatic-pull node keeps interactive contexts on the device
// clock during silence. Chromium's silent sink otherwise switches to a timer
// after 30 seconds; minimized Windows playback can then lose rendered time.
// This processor emits no samples and never advances the source cursor.
class StemClockProcessor extends AudioWorkletProcessor{
 constructor(){super();this.active=true;this.port.onmessage=e=>{if(e.data.type==='dispose')this.active=false;};}
 process(){return this.active;}
}
registerProcessor('stem-clock',StemClockProcessor);

