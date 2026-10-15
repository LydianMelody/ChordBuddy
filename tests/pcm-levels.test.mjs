import test from 'node:test';
import assert from 'node:assert/strict';
import {PcmMixer} from '../chordbuddy/web/pcm-mixer-core.js';
import {StemPlayer} from '../chordbuddy/web/pcm-player.js';

// Stem t (0..6) holds a constant 0.1*(t+1) on both channels; the "original" track is silent.
function chunk(count=40000){
  const data=new Float32Array(count*16),span=count*2;
  for(let t=0;t<7;t++)for(let i=0;i<count;i++){data[(t+1)*span+i*2]=.1*(t+1);data[(t+1)*span+i*2+1]=.1*(t+1);}
  return {generation:1,runId:'r',startFrame:0,frameCount:count,buffer:data.buffer};
}
function mixer(){
  const m=new PcmMixer();m.reset({generation:1,runId:'r',startFrame:0,totalFrames:100000,commonGain:1});m.setMode('stems');m.enqueue(chunk());m.setPlaying(true);return m;
}
const render=(m,n)=>{const l=new Float32Array(n),r=new Float32Array(n);m.render(l,r);return l;};
const close=(a,b,eps=1e-6)=>Math.abs(a-b)<eps;

test('each stem reports its own peak, scaled by fader, master and blend', () => {
  const m=mixer();render(m,1000);m.takeLevels();render(m,200);
  const levels=m.takeLevels();
  for(let t=0;t<7;t++)assert.ok(close(levels[t],.1*(t+1)),`stem ${t}: ${levels[t]}`);
  const mix={gains:[1,1,1,1,1,1,1],mutes:Array(7).fill(false),solos:Array(7).fill(false),master:.5};
  m.setMix({...mix,gains:[1,.5,1,1,1,1,1]});render(m,2000);m.takeLevels();render(m,100);
  const half=m.takeLevels();assert.ok(close(half[0],.05,1e-4),'master .5: '+half[0]);assert.ok(close(half[1],.05,1e-4),'fader .5 and master .5: '+half[1]);
});

test('reading the levels starts the next measurement from zero', () => {
  const m=mixer();render(m,1000);m.takeLevels();
  assert.deepEqual(m.takeLevels(),Array(7).fill(0));
});

test('muted stems, and stems silenced by a solo, read zero; a soloed stem keeps its level', () => {
  const m=mixer();
  m.setMix({gains:Array(7).fill(1),mutes:[false,true,false,false,false,false,false],solos:Array(7).fill(false),master:1});render(m,2000);m.takeLevels();render(m,100);
  const muted=m.takeLevels();assert.equal(muted[1],0);assert.ok(muted[0]>0);
  m.setMix({gains:Array(7).fill(1),mutes:Array(7).fill(false),solos:[false,false,false,true,false,false,false],master:1});render(m,2000);m.takeLevels();render(m,100);
  const solo=m.takeLevels();assert.ok(close(solo[3],.4,1e-4));assert.equal(solo[0],0);assert.equal(solo[6],0);
});

test('the stretched path measures levels the same way', () => {
  const p=new StemPlayer();p.reset({generation:1,runId:'r',startFrame:0,totalFrames:100000,commonGain:1});p.mixer.setMode('stems');p.mixer.enqueue(chunk());p.mixer.setPlaying(true);p.setRate(.75);
  const l=new Float32Array(128),r=new Float32Array(128);for(let i=0;i<10;i++)p.render(l,r);
  const levels=p.mixer.takeLevels();
  assert.ok(levels.every(v=>v>0)&&levels[6]>levels[0],'levels '+levels.join(','));
});

test('nothing is measured while stopped', () => {
  const m=mixer();m.setPlaying(false);render(m,500);
  assert.equal(Math.max(...m.takeLevels()),0);
});
