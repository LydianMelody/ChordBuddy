import test from 'node:test';
import assert from 'node:assert/strict';

const store=new Map();
globalThis.localStorage={get length(){return store.size;},key:i=>[...store.keys()][i],getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v))};
store.set('cb-theme','tomato');store.set('other','x');
const {prefs}=await import('../chordbuddy/web/prefs.js');

test('preferences start from the fast local copy, then the library copy wins', async () => {
  assert.equal(prefs.get('cb-theme','plum'),'tomato');assert.equal(prefs.get('other','none'),'none');
  let loaded=0;prefs.onLoad(()=>{loaded++;});
  const written=[];
  await prefs.connect(async batch=>{written.push(batch);},async()=>({'cb-theme':'forest','cb-rack':'closed'}));
  assert.equal(loaded,1);assert.equal(prefs.get('cb-theme','plum'),'forest');assert.equal(prefs.get('cb-rack','open'),'closed');
  assert.equal(store.get('cb-theme'),'forest');
});

test('changes are saved to the library in one small batch, and a failed save is retried', async () => {
  const batches=[];let fail=true;
  await prefs.connect(async batch=>{batches.push(batch);if(fail)throw Error('offline');},async()=>({}));
  prefs.set('cb-theme','plum');prefs.set('cb-side','closed');prefs.set('cb-side','closed');
  await new Promise(r=>setTimeout(r,500));
  assert.deepEqual(batches.at(-1),{'cb-theme':'plum','cb-side':'closed'});
  fail=false;prefs.set('cb-key:s1','A minor');
  await new Promise(r=>setTimeout(r,500));
  assert.equal(batches.at(-1)['cb-key:s1'],'A minor');assert.equal(batches.at(-1)['cb-theme'],'plum');   // the earlier failure rides along
});
