import test from 'node:test';
import assert from 'node:assert/strict';
import {shiftMidiContent,isDrumNote} from '../chordbuddy/web/pitch-midi.js';

const content={tracks:[{name:'Vocal'},{name:'Chords'},{name:'Drums'}],notes:[
  {pitch:60,start:0,track:0,channel:0},{pitch:64,start:1,track:1,channel:1},
  {pitch:36,start:0,track:0,channel:9},{pitch:38,start:2,track:2,channel:2},{pitch:126,start:3,track:0,channel:0}]};

test('melody and chord notes move by the chart pitch; drums (channel 10 or a drum track) never do', () => {
  const moved=shiftMidiContent(content,3);
  assert.deepEqual(moved.notes.map(n=>n.pitch),[63,67,36,38,127]);
  assert.equal(content.notes[0].pitch,60,'the saved notes are untouched');
  assert.ok(isDrumNote(content.notes[2],content.tracks));assert.ok(isDrumNote(content.notes[3],content.tracks));
});

test('each note takes the pitch at its own start (a show can change it partway); nothing moving returns the same object', () => {
  const moved=shiftMidiContent(content,t=>t>=1?-2:0);
  assert.deepEqual(moved.notes.map(n=>n.pitch),[60,62,36,38,124]);
  assert.equal(shiftMidiContent(content,0),content);
  assert.equal(shiftMidiContent({notes:[],tracks:[]},4).notes.length,0);
});
