import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Transport} from '../chordbuddy/web/transport.js';
class Audio{constructor(){this.currentTime=0;this.duration=100;this.paused=true;this.volume=1;this.events={};}addEventListener(k,f){this.events[k]=f;}pause(){this.paused=true;this.events.pause?.();}async play(){this.paused=false;this.events.play?.();}load(){}}
const manifest={run_id:'r',song_id:'s',frames:4410000,common_gain:1};
const ready=(id='s',run='r')=>({song_id:id,ready:true,active:{...manifest,run_id:run,song_id:id},reason:'Ready'});
function fixture(factory){const audio=new Audio(),calls=[];const pcm={prime:async(...a)=>calls.push(['prime',...a]),play:v=>calls.push(['play',v]),mix:v=>calls.push(['mix',v]),mode:v=>calls.push(['mode',v]),dispose:()=>calls.push(['dispose']),resume:async()=>{}};return {audio,calls,transport:new Transport({audio,token:'t',createPcm:factory||(async()=>pcm)})};}
test('initial playback and underlying original actions remain locked until validated ready',async()=>{
 const {audio,transport}=fixture();await transport.loadSong({songId:'s',originalUrl:'mp3',separation:manifest});
 assert.equal(transport.getSnapshot().ready,false);await transport.play();
 await audio.play();assert.equal(audio.paused,true);assert.equal(transport.getSnapshot().playIntent,false);
 await transport.setReadiness({song_id:'s',ready:false,reason:'Analysis failed'});await transport.play();assert.equal(audio.paused,true);
});
test('ready attaches stems without autoplay or an adoption step, repeated poll retains mode and mix',async()=>{
 const {audio,calls,transport}=fixture();await transport.loadSong({songId:'s',originalUrl:'mp3'});await transport.setReadiness(ready());
 assert.equal(transport.getSnapshot().ready,true);assert.equal(transport.getSnapshot().mode,'stems');assert.equal(audio.paused,true);
 await transport.seek(12);const mix=transport.getSnapshot().mix;mix.mutes[2]=true;mix.master=.3;transport.setMix(mix);
 await transport.play();await assert.rejects(transport.setMode('original'),/processed stems/i);const count=calls.filter(x=>x[0]==='prime').length;
 await transport.setReadiness(ready());assert.equal(calls.filter(x=>x[0]==='prime').length,count);assert.equal(transport.getSnapshot().mode,'stems');assert.deepEqual(transport.getSnapshot().mix,mix);
});
test('reanalysis pauses and blocks, readiness restores same position and mix without autoplay',async()=>{
 const {transport}=fixture();await transport.loadSong({songId:'s',originalUrl:'mp3'});await transport.setReadiness(ready());await transport.seek(23);await transport.play();
 const mix=transport.getSnapshot().mix;mix.solos[1]=true;transport.setMix(mix);
 transport.blockPlayback('Analyzing');await transport.play();assert.equal(transport.getSnapshot().ready,false);assert.equal(transport.getSnapshot().playIntent,false);
 await transport.setReadiness(ready('s','new'));assert.equal(transport.getSnapshot().seconds,23);assert.deepEqual(transport.getSnapshot().mix,mix);assert.equal(transport.getSnapshot().playIntent,false);
});
test('late readiness or priming cannot unlock a different song',async()=>{
 let finish;const {transport}=fixture(()=>new Promise(r=>finish=r));await transport.loadSong({songId:'s',originalUrl:'mp3'});await transport.setReadiness(ready());
 const playing=transport.play();await new Promise(r=>setImmediate(r));await transport.loadSong({songId:'b',originalUrl:'b'});
 finish({dispose(){},prime:async()=>{},resume:async()=>{},play(){},mix(){},mode(){}});await playing;await transport.setReadiness(ready());
 assert.equal(transport.getSnapshot().songId,'b');assert.equal(transport.getSnapshot().ready,false);assert.equal(transport.getSnapshot().playIntent,false);
});
test('a new readiness revision cancels deferred resume and never autoplays',async()=>{
 let finish,hold=false;const plays=[];const pcm={prime:async()=>{},resume:async()=>{if(hold)await new Promise(r=>finish=r);},play:v=>plays.push(v),mix(){},mode(){},dispose(){}};
 const {transport}=fixture(async()=>pcm);await transport.loadSong({songId:'s',originalUrl:'mp3'});await transport.setReadiness(ready());await transport.play();transport.pause();hold=true;
 const playing=transport.play();transport.blockPlayback('Analyzing');finish();await playing;
 assert.equal(transport.getSnapshot().ready,false);assert.notEqual(plays.at(-1),true);
});
test('replacement readiness waits for explicit Play on processed stems',async()=>{
 const {transport,calls}=fixture();await transport.loadSong({songId:'s',originalUrl:'mp3'});await transport.setReadiness(ready());await transport.play();await assert.rejects(transport.setMode('original'),/processed stems/i);
 await transport.setReadiness(ready('s','new'));assert.equal(transport.getSnapshot().playIntent,false);assert.equal(transport.getSnapshot().mode,'stems');
 assert.equal(calls.filter(c=>c[0]==='prime').length,1);await transport.play();assert.equal(transport.getSnapshot().mode,'stems');
});
test('adoption button removed and player uses transport readiness',()=>{
 assert.doesNotMatch(readFileSync(new URL('../chordbuddy/web/mixer-rack.js',import.meta.url),'utf8'),/Use new result|useNewResult/);
 assert.match(readFileSync(new URL('../chordbuddy/web/player-view.js',import.meta.url),'utf8'),/s\.ready/);
});
import {PlaybackGate} from '../chordbuddy/web/playback-ready.js';
test('readiness response order and selection epochs reject stale responses',async()=>{
 const {transport}=fixture();await transport.loadSong({songId:'s',originalUrl:'mp3'});const pending=[];
 const gate=new PlaybackGate(transport,()=>new Promise(resolve=>pending.push(resolve)));
 const old=gate.refresh('s'),latest=gate.refresh('s');pending[1]({song_id:'s',ready:false,reason:'Analyzing'});await latest;pending[0](ready());await old;assert.equal(transport.getSnapshot().ready,false);
 const stale=gate.refresh('s');gate.block('New selection');await transport.loadSong({songId:'b',originalUrl:'b'});pending[2](ready());await stale;assert.equal(transport.getSnapshot().songId,'b');assert.equal(transport.getSnapshot().ready,false);
});
test('analysis admission invalidates outstanding readiness before the request settles',async()=>{
 const {transport}=fixture();await transport.loadSong({songId:'s',originalUrl:'mp3'});await transport.setReadiness(ready());
 let oldResolve,finish;let reads=0;const gate=new PlaybackGate(transport,async()=>{if(++reads===1)return await new Promise(r=>oldResolve=r);return {song_id:'s',ready:false,reason:'Analyzing'};});
 const old=gate.refresh('s');const starting=gate.analyze('s',()=>new Promise(r=>finish=r));oldResolve(ready());await old;assert.equal(transport.getSnapshot().ready,false);await gate.refresh('s');assert.equal(reads,1);finish();await starting;assert.equal(transport.getSnapshot().ready,false);
});
test('Original is rejected during priming without disrupting processed playback',async()=>{
 let finish;const pcm={prime:async()=>new Promise(r=>finish=r),resume:async()=>{},mix(){},mode(){},play(){},dispose(){}};
 const {transport}=fixture(async()=>pcm);await transport.loadSong({songId:'s',originalUrl:'mp3'});await transport.setReadiness(ready());
 const playing=transport.play();await new Promise(r=>setImmediate(r));await assert.rejects(transport.setMode('original'),/processed stems/i);finish();await playing;assert.equal(transport.getSnapshot().mode,'stems');
});
for(const paused of [false,true])test(`post-prime failure stops ${paused?'paused':'playing'} playback until explicit stem retry`,async()=>{
 let fail;let disposed=0;let primes=0;
 const {audio,transport}=fixture(async options=>{fail=options.onError;return {prime:async()=>primes++,resume:async()=>{},mix(){},mode(){},play(){},dispose:()=>disposed++};});
 await transport.loadSong({songId:'s',originalUrl:'mp3'});await transport.setReadiness(ready());await transport.seek(17);await transport.play();
 const mix=transport.getSnapshot().mix;mix.master=.25;mix.mutes[2]=true;transport.setMix(mix);if(paused)transport.pause();
 fail('Stem audio unavailable (500). Press Play to retry.');
 assert.equal(transport.active,false);assert.equal(transport.pcm,null);assert.equal(disposed,1);
 assert.equal(transport.getSnapshot().ready,true);assert.equal(transport.getSnapshot().mode,'stems');assert.match(transport.getSnapshot().error,/500/);
 assert.equal(transport.getSnapshot().seconds,17);assert.deepEqual(transport.getSnapshot().mix,mix);assert.equal(audio.paused,true);assert.equal(transport.getSnapshot().playIntent,false);
 await transport.play();assert.equal(primes,2);assert.equal(transport.getSnapshot().error,null);assert.equal(audio.paused,true);
 transport.blockPlayback('Analyzing');await transport.play();assert.equal(audio.paused,true);assert.equal(transport.getSnapshot().ready,false);
});
