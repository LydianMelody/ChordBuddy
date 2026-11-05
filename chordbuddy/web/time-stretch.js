// Pitch-preserving time stretch for the mixed stereo stream. Pure code with no Web Audio dependency, so it runs in the AudioWorklet
// and in Node tests.
//
// rate = input frames consumed per output frame: 0.5 is half speed, 1 is unchanged, 1.25 is 25% faster.
// Two stretchers with the same shape (step() fills readyL/readyR with Hs frames; currentSourceFrame() is the frame being heard):
// - SignalsmithStretcher: Signalsmith Stretch (vendor/signalsmith-stretch.js, MIT), a spectral stretcher made for whole mixes.
//   It is what plays once loadStretchEngine() has finished; the worklet starts loading it as soon as it starts.
// - WsolaStretcher: Chord Buddy's own simpler stretcher, the fallback if the engine has not loaded (or cannot load).
import SignalsmithStretch from './vendor/signalsmith-stretch.js';

export const MIN_RATE=.5,MAX_RATE=1.25;
export function checkRate(rate){
  if(!Number.isFinite(rate)||rate<MIN_RATE||rate>MAX_RATE)throw Error('Speed must be between 50% and 125%');
}

// ----- Signalsmith Stretch -----
// One engine holds one stream, which is all the player needs: a new stretcher (after a seek or a loop change) takes it over.
let engine=null,loading=null;
export function loadStretchEngine(sampleRate=44100){
  return loading??=SignalsmithStretch().then(module=>{
    module._main?.();
    module._presetDefault(2,sampleRate);
    // the default settings, with the heavy work spread evenly over time so no single audio block runs long (a dropout risk)
    module._configure(2,module._blockSamples(),module._intervalSamples(),1);
    engine=module;return module;
  },()=>null);
}
export const stretchEngine=()=>engine;
// The best stretcher available right now.
export function createStretcher({pull}){return engine?new SignalsmithStretcher({pull,engine}):new WsolaStretcher({pull});}

export class SignalsmithStretcher{
  // pull(left,right,count) fills count mixed frames (the arrays are count long) and returns the source frame number of the first one.
  constructor({pull,engine,hop=512}){
    this.pull=pull;this.engine=engine;this.Hs=hop;this.piece=128;
    this.inLat=engine._inputLatency();this.outLat=engine._outputLatency();
    this.len=Math.ceil(this.inLat+this.outLat*MAX_RATE)+2*hop;
    this.ptr=engine._setBuffers(2,this.len);this.heap=null;
    this.readyL=new Float32Array(hop);this.readyR=new Float32Array(hop);
    this.rate=1;this.reset();
  }
  setRate(rate){checkRate(rate);this.rate=rate;}
  reset(){this.engine._reset();this.inEnd=0;this.map=[];this.carry=0;this.primed=false;this.readyPos=this.Hs;this.heard=0;}
  // Views of the engine's input and output buffers (made again if its memory ever grows).
  views(){
    const buffer=this.engine.HEAP8.buffer;if(buffer===this.heap)return;
    const bytes=this.len*4;this.heap=buffer;
    this.inL=new Float32Array(buffer,this.ptr,this.len);this.inR=new Float32Array(buffer,this.ptr+bytes,this.len);
    this.outL=new Float32Array(buffer,this.ptr+2*bytes,this.Hs);this.outR=new Float32Array(buffer,this.ptr+3*bytes,this.Hs);
  }
  // Pulls count frames into the input buffers from index at, in small pieces so a loop wrapping is placed precisely.
  feed(at,count){
    for(let done=0;done<count;){
      const n=Math.min(this.piece,count-done),from=at+done;
      const first=this.pull(this.inL.subarray(from,from+n),this.inR.subarray(from,from+n),n);
      this.map.push([this.inEnd,first]);if(this.map.length>256)this.map.shift();
      this.inEnd+=n;done+=n;this.views();
    }
  }
  sourceAt(abs){
    const map=this.map;if(!map.length)return 0;
    let entry=map[0];for(let i=map.length-1;i>=0;i--)if(map[i][0]<=abs){entry=map[i];break;}
    return entry[1]+(abs-entry[0]);
  }
  // The sound coming out now is the input fed so far, less the engine's input latency and its output latency (in input frames).
  currentSourceFrame(){return this.sourceAt(this.heard+this.readyPos*this.rate);}
  step(){
    this.views();
    if(!this.primed){
      // Start on the spot: hand the engine enough audio that its very first output frame is the first frame pulled.
      const ahead=Math.round(this.inLat+this.outLat*this.rate);
      this.inL.fill(0);this.inR.fill(0);this.feed(this.len-ahead,ahead);
      this.engine._seek(this.len,this.rate);this.primed=true;
    }
    this.heard=this.inEnd-this.inLat-this.outLat*this.rate;
    this.carry+=this.Hs*this.rate;const count=Math.floor(this.carry);this.carry-=count;
    this.feed(0,count);
    this.engine._process(count,this.Hs);
    this.views();this.readyL.set(this.outL);this.readyR.set(this.outR);this.readyPos=0;
  }
  get readyRemaining(){return this.Hs-this.readyPos;}
  render(left,right){
    for(let i=0;i<left.length;i++){
      if(this.readyPos>=this.Hs)this.step();
      left[i]=this.readyL[this.readyPos];right[i]=this.readyR[this.readyPos];this.readyPos++;
    }
  }
}

// ----- WSOLA (waveform-similarity overlap-add), the fallback -----
// Windows of N frames are laid down every Hs output frames. Each window's source position is chosen within +-tolerance
// of its nominal spot to best continue the previous window, which keeps the waveform coherent and the pitch unchanged.
// At rate 1 every window lands exactly on its nominal spot, so the output is the input, unchanged and undelayed.

export class WsolaStretcher{
  // pull(left,right,count) must fill count mixed frames and return the source frame number of the first one.
  constructor({pull,windowSize=2048,hop=512,tolerance=128,decimate=4,block=128}){
    if(windowSize%hop!==0||windowSize/hop!==4)throw Error('Window must be four hops long');
    this.pull=pull;this.N=windowSize;this.Hs=hop;this.M=windowSize-hop;this.tol=tolerance;this.dec=decimate;this.block=block;
    this.win=new Float32Array(windowSize);for(let i=0;i<windowSize;i++)this.win[i]=.5-.5*Math.cos(2*Math.PI*i/windowSize);
    this.cap=1<<14;this.inL=new Float32Array(this.cap);this.inR=new Float32Array(this.cap);
    this.tmpL=new Float32Array(block);this.tmpR=new Float32Array(block);
    this.accL=new Float32Array(windowSize);this.accR=new Float32Array(windowSize);
    this.readyL=new Float32Array(hop);this.readyR=new Float32Array(hop);
    this.template=new Float32Array(Math.floor(this.M/decimate));
    this.rate=1;this.reset();
  }
  setRate(rate){checkRate(rate);this.rate=rate;}
  reset(){
    // Absolute input index 0 is the first frame pulled after a reset; earlier indexes read as silence.
    this.base=-(this.N+2*this.tol+this.Hs+this.dec);
    this.inL.fill(0);this.inR.fill(0);this.inEnd=0;this.accL.fill(0);this.accR.fill(0);
    this.readyPos=this.Hs;this.hopAna=0;this.prevC=null;this.map=[];this.primed=false;this.finished=false;
    this.j=-3;this.a=-(this.N/2)*(1-this.rate)-3*this.Hs*this.rate;this.endAbs=null;
  }
  // ----- input side -----
  compact(){
    const keep=Math.min(this.prevC===null?Infinity:this.prevC+this.Hs,Math.round(this.a)-this.tol)-this.dec-8;
    const drop=Math.floor(keep-this.base);if(drop<=0)return;
    const live=this.inEnd-this.base-drop;
    this.inL.copyWithin(0,drop,drop+live);this.inR.copyWithin(0,drop,drop+live);this.base+=drop;
  }
  ensure(upTo){
    while(this.inEnd<upTo){
      if(this.inEnd-this.base+this.block>this.cap)this.compact();
      if(this.inEnd-this.base+this.block>this.cap)throw Error('Stretch buffer overflow');
      const first=this.pull(this.tmpL,this.tmpR,this.block),at=this.inEnd-this.base;
      this.inL.set(this.tmpL,at);this.inR.set(this.tmpR,at);
      this.map.push([this.inEnd,first]);if(this.map.length>512)this.map.shift();
      this.inEnd+=this.block;
    }
  }
  // Source frame heard at a given absolute input position (clamped to what has been pulled).
  sourceAt(abs){
    const map=this.map;if(!map.length)return 0;
    let entry=map[0];for(let i=map.length-1;i>=0;i--)if(map[i][0]<=abs){entry=map[i];break;}
    return entry[1]+(abs-entry[0]);
  }
  // Source frame of the output sample about to be heard.
  currentSourceFrame(){return this.sourceAt(this.hopAna+(this.readyPos)*this.rate);}
  // ----- the WSOLA step -----
  search(center){
    const {M,dec,tol}=this,nT=this.template.length,p=this.prevC+this.Hs,tpl=this.template,base=this.base,L=this.inL,R=this.inR;
    for(let i=0;i<nT;i++){const k=p+i*dec-base;tpl[i]=.5*(L[k]+R[k]);}
    const score=cand=>{
      let dot=0,energy=0;
      for(let i=0,k=cand-base;i<nT;i++,k+=dec){const v=.5*(L[k]+R[k]);dot+=tpl[i]*v;energy+=v*v;}
      return energy>1e-12?dot/Math.sqrt(energy):0;
    };
    let best=-Infinity,bestC=center;
    for(let cand=center-tol;cand<=center+tol;cand+=dec){const s=score(cand);if(s>best){best=s;bestC=cand;}}
    for(let cand=bestC-dec+1;cand<bestC+dec;cand++){const s=score(cand);if(s>best){best=s;bestC=cand;}}
    return bestC;
  }
  step(){
    const {N,Hs}=this,j=this.j,nominal=Math.round(this.a);
    this.ensure(nominal+this.tol+N+this.dec+2);
    const c=this.prevC===null||j<1?nominal:this.search(nominal),off=c-this.base,win=this.win,accL=this.accL,accR=this.accR,L=this.inL,R=this.inR;
    for(let i=0;i<N;i++){const w=win[i];accL[i]+=w*L[off+i];accR[i]+=w*R[off+i];}
    if(j>=0){
      for(let i=0;i<Hs;i++){this.readyL[i]=.5*accL[i];this.readyR[i]=.5*accR[i];}
      this.readyPos=0;this.hopAna=this.a+(N/2)*(1-this.rate);
    }
    accL.copyWithin(0,Hs);accR.copyWithin(0,Hs);accL.fill(0,N-Hs);accR.fill(0,N-Hs);
    this.prevC=c;this.a+=Hs*this.rate;this.j++;
  }
  // Whether a further hop of output needs fresh input (so the caller can stop feeding when paused).
  get readyRemaining(){return this.Hs-this.readyPos;}
  render(left,right){
    if(!this.primed){this.a=-(this.N/2)*(1-this.rate)-3*this.Hs*this.rate;while(this.j<0)this.step();this.primed=true;}
    for(let i=0;i<left.length;i++){
      if(this.readyPos>=this.Hs)this.step();
      left[i]=this.readyL[this.readyPos];right[i]=this.readyR[this.readyPos];this.readyPos++;
    }
  }
}
