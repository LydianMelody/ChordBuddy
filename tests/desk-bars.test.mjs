import test from 'node:test';
import assert from 'node:assert/strict';
import {installDom} from './compact-dom.mjs';
import {zoomForRange,combinedZoom} from '../chordbuddy/web/desk-bars.js';
import {createZoomBar} from '../chordbuddy/web/zoom-bar.js';

test('pulling the timing bar narrower zooms in by the same ratio, within the limits', () => {
  assert.equal(zoomForRange({start:0,end:.25},.5,2,[.75,6]),4,'a window half as wide shows twice the zoom');
  assert.equal(zoomForRange({start:0,end:1},.5,2,[.75,6]),1,'twice as wide shows half');
  assert.equal(zoomForRange({start:.3,end:.8},.5,2,[.75,6]),2,'the same width only scrolls');
  assert.equal(zoomForRange({start:0,end:.01},.5,2,[.75,6]),6,'never past the largest zoom');
  assert.equal(zoomForRange({start:0,end:1},.1,2,[.75,6]),.75,'never past the smallest');
  assert.equal(zoomForRange({start:.5,end:.5},.5,2,[.75,6]),2,'an empty range changes nothing');
});

test('a zoom bar made with zoom:false is a plain scroll bar', () => {
  installDom();
  const plain=createZoomBar({vertical:true,zoom:false,lo:0,hi:1,getRange:()=>({start:0,end:.2}),setRange(){}});
  const zooming=createZoomBar({lo:0,hi:1,getRange:()=>({start:0,end:.2}),setRange(){}});
  assert.match(plain.el.className,/\bnozoom\b/);
  assert.doesNotMatch(zooming.el.className,/\bnozoom\b/);
});

test('past the smallest beat grid, zooming out shrinks the page too, and zooming back in gives the page its own zoom back', () => {
  let t=2,p=1;const timing={get:()=>t,set:v=>{t=v;},limits:[.75,6]},page={get:()=>p,set:v=>{p=v;}};
  const z=combinedZoom(timing,page,.5);
  assert.deepEqual(z.limits,[.375,6]);
  z.set(1.5);assert.deepEqual([t,p],[1.5,1],'above the smallest grid only the grid zooms');
  z.set(.5);assert.equal(t,.75);assert.ok(Math.abs(p-2/3)<1e-9,'below it the grid stays smallest and the page shrinks');
  z.set(.1);assert.deepEqual([t,p],[.75,.5],'never below half size');
  z.set(3);assert.deepEqual([t,p],[3,1],'zooming back in restores the page first');
  z.set(.5);z.release();assert.equal(p,1,'leaving the Time tool gives the page its zoom back');
});

test('a page zoom of your own is kept: the grid zooms within it, and it comes back after shrinking', () => {
  let t=2,p=1.5;const z=combinedZoom({get:()=>t,set:v=>{t=v;},limits:[.75,6]},{get:()=>p,set:v=>{p=v;}},.5);
  z.set(1.5);assert.deepEqual([t,p],[1,1.5]);
  z.set(.6);assert.equal(t,.75);assert.ok(p<1.5);
  z.set(4.5);assert.deepEqual([t,p],[3,1.5]);
});

test('with a ceiling, pulling the grips in past the largest grid grows the page, as far as Ctrl+wheel goes', () => {
  let t=2,p=1;const z=combinedZoom({get:()=>t,set:v=>{t=v;},limits:[.75,6]},{get:()=>p,set:v=>{p=v;}},.5,2.5);
  assert.deepEqual(z.limits,[.375,15]);
  z.set(12);assert.deepEqual([t,p],[6,2]);
  z.set(99);assert.deepEqual([t,p],[6,2.5],'never past the largest page zoom');
  z.set(3);assert.deepEqual([t,p],[3,1],'zooming back out gives the page its own zoom back');
  z.set(9);z.release();assert.equal(p,1);
});
