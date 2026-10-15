import test from 'node:test';
import assert from 'node:assert/strict';
import {validateChunk,availableCredit} from '../chordbuddy/web/pcm-stream.js';
test('wire checks reject wrong run, rate and payload length',()=>{
 const expected={runId:'r',startFrame:0,frameCount:10};
 const headers=new Map([['X-Stem-Run-Id','r'],['X-Stem-Start-Frame','0'],['X-Stem-Frame-Count','10'],['X-Stem-Sample-Rate','44100']]);
 assert.equal(validateChunk(headers,new ArrayBuffer(640),expected),10);
 assert.throws(()=>validateChunk(headers,new ArrayBuffer(600),expected));
 headers.set('X-Stem-Run-Id','other');assert.throws(()=>validateChunk(headers,new ArrayBuffer(640),expected));
 assert.equal(availableCredit(441000,0),0);assert.equal(availableCredit(441000,44100),44100);
});

