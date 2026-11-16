import test from 'node:test';
import assert from 'node:assert/strict';
import {chartPresentation} from '../chordbuddy/web/chart-presentation.js';
// The page-level behavior of these rules (what is actually drawn) is covered in chart-model.test.mjs and chart-page.test.mjs.
const chord=(id,label,start,end,anchor={})=>({id,label,start,end,section_id:'s',line:null,offset:null,...anchor});

test('word-anchored placeholders survive and a wholly unknown chart stays intact', () => {
  const measures=[{id:'m',start:0,end:4,beats:[0,1,2,3]}],content={chords:[chord('lead',null,0,1),chord('anchored',null,1,2),chord('sound','G',2,3),chord('tail','N',3,4)],layout:{lines:[{words:[{measure_id:'m',beat:1}]}]}};
  const p=chartPresentation(content,measures);
  assert.deepEqual([...p.hidden],['lead','tail']);assert.ok(p.visible(content.chords[1]));
  assert.equal(chartPresentation({chords:[chord('a',null,0,4)]}).hidden.size,0);
});

test('a bar wholly in the silence before the recording makes a sound is silence; its chord carries on', () => {
  // Wonderland: the model's one-beat bar (0–0.34 s) over silence that ends at 0.33 s, under a C#m that lasts to 4.62 s
  const measures=[{id:'m0',start:0,end:.34,beats:[0]},{id:'m1',start:.34,end:2.48,beats:[.34,.69,1.05,1.41,1.76,2.12]},{id:'m2',start:2.48,end:4.62,beats:[2.48,2.83,3.19,3.55,3.9,4.26]}];
  const chords=[chord('first','C#:min',0,4.62),chord('next','E:maj',4.62,8.9)],content={chords,duration:9};
  const before=JSON.stringify(content),p=chartPresentation(content,measures,.33);
  assert.equal(p.start,.34);assert.equal(p.hidden.size,0);assert.ok(p.visible(chords[0]));
  assert.equal(JSON.stringify(content),before,'nothing is changed');
  assert.equal(chartPresentation(content,measures,2.4).start,2.48,'two silent bars');
  assert.equal(chartPresentation(content,measures,.2).start,0,'more than a moment of sound in the first bar: it is music');
  assert.equal(chartPresentation(content,measures,0).start,0,'sound from the very start');
  assert.equal(chartPresentation(content,measures).start,0,'sound start unknown');
  const sung={...content,layout:{lines:[{words:[{measure_id:'m0',beat:0}]}]}};
  assert.equal(chartPresentation(sung,measures,.33).start,0,'a bar with a word sung in it stays');
});

test('explicit rests and chord-bound N survive; only unanchored edge placeholders hide', () => {
  const chords=[chord('lead',null,0,1),chord('rest','N.C.',1,2),chord('anchor','N',2,3,{line:0,offset:0}),chord('sound','G',3,8),chord('tail','N',8,10)];
  const before=JSON.stringify(chords),p=chartPresentation({chords,duration:10});
  assert.deepEqual([...p.hidden].sort(),['lead','tail']);assert.equal(JSON.stringify(chords),before);
});
