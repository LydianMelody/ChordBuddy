import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {createSongTitle,TITLE_NODES} from '../chordbuddy/web/song-title.js';
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

function setup(){
  const {$}=page(),calls=[],errors=[],song={id:'s',title:'Old name',artist:'Cafuné'};
  const model={song:'s',pendingTitle:false,titleSave:null,state:{songs:[song]}},view={song,drawn:[]};
  const title=createSongTitle({$,model,api:async(path,body)=>{calls.push([path,body]);return {title:body.title};},currentSong:()=>view.song,
    renderPageHead:()=>view.drawn.push('head'),renderLibrary:()=>view.drawn.push('library'),showError:e=>errors.push(e?.message||e)});
  $('song-title').value=song.title;
  return {$,model,view,title,calls,errors,song};
}

test('a changed title is saved, and the page and the song list show it', async () => {
  const {$,model,view,title,calls,song}=setup();
  $('song-title').value='  New name ';model.pendingTitle=true;await title.updateTitle();
  assert.deepEqual(calls,[['/api/song',{id:'s',title:'New name'}]]);assert.equal(song.title,'New name');assert.equal(song.artist,'Cafuné');
  assert.equal(model.pendingTitle,false);assert.equal(model.titleSave,null);assert.deepEqual(view.drawn,['head','library']);
});

test('an unchanged title is not sent, an empty one is refused, and nothing waiting means nothing to do', async () => {
  const {$,model,title,calls}=setup();
  model.pendingTitle=true;await title.updateTitle();assert.deepEqual(calls,[]);assert.equal(model.pendingTitle,false);
  await title.commitUiDrafts();assert.deepEqual(calls,[]);
  $('song-title').value='   ';await assert.rejects(title.updateTitle(),/Give your song a title/);
  $('song-title').value='Later';model.pendingTitle=true;await title.commitUiDrafts();assert.deepEqual(calls,[['/api/song',{id:'s',title:'Later'}]]);
});

test('typing in a page’s heading carries the title to the saving code, which waits a moment after the last key', async (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {$,model,title,calls}=setup();title.wire();
  assert.deepEqual(TITLE_NODES,['page-song','score-title','midi-title']);
  for(const id of TITLE_NODES)assert.equal(typeof $(id).oninput,'function',id);
  const heading=$('score-title');heading.textContent='Brand   new\n title ';heading.oninput();
  assert.equal($('song-title').value,'Brand new title');assert.equal(model.pendingTitle,true);assert.deepEqual(calls,[]);
  t.mock.timers.tick(599);assert.deepEqual(calls,[]);
  t.mock.timers.tick(1);await tick();assert.deepEqual(calls,[['/api/song',{id:'s',title:'Brand new title'}]]);
});

test('Enter leaves the heading; Escape puts the saved title back', () => {
  const {$,title}=setup();title.wire();
  const heading=$('page-song');let blurred=0,prevented=0;heading.onblur=()=>{blurred++;};
  heading.textContent='Half typed';$('song-title').value='Half typed';
  heading.onkeydown({key:'Escape',target:heading,preventDefault(){prevented++;}});
  assert.equal(heading.textContent,'Old name');assert.equal($('song-title').value,'Old name');assert.equal(blurred,1);
  heading.onkeydown({key:'Enter',target:heading,preventDefault(){prevented++;}});assert.equal(prevented,1);assert.equal(blurred,2);
});
