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
 player.toggleLoop();assert.deepEqual(loops.at(-1),{enabled:true,start:10,end:30,implicit:true});
 set({seconds:9.97});assert.equal(loops.length,1,'a moment before the start, while playing: the loop stays');
 set({seconds:31,seeks:1});assert.deepEqual(loops.at(-1),{enabled:true,start:30,end:40,implicit:true},'a seek into the outro moves it there');
 player.toggleLoop();assert.equal(loops.at(-1),null,'again: the loop ends');
 assert.deepEqual(player.sectionStarts(),[0,10,30]);
});
