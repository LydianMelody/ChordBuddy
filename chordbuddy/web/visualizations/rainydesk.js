// Rainy Desk: a lo-fi study scene printed as a three-ink risograph (blue, fluorescent pink, yellow) on cream paper,
// redrawn at 12 frames a second like hand-drawn animation, with a little registration drift between the inks.
//   Chords        -> the desk clock: the chord in seven-segment digits, a colon that blinks on the beat, the next chord dimmer,
//                    and four pips counting down the beats to the change. The cat's tail flicks on every change; on the key's
//                    home chord the cat sleeps soundly (z's float up).
//   Melody MIDI   -> she writes the tune in her notebook as it plays: height = pitch, stroke length = note length, the pen lifts on
//                    leaps and rests; blue = sung, pink = instrumental, a small loop on the key's tonic, a dot over notes outside the key.
//                    Her pencil hand follows the note being written. A new page turns at every section (and when a page fills).
//   Beat          -> she nods along, chin on her hand (deeper with the kick and when the song is loud). She blinks now and then.
//   Drums         -> raindrops fall outside and land on the leaves exactly on the drum hits; the leaf dips and springs back.
//   Bass          -> the curtain sways.               Rhythm guitar -> the fairy lights: each strum lights the next bulb.
//   Lead guitar   -> a night train crosses the city.  Piano -> windows in the city switch on and off.
//   Vocals        -> the desk lamp warms up; the lyric line is printed under the picture, the current word in red.
//   Other         -> steam from the mug.              Sections -> page turns, rain heavier in choruses, a new print registration.
//   Loudness      -> scales the nod, leaf bounce and rain so a quiet bridge stays quiet.
// Calm mode: smaller nod, steady lamp. Nothing here flashes.
import {chordColor} from '../visual-color.js';

const TAU=Math.PI*2,FPS=12,VW=1600,VH=900,ROWS=5;
const INK=[[0,120,191],[255,72,176],[255,232,0]],PAPER='#f3ecdc';
const TYPE='"Courier Prime","Courier New",ui-monospace,monospace',MONO='"Space Mono",ui-monospace,Consolas,monospace';
const clamp=(v,a,b)=>v<a?a:v>b?b:v,lerp=(a,b,p)=>a+(b-a)*p,ease=x=>x<=0?0:x>=1?1:x*x*(3-2*x);
const after=(a,t)=>{let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m].start<=t)lo=m+1;else hi=m;}return lo;};
const hsh=(a,b=0)=>{let x=(Math.imul(a|0,374761393)+Math.imul(b|0,668265263))|0;x=Math.imul(x^(x>>>13),1274126177);x^=x>>>16;return (x>>>0)/4294967296;};
const rng=seed=>{let s=seed;return()=>(s=s*16807%2147483647)/2147483647;};
const rgba=(c,a)=>`rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mk=(W,H)=>{const c=document.createElement('canvas');c.width=Math.max(1,Math.ceil(W));c.height=Math.max(1,Math.ceil(H));return c;};
const PCN={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const pcOf=s=>{const m=/^([A-G])([#b♯♭]?)/.exec(String(s||''));if(!m)return null;return (PCN[m[1]]+(m[2]==='#'||m[2]==='♯'?1:m[2]==='b'||m[2]==='♭'?-1:0)+12)%12;};
const SEG={A:'abcefg',B:'cdefg',C:'adef',D:'bcdeg',E:'adefg',F:'aefg',G:'acdef','-':'g'};
const parseChord=l=>{if(!l)return null;const m=/^([A-G])([#b♯♭]?)([^/]*)(?:\/(.+))?$/.exec(String(l).trim());
  if(!m)return {root:'-',acc:'',qual:String(l).slice(0,5),bass:''};return {root:m[1],acc:m[2]==='♯'?'#':m[2]==='♭'?'b':m[2],qual:m[3],bass:m[4]||''};};
const P=fn=>{const p=new Path2D();fn(p);return p;};
const R=(x,y,w,h)=>P(p=>p.rect(x,y,w,h));
const RR=(x,y,w,h,r)=>P(p=>p.roundRect(x,y,w,h,r));
const E=(x,y,rx,ry,rot=0)=>P(p=>p.ellipse(x,y,rx,ry,rot,0,TAU));
const POLY=pts=>P(p=>{pts.forEach((q,i)=>i?p.lineTo(q[0],q[1]):p.moveTo(q[0],q[1]));p.closePath();});
const LINE=pts=>P(p=>pts.forEach((q,i)=>i?p.lineTo(q[0],q[1]):p.moveTo(q[0],q[1])));
const GX0=152,GY0=82,GX1=848,GY1=548;

function prep(song){
  const midi=song?.midi||{},mel=midi.melody?.notes||[],voc=midi.vocal?.notes||[],ins=midi.instrumental?.notes||[];
  const vox=new Set();voc.forEach(x=>vox.add(Math.round(x.start*50)));
  const isVox=s=>{const r=Math.round(s*50);return vox.has(r)||vox.has(r-1)||vox.has(r+1);};
  let src=mel.length?mel.slice():ins.slice();
  if(voc.length){const have=new Set(src.map(x=>Math.round(x.start*50)));for(const x of voc){const r=Math.round(x.start*50);if(!have.has(r)&&!have.has(r-1)&&!have.has(r+1))src.push(x);}}
  const N=src.filter(x=>x&&x.end>x.start&&isFinite(x.pitch)).map(x=>({start:x.start,end:x.end,pitch:x.pitch,vox:isVox(x.start)})).sort((a,b)=>a.start-b.start);
  const ps=N.map(x=>x.pitch).sort((a,b)=>a-b);let lo=60,hi=76;
  if(ps.length){lo=ps[Math.floor(ps.length*0.03)];hi=ps[Math.min(ps.length-1,Math.floor(ps.length*0.97))];}
  if(hi-lo<10){const m=(lo+hi)/2;lo=Math.floor(m-5);hi=Math.ceil(m+5);}
  const keyRoot=pcOf(song?.key),keyMinor=/minor|min\b|^[A-G][#b]?m$/i.test(String(song?.key||''));
  const steps=keyMinor?[0,2,3,5,7,8,10]:[0,2,4,5,7,9,11],scale=new Set(keyRoot==null?[]:steps.map(s=>(s+keyRoot)%12));
  for(const x of N){x.pn=clamp((x.pitch-lo)/(hi-lo),0,1);const pc=((x.pitch%12)+12)%12;x.home=keyRoot!=null&&pc===keyRoot;x.out=keyRoot!=null&&!scale.has(pc);}
  const bars=(song?.bars||[]).filter(b=>isFinite(b.start)).slice().sort((a,b)=>a.start-b.start);
  bars.forEach((b,i)=>{if(!(b.end>b.start))b.len=bars[i+1]?bars[i+1].start-b.start:(bars[i-1]?b.start-bars[i-1].start:2);else b.len=b.end-b.start;});
  // drops: the stronger drum hits (spaced so the leaves never get crowded); beats 2 and 4 if there are no stems
  let H=(song?.features?.tracks?.drums?.hits||[]).filter(x=>isFinite(x.start)).slice().sort((a,b)=>a.start-b.start);
  if(!H.length){H=[];bars.forEach(b=>{for(const q of [1,3])H.push({start:b.start+b.len*q/4,strength:0.6});});}
  const st=H.map(x=>x.strength??0.6).sort((a,b)=>a-b),thr=st.length?st[Math.floor(st.length*0.35)]:0;
  const D=[];let last=-9,prevLeaf=-1;
  for(const x of H){const s=x.strength??0.6;if(s<thr||x.start-last<0.22)continue;last=x.start;
    let li=Math.floor(hsh(D.length,7)*7);if(li===prevLeaf)li=(li+1+Math.floor(hsh(D.length,9)*6))%7;prevLeaf=li;
    const rank=st.length>1?after(st.map(v=>({start:v})),s)/st.length:0.6;D.push({start:x.start,leaf:li,str:clamp(rank,0,1)});}
  const RH=[];last=-9;for(const x of (song?.features?.tracks?.rhythm?.hits||[]).slice().sort((a,b)=>a.start-b.start))if(x.start-last>0.08){RH.push({start:x.start,str:x.strength??0.7});last=x.start;}
  const secs=(song?.sections||[]).filter(s=>s&&s.end>s.start).slice().sort((a,b)=>a.start-b.start);
  return {N,lo,hi,keyRoot,keyMinor,bars,D,RH,secs,rowCache:{}};
}

function buildCity(){
  const r=rng(11),far=[],near=[],win=[];
  for(let x=GX0-20;x<GX1+20;){const bw=40+r()*55,top=330+r()*110;far.push([x,top,bw]);
    for(let wy=top+14;wy<GY1-8;wy+=18)for(let wx=x+8;wx<x+bw-10;wx+=14)if(r()<0.6)win.push({x:wx,y:wy,w:6,h:9,lit:r()<0.3,near:false});x+=bw+2+r()*6;}
  for(let x=GX0-30;x<GX1+30;){const bw=55+r()*70,top=420+r()*80;near.push([x,top,bw]);
    for(let wy=top+12;wy<GY1-6;wy+=20)for(let wx=x+9;wx<x+bw-12;wx+=17)if(r()<0.55)win.push({x:wx,y:wy,w:8,h:11,lit:r()<0.25,near:true});x+=bw+r()*4;}
  return {far,near,win};
}
function buildLeaves(){
  const P0=[884,98],C=[760,132],P2=[598,238],bz=s=>[(1-s)*(1-s)*P0[0]+2*(1-s)*s*C[0]+s*s*P2[0],(1-s)*(1-s)*P0[1]+2*(1-s)*s*C[1]+s*s*P2[1]];
  const A=[[0.16,200,70],[0.3,112,62],[0.46,224,70],[0.6,100,60],[0.74,206,66],[0.9,126,56]].map(([s,a,len],i)=>{const q=bz(s);return {x:q[0],y:q[1],a:a*Math.PI/180,len,v:i%2};});
  A.push({x:752,y:118,a:252*Math.PI/180,len:50,v:0});
  return A.map(l=>({...l,dir:Math.cos(l.a)>=0?1:-1,k:Math.abs(Math.cos(l.a))*0.8+0.35}));
}
function buildBooks(){
  const r=rng(5),pal=[[0.8,0.1,0],[0,0.85,0.35],[0.05,0.12,0.9],[0.55,0.6,0.1],[0.1,0.55,0.85],[0.85,0.4,0.3],[0.3,0.2,0.6]],B=[];
  for(let x=1198;x<1430;){const w=16+r()*16,h=62+r()*44;B.push({x,w,h,c:pal[Math.floor(r()*pal.length)],stripe:r()<0.6});x+=w+1;}
  const l=B[B.length-1];l.lean=0.22;return B;
}

export default {
  id:'rainydesk',
  name:'Rainy Desk',
  order:55,
  hud:false,   // the desk clock shows the chord, the print's caption shows the lyrics
  create(){
    let w=0,h=0,pr=1,W=0,H=0,print=null,px=null,paper=null,X=[],pats=[];
    let info=null,songRef=null,lastIdx=-1,dirty=true,lastT=null;
    let eS=0,ePk=0.05,vocS=0,bassS=0,othS=0,leadS=0,rainS=0.5,train=null,lastTrainEnd=-9,toggles=0,lyr={key:''};
    const city=buildCity(),leaves=buildLeaves(),books=buildBooks();

    // ---- ink helpers: every shape knocks out what is behind it in all three inks, then lays down its own coverage [blue, pink, yellow]
    function paint(c,i,a){
      if(typeof a==='number'){c.globalAlpha=a;c.fillStyle=c.strokeStyle=rgba(INK[i],1);return;}
      c.globalAlpha=1;const gr=a.rad?c.createRadialGradient(a.rad[0],a.rad[1],0,a.rad[0],a.rad[1],a.rad[2]):c.createLinearGradient(...a.lin);
      a.a.forEach((v,k)=>gr.addColorStop(k/(a.a.length-1),rgba(INK[i],v)));c.fillStyle=c.strokeStyle=gr;
    }
    function fill(p,cov,over,rule='nonzero'){for(let i=0;i<3;i++){const c=X[i];
      if(!over){c.globalCompositeOperation='destination-out';c.globalAlpha=1;c.fillStyle='#000';c.fill(p,rule);}
      if(cov[i]){c.globalCompositeOperation='source-over';paint(c,i,cov[i]);c.fill(p,rule);}}}
    function stroke(p,cov,lw,over,cap='round'){for(let i=0;i<3;i++){const c=X[i];c.lineWidth=lw;c.lineCap=cap;c.lineJoin='round';
      if(!over){c.globalCompositeOperation='destination-out';c.globalAlpha=1;c.strokeStyle='#000';c.stroke(p);}
      if(cov[i]){c.globalCompositeOperation='source-over';paint(c,i,cov[i]);c.stroke(p);}}}
    function erase(p,amt,lw){for(let i=0;i<3;i++){if(!amt[i])continue;const c=X[i];c.globalCompositeOperation='destination-out';c.globalAlpha=amt[i];
      if(lw){c.lineWidth=lw;c.lineCap='round';c.lineJoin='round';c.strokeStyle='#000';c.stroke(p);}else{c.fillStyle='#000';c.fill(p);}}}
    function text(s,x,y,font,cov,align='left',over=true){for(let i=0;i<3;i++){const c=X[i];c.font=font;c.textAlign=align;c.textBaseline='alphabetic';
      if(!over){c.globalCompositeOperation='destination-out';c.globalAlpha=1;c.fillStyle='#000';c.fillText(s,x,y);}
      if(cov[i]){c.globalCompositeOperation='source-over';paint(c,i,cov[i]);c.fillText(s,x,y);}}}
    // light = take blue (and a little pink) away, add yellow
    function light(cx,cy,rx,ry,a){if(a<=0.01)return;for(let i=0;i<3;i++){const c=X[i];c.save();c.translate(cx,cy);c.scale(1,ry/rx);
      const gr=c.createRadialGradient(0,0,0,0,0,rx),amt=[0.6,0.22,0.42][i]*a;
      if(i<2){c.globalCompositeOperation='destination-out';gr.addColorStop(0,`rgba(0,0,0,${amt})`);gr.addColorStop(1,'rgba(0,0,0,0)');}
      else{c.globalCompositeOperation='source-over';gr.addColorStop(0,rgba(INK[2],amt));gr.addColorStop(1,rgba(INK[2],0));}
      c.globalAlpha=1;c.fillStyle=gr;c.fillRect(-rx,-rx,rx*2,rx*2);c.restore();}}
    const tx=(x,y,r,sx=1,sy=1)=>{for(const c of X){c.save();c.translate(x,y);c.rotate(r);c.scale(sx,sy);c.translate(-x,-y);}};
    const clip=p=>{for(const c of X){c.save();c.clip(p);}};
    const pop=()=>{for(const c of X)c.restore();};

    function seven(x,y,w,hh,th,ch,ghost,lit){
      const on=SEG[ch]||'',sk=0.12,pt=(qx,qy)=>[qx+(y+hh-qy)*sk,qy],g=th*0.18;
      const hz=(x0,x1,yc)=>POLY([pt(x0+g,yc),pt(x0+th/2+g,yc-th/2),pt(x1-th/2-g,yc-th/2),pt(x1-g,yc),pt(x1-th/2-g,yc+th/2),pt(x0+th/2+g,yc+th/2)]);
      const vt=(xc,y0,y1)=>POLY([pt(xc,y0+g),pt(xc+th/2,y0+th/2+g),pt(xc+th/2,y1-th/2-g),pt(xc,y1-g),pt(xc-th/2,y1-th/2-g),pt(xc-th/2,y0+th/2+g)]);
      const S={a:hz(x,x+w,y+th/2),g:hz(x,x+w,y+hh/2),d:hz(x,x+w,y+hh-th/2),f:vt(x+th/2,y,y+hh/2),b:vt(x+w-th/2,y,y+hh/2),e:vt(x+th/2,y+hh/2,y+hh),c:vt(x+w-th/2,y+hh/2,y+hh)};
      for(const k in S)fill(S[k],on.includes(k)?lit:ghost);
    }

    function pageClock(t){
      const I=info,secs=I.secs;let i=after(secs,t)-1,sStart=0;
      if(i>=0&&t<secs[i].end)sStart=secs[i].start;else if(i>=0)sStart=secs[i].end;
      let rd=I.rowCache[sStart];
      if(!rd){const b=I.bars[Math.max(0,after(I.bars,sStart+0.05)-1)];rd=I.rowCache[sStart]=clamp(2*(b?.len||2.5),2.4,9);}
      const page=Math.max(0,Math.floor((t-sStart)/(rd*ROWS))),ps=sStart+page*rd*ROWS;
      return {ps,rd,row:clamp(Math.floor((t-ps)/rd),0,ROWS-1)};
    }

    function scene(fr,env,A){
      const t=fr.time||0,wall=env.wall||0,calm=!!env.calm,I=info,tr=fr.tracks||{};
      // wall, shelf
      fill(R(0,0,VW,VH),[{lin:[0,0,0,VH],a:[0.42,0.26]},0.17,0.05]);
      fill(R(1168,228,424,14),[0.5,0.55,0.6]);fill(R(1192,242,10,24),[0.5,0.55,0.6]);fill(R(1556,242,10,24),[0.5,0.55,0.6]);
      for(const b of books){const p=R(b.x,228-b.h,b.w,b.h);if(b.lean)tx(b.x+b.w,228,b.lean);fill(p,b.c);if(b.stripe)fill(R(b.x+2,228-b.h*0.72,b.w-4,5),[0.05,0.12,0.25]);if(b.lean)pop();}
      fill(E(1500,186,30,12),[0.75,0.05,0.9]);
      fill(POLY([[1462,190],[1540,190],[1532,228],[1470,228]]),[0.05,0.6,0.5]);fill(R(1458,184,86,10),[0.1,0.7,0.55]);
      for(let k=0;k<3;k++){const bx=1478+k*18,sw=Math.sin(wall*0.6+k*1.7)*5,len=110+k*55,vine=P(p=>{p.moveTo(bx,184);p.quadraticCurveTo(bx+sw-14,190+len*0.5,bx+sw*1.6+k*6-8,196+len);});
        stroke(vine,[0.75,0.2,0.7],3);
        for(let j=1;j<=5;j++){const f=j/5.4,lx=lerp(bx,bx+sw*1.6+k*6-8,f)+(j%2?7:-7)-6*Math.sin(f*3),ly=196+len*f;fill(E(lx,ly,9,6,j%2?0.6:-0.6),[0.7,0.05,0.9]);}}

      // ---- outside the window
      clip(R(GX0,GY0,GX1-GX0,GY1-GY0));
      fill(R(GX0,GY0,GX1-GX0,GY1-GY0),[{lin:[0,GY0,0,GY1],a:[1,0.62]},{lin:[0,GY0,0,GY1],a:[0.18,0.5]},0]);
      for(let k=0;k<3;k++){const cx=GX0-200+((k*330+wall*5)%1100),cy=150+k*55;fill(E(cx,cy,160,22),[0.72,0.3,0],true);}
      // far city, its windows, the night train, the near city
      fill(P(p=>{p.moveTo(GX0-40,GY1);for(const [x,top,bw] of city.far){p.lineTo(x,top);p.lineTo(x+bw,top);}p.lineTo(GX1+40,GY1);p.closePath();}),[0.9,0.55,0.05]);
      const winPath=near=>P(p=>{for(const q of city.win)if(q.lit&&q.near===near)p.rect(q.x,q.y,q.w,q.h);});
      fill(winPath(false),[0.15,0.35,0.95]);
      stroke(LINE([[GX0,476],[GX1,476]]),[1,0.7,0.2],4);
      for(let x=GX0+40;x<GX1;x+=120)fill(R(x,476,5,80),[1,0.7,0.2]);
      if(train){const x0=trainX(train,t),TL=380;fill(RR(x0,452,TL,22,5),[1,0.6,0.25]);
        const wl=0.65+0.35*clamp(leadS*1.6,0,1);fill(P(p=>{for(let wx=x0+12;wx<x0+TL-16;wx+=26)p.rect(wx,457,14,9);}),[0,0.3,wl]);}
      fill(P(p=>{p.moveTo(GX0-40,GY1+5);for(const [x,top,bw] of city.near){p.lineTo(x,top);p.lineTo(x+bw,top);}p.lineTo(GX1+40,GY1+5);p.closePath();}),[1,0.75,0.2]);
      fill(winPath(true),[0.1,0.4,0.95]);
      // rain
      const nR=Math.round(30+90*rainS);stroke(P(p=>{for(let i=0;i<nR;i++){const sp=420+hsh(i,3)*200,y=((hsh(i,1)*700+wall*sp)%700)+GY0-80,x=GX0-80+hsh(i,2)*(GX1-GX0+120)+(y-GY0)*0.16;p.moveTo(x,y);p.lineTo(x+4.5,y+28);}}),[0.42,0.15,0],1.6);
      // branch, leaves, the drops that land on them
      stroke(P(p=>{p.moveTo(900,90);p.quadraticCurveTo(760,132,598,238);}),[0.9,0.6,0.4],11);
      stroke(P(p=>{p.moveTo(772,140);p.quadraticCurveTo(762,124,752,118);}),[0.9,0.6,0.4],5);
      const bend=leaves.map(()=>0),D=I.D,i0=after(D,t-1.2),i1=after(D,t+0.65),bAmp=(0.5+0.5*A.amp)*0.42;
      for(let i=i0;i<i1;i++){const d=D[i],age=t-d.start;if(age>=0)bend[d.leaf]+=(0.4+0.6*d.str)*Math.exp(-age*5)*Math.sin(age*17)*bAmp;}
      const land=leaves.map((l,i)=>{const a=l.a+l.dir*l.k*bend[i]+Math.sin(wall*0.8+i)*0.03;
        tx(l.x,l.y,a);fill(P(p=>{p.moveTo(l.x,l.y);p.quadraticCurveTo(l.x+l.len*0.4,l.y-l.len*0.34,l.x+l.len,l.y);p.quadraticCurveTo(l.x+l.len*0.4,l.y+l.len*0.34,l.x,l.y);}),l.v?[0.85,0.25,0.8]:[0.62,0.05,0.95]);
        stroke(LINE([[l.x+4,l.y],[l.x+l.len*0.85,l.y]]),l.v?[0.5,0.1,0.65]:[0.3,0,0.75],2);pop();
        return [l.x+Math.cos(a)*l.len*0.55,l.y+Math.sin(a)*l.len*0.55-4];});
      const PAPERCOV=[0.06,0,0.06];
      for(let i=i0;i<i1;i++){const d=D[i],q=land[d.leaf],tau=d.start-t,r=2.6+2.6*d.str;
        if(tau>0&&tau<0.6){const p=1-tau/0.6,y=60+(q[1]-60)*p*p;stroke(LINE([[q[0],y-6-16*p],[q[0],y-3]]),[0.4,0.1,0],1.4);
          fill(P(pp=>{pp.moveTo(q[0],y-r*2.2);pp.quadraticCurveTo(q[0]+r*1.1,y-r*0.2,q[0],y+r);pp.quadraticCurveTo(q[0]-r*1.1,y-r*0.2,q[0],y-r*2.2);}),PAPERCOV);}
        else if(tau<=0&&tau>-0.32){const age=-tau;fill(P(pp=>{for(let k=0;k<4;k++){const vx=(k-1.5)*36*(0.6+d.str),vy=-70-50*d.str,x=q[0]+vx*age,y=q[1]+vy*age+420*age*age,rr=(1.8+d.str)*(1-age/0.32)+0.5;pp.moveTo(x+rr,y);pp.arc(x,y,rr,0,TAU);}}),PAPERCOV);}}
      // the cat's z's drift up the glass on the home chord
      const ch=fr.chord||{},cc=ch.label?chordColor(ch.label):null,home=cc&&I.keyRoot!=null&&pcOf(ch.label)===I.keyRoot&&!!cc.minor===I.keyMinor;
      if(home){const age=Math.max(0,t-(ch.start||t));for(let k=0;k<3;k++){const f=((age*0.45+k/3)%1);if(age*0.45+k/3<0.33)continue;
        text('z',600+k*9-f*24,500-f*120,`700 ${Math.round(20-f*7)}px ${TYPE}`,PAPERCOV,'center',false);}}
      pop();
      // window frame
      fill(P(p=>{p.rect(130,60,740,510);p.rect(GX0,GY0,GX1-GX0,GY1-GY0);}),[0.1,0.12,0.26],false,'evenodd');
      fill(R(490,GY0,20,GY1-GY0),[0.1,0.12,0.26]);fill(R(GX0,300,GX1-GX0,16),[0.1,0.12,0.26]);
      stroke(P(p=>p.rect(GX0,GY0,GX1-GX0,GY1-GY0)),[0.4,0.3,0.32],3,true);
      // fairy lights: each strum lights the next bulb
      const NB=12,glow=new Array(NB).fill(0),RH=I.RH,ri=after(RH,t);
      for(let j=ri-1;j>=0&&j>=ri-NB*2;j--){const age=t-RH[j].start;if(age>2.5)break;glow[j%NB]+=(0.35+0.65*RH[j].str)*Math.exp(-age*2.2)*(0.55+0.45*A.amp);}
      const bulb=f=>[170+680*f,96+34*4*f*(1-f)];
      stroke(P(p=>{for(let k=0;k<=20;k++){const q=bulb(k/20);k?p.lineTo(q[0],q[1]):p.moveTo(q[0],q[1]);}}),[0.7,0.5,0.2],2,true);
      for(let k=0;k<NB;k++){const q=bulb((k+0.5)/NB),L=clamp(glow[k],0,1);fill(E(q[0],q[1]+7,5.5,7),[0.3*(1-L),0.22+0.25*L,0.55+0.45*L]);light(q[0],q[1]+8,28+20*L,28+20*L,0.15+0.85*L);}
      // sill, cat
      fill(R(110,548,780,30),[0.12,0.14,0.3]);fill(R(110,578,780,18),[0.32,0.28,0.38]);
      const br=Math.sin(wall*1.3)*0.035,cs=ch.label?(ch.start??t):-99,ca=t-cs,flick=ca>=0&&ca<2?Math.exp(-ca*2.2)*Math.sin(ca*10)*0.55:0,CAT=[0.06,0.5,0.78];
      tx(784,534,0.15+flick);stroke(P(p=>{p.moveTo(784,534);p.bezierCurveTo(814,544,820,574,796,600);}),CAT,12);pop();
      fill(E(700,524-br*14,88,30*(1+br)),CAT);
      fill(E(624,522,31,28),CAT);fill(POLY([[600,506],[598,478],[620,498]]),CAT);fill(POLY([[628,496],[648,476],[650,506]]),CAT);
      stroke(P(p=>{p.moveTo(608,522);p.quadraticCurveTo(614,527,620,522);p.moveTo(630,522);p.quadraticCurveTo(636,527,642,522);}),[0.7,0.6,0.5],2.2,false);
      stroke(P(p=>{for(let k=0;k<3;k++){const sx=690+k*24;p.moveTo(sx,498-br*14);p.quadraticCurveTo(sx+6,510,sx+2,522);}}),[0.12,0.7,0.85],4,true);
      fill(E(668,548,26,8),CAT);
      // curtain (bass sways it)
      const sw=(Math.sin(wall*0.7)*0.35+0.65*clamp(bassS*1.3,0,1))*26;
      const cur=P(p=>{p.moveTo(36,46);p.lineTo(208+sw*0.2,46);p.bezierCurveTo(232+sw*0.4,220,178+sw,400,214+sw*1.3,624);p.lineTo(36,624);p.closePath();});
      fill(cur,[0.06,0.6,0.42]);
      for(let k=0;k<3;k++){const fx=78+k*42;stroke(P(p=>{p.moveTo(fx,60);p.bezierCurveTo(fx+10+sw*0.3*k/2,240,fx-8+sw*0.6*k/2,420,fx+6+sw*0.9*k/2,620);}),[0.22,0.78,0.5],7,true);}
      stroke(LINE([[24,44],[906,44]]),[0.8,0.5,0.2],7);fill(E(24,44,9,9),[0.8,0.5,0.2]);fill(E(906,44,9,9),[0.8,0.5,0.2]);

      // ---- desk
      fill(R(0,628,VW,VH-628),[0.18,0.42,0.55]);fill(R(0,628,VW,10),[0.42,0.45,0.5]);
      // mug and steam (Other)
      fill(E(322,712,40,8),[0.35,0.4,0.3]);fill(RR(290,646,64,66,10),[0.08,0.78,0.25]);
      stroke(P(p=>{p.moveTo(354,664);p.bezierCurveTo(382,664,382,698,354,698);}),[0.08,0.78,0.25],8,false);
      fill(E(322,648,32,6),[0.55,0.45,0.75]);
      const steam=0.18+0.62*clamp(othS*1.4,0,1);
      for(let k=0;k<3;k++){const bx=306+k*15;erase(P(p=>{for(let y=640;y>480;y-=10){const x=bx+Math.sin(y*0.035+wall*1.3+k*2.1)*(6+(640-y)*0.08);y===640?p.moveTo(x,y):p.lineTo(x,y);}}),[steam,steam*0.8,steam*0.4],6);}
      fill(E(486,712,30,6),[0.35,0.4,0.3]);
      stroke(P(p=>{p.moveTo(474,660);p.lineTo(462,598);p.moveTo(486,660);p.lineTo(490,592);p.moveTo(498,660);p.lineTo(514,604);}),[0.1,0.3,0.85],6,false,'butt');
      fill(POLY([[460,598],[464,598],[462,590]]),[0.6,0.6,0.6]);fill(POLY([[488,592],[492,592],[490,584]]),[0.6,0.6,0.6]);
      fill(RR(458,652,56,60,6),[0.5,0.62,0.45]);stroke(LINE([[458,668],[514,668]]),[0.7,0.72,0.55],3,true);
      tx(560,780,0.3);fill(RR(540,770,40,20,4),[0,0.42,0.14]);fill(R(540,770,14,20),[0.5,0.1,0.2]);pop();
      tx(1000,150,-0.08);fill(R(960,112,72,72),[0,0.06,0.62]);stroke(LINE([[972,136],[1018,136],[972,152],[1008,152]]),[0.5,0.3,0.2],2,true);pop();
      tx(1080,190,0.07);fill(R(1046,160,62,62),[0,0.34,0.08]);stroke(LINE([[1058,182],[1094,182]]),[0.5,0.3,0.2],2,true);pop();
      notebook(fr,t,A);
      A.wall=wall;girl(fr,t,A,calm);
      // lamp, its warm light (Vocals)
      const LA=[0.78,0.45,0.15];
      fill(E(1556,640,42,10),LA);stroke(LINE([[1556,634],[1588,420],[1422,322]]),LA,8);fill(E(1588,420,8,8),LA);
      const ang=Math.atan2(620-322,1080-1422);tx(1422,322,ang);
      fill(POLY([[1422,304],[1512,272],[1512,372],[1422,340]]),[0.88,0.3,0.2]);fill(E(1510,322,10,48),[0,0.05,0.4]);pop();
      const Lv=calm?0.8:0.55+0.45*clamp(vocS*1.4,0,1);
      light(1080,610,600,340,Lv);
      clock(fr,t);
    }

    function trainX(T,t){const v=150,TL=380;return T.dir>0?GX0-TL-40+(t-T.t0)*v:GX1+40-(t-T.t0)*v;}

    function notebook(fr,t,A){
      const Q=[[652,650],[626,818],[972,808],[934,642]];
      const M=(u,v)=>{const ax=lerp(Q[0][0],Q[1][0],u),ay=lerp(Q[0][1],Q[1][1],u),bx=lerp(Q[3][0],Q[2][0],u),by=lerp(Q[3][1],Q[2][1],u);return [lerp(ax,bx,v),lerp(ay,by,v)];};
      fill(POLY(Q.map(p=>[p[0]+12,p[1]+9])),[0.35,0.45,0.5]);
      {const cx=796,cy=730;fill(POLY(Q.map(p=>[cx+(p[0]-cx)*1.06,cy+(p[1]-cy)*1.08])),[0.85,0.35,0.1]);}
      fill(POLY(Q),[0,0.02,0.07]);
      const {ps,rd,row}=pageClock(t),base=k=>0.1+k*0.18+0.15;
      stroke(P(p=>{for(let k=0;k<ROWS;k++){const a=M(0.03,base(k)+0.01),b=M(0.97,base(k)+0.01);p.moveTo(a[0],a[1]);p.lineTo(b[0],b[1]);}}),[0.3,0,0],1.3,true);
      stroke(LINE([M(0.085,0.02),M(0.085,0.98)]),[0,0.5,0],1.3,true);
      // the tune, written row by row
      const N=info.N,ink=[new Path2D(),new Path2D()],dots=new Path2D();let pen=null,lastPt=null;
      for(let k=0;k<=row;k++){const rs=ps+k*rd,re=rs+rd,end=Math.min(re,t);let prev=null;
        for(let i=after(N,rs-1e-6);i<N.length&&N[i].start<end;i++){const n=N[i],uOf=s=>0.11+0.85*(s-rs)/rd,v=base(k)-0.02-n.pn*0.12,pa=ink[n.vox?0:1];
          const u0=uOf(n.start),u1=uOf(Math.min(n.end,end,re)),p0=M(u0,v);
          if(prev&&n.start-prev.n.end<0.35&&Math.abs(n.pitch-prev.n.pitch)<5){const pp=prev.pt;pa.moveTo(pp[0],pp[1]);pa.lineTo(p0[0],p0[1]);}else pa.moveTo(p0[0],p0[1]);
          let q=p0;for(let u=u0;u<=u1+1e-6;u+=0.008){q=M(Math.min(u,u1),v+Math.sin(u*80+i)*0.004);pa.lineTo(q[0],q[1]);}
          if(n.home){pa.moveTo(p0[0]+4,p0[1]-5);pa.arc(p0[0],p0[1]-5,4,0,TAU);pa.moveTo(q[0],q[1]);}
          if(n.out){const d=M(u0,v-0.05);dots.moveTo(d[0]+2.2,d[1]);dots.arc(d[0],d[1],2.2,0,TAU);}
          prev={n,pt:q};lastPt=q;if(t>=n.start&&t<n.end)pen=q;}
        if(k===row&&!pen){const nx=N[after(N,t)];if(nx&&nx.start<re&&prev&&nx.start-prev.n.end<1.2){const f=ease((t-prev.n.end)/Math.max(0.05,nx.start-prev.n.end)),tgt=M(0.11+0.85*(nx.start-rs)/rd,base(k)-0.02-nx.pn*0.12);pen=[lerp(prev.pt[0],tgt[0],f),lerp(prev.pt[1],tgt[1],f)-Math.sin(f*Math.PI)*8];}}}
      stroke(ink[0],[0.92,0.1,0],2.6,true);stroke(ink[1],[0,0.95,0.2],2.6,true);fill(dots,[0.6,0.6,0],true);
      if(!pen){const tap=fr.playing&&fr.beat?.bar!=null?Math.pow(1-(fr.beat.phase||0),3)*4:0;pen=lastPt?[lastPt[0]+6,lastPt[1]-10]:M(0.11,base(row)-0.06);pen=[pen[0],pen[1]-tap];}
      // spiral
      stroke(P(p=>{for(let i=0;i<16;i++){const q=M((i+0.5)/16,0);p.moveTo(q[0]+4,q[1]-3);p.ellipse(q[0],q[1]-3,4,6,0,0,TAU);}}),[0.85,0.3,0.2],2.4,true);
      // page turn
      const fp=(t-ps)/0.55;if(fp>=0&&fp<1){const ve=1-fp*1.15,lift=Math.sin(fp*Math.PI)*34,a=M(0,0),b=M(1,0),c=M(1,Math.max(-0.15,ve)),d=M(0,Math.max(-0.15,ve));
        const pg=POLY([a,b,[c[0]+8,c[1]-lift],[d[0]-6,d[1]-lift]]);fill(pg,[0.05,0.03,0.09]);stroke(pg,[0.4,0.1,0],1.6,true);}
      A.pen=pen;
    }

    function girl(fr,t,A,calm){
      const HAIR=[0.55,0.62,0.85],HAIRL=[0.3,0.42,0.72],HAIRD=[0.78,0.78,0.92],SKIN=[0.02,0.2,0.28],SKIND=[0.1,0.38,0.45],
        SW=[0.52,0.26,0.74],SWD=[0.74,0.46,0.86],SWO=[0.85,0.6,0.9],SC=[0.08,0.72,0.82],HP=[0.04,0.1,0.3],HPD=[0.5,0.5,0.62],RUST=[0.1,0.72,0.6],LN=[0.62,0.62,0.72];
      const at=(x,y,r,k=1)=>{for(const c of X){c.save();c.translate(x,y);c.rotate(r);c.scale(k,k);}};
      const limb=(a,b2,lw)=>{stroke(LINE([a,b2]),SWO,lw+7);stroke(LINE([a,b2]),SW,lw);};
      // the nod: dips just after each beat, deeper on downbeats, with the kick, and when the song is loud
      const b=fr.beat||{},ph=b.phase||0,wall=A.wall||0;let nod=0;
      if(b.bar!=null){const wv=Math.pow((1+Math.cos(TAU*(ph-0.12)))/2,1.6);nod=wv*(b.beat===1?1.2:1)+(fr.tracks?.drums?.pulse||0)*0.25;}
      const rot=-(0.01+0.05*nod*(0.4+0.6*A.amp)*(calm?0.5:1)),blink=((wall*0.23+0.3)%1)<0.035;
      // chair, torso, the far shoulder's shading
      fill(P(p=>{p.moveTo(1240,520);p.bezierCurveTo(1290,470,1356,486,1362,560);p.lineTo(1372,900);p.lineTo(1250,900);p.closePath();}),[0.08,0.78,0.42]);
      stroke(P(p=>{p.moveTo(1352,540);p.lineTo(1362,900);}),[0.25,0.9,0.5],14,true);
      fill(P(p=>{p.moveTo(1062,468);p.bezierCurveTo(1018,488,984,540,972,612);p.bezierCurveTo(962,690,982,800,996,900);p.lineTo(1318,900);p.bezierCurveTo(1314,760,1292,610,1236,526);p.bezierCurveTo(1196,478,1150,458,1104,458);p.closePath();}),SW);
      stroke(P(p=>{p.moveTo(1062,468);p.bezierCurveTo(1018,488,984,540,972,612);p.bezierCurveTo(962,690,982,800,996,900);p.moveTo(1318,900);p.bezierCurveTo(1314,760,1292,610,1236,526);p.bezierCurveTo(1196,478,1150,458,1104,458);}),SWO,3.5,true);
      fill(P(p=>{p.moveTo(1236,526);p.bezierCurveTo(1292,610,1314,760,1318,900);p.lineTo(1276,900);p.bezierCurveTo(1272,760,1252,640,1214,566);p.closePath();}),SWD);
      const head=()=>{tx(1078,470,rot);at(1092,372,-0.3,1.16);},unhead=()=>{pop();pop();};
      // hair behind the neck, with the short ponytail swinging a little behind the nod
      head();
      fill(P(p=>{p.moveTo(-74,-56);p.bezierCurveTo(-66,-128,84,-134,102,-34);p.bezierCurveTo(114,24,106,78,94,110);p.quadraticCurveTo(62,122,30,108);p.quadraticCurveTo(4,96,-8,64);p.lineTo(-50,30);p.closePath();}),HAIR);
      tx(98,-14,0.05*Math.sin(wall*1.1)-rot*2.2);
      fill(P(p=>{p.moveTo(94,-30);p.bezierCurveTo(140,-42,162,8,152,64);p.quadraticCurveTo(142,40,130,32);p.quadraticCurveTo(138,62,122,86);p.quadraticCurveTo(116,40,96,8);p.closePath();}),HAIR);
      stroke(P(p=>{p.moveTo(110,-20);p.quadraticCurveTo(140,0,140,44);}),HAIRD,2,true);
      fill(E(100,-15,9,13,0.3),RUST);pop();
      unhead();
      fill(POLY([[1030,436],[1092,426],[1104,498],[1044,508]]),SKIND);
      stroke(P(p=>{p.moveTo(1030,484);p.quadraticCurveTo(1090,500,1156,470);}),SC,34);
      stroke(P(p=>{p.moveTo(1040,478);p.quadraticCurveTo(1090,492,1146,466);}),[0.02,0.5,0.62],6,true);
      // face, eye, hair in front, headphones
      head();
      const prof=p=>{p.moveTo(-84,-30);p.quadraticCurveTo(-92,-10,-90,4);p.quadraticCurveTo(-94,18,-104,32);p.quadraticCurveTo(-101,40,-92,41);p.quadraticCurveTo(-96,46,-95,50);p.quadraticCurveTo(-90,54,-93,59);p.quadraticCurveTo(-91,72,-80,79);p.quadraticCurveTo(-48,94,-12,74);};
      fill(P(p=>{p.moveTo(-76,-36);prof(p);p.lineTo(-4,24);p.lineTo(-30,-26);p.closePath();}),SKIN);
      fill(E(-26,56,30,18,-0.3),SKIND,true);
      stroke(P(prof),LN,2.4,true);
      fill(E(-66,44,14,6),[0,0.42,0.12],true);
      stroke(LINE([[-93,53],[-88,53]]),[0.1,0.6,0.5],1.8,true);
      if(blink)stroke(P(p=>{p.moveTo(-86,12);p.quadraticCurveTo(-72,18,-58,11);}),HAIRD,3.4,true);
      else{fill(P(p=>{p.moveTo(-80,12);p.quadraticCurveTo(-78,23,-71,24);p.quadraticCurveTo(-65,23,-64,12);p.closePath();}),[0.62,0.58,0.8]);
        fill(E(-74,16,2.4,2.4),[0,0,0.04]);
        stroke(P(p=>{p.moveTo(-86,12);p.quadraticCurveTo(-74,7,-60,11);p.lineTo(-56,8);}),HAIRD,3.4,true);
        stroke(P(p=>{p.moveTo(-79,25);p.quadraticCurveTo(-72,27,-66,24);}),SKIND,1.4,true);}
      fill(P(p=>{p.moveTo(-44,-40);p.quadraticCurveTo(-58,20,-50,84);p.quadraticCurveTo(-44,94,-33,86);p.quadraticCurveTo(-30,40,-12,-14);p.closePath();}),HAIR);
      fill(P(p=>{p.moveTo(-36,-100);p.bezierCurveTo(-80,-96,-100,-56,-98,-6);p.lineTo(-90,-4);p.lineTo(-86,-16);p.lineTo(-80,-2);p.lineTo(-72,-18);p.lineTo(-64,-4);p.lineTo(-58,-22);p.lineTo(-48,-8);p.quadraticCurveTo(-34,-60,10,-96);p.closePath();}),HAIR);
      stroke(P(p=>{p.moveTo(-44,-92);p.quadraticCurveTo(8,-112,58,-92);}),HAIRL,8,true);
      stroke(P(p=>{p.moveTo(50,-70);p.quadraticCurveTo(72,-40,78,40);p.moveTo(70,-60);p.quadraticCurveTo(90,-30,92,62);p.moveTo(-70,-70);p.quadraticCurveTo(-82,-40,-84,-14);}),HAIRD,2,true);
      stroke(P(p=>{p.moveTo(14,-24);p.quadraticCurveTo(22,-112,-34,-104);}),HPD,22);
      stroke(P(p=>{p.moveTo(14,-24);p.quadraticCurveTo(22,-112,-34,-104);}),HP,15,true);
      fill(E(2,22,44,50,0.1),HPD);fill(E(12,22,37,45,0.1),HP);fill(E(16,22,22,27,0.1),RUST);
      stroke(E(16,22,12,15,0.1),HP,2.5,true);
      unhead();
      // chin resting on the far hand
      const E1=[958,702];tx(E1[0],E1[1],rot*0.6);
      limb(E1,[1020,536],60);stroke(LINE([[1010,566],[1020,538]]),SWD,64,false,'butt');
      fill(E(1026,512,27,23,-0.4),SKIN);
      stroke(P(p=>{p.moveTo(1004,500);p.quadraticCurveTo(1016,510,1030,504);p.moveTo(1008,514);p.quadraticCurveTo(1020,522,1034,516);p.moveTo(1014,527);p.quadraticCurveTo(1024,532,1036,528);}),SKIND,2.2,true);
      pop();
      // the writing arm: a two-bone arm from the shoulder to the pencil, elbow dropping toward the desk
      const pen=A.pen||[800,740],H=[pen[0]+30,pen[1]-24],S=[1182,548],L1=225,L2=320;
      const dx=H[0]-S[0],dy=H[1]-S[1],d=clamp(Math.hypot(dx,dy),L2-L1+2,L1+L2-2),phi=Math.atan2(dy,dx),aa=Math.acos(clamp((L1*L1+d*d-L2*L2)/(2*L1*d),-1,1));
      const El=[S[0]+Math.cos(phi-aa)*L1,S[1]+Math.sin(phi-aa)*L1],fa=Math.atan2(H[1]-El[1],H[0]-El[0]),W=[H[0]-Math.cos(fa)*20,H[1]-Math.sin(fa)*20];
      limb(S,El,80);fill(E(El[0],El[1],43,43),SWO);fill(E(El[0],El[1],39,39),SW);
      limb(El,W,62);fill(E(El[0],El[1],36,36),SW);
      stroke(LINE([[W[0]-Math.cos(fa)*26,W[1]-Math.sin(fa)*26],[W[0],W[1]]]),SWD,66,false,'butt');
      stroke(LINE([pen,[pen[0]+48,pen[1]-66]]),[0,0.15,0.95],7,false,'butt');
      stroke(LINE([[pen[0]+48,pen[1]-66],[pen[0]+54,pen[1]-74]]),RUST,7,false,'butt');
      stroke(LINE([pen,[pen[0]+6,pen[1]-8]]),[0.9,0.4,0.2],4,false,'butt');
      fill(E(H[0],H[1],25,19,-0.5),SKIN);
      fill(E(pen[0]+15,pen[1]-13,11,8,-0.6),SKIN);
      stroke(P(p=>{p.moveTo(H[0]-16,H[1]+6);p.quadraticCurveTo(H[0]-4,H[1]+14,H[0]+12,H[1]+10);}),SKIND,2,true);
    }

    function clock(fr,t){
      const K=0.95;for(const c of X){c.save();c.translate(24-1280*K,650-560*K);c.scale(K,K);}
      const ch=fr.chord||{},cur=parseChord(ch.label),nx=ch.next?parseChord(ch.next.label):null;
      fill(E(1404,676,138,10),[0.35,0.4,0.35]);
      fill(RR(1280,560,246,112,16),[0.8,0.5,0.12]);fill(RR(1294,574,218,84,8),[0.92,0.28,0.22]);
      const flash=ch.label&&t-(ch.start??-9)<0.15,ghost=flash?[0.6,0.48,0.5]:[0.8,0.34,0.32],lit=[0,1,1],dim=[0.12,0.62,0.68];
      seven(1306,586,48,64,9,cur?cur.root:'-',ghost,lit);
      if(cur){const top=(cur.acc+cur.qual).slice(0,5);if(top)text(top,1364,606,`700 ${top.length>3?16:20}px ${MONO}`,lit,'left',false);
        if(cur.bass)text('/'+cur.bass,1364,642,`700 17px ${MONO}`,lit,'left',false);}
      const b=fr.beat||{},on=!fr.playing||b.bar==null||(b.phase||0)<0.5;
      fill(E(1430,604,4.2,4.2),on?lit:ghost);fill(E(1430,632,4.2,4.2),on?lit:ghost);
      seven(1446,592,28,40,6,ch.next?(nx?nx.root:'-'):' ',ghost,dim);
      if(nx&&(nx.acc+nx.qual))text((nx.acc+nx.qual).slice(0,4),1480,608,`700 13px ${MONO}`,dim,'left',false);
      const spb=60/(b.bpm||100),n=ch.next?Math.ceil((ch.next.in??99)/spb):0;
      for(let i=0;i<4;i++)fill(R(1446+i*15,644,9,6),n>0&&n<=4&&i<n?lit:ghost);
      pop();
    }

    function lyrics(fr,env,box){
      const ly=fr.lyric||{},line=ly.line,words=ly.words||[];
      const fs0=Math.min(box.h*0.34,w*0.032),cx=box.x+box.w/2,cy=box.y+box.h/2,c=X[0];
      if(line&&words.length){
        const key=line.index+'|'+line.text+'|'+Math.round(box.w)+'|'+Math.round(fs0);
        if(lyr.key!==key){
          const toks=words.map((wd,i)=>{const s=String(wd.text||'');const join=s.length>1&&s.endsWith('-');return {i,text:join?s.slice(0,-1):s,join};});
          const groups=[];let g=[];toks.forEach(tk=>{g.push(tk);if(!tk.join){groups.push(g);g=[];}});if(g.length)groups.push(g);
          let fs=fs0,rows;
          for(let tries=0;tries<8;tries++){c.font=`700 ${fs}px ${TYPE}`;const sp=c.measureText(' ').width;rows=[{w:0,t:[]}];
            for(const gr of groups){const ws=gr.map(tk=>c.measureText(tk.text).width),gw=ws.reduce((a,b)=>a+b,0);let r=rows[rows.length-1];
              if(r.w>0&&r.w+sp+gw>box.w*0.94){r={w:0,t:[]};rows.push(r);}
              let x=r.w+(r.w>0?sp:0);gr.forEach((tk,k)=>{r.t.push({i:tk.i,text:tk.text,x});x+=ws[k];});r.w=x;}
            if(rows.length<=2)break;fs*=0.88;}
          lyr={key,fs,rows};}
        const font=`700 ${lyr.fs}px ${TYPE}`;
        lyr.rows.forEach((r,ri)=>{const y=cy+lyr.fs*0.36+(lyr.rows.length>1?(ri-0.5)*lyr.fs*1.25:0),x0=cx-r.w/2;
          for(const tk of r.t){const st=words[tk.i]?.state;text(tk.text,x0+tk.x,y,font,st==='now'?[0,1,1]:st==='sung'?[0.9,0,0]:[0.32,0,0]);}});
      }else if(ly.next?.text&&(ly.next.in??99)<5){
        const s=String(ly.next.text).replace(/([A-Za-z\u00C0-\u024F'])-(?=[A-Za-z\u00C0-\u024F])/g,'$1');let fs=fs0;c.font=`700 ${fs}px ${TYPE}`;
        const tw=c.measureText(s).width;if(tw>box.w*0.94)fs*=box.w*0.94/tw;text(s,cx,cy+fs*0.36,`700 ${fs}px ${TYPE}`,[0.32,0,0],'center');
      }
    }

    function render(fr,env,A,idx){
      const u=Math.min(w,h),m=Math.round(u*0.035),mb=env.lyrics!==false?Math.max(m,h*0.15):m;
      const ax=m,ay=m,aw=w-2*m,ah=h-m-mb,s=Math.max(aw/VW,ah/VH),ox=(VW-aw/s)*0.5,oy=(VH-ah/s)*0.35;
      for(const c of X){c.setTransform(1,0,0,1,0,0);c.globalCompositeOperation='source-over';c.globalAlpha=1;c.clearRect(0,0,W,H);
        c.save();c.beginPath();c.rect(ax*pr,ay*pr,aw*pr,ah*pr);c.clip();c.setTransform(pr*s,0,0,pr*s,pr*(ax-ox*s),pr*(ay-oy*s));}
      scene(fr,env,A);
      for(const c of X){c.restore();c.setTransform(pr,0,0,pr,0,0);}
      if(env.lyrics!==false)lyrics(fr,env,{x:ax,y:ay+ah,w:aw,h:h-ay-ah-m*0.4});
      // riso grain: speckled voids in each ink
      X.forEach((c,i)=>{c.setTransform(1,0,0,1,0,0);c.globalCompositeOperation='destination-out';c.globalAlpha=0.55;c.fillStyle=pats[i];
        c.save();c.translate(i*71,i*43);c.fillRect(-i*71,-i*43,W,H);c.restore();c.globalCompositeOperation='source-over';c.globalAlpha=1;});
      // registration: a new print per section, a hair of boil per frame
      const si=fr.section?.index??-1,k=Math.max(0.8,u/700)*pr,bo=i=>(hsh(idx,i)-0.5)*0.5*k;
      const off=[[bo(1),bo(2)],[(1+hsh(si,1)*1.4)*k+bo(3),-(0.5+hsh(si,2))*k+bo(4)],[-(0.6+hsh(si,3))*k+bo(5),(0.8+hsh(si,4))*k+bo(6)]];
      px.setTransform(1,0,0,1,0,0);px.globalCompositeOperation='source-over';px.globalAlpha=1;px.drawImage(paper,0,0);
      px.globalCompositeOperation='multiply';X.forEach((c,i)=>px.drawImage(c.canvas,off[i][0],off[i][1]));px.globalCompositeOperation='source-over';
    }

    function buildPaper(){
      paper=mk(W,H);const c=paper.getContext('2d');c.fillStyle=PAPER;c.fillRect(0,0,W,H);
      const id=c.getImageData(0,0,W,H),d=id.data,r=rng(3);
      for(let i=0;i<d.length;i+=4){const n=(r()-0.5)*12;d[i]+=n;d[i+1]+=n;d[i+2]+=n*1.1;}
      c.putImageData(id,0,0);
      c.lineWidth=1;for(let i=0;i<(W*H)/900;i++){const x=r()*W,y=r()*H,a=r()*TAU,l=4+r()*14;c.strokeStyle=r()<0.5?'rgba(140,110,70,0.08)':'rgba(255,255,250,0.25)';c.beginPath();c.moveTo(x,y);c.quadraticCurveTo(x+Math.cos(a+0.5)*l*0.5,y+Math.sin(a+0.5)*l*0.5,x+Math.cos(a)*l,y+Math.sin(a)*l);c.stroke();}
      for(let i=0;i<14;i++){const x=r()*W,y=r()*H,rr=60+r()*220,gr=c.createRadialGradient(x,y,0,x,y,rr);gr.addColorStop(0,'rgba(170,140,90,0.05)');gr.addColorStop(1,'rgba(170,140,90,0)');c.fillStyle=gr;c.fillRect(x-rr,y-rr,rr*2,rr*2);}
    }
    function buildGrain(c){
      const T=mk(220,220),tc=T.getContext('2d'),id=tc.createImageData(220,220),d=id.data,r=rng(17+X.length);
      for(let i=0;i<d.length;i+=4){const v=r();d[i+3]=v>0.74?Math.round(((v-0.74)/0.26)**1.5*255):0;}
      tc.putImageData(id,0,0);tc.fillStyle='#000';for(let i=0;i<260;i++){tc.globalAlpha=0.3+r()*0.5;tc.fillRect(Math.floor(r()*220),Math.floor(r()*220),2,2);}
      return c.getContext('2d').createPattern(T,'repeat');
    }

    return {
      resize(nw,nh){w=nw;h=nh;pr=Math.min(1,1700/Math.max(1,w));W=Math.max(1,Math.round(w*pr));H=Math.max(1,Math.round(h*pr));
        X=[];pats=[];for(let i=0;i<3;i++){const cv=mk(W,H);X.push(cv.getContext('2d'));pats.push(buildGrain(cv));}
        print=mk(W,H);px=print.getContext('2d');buildPaper();dirty=true;lyr={key:''};},
      draw(g,frame,env){
        if(!print)this.resize(env.w,env.h);
        const t=frame.time||0,dt=env.dt||0.016,tr=frame.tracks||{};
        if(env.song!==songRef){songRef=env.song;info=prep(env.song);train=null;}
        let e=0,any=false;for(const k in tr){if(k==='original')continue;any=true;e+=tr[k]?.level||0;}
        eS+=(e-eS)*Math.min(1,dt*4);ePk=Math.max(eS,ePk*Math.exp(-dt/25),0.05);
        const ampI=clamp(eS/ePk,0,1),amp=any?0.15+0.85*ampI*ampI:0.6;
        const sm=(v,x,k)=>v+((x||0)-v)*Math.min(1,dt*k);
        vocS=sm(vocS,tr.vocals?.level,5);bassS=sm(bassS,tr.bass?.level,4);othS=sm(othS,tr.other?.level,3);leadS=sm(leadS,tr.lead?.level,5);
        if(lastT!=null&&(t<lastT-0.05||t-lastT>0.5)){train=null;lastTrainEnd=-9;}lastT=t;
        for(const s of (env.events?.hits?.piano||[])){const W2=city.win,q=W2[Math.floor(hsh(toggles++,5)*W2.length)];if(q)q.lit=!q.lit;}
        const sn=String(frame.section?.name||'').toLowerCase(),base=/chorus|hook|refrain|drop/.test(sn)?1:/bridge|solo|break/.test(sn)?0.75:/verse|pre/.test(sn)?0.6:0.4;
        rainS=sm(rainS,base*(0.4+0.6*amp),0.8);
        if(train){const x=trainX(train,t);if(x>GX1+60||x+380<GX0-60){train=null;lastTrainEnd=t;}}
        if(!train&&leadS>0.12&&frame.playing&&t-lastTrainEnd>1.5)train={t0:t,dir:hsh(Math.floor(t))>0.5?1:-1};
        const idx=Math.floor((env.wall||0)*FPS);
        if(idx!==lastIdx||dirty){lastIdx=idx;dirty=false;render(frame,env,{amp,wall:env.wall||0},idx);}
        g.imageSmoothingEnabled=true;g.drawImage(print,0,0,w,h);
      },
      dispose(){X=[];print=null;paper=null;},
    };
  },
};
