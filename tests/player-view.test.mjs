import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all,installDom} from './compact-dom.mjs';
import {mountPlayer} from '../chordbuddy/web/player-view.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(loadWaveform){installDom();const root=new Node(),audio=new Node('audio'),small=new Node('small');root.append(audio,small);audio.removeAttribute=k=>delete audio.attributes[k];audio.after=n=>root.append(n);const query=root.querySelector.bind(root);root.querySelector=s=>s==='audio'?audio:s==='.player-song small'?small:query(s);let state={ready:true,seconds:12,duration:40,playIntent:false,mix:{master:1}},seeks=[],plays=0,pauses=0;const listeners=[];const transport={getSnapshot:()=>state,subscribe:f=>{listeners.push(f);f(state);return()=>{};},seek:t=>{seeks.push(t);return Promise.resolve();},play:()=>{plays++;return Promise.resolve();},pause:()=>pauses++,setMix:m=>state.mix=m};const player=mountPlayer(root,transport,e=>{throw e;},{loadWaveform});player.setPractice({music:{measures:[]},viewport:{start:0,end:40},projection:{sections:[{id:'a',name:'Verse',start:0,end:10},{id:'b',name:'Chorus',start:10,end:30},{id:'c',name:'Outro',start:30,end:40}]}});return {root,audio,player,seeks,counts:()=>({plays,pauses}),setState:v=>{state={...state,...v};listeners.forEach(f=>f(state));}};}
test('mounted footer has one playback group and scrubber; section skip preserves intent',()=>{
 const {root,audio,player,seeks,setState,counts}=setup();assert.ok(audio.hidden);assert.equal(root.querySelectorAll('.shared-player-controls').length,1);assert.equal(root.querySelectorAll('.practice-scrubber').length,1);assert.equal(root.querySelectorAll('.player-play').length,1);const [previous,next]=root.querySelectorAll('.player-skip');previous.onclick();assert.equal(seeks.at(-1),10);setState({seconds:10.1});previous.onclick();assert.equal(seeks.at(-1),0);next.onclick();assert.equal(seeks.at(-1),30);assert.deepEqual(counts(),{plays:0,pauses:0});root.querySelector('.player-play').onclick();assert.equal(counts().plays,1);setState({playIntent:true});next.onclick();assert.equal(counts().pauses,0);root.querySelector('.player-play').onclick();assert.equal(counts().pauses,1);player.dispose();assert.equal(root.querySelector('.shared-player-controls'),null);
});
test('stale waveform success/failure cannot replace a newer song; sync load failures stay contained',async()=>{
 const requests={};const {root,player}=setup(run=>new Promise((resolve,reject)=>requests[run]={resolve,reject}));player.setWaveformRun('a');await tick();player.setWaveformRun('b');await tick();requests.b.resolve({run_id:'b',duration:40,peaks:[1]});await tick();assert.equal(root.querySelector('.practice-waveform-notice').textContent,'');requests.a.reject(Error('stale'));await tick();assert.equal(root.querySelector('.practice-waveform-notice').textContent,'');player.setWaveformRun('c');await tick();player.setWaveformRun(null);requests.c.resolve({run_id:'c',duration:40,peaks:[1]});await tick();assert.match(root.querySelector('.practice-waveform-notice').textContent,/after analysis/);player.dispose();const sync=setup(()=>{throw Error('offline');});assert.doesNotThrow(()=>sync.player.setWaveformRun('d'));await tick();assert.match(sync.root.querySelector('.practice-waveform-notice').textContent,/unavailable/);sync.player.dispose();
});

// The Loop button (and R, through toggleLoop) loops the section you are in; again ends the loop. The loop follows you when you seek
// into another section, but never because the playhead drifted a moment before the section's start.
test('the loop toggles on the current section and follows seeks, never playback drift',()=>{
 installDom();const root=new Node(),audio=new Node('audio');root.append(audio);audio.removeAttribute=k=>delete audio.attributes[k];audio.after=n=>root.append(n);
 const query=root.querySelector.bind(root);root.querySelector=s=>s==='audio'?audio:query(s);
 let state={ready:true,seconds:12,duration:40,playIntent:true,seeks:0,mix:{master:1},loop:{enabled:false,start:null,end:null,implicit:false}};const loops=[],listeners=[];
 const transport={getSnapshot:()=>state,subscribe:f=>{listeners.push(f);f(state);return()=>{};},seek:()=>Promise.resolve(),play:()=>Promise.resolve(),pause(){},
  setLoop:v=>{loops.push(v);state={...state,loop:v?{...v}:{enabled:false,start:null,end:null,implicit:false}};listeners.forEach(f=>f(state));return Promise.resolve();}};
 const player=mountPlayer(root,transport,e=>{throw e;},{});
 player.setPractice({music:{measures:[]},viewport:{start:0,end:40},projection:{sections:[{id:'a',name:'Verse',start:0,end:10},{id:'b',name:'Chorus',start:10,end:30},{id:'c',name:'Outro',start:30,end:40}]}});
 const set=v=>{state={...state,...v};listeners.forEach(f=>f(state));};
 player.toggleLoop();assert.deepEqual(loops.at(-1),{enabled:true,start:10,end:30,implicit:true,kind:'section'});
 set({seconds:9.97});assert.equal(loops.length,1,'a moment before the start, while playing: the loop stays');
 set({seconds:31,seeks:1});assert.deepEqual(loops.at(-1),{enabled:true,start:30,end:40,implicit:true,kind:'section'},'a seek into the outro moves it there');
 player.toggleLoop();assert.equal(loops.at(-1),null,'again: the loop ends');
 assert.deepEqual(player.sectionStarts(),[0,10,30]);
});

test('L loops four bars or the pass you are in; R and L swap, end their own loop, and end a loop whose handles you placed',()=>{
 installDom();const root=new Node(),audio=new Node('audio');root.append(audio);audio.removeAttribute=k=>delete audio.attributes[k];audio.after=n=>root.append(n);
 const query=root.querySelector.bind(root);root.querySelector=s=>s==='audio'?audio:query(s);
 let state={ready:true,seconds:13,duration:40,playIntent:true,seeks:0,mix:{master:1},loop:{enabled:false,start:null,end:null,implicit:false}};const loops=[],listeners=[];
 const transport={getSnapshot:()=>state,subscribe:f=>{listeners.push(f);f(state);return()=>{};},seek:()=>Promise.resolve(),play:()=>Promise.resolve(),pause(){},
  setLoop:(v,o)=>{loops.push(o?.seekTo!==undefined?{...v,seekTo:o.seekTo}:v);state={...state,loop:v?{...v}:{enabled:false,start:null,end:null,implicit:false}};listeners.forEach(f=>f(state));return Promise.resolve();}};
 const player=mountPlayer(root,transport,e=>{throw e;},{});
 const measures=Array.from({length:20},(_,i)=>({number:i+1,start:i*2,end:i*2+2,beats:[i*2,i*2+1]}));    // 2 s bars, sections 0-10, 10-30, 30-40
 const projection={sections:[{id:'a',name:'Verse',start:0,end:10},{id:'b',name:'Chorus',start:10,end:30},{id:'c',name:'Outro',start:30,end:40}],
  groups:[{sectionId:'b',folded:true,passes:[{start:22,end:26},{start:26,end:30}]}]};
 player.setPractice({music:{measures},viewport:{start:0,end:40},projection});
 const set=v=>{state={...state,...v};listeners.forEach(f=>f(state));};
 player.toggleLoop('bars');assert.deepEqual(loops.at(-1),{enabled:true,start:10,end:18,implicit:true,kind:'bars'},'bar 2 of the chorus: its bars 1-4');
 set({seconds:19,seeks:1});assert.deepEqual(loops.at(-1),{enabled:true,start:18,end:26,implicit:true,kind:'bars'},'a seek to its bar 5 moves it to 5-8');
 player.toggleLoop('section');assert.deepEqual(loops.at(-1),{enabled:true,start:10,end:30,implicit:true,kind:'section'},'R swaps it for the section');
 set({seconds:27,seeks:2});player.toggleLoop('section');assert.equal(loops.at(-1),null,'R again: off');
 player.toggleLoop('bars');assert.deepEqual(loops.at(-1),{enabled:true,start:26,end:30,implicit:true,kind:'bars'},'in a pass of a ×2 phrase: that pass');
 player.toggleLoop('bars');assert.equal(loops.at(-1),null,'L again: off');
 transport.setLoop({enabled:true,start:4,end:8});player.toggleLoop('bars');assert.equal(loops.at(-1),null,'over handles you placed, L ends the loop');
 transport.setLoop({enabled:true,start:4,end:8});set({seconds:2,seeks:3});assert.deepEqual(loops.at(-1),{enabled:true,start:4,end:8},'and a seek never moves it');
});
