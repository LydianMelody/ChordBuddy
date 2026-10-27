import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAbcjs} from './abcjs-node.mjs';
import {analyzeScore} from '../chordbuddy/web/lead-sheet.js';
import {placeChartOnScore,chordSymbolSpans} from '../chordbuddy/web/lead-chart.js';

const abcjs=loadAbcjs();
// four 2 s bars of 4/4 (a quarter is half a second); the score's own chords and section comments say something else
const ABC=['X:1','T:"Quoted"','M:4/4','L:1/4','V: Vocal name="Vocal"','K:C','% intro','V: Vocal','"C"z4|"C"c2d2|','% verse','V: Vocal','"G"e4|"^hi"f2"Am"g2|'].join('\n');
const measures=[0,2,4,6].map(start=>({start,end:start+2,beats:[start,start+.5,start+1,start+1.5],quarter_positions:[0,1,2,3,4]}));

test('the chart’s chords replace the score’s own, each on the note or rest where it starts', () => {
  const analysis=analyzeScore(ABC,abcjs);
  const chart={chords:[{id:'a',label:'N',start:0,end:2},{id:'b',label:'F',start:2,end:3},{id:'c',label:'Bb',start:3,end:4.5},{id:'e',label:'Eb',start:4.5,end:6},{id:'d',label:'Dm7',start:6.5,end:8}],
    sections:[{name:'Opening',start:0},{name:'Chorus',start:4}]};
  const placed=placeChartOnScore(ABC,analysis,measures,chart,label=>label==='Bb'?'B♭':label);
  const body=placed.abc.slice(placed.abc.indexOf('K:C'));
  assert.ok(placed.abc.startsWith('X:1\nT:"Quoted"'),'the header is left alone');
  assert.equal(body,'K:C\n% intro\nV: Vocal\nz4|"F"c2"B♭"d2|\n% verse\nV: Vocal\n"Eb"e4|"^hi"f2"Dm7"g2|','N has no symbol; a chord starting mid-note takes the note sounding; annotations stay');
  assert.deepEqual(placed.chords.map(c=>[c.id,placed.abc.slice(c.abc_index,c.abc_index+4)]),[['b','"F"c'],['c','"B♭"'],['e','"Eb"'],['d','"Dm7']]);
  assert.deepEqual(placed.sections,[{name:'Opening',measure:0},{name:'Chorus',measure:2}],'the chart’s names, on the bars where they start');
  const again=analyzeScore(placed.abc,abcjs);
  assert.deepEqual(again.notes.map(n=>n.pitch),analysis.notes.map(n=>n.pitch),'the same notes, in the same order');
});

test('only chord symbols in the music are found', () => {
  const spans=chordSymbolSpans(ABC).map(([a,b])=>ABC.slice(a,b));
  assert.deepEqual(spans,['"C"','"C"','"G"','"Am"']);
});
