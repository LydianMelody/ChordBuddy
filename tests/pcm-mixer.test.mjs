import test from 'node:test';
import assert from 'node:assert/strict';
import {PcmMixer} from '../chordbuddy/web/pcm-mixer-core.js';
function block(start,count,values=Array(8).fill(0)){const data=new Float32Array(count*16);for(let t=0;t<8;t++)for(let f=0;f<count;f++){data[t*count*2+f*2]=values[t];data[t*count*2+f*2+1]=values[t];}return {generation:1,runId:'r',startFrame:start,frameCount:count,buffer:data.buffer};}
test('common clock mixes seven roles, applies gain once and excludes original',()=>{
 const m=new PcmMixer();m.reset({generation:1,runId:'r',startFrame:0,totalFrames:2000,commonGain:.1});
 m.enqueue(block(0,2000,[99,1,2,3,4,5,6,7]));m.setMode('stems');m.setPlaying(true);
 const left=new Float32Array(1000),right=new Float32Array(1000);m.render(left,right);
 assert.equal(m.frame,1000);assert.ok(Math.abs(left[999]-2.8)<1e-5);assert.equal(left[999],right[999]);
 m.setMix({gains:Array(7).fill(1),mutes:[false,false,false,false,false,true,false],solos:[false,false,false,false,false,true,true],master:1});
 m.render(left,right);assert.ok(Math.abs(left[499]-.7)<1e-5);assert.equal(m.frame,2000);
});
test('seek rejects stale chunks, no track advances on underrun',()=>{
 const m=new PcmMixer();m.reset({generation:2,runId:'r',startFrame:100,totalFrames:1000,commonGain:1});
 assert.equal(m.enqueue(block(0,200)),false);m.setPlaying(true);m.render(new Float32Array(128),new Float32Array(128));
 assert.equal(m.frame,100);assert.equal(m.state,'buffering');
});
test('queue refuses oversized payload and noncontiguous data',()=>{
 const m=new PcmMixer();m.reset({generation:1,runId:'r',startFrame:0,totalFrames:1000000,commonGain:1});
 assert.throws(()=>m.enqueue(block(1,20)),/contiguous/);
 assert.throws(()=>m.enqueue({...block(0,20),frameCount:30}),/length/);
});
test('pause freezes frame and chunks stay bounded through long playback',()=>{
 const m=new PcmMixer();m.reset({generation:1,runId:'r',startFrame:0,totalFrames:44100*60,commonGain:1});
 const out=new Float32Array(44100);
 for(let i=0;i<60;i++){m.enqueue(block(i*44100,44100));m.setPlaying(true);m.render(out,out);assert.ok(m.queuedFrames<=441000);}
 assert.equal(m.frame,44100*60);
 m.setPlaying(false);m.render(out,out);assert.equal(m.frame,44100*60);
});

test('starting an already-muted player emits no fade-in leak',()=>{
 const m=new PcmMixer();m.reset({generation:1,runId:'r',startFrame:0,totalFrames:1000,commonGain:.1});
 m.enqueue(block(0,1000,Array(8).fill(1)));m.setMix({gains:Array(7).fill(1),mutes:Array(7).fill(false),solos:Array(7).fill(false),master:0});m.setMode('stems');m.setPlaying(true);
 const left=new Float32Array(1000),right=new Float32Array(1000);m.render(left,right);
 assert.ok(left.every(x=>x===0));
});
