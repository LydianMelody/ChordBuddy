import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('manual warning offers exact three choices and states rhythm-only clearing',async()=>{
 assert.ok(fs.existsSync(new URL('../chordbuddy/web/rhythm-view.js',import.meta.url)),'Rhythm preview missing');
 const {rhythmChoices,rhythmExplanation}=await import('../chordbuddy/web/rhythm-view.js');
 assert.deepEqual(rhythmChoices(true).map(x=>x.label),['Keep rhythm overrides and apply','Replace rhythm overrides and apply','Cancel']);
 assert.match(rhythmExplanation,/rhythm overrides only/);assert.match(rhythmExplanation,/chord names and times/);
 assert.deepEqual(rhythmChoices(false).map(x=>x.label),['Apply corrected timing','Cancel']);
});
test('delayed responses and double applies respect selection and pending state',async()=>{
 assert.ok(fs.existsSync(new URL('../chordbuddy/web/rhythm-view.js',import.meta.url)),'Rhythm preview missing');
 const {ProposalGuard}=await import('../chordbuddy/web/rhythm-view.js');let id='a';const guard=new ProposalGuard(()=>id);const ticket=guard.begin();id='b';assert.equal(guard.valid(ticket),false);id='a';guard.cancel();assert.equal(guard.valid(ticket),false);
 const next=guard.begin();assert.equal(guard.valid(next),true);assert.equal(guard.acquire(),true);assert.equal(guard.acquire(),false);guard.release();assert.equal(guard.acquire(),true);
});
