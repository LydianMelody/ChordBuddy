import test from 'node:test';
import assert from 'node:assert/strict';
import {WsolaStretcher,MIN_RATE,MAX_RATE} from '../chordbuddy/web/time-stretch.js';

const FS=44100,F=440,AMP=.5;
// A source whose frame number is known, so positions can be checked: left is a 440 Hz sine, right is a quieter copy.
function sineSource(start=0){
  let frame=start;const state={pulled:0};
  state.pull=(l,r,n)=>{const first=frame;for(let i=0;i<n;i++){const v=AMP*Math.sin(2*Math.PI*F*(frame+i)/FS);l[i]=v;r[i]=.8*v;}frame+=n;state.pulled+=n;return first;};
  return state;
}
function run(stretcher,frames,chunk=128){
  const out=new Float32Array(frames),right=new Float32Array(frames),l=new Float32Array(chunk),r=new Float32Array(chunk);
  for(let i=0;i<frames;i+=chunk){const n=Math.min(chunk,frames-i);stretcher.render(l.subarray(0,n),r.subarray(0,n));out.set(l.subarray(0,n),i);right.set(r.subarray(0,n),i);}
  return {left:out,right};
}
const hz=(x,from=4096)=>{let crossings=0,first=-1,last=-1;for(let i=from+1;i<x.length;i++)if(x[i-1]<=0&&x[i]>0){crossings++;if(first<0)first=i;last=i;}return crossings>1?(crossings-1)*FS/(last-first):0;};
const rms=x=>Math.sqrt(x.reduce((a,v)=>a+v*v,0)/x.length);
const maxStep=(x,from=4096)=>{let m=0;for(let i=from+1;i<x.length;i++)m=Math.max(m,Math.abs(x[i]-x[i-1]));return m;};
const THEORETICAL_STEP=AMP*2*Math.PI*F/FS;   // fastest a clean 440 Hz sine ever moves between samples

test('at rate 1 the output is the input: same samples, no delay, both channels', () => {
  const src=sineSource(),s=new WsolaStretcher({pull:src.pull});s.setRate(1);
  const {left,right}=run(s,30000);
  let worst=0;for(let i=0;i<left.length;i++){worst=Math.max(worst,Math.abs(left[i]-AMP*Math.sin(2*Math.PI*F*i/FS)),Math.abs(right[i]-.8*AMP*Math.sin(2*Math.PI*F*i/FS)));}
  assert.ok(worst<1e-5,'worst error '+worst);
});

for(const rate of [MIN_RATE,.75,.9,1.1,1.25]){
  test(`rate ${rate}: pitch stays at 440 Hz, level stays put, and the sound is smooth`, () => {
    const src=sineSource(),s=new WsolaStretcher({pull:src.pull});s.setRate(rate);
    const {left}=run(s,FS*3);
    const f=hz(left);assert.ok(Math.abs(f-F)/F<.012,`pitch ${f.toFixed(2)} Hz`);
    const level=rms(left.subarray(4096))/(AMP/Math.SQRT2);assert.ok(level>.93&&level<1.07,`level ratio ${level.toFixed(3)}`);
    const step=maxStep(left);assert.ok(step<THEORETICAL_STEP*1.25,`largest sample step ${step.toFixed(4)} vs ${THEORETICAL_STEP.toFixed(4)}`);
  });
  test(`rate ${rate}: consumes input at that rate and reports the matching source position`, () => {
    const src=sineSource(),s=new WsolaStretcher({pull:src.pull});s.setRate(rate);
    run(s,FS*2);
    const expected=FS*2*rate;
    assert.ok(Math.abs(s.currentSourceFrame()-expected)<400,`position ${s.currentSourceFrame()} vs ${expected}`);
    assert.ok(Math.abs(src.pulled-expected)<4500,`pulled ${src.pulled} vs ${expected}`);   // read-ahead is bounded by the window + search range
  });
}

test('changing speed while playing stays smooth and in tune', () => {
  const src=sineSource(),s=new WsolaStretcher({pull:src.pull});const parts=[];
  for(const rate of [1,.75,1.25,.5,1]){s.setRate(rate);parts.push(run(s,FS).left);}
  const all=new Float32Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){all.set(p,at);at+=p.length;}
  assert.ok(maxStep(all)<THEORETICAL_STEP*1.4,'step '+maxStep(all));
  assert.ok(Math.abs(hz(all.subarray(FS*4))-F)/F<.015);
});

test('a source position that jumps (a loop wrapping) is followed by the position map', () => {
  // The pull callback reports where each block came from, so a wrap shows up as a jump in the mapped source frame.
  let frame=1000,block=0;const pull=(l,r,n)=>{for(let i=0;i<n;i++){l[i]=r[i]=0;}const first=frame;block++;frame+=n;if(frame>=3000)frame=1000;return first;};
  const s=new WsolaStretcher({pull});s.setRate(1);run(s,20000);
  const at=s.currentSourceFrame();assert.ok(at>=1000&&at<3000,'mapped source '+at);
});

test('speed outside 50%..125% is rejected', () => {
  const s=new WsolaStretcher({pull:sineSource().pull});
  for(const bad of [.49,1.26,NaN,Infinity,0,-1])assert.throws(()=>s.setRate(bad),/between 50% and 125%/);
  s.setRate(MIN_RATE);s.setRate(MAX_RATE);
});

test('reset starts cleanly from silence with no leftover from the previous stream', () => {
  const src=sineSource(),s=new WsolaStretcher({pull:src.pull});s.setRate(.75);run(s,20000);
  const second=sineSource(5000);s.pull=second.pull;s.setRate(1);s.reset();
  const {left}=run(s,6000);
  let worst=0;for(let i=0;i<left.length;i++)worst=Math.max(worst,Math.abs(left[i]-AMP*Math.sin(2*Math.PI*F*(5000+i)/FS)));
  assert.ok(worst<1e-5,'after reset, worst error '+worst);
});

// Overlap-add of windows that have nothing to line up on (white noise) sums their power instead of their amplitude, so the level dips ~4 dB.
// That is inherent to WSOLA and mostly inaudible on real music (tonal and rhythmic content stays coherent); the guarantee is that it never collapses.
test('even pure noise keeps a usable level at every speed', () => {
  let seed=12345;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296*2-1;};
  for(const rate of [.5,.8,1.25]){
    let frame=0;const pull=(l,r,n)=>{for(let i=0;i<n;i++){l[i]=r[i]=.3*rand();}const first=frame;frame+=n;return first;};
    const s=new WsolaStretcher({pull});s.setRate(rate);const {left}=run(s,FS*2);
    const level=rms(left.subarray(8192))/(.3/Math.sqrt(3));assert.ok(level>.55&&level<1.15,`rate ${rate}: noise level ratio ${level.toFixed(3)}`);
  }
});
