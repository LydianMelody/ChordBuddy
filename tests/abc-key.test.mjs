import test from 'node:test';
import assert from 'node:assert/strict';
import {keyFifths,rekeyAbc} from '../chordbuddy/web/abc-key.js';
import {loadAbcjs} from './abcjs-node.mjs';
import {analyzeScore} from '../chordbuddy/web/lead-sheet.js';

test('key signatures: sharps up, flats down, modes from their major', () => {
  assert.deepEqual(['C','B','C#m','C# minor','Eb','Eb major','Am','D mix','F','Bb minor','Gb'].map(keyFifths),[0,5,4,4,-3,-3,0,1,-1,-5,-6]);
  assert.equal(keyFifths('none'),null);
});

test('a score moves from B major to C# minor with every pitch kept: A# gets its sharp, the rest stay plain', () => {
  const abc=['X:1','M:4/4','L:1/4','K:B clef=treble','% verse','V: Vocal','"B"z4|f2f2|B=aag|e^^ff2|A2a2|A A2"A"A|','w: words a b'].join('\n');
  const {abc:out,map}=rekeyAbc(abc,'C# minor');
  assert.deepEqual(out.split('\n'),['X:1','M:4/4','L:1/4','K:C#m clef=treble','% verse','V: Vocal',
    '"B"z4|f2f2|Baag|e^^ff2|^A2^a2|^A A2"A"A|','w: words a b'],
    'a natural A is plain now (and the A after it too); a double sharp stays; each A# in a bar is written once per octave');
  const chord=abc.lastIndexOf('"A"');assert.equal(out.slice(map[chord],map[chord]+3),'"A"','positions follow the rewrite');
  assert.equal(rekeyAbc(abc,'B major'),null,'already in that signature');
  assert.equal(rekeyAbc(abc,'G# minor'),null,'G# minor has the same five sharps');
});

test('the rewritten score parses to the same notes', () => {
  const abcjs=loadAbcjs(),abc=['X:1','M:4/4','L:1/4','K:B','V: Vocal','"B"z4|"C#m7"f2^ea|B=aag|'].join('\n');
  const before=analyzeScore(abc,abcjs),after=analyzeScore(rekeyAbc(abc,'C# minor').abc,abcjs);
  assert.deepEqual(after.notes.map(n=>[n.measure,n.offset]),before.notes.map(n=>[n.measure,n.offset]));
});

test('scores it cannot safely rewrite are left alone', () => {
  assert.equal(rekeyAbc('X:1\nK:B\nab|\nK:C\ncd|','C# minor'),null,'a key change part-way');
  assert.equal(rekeyAbc('X:1\nK:D exp ^f ^c\nab|','C# minor'),null,'an explicit signature');
  assert.equal(rekeyAbc('X:1\nab|','C# minor'),null,'no key at all');
});
