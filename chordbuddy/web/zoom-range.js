// The arithmetic behind a zoomable scroll bar: a range (start..end) of some total (lo..hi) that can be moved, stretched or squeezed,
// and always stays inside the total and never gets thinner than `minSpan`.

/** Keep a range inside lo..hi without changing how wide it is (and never thinner than minSpan, never wider than the total). */
export function clampRange(start,end,lo,hi,minSpan=0){
  const total=Math.max(0,hi-lo),span=Math.max(Math.min(minSpan,total),Math.min(end-start,total));
  const from=Math.min(Math.max(start,lo),hi-span);
  return {start:from,end:from+span};
}
/** Slide the range by `delta`. */
export const panRange=(range,delta,lo,hi)=>clampRange(range.start+delta,range.end+delta,lo,hi);
/** Make the range `factor` times as wide (below 1 zooms in), keeping `anchor` where it is on the bar. */
export function zoomRange(range,factor,anchor,lo,hi,minSpan){
  const span=range.end-range.start,floor=Math.min(minSpan,hi-lo),next=Math.max(floor,Math.min(hi-lo,span*factor));
  const ratio=span?Math.max(0,Math.min(1,(anchor-range.start)/span)):.5,start=anchor-ratio*next;
  return clampRange(start,start+next,lo,hi,floor);
}
/** Drag one end of the range to `value`; the other end stays put. */
export function resizeRange(range,edge,value,lo,hi,minSpan){
  const floor=Math.min(minSpan,hi-lo);
  if(edge==='start')return {start:Math.max(lo,Math.min(range.end-floor,value)),end:range.end};
  return {start:range.start,end:Math.min(hi,Math.max(range.start+floor,value))};
}
/** Move the range so that `at` is in its middle. */
export function centerRange(range,at,lo,hi){const half=(range.end-range.start)/2;return clampRange(at-half,at+half,lo,hi);}
