// The end of the chart: a final barline after the last bar, which the Edit tool can drag onto another barline. Only what the chart shows
// changes (layout.chart_end): chords, words and the recording stay as they are, and the bars after the end come back when it is moved out.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {all,installDom,Node} from './compact-dom.mjs';
import {mountChartPage} from '../chordbuddy/web/chart-page.js';
import {buildChartModel} from '../chordbuddy/web/chart-model.js';
import {chartPresentation} from '../chordbuddy/web/chart-presentation.js';
import {planPageEdit} from '../chordbuddy/web/chart-edits.js';
import {effectiveMeasures} from '../chordbuddy/web/chart-layout.js';

// 16 bars (m0 to m15, of 1 to 3 s: m8 is 20-21 s, m9 21-22 s, m12 24-26 s, m13 26-28 s) in one section, one chord on each bar, all different (so nothing folds into a repeat)
const LABELS=['A','Bm','C','D','E','F','G','Am','Dm','Em','F#m','Bb','Eb','Ab','Db','Gb'];
const chart=()=>{
  const f=JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
  f.content.chords=f.music.measures.map((m,i)=>({id:'c'+i,label:LABELS[i],start:m.start,end:m.end,section_id:'s',line:null,offset:null}));
  return f;
};
const has=(n,c)=>String(n.className||'').split(' ').includes(c);
const byClass=(root,c)=>all(root).filter(n=>has(n,c));
const shownBars=model=>model.sections.flatMap(s=>s.groups.flatMap(g=>g.bars)).filter(b=>!b.pastEnd).map(b=>b.id);
const tick=()=>new Promise(r=>setImmediate(r));

test('the chart ends at the barline nearest its saved end, earlier or later than where the sound fades out', () => {
  const f=chart(),ms=effectiveMeasures(f.music,{});
  assert.equal(chartPresentation(f.content,ms).end,32);
  assert.equal(chartPresentation(f.content,ms,null,null,{chartEnd:27.9}).end,28);           // the barline after bar 14
  f.content.layout={chart_end:26};
  assert.equal(buildChartModel(f.content,f.music).chartEnd,26);
  assert.equal(shownBars(buildChartModel(f.content,f.music)).at(-1),'m12');
  // a fade-out found at 20.5 s would end it after m8 (21 s), but the saved end wins
  assert.equal(chartPresentation(f.content,ms,null,20.5).end,26);
  delete f.content.layout.chart_end;
  assert.equal(chartPresentation(f.content,ms,null,20.5).end,21);
});

test('a bar with a word sung in it is never left out by the end', () => {
  const f=chart();
  f.content.sections[0].lyrics='late';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],chart_end:20,lines:[{section_id:'s',line:0,start_measure:'m12',end_measure:'m12',words:[{offset:0,measure_id:'m12',beat:1}]}]};
  const end=chartPresentation(f.content,effectiveMeasures(f.music,f.content.layout)).end;
  assert.ok(end>24.5&&end<26,'the end goes on to the word in bar 13');
});

test('moving the end saves only that time, and null takes it away again', () => {
  const f=chart(),plan=planPageEdit.endChartAt({content:f.content,seconds:26.0004});
  assert.equal(plan.candidate.layout.chart_end,26);assert.equal(plan.label,'Move the end of the chart');
  assert.deepEqual(plan.candidate.chords,f.content.chords);
  assert.equal('chart_end' in planPageEdit.endChartAt({content:plan.candidate,seconds:null}).candidate.layout,false);
  assert.throws(()=>planPageEdit.endChartAt({content:f.content,seconds:NaN}),/barline/);
});

function mount(f){
  installDom();const root=new Node(),commits=[],errors=[];
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async(c,l)=>{commits.push({candidate:c,label:l});},onError:e=>errors.push(e),onBarEdit:()=>{}});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});
  return {root,view,commits,errors};
}
// bars laid out left to right, 100 px each, all in one row
const placeBars=root=>{byClass(root,'bar').forEach((b,i)=>{b.getBoundingClientRect=()=>({left:i*100,right:i*100+100,top:0,bottom:40,width:100,height:40});});};

test('the last bar has the end cap in every tool; the Edit tool also shows a few faded bars past the end', () => {
  const f=chart();f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[],chart_end:24};
  const m=mount(f);
  let bars=byClass(m.root,'bar');
  assert.equal(byClass(m.root,'end-cap').length,1);
  assert.equal(bars.at(-1).dataset.bar,'m11');assert.ok(has(bars.at(-1),'final'));
  assert.equal(byClass(m.root,'past-end').length,0);
  m.view.setTool('edit');
  bars=byClass(m.root,'bar');
  assert.deepEqual(byClass(m.root,'past-end').map(b=>b.dataset.bar),['m12','m13','m14','m15']);
  assert.ok(has(bars.find(b=>b.dataset.bar==='m11'),'final'));
  assert.equal(byClass(m.root,'end-cap').length,1);
  m.view.setTool('play');
  assert.equal(byClass(m.root,'past-end').length,0);
});

test('Edit tool: dragging the end cap onto an earlier barline ends the chart there; onto a faded bar brings bars back', async () => {
  const f=chart();f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[],chart_end:24};
  const m=mount(f);m.view.setTool('edit');placeBars(m.root);
  const drag=(x)=>{
    const cap=byClass(m.root,'end-cap')[0];cap.setPointerCapture=()=>{};cap.releasePointerCapture=()=>{};
    cap.onpointerdown({button:0,pointerId:1,clientX:1200,clientY:20,preventDefault(){},stopPropagation(){}});
    cap.onpointermove({pointerId:1,clientX:x,clientY:20});
    cap.onpointerup({pointerId:1,clientX:x,clientY:20});
  };
  const bars=byClass(m.root,'bar'),at=id=>bars.findIndex(b=>b.dataset.bar===id);
  drag(at('m9')*100+96);await tick();                         // the barline after m9, at 22 s
  assert.equal(m.errors.length,0);assert.equal(m.commits.length,1);
  assert.equal(m.commits[0].candidate.layout.chart_end,22);
  drag(at('m13')*100+98);await tick();                        // out over the faded bars: m13 ends at 28 s
  assert.equal(m.commits.at(-1).candidate.layout.chart_end,28);
});

test('Play tool: the end cap is only a barline, and a drag on it does nothing', async () => {
  const f=chart();f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[],chart_end:24};
  const m=mount(f);placeBars(m.root);
  const cap=byClass(m.root,'end-cap')[0];cap.setPointerCapture=()=>{};
  cap.onpointerdown({button:0,pointerId:1,clientX:1200,clientY:20,preventDefault(){},stopPropagation(){}});
  cap.onpointermove({pointerId:1,clientX:500,clientY:20});cap.onpointerup({pointerId:1,clientX:500,clientY:20});
  await tick();
  assert.equal(m.commits.length,0);
});
