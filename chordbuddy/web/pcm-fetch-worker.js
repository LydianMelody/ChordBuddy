import {availableCredit,validateChunk,planChunk,loopEngaged} from './pcm-stream.js';
let session=null,port=null;
self.onmessage=event=>{
 const message=event.data;
 if(message.type==='connect'){port=message.port;port.onmessage=onAudio;port.start();return;}
 if(message.type==='stop'){session?.abort.abort();session=null;return;}
 if(message.type==='load'){
  session?.abort.abort();
  const value={...message,loop:message.loop||null,sentEnd:message.startFrame,sent:0,consumed:0,engaged:loopEngaged(message.loop,message.startFrame),busy:false,abort:new AbortController()};
  session=value;pump(value);
 }
};
function onAudio(event){
 const m=event.data,s=session;
 if(s&&m.generation===s.generation&&m.runId===s.runId&&m.type==='position'){s.consumed=Math.max(s.consumed,m.played??0);pump(s);}
}
async function pump(s){
 if(s!==session||s.busy)return;s.busy=true;
 try{
  while(s===session&&(s.engaged||s.sentEnd<s.frames)){
   const {startFrame,frameCount,nextSentEnd}=planChunk({sentEnd:s.sentEnd,frames:s.frames,loop:s.loop});
   if(availableCredit(s.sent,s.consumed)<frameCount)break;
   const response=await fetch('/api/separation-audio/'+encodeURIComponent(s.runId)+'?start_frame='+startFrame+'&frame_count='+frameCount,{headers:{'X-ChordBuddy-Token':s.token},signal:s.abort.signal});
   if(!response.ok)throw Error('Stem audio unavailable ('+response.status+'). Press Play to retry.');
   const buffer=await response.arrayBuffer();if(s!==session)return;
   validateChunk(response.headers,buffer,{runId:s.runId,startFrame,frameCount});
   s.sentEnd=nextSentEnd;s.sent+=frameCount;
   port.postMessage({type:'chunk',generation:s.generation,runId:s.runId,startFrame,frameCount,buffer},[buffer]);
  }
 }catch(error){if(s===session&&error.name!=='AbortError')port.postMessage({type:'error',generation:s.generation,runId:s.runId,error:error.message});}
 finally{s.busy=false;}
}

