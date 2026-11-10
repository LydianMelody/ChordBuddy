// MIDI setup: every change can be undone while it's open (Ctrl+Z or Undo); Okay keeps them, Cancel puts back how it was when it opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom,all,Node} from './compact-dom.mjs';
installDom();
let pageKey=null;document.addEventListener=(type,fn)=>{if(type==='keydown')pageKey=fn;};document.removeEventListener=(type,fn)=>{if(pageKey===fn)pageKey=null;};
const {openMidiSetup}=await import('../chordbuddy/web/midi-setup.js');

const A={device:'Line 6 Helix',status:0xB0,data1:20,range:[1,81],edge:'every',command:'loop-bars',params:{bars:4}};
const B={device:'Line 6 Helix',status:0xB0,data1:21,range:[0,127],edge:'every',command:'play-pause',params:{}};
function rig(start=[A,B],tap=''){
 let list=structuredClone(start),tapName=tap;const host=new Node('body');
 const ui=openMidiSetup({api:async()=>({available:true,inputs:[],outputs:[]}),mappings:()=>list,saveMappings:l=>{list=structuredClone(l);},showError:e=>{throw e;},
  tapDevice:()=>tapName,setTapDevice:n=>{tapName=n;},host});
 const dialog=host.children[0];
 const find=(text)=>all(dialog).find(n=>n.tagName==='button'&&n.textContent.trim()===text);
 const row=key=>all(dialog).find(n=>n.dataset?.control===key);
 const key=(k,shift=false)=>pageKey({key:k,ctrlKey:true,shiftKey:shift,target:{tagName:'BODY'},preventDefault(){},stopPropagation(){}});
 return {ui,dialog,find,row,key,get list(){return list;},get tap(){return tapName;},set tap(v){tapName=v;}};
}
const keyOf=m=>`${m.device}|${m.status}|${m.data1}|${m.range[0]}`;
const forgetA=r=>{r.row(keyOf(A)).onclick();r.find('Forget').onclick();};

test('the footer is Undo, Redo, a red Cancel and a green Okay', () => {
 const r=rig();
 assert.match(r.find('Cancel').className,/btn-cancel/);assert.match(r.find('Okay').className,/btn-ok/);
 assert.equal(r.find('Close'),undefined,'no Close any more');
 assert.equal(r.find('Undo').disabled,true,'nothing to undo yet');
});

test('Ctrl+Z takes back a change to the assignments, and Ctrl+Shift+Z puts it back', () => {
 const r=rig();
 forgetA(r);assert.equal(r.list.length,1);
 r.key('z');assert.deepEqual(r.list,[A,B],'undone');
 r.key('z',true);assert.deepEqual(r.list,[B],'redone');
 r.find('Undo').onclick();assert.deepEqual(r.list,[A,B],'the Undo button does the same');
});

test('Cancel puts back everything since it opened, the tempo follower too; Okay keeps the changes', () => {
 const r=rig([A,B],'Line 6 Helix');
 forgetA(r);r.tap='';
 r.find('Cancel').onclick();
 assert.deepEqual(r.list,[A,B]);assert.equal(r.tap,'Line 6 Helix');
 const k=rig();forgetA(k);k.find('Okay').onclick();assert.deepEqual(k.list,[B]);
 assert.equal(pageKey,null,'closing stops listening for Ctrl+Z');
});

test('a text box keeps Ctrl+Z for its own typing', () => {
 const r=rig();forgetA(r);
 pageKey({key:'z',ctrlKey:true,target:{tagName:'INPUT',type:'number'},preventDefault(){},stopPropagation(){}});
 assert.deepEqual(r.list,[B]);
});
