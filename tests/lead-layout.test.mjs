import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {packLines,systemBreaks,analyzeScore,engravingSettings,applyEngraving,audibleBars,widthForLines,STAFF_UNITS} from '../chordbuddy/web/lead-sheet.js';
const sandbox={module:{exports:{}},exports:{},console};vm.runInNewContext(readFileSync(new URL('../chordbuddy/web/vendor/abcjs-basic-min.js',import.meta.url),'utf8'),sandbox);const abcjs=sandbox.module.exports;

test('lines are filled evenly: no lonely bar, nothing wider than the room',()=>{
  assert.deepEqual(packLines(Array(9).fill(100),450),[3,3,3]);
  assert.deepEqual(packLines([100,100,100,100],250),[2,2]);assert.deepEqual(packLines([100,100,100,100],450),[4]);
  for(const widths of [[120,60,60,200,90,90,90,300,50,50],[500,100,100],[80]]){
    const lengths=packLines(widths,450);let at=0;
    assert.equal(lengths.reduce((a,b)=>a+b,0),widths.length);
    for(const length of lengths){const used=widths.slice(at,at+length).reduce((a,b)=>a+b,0);assert.ok(used<=450||length===1);at+=length;}
  }
});

test('sparse bars are narrow, so more of them share a line than crowded bars',()=>{
  const analysis={measures:12,sections:[],bars:[],groups:[]};
  const sparse=systemBreaks(analysis,engravingSettings(),Array(12).fill(60),450),crowded=systemBreaks(analysis,engravingSettings(),Array(12).fill(150),450);
  assert.ok(sparse.length<crowded.length);
});

test('automatic lines still start a new line at each section and at manual breaks',()=>{
  const analysis={measures:10,sections:[{name:'Verse',measure:5}],bars:[],groups:[]};
  const breaks=systemBreaks(analysis,{...engravingSettings(),breaks:[2]},Array(10).fill(50),1000);
  assert.ok(breaks.includes(1)&&breaks.includes(4));        // after measure 2 (manual) and after measure 5 (the section starts)
});

test('a fixed number of bars per line still works',()=>{
  const analysis={measures:9,sections:[],bars:[],groups:[]};
  assert.deepEqual(systemBreaks(analysis,{...engravingSettings(),bars_per_line:4}),[3,7]);
  assert.equal(engravingSettings({bars_per_line:5}).bars_per_line,0);
  assert.equal(engravingSettings({bars_per_line:3}).bars_per_line,3);
});

const abc='X:1\nM:4/4\nL:1/4\nK:C\n"N"z4|z4|"C"C D E F|G4|z4|"N"z4|\n';
const bars=tune=>tune.lines.flatMap(l=>(l.staff?.[0]?.voices?.[0]||[]).filter(i=>i.el_type==='bar')).length;
const notes=tune=>tune.lines.flatMap(l=>(l.staff?.[0]?.voices?.[0]||[]).filter(i=>i.el_type==='note'&&!i.rest)).length;

test('silence before and after the music is not drawn, and the music itself is untouched',()=>{
  const tune=abcjs.parseOnly(abc)[0],analysis=analyzeScore(abc,abcjs);
  assert.deepEqual(audibleBars(tune,analysis.staffIndex,analysis.voiceIndex),{first:2,last:3,total:6});
  applyEngraving(tune,analysis,engravingSettings());
  assert.equal(bars(tune),2);assert.equal(notes(tune),5);
});

test('silence in the middle, and bars that carry a real chord, stay',()=>{
  const middle='X:1\nM:4/4\nL:1/4\nK:C\n"C"C D E F|z4|G4|\n';
  const intro='X:1\nM:4/4\nL:1/4\nK:C\n"D"z4|"A"z4|C D E F|\n';
  for(const [text,expected] of [[middle,3],[intro,3]]){
    const tune=abcjs.parseOnly(text)[0],analysis=analyzeScore(text,abcjs);
    applyEngraving(tune,analysis,engravingSettings());assert.equal(bars(tune),expected);
  }
});

test('a song with no notes at all is left alone',()=>{
  const empty='X:1\nM:4/4\nL:1/4\nK:C\nz4|z4|\n';
  const tune=abcjs.parseOnly(empty)[0],analysis=analyzeScore(empty,abcjs);
  assert.equal(audibleBars(tune,analysis.staffIndex,analysis.voiceIndex),null);
  applyEngraving(tune,analysis,engravingSettings());assert.equal(bars(tune),2);
});

test('with a fixed number of bars, every line is drawn as wide as the widest needs, so they still end together',()=>{
  assert.equal(widthForLines([100,100,100,100],[1],140,760),760,'fits: the usual width');
  const wide=widthForLines([300,300,100,100],[1],140,760);
  assert.ok(wide>760&&wide>=Math.ceil(600/.94+126));
});

test('music size: three choices, medium by default, each with more room than the one before',()=>{
  assert.equal(engravingSettings().music_size,'medium');assert.equal(engravingSettings({music_size:'huge'}).music_size,'medium');
  assert.equal(engravingSettings({music_size:'small'}).music_size,'small');
  assert.ok(STAFF_UNITS.large<STAFF_UNITS.medium&&STAFF_UNITS.medium<STAFF_UNITS.small);
});
