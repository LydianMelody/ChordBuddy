import test from 'node:test';import assert from 'node:assert/strict';import {commitPracticeDocument} from '../chordbuddy/web/practice-save.js';
const record=()=>({doc:{id:'d',kind:'chart',revision:1,content:{value:'old'}},draft:{value:'old'},version:0,dirty:false,saving:false});
test('409 reloads saved chart while failed draft stays outside record; cancel/reopen can save new revision',async()=>{
 const r=record(),requests=[];let conflict=true;const api=async(path,body)=>{requests.push([path,body]);if(body&&conflict){conflict=false;const e=Error('Changed');e.status=409;throw e;}return {id:'d',kind:'chart',revision:body?3:2,content:body?.content||{value:'server'}};};
 await assert.rejects(commitPracticeDocument(r,{value:'local'},'Edit',{documentId:'d',revision:1},api),/changed/i);
 assert.equal(r.doc.revision,2);assert.deepEqual(r.draft,{value:'server'});assert.equal(r.saving,false);assert.ok(r.practiceSaveError);
 r.practiceSaveError=null;await commitPracticeDocument(r,{value:'retry'},'Edit',{documentId:'d',revision:2},api);
 assert.equal(r.doc.revision,3);assert.deepEqual(r.draft,{value:'retry'});assert.equal(requests.length,3);
});
test('acknowledgement installs only server content and retains error on failure',async()=>{
 const r=record();let done;const saving=commitPracticeDocument(r,{value:'new'},'Edit',{documentId:'d',revision:1},()=>new Promise(resolve=>done=resolve));
 assert.equal(r.saving,true);assert.equal(r.doc.content.value,'old');
 done({id:'d',kind:'chart',revision:2,content:{value:'committed'},export_warning:'Retry export'});await saving;assert.equal(r.draft.value,'committed');assert.equal(r.doc.export_warning,'Retry export');
 await assert.rejects(commitPracticeDocument(r,{value:'lost'},'Edit',{documentId:'d',revision:2},async()=>{throw Error('Offline');}));
 assert.equal(r.draft.value,'committed');assert.match(r.practiceSaveError.message,/Offline/);
});
