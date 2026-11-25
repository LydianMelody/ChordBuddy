/* Presentation only: never rewrite canonical chords, timing or edit history. */
const placeholder=label=>label==null||['','N','?','UNKNOWN'].includes(String(label).trim().toUpperCase());
// The model always writes an opening downbeat at 0.00 s. When the recording begins with a moment of silence, that can become a short bar
// over nothing, under a chord that carries on into the music (Wonderland: a one-beat bar of C#m over the first 0.33 s). With soundStart
// (seconds, from the server's sound_start.py) the bars at the start that reach less than this far into the sound are silence too, so the
// music starts after them, as it does after "N" placeholders. Their chord is not hidden: it goes on in the bars after.
const INTO_SOUND=.1;
// The same at the other end (soundEnd, from sound_start.py): the model keeps its beat grid and its last chord going to the very end of the file,
// so after a fade-out the chart would show bars of the last chord over silence. Bars that begin after the sound has ended are left out, unless
// a word is sung in them. The bar the sound ends in stays.
// The chart's own end (layout.chart_end, set by dragging the end cap in the Edit tool, or `chartEnd` here) wins over that: the chart ends at
// the barline nearest to it, earlier (a chord left ringing) or later (a quiet ending taken for silence). A bar with a word in it still stays.
export function chartPresentation(content,measures=[],soundStart=null,soundEnd=null,{chartEnd=content?.layout?.chart_end}={}){
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
 let finish=end,trimmed=false;
 const lastWord=anchors.length?Math.max(...anchors):-Infinity;
 const barline=Number.isFinite(chartEnd)&&measures.length?measures.reduce((best,m)=>Math.abs(m.end-chartEnd)<Math.abs(best.end-chartEnd)?m:best).end:null;
 if(barline!==null&&barline>start+INTO_SOUND){
  finish=Math.max(barline,lastWord+1e-3);trimmed=finish<end-1e-6;
 }else if(Number.isFinite(soundEnd)&&soundEnd>start+INTO_SOUND&&soundEnd<end-1e-6){
  const bar=measures.find(m=>soundEnd>=m.start&&soundEnd<m.end);
  finish=Math.min(end,Math.max(bar?bar.end:soundEnd,lastWord+1e-3));trimmed=true;
 }
 const visible=event=>!hidden.has(event.chordId??event.id)&&!(placeholder(event.label)&&(event.end<=start||event.start>=end))&&!(trimmed&&event.start>=finish-1e-6);
 return {hidden,start,end:finish,visible};
}
