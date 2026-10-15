import test from 'node:test';
import assert from 'node:assert/strict';
import {editDistance,similarity,alignWords,warpOffsets,replaceLineText,appendLine,removeLine,SIMILAR_WORD} from '../chordbuddy/web/lyric-warp.js';

const pins=(content,line=0)=>(content.layout.lines.find(p=>p.line===line)?.words||[]).map(w=>[w.offset,w.measure_id,w.beat]);
const doc=(lyrics,words,chords=[])=>({version:1,duration:16,sections:[{id:'s',name:'V',start:0,end:16,lyrics}],chords,layout:{bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words}]}});

test('edit distance counts a swap of neighbours as one edit', () => {
  assert.equal(editDistance('teh','the'),1);assert.equal(editDistance('wrold','world'),1);assert.equal(editDistance('kitten','sitting'),3);assert.equal(editDistance('',''),0);assert.equal(editDistance('a','b'),1);
});

test('words are the same if they differ only in case, punctuation or syllable hyphens', () => {
  assert.equal(similarity('Hello,','hello'),1);assert.equal(similarity('un-','un'),1);assert.equal(similarity("Don't",'dont'),1);
});

test('a typo-sized change still counts as the same word, a different word does not', () => {
  assert.ok(similarity('wrold','world')>0&&similarity('wrold','world')<1);
  assert.ok(similarity('teh','the')>0);
  assert.ok(similarity('shine','shrine')>0);
  assert.equal(similarity('moon','sun'),0);assert.equal(similarity('love','hate'),0);
  assert.ok(SIMILAR_WORD===0.4);
});

test('alignment pairs identical sequences one to one', () => {
  assert.deepEqual(alignWords(['a','b','c'],['a','b','c']),[[0,0],[1,1],[2,2]]);
});

test('an inserted word leaves every other word paired with itself', () => {
  assert.deepEqual(alignWords(['shine','bright','tonight'],['shine','so','bright','tonight']),[[0,0],[1,2],[2,3]]);
});

test('a deleted word is simply unpaired', () => {
  assert.deepEqual(alignWords(['shine','so','bright'],['shine','bright']),[[0,0],[2,1]]);
});

test('a retyped word pairs with its fixed version, an unrelated replacement does not', () => {
  assert.deepEqual(alignWords(['the','wrold','tonight'],['the','world','tonight']),[[0,0],[1,1],[2,2]]);
  assert.deepEqual(alignWords(['the','moon','tonight'],['the','sun','tonight']),[[0,0],[2,2]]);
});

test('exact matches beat typo matches', () => {
  assert.deepEqual(alignWords(['wrold','world'],['world']),[[1,0]]);
});

test('an extra repeated word lands at the end, so earlier words keep their pairs', () => {
  assert.deepEqual(alignWords(['la','la','la'],['la','la','la','la']),[[0,0],[1,1],[2,2]]);
});

test('empty sides pair nothing', () => {
  assert.deepEqual(alignWords([],['a']),[]);assert.deepEqual(alignWords(['a'],[]),[]);assert.deepEqual(alignWords([],[]),[]);
});

test('offsets follow the words when text is inserted before them', () => {
  const {map,lost}=warpOffsets('shine bright','oh shine bright');
  assert.equal(map.get(0),3);assert.equal(map.get(6),9);assert.deepEqual(lost,[]);
});

test('typing a missing word keeps every pin and shifts them to their words', () => {
  const content=doc('shine bright tonight',[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m1',beat:2},{offset:13,measure_id:'m3',beat:1}]);
  const {candidate,lost}=replaceLineText(content,'s',0,'shine so bright tonight');
  assert.equal(candidate.sections[0].lyrics,'shine so bright tonight');assert.equal(lost,0);
  assert.deepEqual(pins(candidate),[[0,'m0',0],[9,'m1',2],[16,'m3',1]]);
});

test('fixing a typo in a pinned word keeps its pin', () => {
  const content=doc('hello wrold tonight',[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m2',beat:1.5}]);
  const {candidate,lost}=replaceLineText(content,'s',0,'hello world tonight');
  assert.equal(lost,0);assert.deepEqual(pins(candidate),[[0,'m0',0],[6,'m2',1.5]]);
});

test('deleting a pinned word drops only that pin and says how many were lost', () => {
  const content=doc('one two three',[{offset:0,measure_id:'m0',beat:0},{offset:4,measure_id:'m1',beat:0},{offset:8,measure_id:'m2',beat:0}]);
  const {candidate,lost}=replaceLineText(content,'s',0,'one three');
  assert.equal(lost,1);assert.deepEqual(pins(candidate),[[0,'m0',0],[4,'m2',0]]);
});

test('replacing a word with an unrelated one drops its pin; the rest stay put', () => {
  const content=doc('the moon rises',[{offset:0,measure_id:'m0',beat:0},{offset:4,measure_id:'m1',beat:0},{offset:9,measure_id:'m2',beat:0}]);
  const {candidate,lost}=replaceLineText(content,'s',0,'the sun rises');
  assert.equal(lost,1);assert.deepEqual(pins(candidate),[[0,'m0',0],[8,'m2',0]]);
});

test('older chord bindings follow their words too, and lose their binding only if the word is gone', () => {
  const chords=[{id:'c1',label:'C',start:0,end:2,section_id:'s',line:0,offset:4},{id:'c2',label:'G',start:2,end:4,section_id:'s',line:0,offset:8}];
  const {candidate,lost}=replaceLineText(doc('one two three',[],chords),'s',0,'one 2 two three');
  assert.equal(candidate.chords[0].offset,6);assert.equal(candidate.chords[1].offset,10);
  const gone=replaceLineText(doc('one two three',[],chords),'s',0,'one three').candidate;
  assert.equal(gone.chords[0].line,null);assert.equal(gone.chords[0].offset,null);assert.equal(gone.chords[1].offset,4);
});

test('the row a line was placed on survives even when every pin is lost', () => {
  const content=doc('one two',[{offset:0,measure_id:'m0',beat:0}]);
  const {candidate}=replaceLineText(content,'s',0,'completely different');
  const p=candidate.layout.lines[0];assert.equal(p.start_measure,'m0');assert.equal(p.end_measure,'m3');assert.deepEqual(p.words,[]);
});

test('other lines are untouched, and the original document is never changed', () => {
  const content=doc('one two\nthree four',[{offset:0,measure_id:'m0',beat:0}]);const before=JSON.stringify(content);
  const {candidate}=replaceLineText(content,'s',0,'uno two');
  assert.equal(candidate.sections[0].lyrics.split('\n')[1],'three four');assert.equal(JSON.stringify(content),before);
});

test('line breaks typed into a line become spaces, and surrounding spaces are trimmed', () => {
  const {candidate}=replaceLineText(doc('a b',[]),'s',0,'  a\nb c  ');assert.equal(candidate.sections[0].lyrics,'a b c');
});

test('only existing lines can be replaced', () => {
  assert.throws(()=>replaceLineText(doc('a',[]),'s',3,'x'),/existing lyric line/);assert.throws(()=>replaceLineText(doc('a',[]),'nope',0,'x'),/existing section/);
});

test('a new line goes at the end and reports its index', () => {
  assert.deepEqual(appendLine(doc('',[]),'s','first').line,0);
  const r=appendLine(doc('first',[]),'s','  second ');assert.equal(r.line,1);assert.equal(r.candidate.sections[0].lyrics,'first\nsecond');
  assert.throws(()=>appendLine(doc('a',[]),'s','   '),/Type some words/);
});

test('removing a line renumbers the lines, pins and chord bindings after it', () => {
  const content=doc('one\ntwo\nthree',[{offset:0,measure_id:'m0',beat:0}]);
  content.layout.lines.push({section_id:'s',line:1,start_measure:'m1',end_measure:'m1',words:[{offset:0,measure_id:'m1',beat:0}]},{section_id:'s',line:2,start_measure:'m2',end_measure:'m2',words:[{offset:0,measure_id:'m2',beat:1}]});
  content.chords=[{id:'c',label:'C',start:4,end:6,section_id:'s',line:2,offset:0},{id:'d',label:'D',start:2,end:4,section_id:'s',line:1,offset:0}];
  const next=removeLine(content,'s',1);
  assert.equal(next.sections[0].lyrics,'one\nthree');
  assert.deepEqual(next.layout.lines.map(p=>[p.line,p.words[0].measure_id]),[[0,'m0'],[1,'m2']]);
  assert.equal(next.chords[0].line,1);assert.equal(next.chords[1].line,null);assert.equal(next.chords[1].offset,null);
});

test('emoji and combining accents are counted as single characters, so pins land on the right offsets', () => {
  const content=doc('😀u-ni e\u0301-lan tail',[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m1',beat:1},{offset:13,measure_id:'m2',beat:0}]);
  const {candidate,lost}=replaceLineText(content,'s',0,'😀u-ni oh e\u0301-lan tail');
  assert.equal(lost,0);assert.deepEqual(pins(candidate),[[0,'m0',0],[9,'m1',1],[16,'m2',0]]);
});

test('joining two words into one keeps the first word pinned and drops only the vanished boundary', () => {
  const content=doc('moon light shines',[{offset:0,measure_id:'m0',beat:0},{offset:5,measure_id:'m1',beat:0},{offset:11,measure_id:'m2',beat:0}]);
  const {candidate}=replaceLineText(content,'s',0,'moonlight shines');
  assert.deepEqual(pins(candidate).map(p=>p[1]),['m0','m2']);
});

test('splitting a word into syllables keeps its pin on the first syllable', () => {
  const content=doc('shine unicorn tonight',[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m1',beat:0},{offset:14,measure_id:'m3',beat:0}]);
  const {candidate,lost}=replaceLineText(content,'s',0,'shine u-ni-corn tonight');
  assert.equal(lost,0);assert.deepEqual(pins(candidate),[[0,'m0',0],[6,'m1',0],[16,'m3',0]]);
});

test('joining syllables back into one word keeps the first syllable pin and says only the extra boundaries were lost', () => {
  const content=doc('shine u-ni-corn tonight',[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m1',beat:0},{offset:8,measure_id:'m2',beat:0},{offset:16,measure_id:'m3',beat:0}]);
  const {candidate,lost}=replaceLineText(content,'s',0,'shine unicorn tonight');
  assert.equal(lost,1);assert.deepEqual(pins(candidate).map(p=>p[1]),['m0','m1','m3']);
});
