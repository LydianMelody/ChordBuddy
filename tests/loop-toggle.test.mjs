// Switching a section loop on and off in Prepare (R, or the Loop button): two bugs.
// 1. A song with lead-in bars before beat 1 (numbered -2, -1, 0) looped its whole intro, lead-in included, whenever the waveform could not be used
//    to find a fade, and even with one the "start of the music" was taken to be the first bar drawn instead of bar 1.
// 2. Turning a loop off while paused queued the exit for the end of the pass, which never comes while nothing plays: the loop's band stayed on the
//    page until a click on a new place or until the playhead had gone past where the loop ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import {newPerformance} from '../chordbuddy/web/performance-model.js';
import {sectionRange} from '../chordbuddy/web/performance-runner.js';
import {sectionLoopRange,barOneStart} from '../chordbuddy/web/loop-range.js';
import {sectionTrim} from '../chordbuddy/web/performance-song.js';
import {Sim,grid} from './performance-sim.mjs';

// bars of 2 seconds; the first three are the lead-in (numbered -2, -1, 0), so bar 1 starts at 6 s
const lead=()=>{const g=grid();g.measures.forEach((m,i)=>{m.number=i-2;});return g;};
const SECTIONS=[{id:'a',name:'Intro',start:0,end:24},{id:'b',name:'Verse',start:24,end:60}];

test('bar 1 is found by its number, not by being the first bar drawn', () => {
 const g=lead();
 assert.equal(barOneStart(g.measures),6);
 assert.equal(barOneStart([{number:3,start:4}]),4,'no bar 1 at all: the first bar');
 assert.equal(barOneStart([]),null);
});

test('R in an intro leaves out the lead-in, with or without a waveform', () => {
 const g=lead();
 for(const fades of [{},{fadeIn:{end:2}}]){
  const trim=sectionTrim(g.measures,fades);
  const range=sectionRange(g.measures,SECTIONS,10*44100,{trim});
  assert.equal(range.firstBar,1,'the loop starts at bar 1');
  assert.equal(range.start,6*44100);
  assert.equal(range.faded,true,'and says so in its label');
 }
 assert.equal(sectionRange(g.measures,SECTIONS,10*44100).firstBar,-2,'without a trim the whole section, as before (the bug)');
});

test('a section that is not an intro is still looped whole', () => {
 const g=lead(),trim=sectionTrim(g.measures,{});
 assert.equal(sectionRange(g.measures,SECTIONS,30*44100,{trim}).firstBar,sectionRange(g.measures,SECTIONS,30*44100).firstBar);
});

test('the player bar and the runner agree on where an intro loop starts', () => {
 const g=lead();
 assert.equal(sectionLoopRange(SECTIONS[0],g.measures,{musicStart:barOneStart(g.measures)}).start,6);
});

const looped=()=>{const s=new Sim({performance:newPerformance({songId:'s',id:'p'}),g:lead(),sections:SECTIONS});s.runSeconds(30);return s;};
// the loop is "in force" once the barline it waits for has gone by; a press before that only takes the first press back
const settle=s=>s.runSeconds(5);

test('R then R while paused turns the loop off at once, and its band goes', () => {
 const s=looped();
 assert.equal(s.runner.pressLoop('section').type,'activate');settle(s);
 assert.ok(s.runner.loopShown(),'on');assert.equal(s.runner.pendingText(),null,'in force, nothing pending');
 s.runner.pause();assert.equal(s.runner.status,'paused');
 s.runner.pressLoop('section');
 assert.equal(s.runner.loopShown(),null,'off: nothing is left showing');
 assert.equal(s.runner.snapshot().loop,null);
 assert.equal(s.runner.pendingText(),null,'and nothing is waiting for a pass that will not come');
});

test('while paused the Loop button can be pressed on, off, on, off', () => {
 const s=looped();s.runner.pause();
 for(let i=0;i<2;i++){
  s.runner.pressLoop('section');assert.ok(s.runner.loopShown(),'on #'+i);
  s.runner.pressLoop('section');assert.equal(s.runner.loopShown(),null,'off #'+i);   // a second press straight away takes the first back
 }
});

test('playing, the same key still leaves after this pass (nothing changes for a loop that is going round)', () => {
 const s=looped();
 s.runner.pressLoop('section');settle(s);
 const r=s.runner.pressLoop('section');
 assert.equal(r.type,'exit');
 assert.ok(s.runner.loopShown(),'still going round until the pass ends');
 assert.equal(s.runner.loopShown().left,1);
});

test('pressing exit while paused also ends the loop at once, and music resumes as if never looped', () => {
 const s=looped();s.runner.pressLoop('section');settle(s);s.runner.pause();
 s.runner.pressExit();assert.equal(s.runner.loopShown(),null);
 s.runner.resume();s.runSeconds(40);
 assert.equal(s.runner.loopShown(),null);
 const spans=s.sections();
 assert.equal(spans.length,1,'one unbroken stretch: it never went back');
 assert.ok(spans[0][1]>60,'the song went on past where the loop ended (60 s)');
});

test('the Prepare page draws a loop-section flag over the same bars the show will play (from bar 1)', async () => {
 const {loopFlagsToLoops}=await import('../chordbuddy/web/performance-prepare.js');
 const {address}=await import('../chordbuddy/web/performance-model.js');
 const {addressPosition}=await import('../chordbuddy/web/performance-compiler.js');
 const g=lead(),pos=addressPosition(g.measures),seconds=a=>pos(a)/44100;
 const flag=[{id:'f',at:address('m5'),action:{type:'command',command:'loop-section'}}];
 const planned=trim=>loopFlagsToLoops({...newPerformance({songId:'s',id:'p'}),cues:flag},g.measures,SECTIONS,seconds,trim).performance.regions[0];
 assert.equal(seconds(planned(sectionTrim(g.measures,{})).start),6,'trimmed: bar 1');
 assert.equal(seconds(planned(null).start),0,'untrimmed: the lead-in too (what the page used to draw)');
});
