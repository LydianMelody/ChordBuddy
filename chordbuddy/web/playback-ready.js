// Only the newest selection/readiness response may admit playback.
export class PlaybackGate{
 constructor(transport,fetchState){this.transport=transport;this.fetchState=fetchState;this.version=0;this.admitting=false;}
 block(reason){this.version++;this.transport.blockPlayback(reason);}
 async refresh(songId){
  if(this.admitting)return;
  const ticket=++this.version;
  try{
   const state=await this.fetchState(songId);
   if(ticket!==this.version||songId!==this.transport.getSnapshot().songId)return;
   await this.transport.setReadiness(state);
   return state;
  }catch(error){
   if(ticket!==this.version||songId!==this.transport.getSnapshot().songId)return;
   this.transport.blockPlayback('Could not verify analysis. Reconnecting.');throw error;
  }
 }
 async analyze(songId,start){
  if(this.admitting)return;
  this.admitting=true;this.block('Analysis in progress. Playback is paused until it finishes.');
  try{return await start();}
  finally{this.admitting=false;await this.refresh(this.transport.getSnapshot().songId);}
 }
}
