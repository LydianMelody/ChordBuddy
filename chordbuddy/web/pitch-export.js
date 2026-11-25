// Pitch control's sound exports (Sound switch on, pitch not 0): the MP3 mix and the stems are moved by the same Signalsmith engine as
// playback, in a worker (pitch-render-worker.js), one part at a time; the server encodes each part and the finished file is downloaded
// through an ordinary link. If the pitch can't be applied the export fails with a plain message: it never quietly saves unpitched audio.
export const STEM_PARTS=['vocals','lead','rhythm','bass','drums','piano','other'];

const job=()=>Array.from(crypto.getRandomValues(new Uint8Array(10)),b=>b.toString(16).padStart(2,'0')).join('');

// One part in a worker. onProgress(0..1). Resolves true when done, false when the song has no such part (a stem it doesn't have).
function renderPart({pcmUrl,uploadUrl,token,semitones},onProgress,makeWorker){
  return new Promise((resolve,reject)=>{
    const worker=makeWorker();
    worker.onmessage=({data})=>{
      if(data.progress!==undefined){onProgress(data.progress);return;}
      worker.terminate();
      if(data.done)resolve(true);
      else if(data.status===404)resolve(false);
      else reject(new Error(data.error||'The export failed.'));
    };
    worker.onerror=event=>{worker.terminate();reject(new Error(event.message||'The export failed.'));};
    worker.postMessage({pcmUrl,uploadUrl,token,semitones});
  });
}

// kind: 'mix' (mixQuery: the faders, as for the plain MP3 mix) or 'stems'. Returns the download URL of the finished file.
export async function exportPitched({kind,runId,mixQuery='',title,semitones,token,onProgress=()=>{},makeWorker=()=>new Worker('/pitch-render-worker.js',{type:'module'})}){
  if(!Number.isInteger(semitones)||!semitones)throw new Error('There is no pitch change to export.');
  const id=job(),run=encodeURIComponent(runId);
  const parts=kind==='mix'?[{part:'mix',query:mixQuery}]:STEM_PARTS.map(part=>({part,query:'stem='+part}));
  let made=0;
  for(const [index,{part,query}] of parts.entries()){
    const ok=await renderPart({pcmUrl:`/api/mix-pcm/${run}?${query}`,uploadUrl:`/api/pitch-export/part?job=${id}&part=${part}`,token,semitones},
      p=>onProgress((index+p)/parts.length),makeWorker);
    if(ok)made++;
  }
  if(!made)throw new Error('There was nothing to export.');
  onProgress(1);
  return `/api/pitch-export/${id}?kind=${kind}&name=${encodeURIComponent(title)}&token=${encodeURIComponent(token)}`;
}
