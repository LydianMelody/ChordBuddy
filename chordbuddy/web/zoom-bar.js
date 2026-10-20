// "The Cassette": a compact, chunky zoom/scroll bar. A rectangular track with a small triangle cap at each end; between the caps, a clipped
// box shows a small picture of what is there, and the window is the part you are looking at. Drag the middle of the window to move, drag a
// grip at either end to zoom, click the box to jump there, press a cap (or hold it) to step, use the wheel over it to zoom.
// The song's navigator under the waveform and both bars of the piano roll are this one component, so they look and behave alike.
//
// Geometry: everything inside the bar is measured against the clip box (the part between the caps), never against the track or the window.
// The window is positioned in percent of the clip box, and the picture inside the window is the same picture shifted by exactly the window's
// own offset (border included), so the two line up to the pixel and nothing leaks past the rounded corners.
import {panRange,zoomRange,resizeRange,centerRange} from './zoom-range.js';

const SVG='http://www.w3.org/2000/svg';
const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};

/**
 * options: {vertical, slim, label, windowLabel, bounds():{lo,hi} (or lo and hi), minSpan (number or function), getRange():{start,end},
 *           setRange({start,end}), onTouch()}
 * The picture is given with setPreview(segments): [{from, to, colour, opacity}] in the bar's own units.
 * Returns {el, track, overlay, refresh(), setPreview(segments), setValueText(text), gesture, dispose()}.
 * `overlay` is an empty layer over the picture (under the window) for things like a loop range or the playhead.
 * `gesture` is the drag itself without the mouse, so it can be driven (and tested) with plain numbers: start(mode, position, length), move(position), end().
 */
export function createZoomBar(options){
  const {vertical=false,slim=false,label='Scroll',windowLabel=''}=options;
  const bounds=()=>options.bounds?options.bounds():{lo:options.lo,hi:options.hi};
  const minimum=()=>typeof options.minSpan==='function'?options.minSpan():options.minSpan;
  const root=el('div','cassette '+(vertical?'v':'h')+(slim?' slim':''));
  const track=el('div','cassette-track'),clip=el('div','cassette-clip'),wash=el('div','cassette-wash'),overlay=el('div','cassette-overlay');
  const less=el('button','cassette-cap less'),more=el('button','cassette-cap more');
  less.type=more.type='button';less.tabIndex=more.tabIndex=-1;                 // the window itself takes the keyboard; the caps are for the mouse
  less.setAttribute('aria-label',vertical?'Scroll up':'Scroll back');more.setAttribute('aria-label',vertical?'Scroll down':'Scroll forward');
  const win=el('div','cassette-window'),view=el('div','cassette-view');
  const gripA=el('div','cassette-grip a'),gripB=el('div','cassette-grip b'),text=el('span','window-label',windowLabel);
  win.tabIndex=0;win.setAttribute('role','scrollbar');win.setAttribute('aria-orientation',vertical?'vertical':'horizontal');win.setAttribute('aria-label',label);
  gripA.setAttribute('aria-hidden','true');gripB.setAttribute('aria-hidden','true');
  win.append(view,gripA,text,gripB);clip.append(wash,overlay,win);track.append(less,clip,more);root.append(track);

  // ---- the picture ----
  let segments=[],washSvg=null,viewSvg=null,drawnBounds='';
  const makeSvg=()=>{
    const {lo,hi}=bounds();
    if(typeof document.createElementNS!=='function')return null;
    const svg=document.createElementNS(SVG,'svg');svg.setAttribute('preserveAspectRatio','none');
    svg.setAttribute('viewBox',vertical?`0 ${lo} 1 ${hi-lo||1}`:`${lo} 0 ${hi-lo||1} 1`);
    for(const s of segments){
      const r=document.createElementNS(SVG,'rect');
      if(vertical){r.setAttribute('x',0);r.setAttribute('width',1);r.setAttribute('y',s.from);r.setAttribute('height',Math.max(.0001,s.to-s.from));}
      else{r.setAttribute('y',0);r.setAttribute('height',1);r.setAttribute('x',s.from);r.setAttribute('width',Math.max(.0001,s.to-s.from));}
      r.setAttribute('fill',s.colour);if(s.opacity!==undefined)r.setAttribute('fill-opacity',String(s.opacity));svg.append(r);
    }
    return svg;
  };
  const picture=()=>{
    washSvg?.remove?.();viewSvg?.remove?.();
    washSvg=makeSvg();viewSvg=makeSvg();
    if(washSvg){wash.append(washSvg);view.append(viewSvg);}
    const {lo,hi}=bounds();drawnBounds=lo+':'+hi;
  };

  // ---- the window ----
  const length=()=>(vertical?clip.clientHeight:clip.clientWidth)||1;
  let border=null;                                                  // the window's own border, read once it is in the page
  function refresh(){
    const {lo,hi}=bounds(),total=hi-lo||1,range=options.getRange();
    if(drawnBounds!==lo+':'+hi)picture();
    const a=Math.max(0,Math.min(1,(range.start-lo)/total)),b=Math.max(a,Math.min(1,(range.end-lo)/total)),len=length();
    win.style[vertical?'top':'left']=(a*100)+'%';win.style[vertical?'height':'width']=((b-a)*100)+'%';
    if(viewSvg){
      if(border===null&&typeof getComputedStyle==='function'&&win.isConnected){const cs=getComputedStyle(win);border=parseFloat(vertical?cs.borderTopWidth:cs.borderLeftWidth)||0;}
      const inset=border||0;                                        // the picture inside starts at the window's inner edge, not its outer edge
      viewSvg.style.position='absolute';
      viewSvg.style[vertical?'top':'left']=(-a*len-inset)+'px';viewSvg.style[vertical?'height':'width']=len+'px';
      viewSvg.style[vertical?'left':'top']=(-inset)+'px';viewSvg.style[vertical?'width':'height']=`calc(100% + ${2*inset}px)`;
    }
    text.style.display=(b-a)*len<76||vertical?'none':'';           // the word VIEW only when there is room for it
    win.setAttribute('aria-valuemin',String(lo));win.setAttribute('aria-valuemax',String(hi));win.setAttribute('aria-valuenow',String(Math.round(range.start*100)/100));
    const whole=b-a>=.999;
    root.classList?.toggle('whole',whole);less.disabled=a<=.0005;more.disabled=b>=.9995;
  }
  const set=range=>{options.onTouch?.();options.setRange(range);refresh();};

  // ---- dragging, in plain numbers: mode is 'move', 'start' or 'end'; position and length are in pixels along the bar ----
  let drag=null;
  const gesture={
    start(mode,position,pixels=length()){const {lo,hi}=bounds();drag={mode,origin:position,range:options.getRange(),perPixel:(hi-lo)/Math.max(1,pixels)};},
    move(position){
      if(!drag)return;const {lo,hi}=bounds(),delta=(position-drag.origin)*drag.perPixel;
      if(drag.mode==='move')set(panRange(drag.range,delta,lo,hi));
      else set(resizeRange(drag.range,drag.mode,(drag.mode==='start'?drag.range.start:drag.range.end)+delta,lo,hi,minimum()));
    },
    end(){drag=null;},
  };
  const along=event=>vertical?event.clientY:event.clientX;
  // the bar may sit inside a zoomed page: a pixel of pointer movement is measured against the clip box as it is drawn
  const drawnLength=()=>{const box=clip.getBoundingClientRect?.();return (vertical?box?.height:box?.width)||length();};
  const begin=mode=>event=>{
    if(event.button!==0)return;
    event.preventDefault();event.stopPropagation();
    const node=event.currentTarget;try{node.setPointerCapture?.(event.pointerId);}catch{/* the drag works without capture */}
    gesture.start(mode,along(event),drawnLength());
    const move=e=>gesture.move(along(e));
    const done=()=>{gesture.end();node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',done);node.removeEventListener('pointercancel',done);};
    node.addEventListener('pointermove',move);node.addEventListener('pointerup',done);node.addEventListener('pointercancel',done);
  };
  const atPointer=event=>{const box=clip.getBoundingClientRect(),{lo,hi}=bounds();return lo+((vertical?event.clientY-box.top:event.clientX-box.left)/Math.max(1,vertical?box.height:box.width))*(hi-lo);};
  const step=direction=>{const {lo,hi}=bounds(),r=options.getRange();set(panRange(r,direction*(r.end-r.start)*.15,lo,hi));};
  if(typeof win.addEventListener==='function'){
    win.addEventListener('pointerdown',event=>{if(event.target===gripA||event.target===gripB)return;begin('move')(event);});
    gripA.addEventListener('pointerdown',begin('start'));gripB.addEventListener('pointerdown',begin('end'));
    clip.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest?.('.cassette-window'))return;const {lo,hi}=bounds();set(centerRange(options.getRange(),atPointer(event),lo,hi));});
    for(const [cap,direction] of [[less,-1],[more,1]]){
      let timer=null,repeat=null;
      const stop=()=>{clearTimeout(timer);clearInterval(repeat);};
      cap.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();step(direction);timer=setTimeout(()=>{repeat=setInterval(()=>step(direction),70);},380);});
      for(const type of ['pointerup','pointerleave','pointercancel'])cap.addEventListener(type,stop);
    }
    track.addEventListener('wheel',event=>{
      if(event.ctrlKey)return;
      event.preventDefault();event.stopPropagation();const {lo,hi}=bounds();
      set(zoomRange(options.getRange(),event.deltaY>0?1.25:.8,atPointer(event),lo,hi,minimum()));
    },{passive:false});
    win.addEventListener('keydown',event=>{
      const {lo,hi}=bounds(),r=options.getRange(),span=r.end-r.start,back=vertical?'ArrowUp':'ArrowLeft',forward=vertical?'ArrowDown':'ArrowRight',middle=(r.start+r.end)/2;
      if(event.key===back)set(panRange(r,-span*.1,lo,hi));
      else if(event.key===forward)set(panRange(r,span*.1,lo,hi));
      else if(event.key==='+'||event.key==='=')set(zoomRange(r,.8,middle,lo,hi,minimum()));
      else if(event.key==='-'||event.key==='_')set(zoomRange(r,1.25,middle,lo,hi,minimum()));
      else if(event.key==='Home')set(panRange(r,lo-r.start,lo,hi));
      else if(event.key==='End')set(panRange(r,hi-r.end,lo,hi));
      else return;
      event.preventDefault();
    });
  }
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>refresh()):null;observer?.observe(clip);
  return {el:root,track,overlay,refresh,gesture,dispose(){observer?.disconnect();},
    setPreview(next){segments=next;picture();refresh();},
    setValueText(value){win.setAttribute('aria-valuetext',value);}};
}
