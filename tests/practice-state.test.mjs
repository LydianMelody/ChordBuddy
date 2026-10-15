import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createPracticeState,practiceAction,selectedPass,buildPracticeMarkers} from '../chordbuddy/web/practice-state.js';
import {buildCompactChart} from '../chordbuddy/web/compact-chart.js';
const fixture=()=>{const f=JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));return {...f,view:buildCompactChart(f.content,f.music)};};
test('Reading pass then chord resolve the selected recorded occurrence; Edit never seeks',()=>{
 const {view}=fixture(),g=view.groups[0];let s=createPracticeState('s');let r=practiceAction(s,{type:'pass',groupId:g.id,passNumber:2},view,0);
 assert.deepEqual(r.intent,{type:'seek',seconds:8});s=r.state;
 r=practiceAction(s,{type:'chord',groupId:g.id,slotId:g.slots[1].id},view,0);assert.equal(r.intent.seconds,11);
 s=practiceAction(s,{type:'mode',mode:'edit'},view,0).state;
 r=practiceAction(s,{type:'pass',groupId:g.id,passNumber:3},view,8);assert.equal(r.intent,null);assert.equal(selectedPass(r.state,g,8),3);
 r=practiceAction(r.state,{type:'chord',groupId:g.id,slotId:g.slots[0].id},view,8);assert.equal(r.intent.type,'edit-chord');assert.equal(r.intent.chordId,'c8');
 assert.equal(practiceAction(s,{type:'mode',mode:'reading'},view,8).intent,null);
});
test('draft blocks navigation and mode changes; remembered target differs from actual playback',()=>{
 const {view}=fixture(),g=view.groups[0],s=createPracticeState('s');assert.equal(selectedPass(s,g,20),3);
 s.selectedPasses[g.id]=2;s.draft={text:'local'};
 const r=practiceAction(s,{type:'mode',mode:'edit'},view,20);assert.equal(r.state.mode,'reading');assert.match(r.message,/Save or Cancel/);
 assert.equal(selectedPass(r.state,g,20),2);
});
test('markers follow canonical sections only, never performed pass boundaries',()=>{
 const {view}=fixture(),markers=buildPracticeMarkers(view);assert.deepEqual(markers.map(m=>[m.sectionName,m.seconds,m.end]),[['Chorus',0,32]]);
 assert.equal(markers[0].passNumber,undefined);assert.equal(markers[0].passCount,undefined);
});
