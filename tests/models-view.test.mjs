import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all,installDom} from './compact-dom.mjs';
import {mountModelsPanel,formatBytes} from '../chordbuddy/web/models-view.js';

const model=(id,extra={})=>({id,title:id==='base'?'Base model':'Guitar model',role:'role',license:'unconfirmed',ready:false,bytes_missing:1024**3,bytes_present:0,environment:true,error:null,downloading:false,progress:null,...extra});
const status=(models,extra={})=>({ready:models.every(m=>m.ready),active:false,models,bytes_missing:models.reduce((n,m)=>n+m.bytes_missing,0),...extra});
const byId=(root,id)=>all(root).find(n=>n.id===id);
function setup(){
  installDom();const root=new Node('section'),calls=[];
  const panel=mountModelsPanel(root,{onDownload:()=>calls.push('download'),onCancel:()=>calls.push('cancel'),onFile:async f=>calls.push('file:'+f.name)});
  return {root,calls,panel};
}

test('sizes read like a person would say them', () => {
  assert.equal(formatBytes(0),'0 MB');assert.equal(formatBytes(5*1024**2),'5 MB');assert.equal(formatBytes(1.5*1024**3),'1.5 GB');assert.equal(formatBytes(10),'1 MB');
});

test('the panel appears only while models are missing, shows each license, and downloading needs the box ticked', () => {
  const {root,calls,panel}=setup();
  panel.update(status([model('base'),model('guitar')]));
  assert.equal(root.className.includes('hidden'),false);
  assert.match(root.textContent,/Base model/);assert.match(root.textContent,/License: unconfirmed/);assert.match(root.textContent,/2\.0 GB/);
  const download=byId(root,'models-download'),ack=byId(root,'models-ack');
  assert.equal(download.disabled,true);download.onclick();assert.deepEqual(calls,[]);
  ack.checked=true;ack.onchange();assert.equal(download.disabled,false);download.onclick();assert.deepEqual(calls,['download']);
  panel.update(status([model('base',{ready:true,bytes_missing:0}),model('guitar',{ready:true,bytes_missing:0})]));
  assert.equal(root.className.includes('hidden'),true);
});

test('progress, failures and the stop button follow the status; a ticked box survives updates', () => {
  const {root,calls,panel}=setup();
  const ack=byId(root,'models-ack');ack.checked=true;
  panel.update(status([model('base',{downloading:true,progress:{path:'weights/a.ckpt',done:512*1024**2,size:1024**3,source:'huggingface.co'}}),model('guitar')],{active:true}));
  assert.match(root.textContent,/Downloading a\.ckpt from huggingface\.co/);
  assert.equal(byId(root,'models-stop').className.includes('hidden'),false);assert.equal(byId(root,'models-download').disabled,true);
  byId(root,'models-stop').onclick();assert.deepEqual(calls,['cancel']);
  panel.update(status([model('base',{error:'big.ckpt: could not be downloaded (hf.co: HTTP 404)'}),model('guitar')]));
  assert.match(root.textContent,/Could not finish: big\.ckpt/);assert.equal(byId(root,'models-download').textContent,'Try again');
  assert.equal(ack.checked,true);assert.equal(byId(root,'models-download').disabled,false);
  panel.update(status([model('base',{environment:false}),model('guitar')]));
  assert.match(root.textContent,/engine files are missing/);assert.equal(byId(root,'models-download').disabled,true);
});

test('a file the user picked is handed over and any complaint is shown', async () => {
  const {root}=setup();installDom();
  const calls=[];const rootB=new Node('section');
  const panel=mountModelsPanel(rootB,{onDownload(){},onCancel(){},onFile:async f=>{calls.push(f.name);throw new Error('That file is not one of the models Chord Buddy needs.');}});
  panel.update(status([model('base')]));
  const pick=byId(rootB,'models-file');pick.files=[{name:'mine.ckpt'}];await pick.onchange();
  assert.deepEqual(calls,['mine.ckpt']);assert.match(rootB.textContent,/not one of the models/);
});
