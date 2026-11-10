// Prepare's list of actions, mixer keyframes and their fades, and planned moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {checkAction,describeAction,isOneShot,writesOf} from '../chordbuddy/web/performance-actions.js';
import {COMMANDS} from '../chordbuddy/web/performance-commands.js';
import {createCommandOut} from '../chordbuddy/web/performance-commands.js';
import {FIELDS,NEW_ACTION,PLAN_GROUPS,PLAN_ITEMS,isOlderMixerFlag,itemFor,keyframeForFlag,keyframeFrom,laneOf,mixOf,plannedMixAt,plannedStateAt,searchPlan} from '../chordbuddy/web/performance-plan.js';
import {compilePerformance} from '../chordbuddy/web/performance-compiler.js';
import {PerformanceRunner} from '../chordbuddy/web/performance-runner.js';
import {address,newPerformance} from '../chordbuddy/web/performance-model.js';
import {defaultMix} from '../chordbuddy/web/pcm-mixer-core.js';
import {playWords,repeatWords} from '../chordbuddy/web/performance-prepare.js';

const RATE=44100;
const measures=Array.from({length:16},(_,i)=>({id:`m${i+1}`,number:i+1,start:i*2,end:i*2+2,beats:[i*2,i*2+.5,i*2+1,i*2+1.5]}));
const frames=16*2*RATE;
const ctx={scenes:[{id:'abstract'}],mix:defaultMix(),device:'Helix',tempo:90};
const cue=(id,bar,action)=>({id,at:address(`m${bar}`),action});
const song=cues=>compilePerformance({...newPerformance({songId:'s',id:'p'}),cues},{measures,frames});
function engine(){
  const sent=[];
  return {sent,jump(){},mark(at,answer,generation){answer?.({status:'later'},generation);},prepare(){},schedule(at,payload,id){sent.push({at,payload,id});},cancel(prefix){for(let i=sent.length-1;i>=0;i--)if(sent[i].id.startsWith(prefix))sent.splice(i,1);},cancelFrom(at){for(let i=sent.length-1;i>=0;i--)if(sent[i].at>=at)sent.splice(i,1);},play(){},jumpNow(){}};
}
const run=(cues,to)=>{
  const compiled=song(cues),e=engine();
  const r=new PerformanceRunner({performance:{cues,regions:[]},compiled,grid:{measures,frames},engine:e,baseMix:defaultMix(),sections:[]});
  r.start(0);
  for(let at=0;at<=to;at+=RATE/4)r.tick({played:at,source:at,heard:at,state:'playing',now:at/RATE});
  return {r,e};
};

test('the action list has every action MIDI setup has, by the same name, in the same categories, except the mixer’s', () => {
 assert.deepEqual(PLAN_ITEMS.filter(i=>i.group==='mixer').map(i=>i.id),['mix-keyframe'],'a keyframe does what mute, solo, volume, mix and Master did');
 for(const c of COMMANDS){
  if(c.group==='mixer')continue;
  const item=PLAN_ITEMS.find(i=>i.id===c.id);
  assert.ok(item,c.id);assert.equal(item.group,c.group,c.id);
 }
 for(const g of PLAN_GROUPS)assert.ok(PLAN_ITEMS.some(i=>i.group===g.id),g.id);
});
test('every item makes a good action, and that action finds its way back to the item', () => {
 for(const item of PLAN_ITEMS){
  const action=item.make(item.start(ctx));
  if(!['visual.input','visual.trigger'].includes(action.type))assert.equal(checkAction(action),null,item.id);
  assert.ok(typeof describeAction(action)==='string'&&describeAction(action)!=='Unknown action',item.id);
  assert.ok(['tracks','control','visuals','midi','markers'].includes(laneOf(action)),item.id);
  if(item.id!=='speed-normal')assert.equal(itemFor(action)?.id,item.id);
 }
});
test('search finds actions by what they do', () => {
 assert.ok(searchPlan('keyframe').some(i=>i.id==='mix-keyframe'));
 assert.ok(searchPlan('helix preset').some(i=>i.id==='midi.helix'));
 assert.deepEqual(searchPlan('zzzz'),[]);
});
test('Change a track is no longer offered, but a flag saved with it still opens', () => {
 assert.ok(!PLAN_ITEMS.some(i=>i.id==='track.set'));
 assert.equal(itemFor({type:'track.set',track:'lead',mute:true})?.fields,FIELDS['track.set']);
});
test('a keyframe sets the whole mixer', () => {
 const mix=defaultMix();mix.gains[5]=.25;mix.mutes[3]=true;mix.master=.5;
 const key=keyframeFrom(mix);
 assert.equal(checkAction(key),null);assert.equal(writesOf(key).length,7*3+1);
 assert.deepEqual(mixOf(key),mix);assert.equal(describeAction(key),'Mixer keyframe');
 assert.ok(NEW_ACTION['mix.set']({mix}));
});
test('a mute flag from before still plays, still opens, and becomes a keyframe with its change in', () => {
 const action={type:'mix.set',tracks:{lead:{mute:true},rhythm:{mute:true}},move:'fade',from:{command:'track-mute',params:{tracks:['lead','rhythm'],mode:'on'}}};
 assert.deepEqual(writesOf(action).map(([p])=>p),['track.lead.mute','track.rhythm.mute']);
 const item=itemFor(action);assert.equal(item.id,'track-mute');assert.match(item.help,/older kind of mixer flag/);
 assert.deepEqual(item.values(action),{tracks:['lead','rhythm'],mode:'on',move:'fade'});
 assert.ok(isOlderMixerFlag(action));assert.ok(!isOlderMixerFlag(keyframeFrom(defaultMix())));
 const key=keyframeForFlag(null,0,action);
 assert.equal(key.tracks.lead.mute,true);assert.equal(key.tracks.rhythm.mute,true);assert.equal(key.tracks.bass.mute,false);assert.equal(key.move,'fade','it keeps moving the way it did');
});
test('a keyframe set to change at once does, on its flag', () => {
 const mix=defaultMix();mix.gains[5]=0;
 const {e}=run([cue('a',3,keyframeFrom(mix))],5*RATE);
 const at=4*RATE,mine=e.sent.filter(x=>x.id.includes(':a'));
 assert.equal(mine.length,1);assert.equal(mine[0].at,at);assert.equal(mine[0].payload.mix.gains[5],0);
});
test('a fading keyframe moves smoothly from the last mixer flag and lands on its own', () => {
 const low=defaultMix();low.gains[5]=.2;const high=defaultMix();high.gains[5]=.8;
 const {e}=run([cue('a',2,keyframeFrom(low)),cue('b',4,keyframeFrom(high,'glide'))],7*RATE);
 const steps=e.sent.filter(x=>x.id.includes('glide')).sort((x,y)=>x.at-y.at);
 assert.ok(steps.length>300,'a step every 10 ms');
 assert.equal(steps[0].at,2*RATE);assert.ok(steps.at(-1).at<6*RATE);
 assert.ok(Math.abs(steps[0].payload.mix.gains[5]-.2)<.01);
 assert.ok(Math.abs(steps.at(-1).payload.mix.gains[5]-.8)<.01);
 for(let i=1;i<steps.length;i++)assert.ok(steps[i].payload.mix.gains[5]>=steps[i-1].payload.mix.gains[5]);
 const land=e.sent.find(x=>x.id===`mix:${6*RATE}:b`);assert.ok(land,'the change lands on its flag');assert.equal(land.payload.mix.gains[5],.8);
});
test('a fade into a mute fades out, and the mute lands at the flag', () => {
 const on=defaultMix(),off=defaultMix();off.mutes[5]=true;
 const {e}=run([cue('a',1,keyframeFrom(on)),cue('b',3,keyframeFrom(off,'glide'))],6*RATE);
 const steps=e.sent.filter(x=>x.id.includes('glide')).sort((x,y)=>x.at-y.at);
 assert.ok(Math.abs(steps.at(-1).payload.mix.gains[5])<.01);assert.equal(steps.at(-1).payload.mix.mutes[5],false);
 assert.equal(e.sent.find(x=>x.id===`mix:${4*RATE}:b`).payload.mix.mutes[5],true);
});
test('a track muted at both ends of a fade stays muted, and shows its fader', () => {
 const a=defaultMix();a.mutes[5]=true;a.gains[1]=.2;const b=defaultMix();b.mutes[5]=true;b.gains[1]=.8;
 const mix=plannedMixAt(song([cue('a',2,keyframeFrom(a)),cue('b',4,keyframeFrom(b,'glide'))]),4*RATE);
 assert.equal(mix.mutes[5],true);assert.equal(mix.gains[5],1);assert.ok(Math.abs(mix.gains[1]-.5)<.01);
});
test('the first time only means once, through repeats and live loops', () => {
 const note=when=>({id:'n',at:address('m3'),when,action:{type:'marker.text',text:'Hi'}});
 const perform=when=>({...newPerformance({songId:'s',id:'p'}),cues:[note(when)],regions:[{id:'r',start:address('m3'),end:address('m5'),plays:3,family:'bars',onExit:[],further:null,passes:[1,2,3].map(i=>({id:`p${i}`,entry:[],program:null}))}]});
 const fires=when=>compilePerformance(perform(when),{measures,frames}).segments.filter(s=>s.actions?.some(a=>a.id==='n')).length;
 assert.equal(fires(undefined),3,'every pass');
 assert.equal(fires({first:true}),1,'the first pass only');
 const shared=song([{...cue('a',2,{type:'marker.text',text:'Hi'}),when:{first:true}}]);
 const e=engine(),r=new PerformanceRunner({performance:{cues:[],regions:[]},compiled:shared,grid:{measures,frames},engine:e,baseMix:defaultMix(),sections:[]});
 const program=shared.segments[0].actions;assert.equal(program[0].first,true);
 assert.equal(r.loopSegment({id:'l',kind:'bars',start:0,end:RATE,pass:0,program,startState:{}}).actions.length,0,'a loop going round doesn\'t count as the first time');
 assert.equal(r.loopSegment({id:'l',kind:'bars',start:0,end:RATE,pass:0,program:[{...program[0],first:false}],startState:{}}).actions.length,1);
});
test('the list names a loop and how many times it plays', () => {
 assert.deepEqual(repeatWords({plays:2},50,59),{title:'Loop bars 50 to 59',plays:'2 plays in all'});
 assert.deepEqual(repeatWords({plays:'live'},7,7),{title:'Loop bar 7',plays:'Until you leave it'});
});
test('the list says when an action is only the first time', () => {
 assert.equal(playWords({},{kind:'shared'}),'Every play');
 assert.equal(playWords({when:{first:true}},{kind:'shared'}),'First time only');
 assert.equal(playWords({when:{first:true}},{kind:'pass',index:1,passId:'x'},{plays:3}),'Pass 2 of 3, first time only');
 assert.equal(playWords({enabled:false},{kind:'shared'}),'Off · Every play');
});
test('a fade with nothing before it starts from the start of the song', () => {
 const off=defaultMix();off.gains[0]=0;
 const seg=song([cue('b',3,keyframeFrom(off,'glide'))]).segments[0];
 const glide=seg.actions.find(a=>a.glide);assert.equal(glide.frame,0);assert.equal(glide.action.frames,4*RATE);
});
test('a live change during a fade wins, for the steps still to come', () => {
 const low=defaultMix();low.gains[5]=0;
 const {r,e}=run([cue('b',8,keyframeFrom(low,'glide'))],2*RATE);
 r.setLive('track.lead.gain',.5);
 for(let at=2*RATE;at<=5*RATE;at+=RATE/4)r.tick({played:at,source:at,heard:at,state:'playing',now:at/RATE});
 const later=e.sent.filter(x=>x.id.includes('glide')&&x.at>3*RATE);
 assert.ok(later.length);for(const s of later)assert.equal(s.payload.mix.gains[5],.5);
});
for(const move of ['instant','glide'])test(`a hand mute holds through a keyframe that un-mutes it, and the keyframe's other changes still happen (${move})`, () => {
 // bass muted by the plan, then by hand; a keyframe at bar 8 un-mutes bass and mutes lead
 const muted=defaultMix();muted.mutes[0]=true;const next=defaultMix();next.mutes[5]=true;
 const cues=[cue('a',1,keyframeFrom(muted)),cue('b',8,keyframeFrom(next,move))];
 const compiled=song(cues),e=engine();
 const r=new PerformanceRunner({performance:{cues,regions:[]},compiled,grid:{measures,frames},engine:e,baseMix:defaultMix(),sections:[]});
 r.start(0);const tick=at=>r.tick({played:at,source:at,heard:at,state:'playing',now:at/RATE});
 for(let at=0;at<=3*RATE;at+=RATE/4)tick(at);
 assert.equal(r.setLive('track.bass.mute',true).accepted,true);                 // the click on bass's M
 for(let at=3*RATE;at<=20*RATE;at+=RATE/4)tick(at);
 const after=e.sent.filter(x=>x.payload?.kind==='mix'&&x.at>=3*RATE).sort((x,y)=>x.at-y.at);   // bars are 2 s here: the keyframe is at 14 s
 assert.ok(after.length,'the keyframe ran');
 for(const x of after)assert.equal(x.payload.mix.mutes[0],true,'bass stays muted, as you left it');
 assert.equal(after.at(-1).payload.mix.mutes[5],true,'lead is muted, as the keyframe says');
 r.release({property:'track.bass.mute'});tick(20.25*RATE);
 assert.equal(e.sent.filter(x=>x.payload?.kind==='mix').sort((x,y)=>x.at-y.at).at(-1).payload.mix.mutes[0],false,'let go of it and the keyframe has it again');
});
test('the mix a keyframe starts from is the plan at that spot', () => {
 const low=defaultMix();low.gains[1]=.3;
 const compiled=song([cue('a',2,keyframeFrom(low))]);
 assert.equal(plannedMixAt(compiled,1*RATE).gains[1],1);
 assert.equal(plannedMixAt(compiled,3*RATE).gains[1],.3);
});

test('a planned move is a moment, and waits until it is heard', () => {
 const action={type:'command',command:'section-step',params:{direction:1}};
 assert.equal(checkAction(action),null);assert.equal(isOneShot(action),true);assert.deepEqual(writesOf(action),[]);
 assert.ok(checkAction({type:'command',command:'format-disk'}));
 let now=0,ran=[];const timers=[];
 const out=createCommandOut({timeOf:at=>at,run:a=>ran.push(a),now:()=>now,setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer:id=>{timers[id-1].fn=()=>{};}});
 out.event({type:'oneshot',atPlayed:1000,action,leadMs:0});
 assert.equal(ran.length,0);assert.ok(timers.at(-1).ms<=250);
 now=1000;timers.at(-1).fn();
 assert.equal(ran.length,1);assert.equal(out.waiting,0);
});
test('a planned move that is taken back never happens', () => {
 const action={type:'command',command:'stop',params:{}};
 let ran=0;const timers=[];
 const out=createCommandOut({timeOf:at=>at,run:()=>ran++,now:()=>0,setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:id=>{timers[id-1]=()=>{};}});
 out.event({type:'oneshot',atPlayed:1000,action});
 out.event({type:'withdrawn',atPlayed:500});
 assert.equal(out.waiting,0);timers[0]();assert.equal(ran,0);
 out.event({type:'oneshot',atPlayed:1000,action});out.event({type:'cleanup'});assert.equal(out.waiting,0);
});

test('standing still, the plan at a spot says what the mixer and speed should show', () => {
 const low=defaultMix();low.gains[5]=.2;const high=defaultMix();high.gains[5]=.8;
 const compiled=song([cue('a',2,keyframeFrom(low)),cue('b',4,keyframeFrom(high,'glide')),cue('c',6,{type:'rate.set',percent:80})]);
 assert.equal(plannedMixAt(compiled,1*RATE).gains[5],1);
 assert.equal(plannedMixAt(compiled,2*RATE).gains[5],.2);
 assert.ok(Math.abs(plannedMixAt(compiled,4*RATE).gains[5]-.5)<.01,'halfway through the fade');
 assert.equal(plannedMixAt(compiled,6*RATE).gains[5],.8);
 assert.equal(plannedStateAt(compiled,9*RATE).rate,undefined);
 assert.equal(plannedStateAt(compiled,10*RATE).rate,80);
 assert.equal(plannedStateAt(compiled,frames+RATE).rate,80,'past the end, the end');
});
test('the mixer shows a fade as it goes', () => {
 const low=defaultMix();low.gains[5]=.2;const high=defaultMix();high.gains[5]=.8;
 const {r}=run([cue('a',2,keyframeFrom(low)),cue('b',4,keyframeFrom(high,'glide'))],4*RATE);
 assert.ok(Math.abs(r.fadingMix(4*RATE).gains[5]-.5)<.01);
 assert.equal(r.fadingMix(1*RATE),null);
});
test('an action past the end of a repeat, filed under one of its passes, moves to Every play where it plays', async () => {
 const {rehomeStrayCues}=await import('../chordbuddy/web/performance-model.js');
 const position=at=>Number(at.measure.slice(1))*2;                       // bar n starts at 2n s
 const key=keyframeFrom(defaultMix(),'glide');
 const perf={...newPerformance({songId:'s',id:'p'}),cues:[{id:'s1',at:address('m2'),action:key}],
  regions:[{id:'r',start:address('m4'),end:address('m8'),plays:2,family:'section',further:{entry:[],program:null},onExit:[],
   passes:[{id:'p1',entry:[],program:[{id:'in',at:address('m5'),action:key,from:'x'},{id:'out',at:address('m8'),action:key,from:'y'},{id:'far',at:address('m12'),action:key}]},{id:'p2',entry:[],program:null}]}]};
 const {performance:fixed,moved}=rehomeStrayCues(perf,position);
 assert.equal(moved,2);
 assert.deepEqual(fixed.regions[0].passes[0].program.map(c=>c.id),['in'],'what is inside the repeat stays with the pass');
 assert.deepEqual(fixed.cues.map(c=>c.id),['s1','out','far']);assert.ok(!('from' in fixed.cues[1]));
 assert.equal(fixed.regions[0].passes[1].program,null);
 assert.equal(rehomeStrayCues(fixed,position).performance,fixed,'nothing to move: the same arrangement back');
 const compiled=compilePerformance(fixed,{measures,frames});
 assert.ok(compiled.segments.some(s=>s.actions?.some(a=>a.id==='far'||a.action===key&&a.frame>=24*RATE)),'and now it plays');
});

test('a tempo flag plays as the speed for that tempo where it sits, reads as BPM, and says when the speed can’t reach it', () => {
 const item=PLAN_ITEMS.find(i=>i.id==='tempo-set');
 const start=item.start({...ctx,tempo:90});assert.equal(start.bpm,90);
 const flag=item.make({...start,bpm:72});
 assert.equal(flag.type,'rate.set');assert.equal(flag.percent,80);assert.equal(checkAction(flag),null);
 assert.equal(describeAction(flag),'Set the tempo to 72 BPM');assert.equal(itemFor(flag).id,'tempo-set','opens as a tempo');
 assert.match(checkAction(item.make({...start,bpm:200})),/45 to 112 BPM/);
 assert.match(checkAction(item.make({bpm:80,base:null})),/tempo isn’t known/);
 assert.equal(itemFor({type:'rate.set',percent:80}).id,'speed-set','a speed flag is still a speed');
});
