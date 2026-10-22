// What every scene shares, drawn on top of it: the chord (top) and the lyrics (bottom). Each has its own band of the screen, so a scene
// can never cover them and they never cover each other; a soft shade behind each keeps them readable over anything.
import {chordHsl} from './visual-color.js';

/** The two reserved bands, in CSS pixels. Scenes may use them for backgrounds, but should keep their focal points out. */
export function hudZones(w,h,lyrics){
  return {chord:{top:0,bottom:h*0.27},lyrics:lyrics?{top:h*0.76,bottom:h}:null};
}

function shaded(g,draw){g.save();g.lineJoin='round';draw();g.restore();}
// Text with a soft dark halo, so it reads over anything (a stroke, not a blurred shadow: blur is very slow to draw).
function halo(g,text,x,y){
  const size=parseFloat(/(\d+(?:\.\d+)?)px/.exec(g.font)?.[1]||16),fill=g.fillStyle;
  g.strokeStyle='rgba(5,6,10,.28)';g.lineWidth=size*0.28;g.strokeText(text,x,y);
  g.strokeStyle='rgba(5,6,10,.5)';g.lineWidth=size*0.12;g.strokeText(text,x,y);
  g.fillStyle=fill;g.fillText(text,x,y);
}

// Fit a run of words into `max` pixels by shrinking the font, never below `min` px.
function fitFont(g,text,size,max,min,weight){
  let s=size;g.font=`${weight} ${s}px system-ui,sans-serif`;
  while(s>min&&g.measureText(text).width>max){s=Math.max(min,s*0.92);g.font=`${weight} ${s}px system-ui,sans-serif`;}
  return s;
}

export function drawChordHud(g,frame,w,h,{calm=false}={}){
  const {chord}=frame,u=Math.min(w,h),cx=w/2,y=h*0.13;
  const grad=g.createLinearGradient(0,0,0,h*0.27);grad.addColorStop(0,'rgba(5,6,10,.45)');grad.addColorStop(1,'rgba(5,6,10,0)');
  g.fillStyle=grad;g.fillRect(0,0,w,h*0.27);
  g.textAlign='center';g.textBaseline='middle';
  const label=chord.label??'',size=u*0.13;
  if(label){
    // a quick swell as each chord begins (not in calm mode)
    const fresh=calm?0:Math.max(0,1-(frame.time-(chord.start??-9))/0.25);
    shaded(g,()=>{g.font=`800 ${size*(1+0.06*fresh)}px system-ui,sans-serif`;g.fillStyle='#fff';halo(g,label,cx,y);});
    g.fillStyle=chordHsl(label,62,0.9);g.fillRect(cx-u*0.06,y+size*0.58,u*0.12,Math.max(3,u*0.006));
  }
  if(chord.next){
    g.font=`800 ${size}px system-ui,sans-serif`;
    const right=cx+Math.max(g.measureText(label||'—').width/2,u*0.08)+u*0.09,r=u*0.042;
    const span=chord.start!==null?chord.next.start-chord.start:4,left=Math.max(0,Math.min(1,chord.timeToNext/Math.max(span,1e-3)));
    g.lineWidth=Math.max(3,u*0.006);g.strokeStyle='rgba(255,255,255,.18)';g.beginPath();g.arc(right,y,r,0,Math.PI*2);g.stroke();
    g.strokeStyle=chordHsl(chord.next.label,66,1);g.beginPath();g.arc(right,y,r,-Math.PI/2,-Math.PI/2+Math.PI*2*left);g.stroke();
    shaded(g,()=>{fitFont(g,chord.next.label,r*0.82,r*1.7,r*0.4,700);g.fillStyle=chordHsl(chord.next.label,78,1);halo(g,chord.next.label,right,y);});
    const rest=chord.upcoming.slice(1).map(c=>c.label).join('   ');
    if(rest)shaded(g,()=>{g.font=`600 ${u*0.024}px system-ui,sans-serif`;g.fillStyle='rgba(235,232,222,.7)';halo(g,rest,cx,y+size*0.95);});
  }
}

export function drawLyricHud(g,frame,w,h){
  const {lyric}=frame,u=Math.min(w,h),soon=lyric.next&&lyric.next.in<3;
  if(!lyric.line&&!soon)return;
  const grad=g.createLinearGradient(0,h*0.74,0,h);grad.addColorStop(0,'rgba(5,6,10,0)');grad.addColorStop(0.35,'rgba(5,6,10,.5)');grad.addColorStop(1,'rgba(5,6,10,.7)');
  g.fillStyle=grad;g.fillRect(0,h*0.74,w,h*0.26);
  g.textBaseline='middle';
  const lineY=h*0.85,max=w*0.9;
  let nextY=h*0.93;
  if(lyric.line){
    // a syllable split for timing ("ex-" "pected") is shown as one word, each part still lit on its own
    const parts=lyric.words.map((x,i)=>{const joined=x.text.endsWith('-')&&i<lyric.words.length-1;return {...x,shown:joined?x.text.slice(0,-1):x.text,joined};});
    // one row while it stays big enough to read; otherwise two rows, split between words where they balance best
    const rowWidth=(list,size)=>{g.font=`700 ${size}px system-ui,sans-serif`;const space=g.measureText(' ').width;
      return list.reduce((sum,x,i)=>sum+g.measureText(x.shown).width+(!x.joined&&i<list.length-1?space:0),0);};
    const big=u*0.05,readable=u*0.034;
    let rows=[parts];
    if(rowWidth(parts,readable)>max){
      let best=null;
      for(let i=1;i<parts.length;i++){if(parts[i-1].joined)continue;const widest=Math.max(rowWidth(parts.slice(0,i),big),rowWidth(parts.slice(i),big));if(!best||widest<best.widest)best={i,widest};}
      if(best)rows=[parts.slice(0,best.i),parts.slice(best.i)];
    }
    const size=Math.max(u*0.02,Math.min(big,...rows.map(r=>big*max/Math.max(1,rowWidth(r,big)))));
    rows.forEach((row,r)=>{
      const total=rowWidth(row,size),space=g.measureText(' ').width,y=rows.length>1?lineY+(r-0.5)*size*1.25:lineY;
      let x=w/2-total/2;g.textAlign='left';
      row.forEach((word,i)=>{
        shaded(g,()=>{g.font=`700 ${size}px system-ui,sans-serif`;g.fillStyle=word.state==='now'?'#ffe27a':word.state==='sung'?'#f4f1e8':'rgba(244,241,232,.42)';halo(g,word.shown,x,y);});
        x+=g.measureText(word.shown).width+(word.joined?0:space);
      });
    });
    if(rows.length>1)nextY=lineY+size*1.25+u*0.035;
  }
  if(lyric.next&&(!lyric.line||lyric.line.end-frame.time<4)){
    g.textAlign='center';
    const next=lyric.next.text.replace(/(\S)-\s+(?=\S)/g,'$1');                // syllables rejoined, as above
    const size=fitFont(g,next,u*0.03,max,u*0.018,600);
    shaded(g,()=>{g.font=`600 ${size}px system-ui,sans-serif`;g.fillStyle='rgba(244,241,232,.5)';halo(g,next,w/2,lyric.line?Math.min(h-size*0.7,nextY):lineY);});
  }
  g.textAlign='center';
}
