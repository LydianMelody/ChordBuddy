import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadAbcjs} from './abcjs-node.mjs';
import {analyzeScore} from '../chordbuddy/web/lead-sheet.js';
import {effectiveMeasures} from '../chordbuddy/web/chart-layout.js';
import {scoreNoteTimes,placeLyricsOnNotes} from '../chordbuddy/web/lead-lyrics.js';
import {buildRuns,planRunEdits} from '../chordbuddy/web/lead-lyric-editor.js';
import {layoutLine} from '../chordbuddy/web/word-layout.js';

const song=JSON.parse(readFileSync(new URL('./fixtures/lead-sheet-song.json',import.meta.url)));
const measures=effectiveMeasures(song.music,song.chart.layout);
const analysis=analyzeScore(song.abc,loadAbcjs());
const times=scoreNoteTimes(analysis,measures);
const placed=placeLyricsOnNotes(song.chart,measures,times.notes);
const sectionAt=t=>song.chart.sections.find(s=>t>=s.start-1e-6&&t<s.end-1e-6)?.id??null;
// systems as the screen would lay them out: note 0-24, then 25-48 (this second one crosses from the Verse into the Chorus)
const system=(key,from,to)=>({key,notes:times.notes.slice(from,to+1).map(n=>({index:n.index,left:n.index*10,right:n.index*10+8,top:0,bottom:10,sectionId:sectionAt(n.time)})),lyricTop:12,lyricBottom:24});
const systems=[system('4',0,24),system('5',25,48)];
const ctx={content:song.chart,music:song.music,measures,times};
const verse=song.chart.sections.find(s=>s.name==='Verse'),chorus=song.chart.sections.find(s=>s.name==='Chorus');
const lineAfter=r=>r.content.sections.find(s=>s.id===verse.id).lyrics.split('\n');

test('a system that crosses into the next section is cut there, with an empty run where no words have been typed yet', () => {
  const runs=buildRuns(systems,placed.byNote);
  assert.deepEqual(runs.map(r=>[r.empty,r.sectionId]),[[false,verse.id],[true,verse.id],[true,chorus.id]]);
  assert.equal(runs[0].words.length,10);
  assert.ok(runs[1].notes.every(n=>n.sectionId===verse.id)&&runs[2].notes.every(n=>n.sectionId===chorus.id));
});

test('typing a new line stays inside its own section, starts at the clicked note and does not touch other lines', () => {
  const runs=buildRuns(systems,placed.byNote);
  const clicked=runs[1].notes[3].index;
  const result=planRunEdits(ctx,runs,1,'Racing past the moon and stars tonight',clicked);
  assert.deepEqual(lineAfter(result),['Dancing through the starlight with a unicorn by my side','Racing past the moon and stars tonight']);
  const line=result.content.layout.lines.find(l=>l.section_id===verse.id&&l.line===1);
  const bar=id=>measures.findIndex(m=>m.id===id),first=bar(line.start_measure),last=bar(line.end_measure);
  const vs=measures.findIndex(m=>m.end>verse.start+1e-6),ve=measures.findLastIndex(m=>m.start<verse.end-1e-6);
  assert.ok(first>=vs&&last<=ve&&first<=last,'the new line is placed only on bars of the Verse');
  assert.equal(line.words[0].measure_id,times.notes[clicked].address.measure_id);              // first word pinned where you clicked
  assert.equal(song.chart.sections.find(s=>s.id===verse.id).lyrics.split('\n').length,1);      // the original chart object is not changed
});

test('retyping a run changes only its words, keeps the first word pinned, and an untouched run saves nothing', () => {
  const runs=buildRuns(systems,placed.byNote);
  assert.equal(planRunEdits(ctx,runs,0,runs[0].words.map(w=>w.text).join(' ')),null);
  const result=planRunEdits(ctx,runs,0,'Dancing through the moonlight with a unicorn by my side');
  assert.deepEqual(lineAfter(result),['Dancing through the moonlight with a unicorn by my side']);
  const tokens=layoutLine(result.content,measures,verse.id,0).tokens;
  assert.deepEqual(tokens.filter(t=>t.pinned).map(t=>t.text),['Dancing']);
});

test('several pasted lines flow into the runs that follow, and too many lines is refused without changing anything', () => {
  const runs=buildRuns(systems,placed.byNote);
  const result=planRunEdits(ctx,runs,1,'Racing past the moon\nand into the chorus');
  assert.equal(lineAfter(result).length,2);
  assert.equal(result.content.sections.find(s=>s.id===chorus.id).lyrics,'and into the chorus');
  assert.throws(()=>planRunEdits(ctx,runs,1,'one\ntwo\nthree'),/3 lines of words but only 2/);
  assert.equal(ctx.content.sections.find(s=>s.id===chorus.id).lyrics,'');
});

test('clearing a run removes its words (and the line when nothing is left)', () => {
  const runs=buildRuns(systems,placed.byNote);
  const result=planRunEdits(ctx,runs,0,'');
  assert.deepEqual(lineAfter(result),['']);
});

// ---- pinning by dropping a word on a note ----
import {planPin,planUnpin} from '../chordbuddy/web/lead-lyric-editor.js';
const wordOf=(runs,text)=>runs.flatMap(r=>r.words).find(w=>w.text===text);

test('dropping a word on a note pins it to that note, and the unpinned words after it re-spread', () => {
  const runs=buildRuns(systems,placed.byNote),word=wordOf(runs,'unicorn');
  const target=times.notes.find(n=>n.time>=15.4&&n.time<16).index;             // a note in bar 8 of the Verse
  const result=planPin(ctx,word,target);
  const pin=result.content.layout.lines.find(l=>l.section_id===verse.id&&l.line===0).words.find(w=>w.offset===word.offset);
  assert.equal(pin.measure_id,times.notes[target].address.measure_id);
  assert.equal(result.label,'Pin word');
  const tokens=layoutLine(result.content,measures,verse.id,0).tokens;
  assert.ok(tokens.find(t=>t.text==='unicorn').pinned&&tokens.filter(t=>t.pinned).length===2);
});

test('a drop that would put a word out of order is refused with the reason', () => {
  const runs=buildRuns(systems,placed.byNote),word=wordOf(runs,'side');          // the last word, dropped on the first note of the line
  assert.throws(()=>planPin(ctx,word,times.notes[0].index),/after its preceding words|inside its section/);
});

test('releasing a pinned word, and releasing one that is not pinned', () => {
  const runs=buildRuns(systems,placed.byNote),first=runs[0].words[0];
  assert.equal(first.pinned,true);
  const result=planUnpin(ctx,first);
  const pins=result.content.layout.lines.find(l=>l.section_id===verse.id&&l.line===0).words;
  assert.equal(pins.length,0);
  assert.throws(()=>planUnpin(ctx,runs[0].words[3]),/not pinned/);
});
