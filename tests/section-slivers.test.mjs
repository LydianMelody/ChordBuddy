// A section shorter than one beat is not a section. "Call Me - og" had a 10 ms "Instrumental" before its Intro: never drawn (no bars), yet the
// player bar said "Instrumental" at 0:00, the timeline showed a sliver of it, and nothing on the Chart page could join it to the Intro.
import test from 'node:test';
import assert from 'node:assert/strict';
import {isSliver,chartSlivers,beatLengthAt} from '../chordbuddy/web/section-slivers.js';
import {absorbChartSection} from '../chordbuddy/web/editor.js';
import {planSectionEdit} from '../chordbuddy/web/practice-edit.js';
import {buildCompactChart} from '../chordbuddy/web/compact-chart.js';
import {sectionAtSeconds} from '../chordbuddy/web/loop-range.js';

// 90 bpm in 4/4: a beat is 2/3 s, a bar 8/3 s. Bar 1 starts at 0.01 s, as hers does.
const BEAT=2/3,START=.01;
const measures=Array.from({length:8},(_,i)=>{const start=START+i*4*BEAT;return {id:'m'+i,number:i+1,start,end:start+4*BEAT,meter:[4,4],beats:[0,1,2,3].map(k=>start+k*BEAT)};});
const END=measures.at(-1).end;
function song({sliverLyrics=''}={}){
  return {version:1,duration:END,sections:[
    {id:'s0',name:'Instrumental',start:0,end:START,lyrics:sliverLyrics},
    {id:'s1',name:'Intro',start:START,end:measures[4].start,lyrics:''},
    {id:'s2',name:'Verse',start:measures[4].start,end:END,lyrics:'lost and alone\nneon land'},
  ],chords:[
    {id:'c1',label:'D#m',start:START,end:measures[2].start,section_id:'s1',line:null,offset:null},
    {id:'c2',label:'C#',start:measures[2].start,end:measures[4].start,section_id:'s1',line:null,offset:null},
    {id:'c3',label:'B',start:measures[4].start,end:END,section_id:'s2',line:0,offset:0},
  ]};
}
const music={measures};

test('a section shorter than one beat is a sliver; a beat or longer is a section (a fade in or out stays)',()=>{
  assert.ok(Math.abs(beatLengthAt(measures,0)-BEAT)<1e-9,'before the first bar, the nearest bar says how long a beat is');
  assert.ok(isSliver({start:0,end:.01},measures));
  assert.ok(isSliver({start:0,end:BEAT*.9},measures));
  assert.ok(!isSliver({start:0,end:BEAT},measures),'a whole beat is a section');
  assert.ok(!isSliver({start:0,end:4.2},measures),'a fade in of a few seconds with no beats is a section');
  assert.equal(beatLengthAt([],3),.05,'with no bars at all, only a few milliseconds count');
});

test('the player bar and the timeline say Intro at 0:00, not the hidden sliver, and the chart itself is not changed',()=>{
  const content=song(),before=structuredClone(content);
  const view=buildCompactChart(content,music);
  assert.deepEqual(view.sections.map(s=>s.name),['Intro','Verse']);
  assert.equal(view.sections[0].start,0,'the Intro is shown from 0:00');
  assert.equal(sectionAtSeconds(view.sections,0)?.name,'Intro');
  assert.equal(sectionAtSeconds(view.sections,.005)?.name,'Intro');
  assert.deepEqual(content,before,'shown only: the chart keeps its sections until you join them');
});

test('a sliver with words of its own is still shown, so you can join it by hand',()=>{
  const view=buildCompactChart(song({sliverLyrics:'ah'}),music);
  assert.deepEqual(view.sections.map(s=>s.name),['Instrumental','Intro','Verse']);
});

test('the Chart page finds the sliver and what it would join',()=>{
  const found=chartSlivers(song().sections,measures);
  assert.equal(found.length,1);
  assert.equal(found[0].section.name,'Instrumental');assert.equal(found[0].home.name,'Intro');
  assert.deepEqual(chartSlivers([{id:'a',name:'Song',start:0,end:.01}],measures),[],'a lone section has nothing to join');
});

test('joining a first sliver gives its time to the section after it, which keeps its own name, id and chords',()=>{
  const after=absorbChartSection(song(),'s0');
  assert.deepEqual(after.sections.map(s=>[s.id,s.name,s.start]),[['s1','Intro',0],['s2','Verse',measures[4].start]]);
  assert.deepEqual(after.chords.map(c=>[c.id,c.label,c.section_id,c.start]),[['c1','D#m','s1',START],['c2','C#','s1',measures[2].start],['c3','B','s2',measures[4].start]]);
  assert.equal(after.sections[1].lyrics,'lost and alone\nneon land','other sections are untouched');
});

test('joining a sliver later in the song gives its time to the section before it',()=>{
  const content=song();
  // a 0.1 s "Break" between the Intro and the Verse
  content.sections.splice(2,0,{id:'sx',name:'Break',start:measures[4].start,end:measures[4].start+.1,lyrics:''});
  content.sections[3].start=measures[4].start+.1;content.chords[2].start=measures[4].start+.1;
  const after=absorbChartSection(content,'sx');
  assert.deepEqual(after.sections.map(s=>[s.name,s.start,s.end]),[['Instrumental',0,START],['Intro',START,measures[4].start+.1],['Verse',measures[4].start+.1,END]]);
});

test('the join is a normal, valid chart edit (one step that Undo takes back)',()=>{
  const plan=planSectionEdit(song(),music,{sectionId:'s0',operation:'absorb'});
  assert.deepEqual(plan.conflicts,[]);
  assert.deepEqual(plan.candidate.sections.map(s=>s.name),['Intro','Verse']);
  // a sliver's words travel with it
  const worded=planSectionEdit(song({sliverLyrics:'ah'}),music,{sectionId:'s0',operation:'absorb'});
  assert.equal(worded.candidate.sections[0].name,'Intro');
  assert.ok(worded.candidate.sections[0].lyrics.startsWith('ah'));
});
