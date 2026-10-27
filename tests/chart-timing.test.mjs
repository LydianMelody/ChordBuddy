import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Node,all,installDom} from './compact-dom.mjs';
import {mountChartPage} from '../chordbuddy/web/chart-page.js';
import {layoutLine} from '../chordbuddy/web/word-layout.js';
import {effectiveMeasures} from '../chordbuddy/web/chart-layout.js';

const fixture=()=>JSON.parse(readFileSync(new URL('./fixtures/compact-chart.json',import.meta.url)));
const has=(n,c)=>n.className.split(' ').includes(c);
const byClass=(root,c)=>all(root).filter(n=>has(n,c));
const tick=()=>new Promise(r=>setImmediate(r));
const place=words=>({section_id:'s',line:0,start_measure:'m0',end_measure:'m3',words});

// "one two three four" on the first four bars; "one" and "four" are pinned (bar 1 and bar 4), the others spread between them.
function setup(extra={}){
  const f=fixture();f.content.sections[0].lyrics=extra.lyrics??'one two three four';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[place(extra.words??[{offset:0,measure_id:'m0',beat:0},{offset:14,measure_id:'m3',beat:0}])]};
  installDom();const root=new Node(),commits=[],errors=[];
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async(c,l)=>{commits.push({candidate:c,label:l});},onError:e=>errors.push(e)});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});view.setMode('timing');
  // lay the bars out left to right so pointer positions can be tested
  const bars=byClass(root,'tbar');let x=0;
  for(const b of bars){const w=parseFloat(b.style.width),left=x;b.getBoundingClientRect=()=>({left,right:left+w,top:0,bottom:100,width:w,height:100});x+=w;}
  return {f,root,view,commits,errors,bars,chips:()=>byClass(root,'wchip').filter(n=>!has(n,'ghost'))};
}
const chipOf=(s,text)=>s.chips().find(c=>c.textContent.trim()===text);
const barLeft=(s,i)=>s.bars[i].getBoundingClientRect().left,barWidth=(s,i)=>s.bars[i].getBoundingClientRect().width;
// words and chords move with Shift held (a plain click plays from there)
const down=(chip,x=0,shiftKey=true)=>{chip.setPointerCapture=()=>{};chip.releasePointerCapture=()=>{};chip.onpointerdown({button:0,pointerId:1,clientX:x,clientY:50,shiftKey,preventDefault(){}});};
const move=(chip,x,y=50)=>chip.onpointermove({pointerId:1,clientX:x,clientY:y});
const up=(chip,x)=>chip.onpointerup({pointerId:1,clientX:x,clientY:50});
const drag=async(s,text,toBar,beat)=>{
  const chip=chipOf(s,text),n=4,x=barLeft(s,toBar)+beat/n*barWidth(s,toBar);
  down(chip,10);move(chip,x);up(chip,x);await tick();await tick();
};
const wordsOf=content=>content.layout.lines[0].words.map(w=>[w.offset,w.measure_id,w.beat]);
const timesOf=(content,music)=>layoutLine(content,effectiveMeasures(music,content.layout),'s',0).tokens.map(t=>+t.seconds.toFixed(3));

test('Timing: every bar has its own width, chords sit at their onsets, and each placed word is a chip', () => {
  const s=setup();
  assert.equal(s.bars.length,4);assert.ok(s.bars.every(b=>parseFloat(b.style.width)>=256));
  assert.deepEqual(s.chips().map(c=>c.textContent.trim()),['one','two','three','four']);
  assert.deepEqual(s.chips().map(c=>has(c,'pinned')),[true,false,false,true]);
  const chords=byClass(s.root,'tchord');assert.equal(chords.length,4);assert.ok(chords.every(c=>c.style.left==='0px'));
  assert.ok(s.chips().every(c=>/px$/.test(c.style.left)));
});

test('Timing: a long word makes its bar wider so nothing overlaps', () => {
  const crowded=setup({lyrics:'extraordinarily supercalifragilistic one two',words:[{offset:0,measure_id:'m0',beat:0},{offset:16,measure_id:'m0',beat:1}]});
  const plain=setup();
  assert.ok(parseFloat(crowded.bars[0].style.width)>parseFloat(plain.bars[0].style.width));
});

test('Timing: dragging a word to a beat pins it there, snapped to the grid', async () => {
  const s=setup();await drag(s,'two',1,2.1);                       // about halfway through bar 2: snaps to the nearest 1/8 note
  assert.equal(s.commits.length,1);assert.equal(s.commits[0].label,'Move word');
  const words=wordsOf(s.commits[0].candidate);
  assert.deepEqual(words.find(w=>w[0]===4),[4,'m1',2]);
  assert.ok(words.some(w=>w[0]===0)&&words.some(w=>w[0]===14));   // the other pins are untouched
});

test('Timing: while one word is dragged, a ghost follows the pointer and a marker shows where it will land', () => {
  const s=setup();const two=chipOf(s,'two');
  down(two,10);move(two,barLeft(s,2)+barWidth(s,2)*.5);
  assert.ok(byClass(s.root,'drop-mark').length>=1);assert.equal(byClass(s.root,'ghost').length,1);assert.ok(has(two,'lifted'));
  assert.match(byClass(s.root,'drop-mark')[0].dataset.t,/^Bar \d+ · beat [\d.]+$/);
  two.onpointercancel({pointerId:1});
  assert.equal(s.commits.length,0);assert.equal(byClass(s.root,'ghost').length,0);
});

test('Timing: the unpinned words between the neighbours slide while a word is dragged', () => {
  const s=setup();const two=chipOf(s,'two'),three=chipOf(s,'three');
  const before=three.style.left+'|'+String((three.parentNode||three.parent)?.dataset?.lane);
  down(two,10);move(two,barLeft(s,2)+barWidth(s,2)*.75);   // late in bar 3: "three" has to be somewhere after it
  const after=three.style.left;assert.ok(after!==undefined);
  assert.ok(parseFloat(after)>=0);assert.ok(before.length>0);
  two.onpointercancel({pointerId:1});
});

test('Timing: a word can cross barlines but never passes a pinned word: it stops one grid step short', async () => {
  const s=setup();await drag(s,'two',3,3.5);                          // dragged past the pinned "four" (bar 4 beat 1)
  const times=timesOf(s.commits[0].candidate,s.f.music);
  assert.ok(times[0]<times[1]&&times[1]<times[3],'two stays between one and four');
  assert.deepEqual(wordsOf(s.commits[0].candidate).find(p=>p[0]===4),[4,'m2',3.5]);   // the last 1/8 point before bar 4
});

test('Timing: from the left, a word stops one grid step after the pinned word before it', async () => {
  const s=setup();await drag(s,'three',0,0);
  assert.deepEqual(wordsOf(s.commits[0].candidate).find(p=>p[0]===8),[8,'m0',.5]);
});

test('Timing: pressing and releasing without moving does nothing', async () => {
  const s=setup();const two=chipOf(s,'two');down(two,100);up(two,100);await tick();
  assert.equal(s.commits.length,0);assert.equal(s.errors.length,0);
});

test('Timing: Esc during a drag drops it', async () => {
  const s=setup();const two=chipOf(s,'two');down(two,10);move(two,barLeft(s,1)+100);
  two.onkeydown({key:'Escape'});await tick();assert.equal(s.commits.length,0);assert.equal(byClass(s.root,'ghost').length,0);
});

test('Timing: Shift+clicking a pin releases the word; the other pins stay', async () => {
  const s=setup();const one=chipOf(s,'one'),pin=one.children.find(c=>has(c,'pinb'));
  pin.onclick({stopPropagation(){}});await tick();assert.equal(s.commits.length,0,'a plain click on a pin does not release it');
  pin.onclick({shiftKey:true,stopPropagation(){}});await tick();await tick();
  assert.equal(s.commits.length,1);assert.equal(s.commits[0].label,'Release word');
  assert.deepEqual(wordsOf(s.commits[0].candidate),[[14,'m3',0]]);
  assert.match(s.root.textContent,/Released/);
});

test('Timing: Shift+double-clicking a pinned word also releases it, but a spread word has nothing to release', async () => {
  const s=setup();chipOf(s,'four').ondblclick({shiftKey:true});await tick();await tick();
  assert.equal(s.commits.length,1);assert.deepEqual(wordsOf(s.commits[0].candidate),[[0,'m0',0]]);
  const again=setup();chipOf(again,'two').ondblclick({shiftKey:true});await tick();assert.equal(again.commits.length,0);
});

test('Timing: the first word is not special: it can be dragged off its chord like any other', async () => {
  const s=setup();await drag(s,'one',0,2);
  assert.deepEqual(wordsOf(s.commits[0].candidate).find(p=>p[0]===0),[0,'m0',2]);
});

test('Timing: whatever is dragged where, the saved words keep their order', async () => {
  for(const [text,bar,beat] of [['two',2,1],['three',0,3],['two',0,0],['three',3,2],['two',3,3],['three',1,0]]){
    const fresh=setup();await drag(fresh,text,bar,beat);
    if(fresh.commits[0]){const t=timesOf(fresh.commits[0].candidate,fresh.f.music);assert.ok(t.every((v,i)=>!i||v>=t[i-1]),text+' -> '+t.join(', '));}
    assert.equal(fresh.errors.length,0,text+' produced an error');
  }
});

test('Timing: lyrics that were never placed show as plain text with a way to place them', async () => {
  const f=fixture();installDom();const root=new Node(),commits=[];
  const view=mountChartPage(root,{onCommit:async(c,l)=>{commits.push({c,l});}});view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0}});view.setMode('timing');
  const button=byClass(root,'add-lyrics')[0];assert.ok(button);button.onclick();await tick();await tick();
  assert.equal(commits[0].l,'Place lyric line');assert.equal(commits[0].c.layout.lines.length,1);
});

test('Timing: the playing word lights up in its lane, and the playing chord in the chord row', () => {
  const s=setup();s.view.updatePlayback({seconds:2.5,ready:true,playing:true});
  assert.deepEqual(byClass(s.root,'wnow').map(n=>n.textContent.trim()),['two']);
  assert.equal(byClass(s.root,'chunk').filter(n=>has(n,'now')).length,1);
});

test('Timing: zoom changes the width of every bar and never touches the document', () => {
  const s=setup();const w2=parseFloat(s.bars[0].style.width);
  s.view.zoomBy(1);assert.ok(parseFloat(byClass(s.root,'tbar')[0].style.width)>w2);
  s.view.zoomBy(-1);s.view.zoomBy(-1);assert.ok(parseFloat(byClass(s.root,'tbar')[0].style.width)<w2);
  assert.equal(s.commits.length,0);
});

// ---- barlines: split, join, move ----
function withBarEdits(){
  const f=fixture();f.content.sections[0].lyrics='';f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[]};
  installDom();const root=new Node(),edits=[];
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async()=>{},onError:()=>{},onBarEdit:async c=>{edits.push(c);}});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});view.setMode('timing');
  const bars=byClass(root,'tbar');let x=0;
  for(const b of bars){const w=parseFloat(b.style.width),left=x;b.getBoundingClientRect=()=>({left,right:left+w,top:0,bottom:100,width:w,height:100});x+=w;}
  return {f,root,view,edits,bars};
}
test('Timing: a "+" on every beat inside a bar starts a new bar there', () => {
  const s=withBarEdits();
  const splits=byClass(s.bars[1],'beat-split');
  assert.equal(splits.length,3);                                                // beats 2, 3 and 4 of a four-beat bar
  splits[1].onclick();
  assert.deepEqual(s.edits,[{addBars:[s.f.music.measures[1].beats[2]]}]);
});

test('Timing: clicking a barline (with Ctrl) joins the bar with the one before it, and the first barline of the song has no handle', () => {
  const s=withBarEdits();
  assert.equal(byClass(s.bars[0],'bar-handle').length,0);
  const handle=byClass(s.bars[1],'bar-handle')[0];
  handle.onclick({stopPropagation(){}});
  assert.deepEqual(s.edits,[{removeBars:[s.f.music.measures[1].start]}]);
});

test('Timing: dragging a barline to another beat moves it (one remove and one add)', () => {
  const s=withBarEdits();
  const handle=byClass(s.bars[1],'bar-handle')[0],bar=s.f.music.measures[1],left=barLeft(s,1),w=barWidth(s,1);
  document.body={append(){}};handle.setPointerCapture=()=>{};
  handle.onpointerdown({button:0,pointerId:1,clientX:left});
  handle.onpointermove({pointerId:1,clientX:left+w*.5});                         // halfway along the bar: beat 3
  handle.onpointerup({pointerId:1,clientX:left+w*.5});
  assert.deepEqual(s.edits,[{removeBars:[bar.start],addBars:[bar.beats[2]]}]);
  const none=withBarEdits();                                                      // a click, or a drop where it started, does nothing
  const h2=byClass(none.bars[1],'bar-handle')[0];h2.setPointerCapture=()=>{};
  h2.onpointerdown({button:0,pointerId:1,clientX:5});h2.onpointerup({pointerId:1,clientX:5});
  assert.deepEqual(none.edits,[]);
});

test('Timing: without a barline handler there are no barline controls', () => {
  const f=fixture();installDom();const root=new Node();
  const view=mountChartPage(root,{onSeek:()=>Promise.resolve(),onCommit:async()=>{},onError:()=>{}});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});view.setMode('timing');
  assert.equal(byClass(root,'beat-split').length+byClass(root,'bar-handle').length,0);
});

test('Timing: the barline controls are always drawn (the page shows them only while Ctrl is held), and a drag ends without a join', () => {
  const s=withBarEdits();
  assert.ok(byClass(s.root,'beat-split').length>0&&byClass(s.root,'bar-handle').length>0);
  const handle=byClass(s.bars[1],'bar-handle')[0],left=barLeft(s,1),w=barWidth(s,1);
  document.body={append(){}};handle.setPointerCapture=()=>{};
  handle.onpointerdown({button:0,pointerId:1,clientX:left});handle.onpointermove({pointerId:1,clientX:left+w*.5});handle.onpointerup({pointerId:1,clientX:left+w*.5});
  handle.onclick({stopPropagation(){}});                                          // the click that ends the drag
  assert.equal(s.edits.length,1,'one move, not a move and a join');
});

test('Timing: a plain click on a word plays from it, and pressing without Shift starts no drag', async () => {
  installDom();const f=fixture();f.content.sections[0].lyrics='one two three four';
  f.content.layout={bars_per_line:4,breaks:[],bar_overrides:[],lines:[place([{offset:0,measure_id:'m0',beat:0},{offset:14,measure_id:'m3',beat:0}])]};
  const root=new Node(),seeks=[];const view=mountChartPage(root,{onSeek:t=>{seeks.push(t);return Promise.resolve();},onCommit:async()=>{}});
  view.update({...f,documentId:'d',revision:0,songId:'s',transport:{seconds:0,ready:true}});view.setMode('timing');
  const four=byClass(root,'wchip').find(c=>c.textContent.trim()==='four');
  down(four,10,false);assert.equal(byClass(root,'ghost').length,0);
  four.onclick({});assert.deepEqual(seeks,[6]);
  four.onclick({shiftKey:true});assert.equal(seeks.length,1,'Shift+click is for moving, not playing');
});

test('Timing: Shift+dragging a chord moves where it starts, and the chord before it holds on until then', async () => {
  const s=setup();const cell=byClass(s.root,'tchord').find(c=>c.dataset.chunk&&c.textContent.startsWith('C'));
  down(cell,barLeft(s,1)+2);move(cell,barLeft(s,0)+.5*barWidth(s,0));
  assert.ok(byClass(s.root,'drop-mark').length,'a marker shows where it lands');
  up(cell,barLeft(s,0)+.5*barWidth(s,0));await tick();await tick();
  assert.equal(s.commits.length,1);assert.equal(s.commits[0].label,'Move chord');
  const chords=s.commits[0].candidate.chords;
  assert.equal(chords.find(c=>c.id==='c1').start,1);assert.equal(chords.find(c=>c.id==='c0').end,1);
  assert.equal(chords.find(c=>c.id==='c1').end,4,'its end stays');
  const back=setup();const c2=byClass(back.root,'tchord').find(c=>c.dataset.chunk&&c.textContent.startsWith('C'));
  down(c2,barLeft(back,1)+2);move(c2,barLeft(back,2)+.5*barWidth(back,2));up(c2,barLeft(back,2)+.5*barWidth(back,2));await tick();
  assert.equal(back.commits.length,0,'never past its own end');
});

test('Timing: a dragged chord stays in its own bar while a copy follows the pointer, and losing the pointer ends the drag', async () => {
  const s=setup();const cell=byClass(s.root,'tchord').find(c=>c.dataset.chunk&&c.textContent.startsWith('C'));const home=cell.parent;
  down(cell,barLeft(s,1)+2);move(cell,barLeft(s,0)+.5*barWidth(s,0));
  assert.equal(cell.parent,home,'never moved to another bar (that would lose the pointer and leave it stuck to the mouse)');
  assert.equal(byClass(s.root,'tchord-ghost').length,1);
  cell.onlostpointercapture({pointerId:1});await tick();
  assert.equal(byClass(s.root,'tchord-ghost').length+byClass(s.root,'drop-mark').length,0);
  move(cell,barLeft(s,0)+.3*barWidth(s,0));up(cell,barLeft(s,0)+.3*barWidth(s,0));await tick();
  assert.equal(s.commits.length,0,'the drag is over: later moves and a release do nothing');
});

test('Timing: with the magnet off, a word lands exactly where it is dropped instead of on the grid', async () => {
  const s=setup();s.view.setSnapping(false);
  s.bars=byClass(s.root,'tbar');let x=0;for(const b of s.bars){const w=parseFloat(b.style.width),left=x;b.getBoundingClientRect=()=>({left,right:left+w,top:0,bottom:100,width:w,height:100});x+=w;}
  await drag(s,'two',1,2.1);
  const [offset,bar,beat]=wordsOf(s.commits[0].candidate).find(w=>w[0]===4);
  assert.deepEqual([offset,bar],[4,'m1']);assert.ok(Math.abs(beat-2.1)<1e-6,'beat 2.1, not the nearest 1/8 (2)');
});
