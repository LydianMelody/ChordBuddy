import {lyricTokens,boundaryOffsetMap,remapLineAnchors} from './lyric-chunks.js';
export {lyricTokens} from './lyric-chunks.js';
/* Pure musical layout. Pixel widths never change a chord or recording time. */
export const defaultLayout=()=>({bars_per_line:4,breaks:[],lines:[],bar_overrides:[]});
export function effectiveMeasures(music,layout={}) {
  const measures=structuredClone(music?.measures || []);
  const originalBeats=measures.flatMap(m=>m.beats.map((time,index)=>({time,visible:m.beat_visible?.[index]!==false})));
  for(const override of layout.bar_overrides || []){
    const index=measures.findIndex(m=>m.id===override.id);
    if(index<=0 || !Number.isFinite(override.start))throw new Error('Choose an interior barline to correct.');
    measures[index].start=override.start;measures[index-1].end=override.start;
  }
  for(const measure of measures){
    const source=(music?.measures||[]).find(m=>m.id===measure.id);
    if(measure.start>=measure.end)throw new Error('A barline cannot cross the barline before or after it.');
    const inside=originalBeats.filter(item=>item.time>measure.start+1e-6&&item.time<measure.end-1e-6);
    measure.beats=[measure.start,...inside.map(item=>item.time)];
    measure.beat_visible=[true,...inside.map(item=>item.visible)];
    // A moved boundary changes the bar's musical origin. Keep exact anchors,
    // but expose unknown snap labels unless the original map still matches.
    measure.quarter_positions=source&&source.start===measure.start&&source.end===measure.end&&JSON.stringify(source.beats)===JSON.stringify(measure.beats)&&source.quarter_positions?.length===measure.beats.length+1
      ? [...source.quarter_positions] : Array(measure.beats.length+1).fill(null);
  }
  return measures;
}
export function sectionMeasures(measures,section){return measures.filter(m=>m.end>section.start+1e-6&&m.start<section.end-1e-6);}
export function groupMeasures(measures,section,layout={}){
  const count=[2,3,4,8].includes(layout.bars_per_line)?layout.bars_per_line:4;
  const groups=[];let row=[];
  for(const measure of sectionMeasures(measures,section)){
    if(row.length&&(row.length>=count||(layout.breaks||[]).includes(measure.id))){groups.push(row);row=[];}
    row.push(measure);
  }
  if(row.length)groups.push(row);return groups;
}
export function beatAt(measure,time){
  const times=[...measure.beats,measure.end];
  for(let i=0;i<times.length-1;i++)if(time<times[i+1]-1e-7)return i+Math.max(0,time-times[i])/(times[i+1]-times[i]);
  return Math.max(0,measure.beats.length-0.0001);
}
export function playbackPosition(music,time,layout={}){
  if(!Number.isFinite(time))return null;
  const measures=effectiveMeasures(music,layout);
  const measureIndex=measures.findIndex(m=>time>=m.start-1e-7&&time<m.end-1e-7);
  if(measureIndex<0)return null;
  const measure=measures[measureIndex],beatIndex=Math.max(0,Math.min(measure.beats.length-1,Math.floor(beatAt(measure,time))));
  return {measureId:measure.id,measureIndex,beatIndex,beatStart:measure.beats[beatIndex],beatEnd:measure.beats[beatIndex+1]??measure.end};
}
export function chordsInMeasure(chords,measure){
  return chords.filter(c=>c.start<measure.end-1e-6&&c.end>measure.start+1e-6).map(c=>({...c,beat:beatAt(measure,Math.max(c.start,measure.start)),continued:c.start<measure.start-1e-6}));
}
export function isNoChordLabel(label){
  if(label===null||label===undefined)return true;
  const normalized=String(label).trim().toUpperCase().replace(/[\s.]/g,'');
  return !normalized||normalized==='N'||normalized==='NC'||normalized==='NOCHORD';
}
export function lyricSegments(line,anchors){
  const chars=Array.from(line),sorted=[...anchors].sort((a,b)=>a.offset-b.offset);
  return sorted.map((anchor,i)=>({...anchor,text:chars.slice(anchor.offset,sorted[i+1]?.offset??chars.length).join('').trimEnd()}));
}
export function updateLyricLine(content,sectionId,lineIndex,text){
  const next=structuredClone(content),section=next.sections?.find(s=>s.id===sectionId);
  if(!section||!Number.isInteger(lineIndex)||lineIndex<0)throw new Error('Choose an existing lyric line.');
  const lines=String(section.lyrics??'').split('\n');
  if(lineIndex>=lines.length)throw new Error('Choose an existing lyric line.');
  const value=String(text??'').replace(/\r\n?/g,'\n');
  if(lines[lineIndex]===value)return next;
  const inserted=value.split('\n'),delta=inserted.length-1;lines.splice(lineIndex,1,...inserted);section.lyrics=lines.join('\n');
  const map=inserted.length===1?boundaryOffsetMap(String(content.sections.find(s=>s.id===sectionId).lyrics).split('\n')[lineIndex],value):null;
  remapLineAnchors(next,sectionId,lineIndex,lineIndex,map);
  if(next.layout?.lines)next.layout.lines=next.layout.lines.map(p=>p.section_id===sectionId&&p.line>lineIndex?{...p,line:p.line+delta}:p);
  for(const chord of next.chords||[])if(chord.section_id===sectionId&&Number.isInteger(chord.line)&&chord.line>lineIndex)chord.line+=delta;
  return next;
}
export function appendLyricLine(content,sectionId,text,measureId,beat,measures){
  const section=content.sections?.find(s=>s.id===sectionId);
  if(!section)throw new Error('Choose an existing lyric section.');
  const value=String(text??'').replace(/\r\n?/g,' ').trim();
  const lines=String(section.lyrics??'').split('\n'),lineIndex=section.lyrics?lines.length:0;
  if(!value||!lyricTokens(value).length)throw new Error('Type lyrics before placing them.');
  const next=structuredClone(content),target=next.sections.find(s=>s.id===sectionId);
  target.lyrics=target.lyrics?`${target.lyrics}\n${value}`:value;
  return placeWord(next,sectionId,lineIndex,lyricTokens(value)[0].offset,measureId,beat,measures);
}
function anchorInside(measure,beat,section){
  if(!measure||!section||!Number.isFinite(beat)||beat<0||beat>=measure.beats.length)return false;
  const index=Math.floor(beat),points=[...measure.beats,measure.end],time=points[index]+(beat-index)*(points[index+1]-points[index]);
  return time>=section.start-1e-7&&time<section.end-1e-7;
}
export function placeWord(content,sectionId,lineIndex,offset,measureId,beat,measures){
  const next=structuredClone(content),section=next.sections.find(s=>s.id===sectionId);
  const line=section?.lyrics.split('\n')[lineIndex],measure=measures.find(m=>m.id===measureId);
  if(typeof line!=='string'||!lyricTokens(line).some(t=>t.offset===offset))throw new Error('Choose the start of a lyric chunk.');
  if(!anchorInside(measure,beat,section))throw new Error('Place the phrase on a beat inside its section.');
  next.layout={...defaultLayout(),...next.layout};
  let placement=next.layout.lines.find(p=>p.section_id===sectionId&&p.line===lineIndex);
  if(!placement){placement={section_id:sectionId,line:lineIndex,start_measure:measureId,end_measure:measureId,words:[]};next.layout.lines.push(placement);}
  placement.words=placement.words.filter(w=>w.offset!==offset);
  placement.words.push({offset,measure_id:measureId,beat});placement.words.sort((a,b)=>a.offset-b.offset);
  // Manual anchors must preserve the sung word order; never silently reorder text.
  const positions=placement.words.map(w=>measures.findIndex(m=>m.id===w.measure_id)*1000+w.beat);
  if(positions.some((p,i)=>i&&p<=positions[i-1]))throw new Error('Place this phrase after its preceding words and before its following words.');
  const indices=placement.words.map(w=>measures.findIndex(m=>m.id===w.measure_id));
  const startIndex=measures.findIndex(m=>m.id===placement.start_measure),endIndex=measures.findIndex(m=>m.id===placement.end_measure);
  placement.start_measure=measures[Math.min(startIndex<0?Infinity:startIndex,...indices)].id;
  placement.end_measure=measures[Math.max(endIndex,...indices)].id;
  return next;
}
export function validatePlacements(content,music){
  const measures=effectiveMeasures(music,content.layout);
  for(const p of content.layout?.lines||[]){
    const section=content.sections.find(s=>s.id===p.section_id),own=section?sectionMeasures(measures,section):[];
    const start=own.findIndex(m=>m.id===p.start_measure),end=own.findIndex(m=>m.id===p.end_measure);
    if(start<0||end<start||p.words.some(w=>{const index=own.findIndex(m=>m.id===w.measure_id);return index<start||index>end||!anchorInside(own[index],w.beat,section);}))
      throw new Error('This barline would move a placed lyric outside its section or beat range. Unplace the affected lyric line before correcting the barline.');
  }
  return measures;
}
