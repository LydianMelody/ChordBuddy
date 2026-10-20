import test from 'node:test';
import assert from 'node:assert/strict';
import { activeChord, replaceAbcChord, editChordContent, isJobActive, abcChordTokens, validateChart, reassignChartChords, splitChartSection, mergeChartSection, displayChordLabel, editChartSection, editChartChord, addChartChord, settleHistoryResult, startChordAtMeasure } from '../chordbuddy/web/editor.js';

test('chord replacement keeps notes, lyric quotes, and other chord tokens intact', () => {
  const abc = 'X:1\nT:Song\nK:C\n"C"C2 "G7"G2 |\nw: hello world';
  const index = abc.indexOf('"G7"');
  assert.equal(replaceAbcChord(abc, index, 'Dm7'), abc.replace('"G7"', '"Dm7"'));
  assert.equal(replaceAbcChord('"C"C "C"D', 5, 'F'), '"C"C "F"D');
});
test('chord edits reject incorrect association and unsafe labels', () => {
  assert.throws(() => replaceAbcChord('"C"C', 3, 'G'));
  assert.throws(() => replaceAbcChord('"C"C', 0, 'G"\nK:D'));
});
test('playback chord has inclusive start and exclusive end', () => {
  const chords = [{id:'a',start:0,end:2,label:'C'},{id:'b',start:2,end:4,label:'G'}];
  assert.equal(activeChord(chords, 0)?.id, 'a');
  assert.equal(activeChord(chords, 2)?.id, 'b');
  assert.equal(activeChord(chords, 4), null);
  assert.equal(activeChord(chords, -1), null);
});
test('editing one chord updates subsequent associations and leaves timing independent', () => {
  const content = {abc:'"C"C2 "G"G2',chords:[
    {id:'a',start:0,end:2,label:'C',abc_index:0},
    {id:'b',start:2,end:4,label:'G',abc_index:6}
  ]};
  const edited=editChordContent(content,'a','Cmaj7');
  assert.equal(edited.abc,'"Cmaj7"C2 "G"G2');
  assert.equal(edited.chords[1].abc_index,10);
  assert.equal(edited.chords[0].end,2);
  assert.equal(content.abc,'"C"C2 "G"G2');
  assert.equal(editChordContent(edited,'b','Dm').abc,'"Cmaj7"C2 "Dm"G2');
});

test('partial transcription is terminal while startup and cancellation remain busy', () => {
  for (const status of ['starting','running','cancelling']) assert.equal(isJobActive({status}),true);
  for (const status of ['partial','completed','failed','cancelled','error']) assert.equal(isJobActive({status}),false);
  assert.equal(isJobActive(null),false);
});

test('notation chord associations ignore headers, comments and annotations, retain repeats', () => {
  const abc='X:1\nT:Quoted "title"\nK:C\n"C"C2 "^instruction"D2 % "comment"\n"G"G2 "C"C2';
  assert.deepEqual(abcChordTokens(abc),['C','G','C'].map((label,index)=>({label,index:index===0?abc.indexOf('"C"'):index===1?abc.indexOf('"G"'):abc.lastIndexOf('"C"')})));
});

const chart=()=>({version:1,duration:10,sections:[{id:'s',name:'Verse',start:0,end:10,lyrics:'Hello world'}],chords:[{id:'c',label:'C',start:6,end:8,section_id:'s',line:0,offset:6}]});
test('chart validates section boundaries and lyric anchors',()=>{
  assert.equal(validateChart(chart()),null);
  const invalid=chart();invalid.chords[0].offset=100;assert.ok(validateChart(invalid));
  const overlap=chart();overlap.sections.push({id:'b',name:'Chorus',start:9,end:10,lyrics:''});assert.ok(validateChart(overlap));
});
test('split reassigns later chords without inventing lyric alignment',()=>{
  const original=chart();const split=splitChartSection(original,'s',5,'second');
  assert.equal(split.chords[0].section_id,'second');assert.equal(split.chords[0].line,null);
  assert.equal(original.sections.length,1);assert.equal(split.sections[0].end,5);
});
test('merge preserves anchored lyric line positions and rejects boundary gaps with chords',()=>{
  const content=splitChartSection(chart(),'s',5,'second');content.sections[1].lyrics='Sing again';content.chords[0].line=0;content.chords[0].offset=0;
  const merged=mergeChartSection(content,'s');assert.equal(merged.sections[0].lyrics,'Hello world\n\nSing again');assert.equal(merged.chords[0].line,2);assert.equal(validateChart(merged),null);
  content.sections[1].start=7;assert.throws(()=>reassignChartChords(content));
});

test('legacy chord labels display musician symbols without mutating documents',()=>{
  assert.equal(displayChordLabel('Cmaj/3'),'C/E');assert.equal(displayChordLabel('A#:min/b3'),'A#m/C#');assert.equal(displayChordLabel('Ghdim7/b7'),'Gm7b5/F');assert.equal(displayChordLabel('unfamiliar quality'),'unfamiliar quality');
});

test('moving shared section boundary moves its neighbor and reassigns chords',()=>{
  const content=splitChartSection(chart(),'s',5,'second');const edited=editChartSection(content,'s',{end:7});
  assert.equal(edited.sections[1].start,7);assert.equal(edited.chords[0].section_id,'s');assert.equal(content.sections[0].end,5);
  assert.throws(()=>editChartSection(content,'s',{end:10}));
});
test('adding chord splits existing coverage and shared chord boundaries move together',()=>{
  const content=chart();content.chords[0].start=0;content.chords[0].end=10;
  const added=addChartChord(content,4,'new','G');assert.equal(added.chords[0].end,4);assert.equal(added.chords[1].label,'G');assert.equal(added.chords[1].end,10);assert.equal(added.chords[0].label,'C');
  const edited=editChartChord(added,'new',{start:3});assert.equal(edited.chords[0].end,3);assert.equal(edited.chords[1].start,3);
  assert.throws(()=>addChartChord(content,0,'new'));assert.throws(()=>editChartChord(added,'new',{start:0}));
});

test('starting a selected chord at a bar start only crosses a no-chord lead-in',()=>{
  const chords=[
    {id:'n',label:'N',start:0,end:1.5},
    {id:'am',label:'Am',start:1.5,end:2},
    {id:'g',label:'G',start:2,end:4},
  ],measure={start:0,end:2};
  assert.deepEqual(startChordAtMeasure(chords,'am',measure),{start:0,end:2});
  assert.equal(chords[0].end,1.5);
  assert.deepEqual(startChordAtMeasure([{id:'g',label:'G',start:0,end:1.5},...chords.slice(1)],'am',measure),null);
  assert.equal(startChordAtMeasure(chords,'n',measure),null);
  assert.equal(startChordAtMeasure([{...chords[0]},{...chords[1],start:0},chords[2]],'am',measure),null);
});

test('history response preserves edits created while history request was in flight',()=>{
  const record={doc:{revision:2},draft:{text:'new typing'},dirty:true,version:1,error:null};
  settleHistoryResult(record,{revision:3,content:{text:'undo result'}},0);
  assert.equal(record.doc.revision,3);assert.equal(record.draft.text,'new typing');assert.equal(record.dirty,true);
  const clean={doc:{revision:2},draft:{text:'before undo'},dirty:false,version:0,error:null};
  settleHistoryResult(clean,{revision:3,content:{text:'undo result'}},0);
  assert.equal(clean.draft.text,'undo result');assert.equal(clean.dirty,false);
});
test('inference progress counts completed windows, never the current window', async () => {
  const helpers=await import('../chordbuddy/web/editor.js');
  assert.equal(typeof helpers.jobProgress,'function');
  assert.deepEqual(helpers.jobProgress({status:'running',stage:'encoding',window:1,windows:1}),{percent:0,indeterminate:true});
  assert.deepEqual(helpers.jobProgress({status:'running',stage:'decoding',window:2,windows:3}),{percent:30,indeterminate:false});
  assert.deepEqual(helpers.jobProgress({status:'running',stage:'window_complete',window:3,windows:3}),{percent:90,indeterminate:false});
  assert.deepEqual(helpers.jobProgress({status:'running',stage:'notation',window:3,windows:3}),{percent:95,indeterminate:false});
  assert.deepEqual(helpers.jobProgress({status:'completed'}),{percent:100,indeterminate:false});
});
