import test from 'node:test';
import assert from 'node:assert/strict';
import {pollDelay,POLL_BUSY_MS,POLL_SETTLING_MS,POLL_IDLE_MS,SETTLE_FOR_MS,RECHECK_MS} from '../chordbuddy/web/poll-pace.js';

test('a running job is polled about once a second, however long ago anything else changed',()=>{
  assert.equal(POLL_BUSY_MS,1000);
  for(const sinceChange of [0,5000,SETTLE_FOR_MS,1e9,Infinity])assert.equal(pollDelay({jobActive:true,sinceChange}),POLL_BUSY_MS);
});

test('shortly after a change the page keeps the steady 2.5 second pace',()=>{
  assert.equal(POLL_SETTLING_MS,2500);
  for(const sinceChange of [0,1,2500,SETTLE_FOR_MS-1])assert.equal(pollDelay({jobActive:false,sinceChange}),POLL_SETTLING_MS);
});

test('an app that has sat unchanged for a while is polled slowly',()=>{
  assert.equal(POLL_IDLE_MS,10000);
  for(const sinceChange of [SETTLE_FOR_MS,SETTLE_FOR_MS+1,1e9,Infinity])assert.equal(pollDelay({jobActive:false,sinceChange}),POLL_IDLE_MS);
});

test('missing or odd input falls back to the slow pace, never to a zero or negative wait',()=>{
  assert.equal(pollDelay(),POLL_IDLE_MS);
  assert.equal(pollDelay({}),POLL_IDLE_MS);
  assert.equal(pollDelay({sinceChange:NaN}),POLL_IDLE_MS);
  assert.equal(pollDelay({sinceChange:-5}),POLL_IDLE_MS);
  assert.ok(RECHECK_MS>=POLL_IDLE_MS);
});
