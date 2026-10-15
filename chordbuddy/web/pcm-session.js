// One worklet and fetch worker per song session. All stream messages are versioned.
export async function createPcmSession({token,onPosition,onError}){
 const context=new AudioContext({sampleRate:44100,latencyHint:'interactive'});
 if(context.sampleRate!==44100){await context.close();throw Error('This audio device cannot create the required 44.1 kHz stem player. Processed playback is unavailable on this device.');}
 let worker,node,clockNode,pending=null,version=0,runId=null,disposed=false;
 try{
  await context.audioWorklet.addModule('/pcm-worklet.js');
  node=new AudioWorkletNode(context,'stem-mixer',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
  clockNode=new AudioWorkletNode(context,'stem-clock',{numberOfInputs:1,numberOfOutputs:0});
  worker=new Worker('/pcm-fetch-worker.js',{type:'module'});
  const channel=new MessageChannel();
  worker.postMessage({type:'connect',port:channel.port1},[channel.port1]);
  node.port.postMessage({type:'connect',port:channel.port2},[channel.port2]);
  node.connect(context.destination);
 }catch(error){worker?.terminate();clockNode?.port.postMessage({type:'dispose'});clockNode?.disconnect();node?.disconnect();await context.close();throw error;}
 const rejectPending=()=>{if(pending){clearTimeout(pending.timer);pending.reject(Error('Playback request superseded'));pending=null;}};
 node.port.onmessage=event=>{
  const m=event.data;if(disposed||m.generation!==version||m.runId!==runId)return;
  if(m.type==='reset-ack'&&pending)pending.start();
  if(m.type==='ready'&&pending){clearTimeout(pending.timer);pending.resolve();pending=null;}
  if(m.type==='error'){rejectPending();onError(m.error);return;}
  if(m.type==='position')onPosition({...m,latency:context.outputLatency||context.baseLatency||0,contextState:context.state});
 };
 worker.onerror=event=>{rejectPending();onError(event.message||'Stem stream failed');};
 const send=(type,value)=>node.port.postMessage({type,value,generation:version,runId});
 return {
  async prime(manifest,startFrame,loop=null){
   rejectPending();version++;runId=manifest.run_id;
   const promise=new Promise((resolve,reject)=>{pending={resolve,reject,timer:setTimeout(()=>{pending=null;reject(Error('Stem audio buffering timed out'));},30000)};});
   const generation=version;
   pending.start=()=>{
    if(!pending||generation!==version)return;
    if(startFrame===manifest.frames){clearTimeout(pending.timer);pending.resolve();pending=null;return;}
    worker.postMessage({type:'load',generation,runId,startFrame,frames:manifest.frames,token,loop});
   };
   node.port.postMessage({type:'reset',generation:version,runId,startFrame,totalFrames:manifest.frames,commonGain:manifest.common_gain,loop});
   // Resume must happen before awaiting a worklet message.
   await context.resume();
   await promise;
  },
  resume:()=>context.resume(),play:value=>send('play',value),mix:value=>send('mix',value),mode:value=>send('mode',value),rate:value=>send('rate',value),
  dispose(){if(disposed)return;disposed=true;rejectPending();worker.terminate();clockNode.port.postMessage({type:'dispose'});clockNode.disconnect();node.disconnect();context.close().catch(()=>{});}
 };
}

