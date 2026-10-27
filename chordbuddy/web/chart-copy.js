// Copying one section's lyrics and word timing onto a repeat of it (Chorus 1 -> Chorus 2). Pure: returns a candidate document.
// The words are the same text, so every pin keeps its word; its place moves by the same number of bars from the start of the section
// and the same beat inside that bar. A pin that would fall outside the other section (it has fewer bars, or shorter ones) is let go:
// its word then spreads between its neighbours, as any unpinned word does.
import {effectiveMeasures,sectionMeasures,anchorInside} from './chart-layout.js';
import {validateChart} from './editor.js';

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

// The other sections this one's chords can be copied onto: the same name, as for lyrics (a section needs chords of its own to copy).
export function chordCopyTargets(content,sectionId){
  const section=content.sections?.find(s=>s.id===sectionId);
  if(!section||!(content.chords||[]).some(c=>c.section_id===sectionId))return [];
  const base=baseName(section.name);
  return base?content.sections.filter(s=>s.id!==sectionId&&baseName(s.name)===base):[];
}

// Where a moment sits in its bar, in beats (2.5: halfway through the third beat), and back.
function beatIn(measure,seconds){
  const times=[...(measure.beats?.length?measure.beats:[measure.start]),measure.end];
  for(let i=0;i<times.length-1;i++)if(seconds<times[i+1]-1e-9)return i+Math.max(0,(seconds-times[i])/((times[i+1]-times[i])||1));
  return times.length-1;
}
function secondsIn(measure,beat){
  const times=[...(measure.beats?.length?measure.beats:[measure.start]),measure.end],i=Math.min(Math.floor(beat),times.length-2);
  return times[i]+(beat-i)*(times[i+1]-times[i]);
}

// Copying one section's chords onto a repeat of it (Chorus 1 -> Chorus 2): the same chords, rests included, each moved by the same
// number of bars from the start of the section and starting on the same beat of its bar. The other section's own chords are replaced.
// A chord that would start past the other section's last bar (it has fewer bars) is left out. The chord sounding as the other section
// begins, and the one after it, are stretched to meet the copied chords, as they are in this section. Chords tied to words of the old
// harmony no longer point at anything. The repeats fold the same way: the same chords, and any folding chosen by hand comes along.
// Returns {candidate, copied, dropped}.
export function copySectionChords(content,music,fromId,toId){
  const from=content.sections?.find(s=>s.id===fromId),to=content.sections?.find(s=>s.id===toId);
  if(!from||!to||from===to)throw Error('Choose two different sections.');
  const measures=effectiveMeasures(music,content.layout||{}),source=sectionMeasures(measures,from),own=sectionMeasures(measures,to);
  const chords=(content.chords||[]).filter(c=>c.section_id===fromId).sort((a,b)=>a.start-b.start);
  if(!chords.length)throw Error('There are no chords in '+from.name+' to copy.');
  // a moment of this section -> the same bar and beat of the other (null when the other has no such bar)
  const carry=t=>{
    const place=source.findIndex(m=>t>=m.start-1e-6&&t<m.end-1e-6),measure=own[place];
    if(place<0||!measure)return Math.abs(t-from.end)<1e-6?to.end:null;
    return Math.max(to.start,secondsIn(measure,Math.min(beatIn(source[place],t),(measure.beats?.length||1)-1e-6)));
  };
  const placed=[],ids=new Map();let dropped=0;
  for(const chord of chords){
    const start=carry(chord.start);
    if(start===null||start>=to.end-1e-6||placed.length&&start<=placed.at(-1).start+1e-6){dropped++;continue;}
    const id=crypto.randomUUID();ids.set(chord.id,id);
    placed.push({id,label:chord.label,start,end:null,section_id:toId,line:null,offset:null});
  }
  if(!placed.length)throw Error(to.name+' has no bars where '+from.name+'’s chords could go.');
  const next=structuredClone(content),kept=next.chords.filter(c=>c.section_id!==toId).sort((a,b)=>a.start-b.start);
  // what sounds into the section from before it ends where the first copied chord starts; the last copied chord lasts until the chord after
  const before=kept.filter(c=>c.start<to.start).at(-1),after=kept.find(c=>c.start>=to.end-1e-6);
  if(before&&before.end>to.start-1e-6)before.end=placed[0].start;
  if(placed[0].start>to.start+1e-6&&!(before&&before.end>=placed[0].start-1e-6))placed.unshift({id:crypto.randomUUID(),label:'N',start:to.start,end:null,section_id:toId,line:null,offset:null});
  placed.forEach((c,i)=>{c.end=i<placed.length-1?placed[i+1].start:(after?after.start:Math.min(next.duration,Math.max(to.end,c.start+1e-3)));});
  next.chords=[...kept,...placed].sort((a,b)=>a.start-b.start);
  // and the way its repeats are folded, as chosen by hand (2 bars x4, written out, ...): the other section's own choices give way
  const compact=next.layout?.compact;
  if(Array.isArray(compact?.groups)){
    const mine=compact.groups.filter(g=>g.section_id===fromId),copies=[];
    for(const group of mine){
      const passes=[];
      for(const pass of group.passes||[]){
        const start=carry(pass.start),end=carry(pass.end),measureIds=(pass.measure_ids||[]).map(id=>own[source.findIndex(m=>m.id===id)]?.id);
        if(start===null||end===null||!(end>start)||measureIds.some(id=>!id))break;
        passes.push({...pass,start,end,measure_ids:measureIds,chord_ids:(pass.chord_ids||[]).map(id=>ids.get(id)).filter(Boolean)});
      }
      if(passes.length===(group.passes||[]).length)copies.push({...group,id:'copy:'+toId+'@'+passes[0].start,section_id:toId,passes});
    }
    compact.groups=[...compact.groups.filter(g=>g.section_id!==toId),...copies].sort((a,b)=>(a.passes[0]?.start??0)-(b.passes[0]?.start??0));
  }
  const error=validateChart(next);if(error)throw Error(error);
  return {candidate:next,copied:placed.length,dropped};
}

