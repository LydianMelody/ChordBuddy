import run from 'node:test';
import assert from 'node:assert/strict';

// Diamond Dust Mk II's sung words: syllables joined into words, when each word shows, is sung and melts, and the distance field its
// letters are drawn from. (The shaders themselves are checked by drawing them in a real browser.)
globalThis.document??={createElement:()=>({width:1,height:1,getContext:()=>null})};
// It lives in My Visuals while it is being worked on (that folder is not published), so its '../visual-…' imports are pointed at the app's
// own files and it is loaded from a copy. Without the file (on another computer), these tests are skipped.
const {existsSync,readFileSync,writeFileSync,mkdtempSync}=await import('node:fs');
const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {pathToFileURL}=await import('node:url');
const source=new URL('../My Visuals/diamond-dust-mk2.js',import.meta.url),web=new URL('../chordbuddy/web/',import.meta.url).href;
const here=existsSync(source);
let joinWords,wordState,distanceBytes;
if(here){
  const copy=join(mkdtempSync(join(tmpdir(),'cb-mk2-')),'diamond-dust-mk2.mjs');
  writeFileSync(copy,readFileSync(source,'utf8').replace(/from '\.\.\//g,`from '${web}`));
  ({joinWords,wordState,distanceBytes}=await import(pathToFileURL(copy).href));
}
const test=(name,fn)=>run(name,{skip:!here&&'My Visuals/diamond-dust-mk2.js is not on this computer'},fn);

test('a word cut into syllables for timing becomes one word on screen, timed from the first piece to the last; a typed dash stays', () => {
  const words=joinWords([{text:'ex',joined:true,start:1,end:1.2},{text:'pect',joined:true,start:1.2,end:1.4},{text:'ed',start:1.4,end:1.9},{text:'now',start:2,end:2.5},
    {text:'o-',joined:true,start:2.5,end:2.7},{text:'own',start:2.7,end:2.9},{text:'later',start:NaN,end:NaN},{text:' ',start:3,end:3.1}]);
  assert.deepEqual(words,[{text:'expected',start:1,end:1.9},{text:'now',start:2,end:2.5},{text:'o-own',start:2.5,end:2.9}]);
});

test('a word shows before its line starts, takes its color when sung, drifts out of focus and melts away after it ends', () => {
  const first={text:'ice',start:10,end:10.4},last={text:'sky',start:10.5,end:11},line={start:10,end:11,words:[first,last]};
  assert.equal(wordState(first,line,8).shown,0);                       // too early
  assert.equal(wordState(first,line,9).shown,1);                       // shown 1.6 s ahead, readable before it is sung
  assert.equal(wordState(first,line,9.9).sung,0);
  assert.equal(wordState(first,line,10.2).sung,1);
  assert.equal(wordState(first,line,10.5).melted,0);                   // held a moment after it is sung
  assert.ok(wordState(first,line,11).melted>0&&wordState(first,line,11).melted<1);
  assert.ok(wordState(first,line,12.5).gone);
  // in focus until it is sung, then steadily out of focus until it has melted away
  assert.equal(wordState(first,line,9.9).blur,0);
  const b=[10.3,10.8,11.5,12.2].map(t=>wordState(first,line,t).blur);
  assert.ok(b[0]>0&&b.every((v,i)=>i===0||v>b[i-1]),'the blur only grows');
  assert.ok(b[3]>0.95);
  // the last word of a line stays a little longer
  assert.equal(wordState(last,line,11.5).melted,0);
  assert.ok(wordState(last,line,12).melted>0);
});

test('the distance field is 128 on the letter\'s edge, higher outside and lower inside, and rows go upward', () => {
  const w=40,h=20,alpha=new Uint8Array(w*h);
  for(let y=0;y<10;y++)for(let x=10;x<30;x++)alpha[y*w+x]=255;          // a block in the top half (canvas rows go down)
  const out=new Uint8Array(w*h);distanceBytes(alpha,w,h,out,w,0);
  const at=(x,row)=>out[row*w+x];                                       // row 0 is the bottom
  assert.ok(at(20,15)<128,'inside the block (top half, so the upper rows)');
  assert.ok(at(20,4)>128,'below the block');
  assert.ok(at(2,15)>at(9,15),'further outside reads higher');
  assert.ok(Math.abs(at(10,15)-128)<=8&&Math.abs(at(9,15)-128)<=8,'the edge is close to 128');
});
