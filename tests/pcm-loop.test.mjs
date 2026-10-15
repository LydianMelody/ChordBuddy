import test from 'node:test';
import assert from 'node:assert/strict';
import {PcmMixer,RAMP} from '../chordbuddy/web/pcm-mixer-core.js';
import {planChunk,loopEngaged,validLoop,CHUNK_FRAMES} from '../chordbuddy/web/pcm-stream.js';

// A chunk whose "original" left channel encodes its own source frame number, so playback order is visible in the output.
function chunk(start,count,generation=1,runId='r'){
  const data=new Float32Array(count*16);
  for(let i=0;i<count;i++){data[i*2]=(start+i)/10000;data[i*2+1]=(start+i)/10000;}
  return {generation,runId,startFrame:start,frameCount:count,buffer:data.buffer};
}
function streamInto(mixer,plan,chunks){
  for(let i=0;i<chunks;i++){const c=planChunk(plan);mixer.enqueue(chunk(c.startFrame,c.frameCount));plan.sentEnd=c.nextSentEnd;}
}
function start(loop,startFrame,total=10000){
  const mixer=new PcmMixer();mixer.reset({generation:1,runId:'r',startFrame,totalFrames:total,commonGain:1,loop});mixer.setMode('original');
  return mixer;
}
const render=(mixer,n)=>{const l=new Float32Array(n),r=new Float32Array(n);mixer.render(l,r);return l;};

test('planner: chunks end exactly on the loop end and the next one starts at the loop start', () => {
  const loop={start:100000,end:230000},plan={sentEnd:0,frames:500000,loop},starts=[];
  for(let i=0;i<9;i++){const c=planChunk(plan);starts.push([c.startFrame,c.startFrame+c.frameCount]);plan.sentEnd=c.nextSentEnd;}
  assert.deepEqual(starts[5],[220500,230000]);                 // short chunk lands on the loop end
  assert.equal(starts[6][0],100000);                            // then the stream wraps
  assert.ok(starts.every(([a,b])=>b-a<=CHUNK_FRAMES&&!(a<230000&&b>230000)));
});

test('planner: without a loop, or starting after its end, the stream never wraps', () => {
  const plain={sentEnd:0,frames:100000,loop:null};const a=planChunk(plain);assert.equal(a.nextSentEnd,a.frameCount);
  const after={sentEnd:300000,frames:500000,loop:{start:1000,end:2000}};assert.equal(planChunk(after).nextSentEnd,344100);
  assert.equal(loopEngaged({start:1,end:5},3),true);assert.equal(loopEngaged({start:1,end:5},5),false);assert.equal(loopEngaged(null,0),false);
});

test('loop validation rejects empty, reversed and out-of-song loops', () => {
  assert.equal(validLoop(null,100),true);assert.equal(validLoop({start:10,end:90},100),true);
  for(const bad of [{start:10,end:10},{start:50,end:10},{start:-1,end:5},{start:0,end:101},{start:.5,end:5}])assert.equal(validLoop(bad,100),false);
  assert.throws(()=>new PcmMixer().reset({generation:1,runId:'r',startFrame:0,totalFrames:100,commonGain:1,loop:{start:50,end:10}}),/Invalid PCM timeline/);
});

test('a looped mixer plays 500..2999 then wraps to 1000 with no gap, no silence and no duplicate', () => {
  const loop={start:1000,end:3000},mixer=start(loop,500),plan={sentEnd:500,frames:10000,loop};
  streamInto(mixer,plan,6);mixer.setPlaying(true);
  const total=RAMP+2500+2000*2+300,out=render(mixer,total);
  const expected=k=>k<2500?500+k:1000+((k-2500)%2000);
  for(let k=RAMP;k<total;k++)assert.ok(Math.abs(out[k]*10000-expected(k))<.5,`sample ${k}: got ${out[k]*10000}, want ${expected(k)}`);
  assert.equal(mixer.state,'playing');
});

test('the reported source frame wraps with the audio, and played counts every rendered frame', () => {
  const loop={start:1000,end:3000},mixer=start(loop,2500),plan={sentEnd:2500,frames:10000,loop};
  streamInto(mixer,plan,4);mixer.setPlaying(true);render(mixer,600);
  assert.equal(mixer.frame,1100);assert.equal(mixer.played,600);       // 500 frames to the end, then 100 into the loop
});

test('a looped mixer never reports ended, even when the loop ends exactly at the song end', () => {
  const loop={start:8000,end:10000},mixer=start(loop,8000),plan={sentEnd:8000,frames:10000,loop};
  streamInto(mixer,plan,3);mixer.setPlaying(true);render(mixer,4500);
  assert.notEqual(mixer.state,'ended');assert.equal(mixer.playIntent,true);
});

test('without a loop the mixer still ends at the song end', () => {
  const mixer=start(null,9000),plan={sentEnd:9000,frames:10000,loop:null};
  streamInto(mixer,plan,1);mixer.setPlaying(true);render(mixer,1200);
  assert.equal(mixer.state,'ended');
});

test('a loop that starts after its end is not engaged: the song plays straight through', () => {
  const loop={start:1000,end:2000},mixer=start(loop,5000),plan={sentEnd:5000,frames:10000,loop};
  streamInto(mixer,plan,1);mixer.setPlaying(true);const out=render(mixer,RAMP+1000);
  assert.ok(Math.abs(out[RAMP+500]*10000-(5000+RAMP+500))<.5);
});

test('chunks that straddle the loop end or arrive out of order are rejected', () => {
  const loop={start:1000,end:3000},mixer=start(loop,2000);
  assert.throws(()=>mixer.enqueue(chunk(2000,1500)),/loop end/);
  mixer.enqueue(chunk(2000,1000));                                       // ends exactly on the loop end
  assert.throws(()=>mixer.enqueue(chunk(3000,500)),/contiguous/);        // must wrap to the loop start
  mixer.enqueue(chunk(1000,500));assert.equal(mixer.queuedFrames,1500);
});
