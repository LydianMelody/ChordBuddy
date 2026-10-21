// Copying one section's lyrics and word timing onto a repeat of it (Chorus 1 -> Chorus 2). Pure: returns a candidate document.
// The words are the same text, so every pin keeps its word; its place moves by the same number of bars from the start of the section
// and the same beat inside that bar. A pin that would fall outside the other section (it has fewer bars, or shorter ones) is let go:
// its word then spreads between its neighbours, as any unpinned word does.
import {effectiveMeasures,sectionMeasures,anchorInside} from './chart-layout.js';

const baseName=name=>String(name||'').replace(/\s*\d+\s*$/,'').trim().toLowerCase();

// Every section sharing this one's name, in song order (itself included).
export function copyGroup(content,section){
  const base=baseName(section.name);
  return base?content.sections.filter(s=>baseName(s.name)===base):[section];
}

// The other sections this one can be copied onto: the same name, with or without a number after it ("Chorus", "Chorus 2").
export function copyTargets(content,sectionId){
  const section=content.sections?.find(s=>s.id===sectionId);
  if(!section||!String(section.lyrics||'').trim())return [];
  const base=baseName(section.name);
  return base?content.sections.filter(s=>s.id!==sectionId&&baseName(s.name)===base):[];
}

// Returns {candidate, kept, dropped}: pins carried over, and pins that had no place in the other section.
export function copySectionLyrics(content,music,fromId,toId){
  const from=content.sections?.find(s=>s.id===fromId),to=content.sections?.find(s=>s.id===toId);
  if(!from||!to||from===to)throw Error('Choose two different sections.');
  if(!String(from.lyrics||'').trim())throw Error('There are no lyrics in '+from.name+' to copy.');
  const next=structuredClone(content);
  const target=next.sections.find(s=>s.id===toId);
  target.lyrics=from.lyrics;
  const measures=effectiveMeasures(music,next.layout||{}),source=sectionMeasures(measures,from),own=sectionMeasures(measures,target);
  const layout=next.layout={...(next.layout||{})};
  const placements=layout.lines||[];
  layout.lines=placements.filter(p=>p.section_id!==toId);
  const carry=index=>{const place=source.findIndex(m=>m.id===index);return place<0?-1:place;};
  let kept=0,dropped=0;
  for(const placement of placements.filter(p=>p.section_id===fromId)){
    const words=[];
    for(const word of placement.words||[]){
      const place=carry(word.measure_id),measure=own[place];
      if(place>=0&&measure&&anchorInside(measure,word.beat,target)&&(!words.length||place>words.at(-1).place||(place===words.at(-1).place&&word.beat>words.at(-1).beat)))
        words.push({offset:word.offset,measure_id:measure.id,beat:word.beat,place});
      else dropped++;
    }
    const first=Math.max(0,Math.min(own.length-1,carry(placement.start_measure))),last=Math.max(first,Math.min(own.length-1,carry(placement.end_measure)));
    if(!own.length)continue;
    const start=Math.min(first,...words.map(w=>w.place)),end=Math.max(last,...words.map(w=>w.place));
    layout.lines.push({section_id:toId,line:placement.line,start_measure:own[start].id,end_measure:own[end].id,words:words.map(({offset,measure_id,beat})=>({offset,measure_id,beat}))});
    kept+=words.length;
  }
  // chords once tied to words of the old text no longer point at anything
  for(const chord of next.chords||[])if(chord.section_id===toId&&Number.isInteger(chord.line)){chord.line=null;chord.offset=null;}
  return {candidate:next,kept,dropped};
}
