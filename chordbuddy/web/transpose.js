// Pitch control's music core: moving chord names and keys up or down without touching saved data. Pure code, no DOM.
//
// A pitch offset is -6..+6 half steps. Chords move by the INTERVAL from the song's key to the key shown, counted in letters as well as
// half steps (C -> G is up 4 letters and 7 half steps), so names come out spelled as a musician would: F in C becomes C in G, and a chord
// typed while the song is shown in another key is moved back by the same interval before it's saved (F typed in G saves as Bb in C).
// A result that would need a double sharp or double flat is written as its plain neighbor (F## -> G), unless the chord had one already.
import {keyName} from './key-estimate.js';

const LETTERS='CDEFGAB';
const NATURAL={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const SHARP=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
export const MIN_OFFSET=-6,MAX_OFFSET=6;

const mod=(n,m)=>((n%m)+m)%m;
const marks=accidentals=>[...accidentals].reduce((n,c)=>n+(c==='#'?1:-1),0);
const markText=n=>n>0?'#'.repeat(n):'b'.repeat(-n);

// 'F#' -> 6, 'Db' -> 1, 'Cb' -> 11, 'B#' -> 0, 'e' -> 4; Unicode ♯ and ♭ and surrounding spaces are fine. Anything else (a quality
// like 'Am', a double accidental, an empty box) -> null.
export function pitchOfLetter(text){
  const match=/^\s*([A-Ga-g])\s*([#♯]|[b♭])?\s*$/.exec(String(text??''));if(!match)return null;
  const sign=!match[2]?0:/[#♯]/.test(match[2])?1:-1;
  return mod(NATURAL[match[1].toUpperCase()]+sign,12);
}

// 'C# minor' -> {letter:'C', pitch:1, mode:'minor'}, or null for no key.
export function parseKey(name){
  const match=/^([A-G])([#b]?)\s+(major|minor)$/.exec(String(name||'').trim());if(!match)return null;
  return {letter:match[1],pitch:mod(NATURAL[match[1]]+marks(match[2]),12),mode:match[3]};
}

// One step up or down, coming round the corner: + past +6 is -5, - past -6 is +5 (the same note an octave over, kept near center).
export function stepOffset(offset,direction){
  const next=offset+(direction>0?1:-1);
  return next>MAX_OFFSET?next-12:next<MIN_OFFSET?next+12:next;
}
// Any whole number of half steps -> the same note within -6..+6 (+7 -> -5, -7 -> +5; ±6 stay as they are).
export function wrapOffset(n){
  n=Math.round(Number(n)||0);
  while(n>MAX_OFFSET)n-=12;
  while(n<MIN_OFFSET)n+=12;
  return n;
}
export const validOffset=n=>Number.isInteger(n)&&n>=MIN_OFFSET&&n<=MAX_OFFSET;

// Typing a key letter: the offset that reaches that note the shorter way from where the song is shown now (a tritone tie goes up).
// songTonic: the song's own tonic pitch (0-11); current: the offset now; target: the typed note's pitch.
export function nearestStep(current,target,songTonic){
  const shown=mod(songTonic+current,12),delta=mod(target-shown,12);
  return wrapOffset(current+(delta>6?delta-12:delta));
}

// The interval from the song's key to the key shown at `offset` -> {offset, semis, letters, key}. key is the shown key's name, in the
// app's usual spelling for that key ('Eb major', 'C# minor'). With no song key there is no letter count: letters is null, and names are
// spelled by each chord's own accidental (see transposeChord).
export function intervalFor(songKeyName,offset){
  offset=wrapOffset(offset);
  const song=parseKey(songKeyName);
  if(!song)return {offset,semis:offset,letters:null,key:null};
  const key=keyName(mod(song.pitch+offset,12),song.mode);
  return {offset,semis:offset,letters:mod(LETTERS.indexOf(key[0])-LETTERS.indexOf(song.letter),7),key};
}
// The way back: what a chord typed in the shown key is saved as.
export const invertInterval=interval=>({...interval,offset:-interval.offset,semis:-interval.semis,letters:interval.letters===null?null:mod(-interval.letters,7),key:null});
export const isIdentity=interval=>!interval||mod(interval.semis,12)===0&&(interval.letters===null||interval.letters===0);

// One note name ('F#', 'Bb', 'E') moved by an interval.
export function transposeNote(note,interval){
  const match=/^([A-G])(#{1,2}|b{1,2})?$/.exec(note);if(!match||isIdentity(interval))return note;
  const accidentals=match[2]||'',pitch=mod(NATURAL[match[1]]+marks(accidentals),12),target=mod(pitch+interval.semis,12);
  if(interval.letters===null)return (accidentals.includes('b')?FLAT:SHARP)[target];
  const letter=LETTERS[mod(LETTERS.indexOf(match[1])+interval.letters,7)];
  const shift=mod(target-NATURAL[letter]+6,12)-6;           // -6..+5 half steps from the plain letter
  if(Math.abs(shift)<=1||Math.abs(shift)===2&&accidentals.length===2)return letter+markText(shift);
  return (shift>0?SHARP:FLAT)[target];                       // F## -> G, Ebb -> D, and anything stranger by its plain name
}

// A chord label moved by an interval. The root and a bass note after the slash move; the quality, extensions and a bass written as a
// scale degree ('A:min/b3') stay as they are. A label that doesn't start with a note (N, rests, text) comes back unchanged.
export function transposeChord(label,interval){
  if(typeof label!=='string'||isIdentity(interval))return label;
  const match=/^([A-G](?:#{1,2}|b{1,2})?)(.*?)(?:\/([A-G](?:#{1,2}|b{1,2})?))?$/.exec(label);if(!match)return label;
  const [,root,rest,bass]=match;
  return transposeNote(root,interval)+rest+(bass?'/'+transposeNote(bass,interval):'');
}

// A key's name moved by an interval ('A minor' up 3 -> 'C minor').
export function transposeKey(name,interval){
  if(isIdentity(interval))return name;
  const key=parseKey(name);if(!key)return name;
  return keyName(mod(key.pitch+interval.semis,12),key.mode);
}

// '+3', '-2', '0' for the card.
export const offsetText=offset=>offset>0?'+'+offset:String(offset);

// What a moved export says it is, for its file name or heading: ' (+3, C minor)', ' (-2)' with no key, '' when not moved.
export const pitchSuffix=(offset,key)=>offset?` (${offsetText(offset)}${key?', '+key:''})`:'';
