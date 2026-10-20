// Note names follow the song's key: F minor has four flats, so its chords are Bb, Eb, Db and Ab, never A#, D#, C# and G#. The analysis names
// every black key with a sharp. Only what is drawn is respelled (the pitch is the same); a chord's saved label is left as it was.
const SHARP=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const PITCH={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const FLAT_MAJOR=new Set([5,10,3,8,1]),FLAT_MINOR=new Set([2,7,0,5,10]);   // keys usually written with flats; the rest use sharps
let names=null;                                                          // null: leave the spelling as it is

const pitchOf=(letter,accidentals)=>{let pitch=PITCH[letter];for(const c of accidentals)pitch+=c==='#'?1:-1;return ((pitch%12)+12)%12;};

// 'F minor' -> true, 'E major' -> false, 'Bb major' -> true.
export function keyUsesFlats(name){
  const match=/^([A-G])([#b]?)\s+(major|minor)$/.exec(String(name||'').trim());if(!match)return null;
  if(match[2])return match[2]==='b';
  return (match[3]==='minor'?FLAT_MINOR:FLAT_MAJOR).has(pitchOf(match[1],''));
}
// name: the key's name ('F minor'), or null for no key (chords are then shown as they are).
export function setKeySpelling(name){const flats=keyUsesFlats(name);names=flats===null?null:flats?FLAT:SHARP;}

// A chord label as it should be drawn in the current key: its root and its bass note (after the slash) respelled, the rest untouched.
export function spellChord(label){
  if(!names||typeof label!=='string')return label;
  const match=/^([A-G])([#b]{1,2})?(.*?)(?:\/([A-G])([#b]{1,2})?)?$/.exec(label);if(!match)return label;
  const [,root,rootMark='',quality,bass,bassMark='']=match;
  const spell=(letter,mark)=>mark?names[pitchOf(letter,mark)]:letter;
  return spell(root,rootMark)+quality+(bass?'/'+spell(bass,bassMark):'');
}

// The lead sheet's ABC text with each linked chord symbol respelled for the key. A name that would change length (a double sharp becoming a
// plain note) is left alone, so every position in the text, and every chord's link to it, stays where it was.
export function spellAbc(abc,chords){
  if(!names||typeof abc!=='string')return abc;
  let out=abc;
  for(const chord of chords||[]){
    const index=chord?.abc_index;if(!Number.isInteger(index)||abc[index]!=='"')continue;
    const end=abc.indexOf('"',index+1);if(end<0)continue;
    const label=abc.slice(index+1,end),spelled=spellChord(label);
    if(spelled!==label&&spelled.length===label.length)out=out.slice(0,index+1)+spelled+out.slice(end);
  }
  return out;
}
