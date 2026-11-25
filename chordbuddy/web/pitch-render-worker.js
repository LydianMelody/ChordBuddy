// Renders one part of a pitched export (the mix, or one stem) off the page: reads the plain audio as float PCM from the server, moves its
// pitch with Signalsmith Stretch exactly as playback does (the same engine and settings, so the file sounds like what you heard), and
// uploads it as 16-bit PCM for the server to encode. Messages in: {pcmUrl, uploadUrl, token, semitones}. Out: {progress}, {done}, {error, status}.
import {loadStretchEngine,SignalsmithStretcher} from './time-stretch.js';

const RATE=44100,BLOCK=4096;
const fail=(error,status=0)=>postMessage({error:String(error?.message||error),status});

self.onmessage=async({data:{pcmUrl,uploadUrl,token,semitones}})=>{
  try{
    const engine=await loadStretchEngine(RATE);
    if(!engine)return fail('The pitch engine could not start, so nothing was exported. The song plays as before.');
    const response=await fetch(pcmUrl,{headers:{'X-ChordBuddy-Token':token}});
    if(!response.ok){let message='The audio could not be read for the export.';try{message=(await response.json()).error||message;}catch{}return fail(message,response.status);}
    // read it all, reporting progress (reading is the first half of the work)
    const size=Number(response.headers.get('Content-Length'))||0,bytes=new Uint8Array(size);
    const reader=response.body.getReader();let got=0;
    for(;;){const {done,value}=await reader.read();if(done)break;bytes.set(value,got);got+=value.length;if(size)postMessage({progress:.5*got/size});}
    if(got!==size)return fail('The audio stopped arriving partway. Try the export again.');
    const pcm=new Float32Array(bytes.buffer),frames=pcm.length/2;
    let next=0;
    const pull=(left,right,count)=>{const first=next;for(let i=0;i<count;i++,next++){const k=next<frames?next*2:-1;left[i]=k<0?0:pcm[k];right[i]=k<0?0:pcm[k+1];}return first;};
    const stretch=new SignalsmithStretcher({pull,engine});stretch.setRate(1);stretch.setSemitones(semitones);
    const out=new Int16Array(frames*2),l=new Float32Array(BLOCK),r=new Float32Array(BLOCK);
    for(let at=0;at<frames;at+=BLOCK){
      const n=Math.min(BLOCK,frames-at),left=l.subarray(0,n),right=r.subarray(0,n);
      stretch.render(left,right);
      for(let i=0;i<n;i++){out[(at+i)*2]=Math.max(-32768,Math.min(32767,Math.round(left[i]*32767)));out[(at+i)*2+1]=Math.max(-32768,Math.min(32767,Math.round(right[i]*32767)));}
      if(at%(BLOCK*64)===0)postMessage({progress:.5+.45*at/frames});
    }
    const upload=await fetch(uploadUrl,{method:'POST',headers:{'X-ChordBuddy-Token':token,'Content-Type':'application/octet-stream'},body:out.buffer});
    if(!upload.ok){let message='The export could not be saved.';try{message=(await upload.json()).error||message;}catch{}return fail(message,upload.status);}
    postMessage({done:true});
  }catch(error){fail(error);}
};
