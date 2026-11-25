// Pitch in a show: planned flags and live presses reach the sound like the speed does, and a chart repeat with a change inside is written out.
import test from 'node:test';
import assert from 'node:assert/strict';
import {newPerformance,address} from '../chordbuddy/web/performance-model.js';
import {Sim,grid,RATE} from './performance-sim.mjs';
import {buildChartModel} from '../chordbuddy/web/chart-model.js';
import fs from 'node:fs';
import {setKeySpelling,setChartPitch,spellChord} from '../chordbuddy/web/spelling.js';

const SECTIONS=[{id:'a',name:'Intro',start:0,end:16},{id:'b',name:'Verse',start:16,end:48},{id:'c',name:'Chorus',start:48,end:120}];
const cue=(id,i,action)=>({id,at:address(`m${i}`),action});
const song=cues=>({...newPerformance({songId:'s',id:'p'}),cues});

test('a pitch flag changes the sound at its bar, and the song keeps its stretcher running from the start', () => {
  const s=new Sim({performance:song([cue('up',5,{type:'pitch.set',semitones:3,applyTo:'both'})]),sections:SECTIONS});
  s.runSeconds(14);
  assert.ok(s.pitches.length>=1);
  const up=s.pitches.find(p=>p.semitones===3);
  assert.ok(up,'the +3 reached the engine');assert.equal(up.keep,true);
  assert.ok(Math.abs(up.played-8*RATE)<RATE*.05,`at bar 5 (8 s): ${up.played/RATE}`);
  const chart=s.out.filter(e=>e.type==='pitch');assert.equal(chart.at(-1).chart,3);
});

test('a sound-only flag leaves the chart alone; a chart-only flag sends nothing to the sound', () => {
  const s=new Sim({performance:song([cue('a',3,{type:'pitch.set',semitones:-2,applyTo:'sound'}),cue('b',6,{type:'pitch.set',semitones:4,applyTo:'chart'})]),sections:SECTIONS});
  s.runSeconds(14);
  assert.deepEqual(s.pitches.filter(p=>p.semitones!==0).map(p=>p.semitones),[-2]);
  const out=s.out.filter(e=>e.type==='pitch');
  assert.equal(out[0].chart,undefined);assert.equal(out[1].chart,4);assert.equal(out[1].sound,undefined);
});

test('a pitch press in a show takes over from later planned pitch flags, as a speed press does', () => {
  const s=new Sim({performance:song([cue('later',8,{type:'pitch.set',semitones:2})]),sections:SECTIONS});
  s.runSeconds(4);
  assert.equal(s.runner.setLive('pitch.sound',-1).accepted,true);
  s.runSeconds(14);
  assert.equal(s.pitches.at(-1).semitones,-1,'the live -1 holds; the flag at bar 8 is passed over');
});

// the shared chart fixture: one Verse whose G C D C repeats four times, with words in the first two times through and one sung just
// before the second time begins
function chart(){
  const f=JSON.parse(fs.readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
  f.content.sections=[{id:'v',name:'Verse',start:0,end:32,lyrics:'one two three four'}];for(const c of f.content.chords)c.section_id='v';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[{section_id:'v',line:0,start_measure:'m0',end_measure:'m15',
    words:[{offset:0,measure_id:'m0',beat:0},{offset:4,measure_id:'m3',beat:3},{offset:8,measure_id:'m4',beat:1},{offset:14,measure_id:'m8',beat:0}]}]};
  return f;
}
const wordsIn=g=>(JSON.stringify(g).match(/"text":"([a-z]+)"/g)||[]).map(x=>x.slice(8,-1));

test('a show’s pitch change inside a repeat writes that repeat out, one row per time through; the saved chart is untouched and no word is lost', () => {
  const f=chart(),saved=JSON.stringify(f.content);
  const folded=buildChartModel(f.content,f.music),unfolded=buildChartModel(f.content,f.music,{unfoldAt:[8]});
  assert.equal(JSON.stringify(f.content),saved);
  assert.equal(folded.sections[0].groups.length,1);assert.equal(folded.sections[0].groups[0].passes.length,4);
  const rows=unfolded.sections[0].groups;
  assert.equal(rows.length,4);assert.ok(rows.every(g=>!g.folded));
  for(const w of ['one','two','three','four'])assert.ok(rows.some(g=>wordsIn(g).includes(w)),w+' is shown');
  // today a word sung just before the second time through stays on the first row, by its time (see the report: needs Melody's call)
  assert.ok(wordsIn(rows[0]).includes('two'));
  // with no change inside it, the repeat stays folded
  assert.equal(buildChartModel(f.content,f.music,{unfoldAt:[40]}).sections[0].groups.length,1);
  // chords take the pitch at their own time
  setKeySpelling('G major');setChartPitch(0,[{at:8,offset:2}]);
  assert.equal(spellChord('G',4),'G');assert.equal(spellChord('G',8),'A');
  setKeySpelling(null);setChartPitch(0);
});
