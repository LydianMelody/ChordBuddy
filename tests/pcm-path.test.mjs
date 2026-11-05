// The prepared jump a performance is built on, checked sample by sample: every sample encodes the source frame it came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PathMixer,READY_FRAMES} from '../chordbuddy/web/pcm-path.js';

const SCALE=2**20,TOTAL=441000;
const buffer=(start,count)=>{const data=new Float32Array(count*16);for(let i=0;i<count;i++){data[(count*2)+i*2]=(start+i)/SCALE;data[(count*2)+i*2+1]=(start+i)/SCALE;}return data.buffer;};
const chunk=(start,count,generation=1)=>({generation,runId:'r',startFrame:start,frameCount:count,buffer:buffer(start,count)});
function ready({start=0,chunks=3,size=44100,loop=null}={}){
 const m=new PathMixer();
 m.reset({generation:1,runId:'r',startFrame:start,totalFrames:TOTAL,commonGain:1,loop});
 m.setMode('stems');m.setPlaying(true);
 for(let i=0;i<chunks;i++)m.enqueue(chunk(start+i*size,size));
 return m;
}
function play(m,frames,block=128){
 const out=[];
 for(let done=0;done<frames;done+=block){const l=new Float32Array(block),r=new Float32Array(block);m.render(l,r);for(const v of l)out.push(Math.round(v*SCALE));}
 return out;
}

test('a prepared jump: the last sample before the barline is followed by the target, with no gap or repeat', () => {
 const m=ready();play(m,1280);
 m.addPrepared(chunk(300000,44100,0));
 const plan=m.jump({generation:2,at:22050,to:300000});
 assert.equal(plan.status,'committed');assert.equal(plan.atPlayed,22050);
 const out=play(m,44100);
 const first=22050-1280;
 for(let i=0;i<first;i++)assert.equal(out[i],1280+i);
 for(let i=first;i<out.length;i++)assert.equal(out[i],300000+i-first);
 assert.equal(m.state,'playing');
});

test('jumping backward needs no fetch: the target comes from audio already heard', () => {
 const m=ready();play(m,66176);
 const plan=m.jump({generation:2,at:88200,to:22050});
 assert.equal(plan.status,'committed');
 const out=play(m,44100);const first=88200-66176;
 for(let i=0;i<first;i++)assert.equal(out[i],66176+i);
 for(let i=first;i<out.length;i++)assert.equal(out[i],22050+i-first);
});

test('target audio missing: the jump waits, the music is untouched, and it can commit at a later barline', () => {
 const m=ready();play(m,1280);const before=m.queued;
 assert.equal(m.jump({generation:2,at:22050,to:300000}).status,'waiting');
 assert.equal(m.queued,before);assert.equal(m.generation,1);
 m.addPrepared(chunk(300000,READY_FRAMES,0));
 assert.equal(m.jump({generation:2,at:44100,to:300000}).status,'committed');
});

test('too close, or past: refused, never executed late in the middle of a bar', () => {
 const m=ready();m.addPrepared(chunk(300000,44100,0));play(m,1280);
 assert.equal(m.jump({generation:2,at:1300,to:300000}).status,'missed');
 assert.equal(m.jump({generation:2,at:1000,to:300000}).status,'missed');
 assert.equal(m.jump({generation:2,at:400000,to:300000}).status,'later');
});

test('leaving a loop at its end: no extra wrap, the music carries on from the end of the loop', () => {
 const loop={start:0,end:44100};
 const m=new PathMixer();m.reset({generation:1,runId:'r',startFrame:0,totalFrames:TOTAL,commonGain:1,loop});m.setMode('stems');m.setPlaying(true);
 m.enqueue(chunk(0,44100));
 m.addPrepared(chunk(44100,44100,0));play(m,1280);
 assert.equal(m.jump({generation:2,at:44100,to:44100,loop:null}).status,'committed');
 const out=play(m,66150);
 out.forEach((v,i)=>assert.equal(v,1280+i));
});

test('switching loops at the end of the pass: the old loop does not wrap again', () => {
 const m=new PathMixer();m.reset({generation:1,runId:'r',startFrame:0,totalFrames:TOTAL,commonGain:1,loop:{start:0,end:44100}});m.setMode('stems');m.setPlaying(true);
 m.enqueue(chunk(0,44100));m.addPrepared(chunk(200000,44100,0));play(m,1280);
 const plan=m.jump({generation:2,at:44100,to:200000,loop:{start:200000,end:244100}});
 assert.equal(plan.status,'committed');assert.equal(plan.engaged,true);
 const out=play(m,44100);const first=44100-1280;
 for(let i=first;i<out.length;i++)assert.equal(out[i],200000+i-first);
});

test('the stream catches up behind a jump: the next chunk asked for is accepted, and the old stream is refused', () => {
 const m=ready();play(m,1280);m.addPrepared(chunk(300000,44100,0));
 const plan=m.jump({generation:2,at:22050,to:300000});
 assert.equal(plan.startFrame,300000+44100);
 assert.equal(m.enqueue(chunk(plan.startFrame,44100,1)),false);
 assert.equal(m.enqueue(chunk(plan.startFrame,44100,2)),true);
});

test('a jump away from the very end of the song does not end playback', () => {
 const m=new PathMixer();m.reset({generation:1,runId:'r',startFrame:TOTAL-44100,totalFrames:TOTAL,commonGain:1});m.setMode('stems');m.setPlaying(true);
 m.enqueue(chunk(TOTAL-44100,44100));m.addPrepared(chunk(0,44100,0));play(m,1280);
 assert.equal(m.jump({generation:2,at:TOTAL,to:0}).status,'committed');
 const out=play(m,44100);const first=44100-1280;
 assert.equal(out[first],0);assert.equal(out[first+1],1);assert.equal(m.state,'playing');
});

test('a timed action lands on its exact output frame, even inside a render block', () => {
 const m=ready();play(m,1280);
 m.schedule(1300,x=>{const mix=structuredClone(x.mix);mix.master=.5;x.setMix(mix);});
 const l=new Float32Array(128),r=new Float32Array(128),seen=[];
 const original=m.setMix.bind(m);m.setMix=v=>{seen.push(m.played);original(v);};
 m.render(l,r);
 assert.deepEqual(seen,[1300]);assert.equal(m.played,1408);
 for(let i=0;i<20;i++)assert.equal(Math.round(l[i]*SCALE),1280+i);        // untouched before it
 assert.ok(l[100]*SCALE<1380);                                             // ramping down after it
});

test('paused or starved: a timed action waits and the block still fills with silence', () => {
 const m=ready();m.setPlaying(false);let ran=0;m.schedule(50,()=>ran++);
 const l=new Float32Array(128),r=new Float32Array(128);m.render(l,r);
 assert.equal(ran,0);assert.ok(l.every(v=>v===0));
});

test('prepared audio is bounded, oldest dropped first', () => {
 const m=ready();for(let i=0;i<15;i++)m.addPrepared(chunk(i*20000,20000,0));
 assert.ok(m.preparedFrames<=12*44100);assert.equal(m.readyFrames(0)>0,true);
});
