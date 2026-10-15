import {defaultMix,PcmMixer} from './pcm-mixer-core.js';
import {createPcmSession} from './pcm-session.js';
const noLoop=()=>({enabled:false,start:null,end:null,implicit:false});
const initialState=songId=>({songId,runId:null,ready:false,readiness:'Analyze this song to enable playback.',mode:'stems',seconds:0,duration:0,playing:false,playIntent:false,buffering:false,error:null,mix:defaultMix(),loop:noLoop(),rate:100,levels:null});
export class Transport{
 constructor({audio,token,createPcm=createPcmSession}){
  this.audio=audio;this.token=token;this.factory=createPcm;this.listeners=new Set();this.serial=0;this.pcm=null;this.active=false;this.separation=null;this.sessionEpoch=null;
  this.state=initialState(null);
  // Source audio is an analysis asset, never a second practice playback clock.
  audio.addEventListener('play',()=>audio.pause());
 }
 emit(){for(const fn of this.listeners)fn(this.getSnapshot());}
 subscribe(fn){this.listeners.add(fn);fn(this.getSnapshot());return()=>this.listeners.delete(fn);}
 getDiagnostics(){return this.diagnostics?{...this.diagnostics}:null;}
 getSnapshot(){return {...this.state,mix:structuredClone(this.state.mix)};}
 clearSession(){
  this.serial++;this.sessionEpoch=null;this.pcm?.play(false);this.pcm?.dispose();this.pcm=null;this.active=false;
  this.pendingManifest=null;this.currentManifest=null;this.priming=false;this.audio.pause();
 }
 async loadSong({songId}){
  this.clearSession();this.separation=null;this.state=initialState(songId);this.diagnostics=null;
  this.audio.removeAttribute?.('src');this.audio.load();this.emit();
 }
 blockPlayback(reason){
  this.clearSession();this.state.ready=false;this.state.readiness=reason;this.state.playIntent=false;this.state.playing=false;this.state.levels=null;
  this.state.buffering=false;this.state.runId=null;this.emit();
 }
 async setReadiness(value){
  if(value?.song_id!==this.state.songId)return;
  const manifest=value.active;
  if(!value.ready||!manifest||manifest.song_id!==this.state.songId||!Number.isSafeInteger(manifest.frames)||manifest.frames<=0){
   this.blockPlayback(value.reason||'Analyze this song to enable playback.');return;
  }
  if(this.separation?.run_id!==manifest.run_id){
   this.blockPlayback('Loading completed analysis.');this.separation=manifest;
  }
  this.state.duration=manifest.frames/44100;this.state.seconds=Math.min(this.state.seconds,this.state.duration);
  this.state.ready=true;this.state.readiness=value.reason||'Analysis ready.';this.emit();
 }
 failPlayback(error,seconds=this.state.seconds){
  this.clearSession();this.state.seconds=seconds;this.state.runId=null;this.state.playIntent=false;this.state.playing=false;this.state.levels=null;this.state.buffering=false;
  this.state.error=error?.message||String(error);this.emit();
 }
 async play(){
  if(!this.state.ready)return;
  this.state.playIntent=true;this.state.error=null;
  if(this.active){
   const serial=this.serial,pcm=this.pcm;
   try{
    await pcm.resume();
    if(serial!==this.serial||pcm!==this.pcm||!this.state.playIntent)return;
    pcm.play(true);
   }catch(error){
    if(serial!==this.serial||pcm!==this.pcm)return;
    this.failPlayback(error);throw error;
   }
  }else if(!this.state.buffering)await this.handoff(this.separation,this.state.seconds);
  this.emit();
 }
 pause(){this.state.playIntent=false;this.state.playing=false;this.state.levels=null;this.pcm?.play(false);this.audio.pause();this.emit();}
 async seek(seconds){
  if(!this.state.ready||!Number.isFinite(seconds))return;
  const target=Math.max(0,Math.min(this.state.duration,seconds));
  if(!this.active&&!this.state.buffering){this.state.seconds=target;this.emit();return;}
  await this.handoff(this.pendingManifest||this.currentManifest||this.separation,target);
 }
 // Loop playback: with a range set and enabled, the stream wraps from the range end back to its start inside the audio queue (seamless).
 // Changing the loop re-primes the stream (like a seek), so it can change while playing without losing play/pause intent.
 async setLoop(value,{seekTo}={}){
  const next=value?{enabled:!!value.enabled,start:value.start??null,end:value.end??null,implicit:!!value.implicit}:noLoop();
  if(next.start!==null||next.end!==null){if(!Number.isFinite(next.start)||!Number.isFinite(next.end)||next.start<0||next.end<=next.start||next.end>(this.state.duration||Infinity))throw Error('Choose a loop inside the song.');}
  if(next.enabled&&next.start===null)throw Error('Choose a loop range first.');
  this.state.loop=next;this.emit();
  const manifest=this.pendingManifest||this.currentManifest||this.separation;
  if((this.active||this.state.buffering)&&manifest)await this.handoff(manifest,Number.isFinite(seekTo)?Math.max(0,Math.min(this.state.duration,seekTo)):this.state.seconds);
  else if(Number.isFinite(seekTo))this.state.seconds=Math.max(0,Math.min(this.state.duration,seekTo)),this.emit();
 }
 loopFrames(manifest){
  const l=this.state.loop;if(!l.enabled||l.start===null)return null;
  const start=Math.round(l.start*44100),end=Math.min(manifest.frames,Math.round(l.end*44100));
  return end>start?{start,end}:null;
 }
 // Practice speed as a percentage (50-125). Pitch is preserved: the audio worklet time-stretches the mixed output.
 async setRate(percent){
  if(!Number.isFinite(percent)||percent<50||percent>125)throw Error('Speed must be between 50% and 125%.');
  this.state.rate=percent;this.pcm?.rate?.(percent/100);this.emit();
 }
 setMix(value){const validator=new PcmMixer();validator.setMix(value);this.state.mix=structuredClone(value);this.pcm?.mix(value);this.emit();}
 async setMode(mode){
  if(mode!=='stems')throw Error('Practice playback uses processed stems.');
  if(!this.state.ready||this.state.buffering||this.active)return;
  await this.handoff(this.separation,this.state.seconds);
 }
 async handoff(manifest,seconds){
  if(!this.state.ready||!manifest)return;
  const serial=++this.serial;this.pendingManifest=manifest;
  this.state.seconds=seconds;this.state.buffering=true;this.state.playing=false;this.state.error=null;
  this.audio.pause();this.pcm?.play(false);this.emit();
  try{
   if(!this.pcm){
    const songId=this.state.songId,epoch={};this.sessionEpoch=epoch;
    const current=()=>this.sessionEpoch===epoch&&songId===this.state.songId;
    const pcm=await this.factory({token:this.token,onPosition:m=>{
     if(!current()||!this.state.ready||!this.active||m.runId!==this.state.runId||this.state.buffering&&this.priming)return;
     this.diagnostics={...m,wall:performance.now()};
     this.state.seconds=Math.min(this.state.duration,Math.max(0,m.sourceFrame/44100-(m.state==='playing'?m.latency||0:0)));
     this.state.levels=this.state.playIntent&&Array.isArray(m.levels)?m.levels:null;
     this.state.playing=this.state.playIntent&&m.state==='playing'&&m.contextState!=='suspended';this.state.buffering=m.state==='buffering';
     if(m.state==='ended')this.state.playIntent=false;this.emit();
    },onError:error=>{if(current())this.failPlayback(error);}});
    if(serial!==this.serial){pcm.dispose();return;}this.pcm=pcm;
   }
   this.priming=true;
   await this.pcm.prime(manifest,Math.min(manifest.frames,Math.floor(seconds*44100)),this.loopFrames(manifest));
   if(serial!==this.serial)return;
   this.currentManifest=manifest;this.active=true;this.state.runId=manifest.run_id;this.state.duration=manifest.frames/44100;this.state.seconds=Math.min(seconds,this.state.duration);
   this.state.buffering=false;this.priming=false;this.pendingManifest=null;this.pcm.mix(this.state.mix);this.pcm.mode('stems');this.pcm.rate?.(this.state.rate/100);
   const pcm=this.pcm;await pcm.resume();
   if(serial!==this.serial||pcm!==this.pcm)return;
   pcm.play(this.state.playIntent);this.emit();
  }catch(error){
   if(serial!==this.serial)return;
   this.failPlayback(error,seconds);throw error;
  }
 }
 dispose(){this.clearSession();this.state.playIntent=false;this.state.playing=false;this.listeners.clear();}
}
