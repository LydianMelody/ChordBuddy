import test from 'node:test';
import assert from 'node:assert/strict';
import {createPcmSession} from '../chordbuddy/web/pcm-session.js';
test('fetching a new generation waits for the renderer reset acknowledgement',async()=>{
 const saved={AudioContext:globalThis.AudioContext,AudioWorkletNode:globalThis.AudioWorkletNode,Worker:globalThis.Worker,MessageChannel:globalThis.MessageChannel};
 let node,worker;
 globalThis.AudioContext=class{constructor(){this.sampleRate=44100;this.audioWorklet={addModule:async()=>{}};}resume(){return Promise.resolve();}close(){return Promise.resolve();}};
 globalThis.AudioWorkletNode=class{constructor(ctx,name){if(name==='stem-mixer')node=this;this.port={postMessage(){},close(){}};}connect(){}disconnect(){}};
 globalThis.Worker=class{constructor(){worker=this;this.messages=[];}postMessage(m){this.messages.push(m);}terminate(){}};
 globalThis.MessageChannel=class{constructor(){this.port1={};this.port2={};}};
 let session;
 try{
  session=await createPcmSession({token:'t',onPosition(){},onError(){}});
  const priming=session.prime({run_id:'r',frames:44100,common_gain:1},0);
  await new Promise(r=>setImmediate(r));
  assert.equal(worker.messages.some(m=>m.type==='load'),false);
  node.port.onmessage({data:{type:'reset-ack',generation:1,runId:'r'}});
  assert.equal(worker.messages.some(m=>m.type==='load'),true);
  node.port.onmessage({data:{type:'ready',generation:1,runId:'r'}});
  await priming;
 }finally{session?.dispose();Object.assign(globalThis,saved);}
});

test('session owns a zero-output clock processor and releases it with the audio context',async()=>{
 const saved={AudioContext:globalThis.AudioContext,AudioWorkletNode:globalThis.AudioWorkletNode,Worker:globalThis.Worker,MessageChannel:globalThis.MessageChannel};
 const nodes=[];let closed=0,terminated=0;
 globalThis.AudioContext=class{constructor(){this.sampleRate=44100;this.audioWorklet={addModule:async()=>{}};}close(){closed++;return Promise.resolve();}};
 globalThis.AudioWorkletNode=class{constructor(ctx,name,options){Object.assign(this,{name,options,messages:[],connections:0,disconnected:false});this.port={postMessage:m=>this.messages.push(m),close(){}};nodes.push(this);}connect(){this.connections++;}disconnect(){this.disconnected=true;}};
 globalThis.Worker=class{postMessage(){}terminate(){terminated++;}};
 globalThis.MessageChannel=class{constructor(){this.port1={};this.port2={};}};
 let session;
 try{
  session=await createPcmSession({token:'t',onPosition(){},onError(){}});
  const clock=nodes.find(n=>n.name==='stem-clock');assert.ok(clock,'Silent playback needs a real-time automatic-pull node');
  assert.equal(clock.options.numberOfInputs,1);assert.equal(clock.options.numberOfOutputs,0);assert.equal(clock.connections,0);
  session.dispose();session.dispose();assert.equal(closed,1);assert.equal(terminated,1);
  assert.equal(clock.disconnected,true);assert.ok(clock.messages.some(m=>m.type==='dispose'));
 }finally{session?.dispose();Object.assign(globalThis,saved);}
});


test('unsupported device closes its context and never promises source fallback',async()=>{
 const old=globalThis.AudioContext;let closed=0;
 globalThis.AudioContext=class{constructor(){this.sampleRate=48000;}async close(){closed++;}};
 try{await assert.rejects(createPcmSession({}),error=>{assert.match(error.message,/44.1 kHz/);assert.doesNotMatch(error.message,/Original remains/);return true;});assert.equal(closed,1);}finally{globalThis.AudioContext=old;}
});
