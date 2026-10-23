import test from 'node:test';
import assert from 'node:assert/strict';
import {snapGrain,snapPoints,snapTime,snapRange,moveEdge,dragEdge,sectionAtSeconds,describeRange,stepSpeed,BEAT_ZOOM} from '../chordbuddy/web/loop-range.js';

// Four 4/4 bars at 120 BPM: 2 s per bar, 0.5 s per beat.
const measures=[0,1,2,3].map(i=>({id:'m'+i,number:i+1,start:i*2,end:i*2+2,beats:[0,.5,1,1.5].map(b=>i*2+b),meter:[4,4],quarter_positions:[0,1,2,3,4]}));
const opts=grain=>({grain,duration:8});

test('grain is bars when zoomed out and beats once zoomed in', () => {
  assert.equal(snapGrain(100,{start:0,end:100}),'bar');
  assert.equal(snapGrain(100,{start:0,end:100/(BEAT_ZOOM-.5)}),'bar');
  assert.equal(snapGrain(100,{start:10,end:10+100/BEAT_ZOOM}),'beat');
  assert.equal(snapGrain(100,null),'bar');
});

test('snap points are bar lines (plus the song end) or every beat', () => {
  assert.deepEqual(snapPoints(measures,'bar'),[0,2,4,6,8]);
  assert.equal(snapPoints(measures,'beat').length,17);
  assert.deepEqual(snapPoints([],'bar'),[]);
});

test('snapTime picks the nearest grid line', () => {
  const points=snapPoints(measures,'bar');
  assert.equal(snapTime(points,2.9),2);assert.equal(snapTime(points,3.1),4);assert.equal(snapTime(points,100),8);
  assert.equal(snapTime([],3.3),3.3);
});

test('a dragged range snaps both edges, in either drag direction', () => {
  assert.deepEqual(snapRange(measures,2.4,5.7,opts('bar')),{start:2,end:6});
  assert.deepEqual(snapRange(measures,5.7,2.4,opts('bar')),{start:2,end:6});
  assert.deepEqual(snapRange(measures,2.4,3.1,opts('beat')),{start:2.5,end:3});
});

test('a tiny drag widens to one grid step instead of collapsing', () => {
  assert.deepEqual(snapRange(measures,2.1,2.2,opts('bar')),{start:2,end:4});
  assert.deepEqual(snapRange(measures,7.9,7.95,opts('bar')),{start:6,end:8});
  assert.deepEqual(snapRange(measures,2.1,2.2,opts('beat')),{start:2,end:2.5});
});

test('without a musical grid the range is free but still ordered and clamped', () => {
  assert.deepEqual(snapRange([],5,1,opts('bar')),{start:1,end:5});
  assert.deepEqual(snapRange([],-3,50,opts('bar')),{start:0,end:8});
});

test('moving one edge keeps at least one grid step between the edges', () => {
  const range={start:2,end:6};
  assert.deepEqual(moveEdge(measures,range,'start',3.2,opts('bar')),{start:4,end:6});
  assert.deepEqual(moveEdge(measures,range,'start',9,opts('bar')),{start:4,end:6});
  assert.deepEqual(moveEdge(measures,range,'end',2.1,opts('bar')),{start:2,end:4});
  assert.deepEqual(moveEdge(measures,range,'end',99,opts('bar')),{start:2,end:8});
  assert.deepEqual(moveEdge(measures,range,'start',-5,opts('bar')),{start:0,end:6});
});

test('the section under a time is found by half-open interval', () => {
  const sections=[{id:'a',start:0,end:4},{id:'b',start:4,end:8}];
  assert.equal(sectionAtSeconds(sections,3.99).id,'a');assert.equal(sectionAtSeconds(sections,4).id,'b');
  assert.equal(sectionAtSeconds(sections,8),null);assert.equal(sectionAtSeconds(null,1),null);
});

test('range labels name bars', () => {
  assert.equal(describeRange(measures,{start:2,end:6}),'Bars 2–3');
  assert.equal(describeRange(measures,{start:2,end:4}),'Bar 2');
});

test('speed steps in fives and stays between 50% and 125%', () => {
  assert.equal(stepSpeed(100,-1),95);assert.equal(stepSpeed(100,1),105);
  assert.equal(stepSpeed(50,-1),50);assert.equal(stepSpeed(125,1),125);assert.equal(stepSpeed(102,1),105);
});

test('an edge dragged past the other one swaps roles with it', () => {
  assert.deepEqual(dragEdge(measures,{start:2,end:4},'start',5.1,opts('bar')),{range:{start:4,end:6},edge:'end'});
  assert.deepEqual(dragEdge(measures,{start:2,end:4},'end',0.9,opts('bar')),{range:{start:0,end:2},edge:'start'});
  assert.deepEqual(dragEdge(measures,{start:2,end:4},'start',0.4,opts('bar')),{range:{start:0,end:4},edge:'start'},'not crossing: as before');
});

test('with the magnet off, a loop edge goes exactly where it is dropped', () => {
  assert.deepEqual(snapPoints(measures,'free'),[]);
  assert.deepEqual(moveEdge(measures,{start:2,end:4},'end',5.37,opts('free')),{start:2,end:5.37});
  assert.deepEqual(dragEdge(measures,{start:2,end:4},'start',4.6,opts('free')).range,{start:4,end:4.6});
});
