import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {createJobPanel} from '../chordbuddy/web/job-panel.js';
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

function setup(job,songs=[{id:'s',title:'Tek It',active_run:'r'}]){
  const {$}=page(),calls=[],errors=[],model={state:{job,songs}};
  const panel=createJobPanel({$,model,api:async(path,body)=>{calls.push([path,body]);return {};},currentSong:()=>songs[0],refreshState:async()=>{calls.push(['refresh']);},showError:e=>errors.push(e)});
  return {$,model,panel,calls,errors};
}

test('a running analysis shows in the panel with Cancel and its progress', () => {
  const {$,panel}=setup({id:'j1',kind:'analysis',status:'running',stage:'transcription',progress:{completed:1,total:4}});
  $('job-panel').className='hidden';panel.renderJob();
  assert.equal(has($('job-panel'),'hidden'),false);assert.equal($('job-title').textContent,'Analyze song');assert.equal($('job-message').textContent,'transcription');
  assert.equal($('cancel-job').textContent,'Cancel');assert.ok(has($('cancel-job'),'btn-cancel'));assert.equal($('cancel-job').disabled,false);
  assert.equal($('job-progress').style.width,'25%');assert.equal(has($('job-progress'),'indeterminate'),false);
});

test('a rhythm correction has its own title, and a job without a count shows a moving bar', () => {
  const {$,panel}=setup({id:'j1',kind:'rhythm',status:'running',stage:'drums'});panel.renderJob();
  assert.equal($('job-title').textContent,'Drum-based rhythm correction');assert.ok(has($('job-progress'),'indeterminate'));assert.equal($('job-progress').style.width,'25%');
});

test('no job, a finished job and a dismissed job all hide the panel', () => {
  for(const job of [null,{id:'j',kind:'analysis',status:'completed'},{id:'j',kind:'separation',status:'cancelled'}]){
    const {$,panel}=setup(job);panel.renderJob();assert.ok(has($('job-panel'),'hidden'),JSON.stringify(job));
  }
  const failed={id:'j',kind:'analysis',status:'failed',stage:'chart',error:'Out of memory'},{$,model,panel}=setup(failed);
  panel.renderJob();assert.equal(has($('job-panel'),'hidden'),false);assert.equal($('job-message').textContent,'Out of memory');assert.equal($('cancel-job').textContent,'Dismiss');
  model.dismissedJob=panel.jobKey(failed);panel.renderJob();assert.ok(has($('job-panel'),'hidden'));
});

test('a separation names its song and fills the bar; an old-style job says what happened to the transcription', () => {
  let {$,panel}=setup({id:'j2',kind:'separation',status:'running',song_id:'s',message:'Splitting the stems',progress:{completed:1,total:2}});panel.renderJob();
  assert.equal($('job-title').textContent,'Separation — Tek It');assert.equal($('job-message').textContent,'Splitting the stems');assert.equal($('job-progress').style.width,'50%');
  assert.equal(has($('cancel-job'),'hidden'),false);
  ({$,panel}=setup({id:'j3',kind:'transcribe',status:'failed',song_id:'s',message:'Boom',windows:4,window:2}));panel.renderJob();
  assert.equal($('job-title').textContent,'Transcription failed · Tek It');assert.equal($('job-message').textContent,'Boom · Window 2 of 4');assert.ok(has($('cancel-job'),'hidden'));
});

test('Cancel asks the app to stop the right kind of job; on a job that has stopped it only dismisses the panel', async () => {
  let s=setup({id:'j1',kind:'analysis',status:'running',stage:'x'});s.panel.wire();await s.$('cancel-job').onclick();
  assert.deepEqual(s.calls,[['/api/analysis/j1/cancel',{}],['refresh']]);
  s=setup({id:'j2',kind:'separation',status:'running',song_id:'s'});s.panel.wire();await s.$('cancel-job').onclick();
  assert.deepEqual(s.calls,[['/api/separation/cancel',{job_id:'j2'}],['refresh']]);
  s=setup({id:'j3',kind:'transcribe',status:'running',song_id:'s'});s.panel.wire();await s.$('cancel-job').onclick();
  assert.deepEqual(s.calls,[['/api/cancel',{}],['refresh']]);
  const failed={id:'j4',kind:'analysis',status:'failed',stage:'chart'};s=setup(failed);s.panel.wire();await s.$('cancel-job').onclick();
  assert.deepEqual(s.calls,[]);assert.equal(s.model.dismissedJob,s.panel.jobKey(failed));assert.ok(has(s.$('job-panel'),'hidden'));
});
