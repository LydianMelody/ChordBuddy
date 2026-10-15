import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateKey,parseChord,keyName,KEY_CHOICES} from '../chordbuddy/web/key-estimate.js';

const song=labels=>labels.map((label,i)=>({label,start:i*2,end:i*2+2}));

test('chord names are read as a root and major/minor/diminished', () => {
  assert.deepEqual(parseChord('A:min'),{pitch:9,quality:'min'});
  assert.deepEqual(parseChord('F#m7'),{pitch:6,quality:'min'});
  assert.deepEqual(parseChord('Bb:maj7'),{pitch:10,quality:'maj'});
  assert.deepEqual(parseChord('G7/B'),{pitch:7,quality:'maj'});
  assert.deepEqual(parseChord('Bdim'),{pitch:11,quality:'dim'});
  assert.equal(parseChord('N'),null);
});

test('the key is the one whose chords cover the song', () => {
  assert.equal(estimateKey(song(['C','G','Am','F','C','G','F','C'])).label,'C major');
  assert.equal(estimateKey(song(['Am','F','C','G','Am','Dm','E','Am'])).label,'A minor');
  assert.equal(estimateKey(song(['Bb','Eb','F','Bb','Gm','Eb','F','Bb'])).label,'Bb major');
  assert.equal(estimateKey(song(['D','A','Bm','G','D','A','G','D'])).label,'D major');
});

test('a progression that starts on the relative minor still picks the minor key when it lands there', () => {
  assert.equal(estimateKey(song(['Em','C','G','D','Em','C','D','Em'])).label,'E minor');
});

test('longer chords count for more, and nothing to go on gives no key', () => {
  const chords=[{label:'C',start:0,end:1},{label:'G',start:1,end:2},{label:'F#m',start:2,end:3},{label:'D',start:3,end:20},{label:'A',start:20,end:36},{label:'Bm',start:36,end:50}];
  assert.equal(estimateKey(chords).label,'D major');
  assert.equal(estimateKey([]),null);assert.equal(estimateKey(song(['N','N'])),null);
});

test('keys are named the way players write them and every key can be chosen', () => {
  assert.equal(keyName(10,'major'),'Bb major');assert.equal(keyName(6,'major'),'F# major');assert.equal(keyName(0,'minor'),'C minor');
  assert.equal(KEY_CHOICES.length,24);assert.equal(new Set(KEY_CHOICES).size,24);
});
