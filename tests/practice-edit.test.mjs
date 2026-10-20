import test from 'node:test';import assert from 'node:assert/strict';
import {planChartChordDelete,planChartChordEdit,planSectionEdit} from '../chordbuddy/web/practice-edit.js';
const music={measures:[0,1,2,3].map(i=>({id:'m'+i,number:i+1,start:i*4,end:i*4+4,beats:[0,1,2,3].map(v=>v+i*4),meter:[4,4],quarter_positions:[0,1,2,3,4]}))};
const fixture=()=>({version:1,duration:16,sections:[{id:'a',name:'Verse',start:0,end:8,lyrics:'hello'},{id:'b',name:'End',start:8,end:16,lyrics:''}],chords:[{id:'c0',label:'C',start:0,end:4,section_id:'a',line:null,offset:null},{id:'c1',label:'G',start:4,end:8,section_id:'a',line:null,offset:null},{id:'c2',label:'C',start:8,end:16,section_id:'b',line:null,offset:null}],layout:{bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'a',line:0,start_measure:'m1',end_measure:'m1',words:[{offset:0,measure_id:'m1',beat:1/3}]}]}});
test('musical chord boundaries update shared edges and preserve original on invalid input',()=>{
 const f=fixture(),r=planChartChordEdit(f,music,{chordId:'c1',label:'Am',startAddress:{measure_id:'m0',beat:3.5}});
 assert.equal(r.candidate.chords[0].end,3.5);assert.equal(r.candidate.chords[1].start,3.5);assert.equal(f.chords[1].start,4);
 assert.throws(()=>planChartChordEdit(f,music,{chordId:'c1',label:'Am',endAddress:{measure_id:'m0',beat:0}}));
});
test('shared section boundary moves safely; named anchor conflict prevents silent removal',()=>{
 const f=fixture();const safe=planSectionEdit(f,music,{sectionId:'a',operation:'edit',fields:{name:'Verse A',endAddress:{measure_id:'m2',beat:1}}});
 assert.equal(safe.candidate.sections[0].end,9);assert.equal(safe.candidate.sections[1].start,9);
 const conflict=planSectionEdit(f,music,{sectionId:'a',operation:'edit',fields:{endAddress:{measure_id:'m0',beat:2}}});
 assert.equal(conflict.candidate,null);assert.match(conflict.conflicts[0].message,/hello/);
});
test('split transfers wholly placed lines and merge retains exact addresses',()=>{
 const f=fixture(),split=planSectionEdit(f,music,{sectionId:'a',operation:'split',fields:{address:{measure_id:'m1',beat:0},newId:'part'}});
 assert.equal(split.conflicts.length,0);assert.equal(split.candidate.sections[1].lyrics,'hello');assert.equal(split.candidate.layout.lines[0].words[0].beat,1/3);
 const merged=planSectionEdit(split.candidate,music,{sectionId:'a',operation:'merge',fields:{direction:'next'}});assert.equal(merged.conflicts.length,0);assert.equal(merged.candidate.sections[0].lyrics,'hello');
});

test('a surviving row at the same address cannot mask another row losing its placement',()=>{
 const f=fixture();f.sections[0].lyrics='First row\nSecond row';
 f.layout.lines=[{section_id:'a',line:0,start_measure:'m0',end_measure:'m1',words:[{offset:0,measure_id:'m0',beat:0}]},{section_id:'a',line:1,start_measure:'m0',end_measure:'m0',words:[{offset:0,measure_id:'m0',beat:0}]}];
 const before=JSON.stringify(f),result=planSectionEdit(f,music,{sectionId:'a',operation:'edit',fields:{endAddress:{measure_id:'m1',beat:0}}});
 assert.equal(result.candidate,null);assert.match(result.conflicts[0].message,/First row/);assert.equal(JSON.stringify(f),before);
});

test('deleting a chord gives its time to the chord before it, or after it when nothing comes before, and never leaves a hole',()=>{
 const f=fixture(),before=JSON.stringify(f);
 const mid=planChartChordDelete(f,music,{chordId:f.chords[1].id});
 assert.equal(mid.conflicts.length,0);assert.equal(mid.candidate.chords.length,f.chords.length-1);
 assert.equal(mid.candidate.chords[0].end,f.chords[1].end);assert.ok(!mid.candidate.chords.some(c=>c.id===f.chords[1].id));
 const first=planChartChordDelete(f,music,{chordId:f.chords[0].id});
 assert.equal(first.candidate.chords[0].id,f.chords[1].id);assert.equal(first.candidate.chords[0].start,f.chords[0].start);
 assert.equal(JSON.stringify(f),before);
 assert.throws(()=>planChartChordDelete(f,music,{chordId:'nope'}));
});
test('a chord with no neighbour touching it becomes a gap when deleted',()=>{
 const f=fixture();f.chords=[f.chords[0],{...f.chords[1],start:f.chords[1].start+1}];
 const r=planChartChordDelete(f,music,{chordId:f.chords[1].id});
 assert.equal(r.candidate.chords.length,2);assert.equal(r.candidate.chords[1].label,'N');
});
