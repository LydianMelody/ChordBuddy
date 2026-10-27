// Does the recording fade out? Read from the waveform's peak outline (the one the player draws) and the beat grid, so it works for
// every analyzed song without another analysis. A fade is told apart from the other ways a song goes quiet at the end:
//  - a final hit ringing out, or a sudden step down into a quieter ending, drops sharply (a fade eases down over seconds);
//  - a long quiet outro dying away over most of a minute is an outro, not a fade;
//  - an ending where the band stops has its beats stop too (in a fade the beat goes on to the very end of the file);
//  - a quiet outro that comes back up is not a fade (a fade only goes down).
// Returns {start} (seconds: where the music starts to fade) or null.
const FULL=-3,DOWN=-12,SILENT=-20;          // dB against the song's usual loudness: still full, clearly fading, nearly gone
export function detectFadeOut(peaks,duration,beats){
  if(!Array.isArray(peaks)||peaks.length<64||!(duration>20)||!Array.isArray(beats)||beats.length<8)return null;
  const n=peaks.length,bin=duration/n,db=peaks.map(p=>20*Math.log10(Math.max(p,1e-6)));
  // the loudness envelope: the loudest peak within about a second (peaks dip between beats)
  const reach=Math.max(1,Math.round(.5/bin)),env=db.map((_,i)=>Math.max(...db.slice(Math.max(0,i-reach),i+reach+1)));
  const middle=env.slice(Math.floor(n*.2),Math.floor(n*.85)).sort((a,b)=>a-b),usual=middle[Math.floor(middle.length/2)];
  const level=i=>env[i]-usual;
  const lastSecond=env.slice(-Math.max(1,Math.round(1/bin))).map(v=>v-usual);
  if(Math.max(...lastSecond)>SILENT)return null;                                         // it never gets quiet
  let full=n-1;while(full>0&&level(full)<FULL)full--;                                     // the last moment at full loudness
  const start=(full+1)*bin,length=duration-start;
  if(length<4||length>30)return null;
  let down=full+1;while(down<n&&level(down)>DOWN)down++;
  if((down-full)*bin<4.5)return null;                                                     // it got quiet too quickly to be a fade
  const second=Math.max(1,Math.round(1/bin));
  for(let i=full;i+second<=down&&i+second<n;i++)if(level(i)-level(i+second)>4.5)return null;   // a sudden step down, not easing
  let lowest=Infinity;
  for(let i=full+1;i<n;i++){lowest=Math.min(lowest,level(i));if(level(i)-lowest>6)return null;}   // it came back up
  const sorted=[...beats].sort((a,b)=>a-b),gaps=sorted.slice(1).map((t,i)=>t-sorted[i]).sort((a,b)=>a-b),period=gaps[Math.floor(gaps.length/2)];
  if(!(period>0)||duration-sorted.at(-1)>1.25*period)return null;                        // the beat stopped: the band ended it
  return {start};
}
