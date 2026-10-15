/* Presentation only: never rewrite canonical chords, timing or edit history. */
const placeholder=label=>label==null||['','N','?','UNKNOWN'].includes(String(label).trim().toUpperCase());
export function chartPresentation(content,measures=[]){
 const chords=content.chords||[],anchors=[];
 for(const line of content.layout?.lines||[])for(const word of line.words||[]){const m=measures.find(m=>m.id===word.measure_id),i=Math.floor(word.beat);if(!m)continue;const points=[...m.beats,m.end];if(Number.isFinite(points[i+1]))anchors.push(points[i]+(word.beat-i)*(points[i+1]-points[i]));}
 const anchored=c=>Number.isInteger(c.line)&&Number.isInteger(c.offset)||anchors.some(t=>t>=c.start&&t<c.end);
 const musical=chords.filter(c=>!placeholder(c.label)||anchored(c)),hidden=new Set();
 if(musical.length){const start=Math.min(...musical.map(c=>c.start)),end=Math.max(...musical.map(c=>c.end));for(const c of chords)if(placeholder(c.label)&&!anchored(c)&&(c.end<=start||c.start>=end))hidden.add(c.id);}
 const kept=chords.filter(c=>!hidden.has(c.id)),start=kept.length?Math.min(...kept.map(c=>c.start)):0,end=kept.length?Math.max(...kept.map(c=>c.end)):content.duration;
 const visible=event=>!hidden.has(event.chordId??event.id)&&!(placeholder(event.label)&&(event.end<=start||event.start>=end));
 return {hidden,start,end,visible};
}
