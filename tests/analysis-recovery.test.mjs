import test from 'node:test';import assert from 'node:assert/strict';
import * as view from '../chordbuddy/web/analysis-view.js';
test('failed retry label preserves the distinction from losing all transcription',()=>{
 assert.equal(view.songStatusLabel({status:'failed',active_run:'old'}),'Saved chart; latest analysis failed');
 assert.equal(view.songStatusLabel({status:'failed',active_run:null}),'Transcription failed');
});
test('confidence replacement error explains preserved output instead of demanding inference',()=>{
 const error="[WinError 5] Access is denied: confidence.json.tmp -> confidence.json";
 assert.match(view.analysisErrorMessage(error,true),/earlier chart and stems are preserved/i);
 assert.match(view.analysisErrorMessage(error,false),/confidence metadata/i);
 assert.equal(view.analysisErrorMessage('Other failure',true),'Other failure');
});
