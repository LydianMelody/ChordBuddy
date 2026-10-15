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

test('explicit rests and chord-bound N survive; only unanchored edge placeholders hide', () => {
  const chords=[chord('lead',null,0,1),chord('rest','N.C.',1,2),chord('anchor','N',2,3,{line:0,offset:0}),chord('sound','G',3,8),chord('tail','N',8,10)];
  const before=JSON.stringify(chords),p=chartPresentation({chords,duration:10});
  assert.deepEqual([...p.hidden].sort(),['lead','tail']);assert.equal(JSON.stringify(chords),before);
});
