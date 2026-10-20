import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAbcjs} from './abcjs-node.mjs';
import {analyzeScore} from '../chordbuddy/web/lead-sheet.js';
import {locatePitch,stepOf,spellStep,noteName,shiftSteps,toggleAccidental,toRest,editNoteInContent} from '../chordbuddy/web/lead-edit.js';

const abcjs=loadAbcjs();

test('the pitch is found inside a note that has a chord symbol, decorations and a length',()=>{
  const part=locatePitch('"Bm"!fermata!~^f\'2 ');
  assert.equal(part.accidental,'^');assert.equal(part.letter,'f');assert.equal(part.marks,"'");
  assert.equal(locatePitch('z4'),null);assert.equal(locatePitch('[Ac]2'),null);assert.equal(locatePitch('"D"'),null);
});

test('steps count from middle C and spell back the same way',()=>{
  for(const [text,step] of [['C',0],['D',1],['B',6],['c',7],["c'",14],['C,',-7],['B,',-1],['b',13]])assert.equal(stepOf(locatePitch(text)),step,text);
  for(const step of [-9,-1,0,6,7,13,14,20]){const s=spellStep(step);assert.equal(stepOf(locatePitch(s.letter+s.marks)),step);}
});

test('a note moves one step along the scale and keeps everything around it',()=>{
  assert.equal(shiftSteps('"D"f4',1),'"D"g4');
  assert.equal(shiftSteps('"D"f4',-1),'"D"e4');
  assert.equal(shiftSteps('C2',-1),'B,2');           // down past C: the octave mark appears
  assert.equal(shiftSteps('B,2',1),'C2');
  assert.equal(shiftSteps('b',1),"c'");
  assert.equal(shiftSteps('c',-1),'B');
  assert.equal(shiftSteps('^a2',1),'b2');            // an accidental is dropped: the key signature decides again
  assert.equal(shiftSteps('"A"a3-',7),"\"A\"a'3-");  // an octave up
  assert.equal(shiftSteps('z4',1),null);assert.equal(shiftSteps('[CE]2',1),null);
});

test('sharps and flats toggle on the note itself',()=>{
  assert.equal(toggleAccidental('"D"f4','sharp'),'"D"^f4');
  assert.equal(toggleAccidental('"D"^f4','sharp'),'"D"f4');
  assert.equal(toggleAccidental('f4','flat'),'_f4');
  assert.equal(toggleAccidental('^f4','flat'),'_f4');
  assert.equal(toggleAccidental('^f4','natural'),'=f4');
  assert.equal(toggleAccidental('z','sharp'),null);
});

test('a note becomes a rest of the same length, keeping its chord and dropping a tie',()=>{
  assert.equal(toRest('"A"a3-'),'"A"z3');
  assert.equal(toRest('b2 '),'z2 ');
  assert.equal(toRest('z4'),null);
});

test('notes are named with the key signature in mind',()=>{
  const key=[{acc:'sharp',note:'f'},{acc:'sharp',note:'c'}];
  assert.equal(noteName('f4',key),'F♯5');assert.equal(noteName('=f4',key),'F♮5');assert.equal(noteName('"G"b,2',key),'B4');assert.equal(noteName('_B2',key),'B♭4');
  assert.equal(noteName('z2',key),null);
});

const abc='X:1\nM:4/4\nL:1/16\nK:D\nV: Vocal\n"D"f4f2aa-"A"a3z4z|"G"b2b2b2aa-"D"a3z4f|\n';
test('editing one note changes only that note, moves later chord positions, and keeps the bars the same length',()=>{
  const before=analyzeScore(abc,abcjs);
  const content={abc,chords:[{id:'c0',label:'D',abc_index:abc.indexOf('"D"f4')},{id:'c1',label:'A',abc_index:abc.indexOf('"A"a3')},{id:'c2',label:'G',abc_index:abc.indexOf('"G"b2')}]};
  const target=before.notes[3];                                              // the second "a" of the first bar
  const next=editNoteInContent(content,target.startChar,target.endChar,t=>shiftSteps(t,7));
  assert.ok(next&&next.abc.length===abc.length+1);                                 // one octave mark more
  const after=analyzeScore(next.abc,abcjs);
  assert.equal(after.notes.length,before.notes.length);assert.equal(after.measures,before.measures);
  assert.deepEqual(after.notes.map(n=>n.measure),before.notes.map(n=>n.measure));
  assert.deepEqual(after.notes.map(n=>n.duration),before.notes.map(n=>n.duration));
  assert.notEqual(after.notes[3].pitch,before.notes[3].pitch);assert.equal(after.notes[2].pitch,before.notes[2].pitch);
  // every chord label still sits on its own chord symbol
  for(const chord of next.chords)assert.equal(next.abc[chord.abc_index],'"');
  assert.equal(next.chords[0].abc_index,content.chords[0].abc_index);
  assert.equal(next.chords[2].abc_index,content.chords[2].abc_index+1);
  assert.equal(editNoteInContent(content,before.notes[0].startChar,before.notes[0].endChar,t=>toRest(t)&&t),null,'an edit that changes nothing reports nothing');
});

test('turning a note into a rest keeps the bar lengths',()=>{
  const before=analyzeScore(abc,abcjs);
  const note=before.notes[2];
  const next=editNoteInContent({abc,chords:[]},note.startChar,note.endChar,toRest);
  const after=analyzeScore(next.abc,abcjs);
  assert.equal(after.notes.length,before.notes.length-1);assert.equal(after.measures,before.measures);
});
