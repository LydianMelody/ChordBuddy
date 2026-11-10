// A whole show, on the real controller, runner and mixers: two songs in two players on one fake output timeline, one Start, no input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ShowController,preflight} from '../chordbuddy/web/performance-controller.js';
import {newPerformance,addRepeat,address} from '../chordbuddy/web/performance-model.js';
import {compilePerformance,RATE} from '../chordbuddy/web/performance-compiler.js';
import {PathMixer} from '../chordbuddy/web/pcm-path.js';
import {defaultMix} from '../chordbuddy/web/pcm-mixer-core.js';
import {grid} from './performance-sim.mjs';

const SCALE=2**21,BLOCK=128;
function audio(start,count,base){
 const data=new Float32Array(count*16);
 for(let i=0;i<count;i++)for(let c=0;c<2;c++)data[count*2+i*2+c]=(base+start+i)/SCALE;
 return data.buffer;
}
// The worklet's two slots and handoff, in plain JS: renders what the real PathProcessor renders.
class FakeSession{
 constructor(handlers){this.h=handlers;this.mixers=[new PathMixer(),new PathMixer()];this.bases=[0,0];this.frames=[0,0];this.active=0;this.handoffAt=null;this.gap=0;this.out=[];this.g=1;this.suspended=false;this.time=0;this.bases=[0,0];this.tick=0;this.withhold=null;}
 async resume(){this.suspended=false;}
 async suspend(){this.suspended=true;}
 dispose(){this.disposed=true;}
 mix(slot,m){this.mixers[slot].setMix(m);}
 async load(slot,manifest){
  if(this.withhold===manifest.run_id)throw Error('no audio');
  const m=this.mixers[slot];this.frames[slot]=manifest.frames;this.bases[slot]=manifest.base;
  m.reset({generation:++this.g,runId:manifest.run_id,startFrame:0,totalFrames:manifest.frames,commonGain:1});m.setMode('stems');this.fill(slot);
 }
 fill(slot){const m=this.mixers[slot],total=this.frames[slot];while(m.runId&&m.queued<RATE*4&&m.end<total){const n=Math.min(RATE/2,total-m.end);m.enqueue({generation:m.generation,runId:m.runId,startFrame:m.end,frameCount:n,buffer:audio(m.end,n,this.bases[slot])});}}
 engine(slot){const m=this.mixers[slot],s=this;return {
  jump({at,to},a){const r=m.jump({generation:++s.g,at,to});s.fill(slot);a(r);},
  jumpNow({to},a){a(m.jumpNow({generation:++s.g,to}));},
  mark(at,a){const u=m.framesUntil(at);a(u===null?{status:'later'}:u<256?{status:'missed'}:{status:'committed',atPlayed:m.played+u});},
  prepare(frame){for(let at=frame;at<Math.min(frame+RATE*3,s.frames[slot]);at+=RATE){const n=Math.min(RATE,s.frames[slot]-at);m.addPrepared({runId:m.runId,startFrame:at,frameCount:n,buffer:audio(at,n,s.bases[slot])});}},
  schedule(atPlayed,p,id){m.schedule(atPlayed,x=>{if(p.kind==='mix')x.setMix(p.mix);else if(p.kind==='hold')x.setPlaying(false);},id);},
  cancel(prefix){m.cancel(a=>String(a.id).startsWith(prefix));},cancelFrom(at){m.cancel(a=>a.atPlayed>=at);},play(v){m.setPlaying(v);},
 };}
 handoff(slot,{to,atPlayed,gap}){this.handoffAt={from:slot,to,atPlayed,gap};}
 cancelHandoff(){this.handoffAt=null;}
 run(frames){
  for(let done=0;done<frames;done+=BLOCK){
   if(this.suspended){this.time+=BLOCK/RATE;continue;}
   const l=new Float32Array(BLOCK),r=new Float32Array(BLOCK);let at=0;
   while(at<BLOCK){
    if(this.gap>0){const n=Math.min(BLOCK-at,this.gap);this.gap-=n;at+=n;if(this.gap===0)this.begin();continue;}
    const m=this.mixers[this.active],h=this.handoffAt,until=h&&h.from===this.active?h.atPlayed-m.played:Infinity;
    if(until<=0){this.handoffAt=null;m.setPlaying(false);this.waiting=h.to;this.h.onHandoff({from:h.from,to:h.to,gap:h.gap});if(h.gap>0){this.gap=h.gap;continue;}this.begin();continue;}
    const n=Math.min(BLOCK-at,until);m.render(l.subarray(at,at+n),r.subarray(at,at+n));at+=n;
   }
   for(const v of l)this.out.push(Math.round(v*SCALE));
   this.fill(0);this.fill(1);this.time+=BLOCK/RATE;
   if(++this.tick%16===0){const m=this.mixers[this.active];this.h.onPosition({slot:this.active,played:m.played,sourceFrame:m.frame,heardFrame:m.frame,latency:0,state:m.state});}
  }
 }
 begin(){this.active=this.waiting;this.mixers[this.active].setPlaying(true);}
}
const G=grid(Array(10).fill(4));                        // 20 seconds a song
const SONGS={a:{base:0},b:{base:1000000},c:{base:1500000}};
const song=id=>newPerformance({songId:id,id:`p-${id}`});
const entryOf=(id,songId,extra={})=>({id,songId,performanceId:null,...extra});
function rig({perform=song,withhold=null,g=G}={}){
 let session;
 const events=[],shown=[];
 const c=new ShowController({
  createSession:async h=>{session=new FakeSession(h);session.withhold=withhold;return session;},
  loadEntry:async entry=>{
   const performance=perform(entry.songId),compiled=compilePerformance(performance,g);
   return {song:{title:entry.songId},performance,compiled,grid:g,sections:[],manifest:{run_id:entry.songId,frames:g.frames,base:SONGS[entry.songId].base,common_gain:1},baseMix:defaultMix(),trim:null};
  },
  now:()=>session?session.time:0,out:e=>events.push(e),onSong:id=>shown.push(id),
 });
 return {c,events,shown,get session(){return session;}};
}
const show=(entries,extra={})=>({id:'show',name:'Set',entries,transitions:{kind:'immediate',seconds:0},...extra});
const decode=out=>{const spans=[];let start=out[0],last=out[0];for(let i=1;i<out.length;i++){if(out[i]!==last+1){spans.push([start,last]);start=out[i];}last=out[i];}spans.push([start,last]);return spans;};
const flush=()=>new Promise(r=>setTimeout(r,0));

test('one Start plays a whole set with no input: the next song starts on the very next sample', async () => {
 const r=rig();
 assert.equal((await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]))).ready,true);
 await r.c.start();await flush();
 r.session.run(RATE*19);await flush();r.session.run(RATE*3);await flush();
 const out=r.session.out;
 // A song starts with the mixer's 10 ms fade-in, so read it just after that: frame 500 of the second song is 500 samples after the first one ended.
 assert.equal(out[G.frames+500],1000000+500,'the second song starts on the very next sample');
 assert.equal(out[G.frames-500],G.frames-500,'the first song played to its end');
 assert.deepEqual(r.shown,['a','b']);
 assert.equal(r.c.index,1);assert.equal(r.c.status,'playing');
});

test('a timed gap is exact silence, counted once', async () => {
 const r=rig();
 await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b',{transition:{kind:'gap',seconds:2}})]));
 const before=r.c.totals();assert.equal(before.music,40);assert.equal(before.gaps,2);assert.equal(before.planned,42);
 await r.c.start();await flush();
 r.session.run(RATE*19);await flush();r.session.run(RATE*1.5);
 assert.equal(r.c.status,'gap');
 r.session.run(RATE*2);await flush();
 const out=r.session.out,first=G.frames+2*RATE;
 assert.equal(out[first+500],1000000+500,'starts exactly when the gap ends');
 assert.ok(out.slice(G.frames+500,first).every(v=>v===0),'silence between');
});

test('the show ends after its last song, and says so', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a')]));await r.c.start();
 r.session.run(RATE*21);await flush();
 assert.equal(r.c.runner.status,'finished');
});

test('the same song twice: separate entries, separate one-shots', async () => {
 const perform=id=>({...song(id),cues:[{id:'flash',at:address('m2'),action:{type:'visual.trigger',input:'flash'}}]});
 const r=rig({perform});
 await r.c.arm(show([entryOf('e1','a'),entryOf('e2','a')]));await r.c.start();await flush();
 r.session.run(RATE*19);await flush();r.session.run(RATE*10);await flush();
 const shots=r.events.filter(e=>e.type==='oneshot');
 assert.equal(shots.length,2);assert.notEqual(shots[0].id,shots[1].id);
 assert.deepEqual(shots.map(s=>s.entry),['e1','e2']);
});

test('Next song goes at the next barline, and can be cancelled', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));await r.c.start();await flush();
 r.session.run(RATE*3);await flush();
 const q=r.c.nextSong();assert.equal(q.boundary,RATE*4);
 assert.ok(r.c.cancelJump());
 r.session.run(RATE*3.5);await flush();assert.equal(r.c.index,0);
 const again=r.c.nextSong();assert.equal(again.boundary,RATE*8);
 r.session.run(RATE*3);await flush();
 assert.equal(r.c.index,1);
 const out=r.session.out;
 assert.equal(out[RATE*8-1],RATE*8-1,'the first song played right up to the barline');
 assert.equal(out[RATE*8+500],1000000+500);
});

test('going to any song: further down the set, not in it, or already played', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b'),entryOf('e3','c')]));await r.c.start();await flush();
 r.session.run(RATE*3);await flush();
 assert.equal((await r.c.goToSong('a')),null,'already on it');
 assert.equal((await r.c.goToSong('c')).boundary,RATE*4);
 assert.deepEqual(r.c.entries.map(e=>e.id),['e1','e3','e2'],'the one in between stays, after it');
 assert.ok(r.c.pendingNext);
 r.session.run(RATE*3);await flush();
 assert.equal(r.c.current.id,'e3');
 await r.c.goToSong('a');await flush();
 assert.equal(r.c.next.songId,'a','played earlier, it comes again');assert.notEqual(r.c.next.id,'e1');
 assert.deepEqual(r.c.entries.map(e=>e.songId),['a','c','a','b']);
 for(let i=0;i<8;i++){r.session.run(RATE);await flush();}   // a second at a time: the song it's getting ready has to arrive
 assert.equal(r.c.current.songId,'a');
});
test('Next song pressed as a bar line goes by aims at the next one, and never gets stuck', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));await r.c.start();await flush();
 r.session.run(RATE*3);await flush();
 r.c.nextSong();r.c.pendingNext.at=RATE*2;   // already behind the music
 for(let i=0;i<8;i++){r.session.run(RATE);await flush();}
 assert.equal(r.c.current.id,'e2');
});
test('a song that can’t play is turned away, and the show carries on as it was', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));await r.c.start();await flush();
 const load=r.c.loadEntry;r.c.loadEntry=async()=>{throw Error('no analysis');};
 await assert.rejects(r.c.goToSong('nothing'),/analyzed/);
 r.c.loadEntry=load;
 assert.deepEqual(r.c.entries.map(e=>e.id),['e1','e2']);assert.equal(r.c.pendingNext,null);
});
test('add, remove and reorder while playing: totals change at once and the song playing stays put', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));await r.c.start();await flush();
 r.session.run(RATE*5);await flush();
 const start=r.c.totals().music;
 await r.c.addEntry(entryOf('e3','c'));
 assert.ok(Math.abs(r.c.totals().music-(start+20))<.01);
 r.c.setQueue(['e3','e2']);
 assert.deepEqual(r.c.entries.map(e=>e.id),['e1','e3','e2']);
 assert.equal(r.c.removeEntry('e2'),'removed');
 assert.ok(Math.abs(r.c.totals().music-(start))<.01);
 assert.equal(r.c.removeEntry('e1'),'after-this-song');
 assert.equal(r.c.current.id,'e1');
 const played=r.session.mixers[0].played;r.session.run(RATE);assert.ok(r.session.mixers[0].played>played);
 await flush();r.session.run(RATE*20);await flush();
 assert.equal(r.c.current.id,'e3','the new next song took over');
});

test('a wait for a control: the song ends and nothing starts until Next', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b',{transition:{kind:'control',expected:30}})]));
 const t=r.c.totals();assert.equal(t.estimated,true);assert.equal(t.planned,70);
 await r.c.start();await flush();r.session.run(RATE*22);await flush();
 assert.equal(r.c.index,0);assert.equal(r.c.waitingAtEnd,true);
 assert.ok(r.c.nextSong());r.session.run(RATE);await flush();
 assert.equal(r.c.index,1);
});

test('pause: music stops, the slot clock keeps counting, nothing starts twice', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')],{target:{slotSeconds:60}}));await r.c.start();await flush();
 r.session.run(RATE*5);await flush();
 const a=r.c.snapshot().clock;r.c.pause();
 const played=r.session.mixers[0].played;
 r.session.run(RATE*3);
 assert.equal(r.session.mixers[0].played,played);
 const b=r.c.snapshot().clock;
 assert.ok(Math.abs(b.music-a.music)<.1,'music left unchanged');
 assert.ok(Math.abs((a.spare-b.spare)-3)<.1,`spare fell by the pause: ${a.spare} ${b.spare}`);
 r.c.resume();r.session.run(RATE);assert.ok(r.session.mixers[0].played>played);
});

test('a repeat in a show counts in every total, and an authored live loop is an estimate', async () => {
 const r=rig({perform:id=>id==='a'?addRepeat(song(id),{start:address('m1'),end:address('m3'),plays:3,id:'r'}):addRepeat(song(id),{start:address('m1'),end:address('m3'),plays:'live',id:'r2'})});
 await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));
 const t=r.c.totals();assert.equal(t.music,(20+8)+(20+12));assert.equal(t.estimated,true);
 assert.equal(r.c.check.live,true);
 const r2=r.c.snapshot();assert.equal(r2.count,2);
});

test('Stop is immediate and everything lets go', async () => {
 let released=0;
 const r=rig();r.c.power={acquire(){},release(){released++;}};
 await r.c.arm(show([entryOf('e1','a')]));await r.c.start();r.session.run(RATE);
 const session=r.session;r.c.stop();
 assert.equal(r.c.status,'stopped');assert.equal(released,1);assert.equal(session.disposed,true);
 assert.ok(r.events.some(e=>e.type==='cleanup'));
});

test('a load failure for a future song does not disturb the song playing', async () => {
 const r=rig({withhold:'b'});await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));await r.c.start();await flush();await flush();
 assert.equal(r.c.status,'playing');
 assert.ok(r.c.log.some(l=>l.type==='next-load-failed'));
 r.session.run(RATE*3);assert.ok(r.session.out.at(-1)>0);
});

test('preflight: only what cannot run blocks Start, and the rest is said plainly', () => {
 const ok={song:{title:'A'},manifest:{},compiled:{ok:true,errors:[],warnings:[],segments:[],needsReview:false}};
 assert.equal(preflight([ok]).ready,true);
 assert.match(preflight([{...ok,manifest:null}]).blocking[0],/audio isn’t ready/);
 assert.match(preflight([{...ok,compiled:{ok:false,errors:[{message:'Bad.'}],warnings:[],segments:[]}}]).blocking[0],/A: Bad/);
 assert.equal(preflight([ok],{devices:[{name:'Helix',connected:false}]}).ready,true);
 assert.match(preflight([ok],{devices:[{name:'Helix',connected:false}]}).notes[0],/play without it/);
 assert.equal(preflight([ok],{devices:[{name:'Helix',connected:false,critical:true}]}).ready,false);
 assert.match(preflight([ok],{keepAwake:false}).notes[0],/go to sleep/);
 assert.match(preflight([ok],{missingScenes:['x']}).blocking[0],/“x”/);
});

test('live changes end with the song, unless the show says to keep them', async () => {
 const run=async carry=>{
  const r=rig();await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')],{carryOverrides:carry}));await r.c.start();await flush();
  r.c.setLive('track.drums.mute',true);r.c.nextSong();r.session.run(RATE*3);await flush();
  assert.equal(r.c.index,1);
  return r.c.runner.overrides.size;
 };
 assert.equal(await run(false),0);assert.equal(await run(true),1);
});

test('a song marked to come off after it ends does, and the set carries on', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));await r.c.start();await flush();
 r.c.removeEntry('e1');r.c.nextSong();r.session.run(RATE*3);await flush();
 assert.deepEqual(r.c.entries.map(e=>e.id),['e2']);assert.equal(r.c.current.id,'e2');assert.equal(r.c.index,0);
});

test('a device a show needs going away stops the show at the next bar line; one it doesn’t need just gets noted', async () => {
 const r=rig();await r.c.arm(show([entryOf('e1','a')]));await r.c.start();await flush();
 r.session.run(RATE*1);await flush();
 r.c.deviceLost('Spare',false);r.session.run(RATE*3);await flush();
 assert.equal(r.c.status,'playing');assert.deepEqual(r.c.snapshot().missingDevices,['Spare']);
 r.c.deviceBack('Spare');assert.deepEqual(r.c.snapshot().missingDevices,[]);
 const before=r.c.runner.source;r.c.deviceLost('Helix',true);
 assert.ok(r.c.stopAt>before);assert.equal(r.c.stopAt%(RATE*2),0,'a bar line');
 r.session.run(RATE*3);await flush();
 assert.equal(r.c.status,'stopped');assert.match(r.c.lastError,/Helix was disconnected/);
});

test('after a crash, it offers the song it stopped on; a clean Stop forgets it; another show never gets it', async () => {
 let saved=null;const store={save:v=>{saved=v;},load:()=>saved,clear:()=>{saved=null;}};
 const r=rig();r.c.checkpoint=store;await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));await r.c.start();await flush();
 r.c.nextSong();r.session.run(RATE*3);await flush();
 assert.equal(saved.entryId,'e2');
 const again=rig();again.c.checkpoint=store;await again.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));
 assert.equal(again.c.resumePoint().index,1);assert.equal(again.c.snapshot().resume.index,1);
 await again.c.start({entryIndex:1});await flush();assert.equal(again.c.current.id,'e2');
 const other=rig();other.c.checkpoint=store;await other.c.arm({...show([entryOf('e1','a'),entryOf('e2','b')]),id:'different'});
 assert.equal(other.c.resumePoint(),null);
 again.c.stop();assert.equal(saved,null);
});

test('a target finish time counts down like a slot', async () => {
 const r=rig();r.c.epochNow=()=>1000000;
 await r.c.arm(show([entryOf('e1','a')],{target:{finishAtEpoch:1000000+60000}}));await r.c.start();
 assert.ok(Math.abs(r.c.deadline-(r.c.now()+60))<.01);
});

test('the sample show: valid, its passes differ, its totals are right, and it plays from one Start', async () => {
 const {readFileSync}=await import('node:fs');
 const bundle=JSON.parse(readFileSync(new URL('./fixtures/sample-show.json',import.meta.url),'utf8'));
 const body=bundle.performances[0].body,g=grid();           // 60 bars of 2 seconds
 const c=compilePerformance(body,g);
 assert.equal(c.ok,true,JSON.stringify(c.errors));
 assert.deepEqual(c.segments.filter(s=>s.regionId==='intro').map(s=>s.actions.map(a=>a.id)),[[],['drums-in'],['flash']]);
 const r=rig({g,perform:id=>id==='a'?body:song(id)});
 const sets={...bundle.show,entries:[entryOf('e1','a'),entryOf('e2','b',{transition:{kind:'gap',seconds:10}})]};
 await r.c.arm(sets);
 const t=r.c.totals();assert.equal(t.music,120+16+120);assert.equal(t.planned,120+16+120+10);
 await r.c.start();await flush();r.session.run(RATE*30);await flush();
 assert.equal(r.c.status,'playing');
 assert.ok(r.events.some(e=>e.type==='oneshot'&&e.action.input==='flash'));
 assert.ok(r.events.some(e=>e.type==='visual'&&e.action.type==='visual.switch'),'the exit action ran');
});

test('the last song ends: the show says finished, lets go of everything, and forgets its checkpoint', async () => {
 let released=0,cleared=0;
 const r=rig();r.c.power={acquire(){},release(){released++;}};r.c.checkpoint={save(){},load(){return null;},clear(){cleared++;}};
 await r.c.arm(show([entryOf('e1','a')]));await r.c.start();await flush();
 const session=r.session;session.run(RATE*21);await flush();
 assert.equal(r.c.status,'finished');assert.equal(released,1);assert.equal(cleared,1);assert.equal(session.disposed,true);
 assert.ok(r.events.some(e=>e.type==='cleanup'));
});

test('a song that ends with the next one not ready waits, says so, and goes as soon as it can', async () => {
 const r=rig({withhold:'b'});await r.c.arm(show([entryOf('e1','a'),entryOf('e2','b')]));await r.c.start();await flush();await flush();
 r.session.run(RATE*21);await flush();
 assert.equal(r.c.status,'waiting');assert.equal(r.c.index,0);
 r.session.withhold=null;r.c.preloadNext();await flush();await flush();
 r.session.run(RATE);await flush();
 assert.equal(r.c.index,1);assert.equal(r.c.status,'playing');
});

test('a wait for a control: Next song, or Go on from a hold', async () => {
 const perform=id=>({...song(id),holds:[{id:'h',at:address('m2'),seconds:null,expected:10}]});
 const r=rig({perform});await r.c.arm(show([entryOf('e1','a')]));await r.c.start();await flush();
 r.session.run(RATE*3);await flush();
 assert.equal(r.c.runner.status,'holding');assert.equal(r.c.snapshot().song.holding.waiting,true);
 const at=r.session.mixers[0].played;r.session.run(RATE);assert.equal(r.session.mixers[0].played,at,'it stays held');
 assert.equal(r.c.goOn(),true);r.session.run(RATE);assert.ok(r.session.mixers[0].played>at);
});

test('a timed hold stops counting while paused', async () => {
 const perform=id=>({...song(id),holds:[{id:'h',at:address('m2'),seconds:2}]});
 const r=rig({perform});await r.c.arm(show([entryOf('e1','a')]));await r.c.start();await flush();
 r.session.run(RATE*2.2);await flush();
 assert.equal(r.c.runner.status,'holding');
 r.c.pause();assert.equal(r.c.status,'paused');
 r.session.run(RATE*4);await flush();
 assert.equal(r.c.runner.status,'holding','still holding after 4 seconds paused');
 r.c.resume();r.session.run(RATE*2.5);await flush();
 assert.equal(r.c.runner.status,'playing');
});

test('an empty show cannot start, and says why', async () => {
 const r=rig();const check=await r.c.arm(show([]));
 assert.equal(check.ready,false);assert.match(check.blocking[0],/no songs/);
 await assert.rejects(r.c.start(),/isn’t ready/);
});

test('a preview stopped while it is still starting stays stopped: its session is closed and it never plays or reports', async () => {
 for(const when of ['session','resume','load']){
  const r=rig();
  await r.c.arm(show([entryOf('e1','a')]));
  const made=r.c.createSession;let changes=0;r.c.onChange=()=>changes++;
  r.c.createSession=async h=>{const s=await made(h);if(when==='session')r.c.stop();
   if(when==='resume'){const resume=s.resume.bind(s);s.resume=async()=>{await resume();r.c.stop();};}
   if(when==='load'){const load=s.load.bind(s);s.load=async(...a)=>{await load(...a);r.c.stop();};}
   return s;};
  await r.c.start();await flush();
  assert.equal(r.c.status,'stopped',when);
  assert.equal(r.c.session,null,when+': no session left running');
  assert.equal(r.session.disposed,true,when+': the session it made was closed');
  const seen=changes;r.session.run(RATE);await flush();
  assert.equal(changes,seen,when+': nothing more is reported');
 }
});

test('a show stopped while its songs load does not become ready', async () => {
 let release;const r=rig();const load=r.c.loadEntry;
 r.c.loadEntry=entry=>new Promise(done=>{release=()=>done(load(entry));});
 const armed=r.c.arm(show([entryOf('e1','a')]));await flush();
 r.c.stop();release();
 const check=await armed;
 assert.equal(check.stopped,true);assert.equal(r.c.status,'stopped');
 await assert.rejects(r.c.start(),/isn’t ready/);
});
