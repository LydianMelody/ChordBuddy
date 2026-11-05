import test from 'node:test';
import assert from 'node:assert/strict';
import {songGrid,beatSeconds,secondsBeat,barBeat,beatBar,placement,cleanAlignment,moveTo,rescale,switchMode,addAnchor,removeAnchor,
  defaultRatio,defaultAlignment,grainFor,snapSeconds,placeNotes,placePoints,guessReferences,guessAlignment} from '../chordbuddy/web/midi-align.js';

const near=(a,b,eps=1e-6)=>assert.ok(Math.abs(a-b)<=eps,`${a} is not ${b}`);
// A song at 100 bpm (0.6 s beats) in 4/4, its first bar at 1.0 s; `wobble` nudges each beat (a live drummer).
function measures(bars=16,{beat=0.6,start=1,perBar=4,wobble=()=>0}={}){
  const out=[];let t=start,n=0;
  for(let b=0;b<bars;b++){const beats=[];for(let i=0;i<perBar;i++){beats.push(t+wobble(n++));t+=beat;}out.push({start:beats[0],end:t+wobble(n),beats});}
  for(let i=0;i<out.length-1;i++)out[i].end=out[i+1].start;
  return out;
}
// A MIDI file's clock at a fixed tempo (no tempo events: 120 bpm), 960 ticks to the quarter.
const file=({bpm=120,hasTempo=false,sig=[4,4]}={})=>({ticksPerQuarter:960,hasTempo,timeSignatures:[{tick:0,numerator:sig[0],denominator:sig[1]}],
  seconds:tick=>tick/960*60/bpm,tick:s=>s*bpm/60*960});

test('the song grid lists every beat and where each bar starts', ()=>{
  const g=songGrid(measures(3));
  assert.equal(g.beats.length,12);assert.deepEqual(g.bars,[0,4,8]);near(g.end,1+12*0.6);
  near(beatSeconds(g,0),1);near(beatSeconds(g,2.5),2.5);near(beatSeconds(g,12),g.end);
  near(beatSeconds(g,-1),0.4,1e-9);near(beatSeconds(g,13),g.end+0.6,1e-9);      // past either end at the nearest beat's length
  for(const b of [-2,0,0.3,5.5,11.9,12,14])near(secondsBeat(g,beatSeconds(g,b)),b,1e-9);
  assert.equal(barBeat(g,1),4);assert.equal(beatBar(g,5.5),1);assert.equal(beatBar(g,-3),0);
});

test('following the beats lays the file quarter notes on the song beats, whatever tempo the file says', ()=>{
  const g=songGrid(measures(8,{wobble:n=>n%2?0.03:-0.02})),f=file();     // the file says 120; the song is ~100 and loose
  const p=placement(g,f,{mode:'beats',start:4,ratio:1});
  for(const q of [0,1,2,7,13])near(p.seconds(q*960),g.beats[4+q]);
  near(p.seconds(480),(g.beats[4]+g.beats[5])/2);                         // an eighth note: halfway between the beats
  near(p.tick(g.beats[9]),5*960,1e-6);
});

test('using the file tempo places it by its own seconds', ()=>{
  const g=songGrid(measures(8)),p=placement(g,file({bpm:90}),{mode:'tempo',start:1.5,ratio:1});
  near(p.seconds(960),1.5+60/90);near(p.tick(1.5+2*60/90),1920,1e-6);
});

test('one anchor moves the whole file, two stretch it between them (and beyond at the same rate)', ()=>{
  const g=songGrid(measures(16)),f=file();
  let a=addAnchor({mode:'beats',start:0,ratio:1},960*4,g.beats[10]);
  let p=placement(g,f,a);near(p.seconds(960*4),g.beats[10]);near(p.seconds(960*5),g.beats[11]);near(p.seconds(0),g.beats[6]);
  a=addAnchor(a,960*12,g.beats[26]);                                       // 8 file beats now span 16 song beats: half time
  p=placement(g,f,a);near(p.seconds(960*8),g.beats[18]);near(p.seconds(960*13),g.beats[28]);near(p.seconds(960*3),g.beats[8]);
  for(const t of [g.beats[3],g.beats[20],g.beats[40]])near(p.seconds(p.tick(t)),t,1e-6);
  a=removeAnchor(a,960*12);assert.equal(a.anchors.length,1);
  // tempo mode: two anchors fix a file whose tempo was wrong (says 120, played at 100)
  const t=addAnchor(addAnchor({mode:'tempo',start:0,ratio:1},0,2),960*8,2+8*0.6);
  const q=placement(g,f,t);near(q.seconds(960*4),2+4*0.6,1e-9);near(q.seconds(960*16),2+16*0.6,1e-9);
});

test('anchors stay tidy: sorted, one per tick, never folding back in time', ()=>{
  const a=cleanAlignment({mode:'nonsense',ratio:-1,start:NaN,transpose:2.5,anchors:[{tick:960,time:3},{tick:0,time:1},{tick:960,time:4},{tick:1920,time:2},{tick:'x',time:1}]});
  assert.equal(a.mode,'beats');assert.equal(a.ratio,1);assert.equal(a.start,0);assert.equal(a.transpose,0);
  assert.deepEqual(a.anchors,[{tick:0,time:1},{tick:960,time:3}]);
});

test('moving, half/double time and switching mode keep the chosen moment in place', ()=>{
  const g=songGrid(measures(16)),f=file();
  const a={mode:'beats',start:2,ratio:1};
  const moved=moveTo(g,f,a,960,g.beats[9]);near(placement(g,f,moved).seconds(960),g.beats[9]);assert.equal(moved.start,8);
  const half=rescale(g,f,moved,0.5,960);const p=placement(g,f,half);near(p.seconds(960),g.beats[9]);near(p.seconds(960*3),g.beats[10]);
  const tempo=switchMode(g,f,half,'tempo',960);near(placement(g,f,tempo).seconds(960),g.beats[9],1e-9);
  const back=switchMode(g,f,tempo,'beats',960);near(placement(g,f,back).seconds(960),g.beats[9],1e-9);assert.equal(back.ratio,1);
});

test('a file in 6/8 is laid one of its bars to one bar of the song', ()=>{
  const two=songGrid(measures(4,{perBar:2})),six=songGrid(measures(4,{perBar:6}));
  near(defaultRatio(file({sig:[6,8]}),two),2/3);assert.equal(defaultRatio(file({sig:[6,8]}),six),2);assert.equal(defaultRatio(file(),songGrid(measures(4))),1);
});

test('the first placement: a file with its own tempo that fits the recording starts at 0 s; others follow the beats from bar 1', ()=>{
  const g=songGrid(measures(16));
  assert.deepEqual(defaultAlignment(file({hasTempo:true}),g,{duration:40,lastTick:960*60}),cleanAlignment({mode:'tempo',start:0,ratio:1}));
  const d=defaultAlignment(file(),g,{duration:40,firstBar:1,lastTick:960*60});assert.equal(d.mode,'beats');assert.equal(d.start,4);
  assert.equal(defaultAlignment(file({hasTempo:true}),g,{duration:10,lastTick:960*60}).mode,'beats','a file much longer than the song is not from this recording');
});

test('snapping follows the zoom and can be turned off', ()=>{
  assert.equal(grainFor(80),'sixteenth');assert.equal(grainFor(40),'eighth');assert.equal(grainFor(20),'beat');assert.equal(grainFor(5),'bar');
  const g=songGrid(measures(4));
  near(snapSeconds(g,1.29,'beat'),1);near(snapSeconds(g,1.31,'beat'),1.6);near(snapSeconds(g,1.31,'eighth'),1.3);
  near(snapSeconds(g,2.0,'bar'),1);near(snapSeconds(g,2.3,'bar'),3.4);near(snapSeconds(g,1.234,'free'),1.234);
});

test('notes and control curves are placed on the song, transposed, without changing the file', ()=>{
  const g=songGrid(measures(8)),f=file(),notes=[{tick:960,endTick:1440,pitch:60,velocity:90},{tick:0,endTick:0,pitch:127,velocity:10}];
  const placed=placeNotes(notes,placement(g,f,{mode:'beats',start:0,ratio:1,transpose:2}));
  assert.equal(placed[0].tick,0);near(placed[1].start,1.6);near(placed[1].end,1.9);assert.equal(placed[1].pitch,62);assert.equal(placed[0].pitch,127);
  assert.ok(placed[0].end>placed[0].start,'a zero-length note still lasts a moment');
  assert.equal(notes[0].pitch,60,'the source notes are untouched');
  assert.deepEqual(placePoints([{tick:1920,value:1}],placement(g,f,{mode:'beats',start:0,ratio:1})).map(p=>[+p.time.toFixed(6),p.value]),[[2.2,1]]);
});

// ---- guessing ----
// A sparse part: a riff in bars 5-6 and again in 11-12 of the song, against a chart of C - F - G - C bars. The file starts at its own bar 1,
// with three empty bars before the riff, and says 120 bpm (no tempo).
function scenario({wobble=()=>0,transposeFile=0}={}){
  const m=measures(16,{wobble}),g=songGrid(m);
  const roots=[0,5,7,0];const chords=m.map((bar,i)=>({start:bar.start,end:bar.end,label:['C','F','G','C'][i%4]}));
  const riff=[[0,0],[1,4],[2,7],[3,4],[4,0],[5,7],[6,12],[7,7]];     // [quarter, semitones above the bar's chord root] over two bars
  const notes=[];
  for(const fileBar of [3,9])for(const [q,iv] of riff){
    const quarter=fileBar*4+q,songBar=fileBar+1+Math.floor(q/4);           // the file's bar 1 sits on the song's bar 2 (start beat 4)
    notes.push({tick:quarter*960,endTick:quarter*960+800,pitch:48+roots[songBar%4]+(iv%12)+transposeFile,velocity:80});
  }
  const truth={mode:'beats',start:4,ratio:1};
  const p=placement(g,file(),truth);
  const onsets=notes.map(n=>p.seconds(n.tick)+0.01);                      // the recording: the same notes, a hair late, plus other stuff
  for(let i=0;i<g.beats.length;i+=3)onsets.push(g.beats[i]+0.3);
  return {g,notes,chords,onsets,truth,duration:m.at(-1).end};
}

test('the guess finds where a sparse part with a wrong tempo belongs', ()=>{
  const s=scenario({wobble:n=>Math.sin(n)*0.02});
  const r=guessAlignment({file:file(),grid:s.g,notes:s.notes,refs:guessReferences({onsets:s.onsets,chords:s.chords}),duration:s.duration});
  const best=r.candidates[0].alignment;
  assert.equal(best.mode,'beats');near(best.start,4,0.13);near(best.ratio,1);
  assert.equal(r.candidates[0].bar,1);assert.notEqual(r.confidence,'low');assert.equal(r.transpose,0);
  assert.ok(r.candidates.length>1,'other good fits are offered too');
});

test('the guess notices a file written in another key', ()=>{
  const s=scenario({transposeFile:3});
  const r=guessAlignment({file:file(),grid:s.g,notes:s.notes,refs:guessReferences({onsets:s.onsets,chords:s.chords}),duration:s.duration});
  near(r.candidates[0].alignment.start,4,0.13);assert.equal(r.transpose,-3);
});

test('the guess uses a file\'s own tempo when it was made over the recording', ()=>{
  const g=songGrid(measures(16)),f=file({bpm:100,hasTempo:true});
  const notes=[0,3,5,8,12,13,20,22,29,31,40].map(q=>({tick:q*960,endTick:q*960+400,pitch:40,velocity:100,drum:true}));
  const onsets=notes.map(n=>f.seconds(n.tick)+0.73);
  const r=guessAlignment({file:f,grid:g,notes,refs:guessReferences({onsets}),duration:g.end});
  const best=r.candidates[0].alignment;
  near(placement(g,f,best).seconds(960*3),f.seconds(960*3)+0.73,0.02);
});

test('nothing to go on gives no guess rather than a wild one', ()=>{
  const g=songGrid(measures(4));
  assert.deepEqual(guessAlignment({file:file(),grid:g,notes:[],refs:guessReferences(),duration:10}),{candidates:[],confidence:'low',transpose:0});
});
