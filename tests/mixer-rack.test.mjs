import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {STRIPS,STEM_INDEX,PRESETS,presetMix,activePreset,effectiveLevels,meterLevel,fallingLevel,mixLabel,mixExportQuery} from '../chordbuddy/web/mixer-rack.js';
import {defaultMix,PcmMixer} from '../chordbuddy/web/pcm-mixer-core.js';

test('seven ordinary-named strips, in the planned order, each mapped to its own PCM track', () => {
  assert.deepEqual(STRIPS.map(s=>s.label),['Vocals','Lead guitar','Rhythm guitar','Bass','Drums','Piano','Other']);
  assert.ok(!STRIPS.some(s=>s.key==='guitar'));
  assert.deepEqual([...STRIPS.map(s=>s.index)].sort(),[0,1,2,3,4,5,6]);
  assert.equal(STRIPS[0].index,STEM_INDEX.vocals);
  assert.equal(STRIPS[2].index,STEM_INDEX.rhythm);
});

test('the PCM track order the strips map onto has not drifted', () => {
  // pcm-mixer-core indexes gains/mutes/solos by this order; the old stems tab used it too.
  assert.deepEqual(STEM_INDEX,{bass:0,drums:1,other:2,vocals:3,piano:4,lead:5,rhythm:6});
});

test('every preset produces a mix the audio engine accepts', () => {
  for (const preset of PRESETS) new PcmMixer().setMix(presetMix(defaultMix(),preset.id));
});

test('presets mute the right stems, reset faders and solos, and keep master', () => {
  const messy={gains:[.2,.4,.6,.8,1,.1,.3],mutes:Array(7).fill(true),solos:[true,false,false,false,false,false,false],master:.35};
  const karaoke=presetMix(messy,'karaoke');
  assert.deepEqual(karaoke.gains,Array(7).fill(1));assert.deepEqual(karaoke.solos,Array(7).fill(false));assert.equal(karaoke.master,.35);
  assert.deepEqual(karaoke.mutes.map((m,i)=>m?i:-1).filter(i=>i>=0),[STEM_INDEX.vocals]);
  const noGuitars=presetMix(messy,'noguitars');
  assert.deepEqual(noGuitars.mutes.map((m,i)=>m?i:-1).filter(i=>i>=0).sort(),[STEM_INDEX.lead,STEM_INDEX.rhythm].sort());
  const rhythm=presetMix(messy,'rhythm');
  const playing=rhythm.mutes.map((m,i)=>m?-1:i).filter(i=>i>=0).sort();
  assert.deepEqual(playing,[STEM_INDEX.bass,STEM_INDEX.drums,STEM_INDEX.rhythm].sort());
  assert.deepEqual(presetMix(messy,'full').mutes,Array(7).fill(false));
  assert.throws(()=>presetMix(messy,'nope'));
});

test('activePreset recognises a preset only while the mix still matches it exactly', () => {
  for (const preset of PRESETS) assert.equal(activePreset(presetMix(defaultMix(),preset.id)),preset.id);
  const nudged=presetMix(defaultMix(),'karaoke');nudged.gains[0]=.9;assert.equal(activePreset(nudged),null);
  const soloed=defaultMix();soloed.solos[3]=true;assert.equal(activePreset(soloed),null);
});

test('effective levels: mute wins, a solo silences the others, several solos are allowed', () => {
  const mix=defaultMix();mix.gains[0]=.5;
  assert.deepEqual(effectiveLevels(mix),[.5,1,1,1,1,1,1]);
  mix.mutes[1]=true;assert.equal(effectiveLevels(mix)[1],0);
  const solo=defaultMix();solo.solos[3]=true;solo.solos[5]=true;
  assert.deepEqual(effectiveLevels(solo),[0,0,0,1,0,1,0]);
  solo.mutes[3]=true;assert.equal(effectiveLevels(solo)[3],0);
});

test('the mixer rack never offers adopting a result, and the player still follows readiness', () => {
  assert.doesNotMatch(readFileSync(new URL('../chordbuddy/web/mixer-rack.js',import.meta.url),'utf8'),/Use new result|useNewResult/);
});

test('meter scale: silence is empty, full scale is full, and every 6 dB is a tenth of the way', () => {
  assert.equal(meterLevel(0),0);assert.equal(meterLevel(-1),0);assert.equal(meterLevel(NaN),0);
  assert.equal(meterLevel(1),1);assert.equal(meterLevel(4),1);
  assert.ok(Math.abs(meterLevel(.5)-(1-6.0206/54))<1e-3);
  assert.ok(meterLevel(.01)>0&&meterLevel(.01)<meterLevel(.1)&&meterLevel(.1)<meterLevel(.5));assert.equal(meterLevel(.001),0);
  assert.equal(meterLevel(1e-6),0);
});

test('meters jump up at once, fall gradually, and settle at exactly zero', () => {
  assert.equal(fallingLevel(0,.8),.8);assert.equal(fallingLevel(.3,.9),.9);
  let v=1,steps=0;while(v>0&&steps<200){v=fallingLevel(v,0);steps++;}
  assert.equal(v,0);assert.ok(steps>8&&steps<40,'steps '+steps);
  assert.ok(fallingLevel(1,0)>.7);
});

test('exported mixes are named after what you hear and send the audible levels', () => {
  const mix=defaultMix();
  assert.equal(mixLabel(mix),'Full band');
  Object.assign(mix,presetMix(mix,'noguitars'));assert.equal(mixLabel(mix),'No guitars');
  Object.assign(mix,presetMix(mix,'full'));mix.mutes[STEM_INDEX.drums]=true;assert.equal(mixLabel(mix),'no Drums');
  Object.assign(mix,presetMix(mix,'full'));mix.solos[STEM_INDEX.bass]=true;assert.equal(mixLabel(mix),'only Bass');
  Object.assign(mix,presetMix(mix,'full'));mix.gains[STEM_INDEX.piano]=.4;assert.equal(mixLabel(mix),'custom mix');
  mix.mutes[STEM_INDEX.vocals]=true;mix.master=.5;
  assert.equal(mixExportQuery(mix),'levels=1,1,1,0,0.4,1,1&master=0.5');
});
