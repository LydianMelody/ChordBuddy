import test from 'node:test';import assert from 'node:assert/strict';import {updateViewport,mountPracticeTimeline,rulerMarks} from '../chordbuddy/web/practice-timeline.js';
const context={start:0,end:100,playhead:15,selectedSeconds:null,minSpan:1};
test('zoom anchor, manual pan, each fixed opposite edge, and Follow are presentation only',()=>{
 const base={start:10,end:30,follow:true},copy=JSON.stringify(base);
 assert.deepEqual(updateViewport(base,{type:'zoom',factor:.5},context),{start:12.5,end:22.5,follow:true});
 assert.deepEqual(updateViewport(base,{type:'pan',delta:20},context),{start:30,end:50,follow:false});
 assert.deepEqual(updateViewport(base,{type:'resize-start',seconds:14},context),{start:14,end:30,follow:false});
 assert.deepEqual(updateViewport(base,{type:'resize-end',seconds:25},context),{start:10,end:25,follow:false});
 assert.deepEqual(updateViewport(base,{type:'zoom',factor:.5},{...context,selectedSeconds:25}),{start:17.5,end:27.5,follow:true});
 assert.equal(JSON.stringify(base),copy);assert.equal(context.playhead,15);
 const away=updateViewport(base,{type:'pan',delta:60},context);const followed=updateViewport(away,{type:'follow'},context);
 assert.equal(followed.follow,true);assert.ok(followed.start<=15&&followed.end>=15);
});
test('zoom clamps bounds; invisible playhead falls back to centre',()=>{
 assert.deepEqual(updateViewport({start:20,end:40,follow:false},{type:'zoom',factor:.5},context),{start:25,end:35,follow:false});
 const r=updateViewport({start:0,end:100,follow:true},{type:'pan',delta:300},context);assert.equal(r.start,0);assert.equal(r.end,100);
});

// Synthetic DOM semantics only; this does not verify native range rendering or pointer capture.
import {installDom,Node,all} from './compact-dom.mjs';
test('offscreen current time is explicit and overview interactions never seek',()=>{
 installDom();const root=new Node(),seeks=[],actions=[];let snapshot={seconds:65,duration:100,ready:true},paint;
 const transport={getSnapshot:()=>snapshot,seek:t=>{seeks.push(t);return Promise.resolve();},subscribe:f=>{paint=f;return()=>{};}};
 const mounted=mountPracticeTimeline(root,{transport,onViewportChange:a=>actions.push(a)});
 const music={measures:[{id:'a',number:1,start:0,end:100,beats:[0,25,50,75],quarter_positions:[0,1,2,3,4],meter:'4/4'}]};
 mounted.update({music,projection:null,viewport:{start:10,end:30,follow:false}});
 const seek=root.querySelector('.practice-seek'),navigator=mounted.navigator;
 assert.match(seek.className,/outside/);assert.match(seek.getAttribute('aria-valuetext'),/outside the visible span/);
 assert.match(root.querySelector('.practice-position').textContent,/outside visible span/);
 assert.equal(root.querySelector('.practice-playhead').hidden,true);
 navigator.gesture.start('move',10,100);navigator.gesture.move(20);navigator.gesture.end();
 assert.deepEqual(actions,[{type:'pan-to',start:20,end:40}]);assert.deepEqual(seeks,[]);
 snapshot={...snapshot,seconds:20};paint(snapshot);assert.doesNotMatch(seek.className,/outside/);assert.doesNotMatch(root.querySelector('.practice-position').textContent,/outside visible span/);
 seek.value=22;seek.onchange();assert.deepEqual(seeks,[22]);mounted.dispose();
});

test('one scrubber aligns genuine section blocks and waveform with one shared playhead',()=>{
 installDom();const root=new Node(),seeks=[];const transport={getSnapshot:()=>({seconds:12,duration:100,ready:true}),seek:t=>{seeks.push(t);return Promise.resolve();},subscribe:()=>()=>{}};
 const mounted=mountPracticeTimeline(root,{transport,onViewportChange:()=>{}});
 mounted.update({music:{measures:[]},viewport:{start:0,end:100,follow:false},projection:{mappingKey:'sections',sections:[{id:'a',name:'Chorus',start:0,end:20},{id:'b',name:'Interlude',start:20,end:30},{id:'c',name:'Chorus',start:30,end:100}]}});
 assert.equal(all(root).filter(n=>n.className.split(' ').includes('practice-scrubber')).length,1);
 assert.equal(all(root).filter(n=>n.className.split(' ').includes('practice-playhead')).length,1);
 assert.equal(root.querySelector('.practice-seek-strip'),null);
 assert.equal(root.querySelector('.practice-overview-playhead'),null);
 const blocks=all(root).filter(n=>n.className.split(' ').includes('practice-section-block'));
 assert.deepEqual(blocks.map(n=>n.textContent),['Chorus','Interlude','Chorus']);assert.deepEqual(blocks.map(n=>n.style.width),['20%','10%','70%']);
 blocks[2].onclick();assert.deepEqual(seeks,[30]);assert.ok(!root.textContent.includes('(x'));
});

test('dragging the playhead grip scrubs using the exact visible axis, commits once and cancels without seek',()=>{
 installDom();const root=new Node(),seeks=[];const transport={getSnapshot:()=>({seconds:12,duration:100,ready:true}),seek:t=>{seeks.push(t);return Promise.resolve();},subscribe:()=>()=>{}};const mounted=mountPracticeTimeline(root,{transport,onViewportChange:()=>{}});mounted.update({music:{measures:[]},projection:null,viewport:{start:10,end:30}});const input=root.querySelector('.practice-seek'),grip=root.querySelector('.practice-playhead-grip');grip.setPointerCapture=()=>{};grip.releasePointerCapture=()=>{};input.getBoundingClientRect=()=>({left:100,width:200});input.setPointerCapture=()=>{};input.releasePointerCapture=()=>{};const event=x=>({button:0,pointerId:1,clientX:x,preventDefault(){}});grip.onpointerdown(event(150));assert.equal(Number(input.value),15);assert.deepEqual(seeks,[]);grip.onpointermove(event(275));assert.equal(Number(input.value),27.5);grip.onpointerup(event(300));assert.deepEqual(seeks,[30]);grip.onpointerdown(event(100));grip.onpointercancel(event(100));assert.deepEqual(seeks,[30]);mounted.dispose();
});

test('a playing Follow update cannot move the axis beneath an active playhead scrub',()=>{
 installDom();const root=new Node(),seeks=[];const transport={getSnapshot:()=>({seconds:29,duration:100,ready:true,playIntent:true}),seek:t=>{seeks.push(t);return Promise.resolve();},subscribe:()=>()=>{}};const mounted=mountPracticeTimeline(root,{transport,onViewportChange:()=>{}}),data={music:{measures:[]},projection:null,viewport:{start:10,end:30}};mounted.update(data);const input=root.querySelector('.practice-seek'),grip=root.querySelector('.practice-playhead-grip');grip.setPointerCapture=()=>{};grip.releasePointerCapture=()=>{};input.getBoundingClientRect=()=>({left:0,width:200});input.setPointerCapture=()=>{};input.releasePointerCapture=()=>{};const e={button:0,pointerId:1,clientX:100,preventDefault(){}};grip.onpointerdown(e);mounted.update({...data,viewport:{start:30,end:50}});assert.equal(Number(input.min),10);assert.equal(Number(input.max),30);grip.onpointermove(e);assert.equal(Number(input.value),20);grip.onpointerup(e);assert.deepEqual(seeks,[20]);assert.equal(Number(input.min),30);assert.equal(Number(input.max),50);mounted.dispose();
});


// ---- Navigation bar: loop ranges, pan/zoom controls, follow ----
const bars=[0,1,2,3,4,5,6,7].map(i=>({id:'m'+i,number:i+1,start:i*2,end:i*2+2,beats:[0,.5,1,1.5].map(b=>i*2+b),quarter_positions:[0,1,2,3,4],meter:[4,4]}));
function nav({playIntent=false,duration=16,viewport={start:0,end:16,follow:true},loopState}={}){
 installDom();const root=new Node(),seeks=[],loops=[],actions=[];
 const transport={getSnapshot:()=>({seconds:5,duration,ready:true,playIntent,loop:loopState||{enabled:false,start:null,end:null}}),seek:t=>{seeks.push(t);return Promise.resolve();},setLoop:(v,o)=>{loops.push([v,o]);return Promise.resolve();},subscribe:()=>()=>{}};
 const mounted=mountPracticeTimeline(root,{transport,onViewportChange:a=>actions.push(a)});
 mounted.update({music:{measures:bars},viewport,projection:{sections:[{id:'a',name:'Verse',start:0,end:8},{id:'b',name:'Chorus',start:8,end:16}]}});
 const seek=root.querySelector('.practice-seek');seek.getBoundingClientRect=()=>({left:0,width:160});seek.setPointerCapture=()=>{};seek.releasePointerCapture=()=>{};
 const e=(x,id=1)=>({button:0,pointerId:id,clientX:x,preventDefault(){}});
 return {root,seek,seeks,loops,actions,e,mounted};
}
const pick=(root,cls)=>all(root).filter(n=>n.className.split(' ').includes(cls));

test('a click on the lane seeks to that exact time and sets no loop',()=>{
 const {seek,seeks,loops,e}=nav();seek.onpointerdown(e(52));seek.onpointermove(e(53));seek.onpointerup(e(53));
 assert.equal(seeks.length,1);assert.ok(Math.abs(seeks[0]-5.2)<1e-9);assert.deepEqual(loops,[]);
});

test('dragging on the lane selects a loop snapped to bars, while paused it does not move playback',()=>{
 const {seek,seeks,loops,e}=nav();seek.onpointerdown(e(30));seek.onpointermove(e(95));seek.onpointerup(e(95));
 assert.deepEqual(loops,[[{enabled:true,start:2,end:10},{seekTo:undefined}]]);assert.deepEqual(seeks,[]);
});

test('dragging the other way gives the same loop, and while playing playback moves to the loop start',()=>{
 const {seek,loops,e}=nav({playIntent:true});seek.onpointerdown(e(95));seek.onpointermove(e(30));seek.onpointerup(e(30));
 assert.deepEqual(loops,[[{enabled:true,start:2,end:10},{seekTo:2}]]);
});

test('zoomed in far enough, the same drag snaps to beats',()=>{
 const {seek,loops,e}=nav({viewport:{start:0,end:4,follow:false}});seek.getBoundingClientRect=()=>({left:0,width:400});
 seek.onpointerdown(e(130));seek.onpointermove(e(250));seek.onpointerup(e(250));
 assert.deepEqual(loops[0][0],{enabled:true,start:1.5,end:2.5});
});

test('a cancelled loop drag changes nothing and the lane axis is released',()=>{
 const {seek,loops,seeks,e}=nav();seek.onpointerdown(e(30));seek.onpointermove(e(95));seek.onpointercancel(e(95));
 assert.deepEqual(loops,[]);assert.deepEqual(seeks,[]);
});

test('double-clicking a section block loops that section (and a single click only seeks)',()=>{
 const {root,seeks,loops}=nav({playIntent:true});const [verse,chorus]=pick(root,'practice-section-block');
 chorus.onclick();assert.deepEqual(seeks,[8]);chorus.ondblclick();
 assert.deepEqual(loops,[[{enabled:true,start:8,end:16},{seekTo:8}]]);assert.equal(verse.textContent,'Verse');
});

test('an existing loop shows its range and bar label, and the clear button removes it',()=>{
 const {root,loops}=nav({loopState:{enabled:true,start:4,end:8}});
 const loop=pick(root,'practice-loop')[0];assert.equal(loop.style.left,'25%');assert.equal(loop.style.width,'25%');
 assert.match(root.querySelector('.practice-loop-text').textContent,/Bars 3–4/);assert.match(loop.className,/show/);
 root.querySelector('.practice-loop-clear').onclick();assert.deepEqual(loops,[[null,undefined]]);
});

test('a loop that is off is not drawn at all',()=>{
 const {root}=nav({loopState:{enabled:false,start:4,end:8}});
 assert.doesNotMatch(pick(root,'practice-loop')[0].className,/\bshow\b/);assert.equal(pick(root,'practice-overview-loop')[0].style.display,'none');
 const on=nav({loopState:{enabled:true,start:4,end:8}});assert.match(pick(on.root,'practice-loop')[0].className,/\bshow\b/);
});

test('dragging the start handle past the end swaps them, and the magnet off places an edge freely',()=>{
 const {root,loops,e,mounted}=nav({loopState:{enabled:true,start:4,end:8}});
 const surface=pick(root,'practice-scrubber')[0];surface.getBoundingClientRect=()=>({left:0,width:160});
 const start=pick(root,'practice-loop-handle').find(n=>n.className.includes('start'));start.setPointerCapture=()=>{};start.releasePointerCapture=()=>{};
 start.onpointerdown(e(40));start.onpointermove(e(122));start.onpointerup(e(122));
 assert.deepEqual(loops.at(-1)[0],{enabled:true,start:8,end:12});
 const magnet=pick(root,'practice-loop-magnet')[0];assert.match(magnet.className,/\bon\b/);
 magnet.onclick({stopPropagation(){}});assert.doesNotMatch(magnet.className,/\bon\b/);
 const end=pick(root,'practice-loop-handle').find(n=>n.className.includes('end'));end.setPointerCapture=()=>{};end.releasePointerCapture=()=>{};
 end.onpointerdown(e(80));end.onpointermove(e(113));end.onpointerup(e(113));
 assert.ok(Math.abs(loops.at(-1)[0].end-11.3)<1e-9,'exactly where it was dropped');
 magnet.onclick({stopPropagation(){}});mounted.dispose();
});

test('dragging a loop handle moves only that edge, snapped, without seeking',()=>{
 const {root,loops,seeks,e,mounted}=nav({loopState:{enabled:true,start:4,end:8}});
 const surface=pick(root,'practice-scrubber')[0];surface.getBoundingClientRect=()=>({left:0,width:160});
 const handle=pick(root,'practice-loop-handle').find(n=>n.className.includes('end'));handle.setPointerCapture=()=>{};handle.releasePointerCapture=()=>{};
 handle.onpointerdown(e(80));handle.onpointermove(e(122));handle.onpointerup(e(122));
 assert.deepEqual(loops,[[{enabled:true,start:4,end:12},{seekTo:undefined}]]);assert.deepEqual(seeks,[]);mounted.dispose();
});

test('wheel pans, Ctrl+wheel zooms around the pointer, and neither seeks',()=>{
 const {root,actions,seeks}=nav({viewport:{start:0,end:8,follow:false}});const surface=pick(root,'practice-scrubber')[0];surface.getBoundingClientRect=()=>({left:0,width:160});
 surface.onwheel({deltaY:40,deltaX:0,clientX:80,ctrlKey:false,preventDefault(){}});
 surface.onwheel({deltaY:-100,deltaX:0,clientX:80,ctrlKey:true,preventDefault(){}});
 assert.deepEqual(actions[0],{type:'pan',delta:2});
 assert.equal(actions[1].type,'zoom');assert.equal(actions[1].factor,.8);assert.equal(actions[1].anchor,4);assert.deepEqual(seeks,[]);
});

test('the navigator caps step through the song and Follow toggles, and neither seeks',()=>{
 const {root,actions,seeks}=nav({viewport:{start:0,end:8,follow:true}});
 root.querySelector('.practice-follow').onclick();
 assert.deepEqual(actions,[{type:'set-follow',value:false}]);assert.deepEqual(seeks,[]);
 assert.equal(root.querySelector('.practice-follow').getAttribute('aria-pressed'),'true');
});

test('the navigator says what is visible (to screen readers), and the current section is highlighted behind the waveform',()=>{
 const {root}=nav({viewport:{start:0,end:8,follow:false}});
 assert.match(pick(root,'cassette-window')[0].attributes['aria-valuetext'],/0:00 – 0:08 · 8 s visible/);
 assert.equal(pick(root,'practice-current-band')[0].style.display,'block');
});

test('viewport reducer: pointer-anchored zoom and Follow on/off are presentation only',()=>{
 const base={start:10,end:30,follow:false};
 const zoomed=updateViewport(base,{type:'zoom',factor:.5,anchor:20},{...context,playhead:15});
 assert.deepEqual([zoomed.start,zoomed.end],[15,25]);
 const off=updateViewport({start:10,end:30,follow:true},{type:'set-follow',value:false},context);assert.equal(off.follow,false);
 const on=updateViewport({start:60,end:80,follow:false},{type:'set-follow',value:true},context);assert.equal(on.follow,true);assert.ok(on.start<=15&&on.end>=15);
});

test('the navigator: dragging the middle of its window moves the view, dragging a grip zooms from that end, and neither seeks',()=>{
 const {root}=nav({duration:100,viewport:{start:20,end:60,follow:false}});assert.ok(pick(root,'cassette')[0],'the navigator is a cassette');
 const navigator=nav({duration:100,viewport:{start:20,end:60,follow:false}});
 navigator.mounted.navigator.gesture.start('start',50,200);navigator.mounted.navigator.gesture.move(70);navigator.mounted.navigator.gesture.end();   // 200px = 100s: 20px = 10s
 navigator.mounted.navigator.gesture.start('end',300,200);navigator.mounted.navigator.gesture.move(260);navigator.mounted.navigator.gesture.end();
 assert.deepEqual(navigator.actions,[{type:'pan-to',start:30,end:60},{type:'pan-to',start:20,end:40}]);assert.deepEqual(navigator.seeks,[]);
});

test('ruler marks: evenly spaced times, or the bars that really start nearest those spots, labelled with their own numbers',()=>{
 const times=rulerMarks('time',100,[],5);
 assert.deepEqual(times.map(m=>m.text),['0:00','0:25','0:50','1:15','1:40']);assert.deepEqual(times.map(m=>m.at),[0,25,50,75,100]);
 // a tempo change: bars 1-3 last 10s each, then the bars shorten to 5s each
 const measures=[1,2,3].map((n,i)=>({number:n,start:i*10,end:i*10+10})).concat([4,5,6,7,8].map((n,i)=>({number:n,start:30+i*5,end:35+i*5})));
 const bars=rulerMarks('bars',55,measures,3);
 assert.deepEqual(bars.map(m=>m.text),['1','4','8'],'the middle spot (27.5s) is nearest bar 4, which starts at 30s, because the bars before it were longer');
 assert.deepEqual(rulerMarks('bars',55,[{number:0,start:0,end:5},...measures],2).map(m=>m.text),['1','8'],'a bar before bar 1 is not labelled');
 assert.deepEqual(rulerMarks('bars',10,[],4),[],'no measured bars, no bar labels');
});

test('the TIME / BARS switch changes the labels and nothing else',()=>{
 const {root,actions,mounted}=nav({duration:16,viewport:{start:4,end:12,follow:false}});
 const [timeButton,barsButton]=pick(root,'ruler-toggle')[0].children;
 const text=()=>pick(root,'tick').map(n=>n.textContent);
 const before=text();barsButton.onclick();const inBars=text();timeButton.onclick();
 assert.ok(before.every(t=>/:/.test(t)),'times by default');assert.ok(inBars.every(t=>/^\d+$/.test(t)),'bar numbers after the switch');
 assert.deepEqual(actions,[],'the viewport is untouched');
 assert.equal(barsButton.attributes['aria-pressed'],'false');
});
