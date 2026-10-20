import {musicalPosition} from './musical-grid.js';
import {buildPracticeMarkers} from './practice-state.js';
import {snapGrain,snapRange,moveEdge,describeRange,BEAT_ZOOM} from './loop-range.js';
import {createZoomBar} from './zoom-bar.js';
import {prefs} from './prefs.js';

// Pure viewport reducer: the visible window of the song on the navigation bar. It only ever changes presentation, never playback.
export function updateViewport(viewport,action,context){
 const lo=context.start??0,hi=Math.max(lo,context.end??0),minimum=Math.min(context.minSpan??.2,hi-lo),v=viewport||{start:lo,end:hi,follow:true};
 let start=v.start,end=v.end,follow=v.follow,span=end-start;
 if(action.type==='reset'){start=lo;end=hi;follow=true;}
 if(action.type==='pan-to'){start=action.start;end=action.end;follow=false;}
 if(action.type==='reveal'&&(action.seconds<start||action.seconds>=end)){start=action.seconds-span*.3;end=start+span;}
 if(action.type==='pan'){start+=action.delta;end+=action.delta;follow=false;}
 if(action.type==='resize-start'){start=Math.max(lo,Math.min(end-minimum,action.seconds));follow=false;}
 if(action.type==='resize-end'){end=Math.min(hi,Math.max(start+minimum,action.seconds));follow=false;}
 if(action.type==='zoom'){
  const selected=context.selectedSeconds,playhead=context.playhead;
  // A pointer-anchored zoom (Ctrl+wheel) keeps the time under the cursor in place.
  const anchor=Number.isFinite(action.anchor)?action.anchor:Number.isFinite(selected)?selected:playhead>=start&&playhead<=end?playhead:(start+end)/2;
  const ratio=span?Math.max(0,Math.min(1,(anchor-start)/span)):.5;
  span=Math.max(minimum,Math.min(hi-lo,span*action.factor));start=anchor-ratio*span;end=start+span;
 }
 if(action.type==='set-follow'){follow=!!action.value;}
 if(action.type==='follow'||action.type==='tick'&&follow||action.type==='set-follow'&&follow){
  if(action.type==='follow')follow=true;
  if(context.playhead<start||context.playhead>end){start=context.playhead-span*.3;end=start+span;}
 }
 if(end-start>=hi-lo){start=lo;end=hi;}else {if(start<lo){end+=lo-start;start=lo;}if(end>hi){start-=end-hi;end=hi;}}
 return {start,end,follow};
}

// Where the labels under the navigator go. TIME: evenly spaced clock times. BARS: the bars that start closest to those spots, labelled with
// their real numbers, so tempo and time-signature changes are already in the positions (they come from the measured bars, not a formula).
export function rulerMarks(mode,total,measures,count){
  const marks=[],n=Math.max(2,count);
  for(let i=0;i<n;i++){
    const t=total*i/(n-1);
    if(mode==='bars'){
      let best=null;
      for(const m of measures){if(!(m.number>=1)||m.start>total)continue;if(!best||Math.abs(m.start-t)<Math.abs(best.start-t))best=m;}
      if(best&&!marks.some(x=>x.text===String(best.number)))marks.push({at:best.start,text:String(best.number)});
    }else marks.push({at:t,text:clock(t)});
  }
  return marks;
}

const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
const clock=s=>Number.isFinite(s)?Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0'):'0:00';
const DRAG_PIXELS=5;   // a press that moves less than this is a click (seek); more is a loop selection
const SECTION_COLOUR={verse:'--a3',chorus:'--a1',interlude:'--a2',bridge:'--a2'};
const nameKey=name=>String(name||'').toLowerCase().replace(/[^a-z]/g,'');

export function mountPracticeTimeline(container,{transport,onViewportChange,onError=()=>{}}){
 let value={music:{measures:[]},viewport:null,projection:null},draggingSeek=false,waveform=null,waveMessage='Waveform available after analysis.',markerRefs=[],markerKey='',waveKey='',draft=null,seekAxis=null,pendingTimeline=null;
 const measures=()=>value.music.measures||[];
 // Silence before the song starts is not a bar: what is shown is renumbered from the first bar with music in it.
 const numbered=()=>{const offset=value.barOffset||0;return offset?measures().map(m=>({...m,number:m.number-offset})):measures();};
 const bounds=()=>({start:0,end:transport.getSnapshot().duration||measures().at(-1)?.end||0});
 const visible=()=>seekAxis||value.viewport||bounds();
 const duration=()=>bounds().end;

 // ----- lane: section blocks above the waveform, loop range and the single gold playhead -----
 const surface=node('div','practice-scrubber'),band=node('div','practice-current-band'),sections=node('div','practice-section-track'),wave=node('div','practice-waveform');
 const canvas=node('canvas','practice-waveform-canvas'),played=node('canvas','practice-waveform-canvas played'),notice=node('span','practice-waveform-notice');
 canvas.setAttribute('aria-label','Recording waveform');wave.append(canvas,played,notice);
 const seek=node('input','practice-seek');seek.type='range';seek.min=0;seek.max=0;seek.step=.001;seek.value=0;seek.setAttribute('aria-label','Playback position');wave.append(seek);
 const loop=node('div','practice-loop'),loopStart=node('i','practice-loop-handle start'),loopEnd=node('i','practice-loop-handle end'),tag=node('span','practice-loop-tag'),tagText=node('span','practice-loop-text','Loop'),clear=node('button','practice-loop-clear','×');
 clear.type='button';clear.title='Clear loop';clear.setAttribute('aria-label','Clear loop');loopStart.setAttribute('aria-label','Loop start');loopEnd.setAttribute('aria-label','Loop end');tag.append(tagText,clear);loop.append(loopStart,loopEnd,tag);
 const playhead=node('div','practice-playhead'),grip=node('i','practice-playhead-grip'),position=node('span','practice-position');playhead.setAttribute('aria-label','Playhead');playhead.append(grip);
 surface.append(band,sections,wave,loop,playhead,position);container.append(surface);

 // ----- the navigator ("the cassette"): which part of the song is in view. It sits right against the lane above, as one instrument.
 //       Drag the window to move, its grips to zoom, the caps to step. Under it: the ruler, with Follow and TIME / BARS at its right end.
 const nav=node('div','timeline-nav'),foot=node('div','timeline-foot');
 const button=(cls,text,label)=>{const b=node('button',cls,text);b.type='button';b.setAttribute('aria-label',label);b.title=label;return b;};
 const follow=button('tl-btn practice-follow','Follow','Follow the playhead');follow.setAttribute('aria-pressed','true');
 const toggle=node('div','ruler-toggle'),timeButton=button('','TIME','Label the ruler with times'),barsButton=button('','BARS','Label the ruler with bar numbers');
 toggle.setAttribute('role','group');toggle.setAttribute('aria-label','Ruler labels');toggle.append(timeButton,barsButton);
 const tools=node('div','timeline-tools');tools.append(follow,toggle);
 const cassette=createZoomBar({label:'The part of the song in view: drag to move, drag the ends to zoom',windowLabel:'VIEW',
  bounds:()=>{const b=bounds();return {lo:b.start,hi:b.end||1};},minSpan:()=>.15,
  getRange:()=>{const v=visible();return {start:v.start,end:v.end};},
  setRange:r=>onViewportChange({type:'pan-to',start:r.start,end:r.end})});
 const overviewLoop=node('div','practice-overview-loop'),overviewHead=node('div','practice-ov-head');cassette.overlay.append(overviewLoop,overviewHead);
 const ruler=node('div','timeline-ruler');
 foot.append(ruler,tools);nav.append(cassette.el,foot);container.append(nav);
 follow.onclick=()=>onViewportChange({type:'set-follow',value:!visible().follow});
 // TIME / BARS only changes the labels under the navigator (and on the piano roll's ruler); the part in view stays where it is
 let rulerMode=prefs.get('cb-ruler','time')==='bars'?'bars':'time',rulerKey='';
 const setRuler=(mode,announce=true)=>{
  rulerMode=mode;prefs.set('cb-ruler',mode);
  for(const [b,m] of [[timeButton,'time'],[barsButton,'bars']]){b.classList.toggle('active',mode===m);b.setAttribute('aria-pressed',String(mode===m));}
  rulerKey='';paintRuler();if(announce&&typeof window!=='undefined'&&window.dispatchEvent&&typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('chordbuddy:ruler'));
 };
 function paintRuler(){
  const total=bounds().end,width=ruler.clientWidth||600,free=width-(tools.offsetWidth||0)-8;   // labels stop short of the switches at the right end
  const key=JSON.stringify([rulerMode,total,measures().length,value.barOffset||0,Math.round(width/20),Math.round(free/20)]);
  if(key===rulerKey)return;rulerKey=key;
  const marks=rulerMarks(rulerMode,total,numbered(),Math.min(9,Math.floor(width/90))).filter(m=>m.at/Math.max(.001,total)*width<free-28);
  ruler.replaceChildren(...marks.map((m,i)=>{
   const label=node('span','tick',m.text);label.style.left=(100*m.at/Math.max(.001,total))+'%';
   label.style.transform=i===0&&m.at<total*.02?'none':'translateX(-50%)';return label;
  }));
 }
 timeButton.onclick=()=>setRuler('time');barsButton.onclick=()=>setRuler('bars');
 setRuler(rulerMode,false);

 function positionAt(t){const p=musicalPosition(numbered(),t);return p?(p.bar<1?'Before bar 1':'Bar '+p.bar)+(Number.isFinite(p.beat)?' · Beat '+p.beat.toFixed(2):' · timing unavailable'):'Musical position unavailable';}
 const percentOf=(t,axis)=>100*(t-axis.start)/Math.max(.001,axis.end-axis.start);
 // The bar-and-beat label rides above the playhead but always stays wholly inside the scrubber, however narrow the window is.
 function placeLabel(percent){
  const lane=position.parentElement?.clientWidth||0,width=position.offsetWidth||0;
  if(!lane||!width){position.style.left=Math.max(12,Math.min(88,percent))+'%';return;}
  const half=width/2+4;position.style.left=Math.max(half,Math.min(lane-half,lane*percent/100))+'px';
 }
 const timeAt=(clientX,axis,element=seek)=>{const rect=element.getBoundingClientRect();return axis.start+Math.max(0,Math.min(1,(clientX-rect.left)/Math.max(1,rect.width)))*(axis.end-axis.start);};
 const grain=()=>snapGrain(duration(),visible());
 const currentLoop=()=>{const l=transport.getSnapshot().loop;return l&&l.start!==null&&l.end!==null?l:null;};

 function drawWave(active){
  notice.textContent=waveform?'':waveMessage;
  const ctx=canvas.getContext?.('2d'),pctx=played.getContext?.('2d');if(!ctx||!pctx)return;
  const dpr=typeof devicePixelRatio==='number'?devicePixelRatio:1,width=Math.max(1,Math.round(surface.clientWidth||container.clientWidth||640)),height=Math.max(24,Math.round(wave.clientHeight||46));
  for(const c of [canvas,played]){c.width=Math.round(width*dpr);c.height=Math.round(height*dpr);}
  for(const c of [ctx,pctx]){c.setTransform?.(dpr,0,0,dpr,0,0);c.clearRect(0,0,width,height);}
  const css=typeof getComputedStyle==='function'?getComputedStyle(container):null,ink=css?.getPropertyValue('--ink').trim()||'#222',faint=css?.getPropertyValue('--faint').trim()||'#999';
  const v=visible(),dx=width/Math.max(.001,v.end-v.start);
  // bar lines (beat lines too once zoomed in) and bar numbers share the time axis with the waveform
  const zoomedIn=duration()/Math.max(.001,v.end-v.start)>=BEAT_ZOOM;
  ctx.lineWidth=1;ctx.font='9px "Space Mono",monospace';
  for(const m of measures()){
   if(m.end<v.start||m.start>v.end)continue;
   const x=Math.round((m.start-v.start)*dx)+.5;ctx.strokeStyle=ink;ctx.globalAlpha=.16;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();
   if(zoomedIn)for(const b of m.beats.slice(1)){const bx=Math.round((b-v.start)*dx)+.5;ctx.globalAlpha=.08;ctx.beginPath();ctx.moveTo(bx,0);ctx.lineTo(bx,height);ctx.stroke();}
   const shownNumber=m.number-(value.barOffset||0);
   if(shownNumber>=1&&(shownNumber%(zoomedIn?1:4)===1||zoomedIn&&dx*(m.end-m.start)>26)){ctx.globalAlpha=.55;ctx.fillStyle=faint;ctx.fillText(String(shownNumber),x+3,10);}
  }
  ctx.globalAlpha=1;
  if(!waveform?.peaks?.length)return;
  const duration_=waveform.duration,peak=Math.max(.0001,...waveform.peaks),n=waveform.peaks.length;
  const left=Math.max(0,Math.floor(v.start/duration_*n)),right=Math.min(n,Math.ceil(v.end/duration_*n));
  for(const [c,alpha] of [[ctx,.3],[pctx,1]]){
   c.strokeStyle=ink;c.globalAlpha=alpha;c.lineWidth=Math.max(1,Math.min(3,dx*duration_/n*.7));
   for(let i=left;i<right;i++){const t=(i+.5)/n*duration_,x=(t-v.start)*dx,h=Math.max(1,waveform.peaks[i]/peak*(height/2-3));c.beginPath();c.moveTo(x,height/2-h);c.lineTo(x,height/2+h);c.stroke();}
   c.globalAlpha=1;
  }
 }

 function paintLoop(s,v){
  const l=draft||currentLoop(),shown=!!l&&l.end>v.start&&l.start<v.end;
  loop.classList.toggle('show',shown);loop.classList.toggle('off',!!l&&!draft&&!s.loop?.enabled);loop.classList.toggle('draft',!!draft);
  overviewLoop.style.display=l?'block':'none';
  if(!l)return;
  const b=bounds(),left=Math.max(0,percentOf(l.start,v)),right=Math.min(100,percentOf(l.end,v));
  loop.style.left=left+'%';loop.style.width=Math.max(0,right-left)+'%';
  loopStart.style.display=percentOf(l.start,v)>=0?'block':'none';loopEnd.style.display=percentOf(l.end,v)<=100?'block':'none';
  tagText.textContent=(draft?'':s.loop?.enabled?'Loop · ':'Loop off · ')+describeRange(numbered(),l);
  overviewLoop.style.left=percentOf(l.start,b)+'%';overviewLoop.style.width=Math.max(.5,percentOf(l.end,b)-percentOf(l.start,b))+'%';
 }

 function paint(s){
  const b=bounds(),v=visible(),t=draggingSeek?Number(seek.value):s.seconds;
  seek.min=v.start;seek.max=v.end;seek.disabled=!s.ready;if(!draggingSeek)seek.value=s.seconds;
  const outside=t<v.start||t>v.end;seek.classList.toggle('outside',outside);seek.setAttribute('aria-valuetext',positionAt(t)+(outside?' · outside the visible span':''));
  position.textContent=positionAt(t)+(outside?' · outside visible span':'');position.classList.toggle('outside',outside);playhead.hidden=outside;
  const percent=percentOf(t,v);playhead.style.left=percent+'%';placeLabel(percent);
  played.style.clipPath='inset(0 '+Math.max(0,Math.min(100,100-percent))+'% 0 0)';
  cassette.refresh();paintRuler();overviewHead.style.left=percentOf(t,b)+'%';
  cassette.setValueText(clock(v.start)+' – '+clock(v.end)+' · '+(v.end-v.start>=60?Math.round((v.end-v.start)/6)/10+' min':Math.round(v.end-v.start)+' s')+' visible');
  follow.classList.toggle('on',!!v.follow);follow.setAttribute('aria-pressed',String(!!v.follow));
  let active=null;for(const item of markerRefs){const current=t>=item.marker.seconds&&t<item.marker.end;item.node.disabled=!s.ready;item.node.classList.toggle('current',current);if(current)active=item.marker;}
  band.style.display=active?'block':'none';if(active){const left=Math.max(0,percentOf(active.seconds,v)),right=Math.min(100,percentOf(active.end,v));band.style.left=left+'%';band.style.width=Math.max(0,right-left)+'%';}
  paintLoop(s,v);
  const nextWaveKey=JSON.stringify([v.start,v.end,surface.clientWidth,waveform?.run_id,waveform?.peaks?.length,waveMessage,value.music.measures.length]);if(nextWaveKey!==waveKey){waveKey=nextWaveKey;drawWave(active);}
 }

 // ----- gestures on the lane -----
 // Press-and-release in place seeks. Press-and-drag selects a loop range (snapped to bars, or beats when zoomed in).
 // Dragging the gold playhead grip scrubs. Dragging a loop handle moves that edge. None of them touch pan/zoom.
 let gesture=null;
 const finishGesture=()=>{gesture=null;seekAxis=null;draft=null;if(pendingTimeline){const pending=pendingTimeline;pendingTimeline=null;api.update(pending);}};
 const ready=()=>transport.getSnapshot().ready;
 const commitSeek=()=>{const t=Number(seek.value);draggingSeek=false;finishGesture();transport.seek(t).catch(onError);};
 const applyLoop=(range,{follow:seekToStart}={})=>{
  const playing=transport.getSnapshot().playIntent;
  transport.setLoop({enabled:true,start:range.start,end:range.end},{seekTo:seekToStart&&playing?range.start:undefined}).catch(onError);
 };
 const previewSeek=e=>{const axis=gesture?.axis||visible();seek.value=timeAt(e.clientX,axis);draggingSeek=true;paint(transport.getSnapshot());};
 const options=()=>({grain:gesture?.grain||grain(),duration:duration()});
 seek.oninput=()=>{draggingSeek=true;paint(transport.getSnapshot());};seek.onchange=commitSeek;
 seek.onpointerdown=e=>{
  if(e.button!==0||!ready())return;e.preventDefault();seek.focus();
  gesture={kind:'lane',pointer:e.pointerId,x:e.clientX,moved:false,axis:{...visible()},grain:grain()};seekAxis=gesture.axis;gesture.anchor=timeAt(e.clientX,gesture.axis);seek.setPointerCapture(e.pointerId);
 };
 seek.onpointermove=e=>{
  if(gesture?.kind!=='lane'||e.pointerId!==gesture.pointer)return;
  if(!gesture.moved&&Math.abs(e.clientX-gesture.x)<DRAG_PIXELS)return;
  gesture.moved=true;draft=snapRange(measures(),gesture.anchor,timeAt(e.clientX,gesture.axis),options());paint(transport.getSnapshot());
 };
 seek.onpointerup=e=>{
  if(gesture?.kind!=='lane'||e.pointerId!==gesture.pointer)return;seek.releasePointerCapture?.(e.pointerId);
  if(gesture.moved){const range=draft;draggingSeek=false;finishGesture();if(range)applyLoop(range,{follow:true});return;}
  seek.value=gesture.anchor;draggingSeek=true;commitSeek();
 };
 seek.onpointercancel=e=>{if(gesture?.kind!=='lane'||e.pointerId!==gesture.pointer)return;seek.releasePointerCapture?.(e.pointerId);draggingSeek=false;finishGesture();paint(transport.getSnapshot());};
 grip.onpointerdown=e=>{if(e.button!==0||!ready())return;e.preventDefault();e.stopPropagation?.();gesture={kind:'scrub',pointer:e.pointerId,axis:{...visible()}};seekAxis=gesture.axis;grip.setPointerCapture(e.pointerId);previewSeek(e);};
 grip.onpointermove=e=>{if(gesture?.kind==='scrub'&&e.pointerId===gesture.pointer)previewSeek(e);};
 grip.onpointerup=e=>{if(gesture?.kind!=='scrub'||e.pointerId!==gesture.pointer)return;previewSeek(e);grip.releasePointerCapture?.(e.pointerId);commitSeek();};
 grip.onpointercancel=e=>{if(gesture?.kind!=='scrub'||e.pointerId!==gesture.pointer)return;grip.releasePointerCapture?.(e.pointerId);draggingSeek=false;finishGesture();paint(transport.getSnapshot());};
 for(const [handle,edge] of [[loopStart,'start'],[loopEnd,'end']]){
  handle.onpointerdown=e=>{const l=currentLoop();if(e.button!==0||!l)return;e.preventDefault();e.stopPropagation?.();gesture={kind:'edge',edge,pointer:e.pointerId,axis:{...visible()},grain:grain(),range:{start:l.start,end:l.end}};seekAxis=gesture.axis;handle.setPointerCapture(e.pointerId);};
  handle.onpointermove=e=>{if(gesture?.kind!=='edge'||gesture.edge!==edge||e.pointerId!==gesture.pointer)return;draft=moveEdge(measures(),gesture.range,edge,timeAt(e.clientX,gesture.axis,surface),options());paint(transport.getSnapshot());};
  handle.onpointerup=e=>{if(gesture?.kind!=='edge'||gesture.edge!==edge||e.pointerId!==gesture.pointer)return;handle.releasePointerCapture?.(e.pointerId);const range=draft;finishGesture();if(range)applyLoop(range);};
  handle.onpointercancel=e=>{if(gesture?.kind!=='edge'||e.pointerId!==gesture.pointer)return;handle.releasePointerCapture?.(e.pointerId);finishGesture();paint(transport.getSnapshot());};
 }
 clear.onclick=()=>{transport.setLoop(null).catch(onError);};
 // Plain wheel pans, Ctrl+wheel zooms around the pointer. Neither seeks.
 surface.onwheel=e=>{
  e.preventDefault?.();const v=visible(),width=Math.max(1,surface.getBoundingClientRect?.().width||640);
  if(e.ctrlKey)onViewportChange({type:'zoom',factor:e.deltaY<0?.8:1.25,anchor:timeAt(e.clientX,v,surface)});
  else onViewportChange({type:'pan',delta:((e.deltaX||e.deltaY)/width)*(v.end-v.start)});
 };
 const unsubscribe=transport.subscribe(paint),observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{waveKey='';paint(transport.getSnapshot());}):null;observer?.observe(surface);
 const api={update(next){
  if(seekAxis){pendingTimeline=next;paint(transport.getSnapshot());return;}
  value=next;const v=visible(),list=next.projection?buildPracticeMarkers(next.projection):[],k=JSON.stringify([list,v.start,v.end]);
  if(k!==markerKey){
   markerKey=k;sections.replaceChildren();markerRefs=[];
   const total=Math.max(.001,bounds().end),picture=[];
   for(const m of list){
    picture.push({from:m.seconds,to:m.end,colour:'var('+(SECTION_COLOUR[nameKey(m.sectionName)]||'--tint')+')',opacity:.55});
    if(m.end<=v.start||m.seconds>=v.end)continue;
    const block=node('button','practice-section-block',m.sectionName);block.type='button';block.dataset.name=nameKey(m.sectionName);block.title=m.sectionName+' · '+positionAt(m.seconds)+' · double-click to loop it';
    block.style.left=100*(Math.max(v.start,m.seconds)-v.start)/(v.end-v.start)+'%';block.style.width=100*(Math.min(v.end,m.end)-Math.max(v.start,m.seconds))/(v.end-v.start)+'%';
    block.onclick=()=>transport.seek(m.seconds).catch(onError);
    block.ondblclick=()=>applyLoop({start:m.seconds,end:m.end},{follow:true});
    sections.append(block);markerRefs.push({marker:m,node:block});
   }
   cassette.setPreview(picture);
  }
  paint(transport.getSnapshot());
 },setWaveform(next,message='Waveform unavailable.'){waveform=next;waveMessage=message;waveKey='';paint(transport.getSnapshot());},navigator:cassette,dispose(){unsubscribe();observer?.disconnect();container.replaceChildren();}};
 return api;
}
