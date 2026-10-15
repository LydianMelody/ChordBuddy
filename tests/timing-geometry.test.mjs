import test from 'node:test';
import assert from 'node:assert/strict';
import {ZOOM_LEVELS,DEFAULT_ZOOM,stepZoom,beatPx,isFixed,dragLimits,allowedTime,nearestAllowed,previewTimes,releasedTimes,barWidths,barTargets,nearestTarget,beatToX,SNAPS} from '../chordbuddy/web/timing-geometry.js';

const bar=(id,start)=>({id,number:+id.slice(1)+1,start,end:start+2,beats:[0,.5,1,1.5].map(b=>start+b),meter:[4,4],quarter_positions:[0,1,2,3,4]});

test('chart zoom steps through 0.75x to 6x, starting at 2x, and stops at the ends', () => {
  assert.deepEqual([...ZOOM_LEVELS],[.75,1,1.5,2,3,4,6]);assert.equal(DEFAULT_ZOOM,2);
  assert.equal(stepZoom(2,1),3);assert.equal(stepZoom(2,-1),1.5);assert.equal(stepZoom(6,1),6);assert.equal(stepZoom(.75,-1),.75);assert.equal(stepZoom(2.2,1),3);
  assert.equal(beatPx(2),64);assert.equal(beatPx(.75),24);
});

test('snaps offered are 1/4, 1/8, 1/16 and 1/32', () => {
  assert.deepEqual(SNAPS.map(s=>s[1]),['1/4','1/8','1/16','1/32']);
});

test('pins and older chord bindings are fixed; spread words and the implicit first word are not', () => {
  assert.equal(isFixed({kind:'pin'}),true);assert.equal(isFixed({kind:'chord'}),true);assert.equal(isFixed({kind:'spread'}),false);assert.equal(isFixed({kind:'start'}),false);
});

// five words: pinned, spread, spread, pinned, spread over a row of 0..16 s
const times=[0,2,4,6,10],fixed=[true,false,false,true,false];

test('a word can be dragged anywhere between its nearest pinned neighbours', () => {
  assert.deepEqual(dragLimits(times,fixed,1,0,16),{left:0,right:6,leftFixed:true,rightFixed:true});
  assert.deepEqual(dragLimits(times,fixed,2,0,16),{left:0,right:6,leftFixed:true,rightFixed:true});
  assert.deepEqual(dragLimits(times,fixed,3,0,16),{left:0,right:16,leftFixed:true,rightFixed:false});    // a pinned word moves between the pins around it
  assert.deepEqual(dragLimits(times,fixed,4,0,16),{left:6,right:16,leftFixed:true,rightFixed:false});
});

test('a pinned neighbour is a wall: a word lands strictly between pins, never on one', () => {
  const f=[true,false,true],t=[0,3,8],limits=dragLimits(t,f,1,0,16);
  assert.equal(allowedTime(0,limits),false);assert.equal(allowedTime(8,limits),false);assert.equal(allowedTime(.5,limits),true);assert.equal(allowedTime(7.5,limits),true);
  assert.equal(allowedTime(-1,limits),false);assert.equal(allowedTime(9,limits),false);
});

test('the ends of the row are inclusive, so the first word can sit right at the start', () => {
  const limits=dragLimits([4,6],[false,false],0,2,12);
  assert.deepEqual(limits,{left:2,right:12,leftFixed:false,rightFixed:false});
  assert.equal(allowedTime(2,limits),true);assert.equal(allowedTime(12,limits),true);assert.equal(allowedTime(1.9,limits),false);assert.equal(allowedTime(12.1,limits),false);
});

test('past a pinned neighbour, the nearest grid point that is still between the pins is used', () => {
  const f=[true,false,true],t=[0,3,8],limits=dragLimits(t,f,1,0,16);
  const grid=[0,1,2,3,4,5,6,7,8,9].map(seconds=>({seconds}));
  assert.equal(nearestAllowed(grid,-5,limits).seconds,1);       // dragged far left: stops one step after the left pin
  assert.equal(nearestAllowed(grid,99,limits).seconds,7);       // dragged far right: stops one step before the right pin
  assert.equal(nearestAllowed(grid,4.2,limits).seconds,4);
});

test('with no grid point between two pins there is no place to drop', () => {
  const limits=dragLimits([0,1,2],[true,false,true],1,0,16);
  assert.equal(nearestAllowed([{seconds:0},{seconds:2}],1,limits),null);
});

test('dragging a word makes it a pin and the unpinned words between its neighbours slide with it', () => {
  const t=previewTimes(times,fixed,1,4,0,16);   // word 1 pinned at 4 s, word 3 pinned at 6 s
  assert.deepEqual(t.slice(0,4),[0,4,5,6]);     // word 2 now spreads between 4 and 6
  assert.ok(t[4]>6);
});

test('dragging a pinned word re-spreads the words between it and its neighbours', () => {
  const t=previewTimes(times,fixed,3,9,0,16);
  assert.deepEqual(t.slice(0,4),[0,3,6,9]);
});

test('words outside the neighbours of the dragged word do not move', () => {
  const f=[true,false,true,false,true],t=[0,2,4,6,8];
  const p=previewTimes(t,f,1,3,0,16);assert.equal(p[0],0);assert.equal(p[2],4);assert.equal(p[3],6);assert.equal(p[4],8);
});

test('releasing a pin spreads that word between its neighbours again', () => {
  const t=releasedTimes([0,1,3,6],[true,false,true,true],2,0,12);
  assert.deepEqual(t.slice(0,2),[0,1].map((_,i)=>t[i]));assert.ok(t[1]>0&&t[1]<t[2]&&t[2]<6);assert.equal(t[3],6);
});

test('releasing the first word leaves it at the start of the row', () => {
  const t=releasedTimes([3,5,8],[true,false,true],0,0,12);
  assert.equal(t[0],0);assert.equal(t[2],8);
});

test('every bar is at least its beats wide, and no two words in a lane touch', () => {
  const bars=[{id:'a',beats:4},{id:'b',beats:4}];
  const narrow=barWidths(bars,[[{barId:'a',beat:0,width:30},{barId:'b',beat:0,width:30}]],64);
  assert.equal(narrow.get('a'),256);assert.equal(narrow.get('b'),256);
  const crowded=barWidths(bars,[[{barId:'a',beat:0,width:80},{barId:'a',beat:.5,width:80},{barId:'a',beat:1,width:40}]],64);
  assert.ok(crowded.get('a')>256);
  // the first two words are half a beat apart, so half a beat of the bar must hold the first word plus the gap
  assert.ok(crowded.get('a')*.5/4>=80+8-1e-6);
});

test('a word near the end of a bar widens the bar, but one right at the barline does not', () => {
  const bars=[{id:'a',beats:4}];
  assert.ok(barWidths(bars,[[{barId:'a',beat:3,width:200}]],64).get('a')>256);
  assert.equal(barWidths(bars,[[{barId:'a',beat:3.9,width:200}]],64).get('a'),256);
});

test('across a barline the last word and the next bar\'s first word share the room', () => {
  const bars=[{id:'a',beats:4},{id:'b',beats:4}];
  const w=barWidths(bars,[[{barId:'a',beat:3.5,width:120},{barId:'b',beat:0,width:50}]],64);
  const room=.5/4*w.get('a');assert.ok(room>=120+8-1e-6,'room '+room);
  const free=barWidths(bars,[[{barId:'a',beat:3.5,width:120},{barId:'b',beat:2,width:50}]],64);
  assert.ok(free.get('a')<w.get('a'));
});

test('chord labels and words are separate lanes, so a word never forces room just because a chord is near', () => {
  const bars=[{id:'a',beats:4}];
  const w=barWidths(bars,[[{barId:'a',beat:0,width:40}],[{barId:'a',beat:.25,width:40}]],64);assert.equal(w.get('a'),256);
});

test('grid targets in a bar follow the chosen snap, and chord onsets and pins are included', () => {
  const m=bar('m0',0);
  assert.equal(barTargets(m,{snap:'quarter'}).length,4);
  assert.equal(barTargets(m,{snap:'eighth'}).length,8);
  assert.equal(barTargets(m,{snap:'sixteenth'}).length,16);
  assert.equal(barTargets(m,{snap:'thirty-second'}).length,32);
  const withOnset=barTargets(m,{snap:'quarter',onsets:[.75]});assert.ok(withOnset.some(t=>Math.abs(t.seconds-.75)<1e-9&&t.kinds.includes('onset')));
  assert.ok(withOnset.every((t,i)=>!i||t.beat>=withOnset[i-1].beat));
});

test('a bar with no musical grid still offers beat subdivisions', () => {
  const m={...bar('m0',0),quarter_positions:null};
  const targets=barTargets(m,{snap:'quarter'});assert.equal(targets.length,4);assert.equal(barTargets(m,{snap:'eighth'}).length,8);
});

test('a pointer position snaps to the nearest target', () => {
  const m=bar('m0',0),targets=barTargets(m,{snap:'eighth'});
  // a 256 px wide bar: beat 0 at x=0, beat 0.5 at x=32, beat 1 at x=64
  assert.equal(nearestTarget(targets,30,256,4).beat,.5);assert.equal(nearestTarget(targets,50,256,4).beat,1);assert.equal(nearestTarget(targets,-20,256,4).beat,0);
  assert.equal(nearestTarget(targets,9999,256,4).beat,3.5);assert.equal(nearestTarget([],10,256,4),null);
  assert.equal(beatToX(1,256,4),64);
});
