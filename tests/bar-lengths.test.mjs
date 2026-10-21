import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadAbcjs} from './abcjs-node.mjs';
import {usualBeats,isOddBar,beatsLabel,meterOf,usualMeter,parseMeter} from '../chordbuddy/web/bar-lengths.js';
import {analyzeScore,engravingSettings,applyEngraving} from '../chordbuddy/web/lead-sheet.js';
import {effectiveMeasures} from '../chordbuddy/web/chart-layout.js';
import {buildChartModel} from '../chordbuddy/web/chart-model.js';

const bar=n=>({beats:Array.from({length:n},(_,i)=>i)});
test('the usual bar is the most common length, so one odd bar never defines it', () => {
  assert.equal(usualBeats([bar(4),bar(4),bar(2),bar(4)]),4);
  assert.equal(usualBeats([bar(3),bar(3),bar(4)]),3);
  assert.equal(usualBeats([]),4);
  assert.equal(isOddBar(bar(2),4),true);assert.equal(isOddBar(bar(4),4),false);assert.equal(isOddBar({beats:[]},4),false);
});

test('labels: informal beats for the chart, a real time signature for the lead sheet', () => {
  assert.equal(beatsLabel(2),'2 beats');assert.equal(beatsLabel(1),'1 beat');
  assert.deepEqual(meterOf(2),{num:'2',den:'4'});assert.equal(meterOf(0),null);assert.equal(meterOf(40),null);
});

const song=JSON.parse(readFileSync(new URL('./fixtures/lead-sheet-song.json',import.meta.url)));
test('the chart marks the one short bar of the sample song and no other', () => {
  const model=buildChartModel(song.chart,song.music);
  const bars=model.sections.flatMap(s=>s.groups.flatMap(g=>g.bars));
  const odd=bars.filter(b=>b.odd);
  assert.ok(odd.length>=1&&odd.every(b=>b.beatCount===2));
  assert.equal(model.usualBeats,4);
});

test('the lead sheet gets a 2/4 for the short bar and goes back to 4/4 after it', () => {
  const abcjs=loadAbcjs(),measures=effectiveMeasures(song.music,song.chart.layout);
  const analysis=analyzeScore(song.abc,abcjs),tune=abcjs.parseOnly(song.abc)[0];
  applyEngraving(tune,analysis,engravingSettings({}),null,{usual:usualBeats(measures),beats:measures.map(m=>m.beats.length)});
  const meters=[];
  for(const line of tune.lines)for(const staff of line.staff||[])for(const voice of staff.voices||[])for(const item of voice)if(item.el_type==='meter')meters.push(item.value[0].num+'/'+item.value[0].den);
  const vocal=meters.join(' ');
  assert.match(vocal,/2\/4 4\/4/);
});

test('the song\'s meter is the one most bars carry, so a stray 1/8 pickup tag never names it',()=>{
  const m=(meter,n=1)=>Array.from({length:n},()=>({meter}));
  assert.deepEqual(usualMeter([...m([1,8]),...m([4,4],40)]),[4,4]);
  assert.deepEqual(usualMeter([...m([3,4],5),...m([4,4],5)]),[4,4]);   // a tie goes to the later one
  assert.equal(usualMeter([{meter:null},{}]),null);assert.equal(usualMeter(undefined),null);
});
test('a saved time signature is read back only if it is one of the choices',()=>{
  assert.deepEqual(parseMeter('6/8'),[6,8]);assert.equal(parseMeter('1/8'),null);assert.equal(parseMeter(''),null);assert.equal(parseMeter('x'),null);
});
