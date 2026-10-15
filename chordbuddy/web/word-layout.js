// Where every word of a lyric line sits in time. Pure: no DOM, no pixels.
//
// A line's words are fixed by its pins (saved anchors: character offset -> bar + beat). Words between two pins spread
// evenly between them, like a puppet warp in one dimension: move a pin and the words between its neighbours follow.
// A line that was placed on a row but has no pins spreads across the whole row. A line that was never placed has no
// times at all (it is "unplaced" and shown as plain flowing text).
import {lyricTokens} from './lyric-chunks.js';
import {addressAtSeconds,secondsAtAddress} from './musical-grid.js';

const EPS=1e-6,GAP=.12;

export function lineText(content,sectionId,lineIndex){
  const section=content.sections?.find(s=>s.id===sectionId);
  if(!section)return null;
  const lines=String(section.lyrics??'').split('\n');
  return typeof lines[lineIndex]==='string'?lines[lineIndex]:null;
}

export function linePlacement(content,sectionId,lineIndex){
  return content.layout?.lines?.find(p=>p.section_id===sectionId&&p.line===lineIndex)||null;
}

const safeSeconds=(measures,address)=>{try{return secondsAtAddress(measures,address);}catch{return null;}};

// Times for every word given the fixed ones (a number) and the free ones (null), in order. The first word must be fixed.
// Free words spread evenly between their fixed neighbours; free words after the last fixed one spread towards `end`.
// With `onsets` (when the melody's note starts are known) a gap that has enough notes puts its words on notes instead:
// a rough guess, nothing more. `guessed[i]` is set for every word that was placed that way.
export function spreadBetween(fixedTimes,end,onsets=null,guessed=null){
  const seconds=[...fixedTimes];
  let i=0;
  while(i<seconds.length){
    if(seconds[i]!==null){i++;continue;}
    let j=i;while(j<seconds.length&&seconds[j]===null)j++;
    const left=seconds[i-1],trailing=j>=seconds.length,right=trailing?Math.max(end,left):seconds[j],count=j-i;
    const picks=onsets?melodyGuess(left,right,count,onsets,!trailing):null;
    for(let k=0;k<count;k++){
      seconds[i+k]=picks?picks[k]:left+(k+1)*(right-left)/(count+1);
      if(guessed&&picks)guessed[i+k]=true;
    }
    i=j;
  }
  return seconds;
}

// Pick one note start for each of `count` words between `left` and `right`, in order, each as close as possible to where
// even spacing would put it. Returns null when the notes in that stretch are too few (the words then spread evenly).
export function melodyGuess(left,right,count,onsets,rightIsPin=true){
  const pool=onsets.filter(t=>t>left+GAP&&t<right-(rightIsPin?GAP:EPS));
  if(count<1||pool.length<count)return null;
  const picks=[];let from=0;
  for(let k=0;k<count;k++){
    const target=left+(k+1)*(right-left)/(count+1),last=pool.length-(count-k);
    let best=from;for(let n=from;n<=last;n++)if(Math.abs(pool[n]-target)<Math.abs(pool[best]-target))best=n;
    picks.push(pool[best]);from=best+1;
  }
  return picks;
}

// Note starts from MIDI notes, earliest first, with near-simultaneous starts counted once.
export function onsetsFromNotes(notes){
  const starts=[...new Set((notes||[]).map(n=>n.start).filter(Number.isFinite))].sort((a,b)=>a-b),result=[];
  for(const t of starts)if(!result.length||t-result.at(-1)>=.1)result.push(t);
  return result;
}

// Returns null if the line does not exist, otherwise
//   {placed, start, end, tokens:[{text, offset, seconds, kind, pinned, measureId, beat}]}
// kind is 'pin' (saved anchor), 'chord' (older chord binding), 'start' (first word, implicitly at the line start) or 'spread'.
export function layoutLine(content,measures,sectionId,lineIndex,{onsets=null}={}){
  const text=lineText(content,sectionId,lineIndex);
  if(text===null)return null;
  const section=content.sections.find(s=>s.id===sectionId),tokens=lyricTokens(text),placement=linePlacement(content,sectionId,lineIndex);
  const starts=new Set(tokens.map(t=>t.offset)),anchors=new Map();
  for(const word of placement?.words||[]){
    if(!starts.has(word.offset))continue;
    const seconds=safeSeconds(measures,word);
    if(Number.isFinite(seconds))anchors.set(word.offset,{seconds,kind:'pin'});
  }
  for(const chord of content.chords||[]){
    if(chord.section_id!==sectionId||chord.line!==lineIndex||!Number.isInteger(chord.offset)||!starts.has(chord.offset)||anchors.has(chord.offset))continue;
    anchors.set(chord.offset,{seconds:chord.start,kind:'chord'});
  }
  if(!placement&&!anchors.size)return {placed:false,start:null,end:null,tokens:tokens.map(t=>({...t,seconds:null,kind:'unplaced',pinned:false,measureId:null,beat:null}))};

  const measureById=id=>measures.find(m=>m.id===id);
  let start=placement&&measureById(placement.start_measure)?measureById(placement.start_measure).start:section.start;
  let end=placement&&measureById(placement.end_measure)?measureById(placement.end_measure).end:section.end;
  const pinTimes=[...anchors.values()].map(a=>a.seconds);
  if(pinTimes.length){start=Math.min(start,...pinTimes);end=Math.max(end,...pinTimes);}

  // Fixed points: every anchor, plus the first word at the line start when it has no anchor of its own.
  const fixed=tokens.map(t=>anchors.get(t.offset)||null);
  if(tokens.length&&!fixed[0])fixed[0]={seconds:start,kind:'start'};
  // Times must never run backwards, whatever order the saved anchors arrived in.
  let floor=-Infinity;
  for(const point of fixed)if(point){point.seconds=Math.max(point.seconds,floor);floor=point.seconds;}

  const guessed=[];
  const seconds=spreadBetween(fixed.map(point=>point?point.seconds:null),end,onsets?.length?onsets:null,guessed);
  const kinds=fixed.map((point,n)=>point?point.kind:guessed[n]?'suggest':'spread');
  return {
    placed:true,start,end,
    tokens:tokens.map((t,n)=>{
      const address=addressAtSeconds(measures,Math.min(seconds[n],(measures.at(-1)?.end??seconds[n])-EPS))||null;
      return {...t,seconds:seconds[n],kind:kinds[n],pinned:kinds[n]==='pin',measureId:address?.measure_id??null,beat:address?.beat??null};
    }),
  };
}

// Index of the word being sung at a given time (the last word that has started), or -1 before the first one.
export function currentWordIndex(tokens,seconds){
  let current=-1;
  for(let i=0;i<tokens.length;i++){
    if(Number.isFinite(tokens[i].seconds)&&tokens[i].seconds<=seconds+EPS)current=i;else if(Number.isFinite(tokens[i].seconds))break;
  }
  return current;
}
