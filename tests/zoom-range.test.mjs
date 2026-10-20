import test from 'node:test';
import assert from 'node:assert/strict';
import {clampRange,panRange,zoomRange,resizeRange,centerRange} from '../chordbuddy/web/zoom-range.js';

test('a range keeps its width and stays inside the total',()=>{
  assert.deepEqual(clampRange(-5,5,0,100),{start:0,end:10});
  assert.deepEqual(clampRange(95,105,0,100),{start:90,end:100});
  assert.deepEqual(clampRange(10,20,0,100),{start:10,end:20});
  assert.deepEqual(clampRange(0,500,0,100),{start:0,end:100},'never wider than the total');
  assert.deepEqual(clampRange(10,10.1,0,100,1),{start:10,end:11},'never thinner than the least allowed');
});

test('panning slides the range and stops at the ends',()=>{
  assert.deepEqual(panRange({start:10,end:20},5,0,100),{start:15,end:25});
  assert.deepEqual(panRange({start:10,end:20},-50,0,100),{start:0,end:10});
  assert.deepEqual(panRange({start:85,end:95},50,0,100),{start:90,end:100});
});

test('zooming keeps the point under the pointer where it is',()=>{
  const r=zoomRange({start:20,end:60},.5,30,0,100,1);          // twice as close, around 30 (a quarter of the way in)
  assert.equal(r.end-r.start,20);assert.equal((30-r.start)/20,.25);
  const out=zoomRange({start:20,end:30},100,25,0,100,1);assert.deepEqual(out,{start:0,end:100},'zooming right out shows everything');
  const limit=zoomRange({start:20,end:22},.01,21,0,100,1);assert.equal(limit.end-limit.start,1,'no closer than the least allowed');
});

test('dragging an end of the range zooms from that side only',()=>{
  assert.deepEqual(resizeRange({start:20,end:60},'start',30,0,100,1),{start:30,end:60});
  assert.deepEqual(resizeRange({start:20,end:60},'end',50,0,100,1),{start:20,end:50});
  assert.deepEqual(resizeRange({start:20,end:60},'start',70,0,100,5),{start:55,end:60},'cannot pass the other end');
  assert.deepEqual(resizeRange({start:20,end:60},'end',10,0,100,5),{start:20,end:25});
  assert.deepEqual(resizeRange({start:20,end:60},'start',-9,0,100,1),{start:0,end:60});
});

test('clicking the track puts the thumb in the middle of the click',()=>{
  assert.deepEqual(centerRange({start:0,end:20},50,0,100),{start:40,end:60});
  assert.deepEqual(centerRange({start:0,end:20},2,0,100),{start:0,end:20});
});
