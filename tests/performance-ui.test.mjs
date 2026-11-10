// The parts of Prepare, Perform and the MIDI bridge that make decisions, tested without a page. The pages themselves are checked in the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {History,allActions,changeLabel,laneOf,listDiff,applyListDiff,NEW_ACTION,scopeWords} from '../chordbuddy/web/performance-prepare.js';
import {pendingWords,upcoming} from '../chordbuddy/web/performance-view.js';
import {COMMAND_GROUPS,COMMANDS,currentMapping,describeCommand,runCommand,searchCommands} from '../chordbuddy/web/performance-commands.js';
import {clockOffset,clockPulses,canTapTempo,createMidiBridge,createTempoTap,learnControl,learnFrom,matchInput,messagesFor,placeLearned,rangeClash,readTaps,tapBpm,tapEvents,tempoMap,valueRange} from '../chordbuddy/web/performance-midi.js';
import {ACTIONS,checkAction} from '../chordbuddy/web/performance-actions.js';
import {SHORTCUTS} from '../chordbuddy/web/shortcuts.js';
import {TOOLS,TOOL_ICONS} from '../chordbuddy/web/tool-icons.js';
import {newPerformance,addRepeat,address,editPass} from '../chordbuddy/web/performance-model.js';
import {addressPosition} from '../chordbuddy/web/performance-compiler.js';
import {defaultMix} from '../chordbuddy/web/pcm-mixer-core.js';
import {Sim,grid} from './performance-sim.mjs';

const G=grid(),pos=at=>addressPosition(G.measures)(at)/44100;
let n=0;const uid=()=>`u${++n}`;

test('the history names each step, merges quick repeats of one, and lists them newest first', () => {
 const h=new History('a');h.push('b','Add a repeat');h.push('c','Change Mixer keyframe at bar 9');h.push('d','Change Mixer keyframe at bar 9',{merge:true});
 assert.deepEqual(h.undoLabels,['Change Mixer keyframe at bar 9','Add a repeat'],'typing in one field is one step');
 h.undo();assert.equal(h.value,'b');assert.deepEqual(h.redoLabels,['Change Mixer keyframe at bar 9']);
 h.undo();assert.deepEqual(h.redoLabels,['Add a repeat','Change Mixer keyframe at bar 9'],'next to redo first');
});
test('a change is named for what it did', () => {
 const p=newPerformance({songId:'s',id:'p'}),at=address(G.measures[2].id);
 const withCue={...p,cues:[{id:'c1',at,action:{type:'marker.text',text:'Go'}}]};
 assert.match(changeLabel(p,withCue,pos,G.measures),/^Add .* at bar 3$/);
 assert.match(changeLabel(withCue,p,pos,G.measures),/^Remove /);
 assert.equal(changeLabel(p,{...p,name:'Encore'},pos,G.measures),'Rename to Encore');
});
test('undo steps back and forward through whole values', () => {
 const h=new History(1);h.push(2);h.push(3);
 assert.equal(h.undo(),2);assert.equal(h.undo(),1);assert.equal(h.undo(),null);
 assert.equal(h.redo(),2);h.push(9);assert.equal(h.redo(),null);assert.equal(h.value,9);
});

test('every action type can be made, is valid when made, and has a lane', () => {
 for(const type of Object.keys(ACTIONS)){
  const a=NEW_ACTION[type]({scenes:[{id:'abstract'}],device:'Helix'});
  assert.ok(a,type);assert.ok(['tracks','control','visuals','midi','markers'].includes(laneOf(a)),type);
  if(!['visual.input','visual.trigger'].includes(type))assert.equal(checkAction(a),null,type);
 }
});

test('the action list holds every action, wherever it lives, in time order, and says where', () => {
 let p={...newPerformance({songId:'s',id:'p'}),cues:[{id:'late',at:address('m9'),action:{type:'marker.text',text:'x'}}]};
 p=addRepeat(p,{start:address('m1'),end:address('m3'),plays:2,id:'r'},uid);
 p=editPass(p,'r',p.regions[0].passes[1].id,program=>program.push({id:'own',at:address('m2'),action:{type:'marker.text',text:'y'}}),pos,uid);
 const list=allActions(p,pos);
 assert.deepEqual(list.map(x=>x.cue.id),['own','late']);
 assert.equal(scopeWords(list[0].scope,p.regions[0]),'Pass 2 of 2');assert.equal(scopeWords(list[1].scope),'Every play');
});

test('updating from a set list says what changed, and keeps each song’s arrangement', () => {
 assert.deepEqual(listDiff(['a','b','b'],['b','c']),{added:['c'],removed:['a','b']});
 const show={entries:[{id:'1',songId:'a',performanceId:'p',revision:2},{id:'2',songId:'b',performanceId:null}]};
 const next=applyListDiff(show,['b','a','c'],()=>'new');
 assert.deepEqual(next.entries.map(e=>e.id),['2','1','new']);assert.equal(next.entries[1].performanceId,'p');
 assert.equal(show.entries.length,2,'the old value is untouched');
});

test('the Perform page’s words for what is queued', () => {
 assert.equal(pendingWords({song:{pending:null}}),null);
 assert.match(pendingWords({pendingNext:{at:1},song:{}}).text,/Next song/);
 assert.match(pendingWords({song:{pending:{type:'jump',bar:21}}}).text,/Jump to bar 21/);
 assert.match(pendingWords({song:{pending:{type:'exit'}}}).text,/Leaving the loop after this pass/);
 assert.match(pendingWords({song:{pending:{type:'switch',label:'bars 17–20'}}}).text,/After this pass: loop bars 17–20/);
 assert.match(pendingWords({song:{waiting:{at:88200},pending:null}},G.measures).text,/Waiting for target audio/);
});

test('what’s coming: actions in order, chart cues included, nothing behind the playhead', () => {
 const p={...newPerformance({songId:'s',id:'p'}),cues:[{id:'a',at:address('m3'),action:{type:'track.set',track:'lead',mute:true}},{id:'b',at:address('m1'),action:{type:'marker.text',text:'gone'}}]};
 const s=new Sim({performance:p});s.runSeconds(2.5);
 const list=upcoming(s.runner,5,[{text:'pick scratch',start:3},{text:'past',start:1}]);
 assert.deepEqual(list.map(x=>x.text),['pick scratch','Mute Lead guitar']);assert.equal(list[1].bar,3);
});

test('wire bytes: a note brings its own note-off, and Helix keeps its documented order', () => {
 assert.deepEqual(messagesFor({type:'midi.note',device:'d',channel:2,note:60,velocity:90,length:.5},10),[{at:10,bytes:[0x91,60,90]},{at:10.5,bytes:[0x81,60,0]}]);
 const helix=messagesFor({type:'midi.helix',device:'d',channel:1,setlist:1,preset:2,snapshot:3},10);
 assert.deepEqual(helix.map(m=>m.bytes),[[0xB0,32,0],[0xC0,1],[0xB0,69,2]]);
 assert.ok(helix[1].at>helix[0].at&&helix[2].at>helix[1].at,'spaced, in order');
 assert.deepEqual(messagesFor({type:'visual.scene',scene:'x'},0),[]);
});

test('clock difference comes from the shortest round trip', () => {
 assert.equal(clockOffset([]),null);
 const o=clockOffset([{sent:0,received:1,server:100},{sent:10,received:10.01,server:90.005}]);
 assert.ok(Math.abs(o.offset-80)<1e-9);assert.ok(Math.abs(o.uncertainty-.005)<1e-9);
});

test('MIDI clock: 24 pulses a quarter from the real beats, however uneven', () => {
 const bars=[{start:0,end:2,beats:[0,.5,1,1.5],quarter_positions:[0,1,2,3,4]},{start:2,end:3.5,beats:[2,2.75],quarter_positions:[0,1,2]}];
 const pulses=clockPulses(bars,0,44100*3.5);
 assert.equal(pulses.length,24*6);
 assert.equal(pulses[0],0);assert.equal(pulses[24],Math.round(.5*44100));assert.equal(pulses[24*4],2*44100);
 assert.equal(clockPulses(bars,44100,44100+1).length,1);
});

test('only a taught control does anything; a press fires once, and its release doesn’t', () => {
 const maps=[learnFrom({device:'H',bytes:[0xB0,71,127]},'next-song')],held=new Map();
 const press=(v,data=71,status=0xB0,device='H')=>matchInput(maps,{device,bytes:[status,data,v]},held);
 assert.equal(press(127).command,'next-song');
 assert.equal(press(127).reason,'already down','a held or repeated message');
 assert.equal(press(0).reason,'release');
 assert.equal(press(127).command,'next-song');
 assert.equal(press(127,70).reason,'not mapped','a preset’s chatter on another controller');
 assert.equal(press(127,71,0xB1).reason,'not mapped','another channel');
 assert.equal(press(127,71,0xB0,'Other').reason,'not mapped','another device');
});

test('each kind of switch fires once per press', () => {
 const fired=(mapping,messages)=>{const held=new Map();return messages.map(([bytes,t])=>matchInput([mapping],{device:'H',bytes,t},held).command?1:0);};
 const cc=(v,t)=>[[0xB0,20,v],t];
 const every={device:'H',status:0xB0,data1:20,edge:'every',command:'next-song'};
 assert.deepEqual(fired(every,[cc(127,1),cc(127,2),cc(127,3)]),[1,1,1],'a single-value switch, as the Helix really sent it');
 assert.deepEqual(fired(every,[cc(127,1),cc(0,2),cc(127,3),cc(0,4)]),[1,1,1,1],'a latching toggle: both of its values are presses');
 assert.deepEqual(fired(every,[cc(127,1),cc(127,1.05),cc(127,1.3)]),[1,0,1],'a glitch within one tap is one press; a quick real tap is not');
 const momentary=learnFrom({device:'H',bytes:[0xB0,20,127]},'next-song');
 assert.deepEqual(fired(momentary,[cc(127,1),cc(0,1.3),cc(127,2),cc(0,2.3)]),[1,0,1,0],'momentary, as the Helix really sent it');
 assert.deepEqual(fired(momentary,[cc(127,1),cc(10,1.3),cc(127,2),cc(10,2.3)]),[1,0,1,0],'momentary whose off value isn’t zero');
 const note=learnFrom({device:'H',bytes:[0x90,60,100]},'next-song');
 assert.deepEqual(fired(note,[[[0x90,60,100]],[[0x80,60,0]],[[0x90,60,64]],[[0x80,60,0]]]),[1,0,1,0],'a key whose release is a separate note-off, at any velocity');
 const pc=learnFrom({device:'H',bytes:[0xC0,5]},'next-song','every');
 assert.deepEqual(fired(pc,[[[0xC0,5],1],[[0xC0,5],2]]),[1,1],'a program change has no value to go above zero');
});

test('value ranges: one CC can do several things, and ranges never overlap', () => {
 const low={device:'H',status:0xB0,data1:20,range:[0,63],edge:'every',command:'low'},high={device:'H',status:0xB0,data1:20,range:[64,127],edge:'every',command:'high'};
 const press=(list,v,held=new Map())=>matchInput(list,{device:'H',bytes:[0xB0,20,v]},held);
 assert.equal(press([low,high],10).command,'low');assert.equal(press([low,high],63).command,'low');
 assert.equal(press([low,high],64).command,'high');assert.equal(press([low,high],127).command,'high');
 const whole=learnFrom({device:'H',bytes:[0xB0,20,127]},'all');
 assert.deepEqual(valueRange(whole),[0,127],'0 to 127 unless it says otherwise');assert.equal(press([whole],127).command,'all');
 // a momentary switch on a narrowed range: its off is outside the range, and still lets go
 const narrow={...learnFrom({device:'H',bytes:[0xB0,20,127]},'mine'),range:[64,127]},held=new Map();
 assert.equal(press([narrow],127,held).command,'mine');
 assert.equal(press([narrow],0,held).reason,'outside its range');
 assert.equal(press([narrow],127,held).command,'mine','the next press still counts');
 // two momentary switches sharing a CC, each with its own value
 const a={...learnFrom({device:'H',bytes:[0xB0,20,40]},'a'),range:[1,63]},b={...learnFrom({device:'H',bytes:[0xB0,20,127]},'b'),range:[64,127]},h2=new Map();
 assert.equal(press([a,b],40,h2).command,'a');press([a,b],0,h2);assert.equal(press([a,b],127,h2).command,'b');
 // a program change has no value to split
 assert.equal(matchInput([{device:'H',status:0xC0,data1:5,edge:'every',command:'pc'}],{device:'H',bytes:[0xC0,5]}).command,'pc');
 // clashes
 assert.equal(rangeClash([low,high],low,[0,64]),high);assert.equal(rangeClash([low,high],low,[0,63]),null);
 assert.equal(rangeClash([low,{...high,data1:21}],low,[0,127]),null,'another CC is free');
 // learning into what's free
 const learned=(list,v)=>placeLearned(list,{...learnFrom({device:'H',bytes:[0xB0,20,v]},'new')});
 const beside=learned([low],127);assert.deepEqual(beside.list.at(-1).range,[64,127],'all the free values around it');assert.equal(beside.replaced,null);assert.equal(beside.list.length,2);
 const between=learned([{...low,range:[0,20]},{...high,range:[100,127]}],50);assert.deepEqual(between.list.at(-1).range,[21,99]);
 const taken=learned([low,high],127);assert.equal(taken.replaced,high,'the same value takes that one’s place');assert.deepEqual(taken.list.at(-1).range,[64,127]);assert.equal(taken.list.length,2);
 const first=learned([],127);assert.deepEqual(first.list[0].range,[0,127],'alone, it gets everything');
});

test('Learn goes by the value a switch sends: a new value splits the CC, the same value replaces', async () => {
 const taught=(v,command='new',values=[v],edge='press')=>({...learnFrom({device:'H',bytes:[0xB0,20,v]},command,edge),values});
 const first=placeLearned([],taught(127,'high'));assert.deepEqual(first.list[0].range,[0,127],'the first switch on a CC gets everything');
 const split=placeLearned(first.list,taught(40,'low'));
 assert.equal(split.replaced,null);assert.equal(split.list.length,2);
 const byName=name=>split.list.find(m=>m.command===name);
 assert.deepEqual(byName('low').range,[1,83],'its own side of the midpoint, leaving zero as let go');assert.deepEqual(byName('high').range,[84,127]);
 assert.equal(split.split.command,'high','says which one moved');
 // both switches really do their own things, and let go cleanly
 const held=new Map(),press=v=>matchInput(split.list,{device:'H',bytes:[0xB0,20,v]},held);
 assert.equal(press(40).command,'low');assert.equal(press(0).command,null);assert.equal(press(127).command,'high');assert.equal(press(0).command,null);assert.equal(press(40).command,'low');
 // the same way round when the first switch is the lower one
 const up=placeLearned(placeLearned([],taught(40,'low')).list,taught(127,'high')).list;
 assert.deepEqual(up.find(m=>m.command==='low').range,[1,83]);assert.deepEqual(up.find(m=>m.command==='high').range,[84,127]);
 // the same value is the same switch
 const again=placeLearned(split.list,taught(40,'other'));assert.equal(again.replaced.command,'low');assert.deepEqual(again.list.at(-1).range,[1,83]);assert.equal(again.list.length,2);
 // a third value divides only the range it falls in
 const third=placeLearned(split.list,taught(100,'third')).list;
 assert.deepEqual(third.find(m=>m.command==='third').range,[84,113]);assert.deepEqual(third.find(m=>m.command==='high').range,[114,127]);assert.deepEqual(third.find(m=>m.command==='low').range,[1,83]);
 // a latching toggle presses with both its values, so a value between them can't share with it
 const toggle=placeLearned([],taught(127,'toggle',[0,127],'every')).list;
 const inside=placeLearned(toggle,taught(40,'between'));assert.equal(inside.replaced.command,'toggle');assert.equal(inside.list.length,1);
 // a toggle with a narrow pair can share
 const pair=placeLearned([],taught(100,'pair',[90,100],'every')).list,beside=placeLearned(pair,taught(40,'side')).list;
 assert.deepEqual(beside.find(m=>m.command==='side').range,[1,65]);assert.deepEqual(beside.find(m=>m.command==='pair').range,[66,127]);
 // an assignment from before values were kept can't be compared, so the new one replaces it
 const old=placeLearned([{device:'H',status:0xB0,data1:20,command:'old'}],taught(40));assert.equal(old.replaced.command,'old');
 // what Learn hears is what's kept
 const learnWith=async(batches,options)=>{let now=0,next=0;const api=async url=>{if(url.includes('999999999'))return {last:0,events:[]};now+=500;return {last:next+1,events:(batches[next++]||[]).map(bytes=>({device:'H',bytes}))};};return (await learnControl(api,'x',{clock:()=>now,...options})).mapping;};
 const cc=v=>[0xB0,20,v];
 const momentary=await learnWith([[cc(40)],[cc(0)],[cc(40)]]);assert.equal(momentary.edge,'press');assert.deepEqual(momentary.values,[40]);assert.equal(momentary.on,40);
 const latching=await learnWith([[cc(127)],[cc(0)]]);assert.equal(latching.edge,'every');assert.deepEqual(latching.values,[0,127]);
 const single=await learnWith([[cc(90)],[cc(90)]]);assert.deepEqual(single.values,[90]);
 const note=await learnWith([[[0x90,60,100]],[[0x80,60,0]],[[0x90,60,70]]]);assert.equal(note.edge,'press');assert.equal(note.value,100);
});

const steadyBars=(from,count,bpm,bar=4)=>Array.from({length:count},(_,i)=>{const beat=60/bpm,start=from+i*bar*beat;return {start,end:start+bar*beat,beats:Array.from({length:bar},(_,b)=>start+b*beat)};});
test('tempo map: real changes only, never a wobble', () => {
 const steady=steadyBars(0,40,120);
 assert.deepEqual(tempoMap(steady,120),[{start:0,bpm:120}]);
 // bars that wander a little around one tempo are still one tempo, and it's the one the app shows
 const wobble=steady.map((m,i)=>{const beat=.5*(1+(i%3-1)*.012);return {start:m.start,end:m.end,beats:[0,1,2,3].map(b=>m.start+b*beat)};});
 assert.deepEqual(tempoMap(wobble,120),[{start:0,bpm:120}],'±1.4 BPM isn’t a change');
 const first=steadyBars(0,20,120),last=first.at(-1).end,both=[...first,...steadyBars(last,20,140)];
 const map=tempoMap(both,130);assert.equal(map.length,2,'a real change');
 assert.ok(Math.abs(map[1].start-last)<=2*4*.5+.01,'found within a couple of bars of it');
 assert.ok(Math.abs(map[0].bpm-map[1].bpm)>=15);
 const blip=[...steadyBars(0,20,120),...steadyBars(40,2,150),...steadyBars(44.8,20,120)];
 assert.equal(tempoMap(blip,120).length,1,'two odd bars aren’t a new tempo');
 assert.deepEqual(tempoMap(both,130,{constant:true}),[{start:0,bpm:130}],'a set steady tempo stays one');
 // beats rounded to a time grid: each reads 167, 171 or 176, the bars are a steady 170
 const rounded=Array.from({length:40},(_,i)=>{const start=i*4*60/170,end=(i+1)*4*60/170;return {start,end,beats:[0,1,2,3].map(b=>Math.round((start+b*60/170)/.02)*.02)};});assert.deepEqual(tempoMap(rounded,170),[{start:0,bpm:170}]);assert.deepEqual(tempoMap(rounded,null),[{start:0,bpm:170}],'even with no tempo to compare against');
 // the same things real songs did: odd bars at the very start, and a stretch that settles after its first bars
 const oddStart=[...steadyBars(0,3,150),...steadyBars(4.8,60,120)];assert.deepEqual(tempoMap(oddStart,120),[{start:0,bpm:120}],'a few odd bars at the start aren’t a tempo');
 const settles=[...steadyBars(0,10,118),...steadyBars(20.34,100,120)];assert.deepEqual(tempoMap(settles,120),[{start:0,bpm:120}],'close to what the app shows, it’s what the app shows');
 const twoWhole=[...steadyBars(0,6,130),...steadyBars(11.08,40,120),...steadyBars(91.08,30,100)];const whole=tempoMap(twoWhole,120);assert.deepEqual(whole.map(e=>e.bpm),[120,100],'each from all of its stretch');
 assert.deepEqual(tempoMap([],100),[{start:0,bpm:100}]);assert.deepEqual(tempoMap([],null),[]);
 const eighths=steadyBars(0,30,180,6);assert.deepEqual(tempoMap(eighths,90),[{start:0,bpm:90}],'beats counted differently keep the tempo the app shows');
});

test('virtual tap tempo: following sends only changes, and a set BPM is left alone', async () => {
 assert.ok(canTapTempo('Line 6 Helix'));assert.ok(canTapTempo('HX Stomp'));assert.ok(!canTapTempo('Microsoft GS Wavetable Synth'),'CC 64 is the sustain pedal elsewhere');
 assert.equal(tapBpm(171,75),128.3,'at the speed it’s playing, to the Helix’s 0.1');assert.equal(tapBpm(null),null);assert.equal(tapBpm(60,50),null,'slower than a Helix takes a tap');
 const taps=tapEvents(120,10);assert.deepEqual(taps.map(t=>t.at),[10,10.5,11,11.5]);assert.ok(taps.every(t=>t.bytes.join()==='176,64,127'));
 const sent=[];let device='Helix',time=0;
 const song=(id,bars,bpm)=>({id,bpm,measures:bars});
 const changing=[...steadyBars(0,20,120),...steadyBars(40,20,150)];
 let open=song('a',changing,135);
 const api=async(path,body)=>{if(path==='/api/midi/status')return {clock:50};sent.push(body);return {};};
 const tap=createTempoTap({api,device:()=>device,song:()=>open,now:()=>time});
 const settle=()=>new Promise(r=>setTimeout(r,0));
 const tick=async s=>{tap.tick({playing:true,rate:100,seconds:1,...s});await settle();};
 const bpmOf=call=>Math.round(60/(call.events[1].at-call.events[0].at)*10)/10;
 await tick({playing:false});assert.equal(sent.length,0,'nothing until it plays');
 await tick({});assert.equal(sent.length,1,'the song’s tempo when it first plays');assert.equal(sent[0].device,'Helix');assert.equal(sent[0].events.length,4);assert.equal(bpmOf(sent[0]),120);
 await tick({});await tick({playing:false});await tick({});await tick({seconds:5});await tick({seconds:30});assert.equal(sent.length,1,'nothing on a resume or a seek at the same tempo');
 // the last tap lands on the bar where the new tempo starts
 const change=tempoMap(changing,135)[1];
 await tick({seconds:change.start-10});assert.equal(sent.length,1,'not yet');
 await tick({seconds:change.start-1.3});assert.equal(sent.length,2,'in time for the taps to end on it');assert.equal(bpmOf(sent[1]),tempoMap(changing,135)[1].bpm);
 const last=sent[1].events.at(-1).at-50;assert.ok(Math.abs(last-1.3)<.05,'the last tap comes 1.3 s from now, on the change');
 await tick({seconds:change.start+1});assert.equal(sent.length,2,'and only once');
 await tick({seconds:5});assert.equal(sent.length,3,'a seek back to the old tempo is a change');assert.equal(bpmOf(sent[2]),120);
 // speed: once it stops moving
 await tick({seconds:6,rate:95});time=100;await tick({seconds:6,rate:90});assert.equal(sent.length,3,'waits for the speed to stop moving');
 time=600;await tick({seconds:6,rate:90});assert.equal(sent.length,4);assert.equal(bpmOf(sent[3]),108);
 await tick({seconds:6,rate:100});time=1100;await tick({seconds:6});assert.equal(sent.length,5);
 // a new song at the tempo already sent sends nothing; a different one does
 open=song('b',steadyBars(0,30,120),120);await tick({seconds:1});assert.equal(sent.length,5,'same tempo, nothing to send');
 open=song('c',steadyBars(0,30,90),null);await tick({seconds:1});assert.equal(sent.length,5,'waits for the new song’s tempo');
 open=song('c',steadyBars(0,30,90),90);await tick({seconds:1});assert.equal(sent.length,6);assert.equal(bpmOf(sent[5]),90);
 // a set BPM: exactly that, and following stops until the next song
 assert.equal(await tap.setBpm('Helix',67),67);assert.equal(sent.length,7);assert.equal(bpmOf(sent[6]),67);
 await tick({seconds:2});assert.equal(sent.length,7,'a set BPM is left alone');
 open=song('d',steadyBars(0,30,100),100);await tick({seconds:1});assert.equal(sent.length,8,'the next song follows again');assert.equal(bpmOf(sent[7]),100);
 // the action sends even with nothing changed, to go back after tapping your own
 assert.equal(await tap.follow('Helix',{seconds:1,rate:100}),100);assert.equal(sent.length,9);
 device='';open=song('e',steadyBars(0,30,70),70);await settle();
 // off, unless the action asked for it
 const quiet=createTempoTap({api,device:()=>'',song:()=>open,now:()=>0}),before=sent.length;
 quiet.tick({playing:true,rate:100,seconds:1});await settle();assert.equal(sent.length,before,'off is off');
 await quiet.follow('Helix',{seconds:1,rate:100});assert.equal(sent.length,before+1);
 open=song('f',steadyBars(0,30,80),80);quiet.tick({playing:true,rate:100,seconds:1});await settle();assert.equal(sent.length,before+2,'the action turned following on until a set BPM');
 const ran=[];runCommand('tap-tempo',{mode:'bpm',bpm:133},{tapTempo:p=>ran.push(p)});assert.equal(ran[0].bpm,133);
 assert.equal(describeCommand('tap-tempo',{mode:'bpm',bpm:133}),'Virtual tap tempo: 133 BPM');assert.equal(describeCommand('tap-tempo',{}),'Virtual tap tempo: follow song’s tempo map');
});

test('virtual tap tempo: it reads the device’s real tempo, and only taps when that’s different', async () => {
 const sent=[];let reading=null,open={id:'a',bpm:120,measures:steadyBars(0,30,120)};
 const api=async path=>{if(path==='/api/midi/status')return {clock:50,clock_in:reading?{Helix:reading}:{}};sent.push(path);return {};};
 const tap=createTempoTap({api,device:()=>'Helix',song:()=>open,now:()=>0});
 const settle=()=>new Promise(r=>setTimeout(r,0));
 reading={bpm:119.92,seconds_ago:.01};
 assert.deepEqual(await tap.sync('Helix',{seconds:0,rate:100}),{bpm:120,tapped:false},'turned on, already there');assert.equal(sent.length,0);
 reading={bpm:143,seconds_ago:.01};
 assert.deepEqual(await tap.sync('Helix',{seconds:0,rate:100}),{bpm:120,tapped:true},'turned on, somewhere else');assert.equal(sent.length,1);
 // on: you tap your own during the song, and it's left alone
 reading={bpm:90,seconds_ago:.01};tap.tick({playing:true,rate:100,seconds:5});await settle();assert.equal(sent.length,1,'your own tempo within a song stands');
 // the next song starts from the song's tempo, even with the same number as last time
 open={id:'b',bpm:120,measures:steadyBars(0,30,120)};tap.tick({playing:true,rate:100,seconds:0});await settle();await settle();assert.equal(sent.length,2,'the Helix says 90, this song says 120');
 reading={bpm:100,seconds_ago:.01};open={id:'c',bpm:100,measures:steadyBars(0,30,100)};tap.tick({playing:true,rate:100,seconds:0});await settle();await settle();assert.equal(sent.length,2,'the Helix is already right for this one');
 // a stale reading is no reading: it goes by what it last sent
 reading={bpm:100,seconds_ago:9};open={id:'d',bpm:133,measures:steadyBars(0,30,133)};tap.tick({playing:true,rate:100,seconds:0});await settle();await settle();assert.equal(sent.length,3);
 reading=null;open={id:'e',bpm:133,measures:steadyBars(0,30,133)};tap.tick({playing:true,rate:100,seconds:0});await settle();await settle();assert.equal(sent.length,3,'Send MIDI Clock off: same as last sent, nothing to do');
 open=null;assert.equal(await tap.sync('Helix',{}),null,'no song to go by');
});

test('the action menu: every command is grouped and explained, and says what it does with its settings', () => {
 const groups=new Set(COMMAND_GROUPS.map(g=>g.id));
 assert.equal(new Set(COMMANDS.map(c=>c.id)).size,COMMANDS.length,'no two with one id');
 for(const c of COMMANDS){assert.ok(groups.has(c.group),c.id);assert.ok(c.help.length>15,`${c.id} explains itself`);assert.ok(describeCommand(c.id,{}).length>3,c.id);}
 for(const g of COMMAND_GROUPS)assert.ok(COMMANDS.some(c=>c.group===g.id),`${g.id} isn’t empty`);
 assert.equal(describeCommand('loop-bars',{bars:8}),'Loop 8 bars');
 assert.equal(describeCommand('loop-bars',{bars:1}),'Loop 1 bar');
 assert.equal(describeCommand('loop-bars'),'Loop 4 bars','a switch taught before there were settings');
 assert.equal(describeCommand('track-volume',{tracks:['bass','drums'],level:30}),'Set Bass, Drums to 30%');
 assert.equal(describeCommand('visual-step',{direction:-1,override:false}),'Previous visual until the next planned visual');
 assert.equal(describeCommand('song-step',{}),'Next song');
 assert.deepEqual(currentMapping({device:'H',command:'previous-bar'}),{device:'H',command:'bar-step',params:{direction:-1}},'a switch taught before next and previous were one action');
 assert.deepEqual(COMMAND_GROUPS.map(g=>g.label),['Playback','Song navigation','Looping','Mixer','Display']);
 assert.ok(COMMANDS.some(c=>c.label==='Switch to song defaults'));
 assert.equal(describeCommand('nothing-like-this'),'Something this version doesn’t know');
 assert.ok(searchCommands('mute').some(c=>c.id==='track-mute'));
 assert.ok(searchCommands('loop bars').some(c=>c.id==='loop-bars'));
 assert.equal(searchCommands('zzz').length,0);assert.equal(searchCommands('').length,COMMANDS.length);
});

test('a taught switch does its action in practice and in a show', () => {
 const calls=[];const log=name=>(...args)=>{calls.push([name,...args]);return Promise.resolve();};
 let snap={ready:true,seconds:10,rate:100,mix:defaultMix()};
 const transport={getSnapshot:()=>structuredClone(snap),setMix:mix=>{snap.mix=mix;},setRate:log('rate'),seek:log('seek'),pause:log('pause'),setLoop:log('setLoop')};
 const practice={run:log('run'),toggleLoop:log('toggleLoop'),song:log('song'),barStarts:()=>[0,2,4,6,8,10,12,14,16]};
 let shown='b';const visual={scenes:()=>[{id:'a'},{id:'b'},{id:'c'}],current:()=>shown,show:(id,o)=>{calls.push(['visual',id,o]);shown=id;},toggle:log('toggle'),open:log('open')};
 const controller={togglePlay:log('c.toggle'),stop:log('c.stop'),stepBars:log('c.bars'),stepSections:log('c.sections'),pressLoop:log('c.loop'),exitLoop:log('c.exit'),nextSong:log('c.next'),release:log('c.release'),navigate:log('c.navigate')};
 const run=(id,params,inShow=false)=>{calls.length=0;runCommand(id,params,{inShow,controller,view:null,transport,practice,visual});return calls.map(c=>[...c]);};
 assert.deepEqual(run('play-pause'),[['run',{type:'toggle'}]]);
 assert.deepEqual(run('play-pause',{},true),[['c.toggle']]);
 assert.deepEqual(run('song-step',{direction:1}),[['song',1]]);
 assert.deepEqual(run('song-step',{direction:-1}),[['song',-1]]);
 assert.deepEqual(run('song-step',{direction:1},true),[['c.next']]);
 assert.deepEqual(run('song-step',{direction:-1},true),[],'the order is set during a show');
 assert.deepEqual(run('bar-step',{direction:-1}),[['run',{type:'bar',direction:-1}]]);
 assert.deepEqual(run('section-step',{direction:1},true),[['c.sections',1]]);
 assert.deepEqual(run('loop-bars',{bars:8}),[['toggleLoop','bars',8]]);
 assert.deepEqual(run('loop-bars',{bars:8},true),[['c.loop','bars',{bars:8,plays:undefined,at:undefined}]]);
 assert.deepEqual(run('loop-bars',{bars:8,plays:3},true),[['c.loop','bars',{bars:8,plays:3,at:undefined}]],'a number of plays goes with it');
 assert.equal(describeCommand('loop-bars',{bars:4,plays:3}),'Loop 4 bars, 3 times');
 assert.deepEqual(run('jump-bars',{bars:3,direction:1}),[['seek',16]],'three bars on from bar line 10');
 assert.equal(run('jump-bars',{bars:3,direction:1},true).length,3);
 run('track-mute',{tracks:['drums','bass'],mode:'toggle'});assert.equal(snap.mix.mutes[1],true);assert.equal(snap.mix.mutes[0],true,'a group switches together');
 run('track-mute',{tracks:['drums','bass'],mode:'toggle'});assert.equal(snap.mix.mutes[1],false);
 run('track-solo',{tracks:['vocals'],mode:'on'});assert.equal(snap.mix.solos[3],true);
 run('track-volume',{tracks:['lead'],level:30});assert.equal(snap.mix.gains[5],.3);
 run('master-volume',{level:50});assert.equal(snap.mix.master,.5);
 run('mix-preset',{preset:'karaoke'});assert.equal(snap.mix.mutes[3],true);assert.equal(snap.mix.master,.5,'a preset leaves Master alone');
 assert.deepEqual(run('speed-set',{percent:75}),[['rate',75]]);
 assert.deepEqual(run('speed-change',{direction:-1,percent:5}),[['rate',95]]);
 snap.rate=50;assert.deepEqual(run('speed-change',{direction:-1,percent:5}),[['rate',50]],'never past the slowest speed');snap.rate=100;
 assert.deepEqual(run('visual-step',{direction:1,override:false}),[['visual','c',{override:false}]]);
 assert.deepEqual(run('visual-step',{direction:1}),[['visual','a',{override:true}]],'wraps around, and holds unless told not to');
 assert.deepEqual(run('visual-step',{direction:-1}),[['visual','c',{override:true}]]);
 assert.deepEqual(run('resume-automation',{}),[],'nothing to go back to outside a show');
 assert.deepEqual(run('resume-automation',{},true),[['c.release',{}]]);
 assert.equal(runCommand('nothing-like-this',{},{transport}),false);
});

test('two taps tell what kind of switch it is', async () => {
 assert.equal(readTaps([127]),null);
 assert.equal(readTaps([127,127]),'every','one value');
 assert.equal(readTaps([127,0]),'unsure','latching, or the first tap of a momentary switch');
 assert.equal(readTaps([0,127]),'unsure','a latching switch that started lit');
 assert.equal(readTaps([127,0,127]),'press','momentary');
 const learn=async(batches,options)=>{
  let now=0,next=0;
  const api=async url=>{if(url.includes('999999999'))return {last:0,events:[]};now+=500;const events=(batches[next++]||[]).map(bytes=>({device:'H',bytes}));return {last:next,events};};
  return learnControl(api,'next-song',{clock:()=>now,...options});
 };
 const cc=v=>[0xB0,20,v];
 assert.equal((await learn([[cc(127)],[cc(127)]])).mapping.edge,'every');
 const momentary=(await learn([[cc(127)],[cc(0)],[cc(127)]])).mapping;
 assert.equal(momentary.edge,'press');assert.equal(momentary.on,127);assert.equal(momentary.data1,20);assert.equal(momentary.value,127,'kept, to show which value it sends');
 assert.equal((await learn([[cc(90)],[cc(90)]])).mapping.value,90,'one value');
 assert.equal((await learn([[cc(127)],[],[cc(0)]])).mapping.edge,'every','on, off, then quiet: latching');
 assert.equal((await learn([[cc(0)],[cc(127)]])).mapping.status,0xB0);
 const chatter=await learn([[[0xB0,0,0],[0xB0,32,2],[0xC0,5]]],{wait:3000});
 assert.equal(chatter.mapping,undefined,'a preset’s chatter sends each control once, so it isn’t learned');assert.equal(chatter.heard,3);
 assert.equal((await learn([],{wait:3000})).heard,0);
 const stopped=await learn([],{stop:()=>true});assert.equal(stopped.heard,0,'giving up when the page closes');
});

test('the bridge: preview with hardware off sends nothing; a show sends the right bytes; a returning device gets state, not history', async () => {
 const calls=[];const api=async(path,body)=>{calls.push([path,body]);return path==='/api/midi/status'?{clock:1000}:{};};
 const off=createMidiBridge({api,now:()=>5,timeOfPlayed:p=>p/44100,allow:()=>false});
 off.event({type:'midi',atPlayed:44100,action:{type:'midi.cc',device:'H',channel:1,controller:1,value:2}});
 assert.equal(calls.length,0);
 const on=createMidiBridge({api,now:()=>5,timeOfPlayed:p=>p/44100});
 await on.calibrate(1);calls.length=0;
 on.event({type:'midi',atPlayed:44100,action:{type:'midi.cc',device:'H',channel:1,controller:1,value:2}});
 assert.equal(calls[0][0],'/api/midi/schedule');assert.deepEqual(calls[0][1].events[0].bytes,[0xB0,1,2]);assert.equal(calls[0][1].events[0].at,1000-5+1,'on the server’s clock');
 on.event({type:'oneshot',atPlayed:0,action:{type:'visual.trigger',input:'x'}});
 assert.equal(calls.length,1,'a visual one-shot is not MIDI');
 calls.length=0;
 await on.chase({'midi.H.1.cc.7':100,'midi.H.tone':{snapshot:3},'midi.Other.1.cc.1':5,'track.bass.mute':true},'H');
 assert.deepEqual(calls[0][1].events.map(e=>e.bytes),[[0xB0,7,100],[0xB0,69,2]]);
 calls.length=0;on.event({type:'cleanup'});assert.equal(calls[0][0],'/api/midi/cleanup');
});

test('help text: every new key is in the shortcuts list, and every new tool explains itself', () => {
 const text=JSON.stringify(SHORTCUTS);
 for(const word of ['During a show','Prepare','Action tool','In a loop you planned'])assert.ok(text.includes(word),word);
 assert.ok(!TOOLS['prepare-repeat'],'loops are planned with the Action tool');
 for(const name of ['prepare-select','prepare-action']){assert.ok(TOOLS[name].body.length>40,name);assert.ok(TOOL_ICONS[name],name);}
});

test('after a show, practice playback gets back its own mix and speed, and a song change during the show keeps them', async () => {
 const {Transport}=await import('../chordbuddy/web/transport.js');
 const audio={addEventListener(){},pause(){},load(){},removeAttribute(){}};
 const t=new Transport({audio,token:'x',createPcm:async()=>({})});
 const asked=[];const performer={resume(){asked.push('resume');},pause(){asked.push('pause');},navigate(f){asked.push(['navigate',f]);},pressLoop(k){asked.push(['loop',k]);},exitLoop(){asked.push('exit');},setLive(p,v){asked.push([p,v]);return {accepted:true};},handMix(){asked.push('mix');return {accepted:true};}};
 t.state.ready=true;t.state.duration=100;t.state.rate=90;
 const before=structuredClone(t.state.mix);
 t.attachPerformer(performer);
 t.performerReport({mix:{...before,master:0},rate:100,seconds:5,playing:true,visualMix:{x:1}});
 assert.equal(t.getSnapshot().mix.master,0);
 await t.play();t.pause();await t.seek(2);await t.setLoop({enabled:true,start:1,end:2,implicit:true,kind:'bars'});await t.setLoop(null);await t.setRate(80);t.setMix(before);
 assert.deepEqual(asked,['resume','pause',['navigate',88200],['loop','bars'],'exit',['rate',80],'mix']);
 t.detachPerformer();
 assert.deepEqual(t.getSnapshot().mix,before);assert.equal(t.getSnapshot().rate,90);assert.equal(t.getSnapshot().visualMix,null);assert.equal(t.performer,null);
});

test('copies move by bars, keep their place in the bar, and what would fall off the song is left out and counted', async () => {
 const {copyCues,moveCue}=await import('../chordbuddy/web/performance-model.js');
 const odd=grid([4,4,2,4]).measures;
 const cues=[{id:'a',at:{measure:'m2',beat:{n:3,d:1}},action:{type:'marker.text',text:'x'}},{id:'b',at:{measure:'m1',beat:{n:0,d:1}},action:{type:'marker.text',text:'y'}}];
 let k=0;const r=copyCues(cues,odd,1,()=>`c${++k}`);
 assert.equal(r.skipped,1,'beat 4 is not in a two-beat bar');
 assert.deepEqual(r.copies.map(c=>[c.id,c.at.measure]),[['c1','m2']]);
 assert.equal(cues[1].id,'b','the originals are untouched');
 assert.equal(copyCues(cues,odd,50).copies.length,0);
 assert.equal(moveCue(cues[0],odd[2]),null);assert.equal(moveCue(cues[0],odd[3]).at.measure,'m4');
});

test('a visualization’s parts are offered by what they can do, and melodies aren’t offered', async () => {
 const {inputChoices}=await import('../chordbuddy/web/performance-prepare.js');
 const scenes=[{id:'a',name:'Aurora',inputs:[{key:'flash',type:'trigger',label:'Flash'},{key:'glow',type:'amount',label:'Glow'},{key:'tune',type:'notes',label:'Tune'},{key:'on',type:'gate',label:'On'}]}];
 assert.deepEqual(inputChoices(scenes,'trigger'),[['flash','Aurora: Flash']]);
 assert.deepEqual(inputChoices(scenes,'level').map(x=>x[0]),['glow','on']);
});

test('a show can choose which saved connections the visuals use', async () => {
 const {VisualCues,createVisualOut}=await import('../chordbuddy/web/performance-visuals.js');
 const sent=[],out=createVisualOut({timeOf:p=>p,post:m=>sent.push(m)});
 out.event({type:'visual',atPlayed:5,action:{type:'visual.patch',patch:'default'}});
 assert.deepEqual(sent[0].cues[0],{at:5,kind:'patch',patch:'default'});
 const v=new VisualCues();v.receive(sent[0]);v.step(4);assert.equal(v.state.patch,null);v.step(5);assert.equal(v.state.patch,'default');
 const late=new VisualCues();late.receive(out.current());assert.equal(late.state.patch,'default');
});

test('finish by a clock time: later today, or tomorrow if it has passed', async () => {
 const {nextTimeOfDay,clockValue}=await import('../chordbuddy/web/performance-prepare.js');
 const now=new Date(2026,10,5,20,0,0).getTime();
 assert.equal(new Date(nextTimeOfDay('21:30',now)).getDate(),5);assert.equal(clockValue(nextTimeOfDay('21:30',now)),'21:30');
 assert.equal(new Date(nextTimeOfDay('19:00',now)).getDate(),6);
});

test('device watch: gone is reported once, and coming back opens it again', async () => {
 const {createDeviceWatch}=await import('../chordbuddy/web/performance-midi.js');
 let outputs=[{name:'H'}],log=[];
 const api=async(path)=>{log.push(path);if(path==='/api/midi/ports')return {available:true,outputs,inputs:[]};if(path==='/api/midi/connect')return {output:true};return {};};
 const seen=[];const w=createDeviceWatch({api,devices:()=>[{name:'H',critical:true}],onLost:(n,c)=>seen.push(['lost',n,c]),onBack:n=>seen.push(['back',n])});
 await w.check();assert.deepEqual(seen,[]);
 outputs=[];await w.check();await w.check();assert.deepEqual(seen,[['lost','H',true]]);assert.deepEqual(w.gone(),['H']);
 outputs=[{name:'H'}];await w.check();assert.deepEqual(seen.at(-1),['back','H']);assert.deepEqual(w.gone(),[]);
});

test('spare time reads naturally at any size', async () => {
 const {spareText}=await import('../chordbuddy/web/performance-duration.js');
 assert.equal(spareText(42),'42s to spare');assert.equal(spareText(134),'2m 14s to spare');assert.equal(spareText(54437),'15h 7m to spare');assert.equal(spareText(-38),'38s over');
});

test('live changes in plain words', async () => {
 const {liveWords}=await import('../chordbuddy/web/performance-view.js');
 assert.equal(liveWords({property:'track.drums.mute',value:true}),'Drums muted');
 assert.equal(liveWords({property:'track.lead.gain',value:.5}),'Lead guitar at 50%');
 assert.equal(liveWords({property:'master',value:.8}),'Overall volume at 80%');
 assert.equal(liveWords({property:'rate',value:90}),'Speed at 90%');
 assert.equal(liveWords({property:'midi.Helix.tone',value:{}}),'A pedal or MIDI setting');
});
