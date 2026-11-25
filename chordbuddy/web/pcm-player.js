// The stem player the audio worklet runs: a PcmMixer plus an optional time stretch, which can also move the pitch.
// Normal speed and pitch use the mixer directly, exactly as before. Any other speed, a pitch change, or a song whose pitch has been
// changed at all ("keep": see setPitch) switches (until the next seek or reset) to a stretched path that stretches the already-mixed
// stereo output, so all stems stay in time with each other and with loops.
import {PcmMixer,RAMP} from './pcm-mixer-core.js';
import {checkRate,checkSemitones,createStretcher,stretchEngine,SignalsmithStretcher} from './time-stretch.js';

export class StemPlayer{
  constructor(mixer=new PcmMixer()){
    this.mixer=mixer;this.rate=1;this.semitones=0;this.keep=false;this.stretch=null;this.env=0;this.endedHeard=false;
  }
  // The stretcher runs whenever the speed or pitch asks for it, and stays running for a song whose pitch has been touched, so later pitch
  // changes are smooth (starting it mid-song is a small jump in the sound).
  get wantsStretch(){return this.rate!==1||this.semitones!==0||this.keep;}
  reset(message){
    this.mixer.reset(message);this.stretch=null;this.env=0;this.endedHeard=false;
    if(this.wantsStretch)this.startStretch();   // a seek or loop change keeps the chosen speed and pitch
  }
  setRate(rate){
    checkRate(rate);
    this.rate=rate;
    if(this.stretch)this.stretch.setRate(rate);
    else if(this.wantsStretch)this.startStretch();
  }
  // value: {semitones: -6..+6, keep: keep the stretcher running even at pitch 0 and normal speed}.
  setPitch(value){
    const semitones=value?.semitones??0;checkSemitones(semitones);
    this.semitones=semitones;this.keep=!!value?.keep;
    if(this.stretch)this.stretch.setSemitones(semitones);
    else if(this.wantsStretch)this.startStretch();
  }
  startStretch(){
    const mixer=this.mixer;
    this.stretch=createStretcher({pull:(l,r,n)=>mixer.pullMixed(l,r)});
    this.stretch.setRate(this.rate);this.stretch.setSemitones(this.semitones);
    this.env=mixer.envelope;                 // carry the current fade level across, so switching never steps the volume
    this.endedHeard=false;
  }
  get stretching(){return !!this.stretch;}
  // Which stretcher is playing (for diagnostics): 'signalsmith', 'wsola' (the fallback), or null at normal speed.
  get stretcher(){return !this.stretch?null:this.stretch instanceof SignalsmithStretcher?'signalsmith':'wsola';}
  // A pitch is asked for but can't be heard yet: Signalsmith (the only stretcher that moves pitch) is still loading.
  get pitchPending(){return this.semitones!==0&&this.stretcher!=='signalsmith';}
  // Source frame being heard right now.
  get sourceFrame(){return this.stretch?Math.max(0,Math.min(this.mixer.total,Math.round(this.stretch.currentSourceFrame()))):this.mixer.frame;}
  get state(){
    if(!this.stretch)return this.mixer.state;
    if(this.endedHeard)return 'ended';
    if(!this.mixer.playIntent)return 'paused';
    return this.mixer.state==='buffering'?'buffering':'playing';
  }
  render(left,right){
    // Signalsmith has finished loading while the simpler stretcher stands in, and a pitch is waiting: swap to it.
    if(this.pitchPending&&stretchEngine())this.startStretch();
    if(!this.stretch){this.mixer.render(left,right);return;}
    const m=this.mixer,s=this.stretch;
    for(let i=0;i<left.length;i++){
      const playing=m.playIntent;
      if(!playing&&this.env<=0){left[i]=0;right[i]=0;continue;}                    // paused: the stretcher is frozen, nothing is pulled
      if(s.readyPos>=s.Hs){
        if(playing)s.step();
        else this.env=0;                                                          // paused with nothing left to play
      }
      if(s.readyPos>=s.Hs){left[i]=0;right[i]=0;continue;}
      // fade in when (re)starting, out when pausing (never longer than the audio already computed)
      if(playing)this.env=Math.min(1,this.env+1/RAMP);
      else this.env=Math.max(0,Math.min(this.env-1/RAMP,(s.Hs-s.readyPos)/RAMP));
      left[i]=s.readyL[s.readyPos]*this.env;right[i]=s.readyR[s.readyPos]*this.env;s.readyPos++;
      // playback has really ended once the audio being heard has reached the end of the song
      if(m.state==='ended'&&!this.endedHeard&&s.currentSourceFrame()>=m.total-1){this.endedHeard=true;m.playIntent=false;}
    }
  }
}
