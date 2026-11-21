// Words sung before their section starts (a pickup): where they can be saved, where each view draws them, and dragging one back into the
// row before.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Node,all,installDom} from './compact-dom.mjs';
import {mountChartPage} from '../chordbuddy/web/chart-page.js';
import {buildChartModel} from '../chordbuddy/web/chart-model.js';
import {placeWord,pickupStart,validatePlacements} from '../chordbuddy/web/chart-layout.js';
import {planSectionEdit} from '../chordbuddy/web/practice-edit.js';

const has=(n,c)=>n.className.split(' ').includes(c);
const byClass=(root,c)=>all(root).filter(n=>has(n,c));
const tick=()=>new Promise(r=>setImmediate(r));

// A Verse (bars 1 to 4, "one two") and a Chorus ("And so on") that follows it.
function chart(){
  const f=JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
  f.content.sections=[{id:'v',name:'Verse',start:0,end:8,lyrics:'one two'},{id:'c',name:'Chorus',start:8,end:32,lyrics:'And so on'}];
  for(const c of f.content.chords)c.section_id=c.start<8?'v':'c';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[
    {section_id:'v',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0},{offset:4,measure_id:'m2',beat:0}]},
    {section_id:'c',line:0,start_measure:'m4',end_measure:'m7',words:[{offset:0,measure_id:'m4',beat:0},{offset:4,measure_id:'m5',beat:0}]},
  ]};
  return f;
}
const measures=f=>f.music.measures;
const wordsOf=(content,id)=>content.layout.lines.find(p=>p.section_id===id).words.map(w=>[w.offset,w.measure_id,w.beat]);
const withPickup=(f,beat=3)=>({...f,content:placeWord(f.content,'c',0,0,'m3',beat,measures(f))});

test('a word may be placed in the bar just before its section, and no earlier', () => {
  const f=chart(),ms=measures(f),chorus=f.content.sections[1];
  assert.equal(pickupStart(ms,chorus),6);                                   // the start of bar 4, the bar before the Chorus
  const next=placeWord(f.content,'c',0,0,'m3',3,ms);
  assert.deepEqual(wordsOf(next,'c')[0],[0,'m3',3]);
  assert.equal(next.layout.lines.find(p=>p.section_id==='c').start_measure,'m3');
  assert.throws(()=>placeWord(f.content,'c',0,0,'m2',3,ms),/inside its section/);
  assert.doesNotThrow(()=>validatePlacements(next,f.music));
});

test('moving the pickup back into the section lets the line start at its own first bar again', () => {
  const f=withPickup(chart()),back=placeWord(f.content,'c',0,0,'m4',0,measures(f));
  assert.equal(back.layout.lines.find(p=>p.section_id==='c').start_measure,'m4');
});

test('line by line: a pickup stays at the start of its own row; true timing draws it where it is sung', () => {
  const f=withPickup(chart());
  const line=buildChartModel(f.content,f.music),sung=buildChartModel(f.content,f.music,{trueTiming:true});
  const rowOf=(model,id)=>model.sections.find(s=>s.id===id).groups[0];
  const and=model=>rowOf(model,'c').lanes.flatMap(l=>l.tokens).find(t=>t.text==='And');
  // line by line: in the Chorus row, at the very start; the Verse row has no extra lane
  assert.equal(and(line).measureId,'m4');assert.equal(and(line).displaySeconds,8);
  assert.equal(rowOf(line,'v').lanes.filter(l=>l.pickup).length,0);
  // true timing: in the Verse row's last bar (bar 4, beat 4), still a word of the Chorus line, with its real time
  assert.equal(and(sung),undefined);
  const lane=rowOf(sung,'v').lanes.find(l=>l.pickup);
  assert.ok(lane);assert.equal(lane.sectionId,'c');
  const token=lane.tokens[0];assert.equal(token.text,'And');assert.equal(token.measureId,'m3');assert.equal(token.seconds,7.5);
  assert.deepEqual([token.sectionId,token.line,token.offset],['c',0,0]);
  // the pickup is "now" only until the next word of its line starts
  assert.ok(lane.span.end<=11);
});

function setup(f){
  installDom();const root=new Node(),commits=[],errors=[];
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async(c,l)=>{commits.push({candidate:c,label:l});},onError:e=>errors.push(e)});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});view.setMode('timing');
  const bars=byClass(root,'tbar');let x=0;
  for(const b of bars){const w=parseFloat(b.style.width),left=x;b.getBoundingClientRect=()=>({left,right:left+w,top:0,bottom:100,width:w,height:100});x+=w;}
  return {root,view,commits,errors,bars};
}
const chipOf=(s,text)=>byClass(s.root,'wchip').find(c=>!has(c,'ghost')&&c.textContent.trim()===text);

test('Timing: a pickup is drawn in the row before, and the Timing view needs no switch to show it', () => {
  const s=setup(withPickup(chart()));
  const lanes=byClass(s.root,'tlane');
  assert.ok(chipOf(s,'And'));assert.equal(chipOf(s,'And').parent.parent.dataset.bar,'m3');     // inside bar 4 of the Verse
});

test('Timing: dragging the first word of a line into the bar before its section saves its true time there', async () => {
  const s=setup(chart());
  const chip=chipOf(s,'And'),bar=s.bars.find(b=>b.dataset.bar==='m3'),r=bar.getBoundingClientRect();
  chip.setPointerCapture=()=>{};chip.releasePointerCapture=()=>{};
  chip.onpointerdown({button:0,pointerId:1,clientX:10,clientY:50,shiftKey:true,preventDefault(){}});
  const x=r.left+r.width*.75;                                               // beat 4 of bar 4 (index 3)
  chip.onpointermove({pointerId:1,clientX:x,clientY:50});chip.onpointerup({pointerId:1,clientX:x,clientY:50});
  await tick();await tick();
  assert.equal(s.errors.length,0);assert.equal(s.commits.length,1);assert.equal(s.commits[0].label,'Move word');
  assert.deepEqual(wordsOf(s.commits[0].candidate,'c')[0],[0,'m3',3]);
  assert.deepEqual(wordsOf(s.commits[0].candidate,'v'),[[0,'m0',0],[4,'m2',0]]);    // the Verse is untouched
});

test('Timing: a word cannot be dragged more than one bar before its section', async () => {
  const s=setup(chart());
  const chip=chipOf(s,'And'),bar=s.bars.find(b=>b.dataset.bar==='m2'),r=bar.getBoundingClientRect();
  chip.setPointerCapture=()=>{};chip.releasePointerCapture=()=>{};
  chip.onpointerdown({button:0,pointerId:1,clientX:10,clientY:50,shiftKey:true,preventDefault(){}});
  chip.onpointermove({pointerId:1,clientX:r.left+r.width*.5,clientY:50});chip.onpointerup({pointerId:1,clientX:r.left+r.width*.5,clientY:50});
  await tick();await tick();
  // it lands on the nearest bar it may use, or nothing is saved: never in bar 3
  for(const c of s.commits)assert.notEqual(wordsOf(c.candidate,'c')[0][1],'m2');
});

test('the Words switch: line by line keeps a pickup under its own row, true timing moves it to the row before, and Timing ignores the switch', () => {
  const f=withPickup(chart());
  const rows=root=>byClass(root,'row'),andIn=row=>all(row).filter(n=>has(n,'w')&&n.textContent.trim()==='And').length;
  installDom();const root=new Node();
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async()=>{},onError:()=>{}});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});
  assert.equal(view.getWordView(),'line');
  let r=rows(root);assert.equal(andIn(r[0]),0);assert.equal(andIn(r[1]),1);       // Verse row, Chorus row
  view.setWordView('true');
  r=rows(root);assert.equal(andIn(r[0]),1);assert.equal(andIn(r[1]),0);
  view.setWordView('line');view.setMode('timing');
  assert.ok(byClass(root,'wchip').some(c=>c.textContent.trim()==='And'&&c.parent.parent.dataset.bar==='m3'));   // Timing: always true timing
  view.setWordView('nonsense');assert.equal(view.getWordView(),'line');
});

test('True timing in the chart: a pickup shares the line of words of its bar (no second, lower line), and empty pickup lines draw nothing', () => {
  const f=withPickup(chart());
  installDom();const root=new Node();
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async()=>{},onError:()=>{}});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});view.setWordView('true');
  const verse=byClass(root,'row')[0],bar=byClass(verse,'bar').find(b=>b.dataset.bar==='m3');
  const slots=byClass(bar,'lyr');
  assert.equal(slots.length,1);assert.equal(slots[0].textContent.trim(),'And');
  for(const other of byClass(verse,'bar').filter(b=>b!==bar))assert.equal(byClass(other,'lyr').length,1);   // one line of words in every bar, none extra
  assert.ok(byClass(verse,'chord').some(c=>has(c,'held')||true));
});

test('line by line: the first words of a line sung in the last bar of the row above are drawn at the start of the row where the line goes on', () => {
  const f=JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
  f.content.sections=[{id:'v',name:'Verse',start:0,end:20,lyrics:'row one\nI find'},{id:'c',name:'Chorus',start:20,end:32,lyrics:'x'}];
  const labels=['A','B','C','D','E','F','G','Am'];f.content.chords.forEach((c,i)=>{c.section_id=c.start<20?'v':'c';if(c.start<20)c.label=labels[i];});
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[
    {section_id:'v',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0},{offset:4,measure_id:'m1',beat:0}]},
    {section_id:'v',line:1,start_measure:'m3',end_measure:'m6',words:[{offset:0,measure_id:'m3',beat:3},{offset:2,measure_id:'m5',beat:0}]}]};
  const rows=model=>model.sections.find(s=>s.id==='v').groups;
  const where=(model,text)=>rows(model).find(g=>g.lanes.some(l=>l.tokens.some(t=>t.text===text)));
  const line=buildChartModel(f.content,f.music),sung=buildChartModel(f.content,f.music,{trueTiming:true});
  assert.equal(where(line,'I').id,'v:4');assert.equal(where(line,'find').id,'v:4');       // line by line: with the rest of its line
  const tokenI=where(line,'I').lanes.flatMap(l=>l.tokens).find(t=>t.text==='I');
  assert.equal(tokenI.measureId,'m4');assert.equal(tokenI.displaySeconds,8);
  assert.equal(where(sung,'I').id,'v:0');                                               // true timing: where it is sung
  assert.equal(tokenI.seconds,where(sung,'I').lanes.flatMap(l=>l.tokens).find(t=>t.text==='I').seconds);   // same real time either way
});

test('True timing in the chart: the first word of the next line of the same section shares the baseline of the words in its bar', () => {
  const f=JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
  f.content.sections=[{id:'v',name:'Verse',start:0,end:20,lyrics:'row one\nI find'},{id:'c',name:'Chorus',start:20,end:32,lyrics:'x'}];
  const labels=['A','B','C','D','E','F','G','Am'];f.content.chords.forEach((c,i)=>{c.section_id=c.start<20?'v':'c';if(c.start<20)c.label=labels[i];});
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[
    {section_id:'v',line:0,start_measure:'m0',end_measure:'m3',words:[{offset:0,measure_id:'m0',beat:0},{offset:4,measure_id:'m1',beat:0}]},
    {section_id:'v',line:1,start_measure:'m3',end_measure:'m6',words:[{offset:0,measure_id:'m3',beat:3},{offset:2,measure_id:'m5',beat:0}]}]};
  installDom();const root=new Node();
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async()=>{},onError:()=>{}});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});view.setWordView('true');
  const row=byClass(root,'row')[0],bar=byClass(row,'bar').find(b=>b.dataset.bar==='m3'),slots=byClass(bar,'lyr');
  assert.equal(slots.length,1);assert.equal(slots[0].textContent.trim(),'I');
  // the bars with words of the first line still show them, on one line each
  const m0=byClass(row,'bar').find(b=>b.dataset.bar==='m0');assert.equal(byClass(m0,'lyr').length,1);assert.match(byClass(m0,'lyr')[0].textContent,/row/);
});

// The Verse's two bars repeat (G C, G C), so its row is folded: it shows bars 1 and 2 once, for both passes. The bar just before the
// Chorus is bar 4, the second pass's copy of the bar shown second.
function foldedChart(){
  const f=chart();
  const labels=['G','C','G','C'];
  f.content.chords=f.content.chords.filter(c=>c.start>=8);
  labels.forEach((label,i)=>f.content.chords.unshift({id:'v'+i,label,start:i*2,end:i*2+2,section_id:'v',line:null,offset:null}));
  f.content.chords.sort((a,b)=>a.start-b.start);
  return f;
}

test('Timing: a pickup can be dragged into the bar before its section when that row is a folded repeat', async () => {
  const s=setup(foldedChart());
  const verse=buildChartModel(foldedChart().content,foldedChart().music,{trueTiming:true}).sections.find(x=>x.id==='v').groups[0];
  assert.equal(verse.passes.length,2,'the Verse row is folded into two passes');
  const shownLast=verse.passes[0].measureIds.at(-1);                       // bar 2 on screen, which stands for bar 4 in pass 2
  const chip=chipOf(s,'And'),bar=s.bars.find(b=>b.dataset.bar===shownLast),r=bar.getBoundingClientRect();
  chip.setPointerCapture=()=>{};chip.releasePointerCapture=()=>{};
  chip.onpointerdown({button:0,pointerId:1,clientX:10,clientY:50,shiftKey:true,preventDefault(){}});
  const x=r.left+r.width*.75;                                               // beat 4
  chip.onpointermove({pointerId:1,clientX:x,clientY:50});chip.onpointerup({pointerId:1,clientX:x,clientY:50});
  await tick();await tick();
  assert.equal(s.errors.length,0);assert.equal(s.commits.length,1);
  assert.deepEqual(wordsOf(s.commits[0].candidate,'c')[0],[0,'m3',3]);     // bar 4 (pass 2), where it is sung, not bar 2 (pass 1)
});

// Two lines in the folded Verse: "one two" in pass 1 (bars 1-2) and "three four" in pass 2 (bars 3-4).
function twoPassChart(){
  const f=foldedChart(),v=f.content.sections[0];
  v.lyrics=['one two','three four'].join(String.fromCharCode(10));
  Object.assign(f.content.layout.lines.find(p=>p.section_id==='v'&&p.line===0),{end_measure:'m1',words:[{offset:0,measure_id:'m0',beat:0},{offset:4,measure_id:'m1',beat:0}]});
  f.content.layout.lines.splice(1,0,{section_id:'v',line:1,start_measure:'m2',end_measure:'m3',words:[{offset:0,measure_id:'m2',beat:0},{offset:6,measure_id:'m3',beat:0}]});
  return f;
}
// each pass's lane gets its own height on screen: pass 1 above, pass 2 below
function placeLanes(s){for(const l of byClass(s.root,'tlane')){const top=l.dataset.pass==='1'?40:70;l.getBoundingClientRect=()=>({left:0,right:0,top,bottom:top+28,width:0,height:28});}}

test('Timing: the first word of pass 2’s line can be dragged onto the end of pass 1, by dropping it in pass 1’s lane', async () => {
  const s=setup(twoPassChart());placeLanes(s);
  const chip=chipOf(s,'three'),bar=s.bars.find(b=>b.dataset.bar==='m1'),r=bar.getBoundingClientRect();
  chip.setPointerCapture=()=>{};chip.releasePointerCapture=()=>{};
  chip.onpointerdown({button:0,pointerId:1,clientX:5,clientY:80,shiftKey:true,preventDefault(){}});
  const x=r.left+r.width*.75;                                               // beat 4 of the bar shown second, in pass 1's lane
  chip.onpointermove({pointerId:1,clientX:x,clientY:50});chip.onpointerup({pointerId:1,clientX:x,clientY:50});
  await tick();await tick();
  assert.equal(s.errors.length,0);assert.equal(s.commits.length,1);
  const saved=s.commits[0].candidate.layout.lines.find(p=>p.section_id==='v'&&p.line===1);
  assert.deepEqual([saved.words[0].measure_id,saved.words[0].beat],['m1',3]);   // bar 2, the end of pass 1 (not bar 4)
});

test('a word of pass 2’s line sung in pass 1 is drawn in pass 1’s lane with true timing, and at the start of its own lane line by line', () => {
  const f=twoPassChart();f.content=placeWord(f.content,'v',1,0,'m1',3,measures(f));
  const verse=model=>model.sections.find(x=>x.id==='v').groups[0];
  const sung=verse(buildChartModel(f.content,f.music,{trueTiming:true})),line=verse(buildChartModel(f.content,f.music));
  const laneOf=(g,text)=>g.lanes.find(l=>l.tokens.some(t=>t.text===text));
  assert.equal(laneOf(sung,'three').passNumber,1);assert.equal(laneOf(sung,'four').passNumber,2);
  assert.equal(laneOf(sung,'three').tokens.find(t=>t.text==='three').measureId,'m1');
  assert.equal(laneOf(line,'three'),laneOf(line,'four'));assert.equal(laneOf(line,'four').passNumber,2);
  assert.equal(laneOf(line,'three').tokens.find(t=>t.text==='three').displaySeconds,0);   // the start of the row
});

test('renaming a section keeps the pickup that the next section’s line sings in its last bar', () => {
  const f=withPickup(chart());
  for(const id of ['v','c']){
    const plan=planSectionEdit(f.content,f.music,{sectionId:id,operation:'edit',fields:{name:id==='v'?'Verse 2':'Big Chorus'}});
    assert.deepEqual(plan.conflicts,[]);assert.ok(plan.candidate);
    assert.deepEqual(wordsOf(plan.candidate,'c')[0],[0,'m3',3]);   // the pickup is still in bar 4
  }
});
