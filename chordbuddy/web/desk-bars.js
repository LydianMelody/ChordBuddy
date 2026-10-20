// The Time tool's bars: while the chart is drawn on a beat grid, the page is wider than the desk, so the desk gets the same cassette bars as the
// piano roll instead of the browser's scroll bars. The bar along the bottom scrolls sideways and zooms the beat grid (pull a grip, or use the
// wheel over it); the bar on the right only scrolls. Both measure the page as a fraction of its whole size, 0 to 1.
import {createZoomBar} from './zoom-bar.js';

/**
 * Where the desk should scroll to, and at what zoom, for a range chosen on the bottom bar. Pure, so it can be tested.
 * range: {start,end} as fractions of the page width; span: the fraction showing now; zoom: the zoom now; limits: [lowest, highest].
 * Narrowing the window zooms in by the same ratio (a window half as wide shows twice the zoom), within the limits.
 */
export function zoomForRange(range,span,zoom,[lowest,highest]){
  const wanted=range.end-range.start;
  if(!(wanted>0)||Math.abs(wanted-span)<1e-4)return zoom;
  return Math.max(lowest,Math.min(highest,Math.round(zoom*span/wanted*100)/100));
}

/**
 * One zoom for the bottom bar made of two: the beat grid's own zoom, and below its smallest, the page shrinking as a whole (chord names and
 * all) down to `floor`, so a row of bars can always be seen whole. Zooming back in, or release(), gives the page back its own zoom.
 * timing, page: {get(), set(value)}; timing also has limits [lowest, highest].
 */
export function combinedZoom(timing,page,floor=.5){
  let own=null;                                                     // the page's zoom before the bar shrank it (null: not shrunk)
  const base=()=>own??page.get();
  const api={
    get limits(){return [timing.limits[0]*floor,timing.limits[1]*base()];},
    get:()=>timing.get()*page.get(),
    set(value){
      const lowest=timing.limits[0],natural=base();
      if(value>=lowest*natural){
        if(own!==null){page.set(own);own=null;}
        timing.set(Math.min(timing.limits[1],value/natural));
      }else{
        if(own===null)own=page.get();
        timing.set(lowest);page.set(Math.max(floor,value/lowest));
      }
    },
    release(){if(own!==null){page.set(own);own=null;}},
  };
  return api;
}

/**
 * stage: the element holding the tool rail and the desk; desk: the scrolling element.
 * zoom: {get(), set(value), limits:[lowest, highest], release()} (release: called when the bars go away).
 * Returns {show(on), refresh(), dispose()}.
 */
export function mountDeskBars(stage,desk,zoom){
  const fraction=(axis)=>{
    const total=axis==='x'?desk.scrollWidth:desk.scrollHeight,shown=axis==='x'?desk.clientWidth:desk.clientHeight,at=axis==='x'?desk.scrollLeft:desk.scrollTop;
    return total>0?{start:at/total,end:Math.min(1,(at+shown)/total)}:{start:0,end:1};
  };
  const scrollTo=(axis,start)=>{
    if(axis==='x')desk.scrollTo({left:start*desk.scrollWidth,behavior:'instant'});
    else desk.scrollTo({top:start*desk.scrollHeight,behavior:'instant'});
  };
  let pending=null,queued=false;
  const across=createZoomBar({label:'Scroll the beat grid sideways; pull an end to zoom',bounds:()=>({lo:0,hi:1}),
    minSpan:()=>{const r=fraction('x');return Math.min(1,(r.end-r.start)*zoom.get()/zoom.limits[1]);},
    getRange:()=>pending||fraction('x'),
    setRange(range){
      const now=fraction('x'),next=zoomForRange(range,now.end-now.start,zoom.get(),zoom.limits);
      if(next!==zoom.get()){
        // re-drawing the chart is the slow part, so a drag re-draws at most once a frame, at the latest size asked for
        pending=range;
        if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;const r=pending;pending=null;if(!r)return;
          zoom.set(zoomForRange(r,fraction('x').end-fraction('x').start,zoom.get(),zoom.limits));scrollTo('x',r.start);across.refresh();});}
        return;
      }
      scrollTo('x',range.start);
    }});
  const down=createZoomBar({vertical:true,zoom:false,label:'Scroll the chart up and down',bounds:()=>({lo:0,hi:1}),
    getRange:()=>fraction('y'),setRange(range){scrollTo('y',range.start);}});
  across.el.classList.add('desk-bar','across');down.el.classList.add('desk-bar','down');
  let on=false;
  const refresh=()=>{if(on){across.refresh();down.refresh();}};
  const onScroll=()=>refresh();
  desk.addEventListener('scroll',onScroll,{passive:true});
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(refresh):null;
  return {
    show(next){
      if(next===on)return;on=next;stage.classList.toggle('with-bars',on);
      if(on){stage.append(down.el,across.el);for(const child of desk.children)observer?.observe(child);requestAnimationFrame(refresh);}
      else{down.el.remove();across.el.remove();observer?.disconnect();zoom.release?.();}
    },
    refresh,
    dispose(){desk.removeEventListener('scroll',onScroll);observer?.disconnect();across.dispose();down.dispose();},
  };
}
