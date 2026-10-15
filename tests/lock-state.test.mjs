import test from 'node:test';
import assert from 'node:assert/strict';
import {lockStepStates,lockJobFailed,LOCK_STEPS} from '../chordbuddy/web/analysis-view.js';

const states=job=>Object.fromEntries(lockStepStates(job).map(s=>[s.kind,s.state]));

test('a song with no job shows every analysis step as idle', () => {
  assert.deepEqual(states(null),{source:'idle',separation:'idle',transcription:'idle',chart:'idle'});
  assert.equal(lockStepStates(null).length,LOCK_STEPS.length);
});

test('a running analysis marks finished stages done, the current one active, the rest waiting', () => {
  const job={kind:'analysis',status:'running',stage:'transcription',stages:{source:{status:'completed'},separation:{status:'completed'}}};
  assert.deepEqual(states(job),{source:'done',separation:'done',transcription:'active',chart:'wait'});
});

test('the first stage is active while the job is still preparing', () => {
  assert.equal(states({kind:'analysis',status:'running',stage:'source',stages:{}}).source,'active');
});

test('a failed stage is reported as failed and the job counts as failed', () => {
  const job={kind:'analysis',status:'failed',stage:'failed',stages:{source:{status:'completed'},separation:{status:'failed',error:'x'}}};
  assert.deepEqual(states(job),{source:'done',separation:'failed',transcription:'idle',chart:'idle'});
  assert.equal(lockJobFailed(job),true);
});

test('cancelled and interrupted jobs count as failed; running and completed do not', () => {
  for(const status of ['cancelled','interrupted','partial','error']) assert.equal(lockJobFailed({status}),true,status);
  for(const status of ['running','completed','starting']) assert.equal(lockJobFailed({status}),false,status);
  assert.equal(lockJobFailed(null),false);
});

test('a separation-only job shows the audio as prepared and the stems as active', () => {
  assert.deepEqual(states({kind:'separation',status:'running',stage:'x',stages:{}}),{source:'done',separation:'active',transcription:'wait',chart:'wait'});
});
