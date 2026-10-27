import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildCompactChart,compactFoldChoices,applyCompactFold} from '../chordbuddy/web/compact-chart.js';

const original=JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
const fixture=()=>structuredClone(original);

test('bars re-gridded by a timing correction (no stored quarter positions) still fold',()=>{
  const {content,music}=fixture(),folded=buildCompactChart(content,music).groups.map(g=>[g.bars.length,g.passes.length]);
  for(const m of music.measures)m.quarter_positions=m.beats.map(()=>null).concat([null]);
  const again=buildCompactChart(content,music);
  assert.deepEqual(again.groups.map(g=>[g.bars.length,g.passes.length]),folded);
});

test('a folded stretch can be regrouped into longer phrases, or written out',()=>{
  const {content,music}=fixture(),view=buildCompactChart(content,music),group=view.groups[0];
  assert.equal(group.passes.length,4);
  const choices=compactFoldChoices(view,group);
  assert.deepEqual(choices.filter(c=>!c.expanded).map(c=>[c.unit,c.count]),[[4,4],[8,2]]);
  assert.ok(choices.find(c=>c.expanded));
  const two=choices.find(c=>c.unit===8),next=applyCompactFold(content,music,view,group,two),after=buildCompactChart(next,music);
  assert.deepEqual(after.groups.filter(g=>!g.continuation).map(g=>[g.bars.length,g.passes.length]),[[8,2]]);
  const flat=applyCompactFold(content,music,view,group,choices.find(c=>c.expanded));
  assert.ok(buildCompactChart(flat,music).groups.every(g=>g.passes.length===1));
  assert.equal(JSON.stringify(content),JSON.stringify(fixture().content),'the original chart is untouched');
});

test('a chord held over from the previous pass does not stop an 8-bar phrase folding',()=>{
  // C Am F F | Am F C C, twice: the second pass starts with the C held over from the first
  const names=['C','Am','F','F','Am','F','C','C'],bars=[],chords=[];
  for(let i=0;i<16;i++){
    bars.push({id:'m'+i,number:i+1,start:i*2,end:i*2+2,beats:[0,.5,1,1.5].map(t=>i*2+t),meter:[4,4],quarter_positions:[0,1,2,3,4]});
    const label=names[i%8],last=chords.at(-1);
    if(last&&last.label===label)last.end=i*2+2;else chords.push({id:'c'+i,label,start:i*2,end:i*2+2,section_id:'s',line:null,offset:null});
  }
  const content={version:1,duration:32,sections:[{id:'s',name:'Chorus',start:0,end:32,lyrics:''}],chords};
  const view=buildCompactChart(content,{measures:bars});
  assert.deepEqual(view.groups.map(g=>[g.bars.length,g.passes.length]),[[8,2]]);
});

import {compactRangeChoices,applyCompactRange} from '../chordbuddy/web/compact-chart.js';
test('picking a range of bars lists the ways it can repeat, and applying one folds exactly that range',()=>{
  const {content,music}=fixture(),view=buildCompactChart(content,music);
  const ids=music.measures.map(m=>m.id);
  const info=compactRangeChoices(content,music,ids[0],ids[7]);
  assert.equal(info.length,8);assert.equal(info.problem,null);
  assert.ok(info.choices.length>=2&&info.choices.at(-1).expanded);
  const unfold=applyCompactRange(content,music,view,ids[0],ids[7],info.choices.at(-1));
  assert.equal(unfold.layout.compact.groups[0].mode,'expanded');
  assert.ok(buildCompactChart(unfold,music).groups.every(g=>g.passes.length===1||g.start>=music.measures[8].start));
  const bad=compactRangeChoices(content,music,ids[0],ids[2]);
  assert.ok(bad.problem||bad.choices.length===1);
});

test('only a progression folds, never one chord: F for two bars, then Am for two, is written out, F | (F) | Am | (Am)',()=>{
  const bars=[],chords=[];
  for(let i=0;i<4;i++)bars.push({id:'m'+i,number:i+1,start:i*2,end:i*2+2,beats:[0,.5,1,1.5].map(t=>i*2+t),meter:[4,4],quarter_positions:[0,1,2,3,4]});
  chords.push({id:'a',label:'F',start:0,end:4,section_id:'s',line:null,offset:null},{id:'b',label:'Am',start:4,end:8,section_id:'s',line:null,offset:null});
  const content={version:1,duration:8,sections:[{id:'s',name:'Interlude',start:0,end:8,lyrics:''}],chords};
  const view=buildCompactChart(content,{measures:bars});
  assert.ok(view.groups.every(g=>g.passes.length===1),'nothing folded');
  assert.deepEqual(view.occurrences.map(o=>[o.label,o.continued]),[['F',false],['F',true],['Am',false],['Am',true]]);
  const struck=structuredClone(content);struck.chords=[0,1,2,3].map(i=>({id:'c'+i,label:'B',start:i*2,end:i*2+2,section_id:'s',line:null,offset:null}));
  assert.ok(buildCompactChart(struck,{measures:bars}).groups.every(g=>g.passes.length===1),'B played again every bar is still one chord: not folded');
  const two=structuredClone(content);two.chords=[0,1,2,3].flatMap(i=>[{id:'g'+i,label:'G',start:i*2,end:i*2+1,section_id:'s',line:null,offset:null},{id:'d'+i,label:'D',start:i*2+1,end:i*2+2,section_id:'s',line:null,offset:null}]);
  assert.deepEqual(buildCompactChart(two,{measures:bars}).groups.map(g=>g.passes.length),[4],'G D in every bar is a progression: G D ×4');
  const byHand=compactRangeChoices(struck,{measures:bars},'m0','m3');                      // and folding it by hand is not offered either
  assert.deepEqual(byHand.choices.map(c=>c.label),['Not folded (write out every pass)']);assert.match(byHand.problem,/One chord on its own/);
});
