// Small, safe edits to a note in the lead sheet's ABC text. Only the pitch part of one note is rewritten (never its length, its chord
// symbol or anything around it), so the bars keep exactly the length the chord chart's grid expects.
//
// ABC pitch: C D E F G A B is the octave from middle C (C4); c d e f g a b is the octave above; "," lowers an octave and "'" raises one.
// A leading ^ (sharp), _ (flat) or = (natural) is an accidental; without one the key signature decides.
const LETTERS='CDEFGAB';
const DIATONIC={C:0,D:1,E:2,F:3,G:4,A:5,B:6};

// Where the pitch sits inside a note's text (the text may begin with a "chord symbol", !decorations! or ~ . and end with a length).
// Returns null for rests, chords in [brackets], and anything that is not a single note.
export function locatePitch(text){
  let i=0;
  while(i<text.length){
    const c=text[i];
    if(c==='"'){const end=text.indexOf('"',i+1);if(end<0)return null;i=end+1;continue;}
    if(c==='!'||c==='+'){const end=text.indexOf(c,i+1);if(end<0)return null;i=end+1;continue;}
    if('~.HIJKLMNOPQRSTUVWuv'.includes(c)||/\s/.test(c)){i++;continue;}
    break;
  }
  const accStart=i;while(i<text.length&&'^_='.includes(text[i]))i++;
  const accEnd=i,letter=text[i];
  if(!letter||!/[A-Ga-g]/.test(letter))return null;
  i++;const marksStart=i;while(i<text.length&&(text[i]===','||text[i]==="'"))i++;
  return {accStart,accEnd,letterAt:accEnd,marksStart,marksEnd:i,accidental:text.slice(accStart,accEnd),letter,marks:text.slice(marksStart,i)};
}
// Diatonic step counted from middle C (C4 = 0, D4 = 1, … C5 = 7, B3 = -1).
export function stepOf(part){
  const upper=part.letter===part.letter.toUpperCase(),name=part.letter.toUpperCase();
  let octave=upper?4:5;for(const m of part.marks)octave+=m==="'"?1:-1;
  return (octave-4)*7+DIATONIC[name];
}
export function spellStep(step){
  const octave=4+Math.floor(step/7),index=((step%7)+7)%7,letter=LETTERS[index];
  if(octave<=4)return {letter,marks:','.repeat(4-octave)};
  return {letter:letter.toLowerCase(),marks:"'".repeat(octave-5)};
}
const ACC_TEXT={sharp:'^',flat:'_',natural:'=','':''};

// What a note is called, for showing: "F♯5". `keyAccidentals` is abcjs' key signature list [{acc:'sharp',note:'f'}].
export function noteName(text,keyAccidentals=[]){
  const part=locatePitch(text);if(!part)return null;
  const step=stepOf(part),octave=4+Math.floor(step/7),name=LETTERS[((step%7)+7)%7];
  const written={'^':'♯','^^':'𝄪','_':'♭','__':'𝄫','=':'♮'}[part.accidental];
  const fromKey=keyAccidentals.find(k=>String(k.note).toUpperCase()===name);
  const mark=written??(part.accidental===''&&fromKey?{sharp:'♯',flat:'♭'}[fromKey.acc]||'':'');
  return name+mark+octave;
}

// Each editor takes the note's text and returns the new text, or null when that edit does not apply (a rest, a chord, …).
export function shiftSteps(text,delta){
  const part=locatePitch(text);if(!part||!Number.isInteger(delta))return null;
  const next=spellStep(stepOf(part)+delta);
  if(stepOf(part)+delta<-14||stepOf(part)+delta>27)return null;                  // stay on the staff's side of sanity
  // Moving along the scale: the key signature decides the accidental again.
  return text.slice(0,part.accStart)+next.letter+next.marks+text.slice(part.marksEnd);
}
export function toggleAccidental(text,kind){
  const part=locatePitch(text);if(!part||!ACC_TEXT[kind])return null;
  const want=ACC_TEXT[kind],has=part.accidental===want;
  return text.slice(0,part.accStart)+(has?'':want)+text.slice(part.letterAt);
}
// A rest of the same length. The chord symbol before it stays, and a tie into the next note is dropped.
export function toRest(text){
  const part=locatePitch(text);if(!part)return null;
  const after=text.slice(part.marksEnd).replace(/-/g,'');
  return text.slice(0,part.accStart)+'z'+after;
}

// Applies one of the edits above to the note at [startChar, endChar) of a lead-sheet document's content.
// The chord labels remember where they sit in the text, so those after the edit are moved along.
export function editNoteInContent(content,startChar,endChar,edit){
  const abc=content.abc,old=abc.slice(startChar,endChar),next=edit(old);
  if(next===null||next===old)return null;
  const delta=next.length-old.length;
  const chords=(content.chords||[]).map(chord=>Number.isInteger(chord.abc_index)&&chord.abc_index>=endChar?{...chord,abc_index:chord.abc_index+delta}:chord);
  return {...content,abc:abc.slice(0,startChar)+next+abc.slice(endChar),chords};
}
