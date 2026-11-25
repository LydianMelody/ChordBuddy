/* Chunk boundaries are presentation; saved anchors remain Unicode codepoint offsets. */
// A word splits into pieces that are timed on their own in two ways. A dash typed between letters ("o-own") splits it and is shown
// everywhere, like any letter. A hidden split, the soft hyphen U+00AD (made with the scissors on a word's top edge in the Timing tool),
// splits it and shows nothing: the word reads whole on screen, and only a line that ends in one shows a dash there.
export const SPLIT='\u00ad';
const letter=c=>!!c&&/[\p{L}\p{M}\p{N}]/u.test(c);
const separator=(chars,i)=>['-','\u2011',SPLIT].includes(chars[i])&&letter(chars[i-1])&&letter(chars[i+1]);
// A piece that joins the next one with no space between them on screen.
export const joinsNext=text=>/[-\u2011\u00ad]$/u.test(String(text??''));
// A piece as it is shown: a hidden split disappears, or is a dash when the piece is the last on its line.
export const shownPiece=(text,last=false)=>{const s=String(text??'');return s.endsWith(SPLIT)?s.slice(0,-1)+(last?'-':''):s;};
// A whole line as it is shown: hidden splits disappear inside it, and one at its end is a dash.
export const shownLine=text=>String(text??'').replace(/\u00ad(?=\s*$)/u,'-').replace(/\u00ad/gu,'');
export function lyricTokens(line){
 const chars=Array.from(line),result=[];let start=0;
 const push=end=>{if(end>start)result.push({text:chars.slice(start,end).join(''),offset:start});start=end;};
 for(let i=0;i<chars.length;i++){
  if(/\s/u.test(chars[i])){push(i);start=i+1;}
  else if((chars[i]==='-'||chars[i]===SPLIT)&&separator(chars,i))push(i+1);
 }
 push(chars.length);return result;
}
function skeleton(text){const chars=Array.from(text),indices=[];chars.forEach((c,i)=>{if(!separator(chars,i))indices.push(i);});return {chars,indices,key:indices.map(i=>chars[i]).join('')};}
export function boundaryOffsetMap(before,after){
 if(before===after)return new Map(Array.from({length:Array.from(before).length+1},(_,i)=>[i,i]));
 const a=skeleton(before),b=skeleton(after);if(a.key!==b.key)return null;
 const starts=new Set(lyricTokens(after).map(t=>t.offset)),oldStarts=new Set(lyricTokens(before).map(t=>t.offset)),map=new Map();
 a.indices.forEach((offset,i)=>{const target=b.indices[i];if(starts.has(target)||!oldStarts.has(offset))map.set(offset,target);});
 // Legacy chord anchors may point at the end of a line. Preserve that position.
 map.set(a.chars.length,b.chars.length);return map;
}
export function remapLineAnchors(content,sectionId,oldLine,newLine,map){
 for(const c of content.chords||[])if(c.section_id===sectionId&&c.line===oldLine){const offset=map?.get(c.offset);c.line=offset===undefined?null:newLine;c.offset=offset===undefined?null:offset;}
 if(content.layout?.lines)content.layout.lines=content.layout.lines.flatMap(p=>{
  if(p.section_id!==sectionId||p.line!==oldLine)return [p];if(!map)return [];
  const words=p.words.filter(w=>map.has(w.offset)).map(w=>({...w,offset:map.get(w.offset)}));
  return words.length?[{...p,line:newLine,words}]:[];
 });
}
export function lyricPlacementLosses(before,after){
 const count=c=>(c.layout?.lines||[]).reduce((n,p)=>n+p.words.length,0)+(c.chords||[]).filter(c=>Number.isInteger(c.line)&&Number.isInteger(c.offset)).length;
 return Math.max(0,count(before)-count(after));
}
