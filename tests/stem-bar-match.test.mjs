// Matching one song's bars to another's by when they are (stem_tool/bar-match.js): what puts copied action flags on the right bars.
import test from 'node:test';
import assert from 'node:assert/strict';
import {matchBars,matchWords} from '../stem_tool/bar-match.js';

/** Bars of `length` seconds, the first starting at `first` seconds and numbered `number`. */
const grid=(count,{first=0,number=1,length=2,beats=4,prefix='m'}={})=>Array.from({length:count},(_,i)=>({id:prefix+i,number:number+i,start:first+i*length,end:first+(i+1)*length,beats}));
const partner=(result,id)=>result.bars[id]?.id??null;

// "Real Thing" and its instrumental, as her screenshots show them: the same recording, 120 BPM. The original counts three bars before the
// music (-2, -1, 0) and its Verse is bar 35; the instrumental counts one (0), hears a chord two bars sooner, and its Verse is bar 37.
const original=grid(150,{number:-2}),instrumental=grid(150,{number:0});

test('the same moment is found whatever the two songs call the bar',()=>{
  const r=matchBars(original,instrumental);
  const at=n=>original.find(b=>b.number===n),there=n=>instrumental.find(b=>b.id===partner(r,at(n).id)).number;
  assert.equal(there(35),37,'the Verse: bar 35 there is bar 37 here');
  assert.equal(there(1),3);assert.equal(there(-2),0,'flags before bar 1 have a place too: nothing is left out');
  assert.equal(r.matched,150);assert.deepEqual(r.unmatched,[]);
  assert.equal(r.shift,2);assert.equal(r.mixed,false);
  assert.match(matchWords(r,original,{theirs:'Real Thing',mine:'Real Thing (Instr)'}),/bar 1 of “Real Thing” is bar 3 here/);
});

test('matching by number alone would have put every flag two bars early (the bug)',()=>{
  const byNumber=new Map(instrumental.map(b=>[b.number,b]));
  const verse=original.find(b=>b.number===35);
  assert.equal(byNumber.get(35).start,verse.start-4,'bar 35 of the instrumental is 4 seconds (2 bars) earlier in the music than bar 35 of the original');
  assert.equal(byNumber.get(-2),undefined,'and its first flags had nowhere to go');
});

test('a beat grid that sits a little later is still the same bars',()=>{
  for(const late of [.08,.3,-.4,.9]){               // up to nearly half a bar: the grids are measured against each other first
    const r=matchBars(original,grid(150,{number:0,first:late}));
    assert.equal(r.matched>=149,true,`grid ${late}s later`);
    assert.equal(partner(r,original[36].id),'m36');
    assert.ok(Math.abs(r.phase-late)<.02);
  }
});

test('recordings that do not start together are lined up by the offset found by ear',()=>{
  const later=grid(150,{number:1,first:3.2});        // the other file has 3.2 s more silence in front: none of its bars are near in time
  const blind=matchBars(original,later);
  assert.notEqual(partner(blind,original[10].id),'m10','without the offset the bars are paired a bar or two out');
  const r=matchBars(original,later,3.2);
  assert.equal(partner(r,original[10].id),'m10');assert.equal(partner(r,original[0].id),'m0');assert.equal(r.matched,150);
});

test('a bar with no partner is said so, and never doubled up',()=>{
  const short=grid(100,{number:0});                  // the other song stops 50 bars sooner
  const r=matchBars(original,short);
  assert.equal(r.matched,100);assert.equal(r.unmatched.length,50);assert.equal(r.unmatched[0].number,original[100].number);
  const half=grid(75,{number:1,length:4});           // analyzed in half time: each of its bars covers two of ours
  const h=matchBars(original,half);
  assert.equal(new Set(Object.values(h.bars).map(b=>b.id)).size,h.matched,'no two bars share a partner');
  assert.equal(h.matched,75);
});

test('each partner carries how many beats it has, so a flag on beat 4 of a bar in 3 can be left out',()=>{
  const waltz=grid(150,{number:0,beats:3});
  assert.deepEqual(matchBars(original,waltz).bars.m5,{id:'m5',beats:3});
});

test('songs that agree need no explaining, and songs that share nothing say so',()=>{
  const same=matchBars(original,grid(150,{number:-2}));
  assert.equal(same.shift,0);assert.equal(matchWords(same,original,{theirs:'A',mine:'B'}),'');
  const none=matchBars(original,grid(10,{first:900}));
  assert.equal(none.matched,0);assert.match(matchWords(none,original,{theirs:'A',mine:'B'}),/nothing can be copied/);
  assert.equal(matchBars([],instrumental).matched,0);assert.equal(matchBars(original,[]).unmatched.length,150);
});

test('where the two analyses disagree part-way, it is flagged',()=>{
  const drifting=[...grid(60,{number:0}),...grid(90,{number:61,first:120,prefix:'n'})];   // it skips a bar number at bar 60
  const r=matchBars(original,drifting);
  assert.equal(r.mixed,true);assert.match(matchWords(r,original,{theirs:'A',mine:'B'}),/do not agree about every bar/);
});
