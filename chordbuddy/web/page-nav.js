// Moving around the page, the same way in every view:
//   middle button + drag  pans, like the hand tool in Photoshop (the roll in the MIDI view does the same with its own time axis)
//   Ctrl + wheel          makes the page bigger or smaller on screen, and nothing else: the layout and the music are drawn exactly as before
//   Ctrl + plus / minus / 0  do the same from the keyboard (0 is back to 100%)
export const MIN_ZOOM=.5,MAX_ZOOM=2.5,ZOOM_STEP=.1;

export const clampZoom=value=>Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,Math.round(value*100)/100));
/** One notch bigger (direction 1) or smaller (-1), landing on tidy percentages. */
export const stepZoom=(current,direction)=>clampZoom(Math.round((current+direction*ZOOM_STEP)*10)/10);

const SCROLLING=/auto|scroll/;
/** The nearest thing under the pointer that can scroll, up to (and including) the desk. */
export function scrollableAncestor(node,desk){
  for(let n=node;n&&n!==document.documentElement;n=n.parentElement){
    const style=getComputedStyle(n);
    const sideways=SCROLLING.test(style.overflowX)&&n.scrollWidth>n.clientWidth+1,upDown=SCROLLING.test(style.overflowY)&&n.scrollHeight>n.clientHeight+1;
    if(sideways||upDown)return n;
    if(n===desk)return desk;
  }
  return null;
}

export function installPageNav({desk,pages,prefs,pill}){
  let zoom=clampZoom(Number(prefs?.get('cb-page-zoom','1'))||1);
  const apply=()=>{for(const page of pages)if(page)page.style.zoom=zoom===1?'':String(zoom);};
  const showing=()=>pages.some(page=>page&&!page.classList.contains('hidden'));     // the MIDI view has its own musical zoom instead
  apply();
  let fade=null;
  const show=()=>{
    if(!pill)return;pill.textContent=Math.round(zoom*100)+'%';pill.classList.add('show');
    clearTimeout(fade);fade=setTimeout(()=>pill.classList.remove('show'),1400);
  };
  function setZoom(next,anchor){
    next=clampZoom(next);if(next===zoom){show();return;}
    const ratio=next/zoom,box=desk.getBoundingClientRect();
    const px=anchor?anchor.x-box.left:box.width/2,py=anchor?anchor.y-box.top:box.height/2;
    const contentX=desk.scrollLeft+px,contentY=desk.scrollTop+py;
    zoom=next;apply();
    desk.scrollLeft=contentX*ratio-px;desk.scrollTop=contentY*ratio-py;
    try{prefs?.set('cb-page-zoom',String(zoom));}catch{/* a remembered zoom is a nicety */}
    show();
  }
  document.addEventListener('wheel',event=>{
    if(!event.ctrlKey||!desk.contains(event.target)||!showing())return;        // over the bottom strip, Ctrl+wheel keeps zooming time
    event.preventDefault();
    setZoom(stepZoom(zoom,event.deltaY<0?1:-1),{x:event.clientX,y:event.clientY});
  },{passive:false});
  document.addEventListener('keydown',event=>{
    if(!(event.ctrlKey||event.metaKey)||event.altKey||!showing()||event.target?.closest?.('input,textarea,select,[contenteditable]'))return;
    if(event.key==='+'||event.key==='='){event.preventDefault();setZoom(stepZoom(zoom,1));}
    else if(event.key==='-'||event.key==='_'){event.preventDefault();setZoom(stepZoom(zoom,-1));}
    else if(event.key==='0'){event.preventDefault();setZoom(1);}
  });
  if(pill)pill.onclick=()=>setZoom(1);

  // The middle button drags whatever scrolls under the pointer. (It would otherwise start the browser's own auto-scroll.)
  document.addEventListener('pointerdown',event=>{
    if(event.button!==1)return;
    const scroller=scrollableAncestor(event.target,desk);
    if(!scroller||(scroller!==desk&&!desk.contains(scroller)&&!scroller.contains(desk)))return;
    event.preventDefault();
    let x=event.clientX,y=event.clientY;document.body.classList.add('panning');
    // the page scrolls smoothly for other things; a drag must follow the pointer exactly, with no easing
    const move=e=>{scroller.scrollTo({left:scroller.scrollLeft-(e.clientX-x),top:scroller.scrollTop-(e.clientY-y),behavior:'instant'});x=e.clientX;y=e.clientY;};
    const done=()=>{document.body.classList.remove('panning');document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',done);document.removeEventListener('pointercancel',done);};
    document.addEventListener('pointermove',move);document.addEventListener('pointerup',done);document.addEventListener('pointercancel',done);
  });
  document.addEventListener('mousedown',event=>{if(event.button===1&&desk.contains(event.target))event.preventDefault();});
  document.addEventListener('auxclick',event=>{if(event.button===1&&desk.contains(event.target))event.preventDefault();});
  return {getZoom:()=>zoom,setZoom};
}
