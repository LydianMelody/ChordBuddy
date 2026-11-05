// Where the visualizer's floating panels sit (the picker and the mixer), and dragging them there. A place is kept as a fraction of the
// room the panel has to move in ({x, y}, each 0 to 1: 0 is against the left or top edge, 1 against the right or bottom), so it holds at
// any window size: a panel parked in the bottom-right corner stays there when the window or the capture resolution changes.
export const MARGIN=12;                         // panels keep this far from the edges

const unit=value=>Math.max(0,Math.min(1,Math.round(value*1000)/1000));
// A saved place, or null when it is missing or unreadable.
export function readPlace(value){
  return value&&typeof value==='object'&&Number.isFinite(value.x)&&Number.isFinite(value.y)?{x:unit(value.x),y:unit(value.y)}:null;
}
// Pixels for a place: the panel's top-left corner, inside the stage's margins (a panel bigger than the room sits at the margin).
export function placeToPixels(place,stage,panel){
  const roomX=Math.max(0,stage.w-panel.w-2*MARGIN),roomY=Math.max(0,stage.h-panel.h-2*MARGIN);
  return {left:MARGIN+place.x*roomX,top:MARGIN+place.y*roomY};
}
// The place for a panel whose top-left corner is at (left, top).
export function pixelsToPlace(left,top,stage,panel){
  const roomX=stage.w-panel.w-2*MARGIN,roomY=stage.h-panel.h-2*MARGIN;
  return {x:roomX>0?unit((left-MARGIN)/roomX):0,y:roomY>0?unit((top-MARGIN)/roomY):0};
}

// Put a panel at its place (or the fallback) inside the stage element.
export function placePanel(panel,stage,place){
  const {left,top}=placeToPixels(place,{w:stage.clientWidth,h:stage.clientHeight},{w:panel.offsetWidth,h:panel.offsetHeight});
  panel.style.left=left+'px';panel.style.top=top+'px';panel.style.right='auto';panel.style.bottom='auto';
}
// Drag a panel by its handle; onDrop(place) when it is let go somewhere new. Buttons inside the handle still click as usual.
export function draggable(panel,handle,stage,onDrop){
  let start=null;
  const down=event=>{
    if(event.button!==0||event.target.closest('button,input,select,a'))return;
    start={x:event.clientX,y:event.clientY,left:panel.offsetLeft,top:panel.offsetTop,moved:false};
    handle.setPointerCapture?.(event.pointerId);panel.classList.add('dragging');event.preventDefault();
  };
  const move=event=>{
    if(!start)return;
    const dx=event.clientX-start.x,dy=event.clientY-start.y;if(Math.abs(dx)+Math.abs(dy)>3)start.moved=true;
    const w=stage.clientWidth,h=stage.clientHeight;
    const left=Math.max(MARGIN,Math.min(w-panel.offsetWidth-MARGIN,start.left+dx)),top=Math.max(MARGIN,Math.min(h-panel.offsetHeight-MARGIN,start.top+dy));
    panel.style.left=left+'px';panel.style.top=top+'px';panel.style.right='auto';panel.style.bottom='auto';
  };
  const up=event=>{
    if(!start)return;
    const moved=start.moved;start=null;panel.classList.remove('dragging');handle.releasePointerCapture?.(event.pointerId);
    if(moved)onDrop(pixelsToPlace(panel.offsetLeft,panel.offsetTop,{w:stage.clientWidth,h:stage.clientHeight},{w:panel.offsetWidth,h:panel.offsetHeight}));
  };
  handle.addEventListener('pointerdown',down);handle.addEventListener('pointermove',move);
  handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);
  return ()=>{handle.removeEventListener('pointerdown',down);handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);};
}
