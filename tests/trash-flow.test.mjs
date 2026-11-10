import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {createTrashFlow} from '../chordbuddy/web/trash-flow.js';
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

function setup({flush={ok:true},songsAfter=[{id:'b',title:'Next'}],fail=false}={}){
  const {$,doc}=page(),calls=[],errors=[],model={song:'a',state:{songs:[{id:'a',title:'Tek It'},{id:'b',title:'Next'}],trash:[{id:'t1',title:'Old one'}]}};
  globalThis.window={chordBuddyFlush:async()=>flush};
  const flow=createTrashFlow({$,model,api:async(path,body)=>{calls.push([path,body]);if(fail)throw new Error('The app said no.');return {warning:path.endsWith('purge')?'Some files were in use.':undefined};},currentSong:()=>model.state.songs.find(s=>s.id===model.song),
    refreshState:async()=>{calls.push(['refresh']);model.state.songs=songsAfter;},selectSong:async id=>{calls.push(['select',id]);model.song=id;},leaveSong:async()=>{calls.push(['leave']);model.song=null;},
    renderLibrary:()=>calls.push(['library']),renderControls:()=>calls.push(['controls']),renderDocument:()=>calls.push(['document']),renderLock:()=>calls.push(['lock']),showError:e=>errors.push(e?.message||e)});
  return {$,doc,model,flow,calls,errors};
}
const press=(doc,choice)=>all(doc.body).find(n=>n.tagName==='button'&&n.dataset.choice===choice).onclick();

test('trashing the open song lets go of it and opens the next one', async () => {
  const {flow,calls,errors}=setup();await flow.trashSong('a');
  assert.deepEqual(calls,[['/api/song/trash',{id:'a'}],['refresh'],['leave'],['select','b']]);assert.deepEqual(errors,[]);
});

test('trashing the last song leaves the page empty; trashing another song leaves the open one alone', async () => {
  let {flow,calls}=setup({songsAfter:[]});await flow.trashSong('a');
  assert.deepEqual(calls,[['/api/song/trash',{id:'a'}],['refresh'],['leave'],['library'],['controls'],['document'],['lock']]);
  ({flow,calls}=setup());await flow.trashSong('b');
  assert.deepEqual(calls,[['/api/song/trash',{id:'b'}],['refresh']]);
});

test('nothing is trashed while edits are still being saved, and a refusal from the app is shown', async () => {
  let {flow,calls,errors}=setup({flush:{ok:false}});await flow.trashSong('a');
  assert.deepEqual(calls,[]);assert.deepEqual(errors,['Finish saving your edits first.']);
  ({flow,calls,errors}=setup({fail:true}));await flow.trashSong('a');
  assert.deepEqual(errors,['The app said no.']);assert.ok(!calls.some(c=>c[0]==='leave'));
});

test('Delete song asks first, and only Move to Trash trashes it', async () => {
  const {$,doc,flow,calls}=setup();flow.wire();$('settings-menu').open=true;
  const done=$('delete-song').onclick();
  assert.equal($('settings-menu').open,false);assert.match(doc.body.textContent,/Delete “Tek It”\?/);assert.deepEqual(calls,[]);
  press(doc,'trash');await done;
  assert.deepEqual(calls[0],['/api/song/trash',{id:'a'}]);
});

test('the Trash opens with what is in it', () => {
  const {$,doc,flow}=setup();flow.wire();
  $('trash-open').onclick();
  assert.match(doc.body.textContent,/Old one/);
  assert.ok(all(doc.body).filter(n=>n.tagName==='button').length>=2,'Restore and Delete forever');
});
