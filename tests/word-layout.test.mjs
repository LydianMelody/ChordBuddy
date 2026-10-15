import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutLine,currentWordIndex,lineText,linePlacement,onsetsFromNotes,melodyGuess} from '../chordbuddy/web/word-layout.js';

// Eight 4/4 bars at 120 BPM: bar n spans 2(n-1)..2n seconds, beats every 0.5 s.
const measures=[0,1,2,3,4,5,6,7].map(i=>({id:'m'+i,number:i+1,start:i*2,end:i*2+2,beats:[0,.5,1,1.5].map(b=>i*2+b),meter:[4,4],quarter_positions:[0,1,2,3,4]}));
const content=(lyrics,placements=[],chords=[])=>({version:1,duration:16,sections:[{id:'s',name:'Verse',start:0,end:16,lyrics}],chords,layout:{bars_per_line:4,breaks:[],bar_overrides:[],lines:placements}});
const place=(line,start,end,words=[])=>({section_id:'s',line,start_measure:start,end_measure:end,words});
const times=layout=>layout.tokens.map(t=>+t.seconds.toFixed(4));

test('a line that was never placed has no times and says so', () => {
  const l=layoutLine(content('one two three'),measures,'s',0);
  assert.equal(l.placed,false);assert.deepEqual(l.tokens.map(t=>t.text),['one','two','three']);
  assert.ok(l.tokens.every(t=>t.seconds===null&&t.kind==='unplaced'&&!t.pinned));
});

test('missing lines and sections give null', () => {
  assert.equal(layoutLine(content('a'),measures,'s',3),null);assert.equal(layoutLine(content('a'),measures,'nope',0),null);
  assert.equal(lineText(content('a\nb'),'s',1),'b');assert.equal(lineText(content('a'),'s',5),null);
});

test('placed on a row with no pins, the words spread evenly across the whole row, first word at the start', () => {
  const l=layoutLine(content('one two three four',[place(0,'m0','m1')]),measures,'s',0);
  assert.equal(l.placed,true);assert.deepEqual(times(l),[0,1,2,3]);
  assert.equal(l.tokens[0].kind,'start');assert.ok(l.tokens.slice(1).every(t=>t.kind==='spread'));
  assert.equal(l.tokens[2].measureId,'m1');assert.equal(l.tokens[2].beat,0);
});

test('pinned words sit exactly on their beat and unpinned words spread evenly between pins', () => {
  // pin "one" at bar 1 beat 1 (0 s) and "five" at bar 3 beat 1 (4 s): three words between, one second apart... 4 s over 4 gaps
  const words=[{offset:0,measure_id:'m0',beat:0},{offset:19,measure_id:'m2',beat:0}];
  const l=layoutLine(content('one two three four five',[place(0,'m0','m3',words)]),measures,'s',0);
  assert.deepEqual(times(l).slice(0,5),[0,1,2,3,4]);
  assert.deepEqual(l.tokens.map(t=>t.pinned),[true,false,false,false,true]);
});

test('moving a pin moves the words between its neighbours with it, like a puppet', () => {
  const at=beat=>layoutLine(content('one two three four five',[place(0,'m0','m3',[{offset:0,measure_id:'m0',beat:0},{offset:19,measure_id:'m2',beat:beat}])]),measures,'s',0);
  assert.deepEqual(times(at(0)),[0,1,2,3,4]);
  assert.deepEqual(times(at(2)),[0,1.25,2.5,3.75,5]);   // the end pin moved one second later; the middle words stretched with it
});

test('words after the last pin spread out towards the end of the row', () => {
  const words=[{offset:0,measure_id:'m0',beat:0}];
  const l=layoutLine(content('one two three',[place(0,'m0','m1',words)]),measures,'s',0);
  assert.deepEqual(times(l),[0,1.3333,2.6667]);
});

test('words before the first pin spread between the row start and that pin', () => {
  const words=[{offset:8,measure_id:'m1',beat:0}];   // "three" at 2 s
  const l=layoutLine(content('one two three',[place(0,'m0','m1',words)]),measures,'s',0);
  assert.deepEqual(times(l),[0,1,2]);assert.equal(l.tokens[0].kind,'start');assert.equal(l.tokens[2].pinned,true);
});

test('fractional beats are exact: a word pinned half a beat in sits there', () => {
  const l=layoutLine(content('one two',[place(0,'m0','m0',[{offset:0,measure_id:'m0',beat:.5},{offset:4,measure_id:'m0',beat:2.25}])]),measures,'s',0);
  assert.deepEqual(times(l),[.25,1.125]);
});

test('older chord bindings act as pins, and a saved pin on the same word wins over them', () => {
  const chords=[{id:'c1',label:'C',start:2,end:4,section_id:'s',line:0,offset:4},{id:'c2',label:'G',start:4,end:6,section_id:'s',line:0,offset:8}];
  const l=layoutLine(content('one two three',[place(0,'m0','m3',[{offset:8,measure_id:'m2',beat:2}])],chords),measures,'s',0);
  assert.deepEqual(times(l),[0,2,5]);assert.deepEqual(l.tokens.map(t=>t.kind),['start','chord','pin']);
});

test('a line with only chord bindings (no placement) is still placed', () => {
  const chords=[{id:'c1',label:'C',start:2,end:4,section_id:'s',line:0,offset:0}];
  const l=layoutLine(content('one two',[],chords),measures,'s',0);
  assert.equal(l.placed,true);assert.equal(l.tokens[0].seconds,2);assert.ok(l.tokens[1].seconds>2);
});

test('pins that arrive out of order never make time run backwards', () => {
  const words=[{offset:0,measure_id:'m3',beat:0},{offset:4,measure_id:'m1',beat:0}];
  const l=layoutLine(content('one two three',[place(0,'m0','m3',words)]),measures,'s',0);
  const t=times(l);assert.ok(t.every((v,i)=>!i||v>=t[i-1]),t.join());
});

test('pins on something that is not a word start are ignored', () => {
  const l=layoutLine(content('one two',[place(0,'m0','m1',[{offset:2,measure_id:'m1',beat:0}])]),measures,'s',0);
  assert.equal(l.tokens.filter(t=>t.pinned).length,0);assert.deepEqual(times(l),[0,2]);
});

test('hyphenated syllables are separate words that spread like any other', () => {
  const l=layoutLine(content('un-i-corn',[place(0,'m0','m0')]),measures,'s',0);
  assert.deepEqual(l.tokens.map(t=>t.text),['un-','i-','corn']);assert.deepEqual(times(l),[0,.6667,1.3333]);
});

test('the current word is the last one that has started', () => {
  const l=layoutLine(content('one two three four',[place(0,'m0','m1')]),measures,'s',0);
  assert.equal(currentWordIndex(l.tokens,-1),-1);assert.equal(currentWordIndex(l.tokens,0),0);assert.equal(currentWordIndex(l.tokens,1.99),1);
  assert.equal(currentWordIndex(l.tokens,2),2);assert.equal(currentWordIndex(l.tokens,99),3);
  assert.equal(currentWordIndex(layoutLine(content('a b'),measures,'s',0).tokens,5),-1);
});

test('the placement helper finds a line by section and index', () => {
  const c=content('a\nb',[place(1,'m2','m3')]);
  assert.equal(linePlacement(c,'s',1).start_measure,'m2');assert.equal(linePlacement(c,'s',0),null);
});

// ---- melody guess ----
test('note starts are merged when nearly simultaneous and sorted', () => {
  assert.deepEqual(onsetsFromNotes([{start:2},{start:1},{start:1.05},{start:3},{start:NaN}]),[1,2,3]);
  assert.deepEqual(onsetsFromNotes(null),[]);
});

test('words land on the melody notes nearest to even spacing, in order, and never reuse a note', () => {
  assert.deepEqual(melodyGuess(0,4,3,[0.5,1.2,1.9,3.1,3.6]),[1.2,1.9,3.1]);
  assert.equal(melodyGuess(0,4,4,[1,2,3]),null);                         // too few notes: the caller spreads evenly
  assert.deepEqual(melodyGuess(0,4,2,[0.05,1,3]),[1,3]);                  // a note on top of the previous word is skipped
});

test('with melody notes, unpinned words are guessed from them; pins stay put; without notes nothing changes', () => {
  const c=content('one two three four',[place(0,'m0','m1',[{offset:0,measure_id:'m0',beat:0}])]);
  const onsets=[0.9,1.4,2.2,2.9];
  const guessed=layoutLine(c,measures,'s',0,{onsets});
  assert.equal(guessed.tokens[0].seconds,0);assert.equal(guessed.tokens[0].kind,'pin');
  assert.deepEqual(times(guessed).slice(1),[0.9,1.4,2.2].map((_,i)=>[0.9,2.2,2.9][i]));
  assert.ok(guessed.tokens.slice(1).every(t=>t.kind==='suggest'&&!t.pinned));
  assert.deepEqual(times(layoutLine(c,measures,'s',0)),[0,1,2,3]);        // feature off
  assert.deepEqual(times(layoutLine(c,measures,'s',0,{onsets:[1]})),[0,1,2,3]);   // too few notes
  const pinned=content('one two three four',[place(0,'m0','m1',[{offset:0,measure_id:'m0',beat:0},{offset:8,measure_id:'m1',beat:0}])]);
  const t=layoutLine(pinned,measures,'s',0,{onsets:[0.5,1,1.5,2.5,3]});
  assert.equal(t.tokens[2].seconds,2);assert.equal(t.tokens[2].kind,'pin');assert.equal(t.tokens[1].kind,'suggest');assert.ok(t.tokens[1].seconds>0&&t.tokens[1].seconds<2);
  assert.equal(t.tokens[3].kind,'suggest');assert.ok(t.tokens[3].seconds>2);
});
