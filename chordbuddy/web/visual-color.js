// Colours from harmony: each chord root gets its place on the circle of fifths, so related chords get related colours and a key change
// visibly moves the palette. Minor chords are cooler and softer, major ones warmer and brighter. Pure.
const ROOTS={C:0,G:1,D:2,A:3,E:4,B:5,'F#':6,Gb:6,'C#':7,Db:7,'G#':8,Ab:8,'D#':9,Eb:9,'A#':10,Bb:10,F:11,'E#':11,Cb:5,Fb:4};

/** {root (0..11 on the circle of fifths, or null), minor, hue (degrees)} for a chord name such as "F#m7" or "Bb/D". */
export function chordColor(label){
  const match=/^([A-G](?:#|b)?)(.*)$/.exec(String(label||''));
  if(!match||!(match[1] in ROOTS))return {root:null,minor:false,hue:220};
  const root=ROOTS[match[1]],rest=match[2].split('/')[0];
  const minor=/^(m(?!aj)|min|-|dim|°)/.test(rest);
  return {root,minor,hue:(root*30+(minor?-18:0)+360)%360};
}

/** A CSS colour for a chord: hue from the circle of fifths, `light` 0..100, alpha 0..1. */
export function chordHsl(label,light=60,alpha=1,saturation=null){
  const {root,minor,hue}=chordColor(label);
  const s=saturation??(root===null?10:minor?55:78);
  return `hsla(${hue},${s}%,${minor?light-6:light}%,${alpha})`;
}
