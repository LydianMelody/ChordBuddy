// Starting partway into a song, or jumping: MIDI devices are put where the plan has them, flags behind the playhead included,
// and only what differs is sent, so a Helix is never sent the preset it's already on (that reloads it).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMidiBridge,catchUpActions} from '../chordbuddy/web/performance-midi.js';
import {applyToState} from '../chordbuddy/web/performance-actions.js';

const helix=(f)=>({type:'midi.helix',device:'Line 6 Helix',channel:1,...f});
function rig(known={}){
 const sent=[];
 const api=async(url,body)=>{if(url==='/api/midi/schedule')sent.push(...body.events.map(e=>e.bytes));return {queued:1};};
 const b=createMidiBridge({api,timeOfPlayed:p=>p/44100,known});
 return {b,sent,known};
}
const tick=()=>new Promise(r=>setTimeout(r,0));

test('a flag left at No change keeps the setlist, preset or snapshot that came before', () => {
 let s=applyToState({},helix({setlist:5,preset:63,snapshot:1}));
 s=applyToState(s,helix({snapshot:2}));
 assert.deepEqual(s['midi.Line 6 Helix.tone'],{channel:1,setlist:5,preset:63,snapshot:2});
});

test('starting after a Helix flag sends where the plan has the Helix: setlist, preset and snapshot', async () => {
 const r=rig();
 const state=applyToState({},helix({setlist:5,preset:63,snapshot:1}));
 r.b.event({type:'state',atPlayed:0,state});await tick();
 assert.deepEqual(r.sent,[[0xB0,32,4],[0xC0,62],[0xB0,69,0]]);
});

test('a jump sends only what changed: a new snapshot alone, and nothing when the preset is already there', async () => {
 const r=rig();
 r.b.event({type:'state',atPlayed:0,state:applyToState({},helix({setlist:5,preset:63,snapshot:1}))});await tick();
 r.sent.length=0;
 r.b.event({type:'state',atPlayed:44100*10,state:applyToState({},helix({setlist:5,preset:63,snapshot:2}))});await tick();
 assert.deepEqual(r.sent,[[0xB0,69,1]],'snapshot only, no preset reload');
 r.sent.length=0;
 r.b.event({type:'state',atPlayed:44100*20,state:applyToState({},helix({setlist:5,preset:63,snapshot:2}))});await tick();
 assert.deepEqual(r.sent,[],'already there: nothing');
});

test('a flag right where the catch-up already put the Helix is not sent twice, but a later flag is', async () => {
 const r=rig();
 const state=applyToState({},helix({setlist:5,preset:63,snapshot:1}));
 r.b.event({type:'state',atPlayed:0,state});await tick();r.sent.length=0;
 r.b.event({type:'midi',atPlayed:0,action:helix({setlist:5,preset:63,snapshot:1})});await tick();
 assert.deepEqual(r.sent,[],'the bar-0 flag the catch-up covered');
 r.b.event({type:'midi',atPlayed:44100*30,action:helix({setlist:5,preset:63,snapshot:2})});await tick();
 assert.deepEqual(r.sent,[[0xB0,32,4],[0xC0,62],[0xB0,69,1]],'a flag plays as you wrote it');
});

test('a new preview that shares what was sent does not reload the preset; a fresh start sends it all', async () => {
 const known={},state=applyToState({},helix({setlist:5,preset:63,snapshot:1}));
 const a=rig(known);a.b.event({type:'state',atPlayed:0,state});await tick();
 const b=rig(known);b.b.event({type:'state',atPlayed:0,state});await tick();
 assert.deepEqual(b.sent,[]);
 const c=rig({});c.b.event({type:'state',atPlayed:0,state});await tick();
 assert.equal(c.sent.length,3);
});

test('CC and program change values catch up too', () => {
 const out=catchUpActions('Pedal',{'midi.Pedal.2.cc.11':90,'midi.Pedal.1.pc':7,'midi.Other.1.pc':3},{'midi.Pedal.1.pc':7});
 assert.deepEqual(out,[{type:'midi.cc',device:'Pedal',channel:2,controller:11,value:90}]);
});

test('the tempo here comes from the song’s tempo map, and a typed tempo becomes the speed that plays it', async () => {
 const {tempoAt,speedForTempo}=await import('../chordbuddy/web/performance-midi.js');
 const bar=(start,len)=>({start,end:start+len,beats:[start,start+len/4,start+len/2,start+len*3/4]});
 const measures=[];let t=0;for(let i=0;i<12;i++){measures.push(bar(t,2));t+=2;}   // 120 BPM
 for(let i=0;i<12;i++){measures.push(bar(t,2.4));t+=2.4;}                         // then 100 BPM
 const song={measures,bpm:120,constant:false};
 assert.equal(tempoAt(song,5),120);assert.equal(tempoAt(song,40),100);
 assert.deepEqual(speedForTempo(90,120),{percent:75});
 assert.deepEqual(speedForTempo(80,90),{percent:88.9});
 assert.match(speedForTempo(200,120).error,/60 to 150 BPM/);
 assert.match(speedForTempo(90,null).error,/isn’t known/);
});
