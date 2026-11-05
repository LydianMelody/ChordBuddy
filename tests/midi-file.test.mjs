import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMidi,timeMap,extractSources,describeSignals,gateAt,valueAt,writeMidi} from '../chordbuddy/web/midi-file.js';

// ---- a tiny MIDI file builder: tracks are lists of [absoluteTick, ...bytes] ----
const vlq=n=>{const r=[n&127];while(n>>=7)r.unshift((n&127)|128);return r;};
const be=(n,len)=>Array.from({length:len},(_,i)=>(n>>>(8*(len-1-i)))&255);
const chunk=(id,data)=>[...Buffer.from(id,'latin1'),...be(data.length,4),...data];
const track=list=>{let at=0;const d=[];for(const [t,...bytes] of list.slice().sort((a,b)=>a[0]-b[0])){d.push(...vlq(t-at),...bytes);at=t;}d.push(0,0xFF,0x2F,0);return chunk('MTrk',d);};
const file=(format,division,...tracks)=>new Uint8Array([...chunk('MThd',[...be(format,2),...be(tracks.length,2),...be(division,2)]),...tracks.flat()]);
const name=(t,s)=>[t,0xFF,0x03,s.length,...Buffer.from(s)];
const tempo=(t,us)=>[t,0xFF,0x51,3,...be(us,3)];
const on=(t,ch,p,v=90)=>[t,0x90|ch,p,v], off=(t,ch,p,v=0)=>[t,0x80|ch,p,v];
const cc=(t,ch,c,v)=>[t,0xB0|ch,c,v], bend=(t,ch,raw)=>[t,0xE0|ch,raw&127,raw>>7], press=(t,ch,v)=>[t,0xD0|ch,v], prog=(t,ch,p)=>[t,0xC0|ch,p];
const rpn=(t,ch,msb,lsb,semis,cents)=>[cc(t,ch,101,msb),cc(t,ch,100,lsb),cc(t,ch,6,semis),...(cents==null?[]:[cc(t,ch,38,cents)])];
const near=(a,b,eps=1e-6)=>assert.ok(Math.abs(a-b)<eps,a+' vs '+b);

test('reads the header, a note and the default tempo and meter',()=>{
  const m=parseMidi(file(1,480,track([name(0,'Piano'),on(0,0,60),off(480,0,60)])));
  assert.equal(m.format,1);assert.equal(m.ticksPerQuarter,480);assert.equal(m.ticksPerSecond,null);
  assert.equal(m.hasTempo,false);assert.deepEqual(m.tempos,[{tick:0,usPerQuarter:500000}]);
  assert.deepEqual(m.timeSignatures,[{tick:0,numerator:4,denominator:4}]);
  assert.equal(m.tracks[0].name,'Piano');assert.equal(m.length,480);
  assert.deepEqual(m.tracks[0].events[0],{tick:0,type:'noteOn',channel:0,pitch:60,velocity:90});
  near(timeMap(m).seconds(960),1);                                      // 120 bpm by default
});

test('running status and velocity-0 note-offs',()=>{
  const raw=chunk('MTrk',[0,0x90,60,100, 10,62,100, 10,60,0, 10,62,0, 0,0xFF,0x2F,0]);   // 62 and the zeroes reuse the 0x90 status
  const m=parseMidi(new Uint8Array([...chunk('MThd',[0,0,0,1,0,96]),...raw]));
  assert.deepEqual(m.tracks[0].events.map(e=>[e.tick,e.type,e.pitch,e.velocity]),[[0,'noteOn',60,100],[10,'noteOn',62,100],[20,'noteOff',60,0],[30,'noteOff',62,0]]);
});

test('same-pitch overlapping notes are paired first in, first out',()=>{
  const [s]=extractSources(parseMidi(file(1,480,track([on(0,0,60,50),on(100,0,60,60),off(200,0,60),off(300,0,60)]))));
  assert.deepEqual(s.notes.map(n=>[n.tick,n.endTick,n.velocity]),[[0,200,50],[100,300,60]]);
});

test('a note that never ends holds to the end of the track, or one beat if that is not later; zero length notes are kept',()=>{
  const m=parseMidi(file(1,480,track([on(0,0,60),on(100,0,64),on(900,0,67),off(900,0,67)]),track([on(50,0,72)])));
  const s=extractSources(m);
  assert.equal(s[0].notes[0].endTick,900);assert.equal(s[0].notes[1].endTick,900);assert.equal(s[0].notes[2].endTick,901);
  assert.equal(s[1].notes[0].endTick,50+480);
});

test('tempo changes map ticks to seconds and back, and extrapolate past the ends',()=>{
  const m=parseMidi(file(1,480,track([tempo(0,500000),tempo(960,1000000),on(0,0,60),off(100,0,60)])));
  assert.equal(m.hasTempo,true);
  const tm=timeMap(m);
  near(tm.seconds(0),0);near(tm.seconds(960),1);near(tm.seconds(1440),2);near(tm.seconds(960+4800),11);   // after the change a beat lasts 1 s
  near(tm.tick(1),960);near(tm.tick(2),1440);near(tm.tick(11),960+4800);near(tm.tick(0.25),240);
  for(const t of [0,1,479,960,1000,12345])near(tm.tick(tm.seconds(t)),t,1e-6);
});

test('tempos from all tracks are merged, and a first tempo after tick 0 still gets a default at 0',()=>{
  const m=parseMidi(file(1,480,track([tempo(480,250000)]),track([tempo(0,600000),tempo(0,400000)])));
  assert.deepEqual(m.tempos,[{tick:0,usPerQuarter:400000},{tick:480,usPerQuarter:250000}]);
  const late=parseMidi(file(1,480,track([tempo(480,250000)])));
  assert.deepEqual(late.tempos,[{tick:0,usPerQuarter:500000},{tick:480,usPerQuarter:250000}]);
});

test('time signatures, key signatures and markers are read',()=>{
  const m=parseMidi(file(1,480,track([[0,0xFF,0x58,4,6,3,24,8],[0,0xFF,0x59,2,0xFE,1],[480,0xFF,0x06,4,...Buffer.from('Vers')]])));
  assert.deepEqual(m.timeSignatures,[{tick:0,numerator:6,denominator:8}]);
  assert.deepEqual(m.keySignatures,[{tick:0,sharps:-2,minor:true}]);
  assert.deepEqual(m.markers,[{tick:480,text:'Vers'}]);
});

test('SysEx and unknown chunks are skipped',()=>{
  const data=[0,0xF0,3,1,2,0xF7, 0,0xF7,2,9,9, 0,0x90,60,80, 10,0x80,60,0, 0,0xFF,0x2F,0];
  const bytes=new Uint8Array([...chunk('MThd',[0,0,0,2,0,96]),...chunk('XXXX',[1,2,3,4,5]),...chunk('MTrk',data),...chunk('Junk',[7])]);
  const m=parseMidi(bytes);
  assert.equal(m.tracks.length,1);assert.deepEqual(m.tracks[0].events.map(e=>e.type),['noteOn','noteOff']);
});

test('SMPTE division uses a fixed rate',()=>{
  const m=parseMidi(file(0,(256-25)<<8|40,track([on(0,0,60),off(1000,0,60)])));
  assert.equal(m.ticksPerQuarter,null);assert.equal(m.ticksPerSecond,1000);
  const tm=timeMap(m);near(tm.seconds(1500),1.5);near(tm.tick(2),2000);
});

test('bad input gives friendly errors',()=>{
  assert.throws(()=>parseMidi(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14])),/not a MIDI file/);
  assert.throws(()=>parseMidi(new Uint8Array([])),/not a MIDI file/);
  assert.throws(()=>parseMidi('hello'),/not a MIDI file/);
  const good=file(1,480,track([on(0,0,60),off(480,0,60)]));
  assert.throws(()=>parseMidi(good.slice(0,good.length-6)),/damaged/);
  assert.throws(()=>parseMidi(good.slice(0,10)),/damaged/);
  assert.throws(()=>parseMidi(file(1,480,[...chunk('MTrk',[0,0x90,60])])),/damaged/);                 // note cut off inside its own chunk
  assert.throws(()=>parseMidi(file(1,480,chunk('MTrk',[0,0xFF,0x51,3,1]))),/damaged/);              // meta longer than its chunk
  assert.throws(()=>parseMidi(file(1,480,chunk('MTrk',[0x80,0x80,0x80,0x80,0x80,0x90,60,1]))),/damaged/);   // a variable-length number that never ends
  assert.throws(()=>parseMidi(file(1,480,chunk('MTrk',[0,60,1]))),/damaged/);                        // data with no status to run on
});

test('files over 16 MB are rejected',()=>{
  assert.throws(()=>parseMidi(new Uint8Array(16*1024*1024+1)),/too big/);
});

test('accepts an ArrayBuffer and a Node Buffer',()=>{
  const bytes=file(1,480,track([on(0,0,60),off(10,0,60)]));
  assert.equal(parseMidi(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)).tracks.length,1);
  assert.equal(parseMidi(Buffer.from(bytes)).tracks.length,1);
});

test('a track using several channels becomes one source per channel, with stable ids and names',()=>{
  const m=parseMidi(file(1,480,track([name(0,'Band'),prog(0,0,5),prog(0,2,40),on(0,0,60),on(0,2,48),off(480,0,60),off(480,2,48)]),track([on(0,3,72),off(10,3,72)])));
  const s=extractSources(m);
  assert.deepEqual(s.map(x=>x.id),['t0c1','t0c3','t1']);
  assert.deepEqual(s.map(x=>x.name),['Band (ch 1)','Band (ch 3)','Track 2']);
  assert.deepEqual(s.map(x=>x.program),[5,40,null]);assert.deepEqual(s.map(x=>x.channels),[[0],[2],[3]]);
  assert.ok(s.every(x=>x.kind==='notes'&&x.bendRange===2&&x.track!==undefined));
});

test('channel 10 is a drum source of its own',()=>{
  const only=extractSources(parseMidi(file(1,480,track([name(0,'Kit'),on(0,9,36,100),off(10,9,36),on(20,9,38,80),off(30,9,38)]))));
  assert.equal(only.length,1);assert.equal(only[0].kind,'drums');assert.equal(only[0].id,'t0');assert.equal(only[0].name,'Kit');
  const mixed=extractSources(parseMidi(file(0,480,track([name(0,'Song'),on(0,0,60),on(0,9,36),off(10,0,60),off(10,9,36)]))));
  assert.deepEqual(mixed.map(x=>[x.id,x.kind,x.name]),[['t0c1','notes','Song (ch 1)'],['t0c10','drums','Drums']]);
  assert.equal(describeSignals(only[0]).find(x=>x.key==='hits').label,'Drum hits');
});

test('format 0 files split by channel',()=>{
  const m=parseMidi(file(0,480,track([on(0,0,60),on(0,1,64),off(100,0,60),off(100,1,64),cc(0,1,64,127)])));
  const s=extractSources(m);
  assert.equal(m.format,0);assert.deepEqual(s.map(x=>x.id),['t0c1','t0c2']);assert.deepEqual(Object.keys(s[1].controls),['cc64']);
});

test('a sustain-pedal-only track is kept, with no notes; empty tracks are not',()=>{
  const m=parseMidi(file(1,480,track([tempo(0,500000)]),track([name(0,'Pedal'),cc(0,0,64,127),cc(480,0,64,0)]),track([prog(0,0,1)])));
  const s=extractSources(m);
  assert.equal(s.length,1);assert.equal(s[0].name,'Pedal');assert.deepEqual(s[0].notes,[]);
  assert.deepEqual(s[0].controls.cc64,[{tick:0,value:1},{tick:480,value:0}]);
  assert.deepEqual(describeSignals(s[0]).map(x=>[x.key,x.label,x.type]),[['cc64','Sustain pedal','gate']]);
});

test('signals are locked to what the file really has',()=>{
  const fixed=extractSources(parseMidi(file(1,480,track([on(0,0,60,90),off(100,0,60),on(100,0,62,90),off(200,0,62)]))));
  assert.deepEqual(describeSignals(fixed[0]).map(x=>x.key),['notes','hits']);
  const rich=extractSources(parseMidi(file(1,480,track([on(0,0,60,40),off(100,0,60),on(100,0,62,100),off(200,0,62),
    cc(0,0,64,127),cc(0,0,1,10),cc(0,0,11,100),cc(0,0,74,5),cc(0,0,10,64),cc(0,0,20,3),bend(0,0,9000),press(0,0,30),
    ...rpn(0,0,0,0,12)]))));
  const sig=Object.fromEntries(describeSignals(rich[0]).map(x=>[x.key,x]));
  assert.deepEqual(Object.keys(sig).sort(),['bend','cc1','cc10','cc11','cc20','cc64','cc74','hits','notes','pressure','velocity']);
  assert.deepEqual([sig.velocity.type,sig.cc64.type,sig.cc1.label,sig.cc10.type,sig.cc20.label,sig.bend.label,sig.pressure.label,sig.cc74.label],['amount','gate','Mod wheel','bend','Controller 20','Pitch bend','Aftertouch','Brightness']);
  assert.equal(rich[0].bendRange,12);assert.equal(rich[0].controls.cc101,undefined);assert.equal(rich[0].controls.cc6,undefined);
});

test('controls are normalized and sorted',()=>{
  const [s]=extractSources(parseMidi(file(1,480,track([on(0,0,60),bend(0,0,0),bend(10,0,8192),bend(20,0,16383),cc(5,0,1,127),press(7,0,64),off(30,0,60)]))));
  assert.deepEqual(s.controls.bend.map(p=>p.tick),[0,10,20]);
  near(s.controls.bend[0].value,-1);near(s.controls.bend[1].value,0);near(s.controls.bend[2].value,8191/8192);
  near(s.controls.cc1[0].value,1);near(s.controls.pressure[0].value,64/127);
});

test('bend range from RPN 0 including cents; data entry is not listed as a control',()=>{
  const [s]=extractSources(parseMidi(file(1,480,track([...rpn(0,0,0,0,5,50),on(10,0,60),off(20,0,60)]))));
  near(s.bendRange,5.5);assert.deepEqual(Object.keys(s.controls),[]);
});

test('gate threshold and valueAt',()=>{
  const pts=[{tick:10,value:0},{tick:20,value:63/127},{tick:30,value:64/127},{tick:40,value:1}];
  assert.equal(gateAt(pts,0),false);assert.equal(gateAt(pts,25),false);assert.equal(gateAt(pts,30),true);assert.equal(gateAt(pts,1000),true);
  assert.equal(valueAt(pts,5,-1),-1);assert.equal(valueAt(pts,10,-1),0);assert.equal(valueAt(pts,29,-1),63/127);assert.equal(valueAt([],5,'x'),'x');
});

test('polyphonic key pressure is kept per note',()=>{
  const [s]=extractSources(parseMidi(file(1,480,track([on(0,0,60),[10,0xA0,60,100],[20,0xA0,60,50],off(30,0,60),[40,0xA0,60,9]]))));
  assert.deepEqual(s.notes[0].pressure.map(p=>p.tick),[10,20]);near(s.notes[0].pressure[0].value,100/127);
  assert.ok(describeSignals(s).some(x=>x.key==='polyPressure'&&x.label==='Key pressure'));
});

// ---- MPE ----
const mpeNotes=[   // three members, one note each, with their own bend/pressure/slide; master channel 0 carries a pedal and a wheel
  on(100,1,60,80),on(200,2,64,70),on(300,3,67,60),off(900,1,60),off(900,2,64),off(900,3,67),
  bend(0,1,8192),bend(150,1,12288),bend(500,1,4096),press(100,2,40),press(400,2,80),cc(100,3,74,127),cc(600,3,74,0),
  bend(1000,1,8192),
];
const sorted=l=>l.slice().sort((a,b)=>a[0]-b[0]);

test('MPE announced by RPN 6 becomes one instrument with per-note expression and master controls',()=>{
  const m=parseMidi(file(1,480,track(sorted([name(0,'Seaboard'),...rpn(0,0,0,6,15),...rpn(0,1,0,0,24),cc(0,0,64,127),cc(0,0,1,50),bend(0,0,10000),press(0,0,100),...mpeNotes]))));
  const s=extractSources(m);
  assert.equal(s.length,1);const x=s[0];
  assert.deepEqual([x.id,x.kind,x.name,x.bendRange],['t0mpe','mpe','Seaboard',24]);
  assert.equal(x.notes.length,3);
  assert.deepEqual(Object.keys(x.controls).sort(),['bend','cc1','cc64','pressure']);   // from the master channel; RPN plumbing and member channels stay out
  const n1=x.notes[0];
  assert.deepEqual(n1.bend.map(p=>[p.tick,+p.value.toFixed(3)]),[[100,0],[150,0.5],[500,-0.5]]);   // starts with the value already in effect
  assert.deepEqual(x.notes[1].pressure.map(p=>[p.tick,+p.value.toFixed(3)]),[[200,0.315],[400,0.63]]);   // pressure at 100 carried over to the note start
  assert.deepEqual(x.notes[2].slide.map(p=>[p.tick,p.value]),[[300,1],[600,0]]);
  const keys=describeSignals(x).map(v=>v.key);
  for(const k of ['noteBend','notePressure','noteSlide','cc64','cc1','bend','pressure'])assert.ok(keys.includes(k),k);
});

test('MPE guessed from behavior: many monophonic channels with expression, master channel 0 without notes',()=>{
  const s=extractSources(parseMidi(file(1,480,track(sorted([cc(0,0,64,127),...mpeNotes])))));
  assert.equal(s.length,1);assert.equal(s[0].kind,'mpe');assert.equal(s[0].id,'t0mpe');assert.equal(s[0].bendRange,48);
  assert.deepEqual(s[0].channels,[0,1,2,3]);assert.deepEqual(Object.keys(s[0].controls),['cc64']);
  assert.equal(s[0].notes[0].channel,1);
});

test('MPE per-note signals are only offered when notes really move',()=>{
  const flat=[on(0,1,60),on(0,2,64),on(0,3,67),off(100,1,60),off(100,2,64),off(100,3,67),bend(0,1,8192),bend(0,2,8192),press(0,3,0)];
  const [s]=extractSources(parseMidi(file(1,480,track([cc(0,0,127,1),...rpn(0,0,0,6,3),...flat]))));   // announced as MPE, but nothing expressive in the notes
  assert.equal(s.kind,'mpe');
  assert.deepEqual(describeSignals(s).map(x=>x.key).filter(k=>k.startsWith('note')&&k!=='notes'),[]);
});

test('a drum track next to an MPE instrument stays separate',()=>{
  const s=extractSources(parseMidi(file(1,480,track(sorted([...rpn(0,0,0,6,15),...mpeNotes,on(0,9,36),off(10,9,36)])))));
  assert.deepEqual(s.map(x=>[x.id,x.kind]),[['t0mpe','mpe'],['t0c10','drums']]);
});

test('a polyphonic multi-channel General MIDI track is not mistaken for MPE',()=>{
  const evs=[];
  for(let c=0;c<3;c++){evs.push(prog(0,c,c*10),on(0,c,48+c,80),on(0,c,52+c,80),on(0,c,55+c,80),off(480,c,48+c),off(480,c,52+c),off(480,c,55+c));}
  evs.push(bend(100,0,9000),bend(100,1,9000),press(100,2,50));
  const s=extractSources(parseMidi(file(1,480,track(sorted(evs)))));
  assert.deepEqual(s.map(x=>x.kind),['notes','notes','notes']);assert.deepEqual(s.map(x=>x.id),['t0c1','t0c2','t0c3']);
  // and three monophonic channels with no expression at all are not MPE either
  const plain=extractSources(parseMidi(file(1,480,track(sorted([on(0,0,60),on(0,1,64),on(0,2,67),off(100,0,60),off(100,1,64),off(100,2,67)])))));
  assert.deepEqual(plain.map(x=>x.kind),['notes','notes','notes']);
});

// ---- writing ----
test('writeMidi round-trips notes, controls, tempo map, meter and markers',()=>{
  const bytes=writeMidi({ticksPerQuarter:480,title:'Demo',tempos:[{tick:0,usPerQuarter:500000},{tick:960,usPerQuarter:400000}],timeSignatures:[{tick:0,numerator:3,denominator:4},{tick:1440,numerator:6,denominator:8}],markers:[{tick:960,text:'Chorus'}],
    tracks:[{name:'Lead',channel:2,program:73,notes:[{tick:0,endTick:480,pitch:60,velocity:100},{tick:480,endTick:480,pitch:62,velocity:0},{tick:480,endTick:960,pitch:60,velocity:50}],
      controls:{cc64:[{tick:0,value:1},{tick:480,value:0}],cc1:[{tick:100,value:.5}],bend:[{tick:10,value:-1},{tick:20,value:0},{tick:30,value:2}],pressure:[{tick:5,value:.25}]}}]});
  const m=parseMidi(bytes);
  assert.equal(m.format,1);assert.equal(m.ticksPerQuarter,480);assert.equal(m.tracks.length,2);assert.equal(m.tracks[0].name,'Demo');
  assert.deepEqual(m.tempos,[{tick:0,usPerQuarter:500000},{tick:960,usPerQuarter:400000}]);
  assert.deepEqual(m.timeSignatures.map(t=>[t.tick,t.numerator,t.denominator]),[[0,3,4],[1440,6,8]]);
  assert.deepEqual(m.markers,[{tick:960,text:'Chorus'}]);
  const [s]=extractSources(m);
  assert.deepEqual([s.id,s.name,s.program,s.channels],['t1','Lead',73,[2]]);
  assert.deepEqual(s.notes.map(n=>[n.tick,n.endTick,n.pitch,n.velocity]),[[0,480,60,100],[480,481,62,1],[480,960,60,50]]);   // the second C starts the instant the first ends: off first, then on
  assert.deepEqual(s.controls.cc64,[{tick:0,value:1},{tick:480,value:0}]);
  near(s.controls.cc1[0].value,64/127);
  near(s.controls.bend[0].value,-1);near(s.controls.bend[1].value,0);near(s.controls.bend[2].value,8191/8192);
  near(s.controls.pressure[0].value,32/127);
  const tm=timeMap(m);near(tm.seconds(960),1);near(tm.seconds(1440),1+480*400000/(480*1e6));
});

test('writeMidi defaults produce a valid empty-conductor file, and a pedal-only track survives',()=>{
  const m=parseMidi(writeMidi({tracks:[{name:'Pedal',controls:{cc64:[{tick:0,value:1}]}}]}));
  assert.equal(m.ticksPerQuarter,960);assert.equal(m.hasTempo,true);
  const s=extractSources(m);assert.equal(s.length,1);assert.deepEqual(s[0].notes,[]);
  assert.equal(parseMidi(writeMidi()).tracks.length,1);
});
