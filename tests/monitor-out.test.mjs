import test from 'node:test';
import assert from 'node:assert/strict';
import {AHEAD,beatsBetween,createMonitorOut,planClicks,planCue,planCueJump,practiceStretches,showStretches} from '../chordbuddy/web/monitor-out.js';
import {DEFAULT_MONITOR,lengthNote,readMonitor,songCount,songCountKey} from '../chordbuddy/web/monitor-strips.js';
import {countInOf,showSeconds} from '../chordbuddy/web/performance-duration.js';
import {checkAction,describeAction} from '../chordbuddy/web/performance-actions.js';
import {itemFor,searchPlan} from '../chordbuddy/web/performance-plan.js';

const RATE=44100;
const bars=n=>Array.from({length:n},(_,i)=>({start:i*2,end:i*2+2,beats:[0,.5,1,1.5].map(b=>i*2+b)}));
const stretch=(over={})=>({cycle:1,from:0,to:RATE*100,at:10,speed:1,...over});

test('beats come from the song, with the first of each bar marked', () => {
 const beats=beatsBetween(bars(2),RATE*1.5,RATE*2.6);
 assert.deepEqual(beats,[{frame:RATE*1.5,accent:false},{frame:RATE*2,accent:true},{frame:RATE*2.5,accent:false}]);
});
test('a pickup with beat 1 in it accents it, like any first beat', () => {
 const long=[{number:0,start:0,end:2.2,beats:[0,.7,1.4]},{number:1,start:2,end:4,beats:[2,2.5,3,3.5]}];
 assert.deepEqual(beatsBetween(long,0,RATE*2.1).map(b=>[+(b.frame/RATE).toFixed(2),b.accent]),[[0,true],[.5,false],[1,false],[1.5,false],[2,true]]);
});
test('a pickup bar clicks at bar 1’s tempo, counted back from bar 1, not at the beats found in it (Call Me)', () => {
 const callMe=[{number:0,start:.01,end:1.77,beats:[.01,.41,.77,1.1,1.43]},{number:1,start:1.77,end:4.43,beats:[1.77,2.43,3.11,3.77]}];
 assert.deepEqual(beatsBetween(callMe,0,RATE*3).map(b=>[+(b.frame/RATE).toFixed(2),b.accent]),[[.44,false],[1.11,false],[1.77,true],[2.43,false]]);
 assert.deepEqual(beatsBetween(callMe,RATE*.5,RATE*1.5).map(b=>+(b.frame/RATE).toFixed(2)),[1.11],'only what falls in the window');
 assert.equal(beatsBetween(bars(2),0,RATE*4).length,8,'no pickup, nothing added');
});
test('clicks go out a moment ahead, each one once', () => {
 const sent=new Set(),measures=bars(4);
 const first=planClicks({stretches:[stretch()],measures,now:10.2,sent});
 assert.deepEqual(first.map(e=>e.at),[10.5]);
 assert.equal(planClicks({stretches:[stretch()],measures,now:10.25,sent}).length,0,'not again');
 assert.deepEqual(planClicks({stretches:[stretch()],measures,now:10.7,sent}).map(e=>e.at),[11]);
});
test('a little wobble in where the music is never doubles or loses a click', () => {
 const sent=new Set(),measures=bars(4),at=[];
 for(let t=10;t<14;t+=.046){const wobble=Math.sin(t*50)*.002;at.push(...planClicks({stretches:[stretch({at:10+wobble})],measures,now:t,sent}));}
 const near=at.map(e=>Math.round(e.at*2)/2);
 assert.equal(new Set(near).size,near.length,'no doubles');
 assert.equal(near.length,8);
});
test('speed changes when a click lands', () => {
 const sent=new Set();
 assert.deepEqual(planClicks({stretches:[stretch({speed:.5})],measures:bars(2),now:10.8,sent}).map(e=>e.at),[11]);
});
test('going round a loop clicks its first beat again, on time', () => {
 const list=practiceStretches({source:RATE*3.8,at:20,speed:1,loop:{start:RATE*2,end:RATE*4},end:RATE*100,cycle:0});
 assert.equal(list[1].jumped,true);
 const clicks=planClicks({stretches:list,measures:bars(3),now:20,sent:new Set()});
 assert.deepEqual(clicks.map(e=>[+e.at.toFixed(3),e.accent]),[[20.2,true]]);
});
test('a repeat in a show clicks its way through the seam', () => {
 const runner={rate:100,traversal:5,current:{key:'a',start:0,end:RATE*4,startPlayed:0},boundary:{at:RATE*4,atPlayed:RATE*4,jumped:true,segment:{kind:'music',key:'b',start:RATE*2,end:RATE*4}}};
 const list=showStretches(runner,frame=>frame/RATE);
 const clicks=planClicks({stretches:list,measures:bars(3),now:3.9,sent:new Set()});
 assert.deepEqual(clicks.map(e=>[+e.at.toFixed(3),e.accent]),[[4,true]],'bar 2 again, at the seam');
});
test('a moment of buffering takes back nothing, but pausing does', async () => {
 const r=rig();r.out.setMonitor({click:{gain:.5,mute:false},cue:{gain:0,mute:true}});await settle();r.tick();await settle();
 r.snapshot.playing=false;r.snapshot.buffering=true;r.tick();await settle();
 assert.equal(r.calls.filter(c=>c[0]==='/api/monitor/cancel').length,0,'the click already sounding carries on');
 r.snapshot.playIntent=false;r.tick();await settle();
 assert.equal(r.calls.filter(c=>c[0]==='/api/monitor/cancel').length,1);
});
test('a flag can turn the click off for part of the song', () => {
 const clicks=planClicks({stretches:[stretch()],measures:bars(2),now:10.2,sent:new Set(),allowClick:()=>false});
 assert.equal(clicks.length,0);
});

test('the cue track starts just ahead, at the place the music will be by then', () => {
 const change=planCue({stretches:[stretch({from:RATE*5})],was:null,song:'v1',now:11,margin:.1});
 assert.equal(change.at,11.1);assert.ok(Math.abs(change.source-6.1)<1e-6);assert.equal(change.speed,1);
});
test('the cue track is left alone while it runs with the music', () => {
 const was={song:'v1',cycle:1,source:0,at:10,speed:1};
 assert.equal(planCue({stretches:[stretch()],was,song:'v1',now:30}),null);
 assert.equal(planCue({stretches:[stretch({at:10.02})],was,song:'v1',now:30}),null,'a small wobble is left alone');
});
test('the cue track is put back if the music moves away from it, or changes speed', () => {
 const was={song:'v1',cycle:1,source:0,at:10,speed:1};
 assert.ok(planCue({stretches:[stretch({at:10.2})],was,song:'v1',now:30}),'drifted');
 assert.equal(planCue({stretches:[stretch({speed:.75})],was,song:'v1',now:30}).speed,.75);
});
test('a jump that is coming is sent for its exact moment', () => {
 const list=[stretch({to:RATE*4}),{cycle:2,from:RATE*2,to:RATE*4,at:14,speed:1,jumped:true}];
 const was={song:'v1',cycle:1,source:0,at:10,speed:1};
 assert.equal(planCueJump({stretches:list,was,song:'v1',now:13}),null,'too far off');
 assert.deepEqual(planCueJump({stretches:list,was,song:'v1',now:13.8}),{at:14,song:'v1',cycle:2,source:2,speed:1});
 assert.equal(planCueJump({stretches:list,was:{...was,cycle:2},song:'v1',now:13.8}),null,'already sent');
});
test('music simply carrying on into the next segment leaves no seam', () => {
 const list=[stretch({to:RATE*4}),{cycle:2,from:RATE*4,to:RATE*8,at:14,speed:1}];
 assert.equal(planCueJump({stretches:list,was:{song:'v1',cycle:1,source:0,at:10,speed:1},song:'v1',now:13.8}),null);
});
test('a cue track waiting through a gap starts with the music, not before', () => {
 const change=planCue({stretches:[stretch({at:20})],was:null,song:'v1',now:18,margin:.1});
 assert.equal(change.at,20);assert.equal(change.source,0);
});

function rig(state={}){
 const calls=[];let listener=null;
 const api=async(path,body)=>{calls.push([path,body]);if(path==='/api/monitor/status')return {clock:1000};if(path==='/api/monitor/load')return {key:'v1'};return {};};
 const snapshot={songId:'s',playIntent:true,playing:true,rate:100,duration:100,loop:{enabled:false},seeks:0,...state};
 const transport={subscribe(f){listener=f;return ()=>{};},getSnapshot:()=>snapshot,getDiagnostics:()=>({state:'playing',sourceFrame:0,heardAt:10})};
 const out=createMonitorOut({api,transport,practice:()=>({song:'s',measures:bars(4)}),now:()=>10.2});
 return {calls,out,snapshot,tick:()=>listener(snapshot),scheduled:()=>calls.filter(c=>c[0]==='/api/monitor/schedule').flatMap(c=>c[1].events)};
}
const settle=()=>new Promise(r=>setTimeout(r,5));
test('nothing is asked of the sound engine while the click and cues are off', async () => {
 const r=rig();r.out.setMonitor({click:{gain:.5,mute:true},cue:{gain:.5,mute:true}});r.tick();await settle();
 assert.equal(r.calls.filter(c=>c[0]==='/api/monitor/schedule').length,0);
 assert.deepEqual(r.calls[0],['/api/monitor/gains',{click:.5,cue:.5}]);
});
test('turning the click on sends clicks on the server clock, and stopping takes them back', async () => {
 const r=rig();r.out.setMonitor({click:{gain:.5,mute:false},cue:{gain:0,mute:true}});await settle();r.tick();await settle();
 const clicks=r.scheduled().filter(e=>e.kind==='click');
 assert.ok(clicks.length);assert.ok(clicks[0].at>1000,'on the server’s clock');
 r.snapshot.playing=false;r.snapshot.playIntent=false;r.tick();await settle();
 assert.ok(r.calls.some(c=>c[0]==='/api/monitor/cancel'));
});
test('a seek starts the plan over', async () => {
 const r=rig();r.out.setMonitor({click:{gain:.5,mute:false},cue:{gain:0,mute:true}});await settle();r.tick();await settle();
 const before=r.calls.filter(c=>c[0]==='/api/monitor/cancel').length;
 r.snapshot.seeks=1;r.tick();await settle();
 assert.equal(r.calls.filter(c=>c[0]==='/api/monitor/cancel').length,before+1);
});
test('moving the playhead while stopped (the back button), then Play: the count-in plays', async () => {
 const r=rig({playIntent:false,playing:false});r.out.setMonitor({click:{gain:.5,mute:true},cue:{gain:0,mute:true}});await settle();r.tick();await settle();
 r.snapshot.seeks=3;r.tick();                                 // back to the start, stopped
 r.out.countIn({song:'s',until:RATE*2,clicks:[{k:'p:0',at:10.3,accent:true},{k:'p:1',at:10.5,accent:false}]});
 r.snapshot.playIntent=true;r.tick();await settle();r.tick();await settle();
 assert.deepEqual(r.scheduled().filter(e=>e.kind==='click').map(e=>e.accent),[true,false]);
});
test('a seek just after Play keeps the count-in Play asked for', async () => {
 const r=rig();r.out.setMonitor({click:{gain:.5,mute:true},cue:{gain:0,mute:true}});await settle();r.tick();await settle();
 r.out.countIn({song:'s',until:RATE*2,clicks:[{k:'q:0',at:10.3,accent:true}]});r.snapshot.seeks=9;r.tick();await settle();r.tick();await settle();
 assert.equal(r.scheduled().filter(e=>e.kind==='click').length,1);
});
test('a song with a cue track gets it loaded, then played', async () => {
 const r=rig();r.out.setMonitor({click:{gain:0,mute:true},cue:{gain:.8,mute:false}});await settle();r.tick();await settle();r.tick();await settle();
 assert.ok(r.calls.some(c=>c[0]==='/api/monitor/load'));
 const cue=r.scheduled().find(e=>e.kind==='cue');
 assert.equal(cue.song,'v1');assert.equal(cue.speed,1);
});

test('saved fader settings: anything wrong falls back', () => {
 assert.deepEqual(readMonitor('nonsense'),DEFAULT_MONITOR);
 assert.deepEqual(readMonitor(JSON.stringify({click:{gain:.3,mute:false},cue:{gain:9}})),{click:{gain:.3,mute:false},cue:{gain:.8,mute:false}});
});
test('a song keeps its own count-in, off until you choose one', () => {
 const saved=new Map([['cb-count:a','2'],['cb-count:b','7']]),prefs={get:(k,d)=>saved.has(k)?saved.get(k):d};
 assert.equal(songCount(prefs,'a'),2);assert.equal(songCount(prefs,'b'),0,'only off, 1 bar or 2 bars');assert.equal(songCount(prefs,'c'),0);
 assert.equal(songCountKey('a'),'cb-count:a','saved like the song’s other settings, so it travels in its zip');
 assert.equal(DEFAULT_MONITOR.click.mute,true,'the click starts off');
});
test('a cue track the wrong length is pointed out', () => {
 assert.equal(lengthNote(100.4,100),'');
 assert.match(lengthNote(97,100),/3\.0 seconds shorter/);
 assert.match(lengthNote(105,100),/5\.0 seconds longer/);
});

test('a count-in is whole bars, ending on bar 1, needing silence only for what comes before bar 1 doesn’t cover', () => {
 const clean=countInOf([{number:1,start:0,end:2,beats:[0,.5,1,1.5]}],1);
 assert.deepEqual({...clean,clicks:undefined},{beat:.5,beats:4,meter:4,bars:1,clicks:undefined,target:0,seconds:2,firstBar:0,lead:2});
 assert.deepEqual(clean.clicks,[{at:-2,accent:true},{at:-1.5,accent:false},{at:-1,accent:false},{at:-.5,accent:false}],'A b b b, all before the recording starts');
 assert.equal(countInOf([{number:1,start:.5,end:2.5,beats:[.5,1,1.5,2]}],1).lead,1.5,'half a second of music comes before bar 1');
 assert.equal(countInOf([{number:1,start:5,end:7,beats:[5,5.5,6,6.5]}],1).lead,0,'a long intro has room');
 assert.equal(countInOf([{number:1,start:0,end:2,beats:[0,.5,1,1.5]}],1,50).lead,4,'half speed, half tempo');
 assert.equal(countInOf([],1).lead,0);assert.equal(countInOf(bars(1),0).lead,0);
 assert.equal(countInOf([{number:1,start:0,end:2,beats:[0,.5,1,1.5]}],2).beats,8,'two bars');
});
test('a count-in follows bar 1’s meter: 3/4 counts three, 7/8 counts seven', () => {
 const three=countInOf([{number:1,start:3,end:4.5,beats:[3,3.5,4]}],1);assert.equal(three.beats,3);assert.equal(three.beat,.5);
 assert.equal(countInOf([{number:1,start:3,end:6.5,beats:[3,3.5,4,4.5,5,5.5,6]}],1).beats,7);
});
test('a count-in saved in beats, from before, becomes whole bars', () => {
 const bar1=[{number:1,start:3,end:5,beats:[3,3.5,4,4.5]}];
 assert.equal(countInOf(bar1,{countBeats:4}).bars,1);assert.equal(countInOf(bar1,{countBeats:2}).bars,1);assert.equal(countInOf(bar1,{countBeats:5}).bars,2);
 assert.equal(countInOf(bar1,{countBars:2,countBeats:4}).bars,2,'bars win');
});
test('a pickup bar before bar 1 sets neither the count-in’s tempo nor where it ends (Call Me)', () => {
 const callMe=[{number:0,start:.01,end:1.77,beats:[.01,.41,.77,1.1,1.43]},{number:1,start:1.77,end:4.43,beats:[1.77,2.43,3.11,3.77]},{number:2,start:4.43,end:7.11,beats:[4.43,5.11,5.77,6.43]}];
 const c=countInOf(callMe,1);
 assert.ok(Math.abs(c.beat-.665)<.001,'bar 1’s beat, not the pickup’s');
 assert.equal(c.firstBar,1.77,'it ends on bar 1’s first beat');
 assert.ok(Math.abs(c.lead-(2.66-1.77))<.001,'the pickup plays under the count, and silence makes up the rest');
 assert.ok(Math.abs(countInOf(callMe,1,75).beat-.665/.75)<.001,'at the starting speed');
 assert.equal(countInOf([{number:1,start:0,end:2,beats:[0,.45,1.05,1.5]}],1).beat,.5,'a wobbly detected beat doesn’t set the tempo');
});
test('Play from anywhere counts into the playhead, on its bar’s grid', () => {
 const four=[{number:1,start:0,end:2,beats:[0,.5,1,1.5]},{number:2,start:2,end:4,beats:[2,2.5,3,3.5]},{number:3,start:4,end:6,beats:[4,4.5,5,5.5]}];
 const onBar=countInOf(four,1,100,4);
 assert.deepEqual(onBar.clicks.map(c=>[c.at,c.accent]),[[2,true],[2.5,false],[3,false],[3.5,false]],'A b b b into bar 3');
 assert.equal(onBar.lead,2,'the music waits a bar');
 const midBar=countInOf(four,1,100,4.75);
 assert.deepEqual(midBar.clicks.map(c=>[c.at,c.accent]),[[3,false],[3.5,false],[4,true],[4.5,false]],'the accent stays on the downbeat, not on the first click');
 assert.equal(midBar.target,4.75);
});
test('from inside a pickup, the count still ends on bar 1, with the rest of the pickup under it (Call Me)', () => {
 const callMe=[{number:0,start:.01,end:1.77,beats:[.01,.41,.77,1.1,1.43]},{number:1,start:1.77,end:4.43,beats:[1.77,2.43,3.11,3.77]}];
 const c=countInOf(callMe,1,100,0);
 assert.equal(c.target,1.77);assert.equal(c.clicks.length,4);assert.equal(c.clicks[0].accent,true);
 assert.ok(c.clicks[0].at<0,'the count starts before the recording');
 assert.ok(Math.abs(c.lead-(2.66-1.77))<.001,'so the music waits for it');
 assert.ok(Math.abs(countInOf(callMe,1,100,1).lead-(1-(1.77-2.66)))<.001,'from later in the pickup, it waits longer');
});
test('the set list’s total counts a count-in', () => {
 assert.equal(showSeconds([{segments:[],lead:2},{segments:[],lead:1,transition:{seconds:3}}]).gaps,6);
});

test('a flag turns the click or cue track on or off, in plain words', () => {
 assert.equal(checkAction({type:'monitor.set',part:'click',on:false}),null);
 assert.ok(checkAction({type:'monitor.set',part:'drums',on:false}));
 assert.equal(describeAction({type:'monitor.set',part:'cue',on:false}),'Turn the cue track off');
 assert.equal(searchPlan('click').some(i=>i.id==='monitor-click'),true);
 assert.equal(itemFor({type:'monitor.set',part:'cue',on:true}).id,'monitor-cue');
});
test('AHEAD leaves room for a slow page', () => {assert.ok(AHEAD>=.25);});
