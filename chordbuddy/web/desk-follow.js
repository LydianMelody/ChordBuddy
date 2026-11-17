// While the music plays, the chord chart and the lead sheet scroll to keep the playing line in view. Scroll the page yourself (the wheel,
// a touch, the scroll keys, the scroll bars) and they stop following, so you can read ahead or look back while the song keeps going.
// Following comes back when:
//   - you press "Back to the music" (it appears at the bottom of the page while you are scrolled away),
//   - you seek or jump anywhere, or press play again,
//   - or the playing line comes back into view on its own (the music catches up to where you scrolled).
// The MIDI piano roll has its own short pause (midi-view.js) because it scrolls sideways under your hand.

const holds=new WeakMap();      // desk -> {held, button}

/** True while the reader has scrolled away from the music on this desk. */
export function followHeld(desk){return !!holds.get(desk)?.held;}

/** The playing line is back in view: follow again. */
export function releaseFollow(desk){const h=holds.get(desk);if(h?.held){h.held=false;h.paint();}}

const SCROLL_KEYS=new Set(['PageUp','PageDown','Home','End','ArrowUp','ArrowDown']);

/**
 * stage: the element around the desk (the button sits in it); desk: the scrolling page.
 * Returns {observe(snapshot), dispose()}: call observe with every transport snapshot, so a seek or a new press of play follows again.
 */
export function mountDeskFollow(stage,desk,{active=()=>true}={}){
  const button=document.createElement('button');
  button.type='button';button.className='back-to-music';button.hidden=true;
  button.textContent='Back to the music';
  button.title='The page stopped following the song because you scrolled. Click to jump back to what is playing and follow it again.';
  stage.append(button);
  let playing=false,seeks=null,intent=false;
  const h={held:false,paint(){button.hidden=!(h.held&&playing);}};
  holds.set(desk,h);
  const hold=()=>{if(!h.held&&active()){h.held=true;h.paint();}};    // active: a view that follows the music is open
  const onKey=e=>{
    if(!SCROLL_KEYS.has(e.key)||e.ctrlKey||e.altKey||e.metaKey)return;
    const t=e.target;if(t?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
    hold();
  };
  // a press on the desk's own scroll bar (the target is the desk itself), or on the cassette bars that stand in for it in the Time tool
  const onDown=e=>{if(e.target===desk||e.target?.closest?.('.desk-bar'))hold();};
  desk.addEventListener('wheel',hold,{passive:true});
  desk.addEventListener('touchmove',hold,{passive:true});
  desk.addEventListener('keydown',onKey);
  stage.addEventListener('pointerdown',onDown);
  button.addEventListener('click',()=>{
    h.held=false;h.paint();
    const now=desk.querySelector('.chunk.now, .ending-chord.now, .current-beat');
    now?.scrollIntoView?.({block:'center',behavior:'smooth'});
  });
  return {
    observe(snap){
      if(seeks!==null&&snap.seeks!==seeks)h.held=false;            // you moved the playhead: follow from there
      if(snap.playIntent&&!intent)h.held=false;                     // a new press of play follows again
      seeks=snap.seeks;intent=!!snap.playIntent;playing=intent;h.paint();
    },
    dispose(){
      desk.removeEventListener('wheel',hold);desk.removeEventListener('touchmove',hold);desk.removeEventListener('keydown',onKey);
      stage.removeEventListener('pointerdown',onDown);button.remove();holds.delete(desk);
    },
  };
}
