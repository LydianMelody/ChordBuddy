import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,cleanSettings,cleanParts,songParts,suggestedUse} from '../chordbuddy/web/midi-user.js';
import {songForDrop,rankSongs,customMidi} from '../chordbuddy/web/midi-import.js';
import {writeMidi} from '../chordbuddy/web/midi-file.js';
import {songGrid,placement} from '../chordbuddy/web/midi-align.js';
import {buildScene,sampleFrame} from '../chordbuddy/web/visual-scene.js';

const near=(a,b,eps=1e-3)=>assert.ok(Math.abs(a-b)<=eps,`${a} is not ${b}`);
// A song of 12 bars at ~96 bpm with a slightly uneven drummer, its first beat at 0.83 s.
function measures(bars=12){
  const out=[];let t=0.83;
  for(let b=0;b<bars;b++){const beats=[];for(let i=0;i<4;i++){beats.push(t);t+=0.625+((b*4+i)%3-1)*0.01;}out.push({start:beats[0],end:t,beats});}
  return out;
}

test('a dropped file goes to the open song unless the playhead is within a quarter note of its start or end', ()=>{
  const m=measures(),duration=m.at(-1).end;
  assert.equal(songForDrop({songId:'a',playhead:12,duration,measures:m}),'a');
  assert.equal(songForDrop({songId:'a',playhead:0,duration,measures:m}),null);
  assert.equal(songForDrop({songId:'a',playhead:0.5,duration,measures:m}),null,'still within a quarter note of the start');
  assert.equal(songForDrop({songId:'a',playhead:duration-0.3,duration,measures:m}),null);
  assert.equal(songForDrop({songId:null,playhead:12,duration,measures:m}),null);
});

test('songs are offered most likely first: a similar name, then a similar length', ()=>{
  const songs=[{id:'1',title:'Koi no Highway',duration:200},{id:'2',title:'The Real Thing',duration:300},{id:'3',title:'Another',duration:181}];
  assert.equal(rankSongs(songs,'real thing - bass v3.mid',0)[0].song.id,'2');
  assert.equal(rankSongs(songs,'Untitled.mid',180)[0].song.id,'3');
});

test('a custom file is laid out on the song beats: its notes land exactly where the model put them', ()=>{
  const m=measures(),vocal=[{start:2.1,end:2.5,pitch:64},{start:9.37,end:10,pitch:67,velocity:70},{start:0.2,end:0.6,pitch:60}];
  const file=readFile(customMidi({measures:m,model:{vocal,instrumental:[]},title:'Real Thing'}));
  assert.equal(file.clock.hasTempo,true);
  const grid=songGrid(m),place=placement(grid,file.clock,{mode:'tempo',start:0,ratio:1});
  const source=file.sources.find(s=>s.name==='Vocal melody');
  assert.equal(source.notes.length,3);
  for(const [n,want] of source.notes.map((n,i)=>[n,[...vocal].sort((a,b)=>a.start-b.start)[i]])){near(place.seconds(n.tick),want.start,2e-3);near(place.seconds(n.endTick),want.end,2e-3);}
  // every beat of the song falls on a beat of the file, so a DAW's grid matches the recording
  for(const b of [0,5,17,40])near(file.clock.seconds(file.clock.tick(grid.beats[b])),grid.beats[b],1e-6);
  const lead=file.clock.tick(grid.beats[0]);assert.equal(lead%960,0,'the first beat sits on a whole beat of the file');
  assert.ok(!file.sources.some(s=>s.name==='Your part'),'an empty track offers nothing to wire up');
  assert.equal(suggestedUse(source),'vocal');
});

test('after a new export from the DAW, the parts are the ones the file has now (the manager’s summary uses this)', ()=>{
  const first=readFile(writeMidi({tracks:[{name:'Lead',notes:[{tick:0,endTick:480,pitch:60,velocity:90}]},{name:'Bass',channel:1,notes:[{tick:0,endTick:480,pitch:36,velocity:90}]}]}));
  const [lead,bass]=first.sources.map(s=>s.id),saved={parts:{[lead]:{use:'vocal'},[bass]:{use:'off'}}};
  const note=(pitch,channel)=>({channel,notes:[{tick:0,endTick:480,pitch,velocity:90}]});
  const fewer=cleanParts(saved,readFile(writeMidi({tracks:[{name:'Lead',...note(60,0)}]})));
  assert.deepEqual(fewer,{[lead]:{use:'vocal'}},'the dropped Bass is gone; the Lead keeps its use');
  const more=readFile(writeMidi({tracks:[{name:'Lead',...note(60,0)},{name:'Bass',...note(36,1)},{name:'Keys',...note(64,2)}]}));
  const keys=more.sources.find(s=>s.name==='Keys').id;
  assert.deepEqual(cleanParts(saved,more),{[lead]:{use:'vocal'},[bass]:{use:'off'},[keys]:{use:'extra'}},'a new Keys part is an extra');
});

test('settings give every part a use, and only one part replaces each melody', ()=>{
  const bytes=writeMidi({tracks:[{name:'Lead',notes:[{tick:0,endTick:480,pitch:60,velocity:90}]},{name:'Lead 2',channel:1,notes:[{tick:0,endTick:480,pitch:62,velocity:90}]},
    {name:'Pedal',channel:2,notes:[],controls:{cc64:[{tick:0,value:1},{tick:960,value:0}]}}]});
  const file=readFile(bytes),grid=songGrid(measures());
  const ids=file.sources.map(s=>s.id);
  const s=cleanSettings({parts:{[ids[0]]:{use:'vocal'},[ids[1]]:{use:'vocal'},[ids[2]]:{use:'instrumental'}}},file,{grid,duration:30});
  assert.deepEqual(ids.map(id=>s.parts[id].use),['vocal','extra','extra'],'the second claim and a part with no notes become extras');
  assert.equal(s.alignment.mode,'tempo','a file with its own tempo that fits starts from its tempo');
});

test('the visualizer gets replaced melodies with real dynamics and typed extras', ()=>{
  const m=measures(),grid=songGrid(m);
  const bytes=writeMidi({ticksPerQuarter:960,tempos:[{tick:0,usPerQuarter:500000}],tracks:[
    {name:'Vox',notes:[{tick:960,endTick:1920,pitch:64,velocity:40},{tick:1920,endTick:2880,pitch:65,velocity:120}]},
    {name:'Keys',channel:1,notes:[{tick:0,endTick:3840,pitch:48,velocity:80}],controls:{cc64:[{tick:0,value:1},{tick:1920,value:0}],cc1:[{tick:960,value:0.5}]}}]});
  const file=readFile(bytes),[vox,keys]=file.sources;
  const settings={alignment:{mode:'beats',start:4,ratio:1},parts:{[vox.id]:{use:'vocal'},[keys.id]:{use:'extra'}}};
  const parts=songParts([{id:'abc123abc123',name:'take.mid',file,settings}],m,{duration:m.at(-1).end});
  assert.equal(parts.replace.vocal.length,2);near(parts.replace.vocal[0].start,grid.beats[5],1e-9);
  assert.equal(parts.extras.length,1);assert.equal(parts.extras[0].name,'Keys');
  assert.deepEqual(parts.extras[0].signals.map(s=>s.key),['notes','hits','cc1','cc64']);
  const scene=buildScene({content:{duration:m.at(-1).end},music:{measures:m},midi:{vocal:parts.replace.vocal},user:['vocal'],extras:parts.extras});
  const quiet=sampleFrame(scene,grid.beats[5]+0.1),loud=sampleFrame(scene,grid.beats[6]+0.1);
  near(quiet.notes.vocal.active[0].strength,40/127);near(loud.notes.vocal.active[0].strength,120/127);
  const keysAt=t=>sampleFrame(scene,t).midi.Keys;
  assert.equal(keysAt(grid.beats[4]+0.1).values.cc64,true);assert.equal(keysAt(grid.beats[6]+0.1).values.cc64,false);
  assert.equal(keysAt(grid.beats[4]+0.1).values.cc1,0);near(keysAt(grid.beats[5]+0.1).values.cc1,0.5,0.01);
  assert.equal(keysAt(grid.beats[4]+0.05).active.length,1);assert.ok(keysAt(grid.beats[4]+0.05).pulse>0.4);
  assert.deepEqual(sampleFrame(buildScene({music:{measures:m}}),3).midi,{},'no files, no extras');
});

test('in the combined melody your notes keep their dynamics and the model notes are measured as before', ()=>{
  const m=measures(),fps=10,frames=400,level=new Uint8Array(frames).fill(60);for(let i=50;i<60;i++)level[i]=250;
  const b64=a=>Buffer.from(a).toString('base64'),track=()=>({level:b64(level),bands:b64(new Uint8Array(frames*8)),brightness:b64(new Uint8Array(frames)),flux:b64(new Uint8Array(frames)),hits:[]});
  const features={fps,frames,floor_db:-60,band_edges_hz:[],tracks:{vocals:track(),lead:track()}};
  const model=[{start:5.0,end:5.4,pitch:60,velocity:100},{start:12,end:12.5,pitch:62,velocity:100},{start:20,end:20.5,pitch:64,velocity:100}];
  const mine=[{start:7,end:7.5,pitch:67,velocity:30,mine:true},{start:8,end:8.5,pitch:69,velocity:120,mine:true}];
  const scene=buildScene({music:{measures:m},content:{duration:30},midi:{melody:[...model,...mine]},features});
  const notes=scene.midi.melody.notes;
  near(notes.find(n=>n.pitch===67).strength,30/127);near(notes.find(n=>n.pitch===69).strength,120/127);
  assert.equal(notes.find(n=>n.pitch===60).strength,1,'the loud model note is measured from the stem');
  assert.equal(notes.find(n=>n.pitch===62).strength,0,'the quiet one too');
});
