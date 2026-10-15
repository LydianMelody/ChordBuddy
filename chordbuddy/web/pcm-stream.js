export const MAX_BUFFERED_FRAMES=441000;
export function availableCredit(sentEnd,consumedFrame){return Math.max(0,MAX_BUFFERED_FRAMES-(sentEnd-consumedFrame));}
export function validateChunk(headers,buffer,expected){
 const count=Number(headers.get('X-Stem-Frame-Count'));
 if(headers.get('X-Stem-Run-Id')!==expected.runId||Number(headers.get('X-Stem-Start-Frame'))!==expected.startFrame||Number(headers.get('X-Stem-Sample-Rate'))!==44100||!Number.isSafeInteger(count)||count!==expected.frameCount||buffer.byteLength!==count*64)throw Error('Invalid PCM response');
 return count;
}


// Loop streaming. The worker and the mixer share this one rule so they always agree on what the next chunk is:
// chunks never straddle the loop end, and the chunk that ends exactly on it is followed by one starting at the loop start.
export const CHUNK_FRAMES=44100;
export function planChunk({sentEnd,frames,loop}){
 const inLoop=!!loop&&sentEnd<loop.end;
 const limit=inLoop?loop.end:frames;
 const frameCount=Math.min(CHUNK_FRAMES,limit-sentEnd),end=sentEnd+frameCount;
 return {startFrame:sentEnd,frameCount,nextSentEnd:inLoop&&end===loop.end?loop.start:end};
}
// A loop is "engaged" when streaming starts before its end; only then does the stream wrap (and never run out).
export const loopEngaged=(loop,startFrame)=>!!loop&&startFrame<loop.end;
export function validLoop(loop,totalFrames){
 return loop===null||loop===undefined||(Number.isSafeInteger(loop.start)&&Number.isSafeInteger(loop.end)&&loop.start>=0&&loop.start<loop.end&&loop.end<=totalFrames);
}
