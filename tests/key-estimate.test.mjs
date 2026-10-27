import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateKey,parseKeyLab,parseChord,keyName,KEY_CHOICES,chooseKey,outsideShare} from '../chordbuddy/web/key-estimate.js';

const song=labels=>labels.map((label,i)=>({label,start:i*2,end:i*2+2}));

test('chord names are read as a root and major/minor/diminished', () => {
  assert.deepEqual(parseChord('A:min'),{pitch:9,quality:'min'});
  assert.deepEqual(parseChord('F#m7'),{pitch:6,quality:'min'});
  assert.deepEqual(parseChord('Bb:maj7'),{pitch:10,quality:'maj'});
  assert.deepEqual(parseChord('G7/B'),{pitch:7,quality:'maj'});
  assert.deepEqual(parseChord('Bdim'),{pitch:11,quality:'dim'});
  assert.deepEqual(parseChord('A#sus2'),{pitch:10,quality:'sus'});
  assert.deepEqual(parseChord('Dsus4/A'),{pitch:2,quality:'sus'});
  assert.deepEqual(parseChord('G7sus4'),{pitch:7,quality:'sus'});
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

test("the analysis model's key.lab gives the key, and the key it holds longest wins", () => {
  assert.equal(parseKeyLab('0.01\t23.85\tF:minor\n').label,'F minor');
  assert.equal(parseKeyLab('0\t10\tBb:major\n').label,'Bb major');
  assert.equal(parseKeyLab('0\t10\tF#:min\n').label,'F# minor');
  assert.equal(parseKeyLab('0\t20\tC:major\n20\t30\tA:minor\n30\t50\tC:major\n').label,'C major');
  assert.equal(parseKeyLab('0\t5\tN\n'),null);
  assert.equal(parseKeyLab(''),null);
});

test('a song whose Bb chords are heard as Bb major (a Dorian-flavored F minor) is still F minor by the model, though a chart with plain Bb major chords says Eb major', () => {
  const chords=[['Fm',.7],['A#sus2',.7],['D#',1.4],['Fm',.7],['A#sus2',.7],['C#',1.4],['Fm',.7],['A#sus2',.7],['D#',1.4],['G#',.7],['D#/F##',.4]];
  let at=2;const heard=chords.map(([label,length])=>({label,start:at,end:at+=length}));
  assert.equal(estimateKey(heard.map(c=>c.label==='A#sus2'?{...c,label:'A#'}:c)).label,'Eb major');
  assert.equal(parseKeyLab('0.01\t23.85\tF:minor\n').label,'F minor');
});

test('a suspended chord counts by its root only: it has no third, so it cannot make a key major or minor', () => {
  const chords=[['Fm',.7],['A#sus2',.7],['D#',1.4],['Fm',.7],['A#sus2',.7],['C#',1.4],['Fm',.7],['A#sus2',.7],['D#',1.4],['G#',.7],['D#/F##',.4]];
  let at=2;const heard=chords.map(([label,length])=>({label,start:at,end:at+=length}));
  assert.equal(estimateKey(heard).label,'F minor');
  assert.equal(estimateKey(song(['Csus2','Gsus4','Asus2','Fsus2','Csus2','Gsus4'])).tonic,0);
});

test('the analysis key is kept unless the chords plainly argue with it', () => {
  // a song in C# minor that sits on B: the model hears "B major", but a quarter of the song is A, which has no place in B major
  let t=0;const chords=[];for(let i=0;i<8;i++)for(const [label,beats] of [['B',8],['A',4],['C#m7',4]]){chords.push({label,start:t,end:t+beats});t+=beats;}
  const b=parseKeyLab('0 100 B:major');assert.ok(outsideShare(chords,b)>.2);
  const chosen=chooseKey(b,chords);assert.equal(chosen.key.label,'C# minor');assert.equal(chosen.source,'chords');assert.equal(chosen.overruled.label,'B major');
  const fits=[{label:'C',start:0,end:4},{label:'F',start:4,end:8},{label:'G',start:8,end:12},{label:'Bb',start:12,end:13}];   // one borrowed chord is fine
  assert.deepEqual(chooseKey(parseKeyLab('0 13 C:major'),fits),{key:parseKeyLab('0 13 C:major'),source:'model',overruled:null});
  assert.equal(chooseKey(null,fits).source,'chords');
});
