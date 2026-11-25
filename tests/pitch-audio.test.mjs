import test from 'node:test';
import assert from 'node:assert/strict';
import {loadStretchEngine,SignalsmithStretcher,WsolaStretcher} from '../chordbuddy/web/time-stretch.js';
import {StemPlayer} from '../chordbuddy/web/pcm-player.js';
import {planChunk} from '../chordbuddy/web/pcm-stream.js';

// Pitch control's sound: the player moves the pitch through Signalsmith, separately from the speed, and keeps the stretcher running
// once a song's pitch has been touched so later changes are smooth.
const FS=44100,F=441,AMP=.5;
const sine=frame=>AMP*Math.sin(2*Math.PI*F*frame/FS);
function chunk(start,count){
  const data=new Float32Array(count*16);
  for(let i=0;i<count;i++){data[i*2]=sine(start+i);data[i*2+1]=sine(start+i);}
  return {generation:1,runId:'r',startFrame:start,frameCount:count,buffer:data.buffer};
}
// The stream keeps about two seconds queued, as the fetch worker does.
function make({total=FS*20,startFrame=0}={}){
  const player=new StemPlayer();player.reset({generation:1,runId:'r',startFrame,totalFrames:total,commonGain:1,loop:null});
  player.mixer.setMode('original');const plan={sentEnd:startFrame,frames:total,loop:null};
  player.topUp=()=>{while(player.mixer.queuedFrames<FS*2&&plan.sentEnd<total){const c=planChunk(plan);player.mixer.enqueue(chunk(c.startFrame,c.frameCount));plan.sentEnd=c.nextSentEnd;}};
  player.topUp();player.mixer.setPlaying(true);
  return player;
}
function render(player,frames){
  const out=new Float32Array(frames),l=new Float32Array(128),r=new Float32Array(128);
  for(let i=0;i<frames;i+=128){player.topUp?.();const n=Math.min(128,frames-i);player.render(l.subarray(0,n),r.subarray(0,n));out.set(l.subarray(0,n),i);}
  return out;
}
const hz=(x,from=8192)=>{let c=0,first=-1,last=-1;for(let i=from+1;i<x.length;i++)if(x[i-1]<=0&&x[i]>0){c++;if(first<0)first=i;last=i;}return c>1?(c-1)*FS/(last-first):0;};
const cents=(f,ref)=>1200*Math.log2(f/ref);

const loaded=await loadStretchEngine(FS);

test('the engine loaded (pitch needs it)', () => {assert.ok(loaded);});

for(const semitones of [-6,-3,-1,2,6]){
  test(`pitch ${semitones} at normal speed moves the tone by exactly that many half steps`, () => {
    const player=make();player.setPitch({semitones});
    assert.equal(player.stretcher,'signalsmith');assert.equal(player.pitchPending,false);
    const f=hz(render(player,FS*2));
    assert.ok(Math.abs(cents(f,F)-semitones*100)<5,`${f.toFixed(2)} Hz is ${cents(f,F).toFixed(1)} cents`);
  });
}

test('pitch and speed are separate: +3 at 75% speed is +3 half steps and plays at 75%', () => {
  const player=make();player.setRate(.75);player.setPitch({semitones:3});
  const out=render(player,FS*3),f=hz(out);
  assert.ok(Math.abs(cents(f,F)-300)<5,`${cents(f,F).toFixed(1)} cents`);
  const heard=player.sourceFrame;assert.ok(Math.abs(heard/(FS*3)-.75)<.02,`source advanced ${(heard/(FS*3)).toFixed(3)} of the output`);
});

test('a change while playing is smooth and takes effect without restarting the stretcher', () => {
  const player=make();player.setPitch({semitones:0,keep:true});
  const before=player.stretch;assert.ok(before instanceof SignalsmithStretcher,'kept running at pitch 0');
  const first=render(player,FS);assert.ok(Math.abs(cents(hz(first,4096),F))<5,'pitch 0 sounds at pitch 0');
  player.setPitch({semitones:2,keep:true});
  assert.equal(player.stretch,before,'same stretcher');
  const second=render(player,FS*2);
  assert.ok(Math.abs(cents(hz(second,FS),F)-200)<5,`${cents(hz(second,FS),F).toFixed(1)} cents after the change`);
  // no gap: the level never drops out around the change
  const level=x=>Math.sqrt(x.reduce((a,v)=>a+v*v,0)/x.length);
  for(let i=0;i<FS;i+=2048)assert.ok(level(second.subarray(i,i+2048))>AMP*.5,`level at ${i}`);
});

test('untouched songs play exactly as before: no stretcher at normal speed and pitch 0', () => {
  const player=make();player.setPitch({semitones:0,keep:false});
  assert.equal(player.stretching,false);
});

test('a song whose pitch was touched keeps the stretcher through a seek, even back at pitch 0', () => {
  const player=make();player.setPitch({semitones:0,keep:true});
  player.reset({generation:2,runId:'r',startFrame:FS,totalFrames:FS*20,commonGain:1,loop:null});
  assert.equal(player.stretching,true);
  player.setPitch({semitones:-2,keep:true});
  player.reset({generation:3,runId:'r',startFrame:0,totalFrames:FS*20,commonGain:1,loop:null});
  assert.equal(player.stretch.semitones,-2,'a seek keeps the pitch');
});

test('heard position stays right with pitch on (the playhead follows the sound)', () => {
  const player=make();player.setPitch({semitones:4});
  render(player,FS*4);
  const drift=player.sourceFrame-FS*4;
  assert.ok(Math.abs(drift)<FS*.15,`heard position is ${drift} frames from the output count (stretcher lag only)`);
  const later=(render(player,FS*4),player.sourceFrame-FS*8);
  assert.ok(Math.abs(later-drift)<200,`lag stays fixed: ${drift} then ${later}`);
});

test('only whole half steps from -6 to +6 are accepted', () => {
  const player=make();
  for(const bad of [7,-7,1.5,NaN,'2'])assert.throws(()=>player.setPitch({semitones:bad}),/half steps/,String(bad));
});

test('the simpler stretcher (before Signalsmith loads) reports the pitch as waiting, never pretends', () => {
  const player=make();player.setPitch({semitones:0,keep:true});
  player.stretch=new WsolaStretcher({pull:(l,r)=>player.mixer.pullMixed(l,r)});player.semitones=3;
  assert.equal(player.pitchPending,true);
  render(player,1024);   // Signalsmith is loaded here, so the player swaps to it on the next block
  assert.equal(player.stretcher,'signalsmith');assert.equal(player.pitchPending,false);
});

test('an L-loop with pitch on wraps seamlessly and the heard position stays inside the loop', () => {
  const loop={start:FS,end:FS*3};   // whole periods of the 441 Hz tone, so the source itself is seamless
  const player=new StemPlayer();player.reset({generation:1,runId:'r',startFrame:FS*1.5,totalFrames:FS*20,commonGain:1,loop});
  player.mixer.setMode('original');const plan={sentEnd:FS*1.5,frames:FS*20,loop};
  player.topUp=()=>{while(player.mixer.queuedFrames<FS){const c=planChunk(plan);player.mixer.enqueue(chunk(c.startFrame,c.frameCount));plan.sentEnd=c.nextSentEnd;}};
  player.topUp();player.mixer.setPlaying(true);player.setPitch({semitones:2,keep:true});
  const heard=[],parts=[];
  for(let i=0;i<60;i++){parts.push(render(player,4096));heard.push(player.sourceFrame);}
  const out=new Float32Array(parts.length*4096);parts.forEach((p,i)=>out.set(p,i*4096));
  const step=AMP*2*Math.PI*F*2**(2/12)/FS;let worst=0;for(let i=FS+1;i<out.length;i++)worst=Math.max(worst,Math.abs(out[i]-out[i-1]));
  assert.ok(worst<step*1.5,`largest step ${worst.toFixed(4)} vs a clean tone's ${step.toFixed(4)}`);
  assert.ok(heard.slice(4).every(f=>f>=loop.start-600&&f<=loop.end+600),`heard ${Math.min(...heard.slice(4))}..${Math.max(...heard.slice(4))}`);
  assert.ok(heard.slice(1).filter((f,i)=>f<heard[i]-FS/2).length>=3,'it wrapped at least three times');
  assert.ok(Math.abs(cents(hz(out,FS),F)-200)<5,'still +2 half steps');
});
