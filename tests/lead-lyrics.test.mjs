import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadAbcjs} from './abcjs-node.mjs';
import {analyzeScore} from '../chordbuddy/web/lead-sheet.js';
import {effectiveMeasures} from '../chordbuddy/web/chart-layout.js';
import {scoreNoteTimes,placeLyricsOnNotes,lyricForNote,secondsAtQuarter} from '../chordbuddy/web/lead-lyrics.js';

const song=JSON.parse(readFileSync(new URL('./fixtures/lead-sheet-song.json',import.meta.url)));
const abcjs=loadAbcjs();
const measures=effectiveMeasures(song.music,song.chart.layout);
const analysis=analyzeScore(song.abc,abcjs);
const times=scoreNoteTimes(analysis,measures);

test('a multi-bar rest is counted as the bars it really is, so the score and the chart agree on how many bars there are', () => {
  assert.equal(analysis.timeMeasures,measures.length);
  assert.equal(times.exact,true);
});

test('each melody note gets its real start time: they line up with the vocal melody the model found', () => {
  const notes=times.notes.filter(n=>Number.isFinite(n.time));
  assert.equal(notes.length,analysis.notes.length);
  assert.ok(Math.abs(notes[0].time-song.vocalOnsets[0])<.01,'the first note starts where the first vocal note does');
  // the score is written on a sixteenth-note grid (0.125 s here), so every note must land within a grid step of a real onset
  const far=notes.filter(n=>Math.min(...song.vocalOnsets.map(o=>Math.abs(o-n.time)))>.13);
  assert.ok(far.length<=notes.length*.1,`${far.length} of ${notes.length} notes are far from any real onset`);
  assert.ok(notes.every((n,i)=>i===0||n.time>=notes[i-1].time-1e-9),'notes are in time order');
  assert.ok(notes.every(n=>n.address&&typeof n.address.measure_id==='string'),'every note has an address a pin can use');
});

test('quarter-note offsets map onto the bar, and fall back to a straight line without a grid', () => {
  const bar={start:10,end:12,beats:[10,10.5,11,11.5],quarter_positions:[0,1,2,3,4]};
  assert.equal(secondsAtQuarter(bar,0),10);assert.equal(secondsAtQuarter(bar,2),11);assert.ok(Math.abs(secondsAtQuarter(bar,1.5)-10.75)<1e-9);
  assert.equal(secondsAtQuarter({start:0,end:4,beats:[]},2),2);
});

test('the chart words land on the notes in order, one word per note when there are enough', () => {
  const placed=placeLyricsOnNotes(song.chart,measures,times.notes);
  const verse=song.chart.sections.find(s=>s.name==='Verse');
  const words=verse.lyrics.split('\n')[0].split(' ');
  const notesFor=words.map((_,k)=>{const offset=verse.lyrics.split('\n')[0].split(' ').slice(0,k).join(' ').length+(k?1:0);return placed.byWord.get(`${verse.id}:0:${offset}`);});
  assert.ok(notesFor.every(n=>Number.isInteger(n)),'every word sits on a note');
  assert.ok(notesFor.every((n,i)=>i===0||n>notesFor[i-1]),'in order, each on a later note');
  const pin=song.chart.layout.lines.find(l=>l.section_id===verse.id&&l.line===0).words[0],bar=measures.find(m=>m.id===pin.measure_id);
  assert.ok(Math.abs(times.notes[notesFor[0]].time-bar.start)<.2,'the first word, pinned at the start of a bar, sits on the first note of that bar');
  assert.equal(placed.unplaced.some(u=>u.sectionId===verse.id),false);
});

test('a line in a stretch with no melody notes is reported, not forced onto the wrong notes', () => {
  const placed=placeLyricsOnNotes(song.chart,measures,times.notes);
  const intro=song.chart.sections.find(s=>s.name==='Intro');
  assert.deepEqual(placed.unplaced.filter(u=>u.sectionId===intro.id).map(u=>u.words),[7]);
});

test('more words than notes: notes carry two words and nothing is lost', () => {
  const m=[{id:'a',number:1,start:0,end:2,beats:[0,.5,1,1.5],meter:[4,4],quarter_positions:[0,1,2,3,4]}];
  const content={version:1,duration:2,sections:[{id:'s',name:'V',start:0,end:2,lyrics:'one two three four five six'}],chords:[],layout:{bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'s',line:0,start_measure:'a',end_measure:'a',words:[]}]}};
  const notes=[{index:0,time:0},{index:1,time:1},{index:2,time:1.5}];
  const placed=placeLyricsOnNotes(content,m,notes);
  const all=[...placed.byNote.values()].flat();
  assert.equal(all.length,6);assert.deepEqual(all.map(w=>w.text),['one','two','three','four','five','six']);
  assert.ok([...placed.byNote.values()].some(w=>w.length>1));
});

test('pinned words stay on the note nearest their pin, and hyphens join syllables across notes', () => {
  const m=[{id:'a',number:1,start:0,end:4,beats:[0,1,2,3],meter:[4,4],quarter_positions:[0,1,2,3,4]}];
  const content={version:1,duration:4,sections:[{id:'s',name:'V',start:0,end:4,lyrics:'hel- lo to you'}],chords:[],layout:{bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'s',line:0,start_measure:'a',end_measure:'a',words:[{offset:8,measure_id:'a',beat:2}]}]}};
  const notes=[0,.5,1,1.5,2,2.5,3].map((time,index)=>({index,time}));
  const placed=placeLyricsOnNotes(content,m,notes);
  assert.equal(placed.byWord.get('s:0:8'),4);                                 // "to" is pinned at beat 3 = note at 2 s
  assert.equal(placed.byWord.get('s:0:0'),0);
  assert.deepEqual(lyricForNote(placed.byNote.get(0)),{syllable:'hel',divider:'-'});
  assert.deepEqual(lyricForNote(placed.byNote.get(4)),{syllable:'to',divider:' '});
  assert.equal(lyricForNote(undefined),null);
});
