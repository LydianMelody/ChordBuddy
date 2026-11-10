import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {createSetlistActions} from '../chordbuddy/web/setlist-actions.js';
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
  const {$,doc}=page(),calls=[],errors=[];
  const model={dragSong:null,setlist:'g',state:{songs:[{id:'a',title:'Real Thing'},{id:'b',title:'Tek It'},{id:'c',title:'Third'}],setlists:[{id:'default',name:'All',song_ids:['a','b','c']},{id:'g',name:'Gig',song_ids:['a','b','c']}]}};
  const actions=createSetlistActions({$,model,api:async(path,body)=>{calls.push([path,body]);if(model.fail)throw new Error('The app said no.');return {id:'new-list'};},refreshState:async()=>{calls.push(['refresh']);},showError:e=>errors.push(e?.message||e)});
  return {$,doc,model,actions,calls,errors};
}

test('a song dropped on a set list is added to it, unless it is already there', async (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {model,actions,calls,errors}=setup(),gig=model.state.setlists[1],node=new El('button');
  await actions.addToSetlist(gig,'a',node);
  assert.deepEqual(calls,[]);assert.deepEqual(errors,['Real Thing is already in Gig.']);assert.ok(has(node,'already'));
  t.mock.timers.tick(900);assert.equal(has(node,'already'),false);
  const other={id:'h',name:'Practice',song_ids:[]};
  await actions.addToSetlist(other,'b',node);
  assert.deepEqual(calls,[['/api/setlist/add',{id:'h',song_id:'b'}],['refresh']]);assert.ok(has(node,'took'));
  await actions.addToSetlist(other,'c');   // no node (dropped from All songs)
  assert.equal(calls.length,4);
});

test('taking a song out, moving it up or down, and dragging it before another all send the new list', async () => {
  const {model,actions,calls,errors}=setup();
  await actions.removeFromSetlist('g','b');assert.deepEqual(calls.splice(0),[['/api/setlist/remove',{id:'g',song_id:'b'}],['refresh']]);
  await actions.reorderSong('a',1);assert.deepEqual(calls.splice(0),[['/api/setlist/order',{id:'g',song_ids:['b','a','c']}],['refresh']]);
  await actions.reorderSong('c',-1);assert.deepEqual(calls.splice(0)[0],['/api/setlist/order',{id:'g',song_ids:['a','c','b']}]);
  model.dragSong='c';await actions.moveSongBefore('c','a');
  assert.deepEqual(calls.splice(0),[['/api/setlist/order',{id:'g',song_ids:['c','a','b']}],['refresh']]);assert.equal(model.dragSong,null);
  model.fail=true;await actions.removeFromSetlist('g','a');assert.deepEqual(errors,['The app said no.']);
});

test('while a song is dragged the whole page accepts it, so the pointer stays an arrow', () => {
  const {doc,model,actions}=setup();actions.wireDrag();
  const [over]=doc.listeners.dragover,[drop]=doc.listeners.drop;
  const event=(extra={})=>({prevented:0,defaultPrevented:false,dataTransfer:{dropEffect:''},preventDefault(){this.prevented++;},...extra});
  let e=event();over(e);assert.equal(e.prevented,0,'nothing is dragged');
  model.dragSong='a';
  e=event();over(e);assert.equal(e.prevented,1);assert.equal(e.dataTransfer.dropEffect,'move');
  e=event({defaultPrevented:true});over(e);assert.equal(e.prevented,0,'a set list already took it');
  e=event();drop(e);assert.equal(e.prevented,1);
  model.dragSong=null;e=event();drop(e);assert.equal(e.prevented,0);
});

test('the new set list form opens, makes the list and selects it', async () => {
  const {$,model,actions,calls}=setup();actions.wireForm();$('setlist-form').className='hidden';
  $('new-setlist').onclick();assert.equal(has($('setlist-form'),'hidden'),false);
  let prevented=0;
  $('setlist-name').value='   ';await $('setlist-form').onsubmit({preventDefault(){prevented++;}});assert.deepEqual(calls,[]);
  $('setlist-name').value=' Friday gig ';await $('setlist-form').onsubmit({preventDefault(){prevented++;}});
  assert.equal(prevented,2);assert.deepEqual(calls,[['/api/setlist',{name:'Friday gig'}],['refresh']]);
  assert.equal(model.setlist,'new-list');assert.equal($('setlist-name').value,'');assert.ok(has($('setlist-form'),'hidden'));
});
