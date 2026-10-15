// Turning chart edits into saved changes. Pure: takes a document and returns a candidate document (or the reason it can't).
// Lyrics are typed under chords; the first word of what you type is pinned to that chord, everything else is a puppet
// (it spreads between pins), and editing words never loses the timing of words that are still there.
import {appendLine,removeLine,replaceLineText,similarity} from './lyric-warp.js';
import {lyricTokens} from './lyric-chunks.js';
import {placeWord,defaultLayout,effectiveMeasures} from './chart-layout.js';
import {addressAtSeconds} from './musical-grid.js';

const chars=s=>Array.from(s);
// The same word, or the same word with a typo fixed: it keeps whatever pin it already had.
const sameWord=(a,b)=>similarity(a,b)>0;
const tokenLength=t=>chars(t.text).length;

function chordOnset(model,group,chunk,passNumber){
  const occurrence=model.projection.occurrences.find(o=>o.groupId===group.id&&o.slotId===chunk.slotId&&o.passNumber===passNumber);
  if(!occurrence||occurrence.continued||!Number.isFinite(occurrence.start))return null;
  return addressAtSeconds(model.measures,occurrence.start);
}

// text = what is now typed under this chord on this lyric line.
function slotText({content,music,model,group,lane,laneIndex,chunk,fragment,text}){
  const section=content.sections.find(s=>s.id===group.sectionId);
  if(!section)throw Error('Choose an existing section.');
  const slotTokens=fragment||chunk.lanes?.[laneIndex]||lane.tokens.filter(t=>t.chunkKey===chunk.key);
  const typed=String(text??'').replace(/\s+/g,' ').trim();
  let candidate,line,tokensBefore,label='Edit lyrics',lost=0,anchorFirst=false;

  if(lane.line===null||lane.line===undefined){
    // a new lyric line, started under this chord
    if(!typed)return {candidate:null,conflicts:[],label,lost:0};
    const appended=appendLine(content,section.id,typed);
    candidate=appended.candidate;line=appended.line;tokensBefore=0;anchorFirst=true;label='Add lyrics';
    const pass=group.passes.find(p=>p.number===lane.passNumber)||group.passes[0];
    candidate.layout={...defaultLayout(),...candidate.layout};
    candidate.layout.lines=[...(candidate.layout.lines||[]),{section_id:section.id,line,start_measure:pass.measureIds[0],end_measure:pass.measureIds.at(-1),words:[]}];
  }else{
    line=lane.line;
    const old=String(section.lyrics).split('\n')[line],oldChars=chars(old),oldTokens=lyricTokens(old);
    let start,end,replaced=false;
    if(slotTokens.length){
      const first=slotTokens[0],last=slotTokens.at(-1);
      start=first.offset;end=last.offset+tokenLength(last);replaced=true;
      tokensBefore=oldTokens.findIndex(t=>t.offset===first.offset);
      anchorFirst=!typed?false:!sameWord(first.text,lyricTokens(typed)[0]?.text??'')&&(!fragment||!!first.pinned);
    }else{
      // nothing was under this chord yet: insert after the last word that sits before it
      const placed=lane.tokens.filter(t=>Number.isFinite(t.displaySeconds));
      const after=placed.find(t=>t.displaySeconds>=chunk.end-1e-9);
      const lastBefore=[...placed].reverse().find(t=>t.displaySeconds<chunk.start+1e-9);
      if(after)start=end=after.offset;
      else if(lastBefore)start=end=lastBefore.offset+tokenLength(lastBefore);
      else start=end=oldChars.length;
      tokensBefore=oldTokens.filter(t=>t.offset<start).length;anchorFirst=true;
    }
    if(!typed&&!slotTokens.length)return {candidate:null,conflicts:[],label,lost:0};
    const head=oldChars.slice(0,start).join(''),tail=oldChars.slice(end).join('');
    const glue=(a,b)=>a&&b&&!/\s$/u.test(a)&&!/^\s/u.test(b)?' ':'';
    const merged=typed?head+glue(head,typed)+typed+glue(typed,tail)+tail:(head.trimEnd()+(head&&tail?' ':'')+tail.trimStart());
    if(!lyricTokens(merged).length){candidate=removeLine(content,section.id,line);label='Remove lyric line';}
    else{const result=replaceLineText(content,section.id,line,merged);candidate=result.candidate;lost=result.lost;}
    if(replaced&&!typed)anchorFirst=false;
    if(!lyricTokens(merged).length)return {candidate,conflicts:[],label,lost};
  }

  if(anchorFirst&&typed){
    const finalLine=String(candidate.sections.find(s=>s.id===section.id).lyrics).split('\n')[line],token=lyricTokens(finalLine)[tokensBefore];
    const measures=effectiveMeasures(music,candidate.layout),address=chordOnset(model,group,chunk,lane.passNumber);
    if(token&&address){
      try{candidate=placeWord(candidate,section.id,line,token.offset,address.measure_id,address.beat,measures);}
      catch(error){return {candidate:null,conflicts:[{message:'“'+token.text+'” would land out of order with a word you pinned by hand. Move that pin first, or type the words under the right chord.'}],label,lost};}
    }
  }
  return {candidate,conflicts:[],label,lost};
}

// One editable line of words per pass: `lane` is the line as drawn under this row (null for a pass with no words yet),
// `anchorKey` is the chord the first word is pinned to when a new line is started (where the user clicked).
// The whole fragment of the line that sits on this row is replaced by what was typed; every pin that survives is kept.
function laneText({content,music,model,group,lane,passNumber,anchorKey,text}){
  const chunks=group.bars.flatMap(b=>b.chunks),tokens=lane?.tokens||[];
  const chunk=chunks.find(c=>c.key===(anchorKey??tokens[0]?.chunkKey))||chunks[0];
  if(!chunk)throw Error('This row has no chords to start the words under.');
  return slotText({content,music,model,group,lane:lane||{line:null,passNumber,tokens:[],text:''},laneIndex:0,chunk,fragment:tokens,text});
}

// A lyric line that was never placed on the chart: give it this row's bars so its words spread across the row.
function placeOnRow({content,group,pass,lane}){
  if(!pass?.measureIds?.length)throw Error('This row has no measured bars to place the words on.');
  const next=structuredClone(content);
  next.layout={...defaultLayout(),...next.layout};
  next.layout.lines=(next.layout.lines||[]).filter(p=>!(p.section_id===group.sectionId&&p.line===lane.line));
  next.layout.lines.push({section_id:group.sectionId,line:lane.line,start_measure:pass.measureIds[0],end_measure:pass.measureIds.at(-1),words:[]});
  return next;
}

// Let go of a pin: the word goes back to spreading between its neighbours. The row the line was placed on stays.
function releaseWord({content,sectionId,line,offset}){
  const next=structuredClone(content);let found=false;
  for(const p of next.layout?.lines||[])if(p.section_id===sectionId&&p.line===line){
    const before=p.words.length;p.words=p.words.filter(w=>w.offset!==offset);if(p.words.length!==before)found=true;
  }
  for(const c of next.chords||[])if(c.section_id===sectionId&&c.line===line&&c.offset===offset){c.line=null;c.offset=null;found=true;}
  if(!found)throw Error('This word is not pinned.');
  return next;
}

export const planPageEdit={slotText,laneText,placeOnRow,releaseWord};
