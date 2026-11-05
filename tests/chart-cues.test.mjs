import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildChartModel} from '../chordbuddy/web/chart-model.js';
import {cueWords,placeCues,addCues,editCue,CUE_LENGTH} from '../chordbuddy/web/chart-cues.js';

const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));

test('a cue is one tidy line of a few words; nothing typed means no cue', () => {
  assert.equal(cueWords('  pick   scratch '),'pick scratch');
  assert.equal(cueWords('   '),'');
  assert.throws(()=>cueWords('x'.repeat(CUE_LENGTH+1)),/short/);
});

test('each cue sits on the chord being played at its moment, in its own pass', () => {
  const f=fixture(),model=buildChartModel(f.content,f.music);
  const placed=placeCues(model,[{id:'a',text:'pick scratch',start:0.5},{id:'b',text:'feedback',start:9}]);
  const all=[...placed.values()].flat();
  assert.deepEqual(all.map(p=>[p.cue.id,p.passNumber]).sort(),[['a',1],['b',2]]);
  const keyOf=id=>[...placed].find(([,list])=>list.some(p=>p.cue.id===id))[0];
  assert.equal(keyOf('a'),keyOf('b'),'the G of pass 1 and of pass 2 are one chunk of the folded row');
});

test('a cue in silence the chart hides is drawn on the nearest chord, never lost', () => {
  const f=fixture();for(const c of f.content.chords){c.start+=2;c.end+=2;}for(const m of f.music.measures){m.start+=2;m.end+=2;m.beats=m.beats.map(t=>t+2);}
  f.content.duration=36;f.content.sections[0].end=36;f.content.chords.unshift({id:'lead',label:'N',start:0,end:2,section_id:'s',line:null,offset:null});
  const model=buildChartModel(f.content,f.music),placed=placeCues(model,[{id:'a',text:'count-in',start:0.5}]);
  assert.equal([...placed.values()].flat().length,1);
});

test('adding writes one cue per time, sorted, and never the same words twice in one place; editing retypes or removes', () => {
  let n=0;const id=()=>'n'+(++n);
  const content={chords:[{id:'c',label:'G',start:0,end:2}],cues:[{id:'x',text:'feedback',start:5}]};
  const added=addCues(content,[2,0],'pick scratch',id);
  assert.deepEqual(added.cues.map(c=>[c.text,c.start]),[['pick scratch',0],['pick scratch',2],['feedback',5]]);
  assert.equal(addCues(added,[0],'pick scratch',id).cues.length,3,'already there');
  assert.deepEqual(added.chords,content.chords,'the chords are untouched');
  assert.equal(content.cues.length,1,'the chart given is never changed');
  assert.equal(editCue(added,'x','big feedback').cues.at(-1).text,'big feedback');
  assert.deepEqual(editCue(added,'x','').cues.map(c=>c.id),['n2','n1']);
  assert.throws(()=>editCue(added,'gone','a'),/no longer/);
  assert.deepEqual(addCues({chords:[]},[1],'count-in',id).cues.map(c=>c.text),['count-in'],'a chart with no cues yet gets a list');
});
