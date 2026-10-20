import test from 'node:test';
import assert from 'node:assert/strict';
import {pitchSpan,tickStep,trackName,pitchLabel,clampView,initialView,zoomAt,followStart,noteShape} from '../chordbuddy/web/midi-view.js';

test('pitch names count middle C as C4',()=>{assert.equal(pitchLabel(60),'C4');assert.equal(pitchLabel(69),'A4');assert.equal(pitchLabel(61),'C#4');assert.equal(pitchLabel(0),'C-1');});

test('the pitch range is the notes plus a little air, and never less than an octave',()=>{
  assert.deepEqual(pitchSpan([{pitch:60},{pitch:72}]),{low:59,high:73});
  const narrow=pitchSpan([{pitch:64},{pitch:66}]);assert.ok(narrow.high-narrow.low>=11);assert.ok(narrow.low<=64&&narrow.high>=66);
  assert.deepEqual(pitchSpan([]),{low:48,high:72});
  const edge=pitchSpan([{pitch:0},{pitch:2}]);assert.equal(edge.low,0);assert.ok(edge.high-edge.low>=11);
  const top=pitchSpan([{pitch:126},{pitch:127}]);assert.equal(top.high,127);assert.ok(top.high-top.low>=11);
});

test('time labels are never crowded',()=>{
  for(const pps of [12,24,56,120,240])assert.ok(tickStep(pps)*pps>=70);
  assert.equal(tickStep(240),.5);assert.ok(tickStep(12)>=10);
});

test('SheetSage track names get their full names',()=>{
  assert.equal(trackName('Ins'),'Instruments');assert.equal(trackName('Vocal'),'Vocal melody');assert.equal(trackName('Chords'),'Chords');
  assert.equal(trackName('Piano'),'Piano');assert.equal(trackName('',2),'Track 3');assert.equal(trackName(undefined,0),'Track 1');
});

const box={width:800,height:400,duration:100,pitchLow:48,pitchHigh:80};    // 32 semitones in the roll, a 100 s song

test('a resize keeps the musical scales: a bigger window shows more music, it does not stretch the notes',()=>{
  const view={start:10,pps:80,top:76,rowHeight:16};
  const wider=clampView(view,{...box,width:1200}),taller=clampView(view,{...box,height:440});
  assert.equal(wider.pps,80);assert.equal(wider.start,10);assert.equal(taller.rowHeight,16);assert.equal(taller.top,76);
});

test('the view cannot zoom out past the whole song or the whole pitch range, nor scroll past the ends',()=>{
  const out=clampView({start:-5,pps:1,top:200,rowHeight:1},box);
  assert.equal(out.pps,8,'at most the whole song across');assert.equal(out.start,0);
  assert.equal(out.rowHeight,400/32,'at most every pitch top to bottom');assert.equal(out.top,80);
  const end=clampView({start:99,pps:80,top:76,rowHeight:14},box);assert.equal(end.start,100-800/80,'the last screenful ends with the song');
  const low=clampView({start:0,pps:80,top:40,rowHeight:20},box);assert.equal(low.top,48+400/20,'the bottom row is the lowest pitch');
  const window=clampView({start:0,pps:8,top:80,rowHeight:12.5},{...box,height:600});assert.equal(window.rowHeight,600/32,'a taller window than the music fills up rather than leaving a gap');
});

test('a song opened for the first time shows a readable stretch of notes, not the whole song squeezed in',()=>{
  const notes=[{start:4,pitch:60},{start:5,pitch:64},{start:90,pitch:67}];
  const first=initialView({...box,notes,barSeconds:2});
  assert.ok(first.pps>box.width/box.duration*3,'much closer than fitting the song');
  assert.ok(Math.abs(800/first.pps-14)<1e-9,'about seven bars across');
  assert.ok(first.start<=4&&first.start>=3,'starting just before the first note');
  assert.ok(first.rowHeight>=11,'rows tall enough to read');
  const middle=first.top-400/first.rowHeight/2;assert.ok(Math.abs(middle-(191/3+.5))<1e-6||first.top===80,'centred on the notes');
});

test('Ctrl+wheel zoom keeps the music under the pointer where it is, on either axis',()=>{
  const view={start:10,pps:50,top:76,rowHeight:12};
  const t=zoomAt(view,'time',2,200);assert.equal(t.pps,100);assert.equal(t.start+200/t.pps,view.start+200/view.pps);
  const p=zoomAt(view,'pitch',.5,120);assert.equal(p.rowHeight,6);assert.equal(p.top-120/p.rowHeight,view.top-120/view.rowHeight);
  assert.equal(t.rowHeight,12,'zooming time leaves pitch alone');assert.equal(p.pps,50,'and the other way round');
});

test('the roll follows the playhead only when it leaves the view',()=>{
  const view={start:20,pps:20,top:76,rowHeight:12};                   // 800px at 20 px/s = 40 s in view
  assert.equal(followStart(view,30,800,100),null);
  assert.ok(followStart(view,58,800,100)>20,'just before the right edge it moves on');
  assert.ok(followStart(view,5,800,100)<5);
  assert.equal(followStart({...view,start:60},99,800,100),null,'at the end of the song there is nowhere further to go');
});

test('notes: an inset outline when there is room for one, a plain fill when there is not, so dense music stays readable',()=>{
  const big=noteShape(100,40,30,14);
  assert.ok(big.outlined);assert.ok(big.x>100&&big.x+big.width<130,'the outline sits inside the note');assert.ok(big.y>40&&big.y+big.height<54);
  const thin=noteShape(100,40,4,14),short=noteShape(100,40,30,5);
  assert.ok(!thin.outlined&&!short.outlined,'too small for an outline');assert.ok(thin.width>=1.5&&thin.width<4,'a hairline gap between neighbours');
  assert.ok(noteShape(0,0,.2,2).width>=1.5,'even the tiniest note is still drawn');
});

import {beatGrid} from '../chordbuddy/web/midi-view.js';
test('the piano roll grid follows the measured bars and beats, adding halves and quarters only when there is room',()=>{
  // two bars of 4/4 at 2 s a bar, then a bar of 3/4 that is slower (beats 1 s apart): the grid comes from the data, not a formula
  const bars=[{start:0,end:2,number:1,beats:[0,.5,1,1.5]},{start:2,end:4,number:2,beats:[2,2.5,3,3.5]},{start:4,end:7,number:3,beats:[4,5,6]}];
  const at=(pps,level)=>beatGrid(bars,0,7,pps).filter(l=>l.level===level).map(l=>l.time);
  assert.deepEqual(at(20,'bar'),[0,2,4]);
  assert.deepEqual(at(20,'beat'),[.5,1,1.5,2.5,3,3.5,5,6],'every beat, including the slower ones of the 3/4 bar');
  assert.deepEqual(at(20,'sub'),[],'no room for subdivisions at 10px a beat');
  assert.deepEqual(at(80,'sub').slice(0,3),[.25,.75,1.25],'halves once a beat is 40px wide');
  assert.equal(at(150,'sub').filter(t=>t<.5).length,3,'quarters once a beat is 64px or wider');
  assert.deepEqual(at(8,'beat'),[5,6],'beats closer than 6px are left out (only the slow bar keeps them)');
  assert.deepEqual(beatGrid(bars,2.2,3.8,40).map(l=>l.time),[2.5,3,3.5],'only what is in view');
});
