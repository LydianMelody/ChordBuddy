import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all,installDom} from './compact-dom.mjs';
import {askChoice,askSongSetup,openTrash,CPU_STEMS_WARNING} from '../chordbuddy/web/dialogs.js';

const has=(n,c)=>n.className.split(' ').includes(c);
const byClass=(root,c)=>all(root).filter(n=>has(n,c));
const buttons=host=>all(host).filter(n=>n.tagName==='button');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){installDom();return new Node();}

test('a choice dialog resolves with the id of the button that was pressed', async () => {
  const host=setup();
  const promise=askChoice({title:'Delete “Song”?',message:'It goes to the Trash.',choices:[{id:'trash',label:'Move to Trash',kind:'danger'}],host});
  assert.equal(byClass(host,'choice-dialog').length,1);
  assert.match(host.textContent,/Delete “Song”\?/);assert.match(host.textContent,/It goes to the Trash\./);
  buttons(host).find(b=>b.dataset.choice==='trash').onclick();
  assert.equal(await promise,'trash');assert.equal(byClass(host,'choice-dialog').length,0);
});

test('Cancel and Esc both answer null and close the dialog without choosing anything', async () => {
  const host=setup();
  const first=askChoice({title:'Q',choices:[{id:'go',label:'Go'}],host});
  byClass(host,'choice-cancel')[0].onclick();assert.equal(await first,null);assert.equal(byClass(host,'choice-dialog').length,0);
  const second=askChoice({title:'Q',choices:[{id:'go',label:'Go'}],host});
  byClass(host,'choice-dialog')[0].oncancel({preventDefault(){}});assert.equal(await second,null);
});

test('only the first answer counts', async () => {
  const host=setup();
  const promise=askChoice({title:'Q',choices:[{id:'a',label:'A'},{id:'b',label:'B'}],host});
  const [,a,b]=buttons(host);a.onclick();b.onclick();byClass(host,'choice-cancel')[0]?.onclick?.();
  assert.equal(await promise,'a');
});

test('a keep-open choice (like Export PDF) acts but leaves the question up for the real decision', async () => {
  const host=setup(),picked=[];
  const promise=askChoice({title:'Analyze again?',choices:[{id:'export',label:'Export PDF',keepOpen:true},{id:'analyze',label:'Analyze again',kind:'danger'}],onPick:id=>picked.push(id),host});
  buttons(host).find(b=>b.dataset.choice==='export').onclick();
  assert.deepEqual(picked,['export']);assert.equal(byClass(host,'choice-dialog').length,1);
  buttons(host).find(b=>b.dataset.choice==='analyze').onclick();
  assert.equal(await promise,'analyze');
});

test('dangerous choices are drawn as dangerous so they are never the quiet default', () => {
  const host=setup();askChoice({title:'Q',choices:[{id:'x',label:'Delete',kind:'danger'},{id:'y',label:'Keep',kind:'secondary'}],host});
  assert.ok(has(buttons(host).find(b=>b.dataset.choice==='x'),'choice-danger'));
  assert.ok(!has(buttons(host).find(b=>b.dataset.choice==='y'),'choice-danger'));
});

test('the Trash lists trashed songs with Restore and Delete forever, and refreshes after each action', async () => {
  const host=setup();let items=[{id:'a',title:'One',artist:'Me',filename:'one.mp3'},{id:'b',title:'Two',artist:'',filename:'two.mp3'}];const log=[];
  openTrash({getItems:()=>items,onRestore:async s=>{log.push(['restore',s.id]);items=items.filter(i=>i.id!==s.id);},onPurge:async s=>{log.push(['purge',s.id]);items=items.filter(i=>i.id!==s.id);},host});
  assert.deepEqual(byClass(host,'trash-row').map(r=>r.children[0].children[0].textContent),['One','Two']);
  byClass(host,'trash-row')[0].children[1].onclick();await tick();
  assert.deepEqual(byClass(host,'trash-row').map(r=>r.children[0].children[0].textContent),['Two']);
  byClass(host,'trash-row')[0].children[2].onclick();await tick();
  assert.deepEqual(log,[['restore','a'],['purge','b']]);assert.match(host.textContent,/The Trash is empty\./);
});

test('the Trash says so when it is empty, and Close removes it', () => {
  const host=setup();const t=openTrash({getItems:()=>[],onRestore(){},onPurge(){},host});
  assert.match(host.textContent,/The Trash is empty\./);byClass(host,'choice-cancel')[0].onclick();assert.equal(byClass(host,'choice-dialog').length,0);
});

const inputs=host=>all(host).filter(n=>n.tagName==='input');
test('the song setup dialog starts from the tags and the last choice, and answers with the edited name, artist, stems and device choice', async () => {
  const host=setup();
  const promise=askSongSetup({title:'Tagged Title',artist:'Some Band',stems:true,stemsHint:'Slow.',host});
  assert.equal(byClass(host,'setup-dialog').length,1);
  const [title,artist,stems]=['setup-title','setup-artist','setup-stems'].map(id=>inputs(host).find(n=>n.id===id));
  assert.equal(title.value,'Tagged Title');assert.equal(artist.value,'Some Band');assert.equal(stems.checked,true);
  assert.match(host.textContent,/Slow\./);
  title.value='  My song ';artist.value='';stems.checked=false;
  all(host).find(n=>n.id==='setup-go').onclick();
  assert.deepEqual(await promise,{title:'My song',artist:'',stems:false,device:'auto'});
  assert.equal(byClass(host,'setup-dialog').length,0);
});

test('without a working NVIDIA GPU, or with "CPU only" picked, ticking the stems shows how slow splitting is', async () => {
  const warned=host=>host.textContent.includes(CPU_STEMS_WARNING);
  const host=setup();
  const promise=askSongSetup({title:'x',stems:false,gpu:false,host});
  const stems=inputs(host).find(n=>n.id==='setup-stems'),device=all(host).find(n=>n.id==='setup-device');
  assert.equal(warned(host),false);                                      // nothing until it is ticked
  stems.checked=true;stems.onchange();assert.equal(warned(host),true);
  stems.checked=false;stems.onchange();assert.equal(warned(host),false);
  byClass(host,'choice-cancel')[0].onclick();await promise;
  const gpuHost=setup();
  const second=askSongSetup({title:'x',stems:true,gpu:true,host:gpuHost});
  const device2=all(gpuHost).find(n=>n.id==='setup-device');
  assert.equal(warned(gpuHost),false);                                   // a GPU splits quickly: no warning
  device2.value='cpu';device2.onchange();assert.equal(warned(gpuHost),true);
  device2.value='auto';device2.onchange();assert.equal(warned(gpuHost),false);
  byClass(gpuHost,'choice-cancel')[0].onclick();await second;
  assert.ok(device);
});

test('the song setup dialog cannot analyze without a name, and "Not now" keeps the song without analyzing', async () => {
  const host=setup();
  const first=askSongSetup({title:'x',host});
  const title=inputs(host).find(n=>n.id==='setup-title'),go=all(host).find(n=>n.id==='setup-go');
  title.value='';title.oninput();assert.equal(go.disabled,true);go.onclick();
  title.value='ok';title.oninput();assert.equal(go.disabled,false);
  byClass(host,'choice-cancel')[0].onclick();assert.equal(await first,null);
  const second=askSongSetup({title:'x',host});
  byClass(host,'setup-dialog')[0].oncancel({preventDefault(){}});assert.equal(await second,null);
});

test('a choice dialog can carry a tick box that reports its changes', async () => {
  const host=setup();const seen=[];
  const promise=askChoice({title:'Again?',choices:[{id:'go',label:'Go'}],checkbox:{label:'Also split the stems',hint:'Slow.',checked:false,onChange:v=>seen.push(v)},host});
  const box=inputs(host)[0];assert.equal(box.checked,false);box.checked=true;box.onchange();
  buttons(host).find(b=>b.dataset.choice==='go').onclick();
  assert.equal(await promise,'go');assert.deepEqual(seen,[true]);
});

test('the song setup dialog offers the processing device and starts from the saved choice', async () => {
  const host=setup();
  const promise=askSongSetup({title:'Song',device:'cpu',host});
  const device=all(host).find(n=>n.id==='setup-device');
  assert.equal(device.value,'cpu');assert.match(host.textContent,/NVIDIA GPU only/);
  device.value='cuda';all(host).find(n=>n.id==='setup-go').onclick();
  assert.equal((await promise).device,'cuda');
});

test('a choice dialog can offer one option out of a few, and reports a change of mind', async () => {
  const host=setup();let picked=null;
  const promise=askChoice({title:'Again?',host,choices:[{id:'go',label:'Go'}],
    radios:{label:'Your edits',value:'keep',onChange:v=>{picked=v;},options:[{id:'keep',label:'Keep my edits'},{id:'replace',label:'Start over',hint:'Kept under Previous transcriptions.'}]}});
  const radios=inputs(host).filter(n=>n.type==='radio');
  assert.equal(radios.length,2);assert.equal(radios[0].checked,true);assert.match(host.textContent,/Kept under Previous transcriptions/);
  radios[1].checked=true;radios[1].onchange();assert.equal(picked,'replace');
  all(host).find(n=>n.dataset?.choice==='go').onclick();assert.equal(await promise,'go');
});
