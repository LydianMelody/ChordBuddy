import test from 'node:test';
import assert from 'node:assert/strict';
import {clampZoom,stepZoom,MIN_ZOOM,MAX_ZOOM} from '../chordbuddy/web/page-nav.js';

test('page zoom goes in tidy steps of ten percent and stays between half size and two and a half times',()=>{
  assert.equal(stepZoom(1,1),1.1);assert.equal(stepZoom(1,-1),.9);assert.equal(stepZoom(1.1,1),1.2);
  let z=1;for(let i=0;i<40;i++)z=stepZoom(z,1);assert.equal(z,MAX_ZOOM);
  for(let i=0;i<40;i++)z=stepZoom(z,-1);assert.equal(z,MIN_ZOOM);
  assert.equal(clampZoom(9),MAX_ZOOM);assert.equal(clampZoom(.01),MIN_ZOOM);assert.equal(clampZoom(1.2345),1.23);
});

test('floating point drift never leaves the zoom at an untidy value like 1.2000000000000002',()=>{
  let z=1;for(let i=0;i<7;i++)z=stepZoom(z,1);assert.equal(z,1.7);
  for(let i=0;i<7;i++)z=stepZoom(z,-1);assert.equal(z,1);
});
