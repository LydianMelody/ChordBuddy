// A progression that repeats except for its last bar (A D A E, then A D A F) is not a repeat with a changed ending: only bars that repeat
// exactly fold, so these 16 bars fold as 8 bars x2. In Timing every pass of a repeat has its own lane in every bar, words or not, and each
// word is drawn in the lane of the pass it is sung in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {all,installDom,Node} from './compact-dom.mjs';
import {mountChartPage} from '../chordbuddy/web/chart-page.js';
import {buildCompactChart,compactFoldChoices} from '../chordbuddy/web/compact-chart.js';

// 16 bars (m0 to m15) in one section, one chord on each: A D A E | A D A F | A D A E | A D A F
const LABELS=['A','D','A','E','A','D','A','F','A','D','A','E','A','D','A','F'];
const chart=()=>{
  const f=JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
  f.content.chords=f.music.measures.map((m,i)=>({id:'c'+i,label:LABELS[i],start:m.start,end:m.end,section_id:'s',line:null,offset:null}));
  return f;
};
const has=(n,c)=>String(n.className||'').split(' ').includes(c);
const byClass=(root,c)=>all(root).filter(n=>has(n,c));
const mounted=f=>{
  installDom();const root=new Node();
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async()=>{},onError:()=>{},onBarEdit:()=>{}});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});
  return {root,view};
};

test('a repeat whose last bar changes is not folded with an ending: it folds as the longer stretch that repeats exactly', () => {
  const f=chart(),g=buildCompactChart(f.content,f.music).groups[0];
  assert.equal(g.bars.length,8);assert.equal(g.passes.length,2);
  assert.equal(g.endingVariants,undefined,'no changed endings at all');
  const {root}=mounted(f);
  assert.equal(byClass(root,'alt-endings').length+byClass(root,'ending-chord').length,0,'nothing listed below the row');
});

test('regrouping offers whole multiples only', () => {
  const f=chart(),view=buildCompactChart(f.content,f.music);
  assert.deepEqual(compactFoldChoices(view,view.groups[0]).map(c=>c.label),['8 bars ×2','Not folded (write out every pass)']);
});

test('Edit tool: a click on the repeat count opens the same choices as in Timing; with the Play tool it does nothing', () => {
  const {root,view}=mounted(chart());
  const count=()=>all(root).find(n=>has(n,'repeat')&&n.dataset?.tipTitle==='Regroup the repeat');
  const click=()=>count().onclick({stopPropagation(){},ctrlKey:false,shiftKey:false});
  const choices=()=>all(root).filter(n=>has(n,'fix-choice')).map(n=>n.textContent);
  click();assert.equal(choices().length,0);
  view.setTool('edit');click();
  assert.deepEqual([...new Set(choices())],['8 bars ×2','Not folded (write out every pass)']);
});

test('Timing: a repeated row with no words yet still has a lane for every pass, in every bar, so a word can be dragged to any pass', () => {
  const {root,view}=mounted(chart());
  view.setTool('timing');
  const bars=byClass(root,'tbar');assert.equal(bars.length,8);
  for(const bar of bars)assert.deepEqual(byClass(bar,'tlane').map(l=>l.dataset.pass),['1','2'],'one lane per pass in bar '+bar.dataset.bar);
  assert.deepEqual(byClass(bars[0],'tlane').map(l=>l.dataset.label),['Pass 1','Pass 2']);
  view.setTool('edit');assert.equal(byClass(root,'tlane').length,0,'the chart as written is unchanged');
});

test('Timing: a line that runs from pass 1 into pass 2 draws each word in the lane of the pass it is sung in', () => {
  const f=chart();
  f.content.sections[0].lyrics='one two three four';
  f.content.layout={...(f.content.layout||{}),bars_per_line:4,breaks:[],bar_overrides:[],lines:[
    {section_id:'s',line:0,start_measure:'m4',end_measure:'m11',words:[{offset:0,measure_id:'m4',beat:0},{offset:14,measure_id:'m11',beat:1}]}]};
  const {root,view}=mounted(f);
  view.setTool('timing');
  const where={};
  for(const lane of byClass(root,'tlane'))for(const chip of byClass(lane,'wchip'))
    where[{0:'one',4:'two',8:'three',14:'four'}[chip.dataset.offset]]=lane.dataset.pass+'@'+(lane.parentNode||lane.parent).dataset.bar;
  assert.equal(where.one,'1@m4');assert.equal(where.four,'2@m3','four is sung in m11, the fourth bar of pass 2');
  const order=['one','two','three','four'].map(w=>{const [p,b]=where[w].split('@');return (Number(p)-1)*8+Number(b.slice(1));});
  assert.deepEqual([...order].sort((a,b)=>a-b),order,'read pass by pass, the words come in the order they are sung: '+JSON.stringify(where));
});

test('Play and Edit: a line that runs from pass 1 into pass 2 is split there, each pass\'s words under its own pass, never drawn over each other', () => {
  const f=chart();
  f.content.sections[0].lyrics='one two three four';
  f.content.layout={...(f.content.layout||{}),bars_per_line:4,breaks:[],bar_overrides:[],lines:[
    {section_id:'s',line:0,start_measure:'m4',end_measure:'m11',words:[{offset:0,measure_id:'m4',beat:0},{offset:14,measure_id:'m11',beat:1}]}]};
  const {root,view}=mounted(f);
  for(const tool of ['play','edit']){
    view.setTool(tool);
    const inPass=n=>byClass(root,'lyr').filter(l=>l.dataset.pass===String(n)).map(l=>l.textContent).join(' ');
    assert.match(inPass(1),/one/,tool);assert.doesNotMatch(inPass(1),/four/,tool+': "four" is sung in pass 2');
    assert.match(inPass(2),/four/,tool);assert.doesNotMatch(inPass(2),/one/,tool);
  }
});
