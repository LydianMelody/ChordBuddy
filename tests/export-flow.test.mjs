import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all} from './compact-dom.mjs';
import {createExportFlow} from '../chordbuddy/web/export-flow.js';
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

function setup({documents=[{id:'c1',kind:'chart'},{id:'m1',kind:'midi',name:'melody.mid'},{id:'m2',kind:'midi',name:'transcription.mid'}],song={id:'s',title:'Tek It',active_run:'r'},kind='chart',lead=null,info={bytes:5e6,stems_bytes:0},flush={ok:true}}={}){
  const {$,doc}=page(),calls=[],errors=[],model={detail:{documents},document:documents.find(d=>d.kind===kind)?.id||null},view={song,kind,lead};
  globalThis.window={print:()=>calls.push(['print']),chordBuddyFlush:async()=>flush};
  const flow=createExportFlow({$,model,prefs:{get:(k,fallback)=>fallback,set:(k,v)=>calls.push(['pref',k,v])},api:async(path,body)=>{calls.push(['api',path,body]);return info;},mediaUrl:path=>path+'?token=T',
    practiceView:{setMode:mode=>calls.push(['mode',mode])},getLeadView:()=>view.lead,currentSong:()=>view.song,currentRecord:()=>view.kind?{doc:{kind:view.kind}}:null,
    chartDoc:()=>documents.find(d=>d.kind==='chart')||null,loadChartRecord:async()=>calls.push(['load-chart']),selectDocument:async id=>{calls.push(['select',id]);model.document=id;view.kind=documents.find(d=>d.id===id).kind;},showError:e=>errors.push(e?.message||e)});
  const links=()=>doc.created.filter(n=>n.tagName==='a');
  return {$,doc,model,view,flow,calls,errors,links};
}
const menu=doc=>{doc.found=['pdf-chart','pdf-lead','midi','midi-tracks','outputs','song'].map(kind=>{const b=new El('button');b.dataset.export=kind;return b;});return Object.fromEntries(doc.found.map(b=>[b.dataset.export,b]));};

test('the Export menu offers only what the open song has', () => {
  let {$,doc,flow}=setup({documents:[{id:'c1',kind:'chart'}]});let buttons=menu(doc);flow.renderExportMenu();
  assert.deepEqual(Object.entries(buttons).filter(([,b])=>!b.disabled).map(([kind])=>kind),['pdf-chart','outputs','song']);assert.equal(has($('export-button'),'disabled'),false);
  ({$,doc,flow}=setup({song:null}));buttons=menu(doc);flow.renderExportMenu();
  assert.ok(buttons.song.disabled);assert.ok(buttons.outputs.disabled);assert.ok(has($('export-button'),'disabled'));
});

test('MIDI downloads the whole transcription, as one track or split; the model’s outputs come as a zip', async () => {
  const {flow,links,doc}=setup();
  await flow.runExport('midi');await flow.runExport('midi-tracks');await flow.runExport('outputs');
  assert.deepEqual(links().map(a=>a.href),['/api/export-midi/m2?token=T&mode=single','/api/export-midi/m2?token=T&mode=tracks','/api/export-outputs/s?token=T']);
  assert.ok(links().every(a=>a.clicks===1&&a.download===''));assert.equal(doc.body.children.length,0,'each link is taken away again');
  await assert.rejects(setup({documents:[{id:'c1',kind:'chart'}]}).flow.runExport('midi'),/no MIDI yet/);
  const none=setup({song:null});await none.flow.runExport('outputs');assert.equal(none.links().length,0);
});

test('the whole song is exported once the edits are saved; without stems there is nothing to ask', async () => {
  const {flow,links,calls}=setup();await flow.runExport('song');
  assert.deepEqual(calls,[['api','/api/song-export/info',{song_id:'s'}]]);assert.deepEqual(links().map(a=>a.href),['/api/song-export/s?token=T&stems=0']);
  const unsaved=setup({flush:{ok:false}});await assert.rejects(unsaved.flow.runExport('song'),/Finish saving your edits first/);assert.equal(unsaved.links().length,0);
});

test('with stems, the dialog asks whether to include them and remembers the answer', async () => {
  const {doc,flow,links,calls}=setup({info:{bytes:5e6,stems_bytes:2.4e9}});
  const done=flow.runExport('song');await tick();await tick();
  assert.match(doc.body.textContent,/Adds about 2\.4 GB\. Without them the zip is about 5 MB/);
  all(doc.body).find(n=>n.tagName==='button'&&n.dataset.choice==='export').onclick();await done;
  assert.deepEqual(calls.filter(c=>c[0]==='pref'),[['pref','cb-export-stems','0']]);assert.deepEqual(links().map(a=>a.href),['/api/song-export/s?token=T&stems=0']);
});

test('Export PDF prints the chart from its Navigate page, opening the chart first if another view is showing', async () => {
  let {flow,calls}=setup();await flow.exportChartPdf();
  assert.deepEqual(calls,[['mode','nav'],['print']]);
  ({flow,calls}=setup({kind:'midi'}));await flow.exportPdf('chart');
  assert.deepEqual(calls,[['select','c1'],['mode','nav'],['print']]);
  const none=setup({documents:[]});await none.flow.exportPdf('chart');assert.deepEqual(none.errors,['This song has no chart to export yet.']);
});

test('Export PDF of the lead sheet prints it in its print look, then puts the screen look back', async () => {
  const modes=[],lead={printMode:on=>modes.push(on)},documents=[{id:'c1',kind:'chart'},{id:'a1',kind:'abc'}];
  const {flow,calls}=setup({documents,kind:'chart',lead});
  await flow.exportPdf('lead');
  assert.deepEqual(calls,[['load-chart'],['select','a1'],['print']]);assert.deepEqual(modes,[true,false]);
  const undrawn=setup({documents,kind:'chart',lead:null});await undrawn.flow.exportPdf('lead');
  assert.deepEqual(undrawn.calls,[['load-chart'],['select','a1']],'no lead sheet on screen after all: nothing is printed');assert.deepEqual(undrawn.errors,[]);
  const missing=setup({documents:[{id:'c1',kind:'chart'}]});await missing.flow.exportPdf('lead');assert.deepEqual(missing.errors,['This song has no lead sheet to export yet.']);
  const open=setup({documents,kind:'abc',lead});open.model.document='a1';await open.flow.exportChartPdf();
  assert.deepEqual(open.calls,[['load-chart'],['print']],'on the lead sheet tab, Export PDF means the lead sheet');
});

test('each Export menu button closes the menu and runs its export; the page’s export-pdf event prints', async () => {
  const {$,doc,flow,links,errors}=setup();const buttons=menu(doc);flow.wire();
  $('export-menu').open=true;buttons.outputs.onclick();await tick();
  assert.equal($('export-menu').open,false);assert.deepEqual(links().map(a=>a.href),['/api/export-outputs/s?token=T']);assert.deepEqual(errors,[]);
  assert.equal(doc.listeners['chordbuddy:export-pdf'].length,1);assert.equal(doc.listeners['chordbuddy:export-pdf'][0],flow.exportChartPdf);
});
