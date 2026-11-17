import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from '../chordbuddy/web/midi-user.js';
import {tempoMapMidi,gridTiming,SMOOTHING,STEADY_SECONDS} from '../chordbuddy/web/tempo-map.js';
import {songGrid} from '../chordbuddy/web/midi-align.js';

// A rubato song: 16 bars of 4/4 that drift from ~60 to ~84 bpm and back, the first beat at 1.2 s.
function rubato(bars=16){
  const out=[];let t=1.2,i=0;
  for(let b=0;b<bars;b++){const beats=[];for(let k=0;k<4;k++,i++){beats.push(t);t+=1-0.28*Math.sin(i/(bars*4)*Math.PI)+((i*7)%5-2)*0.004;}out.push({start:beats[0],end:t,beats});}
  return out;
}
const sections=[{start:1.2,end:20,name:'Verse'},{start:20,end:40,name:'Chorus'}];

// Seconds at a tick, as a DAW would play the tempo changes.
function timeOfTick(tempos,tpq,tick){
  let s=0,at=0,us=500000;
  for(const t of [...tempos].sort((a,b)=>a.tick-b.tick)){if(t.tick>=tick)break;s+=(t.tick-at)/tpq*us/1e6;at=t.tick;us=t.usPerQuarter;}
  return s+(tick-at)/tpq*us/1e6;
}

for(const mode of ['beat','bar','steady']){
  test(`${mode}: every bar line (and for "beat" every beat) lands where the song has it`,()=>{
    const m=rubato(),grid=songGrid(m),t=gridTiming(grid,960,mode);
    const tol=mode==='beat'?2e-3:mode==='bar'?2e-3:STEADY_SECONDS+2e-3;
    grid.beats.forEach((sec,i)=>{
      const got=timeOfTick(t.tempos,960,t.tick0+i*960);
      const isBar=grid.bars.includes(i);
      if(mode==='beat'||isBar||mode==='steady')assert.ok(Math.abs(got-sec)<=tol,`${mode}: beat ${i} is at ${got} not ${sec}`);
    });
    assert.ok(Math.abs(timeOfTick(t.tempos,960,t.endTick)-grid.end)<=tol,'the file ends where the last bar ends');
  });
}

test('fewer tempo changes with more smoothing, and "every bar" has at most one per bar',()=>{
  const grid=songGrid(rubato()),n=m=>gridTiming(grid,960,m).tempos.length;
  assert.ok(n('bar')<=grid.bars.length+1);
  assert.ok(n('steady')<n('beat'),`steady ${n('steady')} vs beat ${n('beat')}`);
});

test('the file has the tempo map, meter, section markers and one long placeholder note spanning all of it',()=>{
  const m=rubato(),bytes=tempoMapMidi({measures:m,sections,title:'Wonderland',smoothing:'bar'}),file=readFile(bytes);
  assert.equal(file.clock.hasTempo,true);
  const text=new TextDecoder('latin1').decode(bytes);
  assert.ok(text.includes('Verse')&&text.includes('Chorus'),'section names are markers');
  assert.ok(text.includes('Wonderland tempo map'));
  const note=file.sources.find(s=>s.notes.length===1)?.notes[0];
  assert.ok(note,'one placeholder note');
  assert.equal(note.tick,0);
  assert.equal(note.endTick,gridTiming(songGrid(m),960,'bar').endTick);
  assert.ok(!new TextDecoder('latin1').decode(tempoMapMidi({measures:m,sections,markers:false})).includes('Chorus'),'markers can be left out');
});

test('a song with no bars says to analyze it first',()=>{
  assert.throws(()=>tempoMapMidi({measures:[]}),/Analyze it first/);
});

test('every smoothing choice has a plain explanation',()=>{
  assert.deepEqual(SMOOTHING.map(s=>s.id),['beat','bar','steady']);
  for(const s of SMOOTHING)assert.ok(s.label&&s.hint.length>30);
});
