// The acceptance matrix for one song, run on the real compiler, runner and mixer. Samples carry their source frame, so these check what was played.
import test from 'node:test';
import assert from 'node:assert/strict';
import {newPerformance,addRepeat,address,editPass} from '../chordbuddy/web/performance-model.js';
import {addressPosition} from '../chordbuddy/web/performance-compiler.js';
import {fourBarRange,sectionRange,nextBarline,policyFor} from '../chordbuddy/web/performance-runner.js';
import {Sim,grid,RATE} from './performance-sim.mjs';

const G=grid();                                  // bars of 2 seconds
const pos=addressPosition(G.measures);
const SECTIONS=[{id:'a',name:'Intro',start:0,end:16},{id:'b',name:'Verse',start:16,end:48},{id:'c',name:'Chorus',start:48,end:120}];
let n=0;const uid=()=>`id${++n}`;
const bar=i=>address(`m${i}`);
const song=()=>newPerformance({songId:'s',id:'p'});
const mute=(track,value=true)=>({type:'track.set',track,mute:value});
const cue=(id,i,action,extra={})=>({id,at:bar(i),action,...extra});
const sim=(performance=song(),o={})=>new Sim({performance,sections:SECTIONS,...o});
const F=s=>Math.round(s*RATE);
const seconds=x=>x.toFixed(3);
void seconds;

test('a finite repeat plays exact passes, then the song goes on: sample by sample', () => {
 const s=sim(addRepeat(song(),{start:bar(1),end:bar(3),plays:3,id:'r'},uid));
 s.runSeconds(16);
 const spans=s.sections();
 assert.deepEqual(spans.slice(0,2),[[.014,4],[0,4]]);
 assert.equal(spans.length,3,'three plays: the third runs straight on into the rest of the song');
 assert.equal(spans[2][0],0);assert.ok(spans[2][1]>4);
 assert.equal(s.runner.current.regionId,null);
});

test('L loops four real bars from the section start, and only starts wrapping at their end', () => {
 const s=sim();s.runSeconds(21);                 // in bar 11: section starts at bar 9, so bars 9-12
 const r=s.runner.pressLoop('bars');
 assert.equal(r.type,'activate');assert.equal(r.label,'bars 9–12');assert.equal(r.boundary,F(24));
 s.runSeconds(15);
 const spans=s.sections();
 assert.deepEqual(spans[1],[16,24]);assert.equal(spans[2][0],16);
 assert.equal(spans[0][1],24,'the first pass carries on to the end of the range');
});

test('L then L: finishes the current pass, never at an intervening bar, with no extra wrap', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('bars');s.runSeconds(5);  // now in pass 2, about 18 s
 const r=s.runner.pressLoop('bars');assert.equal(r.type,'exit');
 s.runSeconds(12);
 const spans=s.sections();
 assert.equal(spans.length,2);
 assert.equal(spans[0][1],24);assert.deepEqual([spans[1][0]],[16]);
 assert.ok(spans[1][1]>24,'it carries straight on past the loop end');
 assert.equal(s.runner.loop,null);
});

test('L then R: finishes the pass, then the captured section from its start, without one more pass of the old loop', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('bars');s.runSeconds(5);
 const r=s.runner.pressLoop('section');
 assert.equal(r.type,'switch');assert.equal(r.label,'Verse · bars 9–24');
 s.runSeconds(20);
 const spans=s.sections();
 assert.equal(spans.length,3);
 assert.equal(spans[0][1],24);assert.deepEqual(spans[1],[16,24],'the old loop finishes its pass');
 assert.equal(spans[2][0],16);assert.ok(spans[2][1]>24,'the new loop runs on through to its own end');
 assert.equal(s.runner.loop.kind,'section');assert.equal(s.runner.loop.end,F(48));
});

test('R then L: finishes the section pass, then four bars captured when asked', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('section');s.runSeconds(1.2);
 const r=s.runner.pressLoop('bars');assert.equal(r.type,'switch');assert.equal(r.label,'bars 9–12');
 s.runSeconds(40);
 const spans=s.sections();
 assert.equal(spans[0][1],48);assert.deepEqual(spans[1].slice(0,2),[16,24]);
 assert.equal(spans[2][0],16);
});

test('leaving a moment before the wrap: the wrap already in the engine is replaced, and the music goes straight on', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('bars');s.runSeconds(2.2);  // 23.2: the wrap at 24 is already committed
 assert.equal(s.runner.boundary?.jumped,true);
 assert.equal(s.runner.pressLoop('bars').type,'exit');
 s.runSeconds(6);
 assert.equal(s.sections().length,1,JSON.stringify(s.sections()));
 assert.equal(s.runner.loop,null);
});

test('switching a moment before the wrap: the new loop starts at that very barline', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('bars');s.runSeconds(2.2);
 assert.equal(s.runner.pressLoop('section').type,'switch');
 s.runSeconds(3);
 const spans=s.sections();
 assert.equal(spans[0][1],24);assert.equal(spans[1][0],16);
 assert.equal(s.runner.current.loopId,s.runner.loop.id);assert.equal(s.runner.loop.kind,'section');
});

test('too late to change: the wrap that is already happening stands, and the exit takes the next end of the pass', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('bars');s.runTo(Math.round(24*RATE)-100);
 s.runner.tick(s.report());
 s.runner.pressLoop('bars');
 s.runSeconds(10);
 const spans=s.sections();
 assert.equal(spans[0][1],24);assert.equal(spans[1][0],16);
 assert.equal(spans.length,2,'one more pass, then straight on');
 assert.ok(spans[1][1]>24);
});

test('R then R leaves after the pass', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('section');s.runSeconds(5);
 assert.equal(s.runner.pressLoop('section').type,'exit');
 s.runSeconds(30);
 assert.equal(s.sections().length,1);assert.ok(s.sections()[0][1]>48);
});

test('the same key again cancels a pending change, and the other key replaces it', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('bars');s.runSeconds(5);
 s.runner.pressLoop('bars');
 assert.equal(s.runner.pressLoop('bars').type,'cancelled');
 assert.ok(s.runner.loop,'still looping');
 s.runSeconds(10);
 assert.ok(s.sections().length>=2);
 s.runner.pressLoop('bars');
 const replaced=s.runner.pressLoop('section');
 assert.equal(replaced.type,'switch');assert.equal(s.runner.pendingLoop.type,'switch');
});

test('a queued activation cancelled before its end means the song just goes on', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('bars');
 assert.equal(s.runner.pressLoop('bars').type,'cancelled');
 s.runSeconds(10);
 assert.equal(s.sections().length,1);
});

test('Exit always exits, whatever key made the loop', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('section');s.runSeconds(1.2);
 assert.equal(s.runner.pressExit().type,'exit');
 s.runSeconds(30);assert.equal(s.sections().length,1);
});

test('an authored finite loop: matching key exits early, the other key switches to a live loop, and it does not re-arm', () => {
 const authored=()=>addRepeat(song(),{start:bar(9),end:bar(11),plays:5,family:'bars',id:'r'},uid);
 const a=sim(authored());a.runSeconds(21);
 assert.equal(a.runner.current.passIndex,1);
 assert.equal(a.runner.pressLoop('bars').type,'exit');
 a.runSeconds(10);
 const spans=a.sections();
 assert.deepEqual(spans.slice(0,2).map(x=>x[1]),[20,spans[1][1]]);
 assert.equal(spans.length,2,'no more wraps');
 const b=sim(authored());b.runSeconds(21);
 assert.equal(b.runner.pressLoop('section').type,'switch');
 b.runSeconds(40);
 assert.ok(!b.runner.path.some(p=>p.regionId==='r'),'its unused passes are gone');
 assert.equal(b.runner.loop.kind,'section');
});

test('an until-released loop never stops by itself, and a further pass adds exactly one pass to the estimate', () => {
 const s=sim(addRepeat(song(),{start:bar(1),end:bar(3),plays:'live',id:'r'},uid));
 const first=s.runner.durations();
 assert.equal(first.totalMusic,120+12);
 s.runSeconds(15.9);                              // the last budgeted pass
 assert.equal(s.runner.current.passIndex,3);
 assert.ok(Math.abs(s.runner.durations().totalMusic-132)<.1,'starts 2-4 were already counted');
 s.runSeconds(1);                                 // pass 5 began
 assert.equal(s.runner.current.passIndex,4);
 assert.ok(Math.abs(s.runner.durations().totalMusic-136)<.1,`one more pass: ${s.runner.durations().totalMusic}`);
 s.runSeconds(4);
 assert.ok(Math.abs(s.runner.durations().totalMusic-140)<.1);
 assert.equal(s.runner.current.further,true);
 assert.equal(s.runner.pressLoop('bars').type,'exit');
 s.runSeconds(6);
 assert.equal(s.runner.current.regionId,null);
 assert.ok(s.level.length>0);
});

test('exiting early takes away only the unused estimate: 144 becomes 128', () => {
 const s=sim(addRepeat(song(),{start:bar(10),end:bar(14),plays:'live',id:'r'},uid));
 assert.equal(s.runner.durations().totalMusic,144);
 s.runSeconds(29);                                 // pass 2 of the 8-second range starting at 18
 assert.equal(s.runner.current.passIndex,1);
 s.runner.pressLoop('bars');
 assert.ok(Math.abs(s.runner.durations().totalMusic-128)<.01,`${s.runner.durations().totalMusic}`);
 s.runner.pressLoop('bars');
 assert.ok(Math.abs(s.runner.durations().totalMusic-144)<.01,'cancelling brings the estimate back');
});

test('a live loop adds time only as passes begin: pressing and cancelling cannot double-count', () => {
 const s=sim();s.runSeconds(21);
 s.runner.pressLoop('bars');assert.ok(Math.abs(s.runner.durations().totalMusic-120)<.01,'a queued loop adds nothing');
 s.runner.pressLoop('bars');assert.ok(Math.abs(s.runner.durations().totalMusic-120)<.01);
 s.runner.pressLoop('bars');s.runSeconds(3.2);       // first wrap at 24
 assert.ok(Math.abs(s.runner.durations().totalMusic-128)<.1,`${s.runner.durations().totalMusic}`);
 s.runSeconds(8);
 assert.ok(Math.abs(s.runner.durations().totalMusic-136)<.1,`${s.runner.durations().totalMusic}`);
});

test('a jump: music continues to the next barline, then starts exactly at the target bar', () => {
 const s=sim();s.runSeconds(5.3);                     // in bar 3 (4-6)
 const r=s.runner.navigate(F(41));                    // a click inside bar 21
 assert.equal(r.boundary,F(6));assert.equal(r.target,F(40));
 s.runSeconds(3);
 const spans=s.sections();
 assert.equal(spans[0][1],6);assert.equal(spans[1][0],40);
 assert.equal(spans.length,2);
});

test('a request a moment before a barline takes the next one: never in the middle of a bar', () => {
 const s=sim();s.runTo(F(6)-128);
 const r=s.runner.navigate(F(40));
 assert.equal(r.boundary,F(8));
 s.runSeconds(3);
 assert.equal(s.sections()[0][1],8);
});

test('two quick jumps: the latest wins, and repeated arrows step the queued target', () => {
 const s=sim();s.runSeconds(5.3);
 s.runner.navigate(F(40));s.runner.navigate(F(80));
 s.runSeconds(2);
 assert.equal(s.sections()[1][0],80);
 const t=sim();t.runSeconds(5.3);
 t.runner.stepBars(1);t.runner.stepBars(1);t.runner.stepBars(1);
 assert.equal(t.runner.pendingNav.target,F(10));
 t.runSeconds(2);
 assert.equal(t.sections()[1][0],10);
});

test('target audio not here: the music keeps going, a status says so, and the jump lands at a later barline', () => {
 const s=sim(song(),{withhold:f=>f===F(100)});s.runSeconds(5.3);
 s.runner.navigate(F(100));
 s.runSeconds(1);
 assert.equal(s.runner.waiting.target,F(100));assert.ok(s.runner.waiting.at>=F(6));
 assert.equal(s.sections().length,1);
 s.release();
 s.runSeconds(3);
 const spans=s.sections();
 assert.equal(spans[0][1],8);assert.equal(spans[1][0],100);
 assert.equal(s.runner.waiting,null);
});

test('cancelling a queued jump: the song just goes on', () => {
 const s=sim();s.runSeconds(1);s.runner.navigate(F(40));s.runner.cancelNavigation();
 s.runSeconds(5);assert.equal(s.sections().length,1);
});

test('a jump out of a live loop goes at the next barline, not the end of the pass', () => {
 const s=sim();s.runSeconds(21);s.runner.pressLoop('bars');s.runner.navigate(F(80));
 s.runSeconds(3);
 assert.equal(s.sections()[0][1],22);assert.equal(s.sections()[1][0],80);
 assert.equal(s.runner.loop,null);
});

test('planned mix changes land on their exact output frame', () => {
 const s=sim({...song(),cues:[cue('m',5,mute('bass'))]});
 s.runSeconds(12);
 const change=s.mixes.find(x=>x.id==='mix:'+F(8)+':m');
 assert.ok(change,'scheduled');assert.equal(change.played,F(8));
 assert.equal(change.mix.mutes[0],true);
 assert.equal(s.level[F(8)-1],F(8)-1,'untouched before the bar');
 assert.equal(s.level[F(8)+1000],0,'silent shortly after');
});

test('each pass keeps its own mix, and state is restored at the wrap', () => {
 let p=addRepeat(song(),{start:bar(1),end:bar(3),plays:3,id:'r'},uid);
 const [a,b,c]=p.regions[0].passes.map(x=>x.id);
 p=editPass(p,'r',a,x=>x.push(cue('one',2,mute('bass'))),pos,uid);
 p=editPass(p,'r',b,x=>x.push(cue('two',2,mute('bass',false))),pos,uid);
 void c;
 const s=sim(p);s.runSeconds(12);
 assert.equal(s.level[F(1)],F(1),'Pass 1 before its cue');
 assert.equal(s.level[F(3)],0,'Pass 1 muted at bar 2');
 assert.equal(s.level[F(4)+1000],0,'Pass 2 starts as Pass 1 left it');
 assert.equal(s.level[F(7)],F(3),'Pass 2 unmutes at its own bar 2');
 assert.equal(s.level[F(9)],F(1),'Pass 3 goes on unmuted, with no program of its own');
});

test('user wins by default: a hand mute survives later planned changes to it, and only it', () => {
 const s=sim({...song(),cues:[cue('u',6,mute('bass',false)),cue('d',6,mute('drums'))]});
 s.runSeconds(1);
 assert.deepEqual(s.runner.setLive('track.bass.mute',true),{accepted:true});
 s.runSeconds(12);
 assert.equal(s.level[F(12)],0,'the planned unmute did not undo it');
 assert.equal(s.mixes.at(-1).mix.mutes[1],true,'the drums still followed the plan');
 assert.ok(s.runner.log.some(l=>l.type==='suppressed'&&l.property==='track.bass.mute'));
 s.runner.release({property:'track.bass.mute'});
 s.runSeconds(1);
 assert.equal(s.level.at(-1)>0,true,'releasing brings back the plan');
});

test('until the next cue: the planned change takes it back', () => {
 const s=sim({...song(),cues:[cue('u',6,mute('bass',true))]},{policy:{all:'next-cue'}});
 s.runSeconds(1);s.runner.setLive('track.bass.mute',false);
 s.runSeconds(12);
 assert.equal(s.runner.overrides.size,0);
 assert.equal(s.level.at(-1),0,'muted by the plan');
});

test('until the next section: restored when the section changes', () => {
 const s=sim({...song(),initial:[mute('bass')]},{policy:{tracks:'next-section',all:'until-released'}});
 s.runSeconds(1);
 assert.equal(s.level.at(-1),0);
 s.runner.setLive('track.bass.mute',false);
 s.runSeconds(2);assert.ok(s.level.at(-1)>0);
 s.runSeconds(15);
 assert.equal(s.runner.overrides.size,0);assert.equal(s.level.at(-1),0,'back to the plan in the Verse');
});

test('locked: a deliberate change does nothing and says why; other domains are unaffected', () => {
 const s=sim(song(),{policy:{all:'until-released',tracks:'locked'}});
 const r=s.runner.setLive('track.bass.mute',true);
 assert.equal(r.accepted,false);assert.match(r.reason,/locked/);
 assert.equal(s.runner.setLive('visual.scene','abstract').accepted,true);
 assert.equal(policyFor({all:'locked',rate:'next-cue'},'rate'),'next-cue');
});

test('a policy change keeps live values, unless asked to resume the plan', () => {
 const s=sim();s.runner.setLive('track.bass.gain',.5);
 s.runner.setPolicy({all:'next-section'});
 assert.equal(s.runner.overrides.get('track.bass.gain').policy,'next-section');
 s.runner.setPolicy({all:'until-released'},{resume:true});
 assert.equal(s.runner.overrides.size,0);
});

test('a jump keeps a live change, and sets the plan of where it lands', () => {
 const s=sim({...song(),cues:[cue('m',10,mute('drums'))]});
 s.runSeconds(1);
 s.runner.setLive('track.bass.gain',.25);
 s.runner.navigate(F(30));
 s.runSeconds(3);
 const whole=s.mixes.filter(x=>String(x.id).includes('whole')).at(-1);
 assert.equal(whole.mix.mutes[1],true,'the plan at bar 16 has the drums muted, though that cue was skipped');
 assert.equal(whole.mix.gains[0],.25,'the live change stays');
});

test('skipped one-shots are never played to catch up, and a repeat replays them once per traversal', () => {
 const s=sim({...song(),cues:[cue('flash',10,{type:'visual.trigger',input:'flash'})]});
 s.runSeconds(1);s.runner.navigate(F(40));s.runSeconds(3);
 assert.equal(s.out.filter(e=>e.type==='oneshot').length,0);
 const p=addRepeat({...song(),cues:[cue('flash',2,{type:'visual.trigger',input:'flash'})]},{start:bar(1),end:bar(3),plays:3,id:'r'},uid);
 const t=sim(p);t.runSeconds(13);
 const shots=t.out.filter(e=>e.type==='oneshot');
 assert.equal(shots.length,3);assert.equal(new Set(shots.map(e=>e.id)).size,3);
 assert.deepEqual(shots.map(e=>e.atPlayed),[F(2),F(6),F(10)]);
});

test('manual L replays its bars’ program every pass: timed visuals, from the captured start state', () => {
 const p={...song(),cues:[cue('before',8,{type:'visual.scene',scene:'one'}),cue('in',11,{type:'visual.trigger',input:'flash'}),cue('later',14,{type:'visual.scene',scene:'never'})]};
 const s=sim(p);s.runSeconds(21);s.runner.pressLoop('bars');s.runSeconds(20);
 const shots=s.out.filter(e=>e.type==='oneshot'&&e.action.input==='flash');
 assert.ok(shots.length>=3,`fired ${shots.length}`);
 const replay=s.out.filter(e=>e.type==='loop-replay');
 assert.ok(replay.length>=2);assert.equal(replay[0].state['visual.scene'],'one');
 assert.ok(!s.out.some(e=>e.type==='visual'&&e.action.scene==='never'),'no later planned scene while holding the loop');
});

test('a live loop over Pass 2 stays Pass 2: it never moves on to Pass 3’s visuals', () => {
 let p=addRepeat(song(),{start:bar(9),end:bar(13),plays:3,family:'section',id:'r'},uid);
 const [a,b,c]=p.regions[0].passes.map(x=>x.id);
 p=editPass(p,'r',a,x=>x.push(cue('v1',10,{type:'visual.scene',scene:'pass1'})),pos,uid);
 p=editPass(p,'r',b,x=>x.push(cue('v2',10,{type:'visual.scene',scene:'pass2'})),pos,uid);
 p=editPass(p,'r',c,x=>x.push(cue('v3',10,{type:'visual.scene',scene:'pass3'})),pos,uid);
 const s=sim(p);s.runSeconds(25.5);
 assert.equal(s.runner.current.passIndex,1);
 s.runner.pressLoop('bars');s.runSeconds(30);
 const scenes=s.out.filter(e=>e.type==='visual').map(e=>e.action.scene);
 assert.ok(scenes.filter(x=>x==='pass2').length>=2,JSON.stringify(scenes));
 assert.ok(!scenes.includes('pass3'),JSON.stringify(scenes));
});

test('a hand-picked scene holds through a replay, while unrelated flashes carry on', () => {
 const p={...song(),cues:[cue('sc',10,{type:'visual.scene',scene:'planned'}),cue('fl',10,{type:'visual.trigger',input:'flash'})]};
 const s=sim(p);s.runSeconds(19);s.runner.pressLoop('bars');
 s.runner.setLive('visual.scene','mine');
 s.out.length=0;s.runSeconds(20);
 assert.ok(!s.out.some(e=>e.type==='visual'&&e.action.scene==='planned'));
 assert.ok(s.out.some(e=>e.type==='oneshot'));
 assert.ok(s.out.some(e=>e.type==='suppressed'));
});

test('holds stop the music for their length, then it goes on from the same spot', () => {
 const s=sim({...song(),holds:[{id:'h',at:bar(3),seconds:2}]});
 s.runSeconds(3.9);assert.equal(s.runner.status,'playing');
 s.runSeconds(.3);assert.equal(s.runner.status,'holding');
 assert.ok(s.events.some(e=>e.type==='held'&&e.played===F(4)));
 s.runSeconds(1);assert.equal(s.runner.status,'holding');
 s.runSeconds(1.2);assert.equal(s.runner.status,'playing');
 s.runSeconds(1);
 assert.ok(s.mixer.frame>F(4));
});

test('a wait for a control waits until it is pressed', () => {
 const s=sim({...song(),holds:[{id:'h',at:bar(3),seconds:null,expected:30}]});
 s.runSeconds(9);assert.equal(s.runner.status,'holding');
 assert.equal(s.mixer.frame,F(4));
 assert.equal(s.runner.endHold(),true);
 s.runSeconds(1);assert.ok(s.mixer.frame>F(4));
});

test('pause freezes the music and the cues; resuming plays on with no repeat', () => {
 const s=sim({...song(),cues:[cue('m',3,{type:'visual.trigger',input:'flash'})]});
 s.runSeconds(1);s.runner.pause();
 const frame=s.mixer.frame,played=s.mixer.played;
 s.runSeconds(5);
 assert.equal(s.mixer.played,played);assert.equal(s.mixer.frame,frame);
 assert.equal(s.out.filter(e=>e.type==='oneshot'&&e.atPlayed<=played).length,0);
 s.runner.resume();s.runSeconds(4);
 assert.equal(s.out.filter(e=>e.type==='oneshot').length,1);
});

test('a jump while paused moves there at once, snapped to the bar, and stays paused', () => {
 const s=sim();s.runSeconds(1);s.runner.pause();s.runSeconds(.1);
 s.give(F(40));
 s.runner.navigate(F(41));
 assert.equal(s.runner.status,'paused');assert.equal(s.mixer.position,F(40));
 s.runner.resume();s.runSeconds(1);
 const v=s.level.at(-1);assert.ok(v>F(40)&&v<F(42));
});

test('the song ends and says so', () => {
 const small=grid([4,4]);
 const s=new Sim({performance:song(),g:small,sections:[]});
 s.runSeconds(5);
 assert.equal(s.runner.status,'finished');assert.ok(s.out.some(e=>e.type==='finished'));
});

test('ranges: four bars count from the section; a section edge and the song end are handled; shorter is labeled', () => {
 assert.equal(fourBarRange(G.measures,SECTIONS,F(21)).label,'bars 9–12');
 const offset=[{id:'x',start:6,end:20}];
 assert.equal(fourBarRange(G.measures,offset,F(7)).label,'bars 4–7');
 const across=[{id:'x',start:0,end:4},{id:'y',start:4,end:120}];
 assert.equal(fourBarRange(G.measures,across,F(1)).label,'bars 1–4','four actual bars, across the section edge');
 assert.equal(fourBarRange(G.measures,SECTIONS,F(119)).label,'bars 57–60');
 const tiny=grid([4,4]);
 const r=fourBarRange(tiny.measures,[],0);assert.equal(r.short,true);assert.equal(r.label,'bars 1–2');
 assert.equal(sectionRange(G.measures,SECTIONS,F(20)).label,'Verse · bars 9–24');
 const faded=sectionRange(G.measures,SECTIONS,F(60),{trim:()=>({start:48,end:56})});
 assert.equal(faded.label,'Chorus · bars 25–28 (fade left out)');assert.equal(faded.end,F(56));
 assert.equal(nextBarline(G.measures,F(5)),F(6));assert.equal(nextBarline(G.measures,F(6)),F(8));
 assert.equal(nextBarline(G.measures,F(119)),F(120));assert.equal(nextBarline(G.measures,F(120)),null);
});

test('late answers from the engine: an old answer cannot move the music, and the latest request still wins', () => {
 const s=sim(song(),{lateAnswers:true});s.runSeconds(5.3);
 s.runner.navigate(F(40));
 s.runner.navigate(F(80));
 s.flushAnswers();
 s.runSeconds(2.5);
 const spans=s.sections();
 assert.equal(spans[0][1],6);assert.equal(spans[1][0],80,JSON.stringify(spans));
 assert.equal(spans.length,2);
});

test('a jump answered after the barline has gone is not acted on as if it were in time', () => {
 const s=sim(song(),{lateAnswers:true});s.runSeconds(5.3);
 s.runner.navigate(F(40));
 s.runSeconds(1);                                    // past bar 4's start, and the answer has not come
 assert.equal(s.waitingAnswers.length,1,'asked once, not once per report');
 s.late=false;s.flushAnswers();
 s.runSeconds(3);
 const spans=s.sections();
 assert.equal(spans.at(-1)[0],F(40)/RATE);
 assert.ok(Number.isInteger(spans[0][1]/2),`left on a barline: ${spans[0][1]}`);
});
