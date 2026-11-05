// Random live use, on the real runner and mixer, over many simulated minutes. Whatever is pressed and whenever, the music may only ever leave a bar line and
// land on a bar line, never stops by itself, and the numbers stay sane. Seeded, so a failure can be run again exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {newPerformance,addRepeat,address} from '../chordbuddy/web/performance-model.js';
import {Sim,grid,RATE} from './performance-sim.mjs';

const BLOCK=128;
function random(seed){let a=seed>>>0;return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
const SECTIONS=[{id:'a',name:'Intro',start:0,end:16},{id:'b',name:'Verse',start:16,end:48},{id:'c',name:'Chorus',start:48,end:88},{id:'d',name:'Outro',start:88,end:120}];

function perform(rnd){
 let p={...newPerformance({songId:'s',id:'p'}),cues:[{id:'c1',at:address('m6'),action:{type:'track.set',track:'drums',mute:true}},{id:'c2',at:address('m8'),action:{type:'visual.trigger',input:'flash'}},{id:'c3',at:address('m30'),action:{type:'visual.scene',scene:'x'}}]};
 if(rnd()<.5)p=addRepeat(p,{start:address('m9'),end:address('m11'),plays:3,id:'finite',family:'bars'},()=>`f${Math.floor(rnd()*1e9)}`);
 if(rnd()<.5)p=addRepeat(p,{start:address('m25'),end:address('m29'),plays:'live',id:'open',family:'section'},()=>`l${Math.floor(rnd()*1e9)}`);
 return p;
}

function soak(seed,seconds){
 const rnd=random(seed),G=grid();
 const barlines=new Set(G.measures.map(m=>Math.round(m.start*RATE)));barlines.add(G.frames);
 const s=new Sim({performance:perform(rnd),g:G,sections:SECTIONS,withhold:f=>rnd()<.15&&f%7!==0});
 const problems=[];let zeros=0,reachedEnd=false,last=null,jumps=0,presses=0,total=0,nextPress=RATE;
 const r=s.runner;
 const act=()=>{
  presses++;const c=rnd();
  if(c<.2)r.pressLoop('bars');
  else if(c<.4)r.pressLoop('section');
  else if(c<.5)r.pressExit();
  else if(c<.65)r.navigate(Math.floor(rnd()*G.frames));
  else if(c<.75)r.stepBars(rnd()<.5?-1:1);
  else if(c<.82)r.stepSections(rnd()<.5?-1:1);
  else if(c<.9)r.cancelNavigation();
  else if(c<.95){s.release();}
  else r.setLive('track.drums.mute',rnd()<.5);
 };
 while(total<seconds*RATE){
  const l=new Float32Array(BLOCK),rr=new Float32Array(BLOCK);
  s.mixer.render(l,rr);
  for(let i=0;i<BLOCK;i++){
   const v=Math.round(l[i]*2**21),at=total+i;
   if(at<1000)continue;                         // the fade-in at the very start
   // Frame 0 really is a sample of zero, so a run of zeros, not one, is silence. The mixer's fade at the very end of the song is not a jump.
   zeros=v===0?zeros+1:0;
   if(zeros===32&&problems.length<5)problems.push(`silence at output ${at}`);
   if(last!==null&&v!==last+1&&zeros<2&&last<G.frames-600){
    jumps++;
    if(!barlines.has(last+1)&&problems.length<5)problems.push(`left mid-bar: source ${last} to ${v} at output ${at}`);
    else if(!barlines.has(v)&&problems.length<5)problems.push(`landed mid-bar: source ${last} to ${v} at output ${at}`);
   }
   if(zeros<2)last=v;
   if(last>=G.frames-600)reachedEnd=true;
  }
  total+=BLOCK;s.now+=BLOCK/RATE;s.fill();
  s.blocks=(s.blocks||0)+1;
  if(s.blocks%16===0)r.tick(s.report());
  if(total>=nextPress){act();nextPress=total+Math.floor(RATE*(.1+rnd()*4));}
  if(problems.length>=5||reachedEnd||r.status==="finished"||s.mixer.state==="ended")break;
 }
 const d=r.durations();
 for(const v of [d.musicLeft,d.plannedLeft,d.totalMusic])if(!Number.isFinite(v)||v<0)problems.push(`bad duration ${v}`);
 if(r.log.length>5000)problems.push('log grew past its bound');
 if(s.mixer.actions.length>20000)problems.push('timed actions piling up');
 return {problems,jumps,presses,seconds:total/RATE,status:r.status};
}

let pressed=0,jumped=0;
for(let seed=1;seed<=24;seed++){
 test(`soak ${seed}: random live use never leaves or lands in the middle of a bar`,()=>{
  const out=soak(seed,240);
  pressed+=out.presses;jumped+=out.jumps;
  assert.deepEqual(out.problems,[],JSON.stringify(out));
 });
}
test('the soak really exercised it',()=>{assert.ok(pressed>300,`pressed ${pressed}`);assert.ok(jumped>100,`jumped ${jumped}`);});
