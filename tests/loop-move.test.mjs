// Moving a planned loop (the purple band) to other bars: by dragging its flags or typing its bars, on the Perform tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import {addRepeat,address,newPerformance} from '../chordbuddy/web/performance-model.js';
import {addressPosition} from '../chordbuddy/web/performance-compiler.js';
import {loopMoved} from '../chordbuddy/web/performance-prepare.js';

const measures=Array.from({length:16},(_,i)=>({id:`m${i+1}`,number:i+1,start:i*2,end:i*2+2,beats:[i*2,i*2+.5,i*2+1,i*2+1.5]}));
const position=at=>addressPosition(measures)(at)/44100;
const withLoops=()=>{
  let p=newPerformance({songId:'s',id:'p'});
  p=addRepeat(p,{start:address('m5'),end:address('m9'),plays:2,family:'bars',id:'a'});      // bars 5 to 8
  p=addRepeat(p,{start:address('m12'),end:address('m14'),plays:'live',family:'bars',id:'b'}); // bars 12 and 13
  return p;
};

test('a loop moves to the bars asked for, keeping its plays and passes', () => {
  const before=withLoops(),kept=structuredClone(before),{performance,error}=loopMoved(before,'a',measures,5,9,position);   // bars 6 to 10
  assert.equal(error,undefined);
  const a=performance.regions.find(r=>r.id==='a');
  assert.deepEqual([position(a.start),position(a.end)],[10,20]);
  assert.equal(a.plays,2);assert.equal(a.passes.length,before.regions[0].passes.length);
  assert.equal(a.family,'section','five bars is a section-sized loop');
  assert.deepEqual(before,kept,'the arrangement it came from is untouched');
});

test('to the very last bar, the loop ends on that bar’s last line', () => {
  const {performance}=loopMoved(withLoops(),'b',measures,13,15,position);
  const b=performance.regions.find(r=>r.id==='b');
  assert.deepEqual(b.end,{measure:'m16',beat:{n:4,d:1}});assert.equal(position(b.end),32);
});

test('what cannot be is refused in plain words', () => {
  assert.match(loopMoved(withLoops(),'a',measures,7,5,position).error,/end on or after/);
  assert.match(loopMoved(withLoops(),'a',measures,4,11,position).error,/overlap another loop/);
  assert.match(loopMoved(withLoops(),'a',measures,0,40,position).error,/no such bar/);
  assert.match(loopMoved(withLoops(),'zz',measures,0,1,position).error,/gone/);
});
