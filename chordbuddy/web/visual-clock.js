// The visualizer's clock: the song time right now, smooth enough to draw 60 or more frames a second.
// The player reports its position about 20 times a second (from the audio worklet, already corrected for output latency). Between reports
// the clock runs on at the practice speed; when a report arrives slightly early or late, the difference is eased out over a few frames
// instead of jumping. A seek, a loop wrap or a pause is followed at once. Pure apart from `now`, so it can be tested.
const SNAP=0.15;                                // a difference larger than this (seconds) is a jump: follow it at once
const EASE=0.12;                                // smaller differences fade out with this time constant (seconds)

export class SceneClock{
  constructor({now=()=>performance.now()}={}){
    this.now=now;this.base={seconds:0,at:now(),playing:false,rate:1};this.offset=0;this.offsetAt=this.base.at;
    this.duration=Infinity;this.loop=null;
  }
  // Song time at `at` (ms on this page's performance clock) from the last report alone.
  raw(at=this.now()){
    const {seconds,at:from,playing,rate}=this.base;
    let t=playing?seconds+(at-from)/1000*rate:seconds;
    const loop=this.loop;
    if(playing&&loop&&t>=loop.end&&seconds<loop.end+1e-3)t=loop.start+(t-loop.start)%(loop.end-loop.start);
    return Math.max(0,Math.min(this.duration,t));
  }
  // A position from the player. state: {seconds, playing, rate (1 = normal), duration, loop: {enabled,start,end}}; at: when it was true.
  report(state,at=this.now()){
    const expected=this.time(at);
    const playing=!!state.playing,rate=Number.isFinite(state.rate)&&state.rate>0?state.rate:1;
    this.duration=Number.isFinite(state.duration)&&state.duration>0?state.duration:Infinity;
    this.loop=state.loop?.enabled&&state.loop.end>state.loop.start?{start:state.loop.start,end:state.loop.end}:null;
    const smooth=playing&&this.base.playing&&rate===this.base.rate&&Math.abs(expected-state.seconds)<SNAP;
    this.base={seconds:state.seconds,at,playing,rate};
    this.offset=smooth?expected-this.raw(at):0;this.offsetAt=at;
  }
  // Song time to draw at `at`.
  time(at=this.now()){
    const offset=this.offset*Math.exp(-Math.max(0,at-this.offsetAt)/1000/EASE);
    return Math.max(0,Math.min(this.duration,this.raw(at)+offset));
  }
  get playing(){return this.base.playing;}
  get rate(){return this.base.rate;}
}
