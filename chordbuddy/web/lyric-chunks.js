/* Chunk boundaries are presentation; saved anchors remain Unicode codepoint offsets. */
const letter=c=>!!c&&/[\p{L}\p{M}\p{N}]/u.test(c);
const separator=(chars,i)=>['-','\u2011'].includes(chars[i])&&letter(chars[i-1])&&letter(chars[i+1]);
export function lyricTokens(line){
 const chars=Array.from(line),result=[];let start=0;
 const push=end=>{if(end>start)result.push({text:chars.slice(start,end).join(''),offset:start});start=end;};
 for(let i=0;i<chars.length;i++){
  if(/\s/u.test(chars[i])){push(i);start=i+1;}
  else if(chars[i]==='-'&&separator(chars,i))push(i+1);
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
