import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {createHistoryUi} from '../chordbuddy/web/history-ui.js';
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

const LABELS=['Analysis','Correct chord label','Move a barline'];
function setup({record={doc:{history:LABELS,cursor:2},dirty:false,saving:false},perform={history:null},draft=false}={}){
  const {$}=page(),went=[],model={pendingChart:null},view={record};
  const ui=createHistoryUi({$,model,practiceView:{hasDraft:()=>draft},performanceApp:perform,currentSong:()=>({title:'Tek It'}),currentRecord:()=>view.record,historyAction:(action,position)=>went.push([action,position])});
  return {$,ui,went,model,view,perform};
}
const buttons=node=>node.children.filter(n=>n.tagName==='button');

test('after an undo a note says what was undone, by name, with Redo to go back', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {$,ui,went}=setup();$('history-note').className='hidden';
  ui.noteHistory({cursor:2,history:LABELS},{cursor:1});
  assert.equal($('history-note-text').textContent,'Undid “Move a barline” in Tek It.');assert.equal($('history-note-back').textContent,'Redo');assert.equal(has($('history-note'),'hidden'),false);
  $('history-note-back').onclick();assert.deepEqual(went,[['goto',2]]);assert.ok(has($('history-note'),'hidden'));
  ui.noteHistory({cursor:0,history:LABELS},{cursor:2});
  assert.equal($('history-note-text').textContent,'Redid 2 changes in Tek It, up to “Move a barline”.');assert.equal($('history-note-back').textContent,'Undo');
  t.mock.timers.tick(8000);assert.ok(has($('history-note'),'hidden'),'the note leaves by itself');
  ui.noteHistory({cursor:1,history:LABELS},{cursor:1});assert.ok(has($('history-note'),'hidden'),'nothing moved: no note');
});

test('the History menu lists the steps to undo below Now and the ones to redo above it', () => {
  const {$,ui,went,view}=setup({record:{doc:{history:LABELS,cursor:1},dirty:false,saving:false}});
  ui.renderHistoryMenu();
  const pop=$('history-pop');
  assert.deepEqual(pop.children.map(n=>n.textContent),['Redo up to “Move a barline”1 step','Now','Undo “Correct chord label”1 step']);
  buttons(pop)[0].onclick();buttons(pop)[1].onclick();assert.deepEqual(went,[['goto',2],['goto',0]]);
  view.record={doc:{history:['Analysis'],cursor:0},dirty:false,saving:false};ui.renderHistoryMenu();
  assert.equal(pop.textContent,'No changes yet. Your edits show up here by name.');
  view.record={doc:{history:LABELS,cursor:2},dirty:true,saving:false};ui.renderHistoryMenu();
  assert.equal(pop.textContent,'Finish or save the edit you’re making first.');
});

test('on the Perform tab, Undo, Redo and History are the arrangement’s own', (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const steps=[],history={canUndo:true,canRedo:false,undoLabels:['Add a loop','Move a note'],redoLabels:[],go:n=>steps.push(n)};
  const {$,ui,went}=setup({perform:{history}});
  ui.syncPrepareHistory();
  assert.equal($('undo').disabled,false);assert.equal($('redo').disabled,true);assert.equal($('undo').dataset.tip,'Undo: Add a loop.');assert.equal($('redo').dataset.tip,'Put back what you just undid.');
  $('history-menu').open=true;ui.renderHistoryMenu();
  const pop=$('history-pop');
  assert.deepEqual(pop.children.map(n=>n.textContent),['Now','Undo “Add a loop”1 step','Undo back through “Move a note”2 steps']);
  buttons(pop)[1].onclick();assert.deepEqual(steps,[-2]);assert.equal($('history-menu').open,false);assert.deepEqual(went,[]);
  ui.notePrepareStep({undid:true,count:1,label:'Add a loop'});
  assert.equal($('history-note-text').textContent,'Undid “Add a loop”.');$('history-note-back').onclick();assert.deepEqual(steps,[-2,1]);
});

test('before the show system exists (its history cannot be read yet) the buttons are left alone', () => {
  const {$,ui}=setup({perform:{get history(){throw new ReferenceError('Cannot access performanceApp before initialization');}}});
  $('undo').disabled='untouched';
  assert.doesNotThrow(()=>ui.syncPrepareHistory());assert.equal($('undo').disabled,'untouched');
  const none=setup();none.$('undo').disabled='untouched';none.ui.syncPrepareHistory();assert.equal(none.$('undo').disabled,'untouched','no Perform history: the document’s own buttons stay');
});

test('opening the History menu draws it', () => {
  const {$,ui}=setup();ui.wire();
  const [toggle]=$('history-menu').listeners.toggle;
  toggle();assert.equal($('history-pop').children.length,0,'closed: nothing drawn');
  $('history-menu').open=true;toggle();assert.ok($('history-pop').children.length>0);
});
