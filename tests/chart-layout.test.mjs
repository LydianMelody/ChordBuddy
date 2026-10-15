import test from 'node:test';
import assert from 'node:assert/strict';
const path='../chordbuddy/web/chart-layout.js';
async function moduleUnderTest(){let m;try{m=await import(path);}catch{}assert.ok(m,'Measure layout module must be implemented');return m;}
const measures=Array.from({length:8},(_,i)=>({id:`m${i}`,number:i+1,start:i*2,end:i*2+2,beats:[i*2,i*2+.5,i*2+1,i*2+1.5],meter:[4,4]}));
const section={id:'s0',name:'Chorus',start:0,end:16,lyrics:'And I need you\nOn my own'};
import {splitChartSection,mergeChartSection,editChartSection} from '../chordbuddy/web/editor.js';
import {updateAbcDraft} from '../chordbuddy/web/editor.js';
import {validatePlacements} from '../chordbuddy/web/chart-layout.js';

test('melody edits clear syllables immediately while chord and title edits preserve them',()=>{
  const content={abc:'T:Song\nK:C\n"C"C D|',chords:[],engraving:{anchors:[{index:0,text:'And'}]}};
  assert.equal(updateAbcDraft(content,'T:Rename\nK:C\n"Dm"C D|',[]).engraving.anchors.length,1);
  const edited=updateAbcDraft(content,'T:Song\nK:C\n"C"E D|',[]);
  assert.deepEqual(edited.engraving.anchors,[]);
  assert.deepEqual(updateAbcDraft(edited,edited.abc+' E|',[]).engraving.anchors,[]);
});
test('barline changes reject placements whose section or beat no longer fits',()=>{
  const content=placedChart();content.layout.lines[0].words=[{offset:0,measure_id:'m0',beat:3}];
  content.layout.bar_overrides=[{id:'m1',start:1}];
  assert.throws(()=>validatePlacements(content,{measures}),/Unplace/);
  content.layout.lines=[];assert.equal(validatePlacements(content,{measures})[0].end,1);
});
test('eight bars form two four-bar systems without changing timing',async()=>{const {groupMeasures}=await moduleUnderTest();assert.deepEqual(groupMeasures(measures,section,{}).map(x=>x.map(m=>m.id)),[['m0','m1','m2','m3'],['m4','m5','m6','m7']]);assert.equal(measures[0].end,2);});
test('explicit breaks and odd phrases retain every bar',async()=>{const {groupMeasures}=await moduleUnderTest();assert.deepEqual(groupMeasures(measures.slice(0,6),section,{bars_per_line:4,breaks:['m3']}).map(x=>x.length),[3,3]);assert.deepEqual(groupMeasures(measures.slice(0,6),section,{bars_per_line:4}).map(x=>x.length),[4,2]);});
test('section starts a system without splitting bars',async()=>{const {groupMeasures}=await moduleUnderTest();assert.deepEqual(groupMeasures(measures,{...section,start:8},{}).map(x=>x.map(m=>m.id)),[['m4','m5','m6','m7']]);});
test('sustained harmony carries into the next measure and keeps gaps silent',async()=>{const {chordsInMeasure}=await moduleUnderTest();assert.deepEqual(chordsInMeasure([{id:'c',label:'C',start:.5,end:3}],measures[1]).map(c=>[c.id,c.beat,c.continued]),[['c',0,true]]);assert.equal(chordsInMeasure([{id:'c',label:'C',start:0,end:1}],measures[1]).length,0);});
test('lyrics remain unplaced until a user anchors text; later words stay a phrase',async()=>{const {lyricSegments}=await moduleUnderTest();assert.deepEqual(lyricSegments('And I need you',[]),[]);assert.deepEqual(lyricSegments('And I need you',[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m1',beat:2}]).map(x=>[x.text,x.measure_id,x.beat]),[['And I','m0',0],['need you','m1',2]]);});
test('manual placement preserves source lyrics and handles Unicode offsets',async()=>{const {placeWord}=await moduleUnderTest();const c={duration:16,sections:[{...section,lyrics:'🎵 I need you'}],chords:[]};const next=placeWord(c,'s0',0,4,'m1',2,measures);assert.equal(next.sections[0].lyrics,'🎵 I need you');assert.equal(c.layout,undefined);assert.deepEqual(next.layout.lines[0].words,[{offset:4,measure_id:'m1',beat:2}]);assert.throws(()=>placeWord(c,'s0',0,100,'m1',2,measures));});
test('moving a bar boundary updates both neighbors without mutating the source',async()=>{const {effectiveMeasures}=await moduleUnderTest();const result=effectiveMeasures({measures},{bar_overrides:[{id:'m1',start:2.1}]});assert.equal(result[0].end,2.1);assert.equal(result[1].start,2.1);assert.equal(result[1].beats[0],2.1);assert.equal(measures[0].end,2);assert.throws(()=>effectiveMeasures({measures},{bar_overrides:[{id:'m1',start:4.1}]}));});
const placedChart=()=>({version:1,duration:16,sections:[{...section}],chords:[],layout:{bars_per_line:4,breaks:[],lines:[{section_id:'s0',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0}]}],bar_overrides:[]}});
test('section split unplaces affected lines without losing original lyrics',()=>{const next=splitChartSection(placedChart(),'s0',4,'s1',{measures});assert.deepEqual(next.layout.lines,[]);assert.equal(next.sections[0].lyrics,section.lyrics);});
test('boundary edits retain safe placements and clear out-of-section ranges',()=>{const next=editChartSection(placedChart(),'s0',{end:4},{measures});assert.deepEqual(next.layout.lines,[]);assert.equal(editChartSection(placedChart(),'s0',{name:'Refrain'},{measures}).layout.lines.length,1);});
test('merge remaps placed lyric lines and preserves their bar anchors',()=>{const content=placedChart();content.sections[0].end=8;content.sections.push({id:'s1',name:'Verse',start:8,end:16,lyrics:'Hello'});content.layout.lines.push({section_id:'s1',line:0,start_measure:'m4',end_measure:'m7',words:[{offset:0,measure_id:'m4',beat:0}]});const next=mergeChartSection(content,'s0',{measures});assert.equal(next.layout.lines[1].section_id,'s0');assert.equal(next.layout.lines[1].line,3);assert.equal(next.layout.lines[1].words[0].measure_id,'m4');});

test('editing one lyric line preserves untouched anchors and clears only changed references',async()=>{
  const {updateLyricLine}=await moduleUnderTest();
  const content=placedChart();content.sections[0].lyrics='Keep this\nChange me';
  content.layout.lines.push({section_id:'s0',line:1,start_measure:'m1',end_measure:'m2',words:[{offset:0,measure_id:'m1',beat:0}]});
  content.chords=[{id:'c0',label:'C',start:0,end:1,section_id:'s0',line:0,offset:0},{id:'c1',label:'G',start:2,end:3,section_id:'s0',line:1,offset:0}];
  const next=updateLyricLine(content,'s0',1,'Changed now');
  assert.equal(next.sections[0].lyrics,'Keep this\nChanged now');
  assert.equal(next.layout.lines.length,1);assert.equal(next.layout.lines[0].line,0);
  assert.equal(next.chords[0].line,0);assert.equal(next.chords[1].line,null);assert.equal(next.chords[1].offset,null);
  assert.equal(content.sections[0].lyrics,'Keep this\nChange me');
});

test('playback position reports the active bar and beat, including fractional beat spans',async()=>{
  const {playbackPosition}=await moduleUnderTest();
  assert.deepEqual(playbackPosition({measures},2.25),{measureId:'m1',measureIndex:1,beatIndex:0,beatStart:2,beatEnd:2.5});
  assert.deepEqual(playbackPosition({measures},3.75),{measureId:'m1',measureIndex:1,beatIndex:3,beatStart:3.5,beatEnd:4});
  assert.equal(playbackPosition({measures},16),null);
});

test('no-chord labels are silent display rests',async()=>{
  const {isNoChordLabel}=await moduleUnderTest();
  for(const label of [null,'','N','N.C.','n.c.',' NC '])assert.equal(isNoChordLabel(label),true);
  assert.equal(isNoChordLabel('C'),false);
});

test('explicit slot lyric entry appends source text and creates one manual anchor',async()=>{
  const {appendLyricLine}=await moduleUnderTest();
  const c={duration:16,sections:[{...section,lyrics:'Existing'}],chords:[],layout:{lines:[]}};
  const next=appendLyricLine(c,'s0','new words','m2',1,measures);
  assert.equal(next.sections[0].lyrics,'Existing\nnew words');
  assert.deepEqual(next.layout.lines[0].words,[{offset:0,measure_id:'m2',beat:1}]);
  assert.equal(c.sections[0].lyrics,'Existing');
});

test('partial-bar sections accept only anchor instants inside their span',async()=>{
 const {placeWord,validatePlacements}=await moduleUnderTest();
 const c={duration:16,sections:[{...section,start:.75,end:1.75,lyrics:'Hello'}],chords:[]};
 const saved=placeWord(c,'s0',0,0,'m0',2.5,measures);
 assert.equal(saved.layout.lines[0].words[0].beat,2.5);validatePlacements(saved,{measures});
 for(const beat of [1,3.5])assert.throws(()=>placeWord(c,'s0',0,0,'m0',beat,measures),/inside its section/);
 const bad=structuredClone(saved);bad.layout.lines[0].words[0].beat=3.5;assert.throws(()=>validatePlacements(bad,{measures}),/outside its section/);
 const retained=editChartSection(saved,'s0',{start:1},{measures});assert.equal(retained.layout.lines.length,1);
});
