import test from 'node:test';
import assert from 'node:assert/strict';
import * as editor from '../chordbuddy/web/editor.js';
const fixture=()=>({version:1,duration:4,sections:[{id:'a',name:'Verse',start:0,end:2,lyrics:'héllo'},{id:'b',name:'End',start:2,end:4,lyrics:''}],chords:[{id:'c',label:'C',start:2,end:3,section_id:'b',line:null,offset:null}]});
test('rename changes only name',()=>{assert.equal(typeof editor.renameChartSection,'function');const before=fixture();const after=editor.renameChartSection(before,'a','New');assert.deepEqual(after,{...before,sections:[{...before.sections[0],name:'New'},before.sections[1]]});assert.equal(before.sections[0].name,'Verse');});
test('backward empty merge preserves earlier contents and chord times',()=>{assert.equal(typeof editor.mergeAdjacentChartSections,'function');const after=editor.mergeAdjacentChartSections(fixture(),'b','previous');assert.deepEqual(after.sections,[{id:'a',name:'Verse',start:0,end:4,lyrics:'héllo'}]);assert.equal(after.chords[0].start,2);assert.equal(after.chords[0].section_id,'a');});
test('gaps require explicit acceptance and invalid directions preserve input',()=>{assert.equal(typeof editor.mergeAdjacentChartSections,'function');const before=fixture();before.sections[1].start=2.5;assert.throws(()=>editor.mergeAdjacentChartSections(before,'a','next'),/gap/i);assert.equal(editor.mergeAdjacentChartSections(before,'a','next',{acceptGap:true}).sections.length,1);assert.throws(()=>editor.mergeAdjacentChartSections(before,'a','previous'));assert.equal(before.sections.length,2);});
test('section action waits for durable flush and rejects failed saves or selection changes',async()=>{
 let release,applied=0,id='a';const flush=new Promise(r=>release=r);
 const pending=editor.runSectionAction(()=>flush,()=>id,()=>applied++);
 assert.equal(applied,0);release({ok:true});await pending;assert.equal(applied,1);
 await assert.rejects(editor.runSectionAction(async()=>({ok:false}),()=>id,()=>applied++),/saving/i);
 await assert.rejects(editor.runSectionAction(async()=>{id='b';return {ok:true};},()=>id,()=>applied++),/changed/i);
 assert.equal(applied,1);
});
