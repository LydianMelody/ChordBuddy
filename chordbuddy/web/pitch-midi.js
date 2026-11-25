// Pitch control for MIDI notes: the melody, chord and instrument notes move with the chart (Chart switch); drums never do. A drum note
// is one on MIDI channel 10 (channel 9 counting from 0, the General MIDI drum channel), or on a track named for drums. Pure, no DOM.
// The saved notes are never changed: this makes a moved copy for drawing, exporting or visuals.

export const DRUM_CHANNEL=9;
export const isDrumTrack=track=>/\b(drums?|percussion|drum ?kit)\b/i.test(String(track?.name||''));
export const isDrumNote=(note,tracks=[])=>note?.channel===DRUM_CHANNEL||isDrumTrack(tracks[note?.track]);

// content: {notes:[{pitch,start,...}], tracks}. offsetAt(seconds) -> half steps at that moment (a number works too, for one offset).
// Returns the same object when nothing moves, otherwise a copy with moved pitches (kept inside MIDI's 0..127).
export function shiftMidiContent(content,offsetAt){
  if(!content?.notes?.length)return content;
  const at=typeof offsetAt==='function'?offsetAt:()=>offsetAt||0;
  let moved=false;
  const notes=content.notes.map(note=>{
    if(isDrumNote(note,content.tracks))return note;
    const n=at(note.start)||0;if(!n)return note;
    moved=true;return {...note,pitch:Math.max(0,Math.min(127,note.pitch+n))};
  });
  return moved?{...content,notes}:content;
}
