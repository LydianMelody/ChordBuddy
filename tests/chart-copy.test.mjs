import test from 'node:test';
import assert from 'node:assert/strict';
import {copyTargets,copySectionLyrics} from '../chordbuddy/web/chart-copy.js';
import {effectiveMeasures,validatePlacements} from '../chordbuddy/web/chart-layout.js';
import {validateChart} from '../chordbuddy/web/editor.js';

// eight 4-beat bars of 2 seconds each; Chorus 1 is bars 1-4, Chorus 2 is bars 5-8 (or 5-7)
const bar=i=>({id:'m'+i,number:i+1,start:i*2,end:i*2+2,beats:[0,.5,1,1.5].map(t=>i*2+t),meter:[4,4]});
const music={measures:Array.from({length:8},(_,i)=>bar(i))};
const content=(second={start:8,end:16})=>({duration:16,chords:[],
  sections:[{id:'a',name:'Chorus 1',start:0,end:8,lyrics:'where did you learn\nhow much can I be'},{id:'b',name:'Chorus 2',start:second.start,end:second.end,lyrics:'old words here'}],
  layout:{bars_per_line:4,breaks:[],bar_overrides:[],lines:[
    {section_id:'a',line:0,start_measure:'m0',end_measure:'m1',words:[{offset:0,measure_id:'m0',beat:0},{offset:6,measure_id:'m0',beat:2},{offset:10,measure_id:'m1',beat:1}]},
    {section_id:'b',line:0,start_measure:'m4',end_measure:'m4',words:[{offset:0,measure_id:'m4',beat:0}]}]}});

test('sections with the same name, numbered or not, can be copied onto each other',()=>{
  assert.deepEqual(copyTargets(content(),'a').map(s=>s.id),['b']);
  const plain=content();plain.sections[0].name='Chorus';plain.sections[1].name='Chorus 2';plain.sections.push({id:'c',name:'Verse',start:16,end:17,lyrics:''});
  assert.deepEqual(copyTargets(plain,'a').map(s=>s.id),['b']);
  const none=content();none.sections[0].lyrics='  ';assert.deepEqual(copyTargets(none,'a'),[]);
  const other=content();other.sections[1].name='Bridge';assert.deepEqual(copyTargets(other,'a'),[]);
});

test('the lyrics and every pin move to the same bar and beat of the other section, replacing what was there',()=>{
  const c=content(),{candidate,kept,dropped}=copySectionLyrics(c,music,'a','b');
  assert.equal(candidate.sections[1].lyrics,c.sections[0].lyrics);assert.equal(c.sections[1].lyrics,'old words here');   // the original is untouched
  const lines=candidate.layout.lines.filter(p=>p.section_id==='b');
  assert.deepEqual(lines.map(p=>p.line),[0]);
  assert.deepEqual(lines[0].words,[{offset:0,measure_id:'m4',beat:0},{offset:6,measure_id:'m4',beat:2},{offset:10,measure_id:'m5',beat:1}]);
  assert.deepEqual([lines[0].start_measure,lines[0].end_measure],['m4','m5']);assert.equal(kept,3);assert.equal(dropped,0);
  assert.equal(validateChart(candidate),null);validatePlacements(candidate,music);   // the saved chart would accept it
  assert.equal(candidate.layout.lines.filter(p=>p.section_id==='a').length,1);       // the source keeps its own
});

test('a pin with no place in a shorter section is let go and the rest stay in order',()=>{
  const short=content({start:8,end:9.9});   // one bar
  const {candidate,kept,dropped}=copySectionLyrics(short,music,'a','b');
  const words=candidate.layout.lines.find(p=>p.section_id==='b').words;
  assert.deepEqual(words.map(w=>w.measure_id),['m4','m4']);assert.equal(kept,2);assert.equal(dropped,1);
  validatePlacements(candidate,music);
});

test('copying needs two sections and words to copy',()=>{
  assert.throws(()=>copySectionLyrics(content(),music,'a','a'),/two different/);
  const empty=content();empty.sections[0].lyrics='';assert.throws(()=>copySectionLyrics(empty,music,'a','b'),/no lyrics/);
});

test('chords are copied bar for bar and beat for beat, rests included, replacing the other section’s own', async () => {
  const {copySectionChords,chordCopyTargets}=await import('../chordbuddy/web/chart-copy.js');
  const c=content(),ch=(id,label,start,end,section_id)=>({id,label,start,end,section_id,line:null,offset:null});
  // Chorus 1: a quarter rest, then C#m7 to the end of bar 2; A; B over the last bar. Chorus 2 has the rest missing.
  c.chords=[ch('a1','N',0,.5,'a'),ch('a2','C#m7',.5,4,'a'),ch('a3','A',4,6,'a'),ch('a4','B',6,8,'a'),
    ch('b1','C#m7',8,12,'b'),ch('b2','A',12,14,'b'),ch('b3','B',14,16,'b',)];
  c.chords[4].line=0;c.chords[4].offset=0;
  assert.deepEqual(chordCopyTargets(c,'a').map(s=>s.id),['b']);
  const {candidate,copied,dropped}=copySectionChords(c,music,'a','b');
  assert.equal(validateChart(candidate),null);assert.deepEqual([copied,dropped],[4,0]);
  const mine=candidate.chords.filter(x=>x.section_id==='b').map(x=>[x.label,x.start,x.end,x.line]);
  assert.deepEqual(mine,[['N',8,8.5,null],['C#m7',8.5,12,null],['A',12,14,null],['B',14,16,null]]);
  assert.deepEqual(candidate.chords.filter(x=>x.section_id==='a').map(x=>x.id),['a1','a2','a3','a4'],'the section copied from is unchanged');
});

test('a section with fewer bars takes the chords that fit; what sounds into it from before meets the first copied chord', async () => {
  const {copySectionChords}=await import('../chordbuddy/web/chart-copy.js');
  const c=content({start:8,end:14}),ch=(id,label,start,end,section_id)=>({id,label,start,end,section_id,line:null,offset:null});
  c.duration=16;c.sections.push({id:'z',name:'Outro',start:14,end:16,lyrics:''});
  // Chorus 1: E for half a bar, F# to the end of bar 2, A, B
  c.chords=[ch('a0','E',0,1,'a'),ch('a1','F#',1,4,'a'),ch('a2','A',4,6,'a'),ch('a3','B',6,8,'a'),ch('b1','G',8,14,'b'),ch('z1','E',14,16,'z')];
  const {candidate,dropped}=copySectionChords(c,music,'a','b');
  assert.equal(validateChart(candidate),null);assert.equal(dropped,1,'Chorus 2 has no fourth bar for B');
  assert.deepEqual(candidate.chords.filter(x=>x.section_id==='b').map(x=>[x.label,x.start,x.end]),[['E',8,9],['F#',9,12],['A',12,14]]);
});

test('folding chosen by hand comes along with the chords; the other section’s own choice gives way', async () => {
  const {copySectionChords}=await import('../chordbuddy/web/chart-copy.js');
  const c=content(),ch=(id,label,start,end,section_id)=>({id,label,start,end,section_id,line:null,offset:null});
  c.chords=[ch('a1','E',0,4,'a'),ch('a2','A',4,8,'a'),ch('b1','E',8,16,'b')];
  c.layout.compact={version:1,groups:[
    {id:'x@0',section_id:'a',mode:'expanded',passes:[{start:0,end:8,measure_ids:['m0','m1','m2','m3'],chord_ids:['a1','a2']}]},
    {id:'y@8',section_id:'b',mode:'repeat',passes:[{start:8,end:12,measure_ids:['m4','m5'],chord_ids:['b1']},{start:12,end:16,measure_ids:['m6','m7'],chord_ids:['b1']}]}]};
  const {candidate}=copySectionChords(c,music,'a','b');
  const groups=candidate.layout.compact.groups;
  assert.deepEqual(groups.map(g=>[g.section_id,g.mode]),[['a','expanded'],['b','expanded']]);
  const copied=groups[1].passes[0],ids=candidate.chords.filter(x=>x.section_id==='b').map(x=>x.id);
  assert.deepEqual([copied.start,copied.end,copied.measure_ids],[8,16,['m4','m5','m6','m7']]);
  assert.deepEqual(copied.chord_ids,ids,'pointing at the copied chords');
});
