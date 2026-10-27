import test from 'node:test';
import assert from 'node:assert/strict';
import {detectFadeOut,detectFadeIn} from '../chordbuddy/web/fade-out.js';

// A made-up 120 s song, 1024 peak bins, steady beats every half second. `tail(t)` gives the loudness in dB, 0 = the song's usual level,
// for the seconds t before the end; a little beat-to-beat ripple keeps it like real peaks.
const DURATION=120,N=1024;
function song(tail,{beatsUntil=DURATION}={}){
  const peaks=Array.from({length:N},(_,i)=>{const t=DURATION-(i+.5)*DURATION/N,ripple=i%3?-2:0;return 10**((tail(t)+ripple)/20)*.5;});
  const beats=[];for(let b=0;b<beatsUntil-1e-6;b+=.5)beats.push(b);
  return detectFadeOut(peaks,DURATION,beats);
}
// a fade like Real Thing's: easing down about 12 dB over the first seconds, then falling away to nothing as the file ends
const ramp=(from,length)=>t=>t>=from?0:t>=length*.36?-12*(from-t)/(from-length*.36):-12-58*(length*.36-t)/(length*.36);

test('a fade: the beat goes on while the music eases down to nothing at the end of the file', () => {
  const fade=song(ramp(11,11));
  assert.ok(fade);assert.ok(fade.start>DURATION-11&&fade.start<DURATION-8,`found in the first seconds of the fade (where it is a few dB down), got ${fade.start}`);
});

test('not a fade: a final hit ringing out, a sudden step into a quiet ending, a long quiet outro, or a band that stops', () => {
  assert.equal(song(t=>t>=5?0:-12-(5-t)*10),null,'a hit that drops at once and rings away');
  assert.equal(song(t=>t>=7?0:t>=4?-6-(7-t)*1.5:-11-(4-t)*15),null,'a step down to a quieter last chord, then it ends');
  assert.equal(song(ramp(50,50)),null,'dying away over most of a minute is an outro');
  assert.equal(song(ramp(11,11),{beatsUntil:DURATION-4}),null,'the beat stopped before the end');
  assert.equal(song(()=>0),null,'loud to the last moment');
  assert.equal(song(t=>t>=11?0:t>=5?-15:-10-(5-t)*12),null,'it came back up');
});

test('a fade in is the same thing backwards: the music swells up from silence at the start while the beat already runs', () => {
  const peaks=Array.from({length:N},(_,i)=>{const t=(i+.5)*DURATION/N,ripple=i%3?-2:0;return 10**((ramp(11,11)(t)+ripple)/20)*.5;});
  const beats=[];for(let b=0;b<DURATION;b+=.5)beats.push(b);
  const swell=detectFadeIn(peaks,DURATION,beats);assert.ok(swell);assert.ok(swell.end>8&&swell.end<11,`reaches full volume about 9 s in, got ${swell.end}`);
  assert.equal(detectFadeIn(Array(N).fill(.5),DURATION,beats),null,'loud from the first moment');
});
