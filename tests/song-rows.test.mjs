import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {createSongRows} from '../chordbuddy/web/song-rows.js';
import {element} from '../chordbuddy/web/app-helpers.js';
// A page small enough for these tests: compact-dom's Node with the few extras this module touches, and $(id) making each element on first use.
class El extends Node{
  constructor(tag){super(tag);this.listeners={};this.classList.contains=n=>this.className.split(' ').includes(n);this.style.setProperty=(k,v)=>{this.style[k]=v;};}
  append(...nodes){super.append(...nodes.map(n=>{if(typeof n!=='string')return n;const t=new El('#text');t.textContent=n;return t;}));}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
  querySelectorAll(sel){return all(this).filter(n=>sel[0]==='.'?n.className.split(' ').includes(sel.slice(1)):n.tagName===sel);}
  click(){this.clicks=(this.clicks||0)+1;return this.onclick?.({target:this});}
  blur(){this.onblur?.();}
  set innerHTML(value){this.children=[];this.append(new El('svg'));}
  get firstChild(){return this.children[0];}
}
function page(){
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,new El());return nodes.get(id);};
  const doc={listeners:{},body:new El('body'),created:[],createElement:t=>{const n=new El(t);doc.created.push(n);return n;},createTextNode:t=>{const n=new El('#text');n.textContent=t;return n;},
    addEventListener:(type,fn)=>{(doc.listeners[type]||=[]).push(fn);},querySelectorAll:()=>doc.found||[]};
  globalThis.document=doc;
  return {$,doc};
}
const has=(n,c)=>n.className.split(' ').includes(c);
const tick=()=>new Promise(r=>setImmediate(r));

function setup(facts={a:{bpm:120,key:'C# minor'}}){
  const {doc}=page();
  return {doc,rows:createSongRows({songFacts:{get:id=>facts[id]||null},element})};
}

test('an analyzed song shows its tempo and key; anything else says what is going on', () => {
  const {rows}=setup();
  const line=rows.songLine({id:'a',status:'completed',active_run:'r'},false);
  assert.equal(line.className,'song-facts');assert.deepEqual(line.children.map(n=>n.className),['fact-badge tempo','fact-badge key']);
  assert.equal(line.children[0].textContent,'♩120');assert.equal(line.children[0].title,'120 beats per minute');
  assert.equal(line.children[1].textContent,'C♯m');assert.equal(line.children[1].title,'C# minor');
  const busy=rows.songLine({id:'a',status:'completed',active_run:'r'},true);assert.equal(busy.className,'song-note');assert.equal(busy.textContent,'Analyzing…');
  assert.equal(rows.songLine({id:'b',status:'imported',active_run:null},false).textContent,'Ready to analyze');
  assert.equal(rows.songLine({id:'b',status:'failed',active_run:null},false).textContent,'Transcription failed');
  assert.equal(rows.factBadges({id:'unknown'}).children.length,0,'no facts read yet: an empty box');
});

test('a song that just arrived, or just finished its analysis, is marked once; opening the app marks nothing', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  globalThis.CSS={escape:text=>text};
  const {doc,rows}=setup(),nodes={a:new El(),b:new El()},asked=[];
  doc.querySelectorAll=selector=>{asked.push(selector);const id=/data-song="(.*)"/.exec(selector)[1];return nodes[id]?[nodes[id]]:[];};
  const state=(songs,job=null)=>({songs,job});
  rows.noteArrivals(state([{id:'a',active_run:'r'}]));
  assert.equal(nodes.a.className,'');assert.deepEqual(asked,[]);
  rows.noteArrivals(state([{id:'a',active_run:'r'},{id:'b',active_run:null}],{song_id:'b',status:'running'}));
  assert.ok(has(nodes.b,'just-added'));assert.equal(nodes.a.className,'');assert.match(nodes.b.style['--touch-age'],/^-\d+ms$/);
  t.mock.timers.tick(1600);assert.equal(has(nodes.b,'just-added'),false,'the mark comes off when its animation is over');
});

test('a song goes from busy to ready: it glows once', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  globalThis.CSS={escape:text=>text};
  const {doc,rows}=setup(),node=new El();doc.querySelectorAll=()=>[node];
  rows.noteArrivals({songs:[{id:'zz',active_run:null}],job:{song_id:'zz',status:'running'}});
  rows.noteArrivals({songs:[{id:'zz',active_run:'r'}],job:null});
  assert.ok(has(node,'just-ready'));
});
