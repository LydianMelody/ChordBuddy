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

test('without split stems, every stem is stood in for by its part of the whole mix and follows the master level only', () => {
  const frames=200,bands=[];for(let i=0;i<frames;i++)bands.push(240,240,60,60,60,60,60,60);   // a bass-heavy mix
  const mix={level:b64(Array(frames).fill(230)),bands:b64(bands),brightness:b64(Array(frames).fill(40)),flux:b64(Array(frames).fill(9)),hits:[[1,1]],peak_db:-3};
  const scene=withFeatures(buildScene({content,music}),{fps:100,frames,floor_db:-60,band_edges_hz:[],tracks:{original:mix}});
  const muted={gains:Array(7).fill(1),mutes:Array(7).fill(true),solos:Array(7).fill(false),master:1};
  const f=sampleFrame(scene,1.05,{mix:muted});
  assert.equal(f.stems,false);
  assert.deepEqual(Object.keys(f.tracks).sort(),['original',...STEM_ORDER].sort());
  assert.ok(f.tracks.bass.level>.85&&f.tracks.bass.level<=230/255);       // nearly all of the mix is bass
  assert.ok(f.tracks.vocals.level<f.tracks.bass.level-.2);               // little sits in the vocal range
  assert.ok(f.tracks.vocals.bands[0]<f.tracks.bass.bands[0]);            // outside its range, turned down
  assert.ok(f.tracks.drums.pulse>0&&f.tracks.drums.level>0);             // stem mutes do nothing: the recording is what plays
  assert.equal(sampleFrame(scene,1.05,{mix:{...muted,master:0}}).tracks.drums.level,0);
  const split=withFeatures(buildScene({content,music}),featuresFor(1600));
  assert.equal(sampleFrame(split,1).stems,true);
  assert.equal(sampleFrame(buildScene({content,music}),1).stems,false);   // still loading: no tracks at all
  assert.deepEqual(sampleFrame(buildScene({content,music}),1).tracks,{});
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

test('the loop reaches a visual: its kind, progress, bars and which time around, with events when it starts, wraps and ends', () => {
  const song=buildScene({content,music}),[b1,b2,b3]=song.bars,loop={start:b2.start,end:b3.end,kind:'bars'};
  const at=(t,l=loop,playing=true)=>sampleFrame(song,t,{playing,loop:l});
  const first=at(b2.start+.1);
  assert.equal(first.loop.kind,'bars');assert.equal(first.loop.bars,2);assert.equal(first.loop.bar,1);assert.ok(first.loop.inside);
  assert.equal(at(b3.start+.1).loop.bar,2);assert.ok(Math.abs(at((b2.start+b3.end)/2).loop.progress-.5)<1e-9);
  assert.equal(at(b1.start+.1).loop.bar,null,'before the loop: no bar of it');assert.equal(sampleFrame(song,1).loop,null);
  const started=frameEvents(at(b2.start,null),first,song);assert.deepEqual(started.loop,{started:true,ended:false,wrapped:false});
  const end=at(b3.end-.02);frameEvents(first,end,song);
  const back=at(b2.start+.01),wrap=frameEvents(end,back,song);
  assert.ok(wrap.loop.wrapped);assert.equal(back.loop.pass,2,'second time around');assert.equal(wrap.beat,null,'a wrap is still a jump for beats and hits');
  const on=at(b2.start+.05);frameEvents(back,on,song);assert.equal(on.loop.pass,2,'the pass carries on');
  const seek=at(b2.start+.02);assert.ok(!frameEvents(at(b3.start,loop),seek,song).loop.wrapped,'a jump back from the middle is a seek, not a wrap');
  const slow=at(b2.start+.5);assert.ok(frameEvents(at(b3.end-.6),slow,song).loop.wrapped,'a slow window (a second between frames) still sees the wrap');
  assert.deepEqual(frameEvents(on,at(b2.start+.1,null),song).loop,{started:false,ended:true,wrapped:false});
});

test('the clock keeps the loop\'s kind: R and L by name, a loop placed with the handles as custom', () => {
  const {clock}=clockAt();
  clock.report({seconds:1,playing:true,duration:100,loop:{enabled:true,start:0,end:4,implicit:true,kind:'section'}},0);assert.equal(clock.loop.kind,'section');
  clock.report({seconds:1,playing:true,duration:100,loop:{enabled:true,start:0,end:4,implicit:false}},0);assert.equal(clock.loop.kind,'custom');
  clock.report({seconds:1,playing:true,duration:100,loop:{enabled:false,start:0,end:4}},0);assert.equal(clock.loop,null);
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

test('a changed file is loaded at a new address, so the browser does not hand back the old one', async () => {
  const asked=[];
  const {scenes}=await loadVisualizations({list:async()=>[{file:'a.js',version:'17-2f'}],
    load:async(file,version)=>{asked.push([file,version]);return {default:{id:'a',name:'Ay',create(){}}};}});
  assert.deepEqual(asked,[['a.js','17-2f']]);assert.equal(scenes[0].version,'17-2f');
});

test('My Visuals load from their own folder, and one with a built-in id takes its place', async () => {
  const asked=[],modules={'abstract.js':{default:{id:'abstract',name:'Abstract',create(){}}},'mine.js':{default:{id:'abstract',name:'My Abstract',create(){}}},
    'glow.js':{default:{id:'glow',name:'Glow',create(){}}},'twin.js':{default:{id:'glow',name:'Glow again',create(){}}}};
  const {scenes,failed}=await loadVisualizations({list:async()=>[{file:'mine.js',mine:true},{file:'glow.js',mine:true},{file:'twin.js',mine:true},{file:'abstract.js',mine:false}],
    load:async(file,version,mine)=>{asked.push([file,mine]);return modules[file];}});
  assert.deepEqual(scenes.map(s=>[s.name,s.mine]),[['Glow',true],['My Abstract',true]],'the built-in Abstract is left out, quietly');
  assert.deepEqual(failed.map(f=>f.file),['twin.js'],'two of your own with one id: the second is reported');
  assert.deepEqual(asked.find(a=>a[0]==='abstract.js'),['abstract.js',false]);
});

test('every file in the visualizations folder is a valid visualization (templates included)', async () => {
  const folder=new URL('../chordbuddy/web/visualizations/',import.meta.url),ids=new Set();
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.js'))){
    const scene=(await import(new URL(file,folder))).default;
    assert.ok(scene&&typeof scene.id==='string'&&typeof scene.name==='string'&&typeof scene.create==='function',file);
    assert.ok(!ids.has(scene.id),`${file}: duplicate id ${scene.id}`);ids.add(scene.id);
  }
  assert.ok(ids.size>0,'at least one visualization');
});

// ---- note strength and lyric layout ----
import {noteStrengths} from '../chordbuddy/web/visual-scene.js';
import {layoutLyricLine,joinSyllables} from '../chordbuddy/web/visual-hud.js';

test('each note gets a strength from its own stem as it starts (the MIDI itself has no dynamics)', () => {
  const frames=1000,level=new Uint8Array(frames),other=new Uint8Array(frames);
  level.fill(40);level.fill(250,100,110);level.fill(120,300,310);other.fill(200,500,510);   // vocals loud at 1.0 s, medium at 3.0 s; lead at 5.0 s
  const f={fps:100,frames,tracks:{vocals:{level},lead:{level:other}}};
  const note=(start,pitch=60)=>({start,end:start+.2,pitch,velocity:100,strength:1});
  const midi={vocal:{notes:[note(1),note(3),note(7)]},instrumental:{notes:[note(5),note(7)]},melody:{notes:[note(1),note(5)]}};
  const out=noteStrengths(midi,f);
  const v=out.vocal.notes.map(n=>n.strength);
  assert.ok(v[0]>v[1]&&v[1]>v[2]);                                         // loud, medium, quiet
  assert.ok(out.instrumental.notes[0].strength>out.instrumental.notes[1].strength);
  // the melody's sung note is measured on the vocals stem (loud there), its other note on lead (quieter); spread over the track: 1 and 0
  assert.deepEqual(out.melody.notes.map(n=>n.strength),[1,0]);
  assert.equal(out.vocal.notes[0].velocity,100);                            // the file's velocity is kept
  assert.equal(noteStrengths(midi,null),midi);                              // no stem data: unchanged (every strength 1)
});

test('lyric layout joins split syllables, keeps each part\'s state, and wraps a long line into two rows', () => {
  const g={font:'',measureText(text){const px=parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]);return {width:text.length*px*0.5};}};
  const words=[{text:'ex-',state:'sung'},{text:'pected',state:'now'},{text:'to',state:'ahead'}];
  const one=layoutLyricLine(g,words,{maxWidth:1000,size:20});
  assert.equal(one.rows.length,1);assert.deepEqual(one.rows[0].parts.map(p=>[p.text,p.state]),[['ex','sung'],['pected','now'],['to','ahead']]);
  assert.equal(one.rows[0].parts[1].x,one.rows[0].parts[0].width);        // no space inside the word
  const long=Array.from({length:16},(_,i)=>({text:'word'+i,state:'ahead'}));
  const two=layoutLyricLine(g,long,{maxWidth:300,size:20});
  assert.equal(two.rows.length,2);assert.ok(two.rows.every(r=>r.width<=300+1e-6));
  assert.deepEqual(layoutLyricLine(g,[],{maxWidth:300,size:20}).rows,[]);
  assert.equal(joinSyllables('How much can I be ex-pected to tole- rate?'),'How much can I be expected to tolerate?');
});

// ---- harmony helpers ----
import {pitchClass,parseKey,chordTones,noteInChord,scaleDegree,melodicInterval} from '../chordbuddy/web/visual-harmony.js';

test('harmony: what a note means against the chord and the key', () => {
  assert.equal(pitchClass('Bb'),10);assert.equal(pitchClass('F#'),6);assert.deepEqual(parseKey('F minor'),{tonic:5,minor:true});
  assert.deepEqual(chordTones('Fm7').tones,[5,8,0,3]);assert.deepEqual(chordTones('Abmaj7').intervals,[0,4,7,11]);
  assert.equal(chordTones('Bb/D').bass,2);assert.equal(chordTones('Gsus4').quality,'sus4');assert.equal(chordTones('N'),null);
  assert.deepEqual(noteInChord(72,'Eb'),{inChord:false,interval:9,role:'outside'});    // C over Eb: a 6th, not in a plain Eb triad
  assert.equal(noteInChord(70,'Eb').role,'fifth');assert.equal(noteInChord(67,'Eb').role,'third');assert.equal(noteInChord(63,'Eb').role,'root');
  assert.equal(noteInChord(74,'Ebmaj7').role,'seventh');
  assert.deepEqual(scaleDegree(65,'F minor'),{degree:1,inScale:true,step:0});            // F is the tonic of F minor
  assert.equal(scaleDegree(72,'F minor').degree,5);assert.equal(scaleDegree(69,'F minor').inScale,false);   // A natural: chromatic in F minor
  assert.equal(melodicInterval(72,79).name,'5th');assert.ok(melodicInterval(72,79).leap);assert.ok(melodicInterval(72,70).step);
});

test('a playback key pressed in a pop-out visualizer reaches the player', () => {
  const open=fakeChannels(),actions=[];createVisualPublisher({open,onCommand:a=>actions.push(a)});
  const receiver=createVisualReceiver({open,onScene(){},onClock(){}});
  receiver.command({type:'bar',direction:-1});receiver.command({type:'toggle'});
  assert.deepEqual(actions,[{type:'bar',direction:-1},{type:'toggle'}]);
});

// ---- a song's own look, and the usual one ----
import {defaultVisualOptions,readSetup,readUsual,writeSetup,writeUsual,pickScene} from '../chordbuddy/web/visual-setup.js';
test('the Default Visualization menu: your usual look first, then each visualization, and a missing one says so', () => {
  const scenes=[{id:'a',name:'Aurora'},{id:'b',name:'Mine',mine:true}];
  assert.deepEqual(defaultVisualOptions(scenes,null,'a'),[['','My usual look (Aurora)'],['a','Aurora'],['b','Mine (My Visuals)']]);
  assert.equal(defaultVisualOptions(scenes,null,null)[0][1],'My usual look');
  assert.deepEqual(defaultVisualOptions(scenes,{scene:'gone'},'a').at(-1),['gone','gone (file missing, shows your usual look)']);
  assert.equal(defaultVisualOptions(scenes,{scene:'a'},'a').length,3,'a pinned look that exists isn’t listed twice');
});

test('a song\'s pinned look and the usual one are read back safely, and anything odd is ignored', () => {
  assert.deepEqual(readSetup(writeSetup({scene:'starlane'})),{scene:'starlane'});
  for(const bad of ['','{','null','[1]','{"scene":""}','{"scene":"../x"}','{"scene":42}'])assert.equal(readSetup(bad),null,bad);
  assert.equal(writeSetup(null),'');assert.equal(writeSetup({scene:'<b>'}),'');
  assert.deepEqual(readUsual(writeUsual({scene:'machine',lyrics:false,calm:true,extra:1})),{scene:'machine',lyrics:false,calm:true});
  assert.deepEqual(readUsual('{"lyrics":"yes"}'),{},'only real switches');
  assert.ok(writeSetup({scene:'x'.repeat(60)}).length<=200,'fits a saved preference');
});

test('the look shown: picked now, else the song\'s own, else the usual, else the default, skipping any that is not there', () => {
  const scenes=['abstract','machine','starlane'].map(id=>({id}));
  const pick=o=>pickScene(scenes,o)?.id;
  assert.equal(pick({showing:'machine',pinned:{scene:'starlane'},usual:{scene:'abstract'}}),'machine');
  assert.equal(pick({pinned:{scene:'starlane'},usual:{scene:'machine'}}),'starlane');
  assert.equal(pick({pinned:{scene:'deleted'},usual:{scene:'machine'}}),'machine','a pinned file that is gone falls back');
  assert.equal(pick({usual:{scene:'gone'}}),'abstract','then the default');
  assert.equal(pickScene([{id:'only'}],{})?.id,'only');assert.equal(pickScene([],{}),null);
});

test('pins and the usual look travel over the bridge, and a late window is told the song\'s setup', () => {
  const open=fakeChannels(),pins=[],usuals=[];
  const publisher=createVisualPublisher({open,onPin:(id,setup)=>pins.push([id,setup]),onUsual:u=>usuals.push(u)});
  publisher.setup({songId:'s',pinned:{scene:'machine'},usual:{scene:'abstract'}});
  const setups=[];const receiver=createVisualReceiver({open,onScene:()=>{},onClock:()=>{},onSetup:m=>setups.push(m)});
  assert.deepEqual([setups.length,setups[0].pinned,setups[0].usual],[1,{scene:'machine'},{scene:'abstract'}]);
  publisher.setup({songId:'s',pinned:{scene:'machine'},usual:{scene:'abstract'}});assert.equal(setups.length,1,'unchanged: not sent again');
  receiver.pin('s',{scene:'starlane'});receiver.pin('s',null);receiver.usual({scene:'runner',lyrics:true});
  assert.deepEqual(pins,[['s',{scene:'starlane'}],['s',null]]);assert.deepEqual(usuals,[{scene:'runner',lyrics:true}]);
});

test('patches travel over the bridge: a visualizer saves one, and every visualizer is sent the ones in use', () => {
  const open=fakeChannels(),saved=[];
  const publisher=createVisualPublisher({open,onPatch:(songId,visual,patch)=>saved.push([songId,visual,patch])});
  const setups=[];const receiver=createVisualReceiver({open,onScene:()=>{},onClock:()=>{},onSetup:m=>setups.push(m)});
  const patch={cables:[{from:'stem/bass/hit',to:'shockwave'}]};
  receiver.patch(null,'abstract',patch);receiver.patch('s','abstract',null);
  assert.deepEqual(saved,[[null,'abstract',patch],['s','abstract',null]]);
  publisher.setup({songId:'s',patches:{usual:{abstract:patch},song:{}}});
  assert.deepEqual(setups.at(-1).patches,{usual:{abstract:patch},song:{}});
  publisher.setup({songId:'s',patches:{usual:{abstract:patch},song:{abstract:{cables:[]}}}});
  assert.equal(setups.length,2,'a changed patch is sent again');
  publisher.setup({songId:'s'});assert.deepEqual(setups.at(-1).patches,{usual:{},song:{}},'none: an empty set, never missing');
});

// ---- where the picker and the mixer float ----
import {readPlace,placeToPixels,pixelsToPlace,MARGIN} from '../chordbuddy/web/visual-layout.js';
import {panelPlace} from '../chordbuddy/web/visual-setup.js';

test('a panel\'s place is a fraction of its room, so a corner stays a corner at any window size', () => {
  const panel={w:200,h:100};
  assert.deepEqual(placeToPixels({x:0,y:0},{w:1920,h:1080},panel),{left:MARGIN,top:MARGIN});
  assert.deepEqual(placeToPixels({x:1,y:1},{w:1920,h:1080},panel),{left:1920-200-MARGIN,top:1080-100-MARGIN});
  assert.deepEqual(placeToPixels({x:1,y:1},{w:1280,h:720},panel),{left:1280-200-MARGIN,top:720-100-MARGIN},'bottom right at 720p too');
  const back=pixelsToPlace(500,300,{w:1920,h:1080},panel),again=placeToPixels(back,{w:1920,h:1080},panel);
  assert.ok(Math.abs(again.left-500)<2&&Math.abs(again.top-300)<2,'there and back');
  assert.deepEqual(placeToPixels({x:.5,y:.5},{w:150,h:80},panel),{left:MARGIN,top:MARGIN},'a panel bigger than the window sits at the margin');
  assert.deepEqual(readPlace({x:1.7,y:-2}),{x:1,y:0});assert.equal(readPlace({x:'1',y:0}),null);assert.equal(readPlace(null),null);
});

test('setups keep where the panels sit: the song\'s own places, else the usual ones', () => {
  const pinned=readSetup(writeSetup({scene:'machine',picker:{x:1,y:1},mixer:{x:.25,y:0},junk:{x:1,y:1}}));
  assert.deepEqual(pinned,{scene:'machine',picker:{x:1,y:1},mixer:{x:.25,y:0}});
  const usual=readUsual(writeUsual({scene:'abstract',lyrics:true,calm:false,picker:{x:0,y:1},mixer:{x:1,y:0}}));
  assert.deepEqual(panelPlace('picker',{pinned,usual}),{x:1,y:1});
  assert.deepEqual(panelPlace('picker',{pinned:{scene:'x'},usual}),{x:0,y:1},'a pin without places uses the usual ones');
  assert.equal(panelPlace('mixer',{}),null,'nothing saved: the built-in spot');
  assert.ok(writeUsual({scene:'x'.repeat(40),lyrics:false,calm:false,picker:{x:.123,y:.456},mixer:{x:.789,y:.012}}).length<=200,'fits a saved preference');
  assert.equal(readSetup(writeSetup({scene:'x'.repeat(41)})),null,'ids are at most 40 long');
});

// ---- a visualization's skin on the picker and the mixer ----
import {readSkin,contrast} from '../chordbuddy/web/visual-skin.js';
const HEX={'#f4ecdd':[244,236,221],'#2b1e3f':[43,30,63],'#ff9ec4':[255,158,196],'#1a1c24':[26,28,36],'#ffffff':[255,255,255],'#e9e4d6':[233,228,214],
  '#1e1630':[30,22,48],'#3a3a3a':[58,58,58],'#2d4fd8':[45,79,216],'rgba(244,236,221,.5)':[244,236,221,.5]};
const check={isColor:t=>t.toLowerCase() in HEX,isFont:t=>!t.includes('!'),toRGB:t=>HEX[t.toLowerCase()]||null};
const theme={'--page':'#F4ECDD','--ink':'#1A1C24'};

test('a skin restyles the panels through the theme\'s own tokens, within bounds', () => {
  const vars=readSkin({paper:'#F4ECDD',ink:'#2B1E3F',highlight:'#FF9EC4',font:'"Courier Prime", monospace',border:9,shadow:-2,corners:4.3,
    layout:'grid',ink2:'#fff',paper2:'red'},{theme,check});
  assert.deepEqual(vars,{'--page':'#F4ECDD','--ink':'#2B1E3F','--hl':'#FF9EC4','--g':'"Courier Prime", monospace','--bd':'6px','--sh':'0px',
    '--panel-radius':'4.5px','--on-hl':'#1A1C24'},'unknown keys are ignored; sizes are clamped');
  assert.deepEqual(readSkin(null,{theme,check}),{});assert.deepEqual(readSkin('pink',{theme,check}),{});
  assert.deepEqual(readSkin({font:'x;}body{display:none',paper:'nonsense'},{theme,check}),{},'no way out of the property');
});

test('a skin whose words would be hard to read is left out, and words on its highlight stay readable', () => {
  assert.ok(contrast([0,0,0],[255,255,255])>20);
  assert.deepEqual(readSkin({paper:'#3A3A3A',ink:'#1A1C24',border:4},{theme,check}),{},'dark ink on dark paper: the whole skin goes');
  assert.deepEqual(readSkin({paper:'#1E1630'},{theme,check}),{},'checked against the theme\'s ink when only the paper changes');
  assert.deepEqual(readSkin({paper:'rgba(244,236,221,.5)'},{theme,check}),{},'see-through paper: the scene would decide');
  assert.equal(readSkin({highlight:'#2D4FD8'},{theme,check})['--on-hl'],'#FFFFFF','white words on a dark highlight');
});

test('a skin\'s dark part is laid over it in the app\'s dark scheme', () => {
  const skin={paper:'#F4ECDD',ink:'#2B1E3F',border:3,dark:{paper:'#1E1630',ink:'#F4ECDD'}};
  assert.equal(readSkin(skin,{theme,check})['--page'],'#F4ECDD');
  const dark=readSkin(skin,{dark:true,theme:{'--page':'#1E1630','--ink':'#E9E4D6'},check});
  assert.deepEqual(dark,{'--page':'#1E1630','--ink':'#F4ECDD','--bd':'3px'});
});

test('a skin can set itself apart: neon edges, a coloured shadow, a glow, a texture and spaced capitals, from fixed choices only', () => {
  const vars=readSkin({paper:'#1E1630',ink:'#F4ECDD',line:'#FF9EC4',shadowColor:'#2D4FD8',active:'#2D4FD8',glow:40,texture:'scanlines',caps:true,tracking:.5},{theme,check});
  assert.equal(vars['--line'],'#FF9EC4');assert.equal(vars['--shadow-color'],'#2D4FD8');assert.equal(vars['--panel-glow'],'24px');
  assert.equal(vars['--on-active'],'#FFFFFF','white words on a dark pressed button');
  assert.match(vars['--panel-texture'],/^repeating-linear-gradient/);assert.equal(vars['--panel-caps'],'uppercase');assert.equal(vars['--panel-tracking'],'0.3em');
  assert.equal(readSkin({texture:'url(https://example.com/x.png)'},{theme,check})['--panel-texture'],undefined,'only the listed textures');
  assert.equal(readSkin({caps:'yes',tracking:'wide'},{theme,check})['--panel-caps'],undefined);
});

test('a skin\'s own stylesheet is scoped to the panels, and its images come from the visualization\'s folder', async () => {
  const {skinStylesheet,SKIN_SCOPE}=await import('../chordbuddy/web/visual-skin.js');
  const text=skinStylesheet(`.rack{background:url(wood.png),url("./img/brass.webp"),url('/fonts/x.woff2'),url(data:image/png;base64,AA)}`,{base:'/my-visuals/'});
  assert.ok(text.startsWith(SKIN_SCOPE+'{')&&text.trimEnd().endsWith('}'));
  assert.match(text,/url\(\/my-visuals\/wood\.png\)/);assert.match(text,/url\("\/my-visuals\/\.\/img\/brass\.webp"\)/);
  assert.match(text,/url\('\/fonts\/x\.woff2'\)/,'a path from the app root is left alone');assert.match(text,/url\(data:image/);
  assert.equal(skinStylesheet('',{base:'/'}),null);assert.equal(skinStylesheet(42,{base:'/'}),null);
});

import {playerRelay,viewerRelay,joinChannels} from '../chordbuddy/web/visual-bridge.js';
// a stand-in EventSource and fetch for the relay (visual_relay.py on the server)
function fakeRelay(viewers=1){
  const sources=[],posts=[];let release=null;
  class FakeSource{constructor(url){this.url=url;sources.push(this);}close(){this.closed=true;}}
  const fetch=async(url,options)=>{posts.push({url,...options,body:JSON.parse(options.body)});if(release)await new Promise(r=>{release=r;});return {ok:true,json:async()=>({viewers})};};
  return {sources,posts,EventSource:FakeSource,fetch,hold(){release=true;},let(){const r=release;release=null;r?.();}};
}
const tick=()=>new Promise(r=>setTimeout(r,0));

test('the player relays only after a hello from the server, and only the visualizer messages', async()=>{
  const fake=fakeRelay(),channel=playerRelay('tok',fake),heard=[];
  channel.onmessage=e=>heard.push(e.data);
  assert.equal(fake.sources[0].url,'/api/visual-relay/player?token=tok');
  channel.postMessage({type:'clock',seconds:1});await tick();
  assert.equal(fake.posts.length,0,'nobody is listening yet');
  fake.sources[0].onmessage({data:'{"type":"hello"}'});
  assert.deepEqual(heard,[{type:'hello'}]);
  channel.postMessage({type:'scene',songId:'a'});channel.postMessage({type:'mix'});await tick();
  assert.equal(fake.posts[0].url,'/api/visual-relay/send');assert.equal(fake.posts[0].headers['X-ChordBuddy-Token'],'tok');
  assert.deepEqual(fake.posts[0].body.messages,[{type:'scene',songId:'a'}]);
});

test('while one request is out, a newer clock replaces the waiting one; scenes are kept', async()=>{
  const fake=fakeRelay(),channel=playerRelay('tok',fake);
  fake.sources[0].onmessage({data:'{"type":"hello"}'});
  fake.hold();channel.postMessage({type:'clock',seconds:1});await tick();
  channel.postMessage({type:'clock',seconds:2});channel.postMessage({type:'scene',songId:'b'});channel.postMessage({type:'clock',seconds:3});
  fake.let();await tick();await tick();await tick();
  assert.deepEqual(fake.posts.map(p=>p.body.messages),[[{type:'clock',seconds:1}],[{type:'scene',songId:'b'},{type:'clock',seconds:3}]]);
});

test('the player goes quiet when the server says nobody is watching', async()=>{
  const fake=fakeRelay(0),channel=playerRelay('tok',fake);
  fake.sources[0].onmessage({data:'{"type":"hello"}'});
  channel.postMessage({type:'clock',seconds:1});await tick();await tick();
  channel.postMessage({type:'clock',seconds:2});await tick();
  assert.equal(fake.posts.length,1);
});

test('an OBS viewer says when its link to the app comes up and when it is lost', ()=>{
  const fake=fakeRelay(),links=[];viewerRelay('k',{...fake,onLink:up=>links.push(up)});
  fake.sources[0].onopen();fake.sources[0].onerror();fake.sources[0].onopen();
  assert.deepEqual(links,[true,false,true]);
});

test('an OBS viewer only listens, and a publisher reaches both channels', ()=>{
  const fake=fakeRelay(),viewer=viewerRelay('k e y',fake),got=[];
  assert.equal(fake.sources[0].url,'/visual-stream?key=k%20e%20y');
  const scenes=[],clocks=[];
  createVisualReceiver({open:()=>viewer,onScene:m=>scenes.push(m),onClock:m=>clocks.push(m)});   // its hello goes nowhere
  fake.sources[0].onmessage({data:JSON.stringify({type:'scene',songId:'x'})});fake.sources[0].onmessage({data:'not json'});
  assert.deepEqual(scenes,[{type:'scene',songId:'x'}]);
  const a={postMessage:m=>got.push(['a',m]),close(){}},b={postMessage:m=>got.push(['b',m]),close(){}};
  const joined=joinChannels(a,b),heard=[];joined.onmessage=e=>heard.push(e.data);
  joined.postMessage(1);b.onmessage({data:'hi'});
  assert.deepEqual(got,[['a',1],['b',1]]);assert.deepEqual(heard,['hi']);
});

test('a look chosen for now travels to the player, and back out to every visualizer in the setup', ()=>{
  const sent=[];let player=null;
  const channel={postMessage:m=>sent.push(m),close(){}};
  const shown=[];
  const publisher=createVisualPublisher({open:()=>{player=channel;return channel;},onShow:(songId,scene)=>shown.push([songId,scene])});
  channel.onmessage({data:{type:'show',songId:'s1',scene:'starlane'}});
  channel.onmessage({data:{type:'show',songId:'s1'}});                       // incomplete: ignored
  assert.deepEqual(shown,[['s1','starlane']]);
  channel.onmessage({data:{type:'hello'}});
  publisher.setup({songId:'s1',pinned:{scene:'machine'},usual:null,showing:'starlane'});
  publisher.setup({songId:'s1',pinned:{scene:'machine'},usual:null,showing:'starlane'});   // unchanged: not sent again
  publisher.setup({songId:'s1',pinned:{scene:'machine'},usual:null,showing:null});
  assert.deepEqual(sent.filter(m=>m.type==='setup').map(m=>m.showing),['starlane',null]);
  const out=[];const receiver=createVisualReceiver({open:()=>({postMessage:m=>out.push(m),close(){}}),onScene(){},onClock(){}});
  receiver.show('s1','rainydesk');
  assert.deepEqual(out.at(-1),{type:'show',songId:'s1',scene:'rainydesk'});
});

import {clockNews} from '../chordbuddy/web/visual-bridge.js';
test('the relay sends a clock when something changes, and otherwise twice a second', ()=>{
  const base={type:'clock',songId:'s',seconds:10,playing:true,rate:1,duration:200,loop:null,mix:null,ready:true,at:1000};
  assert.equal(clockNews(null,base),true);
  assert.equal(clockNews(base,{...base,seconds:10.1,at:1100}),false,'running on as expected');
  assert.equal(clockNews(base,{...base,seconds:10.5,at:1500}),true,'half a second later');
  assert.equal(clockNews(base,{...base,seconds:42,at:1100}),true,'a seek');
  assert.equal(clockNews(base,{...base,seconds:10.1,playing:false,at:1100}),true,'paused');
  assert.equal(clockNews(base,{...base,seconds:10.1,rate:0.75,at:1100}),true,'slowed down');
  assert.equal(clockNews(base,{...base,seconds:10.1,loop:{enabled:true,start:4,end:8},at:1100}),true,'a loop');
  assert.equal(clockNews(base,{...base,seconds:10.1,mix:{master:0.5},at:1100}),true,'the mix');
  const paused={...base,playing:false};
  assert.equal(clockNews(paused,{...paused,at:1200}),false,'paused and still');
});

test('a cue from the chart reaches visuals as frame.cue, held for the chord it falls on, and never as a chord', () => {
  const scene=buildScene({content:{...content,cues:[{id:'q',text:'pick scratch',start:5.5},{id:'r',text:'count-in',start:.2}]},music});
  const f=sampleFrame(scene,6);
  assert.equal(f.chord.label,'Am','the chord is still the chord');
  assert.deepEqual([f.cue.text,f.cue.start,f.cue.end],['pick scratch',5.5,9]);assert.ok(f.cue.progress>0&&f.cue.progress<1);
  assert.equal(sampleFrame(scene,9.5).cue,null,'gone when the next chord starts');
  assert.deepEqual([sampleFrame(scene,1).cue.text,sampleFrame(scene,1).cue.end],['count-in',2.2],'in silence it shows for 2 s');
  assert.equal(sampleFrame(buildScene({content,music}),6).cue,null,'a chart without cues');
});
