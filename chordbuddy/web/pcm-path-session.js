// The browser side of the performance player (the 'stem-path' processor in pcm-worklet.js): one AudioContext for a whole show, so song changes
// share one output timeline. Two slots, each with its own fetch worker: the song playing, and the next one getting ready.
// engine(slot) is what performance-runner.js talks to. Practice playback uses pcm-session.js and never comes here.
const RATE=44100,PREPARE_FRAMES=RATE*3;

export async function createPathSession({token,onPosition,onError,onHandoff=()=>{},onPrepared=()=>{}}){
  const context=new AudioContext({sampleRate:RATE,latencyHint:'interactive'});
  if(context.sampleRate!==RATE){await context.close();throw Error('This audio device cannot create the required 44.1 kHz stem player.');}
  let node,clock,workers=[],nextId=1,disposed=false,generation=1;
  const waiting=new Map(),slots=[{},{}];
  try{
    await context.audioWorklet.addModule('/pcm-worklet.js');
    node=new AudioWorkletNode(context,'stem-path',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
    clock=new AudioWorkletNode(context,'stem-clock',{numberOfInputs:1,numberOfOutputs:0});
    workers=[0,1].map(slot=>{
      const worker=new Worker('/pcm-fetch-worker.js',{type:'module'}),channel=new MessageChannel();
      worker.postMessage({type:'connect',port:channel.port1},[channel.port1]);
      node.port.postMessage({type:'connect',slot,port:channel.port2},[channel.port2]);
      worker.onerror=event=>onError(event.message||'Stem stream failed',slot);
      return worker;
    });
    node.connect(context.destination);
  }catch(error){workers.forEach(w=>w.terminate());clock?.port.postMessage({type:'dispose'});clock?.disconnect();node?.disconnect();await context.close();throw error;}
  const send=(message,transfer)=>node.port.postMessage(message,transfer||[]);
  const ask=(message,answer)=>{const id=nextId++;waiting.set(id,answer);send({...message,id});};
  node.port.onmessage=event=>{
    const m=event.data;if(disposed)return;
    if(m.type==='answer'){const answer=waiting.get(m.id);waiting.delete(m.id);answer?.(m.result);return;}
    if(m.type==='position'){
      // Heard now: what the worklet has rendered, less what is on its way to the speakers.
      const latency=context.outputLatency||context.baseLatency||0;
      onPosition({...m,latency,contextState:context.state,at:performance.now()});
      return;
    }
    if(m.type==='ready'){const s=slots[m.slot];if(s.ready&&s.generation===m.generation){clearTimeout(s.timer);s.ready();s.ready=null;}return;}
    if(m.type==='handed-off'){onHandoff(m);return;}
    if(m.type==='prepared'){onPrepared(m);return;}
    if(m.type==='prepare-failed'){onError(m.error,m.slot,true);return;}
    if(m.type==='error'){onError(m.error,m.slot);return;}
  };
  return {
    context,
    /** Get a song ready in a slot. Resolves when enough audio is here to start. */
    load(slot,manifest,startFrame=0){
      const s=slots[slot];s.manifest=manifest;const g=++generation;s.generation=g;
      return new Promise((resolve,reject)=>{
        s.ready=resolve;s.timer=setTimeout(()=>{s.ready=null;reject(Error('Stem audio buffering timed out'));},30000);
        ask({type:'reset',slot,generation:g,runId:manifest.run_id,startFrame,totalFrames:manifest.frames,commonGain:manifest.common_gain,loop:null},()=>{
          send({type:'mode',slot,value:manifest.stems===false?'original':'stems'});
          if(startFrame>=manifest.frames){clearTimeout(s.timer);s.ready=null;resolve();return;}
          workers[slot].postMessage({type:'load',generation:g,runId:manifest.run_id,startFrame,frames:manifest.frames,token,loop:null});
        });
      });
    },
    /** What performance-runner.js drives, for the song in this slot. */
    engine(slot){
      return {
        jump({at,to},answer){const g=++generation;slots[slot].generation=g;ask({type:'jump',slot,generation:g,at,to},answer);},
        jumpNow({to},answer){const g=++generation;slots[slot].generation=g;ask({type:'jump-now',slot,generation:g,to},answer);},
        mark(at,answer){ask({type:'mark',slot,at},answer);},
        prepare(frame){const m=slots[slot].manifest;workers[slot].postMessage({type:'prepare',runId:m.run_id,token,startFrame:frame,frames:PREPARE_FRAMES,total:m.frames});},
        schedule(atPlayed,payload,id){send({type:'schedule',slot,atPlayed,payload,id});},
        cancel(prefix){send({type:'cancel',slot,prefix});},
        cancelFrom(atPlayed){send({type:'cancel-from',slot,atPlayed});},
        play(value){send({type:'play',slot,value});},
      };
    },
    mix(slot,value){send({type:'mix',slot,value});},
    rate(slot,percent){send({type:'rate',slot,value:percent/100});},
    /** The song in `slot` ends at its output frame atPlayed; after `gap` frames of silence the song in slot `to` starts on the next sample. */
    handoff(slot,{to,atPlayed,gap=0}){send({type:'handoff',slot,to,atPlayed,gap});},
    cancelHandoff(){send({type:'cancel-handoff'});},
    resume:()=>context.resume(),
    suspend:()=>context.suspend(),
    dispose(){
      if(disposed)return;disposed=true;workers.forEach(w=>w.terminate());
      clock.port.postMessage({type:'dispose'});clock.disconnect();node.disconnect();context.close().catch(()=>{});
    },
  };
}
