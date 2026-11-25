import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {setKeySpelling,setChartPitch,spellChord,unspellChord,shownKey,chartMoved,chartOffsetAt,spellAbc} from '../chordbuddy/web/spelling.js';
import {analyzeScore} from '../chordbuddy/web/lead-sheet.js';

// Pitch control's Chart switch is a view: every chord name passes through spellChord, typed chords come back through unspellChord.
const reset=()=>{setKeySpelling(null);setChartPitch(0);};

test('with the chart moved, chords are drawn in the new key and spelled for it', () => {
  setKeySpelling('A minor');setChartPitch(3);
  assert.equal(shownKey(),'C minor');assert.equal(chartMoved(),true);
  assert.deepEqual(['Am','F','G','E7','Dm7','G#dim','C/E'].map(c=>spellChord(c)),['Cm','Ab','Bb','G7','Fm7','Bdim','Eb/G']);
  setChartPitch(0);assert.equal(shownKey(),'A minor');assert.equal(chartMoved(),false);
  assert.equal(spellChord('G#dim'),'G#dim');
  reset();
});

test('analysis sharps still come out in the shown key\'s spelling', () => {
  setKeySpelling('E major');setChartPitch(-4);   // E -> C
  assert.equal(shownKey(),'C major');
  assert.equal(spellChord('G#m'),'Em');assert.equal(spellChord('C#m'),'Am');assert.equal(spellChord('D#dim'),'Bdim');
  setKeySpelling('C major');setChartPitch(1);    // C -> Db: the analysis's C# is drawn Db
  assert.equal(spellChord('C#'),'D');assert.equal(spellChord('F'),'Gb');assert.equal(spellChord('A#m'),'Bm');
  reset();
});

test('typing while moved saves in the song\'s own key; untouched chords are never rewritten', () => {
  setKeySpelling('C major');setChartPitch(7);    // shown in G
  assert.equal(shownKey(),'G major');
  assert.equal(unspellChord('F'),'Bb');
  assert.equal(unspellChord('D/F#'),'G/B');
  assert.equal(spellChord(unspellChord('Em7')),'Em7','what you type is what you see');
  setChartPitch(0);assert.equal(unspellChord('F#m'),'F#m','not moved: saved as typed');
  reset();
});

test('the shown key follows the switches: Chart off means the chart stays put', () => {
  setKeySpelling('D major');setChartPitch(0);   // the app passes 0 when Chart is off, whatever the offset
  assert.equal(spellChord('A'),'A');assert.equal(shownKey(),'D major');
  reset();
});

test('a show can move the chart partway through: chords take the pitch at their own play position', () => {
  setKeySpelling('A minor');setChartPitch(0,[{at:60,offset:2},{at:30,offset:1}]);
  assert.equal(chartOffsetAt(10),0);assert.equal(chartOffsetAt(30),1);assert.equal(chartOffsetAt(90),2);
  assert.equal(spellChord('Am',10),'Am');assert.equal(spellChord('Am',45),'Bbm');assert.equal(spellChord('Am',61),'Bm');
  assert.equal(unspellChord('Bm',61),'Am');
  assert.equal(chartMoved(),true);
  reset();
});

test('songs with no known key still move, and the key line is empty', () => {
  setKeySpelling(null);setChartPitch(2);
  assert.equal(shownKey(),null);assert.equal(spellChord('C'),'D');assert.equal(spellChord('Bb'),'C');assert.equal(unspellChord('D'),'C');
  reset();
});

test('the lead sheet ABC respelling is about the song\'s key only, never moved (the score is rewritten instead)', () => {
  setKeySpelling('F minor');setChartPitch(3);
  const abc='K:Fm\n"C#"C|',chords=[{abc_index:abc.indexOf('"C#"')}];
  assert.equal(spellAbc(abc,chords),'K:Fm\n"Db"C|');
  reset();
});

const sandbox={module:{exports:{}},exports:{},console};vm.runInNewContext(readFileSync(new URL('../chordbuddy/web/vendor/abcjs-basic-min.js',import.meta.url),'utf8'),sandbox);
const abcjs=sandbox.module.exports.renderAbc?sandbox.module.exports:sandbox.ABCJS||sandbox.module.exports;

test('the lead sheet\'s score moves by the pitch, notes and key signature, and keeps every note in order', () => {
  const abc='X:1\nM:4/4\nL:1/4\nK:Am\n"Am"A c e ^g|"F"f =g "E7"e2|]\n';
  for(const [n,key] of [[3,'K:Cm'],[-3,'K:F#m'],[6,'K:Ebm'],[-6,'K:Ebm'],[1,'K:Bbm']]){
    const moved=abcjs.strTranspose(abc,abcjs.parseOnly(abc),n);
    assert.ok(moved.includes(key),`${n}: ${moved}`);
    assert.equal(analyzeScore(moved,abcjs).notes.length,analyzeScore(abc,abcjs).notes.length,`${n}: same notes`);
  }
  const up3=abcjs.strTranspose(abc,abcjs.parseOnly(abc),3);
  assert.ok(/c e g =b\|/.test(up3),'A c e ^g up a minor third is c e g b-natural: '+up3);
});

test('the visuals get the pitch with the song, and a pitch change sends the song again', async () => {
  const {createVisualPublisher}=await import('../chordbuddy/web/visual-bridge.js');
  const sent=[],channel={postMessage:m=>sent.push(m)};
  const publisher=createVisualPublisher({open:()=>channel});
  channel.onmessage({data:{type:'hello'}});
  const song={songId:'s',runId:'r',title:'T',key:'A minor',revision:'1',midiDocs:[],userMidi:[]};
  publisher.scene({...song,pitch:{chart:0,sound:0}});
  publisher.scene({...song,pitch:{chart:0,sound:0}});
  publisher.scene({...song,pitch:{chart:3,sound:3}});
  const scenes=sent.filter(m=>m.type==='scene');
  assert.equal(scenes.length,2);assert.deepEqual(scenes[1].pitch,{chart:3,sound:3});
});

test('a song set to flats or sharps writes every chord that way, the key name too, and keeps it when the pitch moves', async () => {
  const {setSpellingPreference,shownSpelling}=await import('../chordbuddy/web/spelling.js');
  setKeySpelling('F# minor');
  assert.equal(shownSpelling(),'sharps');assert.equal(spellChord('C#m'),'C#m');
  setSpellingPreference('flats');
  assert.equal(shownKey(),'Gb minor');assert.equal(spellChord('C#m'),'Dbm');assert.equal(spellChord('F#/A#'),'Gb/Bb');assert.equal(shownSpelling(),'flats');
  setChartPitch(-1);assert.equal(shownKey(),'F minor');assert.equal(spellChord('C#'),'C');
  setChartPitch(6);assert.equal(shownKey(),'C minor');
  setChartPitch(0);setSpellingPreference('sharps');setKeySpelling('Eb major');
  assert.equal(shownKey(),'D# major');assert.equal(spellChord('Bb7'),'A#7');
  setSpellingPreference('key');assert.equal(shownKey(),'Eb major');assert.equal(spellChord('A#7'),'Bb7');
  setSpellingPreference('nonsense');assert.equal(shownKey(),'Eb major','an unknown choice follows the key');
  reset();
});
