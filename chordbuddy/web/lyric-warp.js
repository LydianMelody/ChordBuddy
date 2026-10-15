// Editing the words of a lyric line must never throw away timing work. Old and new words are aligned (like a diff, but
// matching "same word, fixed typo" too), and every pin follows its word to the word's new position. Words that are
// genuinely gone lose their pin; new words start unpinned and simply spread between their neighbours.
// Pure: no DOM.
import {lyricTokens} from './lyric-chunks.js';

export const SIMILAR_WORD=0.4;   // normalized edit distance at or below this counts as "the same word, retyped"

const letters=text=>Array.from(String(text).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu,''));

// Optimal-string-alignment distance: insert, delete, substitute, or swap two neighbours, each costing one.
export function editDistance(a,b){
  const x=Array.isArray(a)?a:Array.from(a),y=Array.isArray(b)?b:Array.from(b);
  const d=Array.from({length:x.length+1},()=>new Array(y.length+1).fill(0));
  for(let i=0;i<=x.length;i++)d[i][0]=i;
  for(let j=0;j<=y.length;j++)d[0][j]=j;
  for(let i=1;i<=x.length;i++)for(let j=1;j<=y.length;j++){
    const cost=x[i-1]===y[j-1]?0:1;
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+cost);
    if(i>1&&j>1&&x[i-1]===y[j-2]&&x[i-2]===y[j-1])d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);
  }
  return d[x.length][y.length];
}

// The letters of a run of words, ignoring case, punctuation, spaces and hyphens.
const spelling=run=>letters(run.map(t=>t.text).join('')).join('');

// 1 for the same word (ignoring case, punctuation and syllable hyphens), a little less for a typo-sized change, otherwise 0.
export function similarity(a,b){
  const x=letters(a),y=letters(b);
  if(!x.length||!y.length)return x.length===y.length?1:0;
  if(x.join('')===y.join(''))return 1;
  const distance=editDistance(x,y)/Math.max(x.length,y.length);
  return distance<=SIMILAR_WORD?.9*(1-distance):0;
}

// Pairs [oldIndex,newIndex] of words that are the same word. Maximizes total similarity, so exact matches beat typo
// matches, and among equal choices earlier words pair up first (an extra repeated word lands at the end).
export function alignWords(oldTexts,newTexts){
  const n=oldTexts.length,m=newTexts.length;
  const sim=Array.from({length:n},(_,i)=>newTexts.map((t,j)=>similarity(oldTexts[i],t)));
  const best=Array.from({length:n+1},()=>new Array(m+1).fill(0));
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--){
    best[i][j]=Math.max(best[i+1][j],best[i][j+1],sim[i][j]>0?sim[i][j]+best[i+1][j+1]:0);
  }
  const pairs=[];let i=0,j=0;
  while(i<n&&j<m){
    if(sim[i][j]>0&&Math.abs(best[i][j]-(sim[i][j]+best[i+1][j+1]))<1e-9){pairs.push([i,j]);i++;j++;}
    else if(Math.abs(best[i][j]-best[i+1][j])<1e-9)i++;
    else j++;
  }
  return pairs;
}

// Map from each old word's character offset to the same word's new offset, plus the old offsets that found no match.
export function warpOffsets(oldLine,newLine){
  const before=lyricTokens(oldLine),after=lyricTokens(newLine);
  const pairs=alignWords(before.map(t=>t.text),after.map(t=>t.text));
  const map=new Map(),matched=new Set();
  for(const [i,j] of pairs){map.set(before[i].offset,after[j].offset);matched.add(i);}
  // Words that were joined or split (moon light <-> moonlight, unicorn <-> u-ni-corn) spell the same letters: the first
  // old word's pin goes to the first new word. Only the boundary that no longer exists loses its pin.
  const anchors=[[-1,-1],...pairs,[before.length,after.length]];
  for(let n=0;n<anchors.length-1;n++){
    const [oi,nj]=anchors[n],[oe,ne]=anchors[n+1],oldRun=before.slice(oi+1,oe),newRun=after.slice(nj+1,ne);
    if(oldRun.length&&newRun.length&&spelling(oldRun)===spelling(newRun)){map.set(oldRun[0].offset,newRun[0].offset);matched.add(oi+1);}
  }
  return {map,lost:before.filter((_,i)=>!matched.has(i)).map(t=>t.offset),before,after};
}

const flat=text=>String(text??'').replace(/\r\n?|\n/g,' ');

// Replace one lyric line's text, carrying every pin (and older chord binding) on that line to its word's new place.
// Returns {candidate, lost} where lost counts the pins that belonged to words that no longer exist.
export function replaceLineText(content,sectionId,lineIndex,newText){
  const next=structuredClone(content),section=next.sections?.find(s=>s.id===sectionId);
  if(!section)throw Error('Choose an existing section.');
  const lines=String(section.lyrics??'').split('\n');
  if(!Number.isInteger(lineIndex)||lineIndex<0||lineIndex>=lines.length)throw Error('Choose an existing lyric line.');
  const value=flat(newText).trim(),{map}=warpOffsets(lines[lineIndex],value);
  lines[lineIndex]=value;section.lyrics=lines.join('\n');
  let lost=0;
  if(next.layout?.lines)for(const placement of next.layout.lines){
    if(placement.section_id!==sectionId||placement.line!==lineIndex)continue;
    const kept=[];
    for(const word of placement.words){if(map.has(word.offset))kept.push({...word,offset:map.get(word.offset)});else lost++;}
    placement.words=kept.sort((a,b)=>a.offset-b.offset);
  }
  for(const chord of next.chords||[]){
    if(chord.section_id!==sectionId||chord.line!==lineIndex||!Number.isInteger(chord.offset))continue;
    const offset=map.get(chord.offset);
    if(offset===undefined){chord.line=null;chord.offset=null;lost++;}else chord.offset=offset;
  }
  return {candidate:next,lost};
}

// Add a brand-new lyric line at the end of a section.
export function appendLine(content,sectionId,text){
  const next=structuredClone(content),section=next.sections?.find(s=>s.id===sectionId);
  if(!section)throw Error('Choose an existing section.');
  const value=flat(text).trim();if(!value)throw Error('Type some words first.');
  const line=section.lyrics?String(section.lyrics).split('\n').length:0;
  section.lyrics=section.lyrics?section.lyrics+'\n'+value:value;
  return {candidate:next,line};
}

// Remove a lyric line entirely, renumbering the lines (and their pins and chord bindings) after it.
export function removeLine(content,sectionId,lineIndex){
  const next=structuredClone(content),section=next.sections?.find(s=>s.id===sectionId);
  if(!section)throw Error('Choose an existing section.');
  const lines=String(section.lyrics??'').split('\n');
  if(lineIndex<0||lineIndex>=lines.length)throw Error('Choose an existing lyric line.');
  lines.splice(lineIndex,1);section.lyrics=lines.join('\n');
  if(next.layout?.lines)next.layout.lines=next.layout.lines.filter(p=>p.section_id!==sectionId||p.line!==lineIndex).map(p=>p.section_id===sectionId&&p.line>lineIndex?{...p,line:p.line-1}:p);
  for(const chord of next.chords||[])if(chord.section_id===sectionId&&Number.isInteger(chord.line)){
    if(chord.line===lineIndex){chord.line=null;chord.offset=null;}else if(chord.line>lineIndex)chord.line-=1;
  }
  return next;
}
