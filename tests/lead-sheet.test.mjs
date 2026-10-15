import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {analyzeScore, engravingSettings, applyEngraving, splitLyrics, placeAnchor, parserBreaks, mapScoreTiming, activeScoreTiming} from '../chordbuddy/web/lead-sheet.js';
const sandbox={module:{exports:{}},exports:{},console};vm.runInNewContext(readFileSync(new URL('../chordbuddy/web/vendor/abcjs-basic-min.js',import.meta.url),'utf8'),sandbox);const abcjs=sandbox.module.exports;
const abc='X:1\nT:Test\nM:4/4\nL:1/4\nV:1 name="Vocal"\nV:2 name="Piano"\nK:C\n% verse\n[V:1] "C"C-C E z|F G A B|\n% chorus\n[V:1] c B A G|F E D C|\n[V:2] C,4|D,4|E,4|F,4|';
test('parser identifies vocal sounded notes, skips rests and tie continuations',()=>{const a=analyzeScore(abc,abcjs);assert.equal(a.notes.length,14);assert.equal(a.notes[0].startChar,abc.indexOf('"C"C')-1);assert.equal(a.measures,4);assert.deepEqual(a.sections.map(s=>s.name),['Verse','Chorus']);});
test('display modifications preserve original source indices and chord source',()=>{const a=analyzeScore(abc,abcjs);const tune=abcjs.parseOnly(abc,{lineBreaks:[[1]]})[0];applyEngraving(tune,a,{...engravingSettings(),anchors:[{index:1,text:'hello'}]});const staves=tune.lines.filter(l=>l.staff);assert.ok(staves.every(l=>l.staff.length===1));const notes=staves.flatMap(l=>l.staff[0].voices[0]).filter(n=>n.el_type==='note');assert.equal(notes.find(n=>n.startChar===a.notes[1].startChar).lyric[0].syllable,'hello');assert.equal(notes[0].startChar,a.notes[0].startChar);});
test('manual placement preserves content and moves explicitly',()=>{const content={abc,chords:[{id:'c'}]};const next=placeAnchor(content,2,'world');assert.equal(next.abc,abc);assert.equal(next.chords,content.chords);assert.deepEqual(next.engraving.anchors,[{index:2,text:'world'}]);assert.deepEqual(placeAnchor(next,4,'world',2).engraving.anchors,[{index:4,text:'world'}]);assert.equal(content.engraving,undefined);});
test('lyric splitting only supplies a tray, never anchors',()=>{assert.deepEqual(splitLyrics('hel-lo world'),['hel','lo','world']);assert.deepEqual(engravingSettings({lyrics_text:'hel-lo'}).anchors,[]);});


test('whole-bar breaks use the vendor nested group format and regroup original lines',()=>{const source='X:1\nM:4/4\nL:1/4\nK:C\nC D E F|G A B c|\nc B A G|F E D C|\nC4|D4|E4|F4|';const a=analyzeScore(source,abcjs);for(const [bars,expected] of [[2,[2,2,2,2]],[3,[3,3,2]],[4,[4,4]],[8,[8]]]){const s=engravingSettings({bars_per_line:bars});const tune=abcjs.parseOnly(source,{lineBreaks:parserBreaks(a,s)})[0];assert.deepEqual(Array.from(tune.lines.filter(l=>l.staff),l=>l.staff[0].voices[0].filter(n=>n.el_type==='bar').length),expected);}});

test('a rest-only section keeps its heading at the section start',()=>{const source='X:1\nM:4/4\nL:1/4\nK:C\n% intro\nz4|\n% chorus\nC4|D4|';const a=analyzeScore(source,abcjs);assert.deepEqual(a.sections,[{name:'Intro',measure:0},{name:'Chorus',measure:1}]);const s=engravingSettings();const tune=abcjs.parseOnly(source,{lineBreaks:parserBreaks(a,s)})[0];applyEngraving(tune,a,s);assert.deepEqual(Array.from(tune.lines.filter(l=>l.subtitle),l=>l.subtitle.text),['Intro','Chorus']);});
test('instrumental toggle keeps both staves without applying melody lyrics to accompaniment',()=>{const a=analyzeScore(abc,abcjs),s=engravingSettings({show_instrumental:true,anchors:[{index:0,text:'Hi'}]});const tune=abcjs.parseOnly(abc,{lineBreaks:parserBreaks(a,s)})[0];applyEngraving(tune,a,s);assert.ok(tune.lines.filter(l=>l.staff).every(l=>l.staff.length===2));assert.ok(tune.lines.filter(l=>l.staff).flatMap(l=>l.staff[1].voices[0]).every(n=>!n.lyric));});
test('vocal melody wins over instrumental melody when both have melody names',()=>{const source='X:1\nM:4/4\nL:1/4\nV: Vocal name="Vocal Melody"\nV: Ins name="Ins Melody"\nK:C\nV: Vocal\nC4|D4|\nV: Ins\nE F G A|B c d e|';const a=analyzeScore(source,abcjs);assert.equal(a.staffIndex,0);assert.equal(a.notes.length,2);});
test('four-bar phrasing resets at a new section instead of leaving a one-bar line',()=>{const a={measures:11,sections:[{name:'Verse',measure:0},{name:'Chorus',measure:3}],bars:Array.from({length:11},(_,measure)=>({measure,startChar:measure})),groups:[Array.from({length:11},(_,i)=>i)]};assert.deepEqual(parserBreaks(a,engravingSettings()),[[2,6]]);});

test('score timing links bars and notes to recording measures without shifting pickup bars',()=>{
  const analysis={measures:2,notes:[{index:0,measure:0,startChar:0,endChar:1},{index:1,measure:1,startChar:2,endChar:3}],bars:[{measure:0,startChar:1},{measure:1,startChar:3}]};
  const music={measures:[{id:'m0',number:1,start:0,end:1,beats:[0,.5]},{id:'m1',number:2,start:1,end:3,beats:[1,2]}]};
  const timing=mapScoreTiming(analysis,music);
  assert.equal(timing.exact,true);
  assert.deepEqual(timing.bars.map(bar=>[bar.measure,bar.start,bar.end]),[[0,0,1],[1,1,3]]);
  assert.equal(timing.notes[1].time,1);
  assert.equal(activeScoreTiming(timing,2.25).measure,1);
  assert.equal(activeScoreTiming(timing,2.25).beat,1);
});

test('score timing marks measure count mismatches uncertain instead of claiming exact links',()=>{
  const analysis={measures:3,notes:[],bars:[]};
  const music={measures:[{id:'m0',number:1,start:0,end:2,beats:[0,1]},{id:'m1',number:2,start:2,end:4,beats:[2,3]}]};
  const timing=mapScoreTiming(analysis,music);
  assert.equal(timing.exact,false);
  assert.equal(timing.uncertain,true);
  assert.ok(timing.measures.every(measure=>measure.uncertain));
});
