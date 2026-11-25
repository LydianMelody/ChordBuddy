import test from 'node:test';
import assert from 'node:assert/strict';
import {exportPitched,STEM_PARTS} from '../chordbuddy/web/pitch-export.js';

// A stand-in worker: answers each part the way pitch-render-worker.js does.
const fakeWorker=(answer,seen)=>()=>{const w={terminate(){},postMessage(m){seen.push(m);queueMicrotask(()=>{w.onmessage({data:{progress:.5}});w.onmessage({data:answer(m)});});}};return w;};

test('a pitched mix renders one part and returns the download link for it', async () => {
  const seen=[],progress=[];
  const url=await exportPitched({kind:'mix',runId:'run 1',mixQuery:'levels=1,1,1,1,1,1,1&master=1',title:'Song (+3, C minor) - full mix',semitones:3,token:'t k',
    onProgress:p=>progress.push(p),makeWorker:fakeWorker(()=>({done:true}),seen)});
  assert.equal(seen.length,1);assert.equal(seen[0].semitones,3);
  assert.equal(seen[0].pcmUrl,'/api/mix-pcm/run%201?levels=1,1,1,1,1,1,1&master=1');
  assert.match(seen[0].uploadUrl,/^\/api\/pitch-export\/part\?job=[0-9a-f]{20}&part=mix$/);
  assert.match(url,/^\/api\/pitch-export\/[0-9a-f]{20}\?kind=mix&name=Song%20\(%2B3%2C%20C%20minor\)%20-%20full%20mix&token=t%20k$/);
  assert.equal(progress.at(-1),1);
});

test('stems render one part each, skipping stems the song lacks', async () => {
  const seen=[];
  const url=await exportPitched({kind:'stems',runId:'r',title:'Song',semitones:-2,token:'t',makeWorker:fakeWorker(m=>m.pcmUrl.endsWith('piano')?{error:'no piano',status:404}:{done:true},seen)});
  assert.deepEqual(seen.map(m=>m.pcmUrl.split('stem=')[1]),STEM_PARTS);
  assert.match(url,/kind=stems/);
});

test('a failure stops the export with its message; never an unpitched file', async () => {
  await assert.rejects(exportPitched({kind:'mix',runId:'r',title:'S',semitones:2,token:'t',makeWorker:fakeWorker(()=>({error:'The pitch engine could not start'}),[])}),/pitch engine/);
  await assert.rejects(exportPitched({kind:'mix',runId:'r',title:'S',semitones:0,token:'t'}),/no pitch change/);
});
