import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_PITCH,pitchKey,readPitch,writePitch,applied,pitchAt,createPitchState} from '../chordbuddy/web/pitch-state.js';

const fakePrefs=(initial={})=>{const data=new Map(Object.entries(initial)),writes=[];return {data,writes,get:(k,f)=>data.has(k)?data.get(k):f,set:(k,v)=>{data.set(k,String(v));writes.push([k,String(v)]);}};};

test('a saved setting reads back; anything unreadable is the default', () => {
  assert.deepEqual(readPitch(writePitch({offset:-3,sound:false,chart:true})),{offset:-3,sound:false,chart:true});
  for(const bad of ['','nope','null','[]','{"offset":9}','{"offset":2.5}'])assert.equal(readPitch(bad).offset,0,bad);
  assert.deepEqual(readPitch('{}'),{...DEFAULT_PITCH});
  assert.equal(pitchKey('abc'),'cb-pitch:abc');
});

test('each side gets the offset only while its switch is on', () => {
  assert.deepEqual(applied({offset:3,sound:true,chart:true}),{sound:3,chart:3});
  assert.deepEqual(applied({offset:3,sound:false,chart:true}),{sound:0,chart:3});
  assert.deepEqual(applied({offset:3,sound:true,chart:false}),{sound:3,chart:0});
});

test('without steps the pitch is the same at every play position', () => {
  const base={offset:-2,sound:true,chart:true};
  for(const t of [0,10,999])assert.deepEqual(pitchAt(t,base),{sound:-2,chart:-2});
});

test('steps take over from their moment on, for the side they name, in any order', () => {
  const base={offset:0,sound:true,chart:true};
  const steps=[{at:60,semitones:2,applyTo:'both'},{at:30,semitones:1,applyTo:'sound'},{at:90,semitones:-1,applyTo:'chart'}];
  assert.deepEqual(pitchAt(0,base,steps),{sound:0,chart:0});
  assert.deepEqual(pitchAt(30,base,steps),{sound:1,chart:0});
  assert.deepEqual(pitchAt(59.9,base,steps),{sound:1,chart:0});
  assert.deepEqual(pitchAt(60,base,steps),{sound:2,chart:2});
  assert.deepEqual(pitchAt(120,base,steps),{sound:2,chart:-1});
  assert.deepEqual(pitchAt(0,base,[{at:0,semitones:8,applyTo:'both'}]),{sound:-4,chart:-4});   // brought round to -6..+6
});

test('the owner loads each song\'s setting, saves real changes, and tells listeners', () => {
  const prefs=fakePrefs({'cb-pitch:song1':writePitch({offset:4,sound:true,chart:false})});
  const pitch=createPitchState({prefs}),heard=[];
  pitch.subscribe((value,song)=>heard.push([value.offset,value.chart,song]));
  pitch.set({offset:2});assert.equal(prefs.writes.length,0,'no song yet: nothing saved');
  pitch.setSong('song1');assert.deepEqual(pitch.get(),{offset:4,sound:true,chart:false});
  pitch.set({offset:4});assert.equal(prefs.writes.length,0,'no change: nothing saved');
  pitch.set({offset:7});assert.equal(pitch.get().offset,-5,'round the corner');
  pitch.set({chart:true});
  assert.deepEqual(readPitch(prefs.data.get('cb-pitch:song1')),{offset:-5,sound:true,chart:true});
  pitch.setSong('song2');assert.deepEqual(pitch.get(),{...DEFAULT_PITCH});
  assert.deepEqual(heard,[[4,false,'song1'],[-5,false,'song1'],[-5,true,'song1'],[0,true,'song2']]);
  const stop=pitch.subscribe(()=>{throw Error('should be unsubscribed');});stop();
  pitch.set({offset:1});
});
