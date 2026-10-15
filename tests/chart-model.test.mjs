import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildChartModel,playbackTarget} from '../chordbuddy/web/chart-model.js';

const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
function model(lyrics,lines){const f=fixture();if(lyrics!==undefined)f.content.sections[0].lyrics=lyrics;if(lines)f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines};return buildChartModel(f.content,f.music);}
const group=m=>m.sections[0].groups[0];
const words=(g,bar,lane=0)=>(g.bars[bar].chunks[0].lanes[lane]||[]).map(t=>t.text).join(' ');
const place=(line,start,end,words=[])=>({section_id:'s',line,start_measure:start,end_measure:end,words});

test('one progression played four times is one folded row of four bars', () => {
  const g=group(model(''));
  assert.equal(g.folded,true);assert.equal(g.passCount,4);assert.deepEqual(g.bars.map(b=>b.number),[1,2,3,4]);
  assert.deepEqual(g.bars.map(b=>b.chunks.map(c=>c.label)),[['G'],['C'],['D'],['C']]);
});

test('the repeat count is written right after the last repeated chord, once, and nowhere else', () => {
  const g=group(model(''));
  const repeats=g.bars.flatMap(b=>b.chunks).map(c=>c.repeat);
  assert.deepEqual(repeats,[0,0,0,4]);assert.equal(g.repeat,4);
});

test('a chart with no lyrics has no lyric lanes', () => {
  assert.equal(group(model('')).lanes.length,0);
});

test('lyrics that were never placed are plain flowing lines, not tied to any chord', () => {
  const g=group(model('First words\nDifferent words'));
  assert.deepEqual(g.lanes.map(l=>l.flow),[true,true]);assert.ok(g.bars.every(b=>b.chunks.every(c=>!Object.keys(c.lanes).length)));
});

test('placed words sit under the chord they fall within, and each line knows which pass it was sung in', () => {
  const g=group(model('First words\nDifferent words',[
    place(0,'m0','m3',[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m2',beat:2}]),
    place(1,'m4','m7')]));
  assert.equal(words(g,0,0),'First');assert.equal(words(g,2,0),'words');
  assert.deepEqual(g.lanes.map(l=>l.passNumber),[1,2]);
  assert.equal(words(g,0,1),'Different');                 // pass 2's first word, drawn on the shared bars
});

test('a word dragged to another chord moves under that chord', () => {
  const f=fixture();f.content.sections[0].lyrics='one two';
  const at=bar=>{f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[place(0,'m0','m3',[{offset:0,measure_id:'m0',beat:0},{offset:4,measure_id:bar,beat:0}])]};return group(buildChartModel(f.content,f.music));};
  assert.equal(words(at('m1'),1),'two');assert.equal(words(at('m3'),3),'two');assert.equal(words(at('m3'),1),'');
});

test('words keep their actual time for seeking, which can be in a later pass', () => {
  const g=group(model('First words\nDifferent words',[place(0,'m0','m3'),place(1,'m4','m7',[{offset:0,measure_id:'m4',beat:0}])]));
  const lane=g.lanes[1];assert.equal(lane.tokens[0].seconds,8);assert.ok(lane.tokens[0].displaySeconds<8);   // seeks to pass 2, drawn in pass 1's bar
});

test('pinned words say so, spread words do not', () => {
  const g=group(model('one two three',[place(0,'m0','m3',[{offset:0,measure_id:'m0',beat:0},{offset:8,measure_id:'m2',beat:0}])]));
  assert.deepEqual(g.lanes[0].tokens.map(t=>t.pinned),[true,false,true]);
});

test('playback names the playing chunk, pass and section; the page never has to move', () => {
  const m=model('');
  const t0=playbackTarget(m,1),t1=playbackTarget(m,9);
  assert.equal(t0.passNumber,1);assert.equal(t0.chunkKey,group(m).bars[0].chunks[0].key);
  assert.equal(t1.passNumber,2);assert.equal(t1.chunkKey,group(m).bars[0].chunks[0].key);   // same chunk, one pass later
  assert.equal(t1.passCount,4);assert.equal(playbackTarget(m,-5),null);assert.equal(playbackTarget(m,NaN),null);
});

test('a document with no measures still builds, with an honest warning instead of an error', () => {
  const f=fixture();f.music={measures:[]};
  const m=buildChartModel(f.content,f.music);
  assert.ok(m.warnings.length>0);assert.ok(m.sections.length>0);
});

test('building the model never changes the document', () => {
  const f=fixture(),before=JSON.stringify(f);buildChartModel(f.content,f.music);assert.equal(JSON.stringify(f),before);
});

// ---- ported from the old compact view: pickups, placeholders and charts without a beat grid ----
const labels=f=>buildChartModel(f.content,f.music).sections.flatMap(s=>s.groups).flatMap(g=>g.bars).flatMap(b=>b.chunks).map(c=>c.label);

test('a real pre-measure pickup is shown without changing canonical coverage', () => {
  const f=fixture();f.music.measures=f.music.measures.slice(1);f.content.chords[0].label='Em';const before=JSON.stringify(f);
  assert.ok(labels(f).includes('Em'));
  assert.ok(buildChartModel(f.content,f.music).projection.occurrences.some(o=>o.chordId==='c0'));
  assert.equal(JSON.stringify(f),before);
});

test('a saved N placeholder is not drawn as a chord, while explicit later N.C. and rests are', () => {
  const f=fixture();f.content.chords[0].label='N';f.content.chords[2].label='N.C.';f.content.chords[3].label='REST';
  const shown=labels(f);
  assert.ok(!shown.some(s=>/^(~ )?N$/.test(s)));assert.ok(shown.includes('N.C.'));assert.ok(shown.includes('REST'));
});

test('an explicit pickup measure keeps its musical chord and canonical times', () => {
  const f=fixture();f.music.measures[0].warning='Partial pickup before first downbeat';f.content.chords[0].label='Em';
  assert.ok(labels(f).includes('Em'));assert.equal(f.content.chords[0].start,0);
});

test('missing measure timing does not guess a later start', () => {
  const f=fixture();f.music.measures=[];f.content.chords[0].label='Em';
  assert.ok(labels(f).includes('Em'));
});

test('leading and trailing placeholders hide, but lyric-anchored and interior ones stay, and nothing is rewritten', () => {
  const chord=(id,label,start,end,anchor={})=>({id,label,start,end,section_id:'s',line:null,offset:null,...anchor});
  const content={version:1,duration:10,sections:[{id:'s',name:'Verse',start:0,end:10,lyrics:'Word'}],
    chords:[chord('lead',null,0,1),chord('rest','N.C.',1,2),chord('anchor','N',2,3,{line:0,offset:0}),chord('sound','G',3,8),chord('tail','N',8,10)]};
  const before=JSON.stringify(content);
  const m=buildChartModel(content,{measures:[]});
  const ids=m.sections.flatMap(s=>s.groups).flatMap(g=>g.bars).flatMap(b=>b.chunks).map(c=>c.chordId);
  assert.ok(!ids.includes('lead')&&!ids.includes('tail'));assert.ok(ids.includes('rest')&&ids.includes('anchor')&&ids.includes('sound'));
  assert.equal(JSON.stringify(content),before);
});
