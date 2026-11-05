// A stand-in for the audio worklet and fetch worker, around the real PathMixer. Every sample's value is the source frame it came from, so a
// test reads exactly what played, frame by frame. Time is fake: the test decides when audio arrives.
import {PathMixer} from '../chordbuddy/web/pcm-path.js';
import {defaultMix} from '../chordbuddy/web/pcm-mixer-core.js';
import {PerformanceRunner} from '../chordbuddy/web/performance-runner.js';
import {compilePerformance,RATE} from '../chordbuddy/web/performance-compiler.js';

const SCALE=2**21;
const BLOCK=128,TICK=16;

export function grid(lengths=Array(60).fill(4),sec=.5){
  let t=0;const measures=lengths.map((beats,i)=>{const m={id:`m${i+1}`,number:i+1,start:t,end:t+beats*sec,beats:Array.from({length:beats},(_,b)=>t+b*sec)};t=m.end;return m;});
  return {measures,frames:Math.round(t*RATE)};
}
function audio(start,count){
  const data=new Float32Array(count*16);
  for(let i=0;i<count;i++){for(let t=1;t<8;t++){data[count*2*t+i*2]=t===1?(start+i)/SCALE:0;data[count*2*t+i*2+1]=t===1?(start+i)/SCALE:0;}}
  return data.buffer;
}

export class Sim{
  constructor({performance,g=grid(),sections=[],policy=null,trim=null,start=0,withhold=()=>false,lateAnswers=false}){
    this.late=lateAnswers;this.waitingAnswers=[];
    this.g=g;this.withhold=withhold;this.events=[];this.mixes=[];this.rates=[];this.out=[];this.level=[];this.delayedPrepare=[];
    this.compiled=compilePerformance(performance,g);
    if(!this.compiled.ok)throw Error(JSON.stringify(this.compiled.errors));
    const m=this.mixer=new PathMixer();
    this.engineGeneration=1;
    m.reset({generation:1,runId:'r',startFrame:start,totalFrames:g.frames,commonGain:1});
    m.setMode('stems');
    this.fill();
    const sim=this,reply=(answer,make)=>{if(sim.late)sim.waitingAnswers.push(()=>answer(make()));else answer(make());},engine={
      jump({at,to},answer){reply(answer,()=>{const generation=++sim.engineGeneration,r=m.jump({generation,at,to});sim.events.push({type:'jump',at,to,status:r.status,atPlayed:r.atPlayed});return r;});},
      jumpNow({to},answer){reply(answer,()=>{const generation=++sim.engineGeneration,r=m.jumpNow({generation,to});sim.events.push({type:'jumpNow',to,status:r.status});return r;});},
      mark(at,answer){reply(answer,()=>{const until=m.framesUntil(at);return until===null?{status:'later'}:until<256?{status:'missed'}:{status:'committed',atPlayed:m.played+until};});},
      prepare(frame){sim.events.push({type:'prepare',frame});if(sim.withhold(frame)){sim.delayedPrepare.push(frame);return;}sim.give(frame);},
      schedule(atPlayed,payload,id){m.schedule(atPlayed,x=>{
        if(payload.kind==='mix'){x.setMix(payload.mix);sim.mixes.push({played:x.played,mix:payload.mix,id});}
        else if(payload.kind==='rate')sim.rates.push({played:x.played,percent:payload.percent});
        else if(payload.kind==='hold'){x.setPlaying(false);sim.events.push({type:'held',played:x.played});}
      },id);},
      cancel(prefix){m.cancel(a=>String(a.id).startsWith(prefix));},
      cancelFrom(at){m.cancel(a=>a.atPlayed>=at);},
      play(value){m.setPlaying(value);},
    };
    this.runner=new PerformanceRunner({performance,compiled:this.compiled,grid:g,engine,baseMix:defaultMix(),sections,policy,trim,out:e=>this.out.push(e)});
    this.runner.start(start);
    this.now=0;
  }
  give(frame,frames=RATE*3){
    for(let at=frame;at<Math.min(frame+frames,this.g.frames);at+=RATE){const n=Math.min(RATE,this.g.frames-at);this.mixer.addPrepared({runId:'r',startFrame:at,frameCount:n,buffer:audio(at,n)});}
  }
  flushAnswers(){const list=this.waitingAnswers;this.waitingAnswers=[];for(const f of list)f();}
  release(){for(const f of this.delayedPrepare)this.give(f);this.delayedPrepare=[];}
  fill(){
    const m=this.mixer;
    while(m.queued<RATE*5&&m.end<this.g.frames){const n=Math.min(RATE/2,this.g.frames-m.end);m.enqueue({generation:m.generation,runId:'r',startFrame:m.end,frameCount:n,buffer:audio(m.end,n)});}
  }
  report(){const m=this.mixer;return {played:m.played,source:m.frame,heard:m.frame,state:m.state,now:this.now};}
  /** Render this many output frames. */
  run(frames){
    let done=0;const start=this.level.length;
    while(done<frames){
      const l=new Float32Array(BLOCK),r=new Float32Array(BLOCK);
      this.mixer.render(l,r);
      for(let i=0;i<BLOCK;i++)this.level.push(Math.round(l[i]*SCALE));
      done+=BLOCK;this.now+=BLOCK/RATE;this.fill();
      this.blocks=(this.blocks||0)+1;
      if(this.blocks%TICK===0)this.runner.tick(this.report());
    }
    return this.level.slice(start);
  }
  runSeconds(s){return this.run(Math.ceil(s*RATE));}
  /** Run until the output counter reaches this frame. */
  runTo(played){while(this.level.length<played)this.run(BLOCK);}
  /** The stretches played, as [first source frame, frames], read back from the samples; the first moments (fade in) are skipped. */
  spans(from=600,to=this.level.length){
    const out=[];let begin=this.level[from],last=begin,count=1;
    for(let i=from+1;i<to;i++){const v=this.level[i];if(v===last+1){last=v;count++;continue;}out.push([begin,count]);begin=v;last=v;count=1;}
    out.push([begin,count]);return out;
  }
  /** Stretches as [start,end) in seconds, for readable tests. */
  sections(from=600,to=this.level.length){return this.spans(from,to).map(([b,c])=>[+(b/RATE).toFixed(3),+((b+c)/RATE).toFixed(3)]);}
}
export {RATE};
