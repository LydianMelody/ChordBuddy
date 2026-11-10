import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {readSessionToken,createApi,timeLabel,element,typingTarget,listLength,nowAndNext} from '../chordbuddy/web/app-helpers.js';
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

test('times read as minutes and seconds, and a list adds up its songs', () => {
  assert.equal(timeLabel(75),'1:15');assert.equal(timeLabel(0),'0:00');assert.equal(timeLabel(-3),'0:00');assert.equal(timeLabel(3599.9),'59:59');
  assert.equal(listLength([{duration:305},{duration:'193'},{},{duration:null}]),498);assert.equal(listLength([]),0);
});

test('element makes a node with its class and text', () => {
  page();
  const node=element('small','song-note','Analyzing…');
  assert.equal(node.tagName,'small');assert.equal(node.className,'song-note');assert.equal(node.textContent,'Analyzing…');
  assert.equal(element('span').className,'');assert.equal(element('b','',0).textContent,'0');
});

test('typing is a text box, a text area, a menu or editable text; tick boxes, sliders and buttons are not', () => {
  assert.equal(typingTarget(null),false);
  assert.equal(typingTarget({tagName:'INPUT'}),true);assert.equal(typingTarget({tagName:'INPUT',type:'search'}),true);
  for(const type of ['checkbox','radio','range','button','submit','reset','file','color'])assert.equal(typingTarget({tagName:'INPUT',type}),false,type);
  assert.equal(typingTarget({tagName:'TEXTAREA'}),true);assert.equal(typingTarget({tagName:'SELECT'}),true);
  assert.equal(typingTarget({tagName:'DIV',isContentEditable:true}),true);assert.equal(typingTarget({tagName:'BUTTON'}),false);
});

test('now and next: the chord sounding, and the next different one (no-chord stretches show a dash)', () => {
  const chords=[{id:1,start:0,end:2,label:'C:maj'},{id:2,start:2,end:4,label:'N'},{id:3,start:4,end:6,label:'C:maj'},{id:4,start:6,end:8,label:'A:min7'}];
  assert.deepEqual(nowAndNext(chords,chords[0],1),{chord:'C',next:'Am7'});
  assert.deepEqual(nowAndNext(chords,chords[1],3),{chord:'—',next:'C'});
  assert.deepEqual(nowAndNext(chords,null,9),{chord:'—',next:''});
});

function fakeFetch(answers){
  const calls=[],real=globalThis.fetch;
  globalThis.fetch=async(path,init)=>{calls.push({path,init});const a=answers.shift();return {ok:a.status<400,status:a.status,headers:{get:name=>name==='ETag'?a.etag||null:null},json:async()=>{if(a.body===undefined)throw new Error('no body');return a.body;}};};
  return {calls,restore:()=>{globalThis.fetch=real;}};
}

test('api sends the token, posts a body as JSON, and throws the app’s own message with its status', async () => {
  const net=fakeFetch([{status:200,body:{ok:1}},{status:200,body:{saved:true}},{status:409,body:{error:'Changed elsewhere.'}},{status:500,body:{}},{status:502}]);
  try{
    const api=createApi('T0K');
    assert.deepEqual(await api('/api/state'),{ok:1});
    assert.equal(net.calls[0].path,'/api/state');assert.equal(net.calls[0].init.headers['X-ChordBuddy-Token'],'T0K');assert.equal(net.calls[0].init.method,undefined);
    assert.deepEqual(await api('/api/song',{id:'s',title:'New'},{headers:{'X-Extra':'1'}}),{saved:true});
    const post=net.calls[1].init;assert.equal(post.method,'POST');assert.equal(post.body,'{"id":"s","title":"New"}');
    assert.equal(post.headers['Content-Type'],'application/json');assert.equal(post.headers['X-Extra'],'1');assert.equal(post.headers['X-ChordBuddy-Token'],'T0K');
    await assert.rejects(api('/api/song',{}),error=>error.message==='Changed elsewhere.'&&error.status===409);
    await assert.rejects(api('/api/x'),error=>error.message==='Request failed (500).'&&error.status===500);
    await assert.rejects(api('/api/x'),/unreadable response \(502\)/);
  }finally{net.restore();}
});

test('api with an etag holder: the tag goes out again, and "nothing changed" comes back as undefined', async () => {
  const net=fakeFetch([{status:200,body:{n:1},etag:'"a"'},{status:304},{status:200,body:{n:2},etag:'"b"'}]);
  try{
    const api=createApi('T'),etag={tag:null};
    assert.deepEqual(await api('/api/state',undefined,{etag}),{n:1});assert.equal(etag.tag,'"a"');
    assert.equal(net.calls[0].init.headers['If-None-Match'],undefined);assert.equal('etag' in net.calls[0].init,false);
    assert.equal(await api('/api/state',undefined,{etag}),undefined);assert.equal(net.calls[1].init.headers['If-None-Match'],'"a"');assert.equal(etag.tag,'"a"');
    assert.deepEqual(await api('/api/state',undefined,{etag}),{n:2});assert.equal(etag.tag,'"b"');
  }finally{net.restore();}
});

test('the session token is taken out of the address and kept for the tab; a reload finds it in the tab’s storage', () => {
  const kept=new Map(),replaced=[],saved={location:globalThis.location,sessionStorage:globalThis.sessionStorage,history:globalThis.history};
  const set=(name,value)=>Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
  try{
    set('sessionStorage',{setItem:(k,v)=>kept.set(k,v),getItem:k=>kept.get(k)??null});set('history',{replaceState:(...args)=>replaced.push(args)});
    set('location',{hash:'#token=abc123',pathname:'/',search:'?x=1'});
    assert.equal(readSessionToken(),'abc123');assert.equal(kept.get('chordbuddy-token'),'abc123');assert.deepEqual(replaced,[[null,'','/?x=1']]);
    set('location',{hash:'',pathname:'/',search:''});
    assert.equal(readSessionToken(),'abc123');assert.equal(replaced.length,1);
    set('sessionStorage',{setItem(){throw new Error('blocked');},getItem(){throw new Error('blocked');}});
    set('location',{hash:'#token=zzz',pathname:'/',search:''});
    assert.equal(readSessionToken(),'zzz','storage blocked: the token in the address still works');
    set('location',{hash:'',pathname:'/',search:''});assert.equal(readSessionToken(),'');
  }finally{for(const [name,value] of Object.entries(saved))set(name,value);}
});
