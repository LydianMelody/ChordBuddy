// Note names follow the song's key: F minor has four flats, so its chords are Bb, Eb, Db and Ab, never A#, D#, C# and G#. The analysis names
// every black key with a sharp. Only what is drawn is respelled (the pitch is the same); a chord's saved label is left as it was.
//
// Pitch control (Chart switch on) is drawn here too: every chord name the app shows passes through spellChord, so moving the chart to
// another key is a view, never a change to saved chords. A chord typed while the chart is moved goes back through unspellChord before it
// is saved, so it's stored in the song's own key (transpose.js says how chords move by an interval).
//
// In a show the chart's pitch can change partway through (Perform's pitch flags): spellChord(label, at) takes the play position of the chord.
import {intervalFor,invertInterval,transposeChord} from './transpose.js';

const SHARP=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT=['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const PITCH={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const FLAT_MAJOR=new Set([5,10,3,8,1,6]),FLAT_MINOR=new Set([2,7,0,5,10,3]);   // keys written with flats, as in key-estimate.js; the rest use sharps

let songKeyName=null;          // the song's own key ('A minor'), or null
let chartOffset=0,chartSteps=[];   // the chart's pitch: a constant, plus Perform's steps [{at, offset}] (sorted) when a show has any
let preference='key';          // the song's chord spelling: 'key' (follow the key), 'sharps' or 'flats'. Only drawing changes; saved labels never do.
const views=new Map();         // offset -> {interval, names} for the song's key

const pitchOf=(letter,accidentals)=>{let pitch=PITCH[letter];for(const c of accidentals)pitch+=c==='#'?1:-1;return ((pitch%12)+12)%12;};

// 'F minor' -> true, 'E major' -> false, 'Bb major' -> true.
export function keyUsesFlats(name){
  const match=/^([A-G])([#b]?)\s+(major|minor)$/.exec(String(name||'').trim());if(!match)return null;
  if(match[2])return match[2]==='b';
  return (match[3]==='minor'?FLAT_MINOR:FLAT_MAJOR).has(pitchOf(match[1],''));
}
function view(offset){
  let v=views.get(offset);if(v)return v;
  const interval=offset?intervalFor(songKeyName,offset):null,shown=interval?interval.key:songKeyName;
  const flats=preference==='flats'?true:preference==='sharps'?false:keyUsesFlats(shown);
  // the key's own name follows a chosen spelling too: F# minor is Gb minor when the song is set to flats
  v={interval,shown:respellKey(shown,preference),names:flats===null?null:flats?FLAT:SHARP};views.set(offset,v);return v;
}
// The chart's pitch offset in effect at a play position (or the constant one without a position).
export function chartOffsetAt(at){
  if(!chartSteps.length||!Number.isFinite(at))return chartOffset;
  let offset=chartOffset;for(const step of chartSteps){if(step.at>at)break;offset=step.offset;}return offset;
}

export const SPELLINGS=Object.freeze(['key','sharps','flats']);
// The song's chord spelling: 'key' (follow the key, the usual), 'sharps' or 'flats'.
export function setSpellingPreference(value){value=SPELLINGS.includes(value)?value:'key';if(value!==preference){preference=value;views.clear();}}
export const spellingPreference=()=>preference;
// What the song shows its black-key chords with now: 'sharps', 'flats', or null (no key and no preference: each as it was written).
export const shownSpelling=()=>{const names=view(0).names;return names===FLAT?'flats':names===SHARP?'sharps':null;};
function respellKey(name,pref){
  const m=/^([A-G])([#b])\s+(major|minor)$/.exec(name||'');if(!m||pref==='key')return name;
  if(pref==='flats'&&m[2]==='#'||pref==='sharps'&&m[2]==='b')return (pref==='flats'?FLAT:SHARP)[pitchOf(m[1],m[2])]+' '+m[3];
  return name;
}
// name: the song's key ('F minor'), or null for no key (chords are then shown as they are, moved by pitch only).
export function setKeySpelling(name){
  name=name||null;if(name!==songKeyName){songKeyName=name;views.clear();}
}
// The chart's pitch: offset in half steps (0 when the Chart switch is off), and optional steps [{at: seconds, offset}] for a show.
export function setChartPitch(offset=0,steps=[]){
  chartOffset=offset||0;chartSteps=[...steps].filter(s=>Number.isFinite(s.at)).sort((a,b)=>a.at-b.at);
}
// The key the chart is shown in ('C minor'), the song's own key when it isn't moved, or null.
export const shownKey=at=>view(chartOffsetAt(at)).shown;
export const songKeyForSpelling=()=>songKeyName;
// Is the chart moved anywhere (so typing needs a hint about where it's saved)?
export const chartMoved=()=>chartOffset!==0||chartSteps.some(s=>s.offset!==0);

const respell=(label,names)=>{
  if(!names||typeof label!=='string')return label;
  const match=/^([A-G])([#b]{1,2})?(.*?)(?:\/([A-G])([#b]{1,2})?)?$/.exec(label);if(!match)return label;
  const [,root,rootMark='',quality,bass,bassMark='']=match;
  const spell=(letter,mark)=>mark?names[pitchOf(letter,mark)]:letter;
  return spell(root,rootMark)+quality+(bass?'/'+spell(bass,bassMark):'');
};

// A chord label as it should be drawn: moved to the chart's key (if pitch moves the chart), then its root and its bass note (after the
// slash) respelled for that key, the rest untouched. at: the chord's play position, for a show whose pitch changes partway.
export function spellChord(label,at){
  if(typeof label!=='string')return label;
  const v=view(chartOffsetAt(at));
  return respell(v.interval?transposeChord(label,v.interval):label,v.names);
}
// A chord typed where the chart is shown (at the play position `at`) -> the label to save, in the song's own key. Unmoved: as typed.
export function unspellChord(typed,at){
  const v=view(chartOffsetAt(at));
  return v.interval&&typeof typed==='string'?transposeChord(typed,invertInterval(v.interval)):typed;
}

// The lead sheet's ABC text with each linked chord symbol respelled for the key. A name that would change length (a double sharp becoming a
// plain note) is left alone, so every position in the text, and every chord's link to it, stays where it was. (A moved chart's lead sheet
// is written again in the new key by lead-sheet.js, so only the spelling is done here.)
export function spellAbc(abc,chords){
  const names=view(0).names;
  if(!names||typeof abc!=='string')return abc;
  let out=abc;
  for(const chord of chords||[]){
    const index=chord?.abc_index;if(!Number.isInteger(index)||abc[index]!=='"')continue;
    const end=abc.indexOf('"',index+1);if(end<0)continue;
    const label=abc.slice(index+1,end),spelled=respell(label,names);
    if(spelled!==label&&spelled.length===label.length)out=out.slice(0,index+1)+spelled+out.slice(end);
  }
  return out;
}

// Everything that changes how chords are drawn, so a view can tell when to draw again: the key, the chart's pitch and the spelling.
export const spellingSignature=()=>JSON.stringify([songKeyName,chartOffset,chartSteps,preference]);
