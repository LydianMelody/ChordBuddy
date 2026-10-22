// Machine: a brass-and-steam music machine.
//   Melody + vocal MIDI -> a player-piano roll scrolls up into the tracker bar. Each hole opens its pipe exactly as the note starts;
//                          pipes rise with pitch, so steam leaves at a height set by the note. The roll also carries chord changes and the beat grid.
//   Drum hits           -> the hammer lifts ahead of each strong hit (looked up in song time) and lands on it; lighter hits ring the bell.
//   Bass                -> the weight in the glass ram rises with the bass and jumps on bass hits.
//   Lead guitar         -> the climbing arc (Jacob's ladder) beside the ram: it climbs faster the louder the lead, and restarts on lead hits.
//   Rhythm guitar       -> the chord-colored lamps on the wind chest flare on each strum.
//   Piano               -> the felt hammers of the little action on the left strike the brass bar on piano hits, in turn.
//   Other               -> steam wisps leak from the flanges of the main along the back wall, thicker as the track gets louder.
//   Bars / beats        -> the flywheel turns once per bar (crank at the top on the downbeat); its hub lamp blinks on each beat.
//   Chords              -> the top CRT (current, next, time left); chest lamps take the chord color.
//   Lyrics              -> the bottom CRT, with a wipe across the word being sung.
import {chordColor} from '../visual-color.js';

const TAU=Math.PI*2;
const MONO='Consolas,"Cascadia Mono","Lucida Console",ui-monospace,Menlo,monospace';   // one terminal face throughout
const SANS=MONO;
const noChord=l=>!l||/^(N|N\.?C\.?|X)$/i.test(String(l).trim()); // the chart writes silence as "N"
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const easeInOut=x=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const easeOut=x=>1-Math.pow(1-x,3);
const after=(a,t)=>{let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m].start<=t)lo=m+1;else hi=m;}return lo;};
const rng=seed=>{let s=seed;return()=>(s=s*16807%2147483647)/2147483647;};
const mkCanvas=(w,h)=>{const c=document.createElement('canvas');c.width=Math.max(1,Math.ceil(w));c.height=Math.max(1,Math.ceil(h));return c;};
const TRACKS=[{name:'melody',hue:188},{name:'vocal',hue:36},{name:'instrumental',hue:280}];
const LYR={sung:'hsl(42,92%,80%)',now:'hsl(50,100%,93%)',ahead:'hsl(36,26%,58%)',next:'hsl(36,22%,50%)',glow:'hsla(38,100%,60%,0.22)'};
const dehyph=s=>String(s).replace(/([A-Za-z\u00C0-\u024F'])-(?=[A-Za-z\u00C0-\u024F])/g,'$1'); // syllable hyphens from timed lyrics
const BRASS=[40,46,42],COPPER=[20,50,40],IRON=[24,8,24];

function analyze(song){
  const midi=song?.midi||{};
  let tracks=TRACKS.slice(0,2).map(d=>({...d,notes:midi[d.name]?.notes||[]})).filter(d=>d.notes.length);
  if(!tracks.length&&midi.instrumental?.notes?.length)tracks=[{...TRACKS[2],notes:midi.instrumental.notes}];
  const all=[];
  for(const tr of tracks){
    tr.notes=tr.notes.filter(n=>n&&n.end>n.start).slice().sort((a,b)=>a.start-b.start);
    tr.maxDur=Math.min(30,tr.notes.reduce((m,n)=>Math.max(m,n.end-n.start),0));
    for(const n of tr.notes)all.push(n.pitch);
  }
  all.sort((a,b)=>a-b);
  let lo=60,hi=79;
  if(all.length){lo=all[Math.floor(all.length*0.02)];hi=all[Math.min(all.length-1,Math.floor(all.length*0.98))];}
  if(hi-lo>35){const m=Math.round((lo+hi)/2);lo=m-17;hi=m+18;}
  while(hi-lo<15){lo--;if(hi-lo<15)hi++;}
  const hits=(song?.features?.tracks?.drums?.hits||[]).slice().sort((a,b)=>a.start-b.start);
  let thr=0;const strong=[];
  if(hits.length){
    const s=hits.map(h=>h.strength||0).sort((a,b)=>a-b);thr=Math.max(0.2,s[Math.floor(s.length*0.7)]);
    let last=-1;for(const h of hits)if((h.strength||0)>=thr&&h.start-last>0.16){strong.push(h);last=h.start;}
  }
  return {tracks,lo,hi,n:hi-lo+1,strong,thr};
}

export default {
  id:'machine',
  name:'Machine',
  order:40,
  hud:false,   // the machine's own CRTs show the chord and the lyrics
  create(){
    let w=0,h=0,k=1,L=null,layKey='',info=null,infoKey='',songRef=null;
    let bg=null,front=null,scan=null,vig=null,fly=null,head=null,weight=null,puff=null,glowFire=null,glowBell=null;
    const glowHue=[],glowTrk={};
    let hue=30,lastT=null,shake=0,anvilGlow=0,bellTap=0,beatLamp=0,chase=-9;
    let ramPos=0.1,ramVel=0,bassS=0,vocS=0;
    let leadS=0,arcH=0,arcHit=0,rhyS=0,rhyFlare=0,otherS=0,leakAcc=0,pianoIdx=0,arcSeed=1;
    const pianoH=new Float32Array(5);let glowArc=null;
    let chordCur,chordPrev=null,chordWall=-9;
    let lit=null,litHue=null,acc=null,prevKeys=new Set();
    const steam=[],sparks=[],rings=[];
    let lyr={key:''};
    const rnd=Math.random;

    const rr=(x,X,Y,W,H,r)=>{x.beginPath();x.roundRect(X,Y,W,H,r);};
    function rivet(x,X,Y,r){
      x.fillStyle='hsl(24,12%,5%)';x.beginPath();x.arc(X,Y+r*0.35,r*1.1,0,TAU);x.fill();
      x.fillStyle='hsl(28,14%,20%)';x.beginPath();x.arc(X,Y,r,0,TAU);x.fill();
      x.fillStyle='hsla(35,40%,72%,0.28)';x.beginPath();x.arc(X-r*0.3,Y-r*0.35,r*0.4,0,TAU);x.fill();
    }
    function metal(x,x0,y0,x1,y1,m,l=m[2]){
      const [hh,s]=m,gr=x.createLinearGradient(x0,y0,x1,y1);
      gr.addColorStop(0,`hsl(${hh},${s}%,${l*0.4}%)`);gr.addColorStop(0.3,`hsl(${hh},${s}%,${l}%)`);
      gr.addColorStop(0.45,`hsl(${hh},${s+8}%,${Math.min(88,l*1.55)}%)`);gr.addColorStop(0.65,`hsl(${hh},${s}%,${l*0.85}%)`);
      gr.addColorStop(1,`hsl(${hh},${s}%,${l*0.3}%)`);return gr;
    }
    function off(W,H){const c=mkCanvas(W*k,H*k),x=c.getContext('2d');x.scale(k,k);return [c,x];}
    function glowSprite(col){
      const c=mkCanvas(64,64),x=c.getContext('2d'),gr=x.createRadialGradient(32,32,0,32,32,32);
      gr.addColorStop(0,col(1));gr.addColorStop(0.3,col(0.35));gr.addColorStop(1,col(0));x.fillStyle=gr;x.fillRect(0,0,64,64);return c;
    }
    const pipeX=i=>L.cx0+(i+0.5)*L.pw;
    const pidx=p=>{while(p<info.lo)p+=12;while(p>info.hi)p-=12;return clamp(p-info.lo,0,info.n-1);};

    function ensureInfo(song){
      const key=(song?.features?.tracks?.drums?.hits?.length||0)+'|'+Object.entries(song?.midi||{}).map(([a,b])=>a+(b?.notes?.length||0)).join(',');
      if(song===songRef&&key===infoKey&&info)return;
      songRef=song;infoKey=key;info=analyze(song);
      lit=new Float32Array(info.n);litHue=new Float32Array(info.n);acc=new Float32Array(info.n);prevKeys=new Set();layKey='';
    }

    function makeLayout(zc,zl){
      const u=Math.min(w,h),top=zc.bottom,bot=zl?zl.top:h*0.97,M=Math.max(bot-top,h*0.3);
      const n=info.n,cx0=w*0.30,cx1=w*0.68,pw=(cx1-cx0)/n,pb=Math.max(2,pw*0.62);
      const chestY=top+M*0.5,chestH=Math.max(u*0.024,M*0.06),trackY=chestY+chestH,trackH=Math.max(3,u*0.012),barY=trackY+trackH;
      const ptop=[];for(let i=0;i<n;i++)ptop.push(chestY-M*(0.12+0.46*(n>1?i/(n-1):0.5)));
      const tape={x0:cx0-u*0.085,x1:cx1+u*0.015,y0:barY,y1:h,lab:cx0-u*0.012};
      const Lh=Math.min(u*0.17,w*0.095),headW=u*0.05,headH=u*0.088,ax=w*0.17,aTop=top+M*0.7;
      const R=Math.min(u*0.16,w*0.085);
      const zh=zc.bottom-zc.top,ch=zh*0.74,cw=Math.min(w*0.36,ch*3.1);
      let lyric=null;
      if(zl){const lh=zl.bottom-zl.top,lw=Math.min(w*0.64,w-u*0.08),lH=lh*0.74;lyric={x:(w-lw)/2,y:zl.top+lh*0.13,w:lw,h:lH,pad:lH*0.09,rad:lH*0.18};}
      const sw=Math.min(w*0.15,u*0.27);
      const lamps=[],nl=Math.max(5,Math.round((cx1-cx0)/(u*0.07)));for(let i=0;i<nl;i++)lamps.push(cx0+(i+0.5)*(cx1-cx0)/nl);
      return {u,top,bot,M,n,cx0,cx1,pw,pb,chestY,chestH,trackY,trackH,barY,ptop,floorY:h*0.955,tape,
        speed:Math.max(u*0.1,bot-barY)/2.2,Lh,headW,headH,ax,aTop,px:ax-Lh,py:aTop-headH/2,
        bx:w*0.245,br:u*0.03,by:top+M*0.24,R,fx:w*0.885,fy:top+M*0.36,Rc:R*0.42,Lr:R*1.2,
        rx:w*0.765,rw:u*0.05,rTop:top+M*0.1,rBot:top+M*0.92,capH:u*0.028,pipeY:top+M*0.07,
        chord:{x:(w-cw)/2,y:zc.top+zh*0.13,w:cw,h:ch,pad:ch*0.09,rad:ch*0.16},lyric,
        jx:0,jw:0,jB:0,jT:0,pn:null,
        sect:{x:w-u*0.035-sw,y:zc.top+zh*0.2,w:sw,h:zh*0.34},lamps,grads:null};
    }

    function extraLayout(){
      const u=L.u,pr=u*0.016,midC=L.chestY+L.chestH*0.5,left=L.cx1+u*0.045+pr,right=L.rx-L.rw*0.82;
      L.jx=(left+right)/2;L.jw=Math.max(u*0.02,Math.min(u*0.06,right-left-u*0.012));L.jB=midC-pr-u*0.032;L.jT=L.top+L.M*0.13;
      const x0=w*0.19,x1=Math.min(w*0.262,L.cx0-u*0.06);
      L.pn={x0,x1,sY:L.top+L.M*0.37,pY:L.top+L.M*0.52,hr:Math.max(2,u*0.009)};
    }
    function bezel(x,R){
      const p=R.pad,o={x:R.x-p,y:R.y-p,w:R.w+2*p,h:R.h+2*p};
      x.fillStyle='rgba(0,0,0,0.55)';rr(x,o.x+p*0.15,o.y+p*0.45,o.w,o.h,p*1.5);x.fill();
      let gr=x.createLinearGradient(0,o.y,0,o.y+o.h);gr.addColorStop(0,'hsl(28,10%,21%)');gr.addColorStop(1,'hsl(24,10%,9%)');
      x.fillStyle=gr;rr(x,o.x,o.y,o.w,o.h,p*1.5);x.fill();
      x.strokeStyle='hsla(35,40%,80%,0.12)';x.lineWidth=1.2;rr(x,o.x+0.6,o.y+0.6,o.w-1.2,o.h-1.2,p*1.5);x.stroke();
      x.fillStyle='hsl(20,10%,3%)';rr(x,R.x-p*0.3,R.y-p*0.3,R.w+p*0.6,R.h+p*0.6,R.rad+p*0.3);x.fill();
      x.strokeStyle='hsla(35,30%,70%,0.10)';x.lineWidth=1;rr(x,R.x-p*0.3+0.5,R.y-p*0.3+0.5,R.w+p*0.6-1,R.h+p*0.6-1,R.rad+p*0.3);x.stroke();
      gr=x.createRadialGradient(R.x+R.w/2,R.y+R.h/2,0,R.x+R.w/2,R.y+R.h/2,Math.max(R.w,R.h)*0.6);
      gr.addColorStop(0,'hsl(30,14%,8.5%)');gr.addColorStop(1,'hsl(30,10%,4%)');x.fillStyle=gr;rr(x,R.x,R.y,R.w,R.h,R.rad);x.fill();
      for(const [X,Y] of [[o.x+p*0.55,o.y+p*0.55],[o.x+o.w-p*0.55,o.y+p*0.55],[o.x+p*0.55,o.y+o.h-p*0.55],[o.x+o.w-p*0.55,o.y+o.h-p*0.55]])rivet(x,X,Y,p*0.16);
    }
    function scanOver(x,R){
      const cx=R.x+R.w/2,cy=R.y+R.h/2,bow=R.h*0.045;
      x.save();rr(x,R.x,R.y,R.w,R.h,R.rad);x.clip();
      // interlace: dark lines every 3 px, bowed outward from the middle like a curved tube face
      x.strokeStyle='rgba(0,0,0,0.34)';x.lineWidth=1.4;x.beginPath();
      for(let Y=R.y-bow;Y<R.y+R.h+bow;Y+=3){const d=(Y-cy)/(R.h/2);x.moveTo(R.x,Y);x.quadraticCurveTo(cx,Y+bow*d*-1,R.x+R.w,Y);}
      x.stroke();
      x.strokeStyle='rgba(255,235,200,0.025)';x.lineWidth=1;x.beginPath();
      for(let Y=R.y-bow+1.5;Y<R.y+R.h+bow;Y+=3){const d=(Y-cy)/(R.h/2);x.moveTo(R.x,Y);x.quadraticCurveTo(cx,Y+bow*d*-1,R.x+R.w,Y);}
      x.stroke();
      // convex falloff toward the edges and corners
      x.save();x.translate(cx,cy);x.scale(R.w/2,R.h/2);
      let gr=x.createRadialGradient(0,0,0.55,0,0,1.42);gr.addColorStop(0,'rgba(0,0,0,0)');gr.addColorStop(0.6,'rgba(0,0,0,0.28)');gr.addColorStop(1,'rgba(0,0,0,0.8)');
      x.fillStyle=gr;x.fillRect(-1,-1,2,2);x.restore();
      // curved glare across the upper left of the glass
      x.save();x.translate(R.x+R.w*0.3,R.y+R.h*0.12);x.scale(R.w*0.42,R.h*0.3);
      gr=x.createRadialGradient(0,0,0,0,0,1);gr.addColorStop(0,'rgba(255,245,230,0.075)');gr.addColorStop(1,'rgba(255,245,230,0)');
      x.fillStyle=gr;x.beginPath();x.arc(0,0,1,0,TAU);x.fill();x.restore();
      // glass edge: inner shadow ring + thin rim light
      x.strokeStyle='rgba(0,0,0,0.6)';x.lineWidth=R.h*0.05;rr(x,R.x,R.y,R.w,R.h,R.rad);x.stroke();
      x.strokeStyle='rgba(255,235,210,0.07)';x.lineWidth=1.2;rr(x,R.x+R.h*0.03,R.y+R.h*0.03,R.w-R.h*0.06,R.h-R.h*0.06,R.rad*0.85);x.stroke();
      x.restore();
    }
    function buildArt(){
      const u=L.u;let x,gr;
      if(!puff){
        puff=mkCanvas(64,64);x=puff.getContext('2d');gr=x.createRadialGradient(32,32,0,32,32,32);
        gr.addColorStop(0,'rgba(238,232,224,0.85)');gr.addColorStop(0.5,'rgba(230,224,216,0.35)');gr.addColorStop(1,'rgba(230,224,216,0)');x.fillStyle=gr;x.fillRect(0,0,64,64);
        glowFire=glowSprite(a=>`hsla(28,100%,58%,${a})`);glowArc=glowSprite(a=>`hsla(205,100%,70%,${a})`);glowBell=glowSprite(a=>`hsla(45,90%,72%,${a})`);
        for(let i=0;i<12;i++)glowHue.push(glowSprite(a=>`hsla(${i*30},95%,62%,${a})`));
        for(const d of TRACKS)glowTrk[d.hue]=glowSprite(a=>`hsla(${d.hue},95%,62%,${a})`);
      }
      // ---- background: wall, floor, all static machinery
      [bg,x]=off(w,h);
      gr=x.createLinearGradient(0,0,0,h);gr.addColorStop(0,'hsl(24,16%,10%)');gr.addColorStop(0.55,'hsl(22,17%,7.5%)');gr.addColorStop(1,'hsl(20,15%,4%)');
      x.fillStyle=gr;x.fillRect(0,0,w,h);
      const r=rng(90210);
      x.filter=`blur(${Math.max(4,Math.round(u*0.035*k))}px)`;
      for(let i=0;i<24;i++){x.fillStyle=`hsla(${18+r()*16},${20+r()*15}%,${r()<0.5?2:15}%,${0.12+r()*0.18})`;x.beginPath();x.ellipse(r()*w,r()*h,u*(0.05+r()*0.2),u*(0.04+r()*0.12),r()*3,0,TAU);x.fill();}
      x.filter='none';
      const pw2=u*0.26;
      for(let X=pw2*0.6;X<w;X+=pw2){
        x.fillStyle='rgba(0,0,0,0.4)';x.fillRect(X-1,0,2,h);x.fillStyle='rgba(255,215,170,0.035)';x.fillRect(X+1,0,1,h);
        for(let Y=u*0.05;Y<h;Y+=u*0.08){rivet(x,X-u*0.013,Y,u*0.004);rivet(x,X+u*0.013,Y,u*0.004);}
      }
      x.fillStyle='hsl(20,14%,4.5%)';x.fillRect(0,L.floorY,w,h-L.floorY);x.fillStyle='hsla(32,40%,60%,0.08)';x.fillRect(0,L.floorY,w,1.5);
      // steam main along the back, supply drops to the wind chest and the ram
      const pr=u*0.016,c0=L.cx0-u*0.025,c1=L.cx1+u*0.025,midC=L.chestY+L.chestH*0.5;
      for(const X of [L.cx0-u*0.045,L.cx1+u*0.045]){
        x.fillStyle=metal(x,X-pr*0.8,0,X+pr*0.8,0,COPPER);x.fillRect(X-pr*0.8,L.pipeY,pr*1.6,midC-L.pipeY);
        x.fillStyle=metal(x,0,midC-pr*0.8,0,midC+pr*0.8,COPPER);const a=X<c0?X:c1,b2=X<c0?c0:X;x.fillRect(a-pr*0.4,midC-pr*0.8,b2-a+pr*0.8,pr*1.6);
      }
      x.fillStyle=metal(x,L.rx-pr*0.8,0,L.rx+pr*0.8,0,COPPER);x.fillRect(L.rx-pr*0.8,L.pipeY,pr*1.6,L.rTop-L.pipeY);
      x.fillStyle=metal(x,0,L.pipeY-pr,0,L.pipeY+pr,COPPER);x.fillRect(0,L.pipeY-pr,w,pr*2);
      for(let X=u*0.12;X<w;X+=u*0.36){x.fillStyle=metal(x,0,L.pipeY-pr*1.35,0,L.pipeY+pr*1.35,COPPER);x.fillRect(X,L.pipeY-pr*1.35,u*0.018,pr*2.7);}
      // hammer post + anvil
      const pwd=u*0.03;
      x.fillStyle=metal(x,L.px-pwd/2,0,L.px+pwd/2,0,IRON);x.fillRect(L.px-pwd/2,L.py,pwd,L.floorY-L.py);
      x.fillStyle=metal(x,0,L.floorY-u*0.02,0,L.floorY,IRON);x.fillRect(L.px-pwd*1.6,L.floorY-u*0.02,pwd*3.2,u*0.02);
      const sw=u*0.1,sy=L.aTop+u*0.1;x.fillStyle=metal(x,L.ax-sw/2,0,L.ax+sw/2,0,[26,22,18]);x.fillRect(L.ax-sw/2,sy,sw,L.floorY-sy);
      const A=(dx,dy)=>[L.ax+dx*u,L.aTop+dy*u];
      x.beginPath();x.moveTo(...A(-0.075,0));x.lineTo(...A(0.055,0));x.quadraticCurveTo(...A(0.1,0.002),...A(0.115,0.012));x.quadraticCurveTo(...A(0.08,0.03),...A(0.05,0.035));
      x.lineTo(...A(0.03,0.048));x.lineTo(...A(0.028,0.075));x.lineTo(...A(0.06,0.1));x.lineTo(...A(-0.068,0.1));x.lineTo(...A(-0.035,0.075));x.lineTo(...A(-0.038,0.048));x.lineTo(...A(-0.075,0.035));x.closePath();
      gr=x.createLinearGradient(0,L.aTop,0,L.aTop+u*0.1);gr.addColorStop(0,'hsl(210,6%,34%)');gr.addColorStop(0.15,'hsl(210,6%,20%)');gr.addColorStop(1,'hsl(210,8%,8%)');x.fillStyle=gr;x.fill();
      x.fillStyle='hsla(200,20%,80%,0.35)';x.fillRect(L.ax-u*0.075,L.aTop,u*0.13,1.5);
      // bell hanging from the main, with the tapper bracket
      const {bx,by,br}=L;
      x.strokeStyle='hsl(24,10%,18%)';x.lineWidth=u*0.006;x.beginPath();x.moveTo(bx,L.pipeY);x.lineTo(bx,by-br);x.moveTo(bx,by-br*1.5);x.lineTo(bx+br*1.75,by-br*1.5);x.stroke();
      x.beginPath();x.moveTo(bx-br*1.15,by+br*0.3);x.bezierCurveTo(bx-br*0.9,by+br*0.1,bx-br,by-br*1.1,bx,by-br*1.1);x.bezierCurveTo(bx+br,by-br*1.1,bx+br*0.9,by+br*0.1,bx+br*1.15,by+br*0.3);x.closePath();
      gr=x.createRadialGradient(bx-br*0.35,by-br*0.6,br*0.1,bx,by,br*1.4);gr.addColorStop(0,'hsl(46,70%,72%)');gr.addColorStop(0.5,'hsl(40,55%,40%)');gr.addColorStop(1,'hsl(34,50%,14%)');x.fillStyle=gr;x.fill();
      rivet(x,bx+br*1.75,by-br*1.5,u*0.005);
      // organ pipes (taller = higher note), wind chest, tracker bar
      const r2=rng(4242);
      for(let i=0;i<L.n;i++){
        const xc=pipeX(i),x0=xc-L.pb/2,yt=L.ptop[i],m=[40+r2()*5,44,40];
        x.fillStyle=metal(x,x0,0,x0+L.pb,0,m);x.fillRect(x0,yt,L.pb,L.chestY-yt+1);
        if((info.lo+i)%12===0){x.fillStyle=metal(x,x0,0,x0+L.pb,0,COPPER,32);x.fillRect(x0-L.pb*0.06,yt+(L.chestY-yt)*0.3,L.pb*1.12,Math.max(2,L.pb*0.35));}
        x.fillStyle=metal(x,x0,0,x0+L.pb,0,m,46);x.fillRect(x0-L.pb*0.08,yt-L.pb*0.12,L.pb*1.16,L.pb*0.3);
        x.fillStyle='hsl(20,30%,4%)';x.beginPath();x.ellipse(xc,yt-L.pb*0.1,L.pb*0.42,L.pb*0.13,0,0,TAU);x.fill();
        x.fillStyle='hsl(24,20%,6%)';x.beginPath();x.arc(xc,L.chestY-L.pb*1.0,L.pb*0.27,0,TAU);x.fill();
      }
      x.fillStyle=metal(x,0,L.chestY,0,L.trackY,BRASS);x.fillRect(c0,L.chestY,c1-c0,L.chestH);
      x.fillStyle='rgba(0,0,0,0.35)';x.fillRect(c0,L.trackY-1,c1-c0,1);
      for(const X of L.lamps){x.fillStyle='hsl(24,20%,7%)';x.beginPath();x.arc(X,midC,L.chestH*0.24,0,TAU);x.fill();}
      rivet(x,c0+u*0.01,midC,u*0.004);rivet(x,c1-u*0.01,midC,u*0.004);
      const T=L.tape;
      gr=x.createLinearGradient(T.x0,0,T.x1,0);gr.addColorStop(0,'hsl(36,18%,9%)');gr.addColorStop(0.07,'hsl(38,22%,14%)');gr.addColorStop(0.93,'hsl(38,22%,14%)');gr.addColorStop(1,'hsl(36,18%,9%)');
      x.fillStyle=gr;x.fillRect(T.x0,T.y0,T.x1-T.x0,T.y1-T.y0);
      x.fillStyle='hsla(36,40%,55%,0.14)';x.fillRect(T.lab,T.y0,1,T.y1-T.y0);
      for(const X of [T.x0-u*0.008,T.x1]){x.fillStyle=metal(x,X,0,X+u*0.008,0,BRASS);x.fillRect(X,T.y0,u*0.008,L.floorY-T.y0);}
      x.fillStyle=metal(x,0,L.trackY,0,L.barY,IRON,30);x.fillRect(T.x0-u*0.008,L.trackY,T.x1-T.x0+u*0.016,L.trackH);
      for(let i=0;i<L.n;i++){x.fillStyle='hsl(20,20%,3%)';x.fillRect(pipeX(i)-L.pb*0.22,L.trackY+L.trackH*0.25,L.pb*0.44,L.trackH*0.5);}
      // bass ram housing
      const {rx,rw,rTop,rBot,capH}=L;
      x.fillStyle=metal(x,rx-rw*0.45,0,rx+rw*0.45,0,IRON);x.fillRect(rx-rw*0.45,rBot,rw*0.9,L.floorY-rBot);
      x.fillStyle=metal(x,0,midC-pr*0.8,0,midC+pr*0.8,COPPER);x.fillRect(c1,midC-pr*0.8,rx-rw*0.8-c1,pr*1.6);
      for(const X of [rx-rw*0.68,rx+rw*0.68]){x.fillStyle=metal(x,X-u*0.003,0,X+u*0.003,0,BRASS);x.fillRect(X-u*0.003,rTop,u*0.006,rBot-rTop);}
      for(const Y of [rTop,rBot-capH]){x.fillStyle=metal(x,0,Y,0,Y+capH,BRASS);rr(x,rx-rw*0.82,Y,rw*1.64,capH,capH*0.2);x.fill();rivet(x,rx-rw*0.6,Y+capH/2,u*0.004);rivet(x,rx+rw*0.6,Y+capH/2,u*0.004);}
      // flywheel stand and the beat cylinder
      const {fx,fy,R}=L;
      x.fillStyle=metal(x,fx-R*0.6,0,fx+R*0.6,0,IRON);
      x.beginPath();x.moveTo(fx-R*0.62,L.floorY);x.lineTo(fx-R*0.1,fy);x.lineTo(fx+R*0.1,fy);x.lineTo(fx+R*0.62,L.floorY);x.lineTo(fx+R*0.42,L.floorY);x.lineTo(fx,fy+R*0.35);x.lineTo(fx-R*0.42,L.floorY);x.closePath();x.fill();
      const cy0=fy+R*1.78;
      x.fillStyle=metal(x,fx-R*0.2,0,fx+R*0.2,0,BRASS);x.fillRect(fx-R*0.2,cy0,R*0.4,L.floorY-cy0);
      x.fillStyle=metal(x,0,cy0,0,cy0+R*0.1,BRASS);x.fillRect(fx-R*0.26,cy0,R*0.52,R*0.1);
      // Jacob's ladder (lead): insulated base on the chest-to-ram pipe, two copper horns
      {const {jx,jw,jB,jT}=L;
        x.fillStyle=metal(x,jx-jw*0.6,0,jx+jw*0.6,0,IRON,22);rr(x,jx-jw*0.6,jB,jw*1.2,u*0.032,u*0.004);x.fill();
        for(const sg of [-1,1]){x.fillStyle='hsl(30,25%,82%)';rr(x,jx+sg*jw*0.14-u*0.006,jB-u*0.02,u*0.012,u*0.022,u*0.003);x.fill();
          x.strokeStyle='hsl(20,55%,45%)';x.lineWidth=Math.max(1.5,u*0.0035);x.beginPath();x.moveTo(jx+sg*jw*0.14,jB-u*0.02);x.quadraticCurveTo(jx+sg*jw*0.16,(jB+jT)/2,jx+sg*jw*0.5,jT);x.stroke();
          x.strokeStyle='hsla(30,70%,75%,0.35)';x.lineWidth=1;x.stroke();}}
      // piano action: brass bar, pivot rail, side brackets
      {const P=L.pn;
        x.fillStyle=metal(x,P.x0,0,P.x0+u*0.008,0,IRON);x.fillRect(P.x0-u*0.012,P.sY-u*0.01,u*0.008,P.pY-P.sY+u*0.03);x.fillRect(P.x1+u*0.004,P.sY-u*0.01,u*0.008,P.pY-P.sY+u*0.03);
        x.fillStyle=metal(x,0,P.pY,0,P.pY+u*0.012,IRON,30);x.fillRect(P.x0-u*0.012,P.pY,P.x1-P.x0+u*0.024,u*0.012);
        x.strokeStyle='hsl(24,10%,18%)';x.lineWidth=u*0.004;x.beginPath();x.moveTo(P.x0-u*0.008,P.pY+u*0.012);x.lineTo(P.x0-u*0.008,L.pipeY);x.stroke();}
      // ---- sprites
      const S=Math.ceil(R*2+4);[fly,x]=off(S,S);x.translate(S/2,S/2);
      for(let i=0;i<6;i++){x.save();x.rotate(i*TAU/6);x.fillStyle=metal(x,-R*0.07,0,R*0.07,0,IRON,28);x.beginPath();x.moveTo(-R*0.075,0);x.lineTo(-R*0.035,-R*0.86);x.lineTo(R*0.035,-R*0.86);x.lineTo(R*0.075,0);x.fill();x.restore();}
      x.beginPath();x.arc(0,0,R,0,TAU);x.arc(0,0,R*0.8,0,TAU,true);
      gr=x.createRadialGradient(0,0,R*0.8,0,0,R);gr.addColorStop(0,'hsl(24,8%,12%)');gr.addColorStop(0.5,'hsl(24,8%,27%)');gr.addColorStop(1,'hsl(24,8%,10%)');x.fillStyle=gr;x.fill('evenodd');
      x.strokeStyle='hsl(40,45%,45%)';x.lineWidth=Math.max(1,R*0.025);x.beginPath();x.arc(0,0,R*0.985,0,TAU);x.stroke();
      for(let i=0;i<12;i++){const a=i*TAU/12;rivet(x,Math.cos(a)*R*0.9,Math.sin(a)*R*0.9,R*0.025);}
      x.fillStyle=metal(x,-R*0.2,0,R*0.2,0,BRASS);x.beginPath();x.arc(0,0,R*0.2,0,TAU);x.fill();
      [head,x]=off(L.headW,L.headH);
      x.fillStyle=metal(x,0,0,L.headW,0,IRON,30);rr(x,0,0,L.headW,L.headH,L.headW*0.12);x.fill();
      x.fillStyle=metal(x,0,0,L.headW,0,BRASS);x.fillRect(0,L.headH*0.1,L.headW,L.headH*0.08);x.fillRect(0,L.headH*0.82,L.headW,L.headH*0.08);
      L.ww=rw*0.84;L.wh=u*0.065;[weight,x]=off(L.ww,L.wh);
      x.fillStyle=metal(x,0,0,L.ww,0,BRASS);rr(x,0,0,L.ww,L.wh,L.ww*0.1);x.fill();x.fillStyle='rgba(0,0,0,0.3)';for(let i=1;i<4;i++)x.fillRect(0,L.wh*i/4,L.ww,1);
      [vig,x]=off(w,h);gr=x.createRadialGradient(w/2,h*0.5,u*0.45,w/2,h*0.5,Math.max(w,h)*0.75);gr.addColorStop(0,'rgba(0,0,0,0)');gr.addColorStop(1,'rgba(0,0,0,0.6)');x.fillStyle=gr;x.fillRect(0,0,w,h);
      [front,x]=off(w,h);bezel(x,L.chord);if(L.lyric)bezel(x,L.lyric);
      [scan,x]=off(w,h);scanOver(x,L.chord);if(L.lyric)scanOver(x,L.lyric);
    }

    function ensureLayout(env,g){
      const zc=env.zones.chord,zl=env.zones.lyrics;
      const kk=clamp(g.getTransform?Math.abs(g.getTransform().a):1,1,2);
      const key=[w,h,kk,zc.top,zc.bottom,zl?zl.top:-1,zl?zl.bottom:-1,info.lo,info.hi].join('|');
      if(key===layKey)return;layKey=key;k=kk;L=makeLayout(zc,zl);extraLayout();buildArt();
    }
    function makeGrads(g){
      const T=L.tape,cx=(L.cx0+L.cx1)/2,cy=L.chestY-L.M*0.25;
      const amb=g.createRadialGradient(cx,cy,0,cx,cy,(L.cx1-L.cx0)*0.8);amb.addColorStop(0,'hsla(32,90%,55%,1)');amb.addColorStop(1,'hsla(32,90%,55%,0)');
      const fy0=T.y0+(Math.min(T.y1,L.bot+L.u*0.05)-T.y0)*0.6;
      const fade=g.createLinearGradient(0,fy0,0,Math.min(T.y1,L.bot+L.u*0.1));fade.addColorStop(0,'rgba(10,7,5,0)');fade.addColorStop(1,'rgba(10,7,5,0.85)');
      const g0=L.rTop+L.capH,g1=L.rBot-L.capH,fl=g.createLinearGradient(0,g0,0,g1);fl.addColorStop(0,'hsla(14,95%,55%,0.2)');fl.addColorStop(1,'hsla(10,95%,50%,0.9)');
      return {amb,fade,fl};
    }

    function strike(s,calm){
      anvilGlow=Math.max(anvilGlow,0.5+0.5*s);
      if(!calm)shake=Math.max(shake,L.u*0.006*s);
      const n=calm?4:10+Math.round(s*8),X=L.ax,Y=L.aTop;
      for(let i=0;i<n&&sparks.length<80;i++){const a=-Math.PI*(0.1+rnd()*0.8),v=L.u*(0.35+rnd()*0.6)*(calm?0.6:1);sparks.push({x:X+(rnd()-0.5)*L.headW,y:Y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,age:0,max:0.25+rnd()*0.35});}
    }
    function puffAt(X,Y,vx,vy,size,life,a=1){if(steam.length<420)steam.push({x:X,y:Y,vx,vy,age:0,max:life,s0:size,a});}
    function pipePuff(i,boost){puffAt(pipeX(i)+(rnd()-0.5)*L.pb*0.4,L.ptop[i]-L.pb*0.1,(rnd()-0.5)*L.u*0.04,-L.u*(0.16+rnd()*0.1)*boost,L.pb*(0.9+rnd()*0.5)+L.u*0.008,1.0+rnd()*0.9);}

    // hammer: 0 = resting on the anvil, 1 = fully raised. Positioned purely by song time between the last and next strong hit.
    function hammerLift(t,fr,drumsOff){
      if(drumsOff)return 0;
      const hs=info.strong;let p=null,n=null;
      if(hs.length){const i=after(hs,t);n=hs[i]?hs[i].start:null;p=i>0?hs[i-1].start:null;}
      else if(fr.beat?.bar!=null&&fr.beat.bpm){const spb=60/fr.beat.bpm;p=t-fr.beat.phase*spb;n=p+spb;}
      if(n==null)return 0;
      if(p==null)p=n-2;
      const d=n-p,s=Math.min(0.11,d*0.4),riseEnd=n-s,riseStart=Math.min(riseEnd,Math.max(p+Math.min(0.12,d*0.3),n-0.55));
      const amp=clamp((d-0.08)/0.5,0.22,1);
      if(t>=riseEnd){const x=(t-riseEnd)/s;return amp*(1-x*x);}
      if(t>=riseStart){const x=(t-riseStart)/Math.max(1e-3,riseEnd-riseStart);return amp*(easeInOut(x)+0.06*Math.sin(Math.PI*x));}
      const x=(t-p)/0.14;return x<1?0.07*amp*Math.sin(Math.PI*x):0;
    }

    function chordParts(label){
      const m=/^([A-G])([#b]?)(.*)$/.exec(label||'');
      if(!m)return [label||'',''];
      return [m[1]+(m[2]==='#'?'♯':m[2]==='b'?'♭':''),m[3].replace(/#/g,'♯')];
    }
    function drawChordLabel(g,label,cx,cy,maxW,fs,col,glow,alpha){
      if(alpha<=0.01)return;
      const [root,rest]=chordParts(label);
      g.font=`700 ${fs}px ${SANS}`;let w1=g.measureText(root).width;
      g.font=`600 ${fs*0.55}px ${SANS}`;let w2=rest?g.measureText(rest).width+fs*0.05:0;
      const s=Math.min(1,maxW/Math.max(1,w1+w2));fs*=s;w1*=s;w2*=s;
      const x0=cx-(w1+w2)/2,y=cy+fs*0.35;
      g.globalAlpha=alpha;g.lineJoin='round';g.textAlign='left';g.textBaseline='alphabetic';
      g.font=`700 ${fs}px ${SANS}`;
      if(glow){g.strokeStyle=glow;g.lineWidth=fs*0.1;g.strokeText(root,x0,y);}
      const fo=Math.max(0.7,fs*0.012);g.fillStyle='rgba(255,70,60,0.35)';g.fillText(root,x0-fo,y);g.fillStyle='rgba(60,150,255,0.35)';g.fillText(root,x0+fo,y);
      g.fillStyle=col;g.fillText(root,x0,y);
      if(rest){g.font=`600 ${fs*0.55}px ${SANS}`;const xr=x0+w1+fs*0.05,yr=y-fs*0.3;if(glow){g.lineWidth=fs*0.06;g.strokeText(rest,xr,yr);}g.fillText(rest,xr,yr);}
      g.globalAlpha=1;
    }

    function drawChordScreen(g,fr,wall,calm){
      const R=L.chord,c=fr.chord||{},h0=hue;
      g.save();rr(g,R.x,R.y,R.w,R.h,R.rad);g.clip();
      const kk=clamp((wall-chordWall)/0.3,0,1),e=easeOut(kk);
      g.globalCompositeOperation='lighter';
      g.fillStyle=`hsla(${h0},60%,40%,0.07)`;g.fillRect(R.x,R.y,R.w,R.h);
      if(!calm&&kk<1){g.fillStyle=`hsla(${h0},80%,60%,${0.12*(1-kk)})`;g.fillRect(R.x,R.y,R.w,R.h);}
      g.globalCompositeOperation='source-over';
      const mcx=R.x+R.w*0.32,mcy=R.y+R.h*0.5,mw=R.w*0.54,fs=R.h*0.64,dy=calm?0:R.h*0.55;
      const drawMain=(lab,yo,al)=>{
        if(lab){const hh=chordColor(lab).hue;drawChordLabel(g,lab,mcx,mcy+yo,mw,fs,`hsl(${hh},85%,75%)`,`hsla(${hh},90%,60%,0.28)`,al);}
        else drawChordLabel(g,'N.C.',mcx,mcy+yo,mw,fs*0.5,'hsl(36,15%,48%)',null,al);
      };
      if(kk<1)drawMain(chordPrev,-e*dy,1-kk);
      drawMain(chordCur,(1-e)*dy,kk);
      g.fillStyle=`hsla(${h0},50%,60%,0.22)`;g.fillRect(R.x+R.w*0.625,R.y+R.h*0.16,1.5,R.h*0.68);
      const nx=c.next;
      if(nx&&!noChord(nx.label)){
        const px=R.x+R.w*0.665,pw=R.w*0.3,nh=chordColor(nx.label).hue;
        g.font=`600 ${R.h*0.105}px ${SANS}`;g.letterSpacing=`${R.h*0.025}px`;g.fillStyle='hsl(36,18%,62%)';g.textAlign='left';g.textBaseline='alphabetic';
        g.fillText('NEXT',px,R.y+R.h*0.25);g.letterSpacing='0px';
        drawChordLabel(g,nx.label,px+pw/2,R.y+R.h*0.47,pw,R.h*0.3,`hsl(${nh},80%,74%)`,null,1);
        const by=R.y+R.h*0.66,bh=Math.max(3,R.h*0.04),p=clamp(c.label?c.progress||0:0,0,1);
        g.fillStyle=`hsla(${nh},40%,50%,0.22)`;rr(g,px,by,pw,bh,bh/2);g.fill();
        g.fillStyle=`hsl(${nh},85%,66%)`;rr(g,px,by,Math.max(bh,pw*p),bh,bh/2);g.fill();
        const ups=(c.upcoming||[]).filter(x=>x.start>nx.start+1e-3&&!noChord(x.label)).slice(0,2);
        let ux=px;g.font=`600 ${R.h*0.13}px ${SANS}`;
        for(const up of ups){const t=chordParts(up.label).join('');g.fillStyle=`hsl(${chordColor(up.label).hue},35%,62%)`;g.fillText(t,ux,R.y+R.h*0.87);ux+=g.measureText(t).width+R.h*0.12;}
      }
      g.restore();
    }

    function drawSection(g,fr){
      const s=fr.section;if(!s?.name)return;
      const P=L.sect,p=P.h*0.14;
      g.fillStyle='rgba(0,0,0,0.45)';rr(g,P.x+p*0.2,P.y+p*0.5,P.w,P.h,p);g.fill();
      g.fillStyle='hsl(26,10%,14%)';rr(g,P.x,P.y,P.w,P.h,p);g.fill();
      g.strokeStyle='hsla(40,45%,60%,0.35)';g.lineWidth=1;rr(g,P.x+0.5,P.y+0.5,P.w-1,P.h-1,p);g.stroke();
      let fs=P.h*0.36;g.font=`600 ${fs}px ${SANS}`;const tw=g.measureText(s.name).width,mw=P.w-p*3;
      if(tw>mw){fs*=mw/tw;g.font=`600 ${fs}px ${SANS}`;}
      g.fillStyle='hsl(40,45%,78%)';g.textAlign='left';g.textBaseline='alphabetic';g.fillText(s.name,P.x+p*1.5,P.y+P.h*0.55);
      const by=P.y+P.h*0.72,bw=P.w-p*3;g.fillStyle='hsla(40,40%,50%,0.25)';g.fillRect(P.x+p*1.5,by,bw,Math.max(2,P.h*0.05));
      g.fillStyle='hsl(40,60%,62%)';g.fillRect(P.x+p*1.5,by,bw*clamp(s.progress||0,0,1),Math.max(2,P.h*0.05));
    }

    function lyricLayout(g,words,line,R){
      const key=line.index+'|'+line.text+'|'+R.w+'|'+R.h;
      if(lyr.key===key)return lyr;
      const toks=words.map(wd=>{const s=String(wd.text||'');const join=s.length>1&&s.endsWith('-');return {text:join?s.slice(0,-1):s,join};});
      const groups=[];let cur=[];toks.forEach((t,i)=>{cur.push(i);if(!t.join){groups.push(cur);cur=[];}});if(cur.length)groups.push(cur);
      const fs0=Math.min(R.h*0.34,R.w*0.05),maxW=R.w*0.92;
      const measure=fs=>{g.font=`600 ${fs}px ${SANS}`;return {ws:toks.map(t=>g.measureText(t.text).width),sp:g.measureText(' ').width};};
      const wrap=(fs,m)=>{const rows=[];let row=[],rw=0;for(const gr of groups){const gw=gr.reduce((a,i)=>a+m.ws[i],0);const add=row.length?m.sp+gw:gw;if(row.length&&rw+add>maxW){rows.push({items:row,w:rw});row=[];rw=0;}rw+=row.length?m.sp+gw:gw;row.push(gr);}if(row.length)rows.push({items:row,w:rw});return rows;};
      let fs=fs0,m=measure(fs),total=wrap(fs,{ws:m.ws,sp:m.sp});
      const one=total.length===1?total[0].w:groups.reduce((a,gr)=>a+gr.reduce((b,i)=>b+m.ws[i],0),0)+m.sp*(groups.length-1);
      if(one>maxW){fs=Math.max(fs0*0.7,fs0*maxW/one);m=measure(fs);}
      let rows=wrap(fs,m);
      while(rows.length>2&&fs>fs0*0.35){fs*=0.9;m=measure(fs);rows=wrap(fs,m);}
      const out=[];rows.forEach((row,ri)=>{
        const y=rows.length===1?R.y+R.h*0.44+fs*0.35:R.y+R.h*(ri===0?0.32:0.7)+fs*0.35;
        let x=R.x+R.w/2-row.w/2;
        row.items.forEach((gr,gi)=>{if(gi)x+=m.sp;for(const i of gr){out.push({i,x,y,w:m.ws[i],text:toks[i].text});x+=m.ws[i];}});
      });
      lyr={key,fs,fs0,tokens:out,rows:rows.length};return lyr;
    }
    function fitText(g,text,cx,y,fs,maxW,weight,col){
      g.font=`${weight} ${fs}px ${SANS}`;const tw=g.measureText(text).width;if(tw>maxW){fs*=maxW/tw;g.font=`${weight} ${fs}px ${SANS}`;}
      g.fillStyle=col;g.textAlign='center';g.fillText(text,cx,y);g.textAlign='left';
    }
    function drawLyricScreen(g,fr,t){
      const R=L.lyric;if(!R)return;
      const ly=fr.lyric||{},line=ly.line,words=ly.words;
      g.save();rr(g,R.x,R.y,R.w,R.h,R.rad);g.clip();g.textBaseline='alphabetic';g.lineJoin='round';
      if(line&&words&&words.length){
        const Lo=lyricLayout(g,words,line,R),fs=Lo.fs;g.font=`600 ${fs}px ${SANS}`;g.textAlign='left';
        for(const tk of Lo.tokens){
          const wd=words[tk.i];if(!wd)continue;const st=wd.state;
          const fo=Math.max(0.6,fs*0.012);
          if(st==='sung'){g.strokeStyle=LYR.glow;g.lineWidth=fs*0.1;g.strokeText(tk.text,tk.x,tk.y);g.fillStyle='rgba(255,70,60,0.3)';g.fillText(tk.text,tk.x-fo,tk.y);g.fillStyle='rgba(60,150,255,0.3)';g.fillText(tk.text,tk.x+fo,tk.y);g.fillStyle=LYR.sung;g.fillText(tk.text,tk.x,tk.y);}
          else if(st==='now'){
            const p=clamp((t-wd.start)/Math.max(0.05,wd.end-wd.start),0,1);
            g.fillStyle=LYR.ahead;g.fillText(tk.text,tk.x,tk.y);
            g.save();g.beginPath();g.rect(tk.x-fs*0.1,tk.y-fs*1.2,(tk.w+fs*0.2)*p,fs*1.6);g.clip();
            g.strokeStyle=LYR.glow;g.lineWidth=fs*0.12;g.strokeText(tk.text,tk.x,tk.y);g.fillStyle='rgba(255,70,60,0.3)';g.fillText(tk.text,tk.x-fo,tk.y);g.fillStyle='rgba(60,150,255,0.3)';g.fillText(tk.text,tk.x+fo,tk.y);g.fillStyle=LYR.now;g.fillText(tk.text,tk.x,tk.y);g.restore();
          } else {g.fillStyle=LYR.ahead;g.fillText(tk.text,tk.x,tk.y);}
        }
        if(Lo.rows===1&&ly.next?.text)fitText(g,dehyph(ly.next.text),R.x+R.w/2,R.y+R.h*0.84,Lo.fs0*0.42,R.w*0.85,500,LYR.next);
      } else if(line?.text){
        fitText(g,dehyph(line.text),R.x+R.w/2,R.y+R.h*0.5+R.h*0.12,R.h*0.34,R.w*0.92,600,LYR.sung);
      } else if(ly.next?.text&&ly.next.in<8){
        fitText(g,dehyph(ly.next.text),R.x+R.w/2,R.y+R.h*0.5+R.h*0.09,R.h*0.26,R.w*0.88,500,LYR.ahead);
        const p=clamp(1-ly.next.in/8,0,1),bw=R.w*0.18,bh=Math.max(2,R.h*0.025);
        g.fillStyle='hsla(38,40%,50%,0.25)';g.fillRect(R.x+R.w/2-bw/2,R.y+R.h*0.78,bw,bh);g.fillStyle='hsl(40,70%,62%)';g.fillRect(R.x+R.w/2-bw/2,R.y+R.h*0.78,bw*p,bh);
      }
      g.restore();
    }

    function drawTape(g,fr,t){
      const T=L.tape,u=L.u,sp=L.speed,look=(Math.min(T.y1,L.bot+u*0.12)-T.y0)/sp;
      g.save();g.beginPath();g.rect(T.x0,T.y0,T.x1-T.x0,T.y1-T.y0);g.clip();
      // sprocket holes (move with song time)
      const step=u*0.03,offY=((-t*sp)%step+step)%step;g.fillStyle='hsl(20,25%,3%)';
      for(let y=T.y0+offY-step;y<T.y1;y+=step){g.fillRect(T.x0+u*0.006,y,u*0.008,u*0.012);g.fillRect(T.x1-u*0.014,y,u*0.008,u*0.012);}
      // beat grid
      const b=fr.beat;
      if(b?.bar!=null&&b.bpm){const spb=60/b.bpm,tb=t-b.phase*spb;
        for(let j=0;j<64;j++){const y=T.y0+(tb+j*spb-t)*sp;if(y>T.y1)break;if(y<T.y0)continue;const down=((b.beat-1+j)%(b.beats||4))===0;
          g.fillStyle=down?'hsla(38,35%,62%,0.24)':'hsla(38,30%,60%,0.09)';g.fillRect(T.lab+2,y,T.x1-T.lab-u*0.02,down?1.5:1);}
      }
      // chord changes printed on the margin
      const chords=songRef?.chords||[];
      if(chords.length){g.font=`700 ${u*0.021}px ${MONO}`;g.textAlign='left';g.textBaseline='middle';
        for(let i=Math.max(0,after(chords,t)-1);i<chords.length;i++){const c=chords[i];if(noChord(c.label))continue;const y=T.y0+(c.start-t)*sp;if(y>T.y1)break;if(y<T.y0-1)continue;
          const ch=chordColor(c.label).hue;g.fillStyle=`hsla(${ch},70%,65%,0.55)`;g.fillRect(T.x0+u*0.018,y,T.lab-T.x0-u*0.018,1.5);
          g.fillStyle=`hsl(${ch},70%,72%)`;g.fillText(chordParts(c.label).join(''),T.x0+u*0.02,y-u*0.016);}
      }
      // note holes, lit from behind
      g.globalCompositeOperation='lighter';
      for(const trk of info.tracks){
        const a=trk.notes;if(!a.length)continue;
        const i0=after(a,t-trk.maxDur-0.01),glowP=new Path2D(),coreP=new Path2D(),hotP=new Path2D();
        for(let i=i0;i<a.length;i++){const n=a[i];if(n.start>t+look)break;if(n.end<=t)continue;
          const y0=Math.max(T.y0,T.y0+(n.start-t)*sp),y1=T.y0+(n.end-t)*sp;if(y1-y0<1)continue;
          const v=n.velocity==null?0.8:n.velocity>1?n.velocity/127:n.velocity,hw=L.pb*(0.38+0.22*v),x=pipeX(pidx(n.pitch))-hw/2,r=Math.min(hw/2,(y1-y0)/2);
          glowP.roundRect(x-u*0.005,y0-u*0.003,hw+u*0.01,y1-y0+u*0.006,r+u*0.005);
          (n.start<=t?hotP:coreP).roundRect(x,y0,hw,y1-y0,r);}
        g.fillStyle=`hsla(${trk.hue},95%,55%,0.22)`;g.fill(glowP);
        g.fillStyle=`hsl(${trk.hue},85%,60%)`;g.fill(coreP);
        g.fillStyle=`hsl(${trk.hue},90%,82%)`;g.fill(hotP);
      }
      g.globalCompositeOperation='source-over';
      g.fillStyle=L.grads.fade;g.fillRect(T.x0,T.y0,T.x1-T.x0,T.y1-T.y0);
      g.restore();
    }

    return {
      resize(nw,nh){w=nw;h=nh;layKey='';},
      draw(g,frame,env){
        w=env.w;h=env.h;
        const {wall,calm}=env,dt=env.dt||1/60,song=env.song,t=frame.time||0,tr=frame.tracks||{},ev=env.events||{};
        ensureInfo(song);ensureLayout(env,g);if(!L.grads)L.grads=makeGrads(g);
        const u=L.u,playing=!!frame.playing;
        const jumped=lastT==null||t<lastT-0.02||t-lastT>0.5;lastT=t;
        const label=noChord(frame.chord?.label)?null:frame.chord.label;
        if(label){const th=chordColor(label).hue;hue=(hue+(((th-hue+540)%360)-180)*Math.min(1,dt*4)+360)%360;}
        if(label!==chordCur){chordPrev=chordCur===undefined?null:chordCur;chordCur=label;chordWall=(jumped||!playing)?wall-1:wall;}
        bassS+=((tr.bass?.level??0)-bassS)*Math.min(1,dt*12);
        vocS+=((tr.vocals?.level??0)-vocS)*Math.min(1,dt*10);
        const drumsOff=!!(tr.drums&&tr.drums.gain===0);
        // reactions
        const thr=info.strong.length?info.thr:-1;
        for(const s of ev.hits?.drums||[]){if(thr<0||s>=thr)strike(s,calm);else{bellTap=Math.max(bellTap,0.6+s*0.4);if(rings.length<6)rings.push({age:0});}}
        if(thr<0&&!drumsOff&&ev.beat)strike(ev.beat.downbeat?0.9:0.55,calm);
        for(const s of ev.hits?.bass||[])ramVel+=s*(calm?1.0:2.6);
        for(const s of ev.hits?.lead||[])if(s>0.35){if(arcH>0.35)arcH=0;arcHit=Math.max(arcHit,s);}
        for(const s of ev.hits?.rhythm||[])rhyFlare=Math.max(rhyFlare,s);
        for(const s of ev.hits?.piano||[]){pianoH[pianoIdx%5]=Math.max(0.5,s);pianoIdx++;}
        const sm=(v,x,r)=>v+((x??0)-v)*Math.min(1,dt*r);
        leadS=sm(leadS,tr.lead?.level,10);rhyS=sm(rhyS,tr.rhythm?.level,8);otherS=sm(otherS,tr.other?.level,4);
        if(ev.beat)beatLamp=ev.beat.downbeat?1:0.55;
        if(ev.chordChanged){chase=wall;const c0=L.cx0-u*0.025,c1=L.cx1+u*0.025,cy=L.chestY+L.chestH*0.5;
          for(let i=0;i<(calm?2:6);i++){puffAt(c0,cy,-u*(0.25+rnd()*0.25),-u*0.06*rnd(),u*0.03,0.9+rnd()*0.5);puffAt(c1,cy,u*(0.25+rnd()*0.25),-u*0.06*rnd(),u*0.03,0.9+rnd()*0.5);}}
        const dec=r=>Math.exp(-dt*r);
        anvilGlow*=dec(6);bellTap*=dec(9);arcHit*=dec(5);rhyFlare*=dec(7);for(let i=0;i<5;i++)pianoH[i]*=dec(11);
        if(leadS>0.04){arcH+=dt*(0.25+leadS*1.1)*(playing?1:0.25);if(arcH>1)arcH=0;}
        if(playing&&otherS>0.03){leakAcc+=dt*otherS*(calm?3:7);while(leakAcc>=1){leakAcc-=1;const fl=Math.floor(rnd()*Math.ceil((w-u*0.12)/(u*0.36)));const X=u*0.12+fl*u*0.36+u*0.009;puffAt(X+(rnd()-0.5)*u*0.01,L.pipeY-u*0.02,(rnd()-0.5)*u*0.02,-u*(0.03+rnd()*0.04),u*0.02,2+rnd()*1.5,0.55);}}beatLamp*=dec(6);shake*=dec(16);
        const target=tr.bass?(0.06+bassS*0.9):0.12+0.04*Math.sin(wall*1.3);
        ramVel+=((target-ramPos)*110-ramVel*13)*dt;ramPos+=ramVel*dt;
        if(ramPos<0){ramPos=0;ramVel=Math.abs(ramVel)*0.3;}if(ramPos>1.05){ramPos=1.05;ramVel=-Math.abs(ramVel)*0.3;}
        // MIDI -> pipes
        const ld=dec(7);for(let i=0;i<info.n;i++)lit[i]*=ld;
        const keys=new Set();
        for(const trk of info.tracks){const nn=frame.notes?.[trk.name];if(!nn)continue;
          for(const n of nn.active||[]){const i=pidx(n.pitch),v=n.velocity==null?0.8:n.velocity>1?n.velocity/127:n.velocity;
            lit[i]=Math.max(lit[i],0.6+0.4*v);litHue[i]=trk.hue;const key=trk.name+n.start+'/'+n.pitch;keys.add(key);
            if(playing){if(!prevKeys.has(key)&&!jumped)for(let j=0;j<(calm?2:6);j++)pipePuff(i,1.7);
              acc[i]+=dt*(calm?8:18)*(0.5+v);while(acc[i]>=1){acc[i]-=1;pipePuff(i,1);}}}}
        prevKeys=keys;

        // ---------- draw
        g.drawImage(bg,0,0,w,h);
        g.globalCompositeOperation='lighter';g.globalAlpha=0.05+0.22*vocS;g.fillStyle=L.grads.amb;g.fillRect(L.cx0-u*0.2,L.top-u*0.1,L.cx1-L.cx0+u*0.4,L.M);g.globalAlpha=1;g.globalCompositeOperation='source-over';
        g.save();
        if(shake>0.3)g.translate((rnd()-0.5)*shake*2,(rnd()-0.5)*shake*2);
        // flywheel: one turn per bar, crank at the top on the downbeat
        const {fx,fy,R,Rc,Lr}=L,b=frame.beat;
        const ang=b?.bar!=null?((b.bar-1)+(b.barPhase||0))*TAU:wall*0.6;
        g.save();g.translate(fx,fy);g.rotate(ang);g.drawImage(fly,-fly.width/k/2,-fly.height/k/2,fly.width/k,fly.height/k);g.restore();
        g.strokeStyle='hsla(40,60%,75%,0.18)';g.lineWidth=R*0.05;g.beginPath();g.arc(fx,fy,R*0.9,-2.6,-1.4);g.stroke();
        const pinX=fx+Rc*Math.sin(ang),pinY=fy-Rc*Math.cos(ang),chY=pinY+Math.sqrt(Math.max(0,Lr*Lr-(pinX-fx)**2));
        g.fillStyle='hsl(24,8%,20%)';g.fillRect(fx-R*0.16,fy+R*0.6,R*0.04,R*1.2);g.fillRect(fx+R*0.12,fy+R*0.6,R*0.04,R*1.2);
        g.fillStyle=metal(g,fx-R*0.04,0,fx+R*0.04,0,BRASS);g.fillRect(fx-R*0.035,chY,R*0.07,fy+R*1.8-chY);
        g.strokeStyle='hsl(24,8%,30%)';g.lineWidth=R*0.09;g.lineCap='round';g.beginPath();g.moveTo(pinX,pinY);g.lineTo(fx,chY);g.stroke();
        g.strokeStyle='hsla(40,40%,70%,0.3)';g.lineWidth=R*0.025;g.beginPath();g.moveTo(pinX,pinY);g.lineTo(fx,chY);g.stroke();g.lineCap='butt';
        g.fillStyle=metal(g,fx-R*0.14,0,fx+R*0.14,0,BRASS);g.fillRect(fx-R*0.12,chY-R*0.06,R*0.24,R*0.12);
        g.fillStyle='hsl(40,50%,55%)';g.beginPath();g.arc(pinX,pinY,R*0.06,0,TAU);g.fill();
        g.fillStyle=`hsl(30,${40+60*beatLamp}%,${20+55*beatLamp}%)`;g.beginPath();g.arc(fx,fy,R*0.09,0,TAU);g.fill();
        if(beatLamp>0.02){g.globalCompositeOperation='lighter';g.globalAlpha=beatLamp;const s=R*0.9;g.drawImage(glowFire,fx-s/2,fy-s/2,s,s);g.globalAlpha=1;g.globalCompositeOperation='source-over';}
        // bass ram
        const {rx,rw,rTop,rBot,capH}=L,g0=rTop+capH,g1=rBot-capH,gw=rw;
        g.fillStyle='hsla(20,30%,6%,0.92)';g.fillRect(rx-gw/2,g0,gw,g1-g0);
        const wy=g1-L.wh-clamp(ramPos,0,1.05)*(g1-g0-L.wh)*0.95;
        g.globalCompositeOperation='lighter';g.globalAlpha=0.25+0.6*bassS;g.fillStyle=L.grads.fl;g.fillRect(rx-gw/2,wy+L.wh*0.5,gw,g1-wy-L.wh*0.5);g.globalAlpha=1;g.globalCompositeOperation='source-over';
        g.drawImage(weight,rx-L.ww/2,wy,L.ww,L.wh);
        g.fillStyle='hsla(40,40%,80%,0.25)';for(let i=1;i<8;i++){const y=g0+(g1-g0)*i/8;g.fillRect(rx+gw*0.3,y,gw*0.2,1);}
        g.fillStyle='hsla(30,30%,90%,0.08)';g.fillRect(rx-gw*0.35,g0,gw*0.12,g1-g0);
        // roll + pipes
        drawTape(g,frame,t);
        // Jacob's ladder (lead guitar)
        {const b=Math.min(1,leadS*1.3)*(0.65+0.35*arcHit);
          if(b>0.03){const {jx,jw,jB,jT}=L,y=jB-u*0.02-arcH*(jB-u*0.02-jT),sp=0.14+0.36*Math.pow(arcH,1.4),xl=jx-jw*sp,xr=jx+jw*sp;
            if(!calm||Math.floor(wall*8)!==arcSeed){arcSeed=Math.floor(wall*8);}
            const R2=rng(1+(calm?arcSeed:Math.floor(wall*60))%2147483646),jit=jw*(calm?0.05:0.12),pts=[];
            for(let i=0;i<=8;i++){const f=i/8,x=xl+(xr-xl)*f,yy=y-Math.sin(Math.PI*f)*jw*0.35*(0.4+arcH)+(i&&i<8?(R2()-0.5)*jit*2:0);pts.push(x,yy);}
            g.globalCompositeOperation='lighter';
            const s=jw*2.4*b;g.globalAlpha=b*0.8;g.drawImage(glowArc,jx-s/2,y-jw*0.2-s/2,s,s);g.globalAlpha=1;
            const line=(lw,st)=>{g.strokeStyle=st;g.lineWidth=lw;g.beginPath();g.moveTo(pts[0],pts[1]);for(let i=2;i<pts.length;i+=2)g.lineTo(pts[i],pts[i+1]);g.stroke();};
            g.lineJoin='round';line(u*0.016,`hsla(205,100%,65%,${0.16*b})`);line(u*0.006,`hsla(205,100%,78%,${0.5*b})`);line(Math.max(1,u*0.0018),`rgba(240,250,255,${b})`);
            g.globalCompositeOperation='source-over';}}
        // piano action
        {const P=L.pn,n=5,step=(P.x1-P.x0)/n,len=P.pY-P.sY-P.hr*1.1;
          g.lineCap='round';
          for(let i=0;i<n;i++){const hx=P.x0+(i+0.5)*step,a=-0.42*(1-Math.min(1,pianoH[i]*1.6)),ex=hx+Math.sin(a)*len,ey=P.pY-Math.cos(a)*len;
            g.strokeStyle='hsl(30,30%,55%)';g.lineWidth=Math.max(1,u*0.0025);g.beginPath();g.moveTo(hx,P.pY);g.lineTo(ex,ey);g.stroke();
            g.fillStyle='hsl(352,30%,34%)';rr(g,ex-P.hr*0.8,ey-P.hr,P.hr*1.6,P.hr*2,P.hr*0.6);g.fill();
            g.fillStyle='hsla(30,30%,80%,0.25)';g.fillRect(ex-P.hr*0.8,ey-P.hr,P.hr*0.4,P.hr*2);}
          g.lineCap='butt';
          let ring=0;for(let i=0;i<n;i++)ring=Math.max(ring,pianoH[i]);
          const by=P.sY+P.hr*0.1-u*0.005;g.fillStyle=metal(g,0,by-u*0.005,0,by+u*0.005,BRASS);g.fillRect(P.x0-u*0.012,by-u*0.005,P.x1-P.x0+u*0.024,u*0.01);
          if(ring>0.03){g.globalCompositeOperation='lighter';g.fillStyle=`hsla(45,90%,70%,${ring*0.5})`;g.fillRect(P.x0-u*0.012,by-u*0.005,P.x1-P.x0+u*0.024,u*0.01);
            const s=(P.x1-P.x0)*0.9*ring;g.globalAlpha=ring*0.5;g.drawImage(glowBell,(P.x0+P.x1)/2-s/2,by-s/2,s,s);g.globalAlpha=1;g.globalCompositeOperation='source-over';}}
        g.globalCompositeOperation='lighter';
        for(let i=0;i<info.n;i++){const a=lit[i];if(a<0.02)continue;const xc=pipeX(i),yt=L.ptop[i];
          g.fillStyle=`hsla(${litHue[i]},80%,60%,${a*0.22})`;g.fillRect(xc-L.pb/2,yt,L.pb,L.chestY-yt);
          const sp=glowTrk[litHue[i]]||glowFire,s1=L.pb*3.2*a;g.globalAlpha=a;g.drawImage(sp,xc-s1/2,L.chestY-L.pb-s1/2,s1,s1);
          const s2=L.pb*4*a;g.globalAlpha=a*0.7;g.drawImage(sp,xc-s2/2,yt-L.pb*0.1-s2/2,s2,s2);
          g.globalAlpha=a;g.fillStyle=`hsl(${litHue[i]},90%,80%)`;g.fillRect(xc-L.pb*0.22,L.trackY+L.trackH*0.25,L.pb*0.44,L.trackH*0.5);g.globalAlpha=1;}
        const hi=Math.round(hue/30)%12,cy=L.chestY+L.chestH*0.5;
        L.lamps.forEach((X,i)=>{const d=(wall-chase)*14-i,ch=d>0&&d<2?1-Math.abs(d-1):0,fl=rhyFlare*(calm?0.5:1),a=0.38+0.2*rhyS+0.55*fl+0.6*ch*(calm?0.5:1),s=L.chestH*(1.5+1.2*fl+1.6*ch);
          g.globalAlpha=Math.min(1,a);g.drawImage(glowHue[hi],X-s/2,cy-s/2,s,s);g.globalAlpha=1;});
        g.globalCompositeOperation='source-over';
        L.lamps.forEach(X=>{g.fillStyle=`hsl(${hue},80%,72%)`;g.beginPath();g.arc(X,cy,L.chestH*0.13,0,TAU);g.fill();});
        // hammer + anvil
        const lift=hammerLift(t,frame,drumsOff),ha=-lift*1.15;
        if(anvilGlow>0.02){g.globalCompositeOperation='lighter';g.globalAlpha=anvilGlow;const s=u*0.28*anvilGlow;g.drawImage(glowFire,L.ax-s/2,L.aTop-s/2,s,s);
          g.fillStyle=`hsla(25,100%,60%,${anvilGlow*0.6})`;g.fillRect(L.ax-u*0.075,L.aTop,u*0.13,u*0.006);g.globalAlpha=1;g.globalCompositeOperation='source-over';}
        g.save();g.translate(L.px,L.py);g.rotate(ha);
        g.strokeStyle='hsl(28,35%,26%)';g.lineWidth=u*0.014;g.beginPath();g.moveTo(0,0);g.lineTo(L.Lh,0);g.stroke();
        g.strokeStyle='hsla(30,40%,55%,0.5)';g.lineWidth=u*0.004;g.beginPath();g.moveTo(0,-u*0.003);g.lineTo(L.Lh,-u*0.003);g.stroke();
        g.drawImage(head,L.Lh-L.headW/2,-L.headH/2,L.headW,L.headH);g.restore();
        g.fillStyle=metal(g,L.px-u*0.022,0,L.px+u*0.022,0,BRASS);g.beginPath();g.arc(L.px,L.py,u*0.02,0,TAU);g.fill();rivet(g,L.px,L.py,u*0.006);
        // bell tapper + rings
        const {bx,by,br}=L,ta=1.95+bellTap*0.3,tpx=bx+br*1.75,tpy=by-br*1.5,tbx=tpx+Math.cos(ta)*br*1.55,tby=tpy+Math.sin(ta)*br*1.55;
        g.strokeStyle='hsl(24,10%,30%)';g.lineWidth=u*0.004;g.beginPath();g.moveTo(tpx,tpy);g.lineTo(tbx,tby);g.stroke();
        g.fillStyle='hsl(40,30%,40%)';g.beginPath();g.arc(tbx,tby,br*0.22,0,TAU);g.fill();
        g.globalCompositeOperation='lighter';
        if(bellTap>0.02){g.globalAlpha=bellTap*0.7;const s=br*5*bellTap;g.drawImage(glowBell,bx-s/2,by-br*0.3-s/2,s,s);g.globalAlpha=1;}
        for(let i=rings.length-1;i>=0;i--){const r=rings[i];r.age+=dt;if(r.age>0.6){rings.splice(i,1);continue;}
          g.strokeStyle=`hsla(45,80%,70%,${0.4*(1-r.age/0.6)})`;g.lineWidth=u*0.003;g.beginPath();g.arc(bx,by-br*0.3,br*(1.3+r.age*3),-Math.PI*0.85,-Math.PI*0.15);g.stroke();}
        // sparks
        g.lineCap='round';g.lineWidth=Math.max(1,u*0.0025);
        for(let i=sparks.length-1;i>=0;i--){const s=sparks[i];s.age+=dt;if(s.age>s.max){sparks[i]=sparks[sparks.length-1];sparks.pop();continue;}
          s.vy+=u*1.8*dt;s.x+=s.vx*dt;s.y+=s.vy*dt;const a=1-s.age/s.max;
          g.strokeStyle=`hsla(${30+20*a},100%,${55+30*a}%,${a})`;g.beginPath();g.moveTo(s.x,s.y);g.lineTo(s.x-s.vx*0.025,s.y-s.vy*0.025);g.stroke();}
        g.lineCap='butt';g.globalCompositeOperation='source-over';
        // steam
        const wind=Math.sin(wall*0.4)*u*0.03;
        for(let i=steam.length-1;i>=0;i--){const p=steam[i];p.age+=dt;if(p.age>p.max){steam[i]=steam[steam.length-1];steam.pop();continue;}
          const dd=Math.exp(-dt*1.8);p.vx=p.vx*dd+wind*dt;p.vy=p.vy*dd-u*0.02*dt;p.x+=p.vx*dt;p.y+=p.vy*dt;
          const q=p.age/p.max,s=p.s0+u*0.09*q,a=Math.pow(1-q,1.5)*0.32*p.a*Math.min(1,p.age/0.06);
          g.globalAlpha=a;g.drawImage(puff,p.x-s/2,p.y-s/2,s,s);}
        g.globalAlpha=1;
        g.restore();
        g.drawImage(vig,0,0,w,h);
        // screens
        g.drawImage(front,0,0,w,h);
        drawChordScreen(g,frame,wall,calm);
        drawLyricScreen(g,frame,t);
        g.drawImage(scan,0,0,w,h);
        drawSection(g,frame);
      },
      dispose(){bg=front=scan=vig=fly=head=weight=null;steam.length=sparks.length=rings.length=0;},
    };
  },
};
