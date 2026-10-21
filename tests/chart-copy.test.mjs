import test from 'node:test';
import assert from 'node:assert/strict';
import {copyTargets,copySectionLyrics} from '../chordbuddy/web/chart-copy.js';
import {effectiveMeasures,validatePlacements} from '../chordbuddy/web/chart-layout.js';
import {validateChart} from '../chordbuddy/web/editor.js';

// eight 4-beat bars of 2 seconds each; Chorus 1 is bars 1-4, Chorus 2 is bars 5-8 (or 5-7)
const bar=i=>({id:'m'+i,number:i+1,start:i*2,end:i*2+2,beats:[0,.5,1,1.5].map(t=>i*2+t),meter:[4,4]});
const music={measures:Array.from({length:8},(_,i)=>bar(i))};
const content=(second={start:8,end:16})=>({duration:16,chords:[],
  sections:[{id:'a',name:'Chorus 1',start:0,end:8,lyrics:'where did you learn\nhow much can I be'},{id:'b',name:'Chorus 2',start:second.start,end:second.end,lyrics:'old words here'}],
  layout:{bars_per_line:4,breaks:[],bar_overrides:[],lines:[
    {section_id:'a',line:0,start_measure:'m0',end_measure:'m1',words:[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m0',beat:2},{offset:10,measure_id:'m1',beat:1}]},
    {section_id:'b',line:0,start_measure:'m4',end_measure:'m4',words:[{offset:0,measure_id:'m4',beat:0}]}]}});

test('sections with the same name, numbered or not, can be copied onto each other',()=>{
  assert.deepEqual(copyTargets(content(),'a').map(s=>s.id),['b']);
  const plain=content();plain.sections[0].name='Chorus';plain.sections[1].name='Chorus 2';plain.sections.push({id:'c',name:'Verse',start:16,end:17,lyrics:''});
  assert.deepEqual(copyTargets(plain,'a').map(s=>s.id),['b']);
  const none=content();none.sections[0].lyrics='  ';assert.deepEqual(copyTargets(none,'a'),[]);
  const other=content();other.sections[1].name='Bridge';assert.deepEqual(copyTargets(other,'a'),[]);
});

test('the lyrics and every pin move to the same bar and beat of the other section, replacing what was there',()=>{
  const c=content(),{candidate,kept,dropped}=copySectionLyrics(c,music,'a','b');
  assert.equal(candidate.sections[1].lyrics,c.sections[0].lyrics);assert.equal(c.sections[1].lyrics,'old words here');   // the original is untouched
  const lines=candidate.layout.lines.filter(p=>p.section_id==='b');
  assert.deepEqual(lines.map(p=>p.line),[0]);
  assert.deepEqual(lines[0].words,[{offset:0,measure_id:'m4',beat:0},{offset:6,measure_id:'m4',beat:2},{offset:10,measure_id:'m5',beat:1}]);
  assert.deepEqual([lines[0].start_measure,lines[0].end_measure],['m4','m5']);assert.equal(kept,3);assert.equal(dropped,0);
  assert.equal(validateChart(candidate),null);validatePlacements(candidate,music);   // the saved chart would accept it
  assert.equal(candidate.layout.lines.filter(p=>p.section_id==='a').length,1);       // the source keeps its own
});

test('a pin with no place in a shorter section is let go and the rest stay in order',()=>{
  const short=content({start:8,end:9.9});   // one bar
  const {candidate,kept,dropped}=copySectionLyrics(short,music,'a','b');
  const words=candidate.layout.lines.find(p=>p.section_id==='b').words;
  assert.deepEqual(words.map(w=>w.measure_id),['m4','m4']);assert.equal(kept,2);assert.equal(dropped,1);
  validatePlacements(candidate,music);
});

test('copying needs two sections and words to copy',()=>{
  assert.throws(()=>copySectionLyrics(content(),music,'a','a'),/two different/);
  const empty=content();empty.sections[0].lyrics='';assert.throws(()=>copySectionLyrics(empty,music,'a','b'),/no lyrics/);
});
