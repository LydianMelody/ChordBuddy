import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {createImportFlow} from '../chordbuddy/web/import-flow.js';
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

function setup(answers={}){
  const {$}=page(),calls=[],errors=[],model={importing:false,setlist:'gig',song:'open',state:{settings:{device:'auto'},engine:{gpu:true,ready:true}}};
  $('import-button').append(new El('em'));
  const win={listeners:{},addEventListener:(type,fn)=>{(win.listeners[type]||=[]).push(fn);},chordBuddyFlush:async()=>({ok:true})};globalThis.window=win;
  const flow=createImportFlow({$,model,prefs:{set:(k,v)=>calls.push(['pref',k,v])},
    api:async(path,body,options)=>{calls.push(['api',path,body,options?.headers?.['Content-Type']]);const key=Object.keys(answers).find(k=>path.startsWith(k));if(answers[key] instanceof Error)throw answers[key];return answers[key];},
    midiImport:{importFile:file=>{calls.push(['midi',file.name]);return 'midi-result';}},wantsStems:()=>false,stemsHint:()=>'hint',
    startAnalysis:async(...args)=>calls.push(['analyze',...args]),refreshState:async()=>calls.push(['refresh']),selectSong:async id=>{calls.push(['select',id]);model.song=id;},
    leaveSong:async()=>{calls.push(['leave']);model.song=null;},renderControls:()=>calls.push(['controls']),showError:e=>errors.push(e?.message||e),clearError:()=>calls.push(['clear'])});
  return {$,model,flow,calls,errors,win};
}

test('only an MP3, a song zip or a MIDI file is taken, and an MP3 over the limit is refused', async () => {
  const {flow,calls,errors,model}=setup();
  await flow.importFile(undefined);await flow.importFile({name:'notes.txt',size:10});await flow.importFile({name:'huge.mp3',size:251*1024*1024});
  assert.deepEqual(errors,['Choose an MP3 recording, or a song zip exported from Chord Buddy.','This recording is larger than the 250 MB import limit.']);
  assert.deepEqual(calls,[]);assert.equal(model.importing,false);
  assert.equal(await flow.importFile({name:'Melody.MID',size:10}),'midi-result');assert.deepEqual(calls,[['midi','Melody.MID']]);
});

test('an MP3 is sent to the app with its name and the open set list, then opened', async () => {
  const {$,flow,calls,model}=setup({'/api/import':{id:'new',title:'Tek It',artist:'Cafuné'}});
  const file={name:'Tek It.mp3',size:1000,arrayBuffer:async()=>new ArrayBuffer(8)};
  const done=flow.importFile(file);
  assert.equal(model.importing,true);assert.equal($('import-button').disabled,true);assert.equal($('import-button').querySelector('em').textContent,'Importing…');
  await flow.importFile(file);   // a second import while one runs is ignored
  await done;
  assert.deepEqual(calls.slice(0,5),[['clear'],['api','/api/import?filename=Tek%20It.mp3&setlist=gig',undefined,'audio/mpeg'],['refresh'],['select','new'],['controls']]);
  assert.equal(model.importing,false);assert.equal($('import-button').disabled,false);assert.equal($('import-button').querySelector('em').textContent,'Import');assert.equal($('file-input').value,'');
});

test('after an MP3 import the song’s setup is asked, saved, and the analysis starts', async () => {
  const s=setup({'/api/song':{title:'My song'}}),find=id=>all(globalThis.document.body).find(n=>n.id===id);
  const asked=s.flow.setupImportedSong({id:'new',title:'Tek It',artist:'Cafuné'});
  assert.equal(find('setup-title').value,'Tek It');assert.equal(find('setup-artist').value,'Cafuné');assert.equal(find('setup-stems').checked,false);
  find('setup-title').value=' My song ';find('setup-stems').checked=true;find('setup-go').onclick();await asked;
  assert.deepEqual(s.calls,[['pref','cb-stems','1'],['api','/api/song',{id:'new',title:'My song',artist:'Cafuné'},undefined],['refresh'],['analyze','new',[],true]]);
  const t=setup(),later=t.flow.setupImportedSong({id:'new',title:'Tek It'});
  all(globalThis.document.body).find(n=>has(n,'choice-cancel')).onclick();await later;
  assert.deepEqual(t.calls,[],'Not now: nothing is saved and nothing starts');
});

test('a failed import says why and gives the button back', async () => {
  const {$,flow,errors,calls,model}=setup({'/api/import':new Error('The disk is full.')});
  await flow.importFile({name:'a.mp3',size:1,arrayBuffer:async()=>new ArrayBuffer(1)});
  assert.deepEqual(errors,['The disk is full.']);assert.equal(model.importing,false);assert.equal($('import-button').disabled,false);
  assert.ok(!calls.some(c=>c[0]==='select'));
});

test('a song zip with no song of the same title here is added as a new song, sent as the file itself', async () => {
  const file={name:'Tek It.zip',size:5e9};
  const {flow,calls,errors,model}=setup({'/api/song-import/apply':{song_id:'added',warning:'The stems were left out.'},'/api/song-import':{token:'tok',matches:[]}});
  await flow.importFile(file);
  assert.deepEqual(calls,[['clear'],['api','/api/song-import',undefined,'application/zip'],['api','/api/song-import/apply',{token:'tok',mode:'new',setlist:'gig'},undefined],['refresh'],['select','added'],['controls']]);
  assert.deepEqual(errors,['The stems were left out.']);assert.equal(model.importing,false);
});

test('the Import button opens the file chooser, and the chosen file is imported', async () => {
  const {$,flow,errors}=setup();flow.wireButtons();
  $('import-button').onclick();$('empty-import').onclick();assert.equal($('file-input').clicks,2);
  $('file-input').files=[{name:'wrong.wav',size:1}];await $('file-input').onchange();
  assert.equal(errors.length,1);
});

test('a file dragged over the window shows the drop overlay; dropping it imports it', async () => {
  const {$,flow,win,errors}=setup();flow.wireDrop();$('drop-overlay').className='hidden';
  const files={types:['Files'],files:[{name:'wrong.wav',size:1}]},event=(dataTransfer=files)=>({dataTransfer,prevented:0,preventDefault(){this.prevented++;}});
  let e=event({types:['text/plain']});win.listeners.dragenter[0](e);assert.equal(e.prevented,0);assert.ok(has($('drop-overlay'),'hidden'),'a dragged song is not a file');
  e=event();win.listeners.dragenter[0](e);assert.equal(e.prevented,1);assert.equal(has($('drop-overlay'),'hidden'),false);
  win.listeners.dragenter[0](event());win.listeners.dragleave[0]();assert.equal(has($('drop-overlay'),'hidden'),false,'still over the window');
  win.listeners.dragleave[0]();assert.ok(has($('drop-overlay'),'hidden'));
  win.listeners.dragenter[0](event());e=event();win.listeners.drop[0](e);await tick();
  assert.equal(e.prevented,1);assert.ok(has($('drop-overlay'),'hidden'));assert.equal(errors.length,1);
});
