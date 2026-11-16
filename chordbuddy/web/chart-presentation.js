/* Presentation only: never rewrite canonical chords, timing or edit history. */
const placeholder=label=>label==null||['','N','?','UNKNOWN'].includes(String(label).trim().toUpperCase());
// The model always writes an opening downbeat at 0.00 s. When the recording begins with a moment of silence, that can become a short bar
// over nothing, under a chord that carries on into the music (Wonderland: a one-beat bar of C#m over the first 0.33 s). With soundStart
// (seconds, from the server's sound_start.py) the bars at the start that reach less than this far into the sound are silence too, so the
// music starts after them, as it does after "N" placeholders. Their chord is not hidden: it goes on in the bars after.
const INTO_SOUND=.1;
export function chartPresentation(content,measures=[],soundStart=null){
 const chords=content.chords||[],anchors=[];
 for(const line of content.layout?.lines||[])for(const word of line.words||[]){const m=measures.find(m=>m.id===word.measure_id),i=Math.floor(word.beat);if(!m)continue;const points=[...m.beats,m.end];if(Number.isFinite(points[i+1]))anchors.push(points[i]+(word.beat-i)*(points[i+1]-points[i]));}
 const anchored=c=>Number.isInteger(c.line)&&Number.isInteger(c.offset)||anchors.some(t=>t>=c.start&&t<c.end);
 const musical=chords.filter(c=>!placeholder(c.label)||anchored(c)),hidden=new Set();
 if(musical.length){const start=Math.min(...musical.map(c=>c.start)),end=Math.max(...musical.map(c=>c.end));for(const c of chords)if(placeholder(c.label)&&!anchored(c)&&(c.end<=start||c.start>=end))hidden.add(c.id);}
 const kept=chords.filter(c=>!hidden.has(c.id)),end=kept.length?Math.max(...kept.map(c=>c.end)):content.duration;
 let start=kept.length?Math.min(...kept.map(c=>c.start)):0;
 if(Number.isFinite(soundStart)&&soundStart>0){
  // only bars from the very start, and never one with a word sung in it
  for(const m of [...measures].sort((a,b)=>a.start-b.start)){if(!(m.end<soundStart+INTO_SOUND)||anchors.some(t=>t>=m.start&&t<m.end))break;start=Math.max(start,m.end);}
 }
 const visible=event=>!hidden.has(event.chordId??event.id)&&!(placeholder(event.label)&&(event.end<=start||event.start>=end));
 return {hidden,start,end,visible};
}
