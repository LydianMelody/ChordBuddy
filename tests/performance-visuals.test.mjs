import test from 'node:test';
import assert from 'node:assert/strict';
import {VisualCues,createVisualOut} from '../chordbuddy/web/performance-visuals.js';
import {clockMessage} from '../chordbuddy/web/visual-bridge.js';

const INPUTS=[{key:'flash',type:'trigger'},{key:'glow',type:'amount'},{key:'on',type:'gate'},{key:'tilt',type:'bend'}];
const values=()=>({flash:[],glow:.2,on:false,tilt:0});

test('a timed scene change holds off until its moment, then stays', () => {
 const v=new VisualCues();v.receive({cues:[{at:1000,kind:'scene',scene:'aurora'}]});
 v.step(999);assert.equal(v.state.scene,null);
 v.step(1000);assert.equal(v.state.scene,'aurora');
 v.step(5000);assert.equal(v.state.scene,'aurora');
});

test('an effect fires on exactly one frame, however long the frame gap', () => {
 const v=new VisualCues();v.receive({cues:[{at:100,kind:'trigger',input:'flash'}]});
 v.step(90);assert.deepEqual(v.overlay(INPUTS,values(),90).flash,[]);
 v.step(116);assert.deepEqual(v.overlay(INPUTS,values(),116).flash,[1]);
 v.step(132);assert.deepEqual(v.overlay(INPUTS,values(),132).flash,[]);
});

test('set values lay over the patch by type, and a ramp moves between them', () => {
 const v=new VisualCues();
 v.receive({cues:[{at:0,kind:'input',input:'glow',value:1,ramp:1},{at:0,kind:'input',input:'on',value:1},{at:0,kind:'input',input:'tilt',value:1}]});
 v.step(0);
 const half=v.overlay(INPUTS,values(),500);
 assert.equal(half.glow,.5);assert.equal(half.on,true);assert.equal(half.tilt,1);
 assert.equal(v.overlay(INPUTS,values(),2000).glow,1);
});

test('an input nothing has set keeps what the patch bay said', () => {
 const v=new VisualCues();v.step(0);
 assert.deepEqual(v.overlay(INPUTS,values(),0),values());
});

test('a changed decision takes back what has not happened; what has, stands', () => {
 const v=new VisualCues();v.receive({cues:[{at:100,kind:'scene',scene:'one'},{at:200,kind:'scene',scene:'two'},{at:300,kind:'trigger',input:'flash'}]});
 v.step(100);v.receive({withdraw:200});v.step(400);
 assert.equal(v.state.scene,'one');assert.deepEqual(v.overlay(INPUTS,values(),400).flash,[]);
});

test('a replay repeats the same random numbers each pass', () => {
 const v=new VisualCues();
 v.receive({cues:[{at:0,kind:'replay',loop:'L1',pass:1}]});v.step(0);
 const one=[v.random(),v.random(),v.random()];
 assert.deepEqual(v.takeReplay(),{loop:'L1',pass:1});assert.equal(v.takeReplay(),null);
 v.receive({cues:[{at:10,kind:'replay',loop:'L1',pass:2}]});v.step(10);
 assert.deepEqual([v.random(),v.random(),v.random()],one);
 v.receive({cues:[{at:20,kind:'replay',loop:'other',pass:1}]});v.step(20);
 assert.notDeepEqual([v.random(),v.random(),v.random()],one);
});

test('the player side: stamps by when it will be heard, and keeps the state for a window opening late, without old effects', () => {
 const sent=[],out=createVisualOut({timeOf:p=>p*2,post:m=>sent.push(m)});
 out.event({type:'state',atPlayed:10,state:{'visual.scene':'first','visual.input.glow':.5,'track.bass.mute':true}});
 assert.deepEqual(sent[0].cues[0],{at:20,kind:'state',state:{scene:'first',lyrics:null,calm:null,patch:null,inputs:{glow:.5}}});
 out.event({type:'oneshot',atPlayed:20,action:{type:'visual.trigger',input:'flash'}});
 out.event({type:'visual',atPlayed:30,action:{type:'visual.scene',scene:'second'}});
 out.event({type:'oneshot',atPlayed:40,action:{type:'midi.note',note:60}});
 assert.equal(sent.length,3,'not a visual action: nothing sent');
 const late=new VisualCues();late.receive(out.current());late.step(1000);
 assert.equal(late.state.scene,'second');assert.equal(late.state.inputs.glow,.5);
 assert.deepEqual(late.overlay(INPUTS,values(),1000).flash,[],'the old flash never replays');
});

test('the player side: a hand-picked scene goes straight out, and the end of a show clears everything', () => {
 const sent=[],out=createVisualOut({timeOf:p=>p,post:m=>sent.push(m)});
 out.event({type:'live',property:'visual.scene',value:'mine'});
 assert.equal(sent[0].state.scene,'mine');
 out.event({type:'live',property:'track.bass.mute',value:true});
 assert.equal(sent.length,1);
 out.event({type:'cleanup'});assert.deepEqual(sent.at(-1),{clear:true});
});

test('keeping visuals when muted: the clock can carry its own mix, and otherwise carries the real one', () => {
 const snapshot={songId:'s',seconds:1,playing:true,rate:100,duration:10,loop:null,ready:true,mix:{mutes:[true]},visualMix:{mutes:[false]}};
 assert.equal(clockMessage(snapshot,0).mix.mutes[0],false);
 assert.equal(clockMessage({...snapshot,visualMix:null},0).mix.mutes[0],true);
});
