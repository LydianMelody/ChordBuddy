// The parts of Prepare, Perform and the MIDI bridge that make decisions, tested without a page. The pages themselves are checked in the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {History,allActions,laneOf,listDiff,applyListDiff,NEW_ACTION,scopeWords} from '../chordbuddy/web/performance-prepare.js';
import {pendingWords,upcoming} from '../chordbuddy/web/performance-view.js';
import {clockOffset,clockPulses,createMidiBridge,learnFrom,matchInput,messagesFor} from '../chordbuddy/web/performance-midi.js';
import {ACTIONS,checkAction} from '../chordbuddy/web/performance-actions.js';
import {SHORTCUTS} from '../chordbuddy/web/shortcuts.js';
import {TOOLS,TOOL_ICONS} from '../chordbuddy/web/tool-icons.js';
import {newPerformance,addRepeat,address,editPass} from '../chordbuddy/web/performance-model.js';
import {addressPosition} from '../chordbuddy/web/performance-compiler.js';
import {Sim,grid} from './performance-sim.mjs';

const G=grid(),pos=at=>addressPosition(G.measures)(at)/44100;
let n=0;const uid=()=>`u${++n}`;

test('undo steps back and forward through whole values', () => {
 const h=new History(1);h.push(2);h.push(3);
 assert.equal(h.undo(),2);assert.equal(h.undo(),1);assert.equal(h.undo(),null);
 assert.equal(h.redo(),2);h.push(9);assert.equal(h.redo(),null);assert.equal(h.value,9);
});

test('every action type can be made, is valid when made, and has a lane', () => {
 for(const type of Object.keys(ACTIONS)){
  const a=NEW_ACTION[type]({scenes:[{id:'abstract'}],device:'Helix'});
  assert.ok(a,type);assert.ok(['tracks','visuals','midi','markers'].includes(laneOf(a)),type);
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
 const latch=[{device:'H',status:0xB0,data1:9,edge:'both',command:'loop-bars'}],h2=new Map();
 assert.equal(matchInput(latch,{device:'H',bytes:[0xB0,9,127]},h2).command,'loop-bars');
 assert.equal(matchInput(latch,{device:'H',bytes:[0xB0,9,0]},h2).command,'loop-bars');
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
 for(const word of ['During a show','Prepare','Repeat tool','Action tool'])assert.ok(text.includes(word),word);
 for(const name of ['prepare-select','prepare-repeat','prepare-action']){assert.ok(TOOLS[name].body.length>40,name);assert.ok(TOOL_ICONS[name],name);}
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
