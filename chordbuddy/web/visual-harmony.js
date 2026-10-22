// Music theory for visualizations: what a MIDI note *means* against the key and the chord, which no frequency analysis can tell.
// Pure. Pitches are MIDI numbers (60 = middle C); chord labels as the chart writes them ("F#m7", "Bb/D", "Gsus4"); keys as "F minor".
const LETTERS={C:0,D:2,E:4,F:5,G:7,A:9,B:11};

/** Pitch class (0 = C .. 11 = B) of a note name such as "Bb" or "F#", or null. */
export function pitchClass(name){
  const m=/^([A-G])(#{1,2}|b{1,2})?/.exec(String(name||''));if(!m)return null;
  const shift=(m[2]||'').split('').reduce((s,c)=>s+(c==='#'?1:-1),0);
  return (LETTERS[m[1]]+shift+12)%12;
}

/** The song's key: {tonic (pitch class), minor} for "F minor" / "Eb major", or null. */
export function parseKey(key){
  const m=/^([A-G](?:#|b)?)\s*(major|minor|maj|min|m)?/i.exec(String(key||'').trim());if(!m)return null;
  return {tonic:pitchClass(m[1]),minor:/^m(in(or)?)?$/i.test(m[2]||'')};
}

/**
 * The notes of a chord: {root, bass, tones:[pitch classes], intervals:[semitones above the root], quality}, or null for silence ("N"/null).
 * Covers the qualities the chart uses: major, minor (m), dim, aug, sus2, sus4, 6, 7, maj7, m7, m7b5, add9 / 9 / 11 / 13 (as 7ths with tensions).
 */
export function chordTones(label){
  const m=/^([A-G](?:#|b)?)([^/]*)(?:\/([A-G](?:#|b)?))?$/.exec(String(label||'').trim());if(!m)return null;
  const root=pitchClass(m[1]),q=m[2],bass=m[3]?pitchClass(m[3]):root;
  let third=4,fifth=7,quality='major';const extra=[];
  if(/^(m(?!aj)|min|-)/.test(q)){third=3;quality='minor';}
  if(/dim|°/.test(q)){third=3;fifth=6;quality='dim';}
  if(/m7b5|ø/.test(q)){third=3;fifth=6;quality='half-dim';extra.push(10);}
  if(/aug|\+/.test(q)){fifth=8;quality='aug';}
  if(/sus2/.test(q)){third=2;quality='sus2';}else if(/sus/.test(q)){third=5;quality='sus4';}
  if(/maj7|maj9|M7|Δ/.test(q))extra.push(11);
  else if(/(^|[^d])(7|9|11|13)/.test(q)&&!extra.includes(10))extra.push(quality==='dim'&&/dim7/.test(q)?9:10);   // a 7th, but not for "add9"
  if(/6/.test(q)&&!/b6/.test(q))extra.push(9);
  if(/9|add9|add2/.test(q))extra.push(2);
  if(/11/.test(q))extra.push(5);
  if(/13/.test(q))extra.push(9);
  const intervals=[...new Set([0,third,fifth,...extra])].sort((a,b)=>a-b);
  return {root,bass,quality,intervals,tones:intervals.map(i=>(root+i)%12)};
}

/**
 * How a note sits against a chord: {inChord, interval (semitones above the chord root, 0..11), role}.
 * role: 'root' | 'third' | 'fifth' | 'seventh' | 'tension' (a chord's 6th/9th/11th/13th) | 'outside' (a passing or clashing note).
 */
export function noteInChord(pitch,label){
  const chord=chordTones(label);if(!chord||!Number.isFinite(pitch))return null;
  const interval=((pitch%12)-chord.root+12)%12,inChord=chord.intervals.includes(interval);
  const role=!inChord?'outside':interval===0?'root':interval===3||interval===4||(chord.quality.startsWith('sus')&&(interval===2||interval===5))?'third'
    :interval===6&&/dim/.test(chord.quality)||interval===7||interval===8&&chord.quality==='aug'?'fifth':interval===10||interval===11?'seventh':'tension';
  return {inChord,interval,role};
}

const MAJOR=[0,2,4,5,7,9,11],MINOR=[0,2,3,5,7,8,10];
/** Scale degree of a note in the key: {degree 1..7, inScale, step (semitones above the tonic)}, e.g. the tonic is degree 1. */
export function scaleDegree(pitch,key){
  const k=typeof key==='string'?parseKey(key):key;if(!k||!Number.isFinite(pitch))return null;
  const step=((pitch%12)-k.tonic+12)%12,scale=k.minor?MINOR:MAJOR,exact=scale.indexOf(step);
  if(exact>=0)return {degree:exact+1,inScale:true,step};
  // a chromatic note: the scale degree just below it
  let below=0;for(let i=0;i<scale.length;i++)if(scale[i]<step)below=i;
  return {degree:below+1,inScale:false,step};
}

/** Semitones from one note to the next (+ up, - down) and its common name, for melodic shape: leaps, steps, repeats. */
export function melodicInterval(from,to){
  if(!Number.isFinite(from)||!Number.isFinite(to))return null;
  const semitones=to-from,size=Math.abs(semitones)%12;
  const names=['unison','minor 2nd','major 2nd','minor 3rd','major 3rd','4th','tritone','5th','minor 6th','major 6th','minor 7th','major 7th'];
  return {semitones,name:Math.abs(semitones)===12?'octave':names[size],step:Math.abs(semitones)<=2,leap:Math.abs(semitones)>=5};
}
