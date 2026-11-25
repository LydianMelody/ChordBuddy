// What every scene shares, drawn on top of it: the chord (top) and the lyrics (bottom). Each has its own band of the screen, so a scene
// can never cover them and they never cover each other; a soft shade behind each keeps them readable over anything.
// A visualization that draws its own words instead (hud:false) uses the same helpers: layoutLyricLine, joinSyllables, halo, FONTS.
// A visualization can choose the font these are drawn in with `overlay` (visual-fonts.js): a style {family, weight, step}. step is the size
// a bitmap (pixel) font was drawn at: sizes then snap to whole multiples of it, and positions to whole pixels, with a hard outline.
import {chordHsl} from './visual-color.js';

const PLAIN={family:'system-ui,sans-serif',weight:null,step:0};
const snapTo=(style,px)=>style.step?Math.max(style.step,Math.round(px/style.step)*style.step):px;
const fontAt=(style,weight,px)=>`${style.weight??weight} ${px}px ${style.family}`;
const whole=(style,v)=>style.step?Math.round(v):v;

// Fonts a visualization can rely on, offline, in the browser and the desktop app. The three named ones are bundled with Chord Buddy
// (web/fonts, loaded by the visualizer before drawing); nothing can be loaded from the internet (the app's security policy blocks it).
export const FONTS={
  ui:'system-ui,"Segoe UI",sans-serif',                                   // the default: plain, very readable
  display:'"Bricolage Grotesque",system-ui,sans-serif',                   // the app's headline face (weights 400-800)
  mono:'"Space Mono",ui-monospace,Consolas,monospace',                    // 400 and 700
  typewriter:'"Courier Prime",ui-monospace,Consolas,monospace',           // 400, 700 and italic
};

// A whole line text, ready to show (lyric.line.text, lyric.next.text). Frames already give lines as they are shown: a dash typed in a word
// stays ("o-owning"), and a word cut into syllables only for timing reads whole. This only removes a leftover hidden split (U+00AD).
export function joinSyllables(text){return String(text??'').replace(/­(?=\s*$)/u,'-').replace(/­/gu,'');}

/** The two reserved bands, in CSS pixels. Scenes may use them for backgrounds, but should keep their focal points out. */
export function hudZones(w,h,lyrics){
  return {chord:{top:0,bottom:h*0.27},lyrics:lyrics?{top:h*0.76,bottom:h}:null};
}

function shaded(g,draw){g.save();g.lineJoin='round';draw();g.restore();}
// Text with a soft dark halo, so it reads over anything (a stroke, not a blurred shadow: blur is very slow to draw).
// pixel: the size of one pixel of a bitmap font, in screen pixels (0: the usual soft halo); the outline is then one hard font pixel wide.
export function halo(g,text,x,y,pixel=0){
  const size=parseFloat(/(\d+(?:\.\d+)?)px/.exec(g.font)?.[1]||16),fill=g.fillStyle;
  if(pixel>0){
    g.save();g.lineJoin='miter';g.miterLimit=2;g.strokeStyle='rgba(5,6,10,.92)';g.lineWidth=pixel*2;g.strokeText(text,Math.round(x),Math.round(y));g.restore();
    g.fillStyle=fill;g.fillText(text,Math.round(x),Math.round(y));return;
  }
  g.strokeStyle='rgba(5,6,10,.28)';g.lineWidth=size*0.28;g.strokeText(text,x,y);
  g.strokeStyle='rgba(5,6,10,.5)';g.lineWidth=size*0.12;g.strokeText(text,x,y);
  g.fillStyle=fill;g.fillText(text,x,y);
}

// Fit a run of words into `max` pixels by shrinking the font, never below `min` px.
function fitFont(g,text,size,max,min,weight,style=PLAIN){
  let s=snapTo(style,size);g.font=fontAt(style,weight,s);
  while(s>min&&g.measureText(text).width>max){
    const next=style.step?s-style.step:Math.max(min,s*0.92);
    if(style.step&&next<style.step)break;                  // a bitmap font has no smaller size than its own
    s=next;g.font=fontAt(style,weight,s);
  }
  return s;
}
const pixelOf=(style,size)=>style.step?size/style.step:0;

export function drawChordHud(g,frame,w,h,{calm=false,style=PLAIN}={}){
  style=style||PLAIN;
  const {chord}=frame,u=Math.min(w,h),cx=w/2,y=whole(style,h*0.13);
  const grad=g.createLinearGradient(0,0,0,h*0.27);grad.addColorStop(0,'rgba(5,6,10,.45)');grad.addColorStop(1,'rgba(5,6,10,0)');
  g.fillStyle=grad;g.fillRect(0,0,w,h*0.27);
  g.textAlign='center';g.textBaseline='middle';
  const label=chord.label??'',size=snapTo(style,u*0.13),px=pixelOf(style,size);
  if(label){
    // a quick swell as each chord begins (not in calm mode; a bitmap font keeps to its whole sizes)
    const fresh=calm||style.step?0:Math.max(0,1-(frame.time-(chord.start??-9))/0.25);
    shaded(g,()=>{g.font=fontAt(style,800,size*(1+0.06*fresh));g.fillStyle='#fff';halo(g,label,cx,y,px);});
    g.fillStyle=chordHsl(label,62,0.9);g.fillRect(whole(style,cx-u*0.06),whole(style,y+size*0.58),whole(style,u*0.12),whole(style,Math.max(3,u*0.006)));
  }
  // a cue from the chart ("pick scratch") sits over the chord in plain words, in no chord's colour
  if(frame.cue)shaded(g,()=>{const s=fitFont(g,frame.cue.text,size*0.3,w*0.6,size*0.18,600,style);g.fillStyle='rgba(235,232,222,.85)';halo(g,frame.cue.text,cx,y-size*0.78,pixelOf(style,s));});
  if(chord.next){
    g.font=fontAt(style,800,size);
    const right=whole(style,cx+Math.max(g.measureText(label||'—').width/2,u*0.08)+u*0.09),r=u*0.042;
    const span=chord.start!==null?chord.next.start-chord.start:4,left=Math.max(0,Math.min(1,chord.timeToNext/Math.max(span,1e-3)));
    g.lineWidth=Math.max(3,u*0.006);g.strokeStyle='rgba(255,255,255,.18)';g.beginPath();g.arc(right,y,r,0,Math.PI*2);g.stroke();
    g.strokeStyle=chordHsl(chord.next.label,66,1);g.beginPath();g.arc(right,y,r,-Math.PI/2,-Math.PI/2+Math.PI*2*left);g.stroke();
    shaded(g,()=>{const s=fitFont(g,chord.next.label,r*0.82,r*1.7,r*0.4,700,style);g.fillStyle=chordHsl(chord.next.label,78,1);halo(g,chord.next.label,right,y,pixelOf(style,s));});
    const rest=chord.upcoming.slice(1).map(c=>c.label).join('   ');
    if(rest)shaded(g,()=>{const s=snapTo(style,u*0.024);g.font=fontAt(style,600,s);g.fillStyle='rgba(235,232,222,.7)';halo(g,rest,cx,y+size*0.95,pixelOf(style,s));});
  }
}

export function drawLyricHud(g,frame,w,h,{style=PLAIN}={}){
  style=style||PLAIN;
  const {lyric}=frame,u=Math.min(w,h),soon=lyric.next&&lyric.next.in<3;
  if(!lyric.line&&!soon)return;
  const grad=g.createLinearGradient(0,h*0.74,0,h);grad.addColorStop(0,'rgba(5,6,10,0)');grad.addColorStop(0.35,'rgba(5,6,10,.5)');grad.addColorStop(1,'rgba(5,6,10,.7)');
  g.fillStyle=grad;g.fillRect(0,h*0.74,w,h*0.26);
  g.textBaseline='middle';
  const lineY=h*0.85,max=w*0.9;
  let nextY=h*0.93;
  if(lyric.line){
    const layout=style.step?stepLayout(g,lyric.words,max,u*0.05,style):layoutLyricLine(g,lyric.words,{maxWidth:max,size:u*0.05,minSize:u*0.02,family:style.family,weight:style.weight??700});
    g.textAlign='left';
    layout.rows.forEach((row,r)=>{
      const y=whole(style,lineY+(r-(layout.rows.length-1)/2)*layout.lineHeight),left=whole(style,w/2-row.width/2);
      for(const part of row.parts)shaded(g,()=>{g.font=layout.font;g.fillStyle=part.state==='now'?'#ffe27a':part.state==='sung'?'#f4f1e8':'rgba(244,241,232,.42)';halo(g,part.text,left+part.x,y,pixelOf(style,layout.size));});
    });
    if(layout.rows.length>1)nextY=lineY+layout.lineHeight+u*0.035;
  }
  if(lyric.next&&(!lyric.line||lyric.line.end-frame.time<4)){
    g.textAlign='center';
    const next=joinSyllables(lyric.next.text);
    const size=fitFont(g,next,u*0.03,max,u*0.018,600,style);
    shaded(g,()=>{g.font=fontAt(style,600,size);g.fillStyle='rgba(244,241,232,.5)';halo(g,next,w/2,lyric.line?Math.min(h-size*0.7,nextY):lineY,pixelOf(style,size));});
  }
  g.textAlign='center';
}

// A line in a bitmap font: the largest whole multiple of its size (at most `size`) at which the words fit in one row or two.
function stepLayout(g,words,maxWidth,size,style){
  let s=snapTo(style,size),layout;
  for(;;){
    layout=layoutLyricLine(g,words,{maxWidth,size:s,minSize:s,readable:s,weight:style.weight??700,family:style.family});
    if(s<=style.step||Math.max(0,...layout.rows.map(r=>r.width))<=maxWidth)return layout;
    s-=style.step;
  }
}

/**
 * Lay out the line being sung (frame.lyric.words) to fit `maxWidth`, the way the shared overlay does: a word cut into syllables for timing
 * (pieces with `joined`) is drawn as one word (each part keeps its own state, so the highlight still moves syllable by syllable); one row while the text stays at
 * least `readable` px, otherwise two rows split between words where they balance best; the font shrinks only as far as `minSize`.
 * Returns {size, font, lineHeight, rows:[{width, parts:[{text, x (from the row's left edge), width, state, index}]}]}; draw each row
 * centred (or aligned) wherever the visualization wants it. No words (no line, or an unplaced one): rows is empty.
 */
export function layoutLyricLine(g,words,{maxWidth,size,minSize=size*0.4,readable=size*0.68,weight=700,family=FONTS.ui}={}){
  const parts=(words||[]).map((x,i,all)=>({text:String(x.text??''),joined:!!x.joined&&i<all.length-1,state:x.state,index:i}));   // joined: the next piece is the same word
  const fontAt=px=>`${weight} ${px}px ${family}`;
  const rowWidth=(list,px)=>{g.font=fontAt(px);const space=g.measureText(' ').width;
    return list.reduce((sum,x,i)=>sum+g.measureText(x.text).width+(!x.joined&&i<list.length-1?space:0),0);};
  let rows=parts.length?[parts]:[];
  if(parts.length&&rowWidth(parts,readable)>maxWidth){
    let best=null;
    for(let i=1;i<parts.length;i++){if(parts[i-1].joined)continue;const widest=Math.max(rowWidth(parts.slice(0,i),size),rowWidth(parts.slice(i),size));if(!best||widest<best.widest)best={i,widest};}
    if(best)rows=[parts.slice(0,best.i),parts.slice(best.i)];
  }
  const px=Math.max(minSize,Math.min(size,...rows.map(r=>size*maxWidth/Math.max(1,rowWidth(r,size)))));
  g.font=fontAt(px);const space=g.measureText(' ').width;
  return {size:px,font:fontAt(px),lineHeight:px*1.25,rows:rows.map(row=>{
    let x=0;const placed=row.map((part,i)=>{const width=g.measureText(part.text).width,item={text:part.text,x,width,state:part.state,index:part.index};x+=width+(part.joined||i===row.length-1?0:space);return item;});
    return {width:x,parts:placed};
  })};
}
