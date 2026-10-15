import test from 'node:test';
import assert from 'node:assert/strict';
import {Transport} from '../chordbuddy/web/transport.js';
import {Node,installDom} from './compact-dom.mjs';
import {mountPlayer} from '../chordbuddy/web/player-view.js';
class Audio{constructor(){this.events={};}addEventListener(k,f){this.events[k]=f;}pause(){}async play(){}load(){}removeAttribute(){}}
const manifest={run_id:'r',song_id:'s',frames:4410000,common_gain:1};
function fixture(){
  const calls=[],pcm={prime:async()=>calls.push(['prime']),play:()=>{},mix:()=>{},mode:()=>{},rate:v=>calls.push(['rate',v]),dispose:()=>{},resume:async()=>{}};
  const transport=new Transport({audio:new Audio(),token:'t',createPcm:async()=>pcm});
  return {transport,calls,load:async()=>{await transport.loadSong({songId:'s'});await transport.setReadiness({song_id:'s',ready:true,active:manifest});}};
}

test('speed starts at 100% and is a transport setting visible to every view', async () => {
  const {transport,load}=fixture();await load();assert.equal(transport.getSnapshot().rate,100);
  await transport.setRate(75);assert.equal(transport.getSnapshot().rate,75);
});

test('the chosen speed reaches the audio engine on every (re)prime and when changed live', async () => {
  const {transport,calls,load}=fixture();await load();await transport.setRate(80);
  await transport.play();assert.deepEqual(calls.filter(c=>c[0]==='rate').at(-1),['rate',.8]);
  await transport.setRate(60);assert.deepEqual(calls.at(-1),['rate',.6]);
  await transport.seek(30);assert.deepEqual(calls.filter(c=>c[0]==='rate').at(-1),['rate',.6]);
});

test('speed outside 50%..125% is rejected and changes nothing', async () => {
  const {transport,load}=fixture();await load();
  for(const bad of [49,126,NaN,'fast'])await assert.rejects(transport.setRate(bad),/between 50% and 125%/);
  assert.equal(transport.getSnapshot().rate,100);
});

test('a new song resets speed to 100%', async () => {
  const {transport,load}=fixture();await load();await transport.setRate(70);await transport.loadSong({songId:'t'});
  assert.equal(transport.getSnapshot().rate,100);
});

test('the stepper is disabled when the transport cannot change speed, and steps by 5% when it can', async () => {
  installDom();
  const mount=transport=>{const root=new Node(),audio=new Node('audio');root.append(audio);audio.removeAttribute=()=>{};audio.after=n=>root.append(n);const q=root.querySelector.bind(root);root.querySelector=s=>s==='audio'?audio:q(s);
    const player=mountPlayer(root,transport,e=>{throw e;});return {root,player};};
  const base={ready:true,seconds:0,duration:40,playIntent:false,mix:{master:1},loop:{enabled:false,start:null,end:null},rate:100};
  const without=mount({getSnapshot:()=>base,subscribe:f=>{f(base);return()=>{};}});
  const speedButtons=root=>root.querySelectorAll('.speed')[0].children.filter(n=>n.tagName==='button');
  assert.ok(speedButtons(without.root).every(b=>b.disabled));
  const set=[];let state={...base};const listeners=[];
  const t={getSnapshot:()=>state,subscribe:f=>{listeners.push(f);f(state);return()=>{};},setRate:p=>{set.push(p);return Promise.resolve();}};
  const withRate=mount(t);const [slower,faster]=speedButtons(withRate.root);
  assert.ok(!slower.disabled&&!faster.disabled);slower.onclick();faster.onclick();assert.deepEqual(set,[95,105]);
  state={...base,rate:125};listeners.forEach(f=>f(state));assert.ok(faster.disabled);assert.ok(!slower.disabled);
  state={...base,rate:50};listeners.forEach(f=>f(state));assert.ok(slower.disabled);
});
