// The MIDI tab: a piano roll to look at and play along with, plus a way out to a program made for editing MIDI.
// It is a viewer on purpose: anyone who wants to change the notes has software for that, so "Editor" sends the file there.
// Saving the MIDI lives in the Export menu with the other ways of saving, so it is in the same place in every view.
//
// It behaves like a DAW's piano roll: the editor fills the space it is given, and its chrome (keys, ruler, scroll bars, borders, labels)
// stays the same size in screen pixels. What you see is decided by two musical scales and an offset:
//   time:  `start` (the second at the left edge) and `pps` (pixels per second)
//   pitch: `top` (the pitch at the top edge, rows count downward) and `rowHeight` (pixels per semitone)
// Resizing the window keeps the scales and shows more or less music. Ctrl+wheel changes the time scale, Ctrl+Shift+wheel the pitch scale.
// "Fit song" is the only thing that fits everything in, and the view a song was left at comes back when it is opened again.
import {renderRail} from './tool-rail.js';
import {createZoomBar} from './zoom-bar.js';
import {prefs} from './prefs.js';

const SVG='http://www.w3.org/2000/svg';
const NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const pitchLabel=pitch=>NAMES[pitch%12]+(Math.floor(pitch/12)-1);
const BLACK=new Set([1,3,6,8,10]);
export const KEYS=54,RULER=26,BAR=16,TRACK_COLOURS=['--a1','--a2','--a3','--hl'];
const BLACK_KEY_SHARE=.6;                         // a black key covers this much of a key's width, like on a piano, so the label sits on clear white
const MAX_PPS=1600,MAX_ROW=40;                    // the closest you can zoom in: about a second across the screen, a semitone 40px tall
const FOLLOW_PAUSE=4000;                          // after you move the roll yourself, it stops following the music for this long (ms)
const OUTLINE=1.5;                                // the ink around a note; drawn inside the note so it never eats into its neighbours

const FRIENDLY={ins:'Instruments',vocal:'Vocal melody',chords:'Chords'};
/** SheetSage calls its tracks Vocal, Ins and Chords; people get the full names. */
export const trackName=(name,index=0)=>FRIENDLY[String(name||'').trim().toLowerCase()]||String(name||'').trim()||'Track '+(index+1);

/** The lowest and highest pitch to show: the notes, with a little air, and never less than an octave. */
export function pitchSpan(notes){
  if(!notes.length)return {low:48,high:72};
  let low=127,high=0;for(const n of notes){if(n.pitch<low)low=n.pitch;if(n.pitch>high)high=n.pitch;}
  low=Math.max(0,low-1);high=Math.min(127,high+1);
  while(high-low<11){if(low>0)low--;if(high-low<11&&high<127)high++;}
  return {low,high};
}
/** Seconds between time labels, so that labels are never closer than about 70px. */
export function tickStep(pxPerSecond){return [.1,.2,.5,1,2,5,10,15,30,60,120,300].find(step=>step*pxPerSecond>=70)||600;}

/**
 * Keeps a view inside the song for a viewport of `width` x `height` pixels: you cannot zoom out past the whole song (or the whole pitch
 * range), nor in past the closest zoom, nor scroll past either end. Only what has to change changes, so a resize keeps the scales.
 */
export function clampView(view,{width,height,duration,pitchLow,pitchHigh}){
  const rows=pitchHigh-pitchLow,fitRow=height/rows;
  const pps=Math.min(Math.max(MAX_PPS,width/Math.max(.001,duration)),Math.max(width/Math.max(.001,duration),view.pps));
  const rowHeight=Math.min(Math.max(MAX_ROW,fitRow),Math.max(fitRow,view.rowHeight));
  const start=Math.max(0,Math.min(view.start,duration-width/pps));
  const top=Math.min(pitchHigh,Math.max(pitchLow+height/rowHeight,view.top));
  return {start,pps,top,rowHeight};
}
/** The first view of a song never opened before: a readable stretch from where the music starts, about seven bars across, centred on the notes. */
export function initialView({width,height,duration,pitchLow,pitchHigh,notes,barSeconds}){
  const bar=Number.isFinite(barSeconds)&&barSeconds>0?barSeconds:2;
  const pps=Math.max(24,Math.min(400,width/(bar*7)));
  const first=notes.length?Math.min(...notes.map(n=>n.start)):0;
  const rowHeight=Math.max(height/(pitchHigh-pitchLow),Math.min(16,Math.max(11,height/30)));
  const middle=notes.length?notes.reduce((sum,n)=>sum+n.pitch,0)/notes.length+.5:(pitchLow+pitchHigh)/2;
  return clampView({start:Math.max(0,first-bar*.5),pps,top:middle+height/rowHeight/2,rowHeight},{width,height,duration,pitchLow,pitchHigh});
}
/** Zoom one axis by `factor` while the point under the pointer (`at`, in pixels from the left or top) stays where it is. */
export function zoomAt(view,axis,factor,at){
  if(axis==='time'){const pps=view.pps*factor,anchor=view.start+at/view.pps;return {...view,pps,start:anchor-at/pps};}
  const rowHeight=view.rowHeight*factor,anchor=view.top-at/view.rowHeight;return {...view,rowHeight,top:anchor+at/rowHeight};
}
/** If the playhead has left the visible time, the start that brings it back in view (a little in from the left edge); otherwise null. */
export function followStart(view,time,width,duration,margin=.12){
  const span=width/view.pps;
  if(time>=view.start&&time<=view.start+span*(1-margin))return null;
  const start=Math.max(0,Math.min(duration-span,time-span*.2));
  return Math.abs(start-view.start)<1e-6?null:start;
}
/**
 * How a note is drawn at the current zoom. Big enough: a filled note with its ink outline inset, so the outline is the same width at
 * every zoom and never covers the fill. Too small for an outline: a plain filled note with a hairline gap, so dense passages stay readable.
 */
export function noteShape(x,y,width,height){
  if(width>=8&&height>=7){
    const half=OUTLINE/2;
    return {outlined:true,x:x+half,y:y+1+half,width:Math.max(1,width-1-OUTLINE),height:Math.max(1,height-2-OUTLINE),rx:Math.min(3,(height-2)/3)};
  }
  return {outlined:false,x,y:y+(height>=4?.5:0),width:Math.max(1.5,width-1),height:Math.max(1,height-(height>=4?1:0)),rx:height>=6?1.5:0};
}
/**
 * The vertical grid lines for the stretch from `start` to `end`, from the song's measured bars (so tempo changes and odd bars are right):
 * every bar, every beat when beats are at least 6px apart, and halves and quarters of a beat when there is room for them (32px and 64px).
 */
export function beatGrid(bars,start,end,pps){
  const lines=[];
  bars.forEach((bar,i)=>{
    const barEnd=Number.isFinite(bar.end)?bar.end:bars[i+1]?.start??bar.start;
    if(barEnd<start||bar.start>end)return;
    if(bar.start>=start&&bar.start<=end)lines.push({time:bar.start,level:'bar'});
    const beats=(bar.beats||[]).filter(b=>b>bar.start+1e-6&&b<barEnd-1e-6),points=[bar.start,...beats,barEnd];
    for(let k=0;k<points.length-1;k++){
      const from=points[k],to=points[k+1],px=(to-from)*pps;
      if(k>0&&px>=6&&from>=start&&from<=end)lines.push({time:from,level:'beat'});
      const parts=px>=64?4:px>=32?2:1;
      for(let p=1;p<parts;p++){const t=from+(to-from)*p/parts;if(t>=start&&t<=end)lines.push({time:t,level:'sub'});}
    }
  });
  return lines;
}
const clock=seconds=>{const s=Math.max(0,seconds);return s<10&&s%1?s.toFixed(1)+'s':Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');};

const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const sv=(tag,attrs={},cls='')=>{const n=document.createElementNS(SVG,tag);for(const k in attrs)n.setAttribute(k,String(attrs[k]));if(cls)n.setAttribute('class',cls);return n;};

export const EDITOR={label:'Editor',title:'Open in another editor',
  body:'Saves the MIDI and opens it in whichever program your computer uses for MIDI files (a digital audio workstation or notation program). Chord Buddy does not read your changes back. To keep a copy, use Export.'};
const HINT='Click to play from there · Ctrl + wheel zooms time, Ctrl + Shift + wheel zooms pitch · the middle button drags the roll';
const SECTION_COLOUR={verse:'--a3',chorus:'--a1',interlude:'--a2',bridge:'--a2'};

/**
 * Draws the piano roll into `container`.
 *   state    {hidden:Set, view:{start,pps,top,rowHeight}|null}  kept by the caller so the view survives a redraw
 *   options  {songId, content, bars:[{start,end,number,beats}], sections, seconds, dock, note, status, onSeek(seconds), onExternal, onError}
 * Returns {update(seconds,playing)}.
 */
export function renderMidiRoll(container,state,options){
  container._roll?.dispose();
  const content=options.content||{notes:[],tracks:[]};
  const tracks=content.tracks?.length?content.tracks:[{name:'Track 1'}];
  const all=(content.notes||[]).map((n,i)=>({...n,i,track:Math.min(Math.max(0,n.track|0),tracks.length-1)}));
  const counts=tracks.map((_,t)=>all.filter(n=>n.track===t).length);
  const live=tracks.map((_,t)=>t).filter(t=>counts[t]>0);        // the tempo track has no notes: nothing to show or hide
  const colourOf=t=>'var('+TRACK_COLOURS[Math.max(0,live.indexOf(t))%TRACK_COLOURS.length]+')';   // the first track with notes is always the first colour
  const span=pitchSpan(all);                                       // the range of the whole piece, so hiding a track never makes the roll jump
  const duration=Math.max(8,content.duration||0,...all.map(n=>n.end));
  const pitchLow=span.low,pitchHigh=span.high+1,rows=pitchHigh-pitchLow;   // pitch p occupies [p, p+1)
  const memory='cb-roll:'+(options.songId||'');
  const say=(text,keep=false)=>{
    const host=options.status;if(!host)return;
    host.replaceChildren(el('span','status-hint',text||HINT));
    if(text&&!keep)clearTimeout(say.timer),say.timer=setTimeout(()=>say(null),7000);
  };

  // --- the rail (Editor) and the bar with the track buttons and Fit song ---
  if(options.dock){
    options.dock.dataset.owner='midi';
    renderRail(options.dock,{groups:[],active:null,onPick(){},actions:[
      {id:'external',label:EDITOR.label,title:EDITOR.title,body:EDITOR.body,run:()=>Promise.resolve(options.onExternal?.()).then(r=>r&&say(r.message,true)).catch(e=>{say(e?.message||String(e),true);options.onError?.(e);})},
    ]});
  }
  const fit=el('button','tl-btn roll-fit','Fit song');fit.type='button';fit.title='Zoom out to the whole song and every pitch in it';
  if(options.note){
    const bar=el('div','tool-controls roll-controls');
    const group=el('div','roll-tracks');group.setAttribute('role','group');group.setAttribute('aria-label','Tracks to show');
    for(const t of live){
      const track=tracks[t];
      const b=el('button','roll-track');b.type='button';b.setAttribute('aria-pressed',String(!state.hidden.has(t)));b.style.setProperty('--tc',colourOf(t));
      b.append(el('i','roll-swatch'),el('span','',trackName(track.name,t)));
      b.title=(state.hidden.has(t)?'Show ':'Hide ')+trackName(track.name,t);
      b.onclick=()=>{state.hidden.has(t)?state.hidden.delete(t):state.hidden.add(t);b.setAttribute('aria-pressed',String(!state.hidden.has(t)));b.title=(state.hidden.has(t)?'Show ':'Hide ')+trackName(track.name,t);schedule();};group.append(b);
    }
    bar.append(group,fit);
    options.note.replaceChildren(bar);
  }
  say(null,true);

  // --- the editor: a grid that fills its box. Ruler and keys are fixed; the notes area takes the rest; the scroll bars hug its edges ---
  //      [corner][ruler      ][     ]
  //      [keys  ][notes      ][pitch]
  //      [      ][time       ][     ]
  const grid=el('div','roll-grid');grid.style.setProperty('--keys',KEYS+'px');grid.style.setProperty('--ruler',RULER+'px');grid.style.setProperty('--bar',BAR+'px');
  const corner=el('div','roll-corner'),rulerCell=el('div','roll-ruler-cell'),keysCell=el('div','roll-keys-cell'),bodyCell=el('div','roll-body-cell');
  const rulerSvg=sv('svg',{},'roll-ruler'),keysSvg=sv('svg',{},'roll-keys'),bodySvg=sv('svg',{},'roll-body');
  rulerCell.append(rulerSvg);keysCell.append(keysSvg);bodyCell.append(bodySvg);
  const size=()=>({width:Math.max(40,bodyCell.clientWidth||600),height:Math.max(40,bodyCell.clientHeight||300)});
  const limits=()=>({...size(),duration,pitchLow,pitchHigh});
  // the view: as it was left, or a readable first view (never the whole song squeezed in)
  const bars=options.bars||[];
  const barSeconds=bars.length>2?(()=>{const lengths=bars.slice(1).map((b,i)=>b.start-bars[i].start).filter(x=>x>0).sort((a,b)=>a-b);return lengths[lengths.length>>1];})():null;
  const fresh=()=>initialView({...limits(),notes:all,barSeconds});
  if(!state.view){
    try{const saved=JSON.parse(prefs.get(memory,'null'));if(saved&&['start','pps','top','rowHeight'].every(k=>Number.isFinite(saved[k])))state.view=saved;}catch{/* fall back */}
  }
  // the view exists before anything asks for it; a first view is only kept once the roll has its real size (it depends on it)
  const current=()=>{if(state.view)return state.view;const v=clampView(fresh(),limits());if(bodyCell.clientWidth>0)state.view=v;return v;};

  let touchedAt=-Infinity,scheduled=false,saveTimer=null;
  const touch=()=>{touchedAt=performance.now();};
  const setView=next=>{
    state.view=clampView(next,limits());schedule();
    clearTimeout(saveTimer);saveTimer=setTimeout(()=>{try{prefs.set(memory,JSON.stringify(state.view));}catch{/* remembering is a nicety */}},400);
  };
  function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;paint();});}

  const timeBar=createZoomBar({slim:true,label:'Time: move or zoom the part of the song you see',bounds:()=>({lo:0,hi:duration}),
    minSpan:()=>size().width/MAX_PPS,onTouch:touch,
    getRange:()=>{const v=current(),{width}=size();return {start:v.start,end:v.start+width/v.pps};},
    setRange:r=>setView({...current(),start:r.start,pps:size().width/Math.max(.001,r.end-r.start)})});
  const pitchBar=createZoomBar({vertical:true,slim:true,label:'Pitch: move or zoom the notes you see',bounds:()=>({lo:0,hi:rows}),
    minSpan:()=>size().height/MAX_ROW,onTouch:touch,
    getRange:()=>{const v=current(),{height}=size(),from=pitchHigh-v.top;return {start:from,end:from+height/v.rowHeight};},
    setRange:r=>setView({...current(),top:pitchHigh-r.start,rowHeight:size().height/Math.max(.001,r.end-r.start)})});
  timeBar.el.classList.add('roll-hbar');pitchBar.el.classList.add('roll-vbar');
  grid.append(corner,rulerCell,el('div','roll-gap top'),keysCell,bodyCell,pitchBar.el,el('div','roll-gap left'),timeBar.el,el('div','roll-gap right'));
  container.replaceChildren(grid);
  container.setAttribute('role','group');

  // the time bar shows the song's sections in their colours; the pitch bar is plain, like an ordinary scroll bar
  const sections=[];
  for(const s of options.sections||[]){
    const key=String(s.name||'').toLowerCase().replace(/[^a-z]/g,'');
    sections.push({from:Math.max(0,s.start),to:Math.min(duration,s.end),colour:'var('+(SECTION_COLOUR[key]||'--tint')+')',opacity:.9});
  }
  timeBar.setPreview(sections.length?sections:[{from:0,to:duration,colour:'var(--tint)'}]);

  fit.onclick=()=>{touch();const {width,height}=size();setView({start:0,pps:width/duration,top:pitchHigh,rowHeight:height/rows});};

  let seconds=options.seconds||0,playing=false,head=null,marker=null,rects=[],shown={start:0,pps:1};
  function paint(){
    if(!grid.isConnected)return;
    const {width,height}=size();
    state.view=clampView(state.view||fresh(),limits());
    const v=state.view;shown=v;
    const xOf=t=>(t-v.start)*v.pps,yOf=p=>(v.top-(p+1))*v.rowHeight,end=v.start+width/v.pps,bottom=v.top-height/v.rowHeight;
    for(const [node,w,h] of [[bodySvg,width,height],[rulerSvg,width,RULER],[keysSvg,KEYS,height]]){node.setAttribute('width',w);node.setAttribute('height',h);node.replaceChildren();}
    container.setAttribute('aria-label',`Piano roll: ${all.filter(n=>!state.hidden.has(n.track)).length} notes in ${live.filter(k=>!state.hidden.has(k)).length} of ${live.length} tracks, from ${pitchLabel(span.low)} to ${pitchLabel(span.high)}. Press play to hear it.`);

    // pitch rows and keys
    const lowPitch=Math.max(pitchLow,Math.floor(bottom)),highPitch=Math.min(pitchHigh-1,Math.ceil(v.top)-1);
    for(let p=highPitch;p>=lowPitch;p--){
      const y=yOf(p),black=BLACK.has(p%12);
      if(black)bodySvg.append(sv('rect',{x:0,y,width,height:v.rowHeight},'roll-row black'));
      keysSvg.append(sv('rect',{x:0,y,width:black?KEYS*BLACK_KEY_SHARE:KEYS,height:v.rowHeight},'roll-key'+(black?' black':'')));
      if(p%12===0){
        bodySvg.append(sv('line',{x1:0,x2:width,y1:Math.round(y+v.rowHeight)+.5,y2:Math.round(y+v.rowHeight)+.5},'roll-octave'));
        const label=sv('text',{x:KEYS-6,y:y+v.rowHeight-Math.max(2,Math.min(4,v.rowHeight/4)),'text-anchor':'end'},'roll-key-label');label.textContent=pitchLabel(p);keysSvg.append(label);
      }
    }
    // time: labels on the ruler (times, or bar numbers: the navigator's TIME / BARS switch), bar lines across the notes
    const barsMode=prefs.get('cb-ruler','time')==='bars'&&bars.length>0;
    const tick=(time,text)=>{
      const x=Math.round(xOf(time))+.5;
      if(!bars.length)bodySvg.append(sv('line',{x1:x,x2:x,y1:0,y2:height},'roll-second'));      // no measured bars: fall back to seconds
      rulerSvg.append(sv('line',{x1:x,x2:x,y1:RULER-8,y2:RULER},'roll-tick'));
      const label=sv('text',{x:x+4,y:RULER-10},'roll-time');label.textContent=text;rulerSvg.append(label);
    };
    const inView=bars.filter(b=>b.start>=v.start-1e-6&&b.start<=end);
    if(barsMode){
      const every=Math.max(1,Math.ceil(54/Math.max(1,(barSeconds||2)*v.pps)));      // labels every few bars when the bars are narrow
      inView.forEach(b=>{if(b.number>=1&&(b.number-1)%every===0)tick(b.start,String(b.number));});
    }else{
      const step=tickStep(v.pps);
      for(let s=Math.ceil(v.start/step)*step;s<=end+1e-9;s+=step)tick(s,clock(s));
    }
    // the grid follows the music: a line at every bar, a fainter one at every beat, and halves and quarters of a beat once there is room
    for(const line of beatGrid(bars,v.start,end,v.pps)){
      const x=Math.round(xOf(line.time))+.5;
      bodySvg.append(sv('line',{x1:x,x2:x,y1:0,y2:height},line.level==='bar'?'roll-bar':line.level==='beat'?'roll-beat':'roll-sub'));
    }
    // notes
    rects=[];
    for(const n of all){
      if(state.hidden.has(n.track)||n.end<v.start||n.start>end||n.pitch<lowPitch||n.pitch>highPitch)continue;
      const shape=noteShape(xOf(n.start),yOf(n.pitch),(n.end-n.start)*v.pps,v.rowHeight);
      const rect=sv('rect',{x:shape.x,y:shape.y,width:shape.width,height:shape.height,rx:shape.rx,'data-i':n.i},'roll-note'+(shape.outlined?'':' flat'));
      rect.style.setProperty('--tc',colourOf(n.track));bodySvg.append(rect);rects.push({rect,n,on:false});
    }
    head=sv('line',{x1:0,x2:0,y1:0,y2:height},'roll-head');bodySvg.append(head);
    marker=sv('path',{d:'M-6 '+(RULER-12)+'h12l-6 12z'},'roll-marker');rulerSvg.append(marker);
    timeBar.refresh();pitchBar.refresh();
    update(seconds,playing);
  }

  function update(time,isPlaying=false){
    seconds=time;playing=isPlaying;if(!head)return;
    if(isPlaying&&performance.now()-touchedAt>FOLLOW_PAUSE){      // the roll follows the music, unless you have just moved it yourself
      const next=followStart(state.view,time,size().width,duration);if(next!==null){state.view={...state.view,start:next};schedule();}
    }
    const x=(time-shown.start)*shown.pps;
    head.setAttribute('transform','translate('+x+' 0)');marker.setAttribute('transform','translate('+x+' 0)');
    for(const item of rects){const on=item.n.start<=time&&time<item.n.end;if(on!==item.on){item.on=on;item.rect.classList.toggle('sounding',on);}}
  }

  // pointer: a click plays from there; hovering a note reads it; the middle button drags the roll like a hand
  const local=(event,node)=>{const r=node.getBoundingClientRect(),w=Number(node.getAttribute('width'))||r.width,h=Number(node.getAttribute('height'))||r.height;
    return {x:(event.clientX-r.left)*(w/(r.width||w)),y:(event.clientY-r.top)*(h/(r.height||h))};};
  const timeAt=(event,node)=>state.view.start+local(event,node).x/state.view.pps;
  bodySvg.addEventListener('pointerdown',event=>{if(event.button===0)options.onSeek?.(Math.max(0,timeAt(event,bodySvg)));});
  rulerSvg.addEventListener('pointerdown',event=>{if(event.button===0)options.onSeek?.(Math.max(0,timeAt(event,rulerSvg)));});
  bodySvg.addEventListener('pointermove',event=>{
    const i=event.target?.dataset?.i;if(i===undefined){say(null,true);return;}
    const n=all[Number(i)];if(!n)return;
    say(`${trackName(tracks[n.track]?.name,n.track)} · ${pitchLabel(n.pitch)} · ${n.start.toFixed(2)}–${n.end.toFixed(2)} s · velocity ${n.velocity}`,true);
  });
  bodySvg.addEventListener('pointerleave',()=>say(null,true));
  for(const area of [bodyCell,keysCell,rulerCell])area.addEventListener('pointerdown',event=>{
    if(event.button!==1)return;
    event.preventDefault();event.stopPropagation();touch();
    try{area.setPointerCapture?.(event.pointerId);}catch{/* the drag still works without capture */}
    let x=event.clientX,y=event.clientY;grid.classList.add('grabbing');
    const move=e=>{touch();const v=state.view;setView({...v,start:v.start-(e.clientX-x)/v.pps,top:v.top+(e.clientY-y)/v.rowHeight});x=e.clientX;y=e.clientY;};
    const done=()=>{grid.classList.remove('grabbing');area.removeEventListener('pointermove',move);area.removeEventListener('pointerup',done);area.removeEventListener('pointercancel',done);};
    area.addEventListener('pointermove',move);area.addEventListener('pointerup',done);area.addEventListener('pointercancel',done);
  });
  // the wheel, as in a DAW: it scrolls the pitches; Shift (or a sideways wheel) scrolls time; Ctrl zooms time; Ctrl + Shift zooms pitch.
  // It never reaches the page, so the page-wide zoom never scales the roll's frame.
  for(const area of [bodyCell,keysCell,rulerCell])area.addEventListener('wheel',event=>{
    event.preventDefault();event.stopPropagation();touch();
    const v=state.view,at=local(event,bodySvg),notch=event.deltaY<0?1.15:1/1.15;
    if((event.ctrlKey||event.metaKey||event.altKey)&&event.shiftKey)setView(zoomAt(v,'pitch',notch,Math.max(0,at.y)));
    else if(event.ctrlKey||event.metaKey||event.altKey)setView(zoomAt(v,'time',notch,Math.max(0,at.x)));
    else if(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)){const d=event.shiftKey?event.deltaY:event.deltaX;setView({...v,start:v.start+d/v.pps});}
    else setView({...v,top:v.top-event.deltaY/v.rowHeight});
  },{passive:false});

  const onRuler=()=>schedule();window.addEventListener('chordbuddy:ruler',onRuler);
  let observer=null,last='';
  if(typeof ResizeObserver==='function'){                          // a bigger window shows more music at the same scale, never stretched notes
    observer=new ResizeObserver(()=>{const {width,height}=size(),key=width+'x'+height;if(key!==last){last=key;schedule();}});observer.observe(bodyCell);
  }
  container._roll={dispose(){observer?.disconnect();timeBar.dispose();pitchBar.dispose();clearTimeout(say.timer);if(saveTimer){clearTimeout(saveTimer);try{if(state.view)prefs.set(memory,JSON.stringify(state.view));}catch{/* a nicety */}}window.removeEventListener('chordbuddy:ruler',onRuler);}};
  paint();
  return {update};
}
