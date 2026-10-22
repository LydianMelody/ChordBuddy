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

// ---- lyrics ----
test('lyric words get the chart\'s times: pinned words exactly, the others spread, never-placed lines left out', () => {
  const sections=[{id:'s1',name:'Verse',start:1,end:9,lyrics:'hello there world\n\nnot placed yet'},{id:'s2',name:'Chorus',start:9,end:16,lyrics:''}];
  const layout={lines:[{section_id:'s1',line:0,start_measure:'m1',end_measure:'m1',words:[{offset:0,measure_id:'m1',beat:0},{offset:6,measure_id:'m1',beat:2}]}]};
  const scene=buildScene({content:{...content,sections,layout},music});
  assert.equal(scene.lyrics.lines.length,1);assert.equal(scene.lyrics.unplaced,1);
  assert.deepEqual(scene.lyrics.lines[0].words.map(w=>[w.text,w.start]),[['hello',1],['there',3],['world',4]]);
  const f=sampleFrame(scene,3.5);
  assert.equal(f.lyric.line.text,'hello there world');assert.equal(f.lyric.line.section,'Verse');
  assert.equal(f.lyric.word.text,'there');assert.equal(f.lyric.word.progress,.5);
  assert.deepEqual(f.lyric.words.map(w=>w.state),['sung','now','ahead']);
  const before=sampleFrame(scene,.5);
  assert.equal(before.lyric.line,null);assert.equal(before.lyric.next.text,'hello there world');assert.equal(before.lyric.next.in,.5);
  assert.equal(sampleFrame(scene,6).lyric.line,null);                    // the line is over (the last word is held 1 s, to the end of the bar)
});

test('with the melody guess on, unpinned words land on vocal notes, as on the chart', () => {
  const sections=[{id:'s1',name:'Verse',start:1,end:9,lyrics:'one two three'}];
  const layout={lines:[{section_id:'s1',line:0,start_measure:'m1',end_measure:'m2',words:[{offset:0,measure_id:'m1',beat:0}]}]};
  const vocal=[{start:2.6,end:3,pitch:60},{start:6.2,end:7,pitch:62}];
  const even=buildScene({content:{...content,sections,layout},music,midi:{vocal}});
  const guessed=buildScene({content:{...content,sections,layout},music,midi:{vocal},lyricGuess:true});
  assert.deepEqual(even.lyrics.lines[0].words.map(w=>w.start),[1,1+8/3,1+16/3]);
  assert.deepEqual(guessed.lyrics.lines[0].words.map(w=>w.start),[1,2.6,6.2]);
});

test('a visualizer opened while nothing is playing still gets the song straight away', () => {
  const open=fakeChannels();let calls=0;
  const publisher=createVisualPublisher({open,onListen:()=>{calls++;publisher.scene({songId:'s',runId:null,title:'T',key:null,revision:'1:0',midiDocs:[]});}});
  const scenes=[];
  createVisualReceiver({open,onScene:m=>scenes.push(m),onClock:()=>{}});
  assert.equal(calls,1);assert.equal(scenes.length,1);assert.equal(scenes[0].songId,'s');
  createVisualReceiver({open,onScene:m=>scenes.push(m),onClock:()=>{}});    // a second window: answered with the same scene
  assert.equal(scenes.filter(s=>s.songId==='s').length,3);               // the first window hears the answer to the second too
});

test('a chord held over a barline counts as one chord, so the next chord is always a change', () => {
  const held={...content,chords:[{id:'a',label:'C',start:1,end:5},{id:'b',label:'C',start:5,end:9},{id:'c',label:'F',start:9,end:13}]};
  const f=sampleFrame(buildScene({content:held,music}),3);
  assert.equal(f.chord.label,'C');assert.equal(f.chord.end,9);assert.equal(f.chord.next.label,'F');assert.equal(f.chord.progress,.25);
});

// ---- scenes' shared pieces ----
import {chordColor} from '../chordbuddy/web/visual-color.js';
import {frameEvents} from '../chordbuddy/web/visualizer-view.js';

test('chord colours follow the circle of fifths, and minor chords are marked', () => {
  assert.equal(chordColor('C').hue,0);assert.equal(chordColor('G7').hue,30);assert.equal(chordColor('F').hue,330);
  assert.equal(chordColor('Gb').root,chordColor('F#maj7').root);
  assert.ok(chordColor('Am7').minor&&!chordColor('Amaj7').minor&&chordColor('Bdim').minor);
  assert.equal(chordColor(null).root,null);
});

test('frame events report new hits and beats while playing, and nothing across a seek', () => {
  const song=withFeatures(buildScene({content,music}),featuresFor(1600));
  song.features.tracks.drums.hits=[{start:1,strength:.5},{start:1.01,strength:.9},{start:3,strength:1}];
  const at=t=>sampleFrame(song,t);
  const e=frameEvents(at(.99),at(1.02),song);
  assert.deepEqual(e.hits.drums,[.5,.9]);
  assert.equal(frameEvents(at(1.5),at(3.2),song).hits.drums,undefined);   // a jump: no burst of skipped hits
  assert.deepEqual(frameEvents(at(1.9),at(2.05),song).beat,{bar:1,beat:2,downbeat:false});
  assert.ok(frameEvents(at(4.9),at(5.05),song).chordChanged);
  assert.deepEqual(frameEvents(at(2),at(2),song).hits,{});                // paused
});

test('a visualizer\'s mixer drawer changes the player\'s mix over the bridge', () => {
  const open=fakeChannels(),mixes=[];
  createVisualPublisher({open,onMix:mix=>mixes.push(mix)});
  const receiver=createVisualReceiver({open,onScene:()=>{},onClock:()=>{}});
  const mix={gains:[1,1,1,.5,1,1,1],mutes:Array(7).fill(false),solos:Array(7).fill(false),master:.8};
  receiver.setMix(mix);
  assert.deepEqual(mixes,[mix]);
});

// ---- the visualizations folder ----
import {loadVisualizations} from '../chordbuddy/web/visualizer-view.js';
import {readdirSync} from 'node:fs';

test('visualizations load from the folder: sorted, and a broken file is reported without stopping the others', async () => {
  const modules={
    'b.js':{default:{id:'b',name:'Bee',order:20,create(){}}},
    'a.js':{default:{id:'a',name:'Ay',order:10,create(){}}},
    'nodefault.js':{},
    'twin.js':{default:{id:'a',name:'Twin',create(){}}},
    'late.js':{default:{id:'late',name:'Late',create(){}}},
  };
  const {scenes,failed}=await loadVisualizations({list:async()=>['b.js','boom.js','a.js','nodefault.js','twin.js','late.js'],
    load:async file=>{if(file==='boom.js')throw new SyntaxError('Unexpected token');return modules[file];}});
  assert.deepEqual(scenes.map(s=>s.id),['a','b','late']);                // by order, then name; no order counts as 100
  assert.deepEqual(failed.map(f=>f.file),['boom.js','nodefault.js','twin.js']);
  assert.match(failed[0].error,/Unexpected token/);assert.match(failed[2].error,/already uses the id "a"/);
});

test('every file in the visualizations folder is a valid visualization (templates included)', async () => {
  const folder=new URL('../chordbuddy/web/visualizations/',import.meta.url),ids=new Set();
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.js'))){
    const scene=(await import(new URL(file,folder))).default;
    assert.ok(scene&&typeof scene.id==='string'&&typeof scene.name==='string'&&typeof scene.create==='function',file);
    assert.ok(!ids.has(scene.id),`${file}: duplicate id ${scene.id}`);ids.add(scene.id);
  }
  assert.ok(['cozy','runner','abstract','diagnostic'].every(id=>ids.has(id)));
});
