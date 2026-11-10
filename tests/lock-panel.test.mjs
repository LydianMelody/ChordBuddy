import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {createLockPanel} from '../chordbuddy/web/lock-panel.js';
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

function setup({song=null,job=null,snap={ready:false,readiness:''},engine={ready:true},checked=false}={}){
  const {$}=page(),model={state:{job,engine,songs:song?[song]:[]},readinessChecked:checked},view={song,snap,sections:0};
  $('lock-cta').append(new El('em'));
  const panel=createLockPanel({$,model,transport:{getSnapshot:()=>view.snap},element,currentSong:()=>view.song,renderSections:()=>{view.sections++;}});
  return {$,model,view,panel};
}

test('with no song open nothing is locked', () => {
  const {$,panel,view}=setup();panel.renderLock();
  assert.equal(panel.lockMode(),'none');assert.equal($('app').dataset.lock,'none');
  assert.ok(has($('nav-lock'),'hidden'));assert.ok(has($('lock-banner'),'hidden'));assert.ok(has($('locked-panel'),'hidden'));assert.equal(view.sections,0);
});

test('a song that was never analyzed gets the full panel: what to do, the four steps, and Analyze song', () => {
  const {$,panel,view}=setup({song:{id:'s',title:'Tek It',active_run:null}});panel.renderLock();
  assert.equal(panel.lockMode(),'full');assert.equal($('app').dataset.lock,'full');assert.equal(has($('locked-panel'),'hidden'),false);
  assert.equal($('lock-title').textContent,'Not analyzed yet');assert.match($('lock-copy').textContent,/needs to listen first/);
  assert.equal($('lock-steps').children.length,4);assert.ok($('lock-steps').children.every(step=>step.className==='step'));
  assert.equal($('lock-cta').querySelector('em').textContent,'Analyze song');assert.equal($('lock-cta').disabled,false);assert.ok(has($('lock-cta'),'hot'));
  assert.equal(view.sections,1,'the page is laid out again when the lock changes');
  panel.renderLock();assert.equal(view.sections,1);
});

test('while the analysis runs the panel follows its steps and offers Cancel; a failed one says so', () => {
  const song={id:'s',title:'Tek It',active_run:null};
  const {$,model,panel}=setup({song,job:{kind:'analysis',song_id:'s',status:'running',stage:'transcription',stages:{source:{status:'completed'},separation:{status:'completed'}}}});
  panel.renderLock();
  assert.equal($('lock-title').textContent,'Analyzing…');assert.equal($('lock-cta').querySelector('em').textContent,'Cancel analysis');assert.equal(has($('lock-cta'),'hot'),false);
  assert.deepEqual($('lock-steps').children.map(step=>step.className),['step done','step done','step active','step wait']);
  assert.ok($('lock-steps').children[2].children.some(n=>n.className==='bar-p'),'the running step has a progress bar');
  model.state.job={kind:'analysis',song_id:'s',status:'failed',error:'The model ran out of memory.',stages:{}};panel.renderLock();
  assert.equal($('lock-title').textContent,'Analysis did not finish');assert.equal($('lock-copy').textContent,'The model ran out of memory.');
  assert.equal($('lock-cta').querySelector('em').textContent,'Analyze again');
  model.state.job={kind:'analysis',song_id:'other',status:'running',stage:'source'};
  assert.equal(panel.analysisJobFor(song),null,'another song’s job is not this song’s');
});

test('without the transcription engine the button is off and says why', () => {
  const {$,panel}=setup({song:{id:'s',active_run:null},engine:{ready:false,message:'Install the engine first.'}});panel.renderLock();
  assert.equal($('lock-cta').disabled,true);assert.equal($('lock-cta').title,'Install the engine first.');
});

test('an analyzed song whose playback is not ready gets the banner, and nothing once it is ready', () => {
  const {$,panel,view}=setup({song:{id:'s',active_run:'r'},checked:true,snap:{ready:false,readiness:'The stems are missing.'}});panel.renderLock();
  assert.equal(panel.lockMode(),'banner');assert.equal(has($('lock-banner'),'hidden'),false);assert.equal(has($('nav-lock'),'hidden'),false);
  assert.equal($('lock-banner-text').textContent,'The stems are missing. Your chart is still here to view and edit.');assert.ok(has($('locked-panel'),'hidden'));
  view.snap={ready:true,readiness:''};panel.renderLock();
  assert.equal(panel.lockMode(),'none');assert.ok(has($('lock-banner'),'hidden'));assert.ok(has($('nav-lock'),'hidden'));
});

test('before the song’s readiness has been checked there is no banner yet', () => {
  const {panel}=setup({song:{id:'s',active_run:'r'},checked:false});assert.equal(panel.lockMode(),'none');
});

test('the panel’s button starts the analysis, or cancels the one that is running', () => {
  const {$,model,panel}=setup({song:{id:'s',active_run:null}});panel.wire();
  $('lock-cta').onclick();assert.equal($('transcribe').clicks,1);assert.equal($('cancel-job').clicks,undefined);
  model.state.job={kind:'analysis',song_id:'s',status:'running'};
  $('lock-cta').onclick();assert.equal($('transcribe').clicks,1);assert.equal($('cancel-job').clicks,1);
});
