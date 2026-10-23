import test from 'node:test';
import assert from 'node:assert/strict';
import {Transport,heardSeconds} from '../chordbuddy/web/transport.js';
class Audio{constructor(){this.events={};}addEventListener(k,f){this.events[k]=f;}pause(){}async play(){}load(){}removeAttribute(){}}
const manifest={run_id:'r',song_id:'s',frames:4410000,common_gain:1};   // 100 s
function fixture(){
  const calls=[],pcm={prime:async(...a)=>calls.push(['prime',...a]),play:v=>calls.push(['play',v]),mix:()=>{},mode:()=>{},dispose:()=>{},resume:async()=>{}};
  const transport=new Transport({audio:new Audio(),token:'t',createPcm:async()=>pcm});
  const load=async()=>{await transport.loadSong({songId:'s'});await transport.setReadiness({song_id:'s',ready:true,active:manifest});};
  return {transport,calls,load,primes:()=>calls.filter(c=>c[0]==='prime')};
}

test('a new song starts with no loop', async () => {
  const {transport,load}=fixture();await load();
  assert.deepEqual(transport.getSnapshot().loop,{enabled:false,start:null,end:null,implicit:false});
});

test('setting a loop while stopped is remembered and used by the next Play', async () => {
  const {transport,load,primes}=fixture();await load();
  await transport.setLoop({enabled:true,start:20,end:40});
  assert.equal(primes().length,0);assert.equal(transport.getSnapshot().loop.start,20);
  await transport.play();
  assert.deepEqual(primes()[0].slice(2),[0,{start:20*44100,end:40*44100}]);
});

test('setting a loop while playing re-primes at the same spot and keeps play intent', async () => {
  const {transport,load,primes}=fixture();await load();await transport.seek(25);await transport.play();
  await transport.setLoop({enabled:true,start:20,end:40});
  assert.equal(primes().length,2);
  assert.deepEqual(primes()[1].slice(2),[25*44100,{start:20*44100,end:40*44100}]);
  assert.equal(transport.getSnapshot().playIntent,true);
});

test('setLoop can also move playback to the loop start in one step', async () => {
  const {transport,load,primes}=fixture();await load();await transport.seek(70);await transport.play();
  await transport.setLoop({enabled:true,start:20,end:40},{seekTo:20});
  assert.equal(primes().length,2);assert.equal(primes()[1][2],20*44100);assert.equal(transport.getSnapshot().playIntent,true);
});

test('setting a loop while paused does not start playback, but can still move the position', async () => {
  const {transport,load,primes}=fixture();await load();
  await transport.setLoop({enabled:true,start:20,end:40},{seekTo:20});
  assert.equal(primes().length,0);assert.equal(transport.getSnapshot().seconds,20);assert.equal(transport.getSnapshot().playIntent,false);
});

test('turning the loop off re-primes without a loop; a disabled loop keeps its range for later', async () => {
  const {transport,load,primes}=fixture();await load();await transport.play();
  await transport.setLoop({enabled:true,start:20,end:40});
  await transport.setLoop({enabled:false,start:20,end:40});
  assert.equal(primes().at(-1)[3],null);
  assert.deepEqual([transport.getSnapshot().loop.start,transport.getSnapshot().loop.end],[20,40]);
});

test('a loop must be a real range inside the song', async () => {
  const {transport,load}=fixture();await load();
  for(const bad of [{enabled:true,start:40,end:20},{enabled:true,start:10,end:10},{enabled:true,start:-1,end:5},{enabled:true,start:90,end:200},{enabled:true,start:NaN,end:5},{enabled:true}])
    await assert.rejects(transport.setLoop(bad),/loop/i);
  assert.equal(transport.getSnapshot().loop.enabled,false);
});

test('clearing the loop, and changing song, both reset it', async () => {
  const {transport,load}=fixture();await load();
  await transport.setLoop({enabled:true,start:20,end:40});await transport.setLoop(null);
  assert.deepEqual(transport.getSnapshot().loop,{enabled:false,start:null,end:null,implicit:false});
  await transport.setLoop({enabled:true,start:20,end:40});await transport.loadSong({songId:'t'});
  assert.equal(transport.getSnapshot().loop.enabled,false);
});

test('a loop that reaches past the end of the streamed audio is clipped to it', async () => {
  const {transport,load,primes}=fixture();await load();
  await transport.setLoop({enabled:true,start:90,end:100});await transport.play();
  assert.equal(primes()[0][3].end,4410000);
});

// What is heard: the engine's frame less what is still on its way to the speakers, never before where playback started, and just after
// a loop wraps, the end of the loop still sounding (not the bars before the loop: that made a section loop follow itself backwards).
test('the playhead never reads earlier than where playback started, nor before a loop it has just wrapped', () => {
  const f=s=>Math.round(s*44100),loop={start:52,end:79};
  const at=(seconds,played,latency=.03,state='playing')=>({sourceFrame:f(seconds),played:f(played),latency,state});
  assert.equal(+heardSeconds(at(52.01,.01),{start:52,loop}).toFixed(3),52,'starting at a section: not 30 ms before it');
  assert.equal(+heardSeconds(at(10.01,.01),{start:10,loop:null}).toFixed(3),10);
  assert.equal(+heardSeconds(at(60,8),{start:52,loop}).toFixed(3),59.97,'later on, the latency is taken off as before');
  assert.equal(+heardSeconds(at(52.02,27.02,.05),{start:52,loop}).toFixed(3),78.97,'just after the wrap: the loop end still sounding');
  assert.equal(+heardSeconds(at(52.2,27.2,.05),{start:52,loop}).toFixed(3),52.15);
  assert.equal(+heardSeconds(at(30,0,.03,'paused'),{start:30,loop:null}).toFixed(3),30,'paused: nothing in flight');
});

test('a seek that makes a listener start another handoff (a section loop following) keeps playing, with no superseded error', async () => {
  // like the real session: priming again cancels the request still waiting
  let pending=null;const calls=[];
  const pcm={prime:(...a)=>{calls.push(a);if(pending)pending.reject(Error('Playback request superseded'));return new Promise((resolve,reject)=>{pending={resolve,reject};setImmediate(()=>{if(pending?.resolve===resolve){pending=null;resolve();}});});},
    play:()=>{},mix:()=>{},mode:()=>{},rate:()=>{},dispose:()=>{},resume:async()=>{}};
  const transport=new Transport({audio:new Audio(),token:'t',createPcm:async()=>pcm});
  await transport.loadSong({songId:'s'});await transport.setReadiness({song_id:'s',ready:true,active:manifest});
  await transport.setLoop({enabled:true,start:0,end:10,implicit:true});await transport.play();
  let followed=false;
  transport.subscribe(s=>{if(!followed&&s.seeks===1){followed=true;transport.setLoop({enabled:true,start:40,end:60,implicit:true});}});
  await transport.seek(45);await new Promise(r=>setTimeout(r,20));
  const state=transport.getSnapshot();
  assert.equal(state.error,null);assert.equal(state.playIntent,true);assert.deepEqual([state.loop.start,state.loop.end],[40,60]);
  assert.deepEqual(calls.at(-1).slice(1),[45*44100,{start:40*44100,end:60*44100}],'the stream starts once more, at the seek, with the new loop');
});
