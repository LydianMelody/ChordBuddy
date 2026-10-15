import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('analysis view exposes cache-aware action and measured stage progress',async()=>{
 assert.ok(fs.existsSync(new URL('../chordbuddy/web/analysis-view.js',import.meta.url)),'Analysis view missing');
 const {analysisUiState}=await import('../chordbuddy/web/analysis-view.js');
 assert.equal(analysisUiState({active_run:'run'},null).label,'Analyze again');
 assert.equal(analysisUiState({},null).label,'Analyze song');
 assert.equal(analysisUiState({}, {status:'running',stage:'Using saved transcription'}).stage,'Using saved transcription');
});
