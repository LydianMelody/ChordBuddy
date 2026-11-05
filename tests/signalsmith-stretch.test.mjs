import test from 'node:test';
import assert from 'node:assert/strict';
import {loadStretchEngine,stretchEngine,createStretcher,SignalsmithStretcher,WsolaStretcher,MIN_RATE,MAX_RATE} from '../chordbuddy/web/time-stretch.js';
import {RAMP} from '../chordbuddy/web/pcm-mixer-core.js';
import {StemPlayer} from '../chordbuddy/web/pcm-player.js';
import {planChunk} from '../chordbuddy/web/pcm-stream.js';

// The practice-speed stretcher the app plays with: Signalsmith Stretch, driven from the worklet one block at a time.
const FS=44100,F=441,AMP=.5;   // 441 Hz has a period of exactly 100 samples, so loops of whole periods are seamless
const sine=frame=>AMP*Math.sin(2*Math.PI*F*frame/FS);
const STEP=AMP*2*Math.PI*F/FS;   // fastest a clean sine ever moves between samples
const maxStep=(x,from=0)=>{let m=0;for(let i=from+1;i<x.length;i++)m=Math.max(m,Math.abs(x[i]-x[i-1]));return m;};
const hz=(x,from=8192)=>{let c=0,first=-1,last=-1;for(let i=from+1;i<x.length;i++)if(x[i-1]<=0&&x[i]>0){c++;if(first<0)first=i;last=i;}return c>1?(c-1)*FS/(last-first):0;};
const rms=x=>Math.sqrt(x.reduce((a,v)=>a+v*v,0)/x.length);

const loaded=await loadStretchEngine(FS);

function source(make=sine,start=0){
  let frame=start;const state={pulled:0};
  state.pull=(l,r,n)=>{assert.equal(l.length,n);const first=frame;for(let i=0;i<n;i++){l[i]=make(frame+i);r[i]=.8*make(frame+i);}frame+=n;state.pulled+=n;return first;};
  return state;
}
function run(stretcher,frames,chunk=128){
  const out=new Float32Array(frames),right=new Float32Array(frames),l=new Float32Array(chunk),r=new Float32Array(chunk);
  for(let i=0;i<frames;i+=chunk){const n=Math.min(chunk,frames-i);stretcher.render(l.subarray(0,n),r.subarray(0,n));out.set(l.subarray(0,n),i);right.set(r.subarray(0,n),i);}
  return {left:out,right};
}

test('the engine loads, and the player then picks it over the simpler stretcher', () => {
  assert.ok(loaded);assert.equal(stretchEngine(),loaded);
  assert.ok(createStretcher({pull:source().pull}) instanceof SignalsmithStretcher);
});

for(const rate of [MIN_RATE,.75,.9,1,1.1,MAX_RATE]){
  test(`rate ${rate}: pitch stays put, level stays put, the sound is smooth, and both channels come through`, () => {
    const s=new SignalsmithStretcher({pull:source().pull,engine:loaded});s.setRate(rate);
    const {left,right}=run(s,FS*3);
    const f=hz(left);assert.ok(Math.abs(f-F)/F<.005,`pitch ${f.toFixed(2)} Hz`);
    const level=rms(left.subarray(8192))/(AMP/Math.SQRT2);assert.ok(level>.93&&level<1.07,`level ratio ${level.toFixed(3)}`);
    const balance=rms(right.subarray(8192))/rms(left.subarray(8192));assert.ok(Math.abs(balance-.8)<.02,`right/left ${balance.toFixed(3)}`);
    assert.ok(maxStep(left,8192)<STEP*1.1,`largest sample step ${maxStep(left,8192).toFixed(4)} vs ${STEP.toFixed(4)}`);
  });
}

test('the heard position matches the sound: clicks come out where the reported position says they are', () => {
  for(const rate of [.5,.75,1,1.25]){
    const clicks=f=>f>0&&f%11025===0?1:0;
    const s=new SignalsmithStretcher({pull:source(clicks,20000).pull,engine:loaded});s.setRate(rate);
    // the reported position just after each output frame, and where each click's loudest frame came out
    const l=new Float32Array(1),r=new Float32Array(1),frames=150000,out=new Float32Array(frames),reported=new Float64Array(frames);
    for(let i=0;i<frames;i++){s.render(l,r);out[i]=l[0];reported[i]=s.currentSourceFrame()-rate;}
    const errors=[];
    for(let i=0;i<frames;){
      if(out[i]<.15){i++;continue;}
      let peak=i;for(let k=i;k<Math.min(frames,i+1500);k++)if(out[k]>out[peak])peak=k;
      const heard=reported[peak];errors.push(heard-Math.round(heard/11025)*11025);i+=3000;
    }
    assert.ok(errors.length>=4,`rate ${rate}: clicks heard ${errors.length}`);
    assert.ok(errors.every(e=>Math.abs(e)<=60),`rate ${rate}: position off by ${errors.map(Math.round).join(', ')} frames`);
  }
});

test('starting (or seeking) plays from the spot right away, not after a gap', () => {
  const s=new SignalsmithStretcher({pull:source(sine,5000).pull,engine:loaded});s.setRate(.75);
  const {left}=run(s,6000);
  const firstSound=left.findIndex(v=>Math.abs(v)>.05);
  assert.ok(firstSound>=0&&firstSound<2500,'first sound at frame '+firstSound);
  assert.ok(Math.abs(s.currentSourceFrame()-(5000+6000*.75))<60,'position '+s.currentSourceFrame());
});

test('changing speed while playing stays smooth and in tune', () => {
  const s=new SignalsmithStretcher({pull:source().pull,engine:loaded});const parts=[];
  for(const rate of [1,.75,1.25,.5,1]){s.setRate(rate);parts.push(run(s,FS).left);}
  const all=new Float32Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){all.set(p,at);at+=p.length;}
  assert.ok(maxStep(all,8192)<STEP*1.2,'step '+maxStep(all,8192));
  assert.ok(Math.abs(hz(all.subarray(FS*4))-F)/F<.01);
});

test('a source position that jumps (a loop wrapping) is followed by the position map', () => {
  let frame=1000;const pull=(l,r,n)=>{l.fill(0);r.fill(0);const first=frame;frame+=n;if(frame>=3000)frame=1000;return first;};
  const s=new SignalsmithStretcher({pull,engine:loaded});run(s,20000);
  const at=s.currentSourceFrame();assert.ok(at>=1000&&at<3000+60,'mapped source '+at);
});

test('a new stretcher (a seek) starts clean, with nothing left over from the last stream', () => {
  const first=new SignalsmithStretcher({pull:source(f=>.9*Math.sin(f*.3)).pull,engine:loaded});first.setRate(.6);run(first,20000);
  const second=new SignalsmithStretcher({pull:source(()=>0).pull,engine:loaded});second.setRate(.6);
  const {left}=run(second,8000);assert.ok(Math.max(...left.map(Math.abs))<1e-4,'leftover '+Math.max(...left.map(Math.abs)));
});

test('the simpler stretcher is still there for when the engine is not loaded', () => {
  const s=new WsolaStretcher({pull:source().pull});s.setRate(.75);
  assert.ok(Math.abs(hz(run(s,FS*2).left,4096)-F)/F<.012);
});

// ----- the stem player, with the engine loaded (pcm-player.test.mjs covers it with the simpler stretcher) -----
function chunk(start,count){
  const data=new Float32Array(count*16);
  for(let i=0;i<count;i++){data[i*2]=sine(start+i);data[i*2+1]=sine(start+i);}
  return {generation:1,runId:'r',startFrame:start,frameCount:count,buffer:data.buffer};
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

test('player at 75%: Signalsmith plays, the pitch is unchanged and the position advances at 75%', () => {
  const {player}=make({rate:.75});player.mixer.setPlaying(true);
  const out=render(player,FS*2);
  assert.ok(player.stretch instanceof SignalsmithStretcher);
  assert.ok(Math.abs(hz(out)-F)/F<.005,'pitch '+hz(out));
  assert.ok(maxStep(out,RAMP+8192)<STEP*1.1,'step '+maxStep(out,RAMP+8192));
  const expected=FS*2*.75;assert.ok(Math.abs(player.sourceFrame-expected)<600,`position ${player.sourceFrame} vs ${expected}`);
});

test('player: pausing fades out smoothly and stays silent, and resuming carries on from the same place', () => {
  const {player}=make({rate:.75});player.mixer.setPlaying(true);
  render(player,20000);const at=player.sourceFrame;
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

test('player: stretched playback reaches the end of the song, reports ended once heard, and stops', () => {
  const {player}=make({total:30000,rate:.5,feed:2});player.mixer.setPlaying(true);
  render(player,80000);
  assert.equal(player.state,'ended');assert.equal(player.mixer.playIntent,false);assert.ok(player.sourceFrame>=29999);
});

test('player: a loop wrapping while stretched stays seamless and the heard position stays inside the loop', () => {
  const loop={start:2000,end:6000};const {player,send}=make({total:600000,startFrame:2500,loop,rate:.75,feed:8});
  player.mixer.setPlaying(true);const heard=[];const out=[];
  for(let block=0;block<110;block++){out.push(...render(player,512));send(1);heard.push(player.sourceFrame);}
  const all=Float32Array.from(out);
  assert.ok(maxStep(all,RAMP+8192)<STEP*1.5,'step across wraps '+maxStep(all,RAMP+8192));
  assert.ok(heard.slice(8).every(f=>f>=2000-300&&f<=6000+300),'heard positions escaped the loop: '+Math.min(...heard.slice(8))+'..'+Math.max(...heard.slice(8)));
  const wraps=heard.slice(1).filter((f,i)=>f<heard[i]-1000).length;assert.ok(wraps>=3,'wraps '+wraps);
  assert.notEqual(player.state,'ended');
});
