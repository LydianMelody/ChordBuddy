// Dragging a word pushes the words of the lines before and after it, the way it pushes the words of its own line: lyrics never
// overlap another line and never change order, and a pinned word of the next or previous line is a wall.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Node,all,installDom} from './compact-dom.mjs';
import {mountChartPage} from '../chordbuddy/web/chart-page.js';
import {layoutLine} from '../chordbuddy/web/word-layout.js';
import {neighbourWalls,pushNeighbours} from '../chordbuddy/web/timing-geometry.js';

const has=(n,c)=>String(n.className||'').split(' ').includes(c);
const byClass=(root,c)=>all(root).filter(n=>has(n,c));
const tick=()=>new Promise(r=>setImmediate(r));

// One Verse (bars 1 to 4, 0 to 8 s) with two lines: "one two" in bars 1-2 and "three four five" in bars 3-4.
function chart(line0Words,line1Words){
  const f=JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
  f.content.sections=[{id:'v',name:'Verse',start:0,end:8,lyrics:'one two\nthree four five'},{id:'c',name:'Chorus',start:8,end:32,lyrics:''}];
  for(const c of f.content.chords)c.section_id=c.start<8?'v':'c';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[
    {section_id:'v',line:0,start_measure:'m0',end_measure:'m1',words:line0Words},
    {section_id:'v',line:1,start_measure:'m2',end_measure:'m3',words:line1Words},
  ]};
  return f;
}
function setup(f){
  installDom();const root=new Node(),commits=[],errors=[];
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async(c,l)=>{commits.push({candidate:c,label:l});},onError:e=>errors.push(e)});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});view.setMode('timing');
  const bars=byClass(root,'tbar');let x=0;
  for(const b of bars){const w=parseFloat(b.style.width),left=x;b.getBoundingClientRect=()=>({left,right:left+w,top:0,bottom:100,width:w,height:100});x+=w;}
  return {root,view,commits,errors,bars,f};
}
const chipOf=(s,text)=>byClass(s.root,'wchip').find(c=>!has(c,'ghost')&&c.textContent.trim()===text);
const drag=(s,text,barId,at)=>{
  const chip=chipOf(s,text),r=s.bars.find(b=>b.dataset.bar===barId).getBoundingClientRect(),x=r.left+r.width*at;
  chip.setPointerCapture=()=>{};chip.releasePointerCapture=()=>{};
  chip.onpointerdown({button:0,pointerId:1,clientX:x+300,clientY:50,shiftKey:true,preventDefault(){}});
  chip.onpointermove({pointerId:1,clientX:x,clientY:50});
  return async()=>{chip.onpointerup({pointerId:1,clientX:x,clientY:50});await tick();await tick();};
};
// every word of the Verse, in the order it is written, with its saved time
const sung=(s,content)=>[0,1].flatMap(line=>layoutLine(content,s.f.music.measures,'v',line).tokens.map(t=>[t.text,t.seconds]));
const inOrder=list=>list.every(([,t],i)=>!i||t>list[i-1][1]+1e-6);

test('pushing forward: a word dragged into the next line\'s bars pushes that line\'s unpinned words on, and they stay there', async () => {
  const s=setup(chart([{offset:0,measure_id:'m0',beat:0}],[]));          // "two" and the whole second line are not pinned
  const drop=drag(s,'two','m2',.5);
  // while dragging, "three" is already drawn after the drop point, not under it
  const mark=byClass(s.root,'drop-mark')[0];assert.ok(mark);
  const three=chipOf(s,'three');assert.equal(three.parent.parent.dataset.bar,'m2');
  assert.ok(parseFloat(three.style.left)>parseFloat(mark.style.left),'"three" sits after the dragged word');
  await drop();
  assert.equal(s.errors.length,0);assert.equal(s.commits.length,1);
  const words=sung(s,s.commits[0].candidate),at=Object.fromEntries(words);
  assert.ok(inOrder(words),'every word in the order it is sung: '+JSON.stringify(words));
  assert.ok(at.two>=4.5&&at.two<=5.5,'"two" is in bar 3 where it was dropped');
  assert.ok(at.five<8,'the second line still ends inside its last bar');
});

test('pushing back: a word dragged into the line before pulls its own first words along and pushes the line before back', async () => {
  const s=setup(chart([{offset:0,measure_id:'m0',beat:0}],[{offset:11,measure_id:'m3',beat:0}]));   // "four" is pinned on bar 4
  const drop=drag(s,'four','m1',.5);
  await drop();
  assert.equal(s.errors.length,0);assert.equal(s.commits.length,1);
  const words=sung(s,s.commits[0].candidate),at=Object.fromEntries(words);
  assert.ok(inOrder(words),'every word in the order it is sung: '+JSON.stringify(words));
  assert.ok(at.four>=2.5&&at.four<=3.5,'"four" is in bar 2 where it was dropped');
  assert.ok(at.two<at.three&&at.two<2,'"two" made room for "three"');
  assert.equal(at.one,0,'the pinned first word did not move');
});

test('a pinned word of the next line is a wall the dragged word never passes', async () => {
  const s=setup(chart([{offset:0,measure_id:'m0',beat:0}],[{offset:0,measure_id:'m2',beat:0}]));   // "three" is pinned on bar 3
  const drop=drag(s,'two','m3',.5);
  await drop();
  for(const c of s.commits){const words=sung(s,c.candidate);assert.ok(inOrder(words),JSON.stringify(words));assert.ok(Object.fromEntries(words).two<4);}
});

test('lines that are not reached are left exactly where they were', () => {
  const prev={times:[0,1],fixed:[true,false],end:2},next={times:[4,5],fixed:[false,false],end:8};
  const r=pushNeighbours([2,3],[false,false],1,3,prev,next);
  assert.deepEqual([r.own,r.prev,r.next,r.pushedPrev,r.pushedNext],[[2,3],[0,1],[4,5],false,false]);
  assert.deepEqual(neighbourWalls(prev,next),{left:0,right:8});
  const pushed=pushNeighbours([2,4.5],[false,false],1,4.5,prev,next);
  assert.deepEqual(pushed.next.map(t=>+t.toFixed(3)),[5.667,6.833]);assert.equal(pushed.pushedNext,true);
});
