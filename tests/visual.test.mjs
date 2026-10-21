import test from 'node:test';
import assert from 'node:assert/strict';
import {SceneClock} from '../chordbuddy/web/visual-clock.js';
import {buildScene,sampleFrame,withFeatures,mixGains,STEM_ORDER} from '../chordbuddy/web/visual-scene.js';
import {createVisualPublisher,createVisualReceiver,clockMessage} from '../chordbuddy/web/visual-bridge.js';

// ---- clock ----
const clockAt=()=>{let now=0;const clock=new SceneClock({now:()=>now});return {clock,set:t=>{now=t;}};};

test('the clock runs on between reports at the practice speed and stops when paused', () => {
  const {clock,set}=clockAt();
  clock.report({seconds:10,playing:true,rate:1,duration:100},0);
  set(500);assert.equal(clock.time(),10.5);
  clock.report({seconds:10.5,playing:true,rate:.5,duration:100},500);
  set(1500);assert.equal(clock.time(),11);                              // half speed: a second of wall time is half a second of song
  clock.report({seconds:11,playing:false,rate:.5,duration:100},1500);
  set(5000);assert.equal(clock.time(),11);
});

test('small report jitter is eased out instead of jumping, and a seek is followed at once', () => {
  const {clock,set}=clockAt();
  clock.report({seconds:0,playing:true,rate:1,duration:100},0);
  clock.report({seconds:1.04,playing:true,rate:1,duration:100},1000);   // 40 ms ahead of the clock's own estimate
  assert.ok(Math.abs(clock.time(1000)-1)<1e-9);                        // no jump on the frame the report lands
  assert.ok(Math.abs(clock.time(2000)-2.04)<1e-3);                      // eased in within a second
  clock.report({seconds:50,playing:true,rate:1,duration:100},2000);     // a seek
  assert.equal(clock.time(2000),50);
});

test('the clock wraps at the loop end and never runs past the song', () => {
  const {clock}=clockAt();
  clock.report({seconds:9.9,playing:true,rate:1,duration:100,loop:{enabled:true,start:8,end:10}},0);
  assert.ok(Math.abs(clock.time(300)-8.2)<1e-9);
  clock.report({seconds:99.9,playing:true,rate:1,duration:100},0);
  assert.equal(clock.time(1000),100);
});

// ---- scene ----
const content={duration:16,chords:[{id:'a',label:'N',start:0,end:1},{id:'b',label:'C',start:1,end:5},{id:'c',label:'Am',start:5,end:9},{id:'d',label:'F',start:9,end:13},{id:'e',label:'G',start:13,end:16}],
  sections:[{id:'s1',name:'Verse',start:1,end:9},{id:'s2',name:'Chorus',start:9,end:16}]};
const bar=(id,start)=>({id,start,end:start+4,beats:[start,start+1,start+2,start+3]});
const music={measures:[bar('m0',-3),bar('m1',1),bar('m2',5),bar('m3',9),bar('m4',13)].map(m=>m.start<0?{...m,start:0,end:1,beats:[0]}:m)};

test('a frame names the chord, the next ones, the beat and the section', () => {
  const scene=buildScene({content,music,title:'Song'});
  const f=sampleFrame(scene,6.5);
  assert.equal(f.chord.label,'Am');assert.equal(f.chord.next.label,'F');assert.equal(f.chord.timeToNext,2.5);
  assert.deepEqual(f.chord.upcoming.map(c=>c.label),['F','G']);
  assert.equal(f.beat.bar,2);assert.equal(f.beat.beat,2);assert.equal(f.beat.phase,.5);assert.equal(f.beat.bpm,60);
  assert.equal(f.section.name,'Verse');assert.equal(f.section.next.name,'Chorus');
  assert.equal(sampleFrame(scene,.5).chord.label,null);                 // leading silence: no chord, but the first one is next
  assert.equal(sampleFrame(scene,.5).chord.next.label,'C');
});

test('MIDI notes sounding at a moment are listed, with the next one', () => {
  const scene=buildScene({content,music,midi:{vocal:[{start:2,end:3,pitch:60},{start:2.5,end:6,pitch:64},{start:7,end:8,pitch:67}]}});
  const f=sampleFrame(scene,2.75);
  assert.deepEqual(f.notes.vocal.active.map(n=>n.pitch).sort(),[60,64]);
  assert.equal(f.notes.vocal.next.pitch,67);
  assert.deepEqual(sampleFrame(scene,6.5).notes.vocal.active,[]);
});

const b64=bytes=>Buffer.from(Uint8Array.from(bytes)).toString('base64');
function featuresFor(frames){
  const track=(level)=>({level:b64(Array(frames).fill(level)),bands:b64(Array(frames*8).fill(level)),brightness:b64(Array(frames).fill(128)),flux:b64(Array(frames).fill(0)),hits:[[1,1]],peak_db:-6});
  return {fps:100,frames,floor_db:-60,band_edges_hz:[],tracks:Object.fromEntries(['original',...STEM_ORDER].map(r=>[r,track(204)]))};
}

test('stem values follow the mixer: muted and un-soloed stems go quiet, a fader lowers the level', () => {
  const scene=withFeatures(buildScene({content,music}),featuresFor(1600));
  const mix={gains:[1,1,1,.5,1,1,1],mutes:[false,true,false,false,false,false,false],solos:Array(7).fill(false),master:1};
  const f=sampleFrame(scene,1.05,{mix});
  assert.equal(f.tracks.drums.level,0);
  assert.ok(Math.abs(f.tracks.bass.level-204/255)<1e-9);
  assert.ok(Math.abs(f.tracks.vocals.level-(204/255+20*Math.log10(.5)/60))<1e-9);   // -6 dB
  assert.ok(f.tracks.bass.pulse>.6&&f.tracks.bass.pulse<1&&Math.abs(f.tracks.bass.sinceHit-.05)<1e-9);
  const solo=mixGains({...mix,solos:[false,false,false,false,true,false,false]});
  assert.deepEqual(STEM_ORDER.map(r=>solo[r]>0),[false,false,false,false,true,false,false]);
});

// ---- bridge ----
function fakeChannels(){
  const all=[];
  const open=()=>{const ch={onmessage:null,postMessage(data){for(const other of all)if(other!==ch&&other.onmessage)other.onmessage({data:structuredClone(data)});},close(){all.splice(all.indexOf(ch),1);}};all.push(ch);return ch;};
  return open;
}

test('a visualizer that opens late is given the current song and position', () => {
  const open=fakeChannels(),publisher=createVisualPublisher({open});
  publisher.scene({songId:'s',runId:'r',title:'T',key:'C major',revision:'1:0',midiDocs:[]});
  publisher.clock({songId:'s',seconds:12,playing:true,rate:50,duration:100,loop:null,mix:null,ready:true});
  const scenes=[],clocks=[];
  createVisualReceiver({open,onScene:m=>scenes.push(m),onClock:m=>clocks.push(m)});
  assert.equal(scenes.length,1);assert.equal(scenes[0].runId,'r');
  assert.equal(clocks.length,1);assert.equal(clocks[0].seconds,12);assert.equal(clocks[0].rate,.5);
  publisher.scene({songId:'s',runId:'r',title:'T',key:'C major',revision:'1:0',midiDocs:[]});
  assert.equal(scenes.length,1);                                         // unchanged scenes are not sent again
  publisher.clock({songId:'s',seconds:13,playing:true,rate:100,duration:100});
  assert.equal(clocks.at(-1).seconds,13);
  assert.equal(clockMessage({seconds:1,rate:100}).rate,1);
});
