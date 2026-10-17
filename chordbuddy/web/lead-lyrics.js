// Putting the chart's lyrics on the lead sheet's melody notes. Pure: no DOM.
// The chart is the one home of the words (lines of text plus pins that fix some words to a beat). The lead sheet only decides which
// note each word sits on: a pinned word goes to the note nearest its pin, and the words between pins take the notes between them, in
// order. If there are more words than notes, some notes carry two words; nothing is left over.
import {layoutLine} from './word-layout.js';
import {addressAtSeconds} from './musical-grid.js';

const finite=Number.isFinite;

// Seconds at a position given in quarter notes from the start of a bar.
export function secondsAtQuarter(measure,quarters){
  const times=[...(measure.beats||[]),measure.end],q=measure.quarter_positions;
  if(q&&q.length===times.length&&q.every(finite)){
    for(let i=0;i<q.length-1;i++)if(quarters<q[i+1]+1e-9&&q[i+1]>q[i])return times[i]+Math.max(0,quarters-q[i])/(q[i+1]-q[i])*(times[i+1]-times[i]);
    return measure.end;
  }
  const length=q?.length?q.at(-1):4;
  return measure.start+Math.min(1,Math.max(0,quarters/length))*(measure.end-measure.start);
}

// When each melody note of the score starts, in recording time. `exact` says the score and the chart have the same number of bars.
export function scoreNoteTimes(analysis,measures){
  const exact=analysis.timeMeasures===measures.length;
  const notes=analysis.notes.map(note=>{
    const measure=measures[note.timeMeasure];
    if(!measure)return {index:note.index,time:null,address:null};
    const time=secondsAtQuarter(measure,(note.offset||0)*4);
    return {index:note.index,time,address:addressAtSeconds(measures,Math.min(time,measure.end-1e-6))};
  });
  return {exact,notes};
}

// Pick `count` of the notes (their start times) for words that would sit evenly between `left` and `right`, in order.
function pickEvenly(times,count,left,right){
  const picks=[];let from=0;
  for(let k=0;k<count;k++){
    const target=left+(k+1)*(right-left)/(count+1),last=times.length-(count-k);
    let best=from;for(let n=from;n<=last;n++)if(Math.abs(times[n]-target)<Math.abs(times[best]-target))best=n;
    picks.push(best);from=best+1;
  }
  return picks;
}

// Which note each word sits on. `notes` is [{index,time}] in score order. Returns
//   byNote: Map(note index -> [{text,sectionId,line,offset,pinned}])   words on that note, in order
//   byWord: Map("sectionId:line:offset" -> note index)
//   unplaced: [{sectionId,line,words}]   lines whose stretch of the song has no melody notes at all
export function placeLyricsOnNotes(content,measures,notes){
  const byNote=new Map(),byWord=new Map(),unplaced=[];
  const timed=notes.filter(n=>finite(n.time)).sort((a,b)=>a.time-b.time);
  for(const section of content.sections||[]){
    String(section.lyrics??'').split('\n').forEach((_,line)=>{
      const layout=layoutLine(content,measures,section.id,line);
      if(!layout?.placed||!layout.tokens.length)return;
      const pool=timed.filter(n=>n.time>=layout.start-1e-6&&n.time<layout.end-1e-9);
      if(!pool.length){unplaced.push({sectionId:section.id,line,words:layout.tokens.length});return;}
      const tokens=layout.tokens,assign=Array(tokens.length).fill(null);
      // 1. words fixed in time (pins, chord ties, and the first word at the start of the line) go to the nearest note not before the previous one
      let previous=0;
      tokens.forEach((token,i)=>{
        if(token.kind==='spread')return;
        let best=previous;for(let p=previous;p<pool.length;p++)if(Math.abs(pool[p].time-token.seconds)<Math.abs(pool[best].time-token.seconds))best=p;
        assign[i]=best;previous=best;
      });
      // 2. the words between two fixed words take the notes between them
      const fixed=assign.map((p,i)=>p===null?null:i).filter(i=>i!==null);
      const spans=[];
      fixed.forEach((i,n)=>spans.push({from:i,to:fixed[n+1]??tokens.length,low:assign[i],high:fixed[n+1]!==undefined?assign[fixed[n+1]]:pool.length,left:tokens[i].seconds,right:fixed[n+1]!==undefined?tokens[fixed[n+1]].seconds:layout.end}));
      for(const {from,to,low,high,left,right} of spans){
        const free=to-from-1;if(free<=0)continue;
        const available=[];for(let p=low+1;p<high;p++)available.push(p);
        if(available.length>=free){
          const picks=pickEvenly(available.map(p=>pool[p].time),free,left,right);
          picks.forEach((pick,k)=>{assign[from+1+k]=available[pick];});
        }else if(available.length>0){
          for(let k=0;k<free;k++)assign[from+1+k]=available[Math.floor(k*available.length/free)];
        }else{
          for(let k=0;k<free;k++)assign[from+1+k]=low;                       // no free note: share the previous word's note
        }
      }
      tokens.forEach((token,i)=>{
        const note=pool[assign[i]??0].index,pinned=token.kind==='pin'||token.kind==='chord';
        const word={text:token.text,sectionId:section.id,line,offset:token.offset,pinned,address:pinned&&token.measureId?{measure_id:token.measureId,beat:token.beat}:null};
        if(!byNote.has(note))byNote.set(note,[]);
        byNote.get(note).push(word);byWord.set(`${section.id}:${line}:${token.offset}`,note);
      });
    });
  }
  return {byNote,byWord,unplaced};
}

// The syllable abcjs prints under a note: words on one note share it, and a trailing hyphen on the last one joins it to the next note.
export function lyricForNote(words){
  if(!words?.length)return null;
  const last=words.at(-1).text,joined=words.map((w,i)=>i===words.length-1?w.text.replace(/-$/u,''):w.text).join(' ');
  return {syllable:joined,divider:last.endsWith('-')?'-':' '};
}
