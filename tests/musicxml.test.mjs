import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAbcjs} from './abcjs-node.mjs';
import {analyzeScore} from '../chordbuddy/web/lead-sheet.js';
import {tuneToMusicXml,splitLength,parseChord,exportFileName} from '../chordbuddy/web/musicxml.js';

const abcjs=loadAbcjs();
const xmlFor=(abc,options={})=>{const tune=abcjs.parseOnly(abc)[0],a=analyzeScore(abc,abcjs);return tuneToMusicXml(tune,{staffIndex:a.staffIndex,voiceIndex:a.voiceIndex,...options});};

// A tiny well-formedness check: every tag closes in order.
function wellFormed(xml){
  const stack=[];
  for(const m of xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g,'').matchAll(/<(\/?)([A-Za-z][\w-]*)([^>]*?)(\/?)>/g)){
    const [,close,name,,self]=m;
    if(self)continue;
    if(close){if(stack.pop()!==name)return false;}else stack.push(name);
  }
  return stack.length===0;
}
const measuresOf=xml=>[...xml.matchAll(/<measure number="(\d+)">([\s\S]*?)<\/measure>/g)].map(m=>({number:+m[1],body:m[2]}));
const lengthOf=body=>[...body.matchAll(/<note>[\s\S]*?<duration>([\d.]+)<\/duration>/g)].reduce((n,m)=>n+Number(m[1]),0);

const abc='X:1\nT:Song\nM:4/4\nL:1/16\nQ:1/4=96\nK:D\nV: Vocal name="Vocal Melody"\nZ|"D"f4f2aa-"A"a3z4z|"G"b2b2b2^a2a3z4f|[M:2/4] "Bm"f4z4|[M:4/4] "D"d8"A"e5z3|\n';
test('the file is well formed MusicXML with the song, tempo, key and every bar the same length',()=>{
  const xml=xmlFor(abc,{title:'My <Song> & more',artist:'A Band'});
  assert.ok(wellFormed(xml),'every tag closes');
  assert.match(xml,/<score-partwise version="3\.1">/);assert.match(xml,/<work-title>My &lt;Song&gt; &amp; more<\/work-title>/);assert.match(xml,/<creator type="composer">A Band<\/creator>/);
  assert.match(xml,/<fifths>2<\/fifths>/);assert.match(xml,/<per-minute>96<\/per-minute>/);
  const measures=measuresOf(xml);
  assert.equal(measures.length,5);                       // the opening rest bar, then four written bars
  assert.deepEqual(measures.map(m=>m.number),[1,2,3,4,5]);
  assert.deepEqual(measures.map(m=>lengthOf(m.body)),[96,96,96,48,96]);            // 4/4, 4/4, 4/4, 2/4, 4/4 in 24ths of a quarter
  assert.match(measures[3].body,/<beats>2<\/beats><beat-type>4<\/beat-type>/);
  assert.match(measures[4].body,/<beats>4<\/beats>/);
});

test('chord symbols become harmony elements with the label the app shows, lyrics sit on their notes, ties are written',()=>{
  const xml=xmlFor(abc,{chordLabel:name=>name==='A'?'A7':name,lyrics:new Map([[0,{syllable:'Dan',divider:'-'}],[1,{syllable:'cing',divider:' '}],[2,{syllable:'on',divider:' '}]])});
  assert.match(xml,/<root-step>A<\/root-step><\/root><kind text="7">dominant<\/kind>/);
  assert.match(xml,/<root-step>B<\/root-step><\/root><kind text="m">minor<\/kind>/);
  assert.match(xml,/<syllabic>begin<\/syllabic><text>Dan<\/text>/);assert.match(xml,/<syllabic>end<\/syllabic><text>cing<\/text>/);assert.match(xml,/<syllabic>single<\/syllabic><text>on<\/text>/);
  assert.match(xml,/<tie type="start"\/>/);assert.match(xml,/<tie type="stop"\/>/);
  assert.match(xml,/<pitch><step>F<\/step><alter>1<\/alter><octave>5<\/octave><\/pitch>/);          // an F in the key of D is F sharp
  assert.match(xml,/<step>A<\/step><alter>1<\/alter><octave>5<\/octave>/);                          // an accidental written in the bar
});

test('odd lengths become tied standard lengths, and rests are never tied',()=>{
  assert.deepEqual(splitLength(120).map(p=>p[1]+p[2]),['whole0','quarter0']);      // five quarters: a whole note and a quarter
  assert.deepEqual(splitLength(36).map(p=>p[1]+p[2]),['quarter1']);
  assert.equal(splitLength(30).reduce((n,p)=>n+p[0],0),30);
  const xml=xmlFor('X:1\nM:4/4\nL:1/16\nK:C\nV: V name="Vocal"\nc5z11|\n');
  assert.ok(wellFormed(xml));assert.equal((xml.match(/<tie /g)||[]).length,2);                       // the five-sixteenth note is a quarter tied to a sixteenth
  assert.equal(measuresOf(xml).reduce((n,m)=>n+lengthOf(m.body),0),96);
});

test('chord names are read into root, kind and bass, and unreadable ones are kept as written',()=>{
  assert.deepEqual(parseChord('F#m7/C'),{rootStep:'F',rootAlter:1,kind:'minor-seventh',text:'m7',bassStep:'C',bassAlter:0});
  assert.equal(parseChord('Bbmaj7').kind,'major-seventh');assert.equal(parseChord('Bbmaj7').rootAlter,-1);
  assert.equal(parseChord('Gsus4').kind,'suspended-fourth');assert.equal(parseChord('Cadd9').kind,'other');assert.equal(parseChord('N.C.'),null);
});

test('the file name is safe for any computer',()=>{
  assert.equal(exportFileName('AC/DC: "Back" in Black?'),'AC DC Back in Black.musicxml');assert.equal(exportFileName(''),'Lead sheet.musicxml');
});

test('chord names in the file are spelled as the chart spells them, and a chosen time signature of the same bar length is used',()=>{
  const flats=abcjs.parseOnly('X:1\nM:4/4\nL:1/16\nK:Fm\n"A#sus2"c4c4c4c4|\n')[0];
  const a=analyzeScore('X:1\nM:4/4\nL:1/16\nK:Fm\n"A#sus2"c4c4c4c4|\n',abcjs);
  const xml=tuneToMusicXml(flats,{staffIndex:a.staffIndex,voiceIndex:a.voiceIndex,chordsFor:()=>['Bbsus2'],meter:{num:2,den:2}});
  assert.match(xml,/<root-step>B<\/root-step><root-alter>-1<\/root-alter>/);assert.match(xml,/<beats>2<\/beats><beat-type>2<\/beat-type>/);
  const other=tuneToMusicXml(flats,{staffIndex:a.staffIndex,voiceIndex:a.voiceIndex,meter:{num:3,den:4}});   // not as long as the score's bar: ignored
  assert.match(other,/<beats>4<\/beats><beat-type>4<\/beat-type>/);
});
