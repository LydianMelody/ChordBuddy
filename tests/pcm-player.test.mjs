import test from 'node:test';
import assert from 'node:assert/strict';
import {PcmMixer,RAMP} from '../chordbuddy/web/pcm-mixer-core.js';
import {StemPlayer} from '../chordbuddy/web/pcm-player.js';
import {planChunk} from '../chordbuddy/web/pcm-stream.js';

const FS=44100,F=441,AMP=.5;   // 441 Hz has a period of exactly 100 samples, so loops of whole periods are seamless
const sine=frame=>AMP*Math.sin(2*Math.PI*F*frame/FS);
function chunk(start,count,generation=1,runId='r'){
  const data=new Float32Array(count*16);
  for(let i=0;i<count;i++){data[i*2]=sine(start+i);data[i*2+1]=sine(start+i);}
  return {generation,runId,startFrame:start,frameCount:count,buffer:data.buffer};
}
function make({total=600000,startFrame=0,loop=null,rate=1,feed=8}={}){
  const player=new StemPlayer();player.reset({generation:1,runId:'r',startFrame,totalFrames:total,commonGain:1,loop});
  player.mixer.setMode('original');const plan={sentEnd:startFrame,frames:total,loop};
  const send=n=>{for(let i=0;i<n;i++){const c=planChunk(plan);if(plan.sentEnd>=total&&!loop)break;player.mixer.enqueue(chunk(c.startFrame,c.frameCount));plan.sentEnd=c.nextSentEnd;}};
  send(feed);if(rate!==1)player.setRate(rate);
  return {player,send};
}
function render(player,frames,chunkSize=128){
  const out=new Float32Array(frames),l=new Float32Array(chunkSize),r=new Float32Array(chunkSize);
  for(let i=0;i<frames;i+=chunkSize){const n=Math.min(chunkSize,frames-i);player.render(l.subarray(0,n),r.subarray(0,n));out.set(l.subarray(0,n),i);}
  return out;
}
const STEP=AMP*2*Math.PI*F/FS;
const maxStep=(x,from=0)=>{let m=0;for(let i=from+1;i<x.length;i++)m=Math.max(m,Math.abs(x[i]-x[i-1]));return m;};
const hz=(x,from=4096)=>{let c=0,first=-1,last=-1;for(let i=from+1;i<x.length;i++)if(x[i-1]<=0&&x[i]>0){c++;if(first<0)first=i;last=i;}return c>1?(c-1)*FS/(last-first):0;};

test('at normal speed the player is exactly the plain mixer (the old behavior is untouched)', () => {
  const a=make(),b=new PcmMixer();b.reset({generation:1,runId:'r',startFrame:0,totalFrames:600000,commonGain:1});b.setMode('original');
  const plan={sentEnd:0,frames:600000,loop:null};for(let i=0;i<8;i++){const c=planChunk(plan);b.enqueue(chunk(c.startFrame,c.frameCount));plan.sentEnd=c.nextSentEnd;}
  a.player.mixer.setPlaying(true);b.setPlaying(true);
  const x=render(a.player,5000),y=new Float32Array(5000),r=new Float32Array(128);
  for(let i=0;i<5000;i+=128){const n=Math.min(128,5000-i),l=new Float32Array(n);b.render(l,r.subarray(0,n));y.set(l,i);}
  assert.deepEqual(x,y);assert.equal(a.player.stretching,false);
});

test('at 75% speed the pitch is unchanged and the source position advances at 75%', () => {
  const {player}=make({rate:.75});player.mixer.setPlaying(true);
  const out=render(player,FS*2);
  assert.ok(player.stretching);
  assert.ok(Math.abs(hz(out)-F)/F<.012,'pitch '+hz(out));
  assert.ok(maxStep(out,RAMP+4096)<STEP*1.25,'step '+maxStep(out,RAMP+4096));
  const expected=FS*2*.75;assert.ok(Math.abs(player.sourceFrame-expected)<600,`position ${player.sourceFrame} vs ${expected}`);
});

test('switching speed mid-playback carries on from the same spot without a jump in volume or position', () => {
  const {player}=make();player.mixer.setPlaying(true);
  const before=render(player,FS);const frameBefore=player.sourceFrame;
  player.setRate(.6);const after=render(player,FS);
  assert.ok(maxStep(after,64)<STEP*1.4,'step after switch '+maxStep(after,64));
  assert.ok(Math.abs(before.at(-1)-after[0])<STEP*3,'boundary jump '+Math.abs(before.at(-1)-after[0]));
  assert.ok(player.sourceFrame>frameBefore&&Math.abs(player.sourceFrame-(frameBefore+FS*.6))<700,'position '+player.sourceFrame);
});

test('pausing fades out smoothly, stays silent, and resuming continues from the same place', () => {
  const {player}=make({rate:.75});player.mixer.setPlaying(true);
  const run=render(player,20000);const at=player.sourceFrame;
  player.mixer.setPlaying(false);
  const fade=render(player,4000);
  assert.ok(maxStep(fade)<STEP*1.5,'click on pause '+maxStep(fade));
  assert.equal(Math.max(...fade.subarray(1500).map(Math.abs)),0);
  const frozen=player.sourceFrame;assert.ok(frozen>=at&&frozen-at<2000,'drift while pausing '+(frozen-at));
  assert.equal(player.state,'paused');
  player.mixer.setPlaying(true);const resumed=render(player,6000);
  assert.ok(maxStep(resumed)<STEP*1.5,'click on resume '+maxStep(resumed));
  assert.ok(player.sourceFrame>frozen&&player.sourceFrame-frozen<6000,'resume position '+(player.sourceFrame-frozen));
});

test('stretched playback reaches the end of the song, reports ended once heard, and stops', () => {
  const {player}=make({total:30000,rate:.5,feed:2});player.mixer.setPlaying(true);
  render(player,80000);
  assert.equal(player.state,'ended');assert.equal(player.mixer.playIntent,false);assert.ok(player.sourceFrame>=29999);
});

test('a loop wrapping while stretched stays seamless and the heard position stays inside the loop', () => {
  const loop={start:2000,end:6000};const {player,send}=make({total:600000,startFrame:2500,loop,rate:.75,feed:8});
  player.mixer.setPlaying(true);const heard=[];let out=[];
  for(let block=0;block<110;block++){out.push(...render(player,512));send(1);heard.push(player.sourceFrame);}
  const all=Float32Array.from(out);
  assert.ok(maxStep(all,RAMP+4096)<STEP*1.5,'step across wraps '+maxStep(all,RAMP+4096));
  assert.ok(heard.slice(8).every(f=>f>=2000-300&&f<=6000+300),'heard positions escaped the loop: '+Math.min(...heard.slice(8))+'..'+Math.max(...heard.slice(8)));
  const wraps=heard.slice(1).filter((f,i)=>f<heard[i]-1000).length;assert.ok(wraps>=3,'wraps '+wraps);
  assert.notEqual(player.state,'ended');
});

test('a seek or loop change (reset) keeps the chosen speed', () => {
  const {player}=make({rate:.8});assert.ok(player.stretching);
  player.reset({generation:2,runId:'r',startFrame:1000,totalFrames:600000,commonGain:1,loop:null});
  assert.ok(player.stretching);assert.equal(player.rate,.8);
  const normal=make();normal.player.setRate(1);assert.equal(normal.player.stretching,false);
});

test('only 50%..125% is accepted', () => {
  const {player}=make();for(const bad of [.4,1.3,NaN])assert.throws(()=>player.setRate(bad),/50% and 125%/);
  player.setRate(1.25);player.setRate(.5);
});
