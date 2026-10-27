// The playback keys, the same in the main window and in a visualizer (which sends them to the player over the visual bridge):
//   Space          play / pause                 R                 loop the section you are in (again: stop looping)
//                                               L                 loop four bars, or the repeated phrase you are in (again: stop)
//   Left / Right   the previous / next bar      Ctrl+Left / Right the previous / next section
// Pure: playbackAction() reads a key event, and targetSeconds() works out where a bar or section jump lands.

/** The action for a keydown event, or null when the key is not a playback key (or belongs to whatever has focus). A held key repeats
 *  only the bar and section jumps: `repeat` is set on the others so the caller can swallow the key without acting again. */
export function playbackAction(event){
  if(event.defaultPrevented||event.altKey||event.metaKey)return null;
  const t=event.target;
  if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||'')))return null;     // typing, or a slider moving itself
  if(t?.closest?.('[role="scrollbar"],dialog[open]'))return null;
  const key=event.key,repeat=!!event.repeat;
  if((key===' '||event.code==='Space')&&!event.ctrlKey&&!event.shiftKey)return {type:'toggle',repeat};
  if((key==='r'||key==='R')&&!event.ctrlKey&&!event.shiftKey)return {type:'loop',repeat};
  if((key==='l'||key==='L')&&!event.ctrlKey&&!event.shiftKey)return {type:'loop',kind:'bars',repeat};
  if((key==='ArrowLeft'||key==='ArrowRight')&&!event.shiftKey)return {type:event.ctrlKey?'section':'bar',direction:key==='ArrowLeft'?-1:1,repeat:false};
  return null;
}

// Back goes to the start of the bar (or section) you are in, or to the one before when you are at its very start, so pressing it
// twice quickly steps back twice even while the song plays on. Forward goes to the next start.
const GRACE=.35;
/** starts: the times bars (or sections) begin, in order. Returns the time to seek to, or null when there is nowhere to go. */
export function targetSeconds(starts,seconds,direction){
  const list=starts.filter(Number.isFinite);
  if(direction<0){
    const before=list.filter(t=>t<=seconds-GRACE);
    if(before.length)return before.at(-1);
    return list.length&&list[0]<seconds?list[0]:null;
  }
  return list.find(t=>t>seconds+.05)??null;
}
