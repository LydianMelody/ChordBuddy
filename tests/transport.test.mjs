import test from 'node:test';
import assert from 'node:assert/strict';
import {Transport} from '../chordbuddy/web/transport.js';
class Audio {
 constructor(){this.currentTime=0;this.duration=100;this.paused=true;this.plays=0;this.events={};}
 addEventListener(k,f){this.events[k]=f;} pause(){this.paused=true;this.events.pause?.();}
 async play(){this.plays++;this.paused=false;this.events.play?.();}load(){}
}
const manifest={run_id:'r',song_id:'s',frames:4410000,common_gain:1};
function fixture(factory){
 const audio=new Audio(),calls=[],pcm={prime:async(...a)=>calls.push(['prime',...a]),play:v=>calls.push(['play',v]),mix:v=>calls.push(['mix',v]),mode:v=>calls.push(['mode',v]),dispose:()=>calls.push(['dispose']),resume:async()=>{}};
 const transport=new Transport({audio,token:'t',createPcm:factory||(async()=>pcm)});
 return {audio,calls,transport,load:async()=>{await transport.loadSong({songId:'s',originalUrl:'mp3'});await transport.setReadiness({song_id:'s',ready:true,active:manifest});}};
}
test('processed playback owns position, preserves mix, and never plays source',async()=>{
 const {audio,transport,calls,load}=fixture();await load();await transport.seek(12);
 const mix=transport.getSnapshot().mix;mix.master=.3;transport.setMix(mix);
 await transport.play();assert.equal(audio.plays,0);assert.equal(audio.paused,true);
 assert.equal(transport.getSnapshot().seconds,12);assert.equal(calls.find(c=>c[0]==='prime')[2],12*44100);
 audio.currentTime=88;audio.events.timeupdate?.();assert.equal(transport.getSnapshot().seconds,12);
 assert.deepEqual(transport.getSnapshot().mix,mix);
 await assert.rejects(transport.setMode('original'),/processed stems/i);
});
test('failed handoff stops honestly at same position and explicit retry uses stems',async()=>{
 let tries=0;const pcm={prime:async()=>{},play(){},mix(){},mode(){},dispose(){},resume:async()=>{}};
 const {audio,transport,load}=fixture(async()=>{if(++tries===1)throw Error('unsupported');return pcm;});
 await load();await transport.seek(5);await assert.rejects(transport.play(),/unsupported/);
 assert.equal(audio.plays,0);assert.equal(transport.getSnapshot().mode,'stems');assert.equal(transport.getSnapshot().seconds,5);
 assert.equal(transport.getSnapshot().playIntent,false);assert.equal(transport.getSnapshot().playing,false);assert.match(transport.getSnapshot().error,/unsupported/);
 await transport.play();assert.equal(tries,2);assert.equal(transport.getSnapshot().error,null);
});
test('late handoff cannot replace a new song',async()=>{
 let resolve;const {transport,load}=fixture(()=>new Promise(r=>resolve=r));await load();
 const switching=transport.play();await transport.loadSong({songId:'b',originalUrl:'b'});
 resolve({dispose(){},prime:async()=>{},resume:async()=>{},mix(){},mode(){},play(){}});
 await switching;assert.equal(transport.getSnapshot().songId,'b');assert.equal(transport.getSnapshot().ready,false);
});
test('seek during first priming supersedes old target and keeps play intent',async()=>{
 let complete;const starts=[],pcm={prime:async(m,frame)=>{starts.push(frame);if(starts.length===1)await new Promise(r=>complete=r);},play(){},mix(){},mode(){},dispose(){},resume:async()=>{}};
 const {transport,load}=fixture(async()=>pcm);await load();await transport.seek(5);
 const first=transport.play();await new Promise(r=>setImmediate(r));await transport.seek(20);complete();await first;
 assert.equal(transport.getSnapshot().seconds,20);assert.equal(starts.at(-1),20*44100);assert.equal(transport.getSnapshot().playIntent,true);
});
test('Original cannot replace processed mode during pending seek',async()=>{
 let finish,hold=false;const modes=[],pcm={prime:async()=>{if(hold)await new Promise(r=>finish=r);},resume:async()=>{},mix(){},play(){},mode:m=>modes.push(m),dispose(){}};
 const {transport,load}=fixture(async()=>pcm);await load();await transport.setMode('stems');
 hold=true;const seeking=transport.seek(20);await assert.rejects(transport.setMode('original'),/processed stems/i);finish();await seeking;
 assert.equal(transport.getSnapshot().mode,'stems');assert.equal(modes.at(-1),'stems');assert.equal(transport.getSnapshot().playIntent,false);
});
test('Pause wins over delayed context resume',async()=>{
 let finish,hold=false;const plays=[],pcm={prime:async()=>{},resume:async()=>{if(hold)await new Promise(r=>finish=r);},mix(){},play:v=>plays.push(v),mode(){},dispose(){}};
 const {transport,load}=fixture(async()=>pcm);await load();await transport.setMode('stems');
 hold=true;const playing=transport.play();transport.pause();finish();await playing;
 assert.equal(transport.getSnapshot().playIntent,false);assert.equal(plays.at(-1),false);
});
test('late resume cannot play a disposed song session',async()=>{
 let finish,hold=false;const plays=[],pcm={prime:async()=>{},resume:async()=>{if(hold)await new Promise(r=>finish=r);},mix(){},play:v=>plays.push(v),mode(){},dispose(){}};
 const {transport,load}=fixture(async()=>pcm);await load();await transport.setMode('stems');
 hold=true;const playing=transport.play();transport.dispose();finish();await playing;assert.notEqual(plays.at(-1),true);
});
test('late callbacks from a failed session cannot stop or move its retry',async()=>{
 const callbacks=[];const {audio,transport,load}=fixture(async options=>{callbacks.push(options);return {prime:async()=>{},resume:async()=>{},mix(){},play(){},mode(){},dispose(){}};});
 await load();await transport.seek(17);await transport.play();callbacks[0].onError('Network failed');
 assert.equal(transport.getSnapshot().playIntent,false);await transport.play();
 callbacks[0].onPosition({runId:'r',sourceFrame:44100,state:'playing'});callbacks[0].onError('Late error');
 assert.equal(transport.getSnapshot().seconds,17);assert.equal(transport.getSnapshot().error,null);assert.equal(transport.getSnapshot().playIntent,true);assert.equal(audio.plays,0);
 callbacks[1].onPosition({runId:'r',sourceFrame:18*44100,state:'playing',contextState:'running'});
 assert.equal(transport.getSnapshot().seconds,18);assert.equal(transport.getSnapshot().playing,true);
});
test('a song analyzed without stems plays its recording: the player is told to use the original track and the mixer waits',async()=>{
 const {transport,calls}=fixture();
 await transport.loadSong({songId:'s',originalUrl:'mp3'});
 await transport.setReadiness({song_id:'s',ready:true,active:{...manifest,run_id:'orig-s',stems:false}});
 assert.equal(transport.getSnapshot().stems,false);assert.equal(transport.getSnapshot().sourceRunId,'orig-s');assert.equal(transport.getSnapshot().ready,true);
 await transport.play();assert.equal(calls.filter(c=>c[0]==='mode').at(-1)[1],'original');
 // the stems arrive later: a different run, with the usual stems mode
 await transport.setReadiness({song_id:'s',ready:true,active:manifest});
 assert.equal(transport.getSnapshot().stems,true);assert.equal(transport.getSnapshot().sourceRunId,'r');
 await transport.play();assert.equal(calls.filter(c=>c[0]==='mode').at(-1)[1],'stems');
});
