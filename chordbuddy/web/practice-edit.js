import {effectiveMeasures,validatePlacements} from './chart-layout.js';
import {secondsAtAddress} from './musical-grid.js';
import {deleteChartChord,editChartChord,editChartSection,mergeAdjacentChartSections,reassignChartChords,validateChart} from './editor.js';
import {buildCompactChart,compactEditTargets} from './compact-chart.js';
const clone=structuredClone;
function losses(before,after){
 const conflicts=[],identity=(content,p,w)=>JSON.stringify([content.sections.find(s=>s.id===p.section_id)?.lyrics.split('\n')[p.line],w.offset,w.measure_id,w.beat]),remaining=new Map();
 for(const p of after.layout?.lines||[])for(const w of p.words){const key=identity(after,p,w);remaining.set(key,(remaining.get(key)||0)+1);}
 for(const p of before.layout?.lines||[])for(const w of p.words){
  const key=identity(before,p,w),count=remaining.get(key)||0;
  if(count)remaining.set(key,count-1);
  else {
   const line=before.sections.find(s=>s.id===p.section_id)?.lyrics.split('\n')[p.line]||'Lyric line';
   conflicts.push({message:'“'+line+'” at '+w.measure_id+' crosses this boundary. Keep the boundary or move this line’s anchors first.'});
  }
 }
 for(const c of before.chords)if(c.line!==null&&after.chords.find(n=>n.id===c.id)?.line===null)conflicts.push({message:'Chord '+c.label+' would lose its lyric association. Keep this boundary or resolve that line first.'});
 return conflicts;
}
export function planChartChordEdit(content,music,{chordId,label,startAddress=null,endAddress=null,scope='occurrence',selection=null,view=null}){
 const measures=effectiveMeasures(music,content.layout),chartView=view||buildCompactChart(content,music),chosen=content.chords.find(c=>c.id===chordId);
 if(!chosen)throw Error('Choose an existing chord.');
 const ids=selection?compactEditTargets(chartView,{...selection,scope}).chordIds:[chordId];
 const group=selection&&chartView.groups.find(g=>g.id===selection.groupId),selected=group?.passes.find(p=>p.number===selection.passNumber);
 function addressFor(address,id){
  if(!address)return null;if(scope!=='all-matching'||!selected)return address;
  const occurrence=chartView.occurrences.find(o=>o.chordId===id&&o.groupId===group.id),pass=group.passes.find(p=>p.number===occurrence.passNumber);
  const index=selected.measureIds.indexOf(address.measure_id);
  if(index>=0&&pass.measureIds[index])return {...address,measure_id:pass.measureIds[index]};
  const boundary=secondsAtAddress(measures,address);
  if(boundary===selected.end){const m=measures.find(m=>m.id===pass.measureIds.at(-1));return {measure_id:m.id,beat:m.beats.length};}
  throw Error('For all matching passes, keep the edited boundary inside this passage.');
 }
 let next=clone(content);
 for(const id of ids){
  const fields={label};if(startAddress)fields.start=secondsAtAddress(measures,addressFor(startAddress,id));if(endAddress)fields.end=secondsAtAddress(measures,addressFor(endAddress,id));
  next=editChartChord(next,id,fields);
 }
 const conflicts=losses(content,next);return {candidate:conflicts.length?null:next,conflicts,affected:ids};
}
// Delete a chord (or the matching chords of every pass), the neighbours taking over its time. Same answer shape as planChartChordEdit.
export function planChartChordDelete(content,music,{chordId,scope='occurrence',selection=null,view=null}){
 const chartView=view||buildCompactChart(content,music);
 if(!content.chords.some(c=>c.id===chordId))throw Error('Choose an existing chord.');
 const ids=selection?compactEditTargets(chartView,{...selection,scope}).chordIds:[chordId];
 let next=clone(content);for(const id of ids)next=deleteChartChord(next,id);
 const conflicts=losses(content,next);if(!conflicts.length){const error=validateChart(next);if(error)throw Error(error);}
 return {candidate:conflicts.length?null:next,conflicts,affected:ids};
}
export function planSectionEdit(content,music,{sectionId,operation,fields={}}){
 const measures=effectiveMeasures(music,content.layout),section=content.sections.find(s=>s.id===sectionId);if(!section)throw Error('Choose an existing section.');
 let next;
 if(operation==='merge')next=mergeAdjacentChartSections(content,sectionId,fields.direction||'next',{acceptGap:fields.acceptGap===true});
 else if(operation==='edit'){
  const value={};if(fields.name!==undefined)value.name=fields.name.trim();
  if(fields.startAddress)value.start=secondsAtAddress(measures,fields.startAddress);if(fields.endAddress)value.end=secondsAtAddress(measures,fields.endAddress);
  next=editChartSection(content,sectionId,value,music);
 }else if(operation==='split'){
  const seconds=secondsAtAddress(measures,fields.address);if(!(seconds>section.start&&seconds<section.end))throw Error('Choose a split position inside the section.');
  next=clone(content);const index=next.sections.findIndex(s=>s.id===sectionId),first=next.sections[index],second={...first,id:fields.newId,name:fields.name||first.name+' (continued)',start:seconds,lyrics:''};first.end=seconds;
  const oldLines=section.lyrics.split('\n'),sides=[],conflicts=[];
  oldLines.forEach((line,i)=>{
   const anchors=(content.layout?.lines||[]).filter(p=>p.section_id===sectionId&&p.line===i).flatMap(p=>p.words.map(w=>secondsAtAddress(measures,w)));
   anchors.push(...content.chords.filter(c=>c.section_id===sectionId&&c.line===i).map(c=>c.start));
   if(anchors.some(t=>t<seconds)&&anchors.some(t=>t>=seconds))conflicts.push({message:'“'+line+'” spans the split. Split its lyric line at the intended word first.'});
   sides[i]=anchors.length&&anchors.every(t=>t>=seconds)?1:0;
  });
  if(conflicts.length)return {candidate:null,conflicts};
  const maps=[new Map(),new Map()],lines=[[],[]];oldLines.forEach((line,i)=>{const side=sides[i];maps[side].set(i,lines[side].length);lines[side].push(line);});
  first.lyrics=lines[0].join('\n');second.lyrics=lines[1].join('\n');next.sections.splice(index+1,0,second);
  for(const p of next.layout?.lines||[])if(p.section_id===sectionId){const side=sides[p.line];p.section_id=side?second.id:first.id;p.line=maps[side].get(p.line);}
  for(const c of next.chords)if(c.section_id===sectionId){const side=c.start>=seconds?1:0;c.section_id=side?second.id:first.id;if(c.line!==null)c.line=maps[side].get(c.line)??null;if(c.line===null)c.offset=null;}
  next=reassignChartChords(next);
 }else throw Error('Choose a section operation.');
 const conflicts=losses(content,next);if(!conflicts.length){validatePlacements(next,music);const error=validateChart(next);if(error)throw Error(error);}
 return {candidate:conflicts.length?null:next,conflicts};
}
