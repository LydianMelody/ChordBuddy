// A song's pitch setting, with one owner, so the player bar, chart, lead sheet, MIDI view, exports and visuals all read the same thing.
//   offset: -6..+6 half steps.  sound: the music you hear moves.  chart: the chords and notes you see move.
// Saved per song in the library's settings as 'cb-pitch:<song id>', like the key chip's 'cb-key:<song id>'. Per-song settings travel in
// the song's zip (song_extras.py), so the pitch goes with the song. Nothing here changes saved chord data: transposing is a view.
//
// pitchAt(position) is the pitch in effect at a play position (seconds of playback, which in a show is arrangement time, so two passes
// through one repeat can differ). Practice has no steps, so it is the same everywhere. A show adds steps (Perform's pitch flags).
import {validOffset,wrapOffset} from './transpose.js';

export const DEFAULT_PITCH=Object.freeze({offset:0,sound:true,chart:true});
export const pitchKey=songId=>'cb-pitch:'+songId;

// Saved text -> a clean setting. Anything unreadable falls back to the default, never an error.
export function readPitch(text){
  try{
    const value=JSON.parse(text);
    if(!value||typeof value!=='object')return {...DEFAULT_PITCH};
    return {offset:validOffset(value.offset)?value.offset:0,sound:value.sound!==false,chart:value.chart!==false};
  }catch{return {...DEFAULT_PITCH};}
}
export const writePitch=pitch=>JSON.stringify({offset:pitch.offset,sound:pitch.sound,chart:pitch.chart});
export const samePitch=(a,b)=>a.offset===b.offset&&a.sound===b.sound&&a.chart===b.chart;

// What each side gets from a setting: {sound, chart} in half steps (0 for a side that's switched off).
export const applied=pitch=>({sound:pitch.sound?pitch.offset:0,chart:pitch.chart?pitch.offset:0});

// The pitch in effect at a play position.
//   base: the song's setting.  steps: [{at: seconds, semitones, applyTo: 'both'|'sound'|'chart'}], any order. A step sets the side(s) it
//   names from its moment on, and leaves the other side as it was. Without steps the answer is the same at every position.
export function pitchAt(position,base=DEFAULT_PITCH,steps=[]){
  const now=applied(base);
  if(!steps.length)return now;
  for(const step of [...steps].sort((a,b)=>a.at-b.at)){
    if(step.at>position)break;
    const n=wrapOffset(step.semitones);
    if(step.applyTo!=='chart')now.sound=n;
    if(step.applyTo!=='sound')now.chart=n;
  }
  return now;
}

// The owner. prefs: the app's prefs store (get/set). Listeners hear (pitch, songId) after every real change.
export function createPitchState({prefs}){
  let songId=null,pitch={...DEFAULT_PITCH};
  const listeners=new Set();
  const emit=()=>{for(const fn of listeners)fn({...pitch},songId);};
  return {
    get:()=>({...pitch}),
    get songId(){return songId;},
    // Switch to a song: its saved setting comes back.
    setSong(id){
      const next=id?readPitch(prefs.get(pitchKey(id),'')):{...DEFAULT_PITCH};
      const changed=id!==songId||!samePitch(next,pitch);
      songId=id||null;pitch=next;if(changed)emit();
    },
    // patch: any of {offset, sound, chart}. An offset outside -6..+6 is brought round to the same note inside it.
    set(patch){
      if(!songId)return;
      const next={
        offset:'offset' in patch?wrapOffset(patch.offset):pitch.offset,
        sound:'sound' in patch?!!patch.sound:pitch.sound,
        chart:'chart' in patch?!!patch.chart:pitch.chart,
      };
      if(samePitch(next,pitch))return;
      pitch=next;prefs.set(pitchKey(songId),writePitch(pitch));emit();
    },
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
  };
}
