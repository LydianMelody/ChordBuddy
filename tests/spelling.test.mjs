import test from 'node:test';
import assert from 'node:assert/strict';
import {keyUsesFlats,setKeySpelling,spellChord} from '../chordbuddy/web/spelling.js';

test('a key is written with flats or sharps by its name', () => {
  for(const name of ['F minor','Bb major','Eb major','C minor','G minor','D minor','Ab major','Db major','F major','Eb minor'])assert.equal(keyUsesFlats(name),true,name);
  for(const name of ['C major','G major','D major','A major','E major','B major','A minor','E minor','B minor','F# minor','C# minor','F# major'])assert.equal(keyUsesFlats(name),false,name);
  assert.equal(keyUsesFlats(''),null);assert.equal(keyUsesFlats(null),null);assert.equal(keyUsesFlats('nonsense'),null);
});

test('in F minor, the analysis sharps are written as flats, bass notes too, and the rest of the chord is untouched', () => {
  setKeySpelling('F minor');
  assert.equal(spellChord('A#sus2'),'Bbsus2');
  assert.equal(spellChord('D#'),'Eb');
  assert.equal(spellChord('C#'),'Db');
  assert.equal(spellChord('G#'),'Ab');
  assert.equal(spellChord('D#/F##'),'Eb/G');
  assert.equal(spellChord('C#m7/G#'),'Dbm7/Ab');
  assert.equal(spellChord('Fm'),'Fm');
  assert.equal(spellChord('Bb'),'Bb');
  assert.equal(spellChord('N'),'N');
  assert.equal(spellChord('?'),'?');
});

test('in a sharp key, flats become sharps, and with no key nothing changes', () => {
  setKeySpelling('E major');
  assert.equal(spellChord('Bb'),'A#');assert.equal(spellChord('Db/Ab'),'C#/G#');assert.equal(spellChord('A'),'A');
  setKeySpelling(null);
  assert.equal(spellChord('A#sus2'),'A#sus2');assert.equal(spellChord('Bb'),'Bb');
});
