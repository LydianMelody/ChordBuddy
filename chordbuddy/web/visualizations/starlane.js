// Starlane: a 1980s VHS rail shooter. A ship flies into the screen through five stages, one per kind of song section.
//   Sections      -> the stage: Intro/Outro = DEEP SPACE, Verse = ATMOSPHERE (slow, checkerboard planet, entry plasma),
//                    Pre-chorus/Build = NEON CIRCUIT (track), Chorus = HYPERDRIVE (fast, tunnel, shake), Bridge/Break = INVASION (UFOs),
//                    Solo = DOGFIGHT (chorus speed, harder shake; each strong lead-guitar hit fires a shot that blows up a UFO, and new ones fly in).
//                    World speed per stage is integrated over song time, so everything stays in sync through every speed change.
//   Melody MIDI   -> the flight path. Every note is an object in the world placed at the exact distance where it sounds: height = pitch,
//                    tube length = note duration. The ship rides each tube for exactly its length and glides to the next note before it starts.
//                    Each stage draws notes its own way: constellation stars, hoops, boost pads on the track, diamond gates, orbs.
//                    Pink = sung (vocal MIDI), cyan = instrumental, gold = the key's tonic. Background stars of the same pitch class twinkle.
//   Chords        -> twin neon pylons with a laser line and a chord sign arrive exactly on each change (gold = tonic chord, pink = minor, cyan = major); HUD panel on top.
//   Beat / bars   -> HYPERDRIVE tunnel rings sit on every beat (downbeats gold); lasers fire on beats in HYPERDRIVE and INVASION; ground pulses on downbeats.
//   Every 4 bars  -> in INVASION a UFO targets where the ship will be, the reticle arrives with the bar, the beam fires and the ship barrel-rolls aside.
//   Drums         -> kicks flare the engines; strong hits shake the camera in HYPERDRIVE (not in calm mode).
//   Bass          -> the ATMOSPHERE sun swells; grid glow.     Vocals -> sun brightness and the warm glow around the ship.
//   Rhythm guitar -> beacons along both sides, one per strum, passing the ship exactly on the strum.
//   Lead guitar   -> wingtip trails tracing the path just flown, brighter and wider with the lead.
//   Piano         -> shooting stars in the sky.             Other -> nebula haze.
//   Stage entry -> into a chorus the ship races ahead of the camera with an engine bloom; into a verse it brakes back toward it.
//   HUD (inside the tape image, under the same VHS pass): chord + next chord, stage + section countdown, bar/beat pips,
//   a pitch altimeter with the melody note's name and scale degree, the lyric line with the current word wiped in.
// Post pass: 2-3 px chroma shift, ~1 px gate weave, ~5% flicker, scanlines, tape noise and an occasional tracking line,
// all seeded by frame index (song time x 60). Calm mode: no shake, flicker or tracking line.
import {chordColor} from '../visual-color.js';

const TAU=Math.PI*2,PINK='#ff3fa4',CYAN='#00e5ff',WARM='#ffd166',INK='#120f1d',LAV='#b9a9d6';
const RGB={pink:[255,63,164],cyan:[0,229,255],warm:[255,209,102],white:[255,255,255]};
const HEX={pink:PINK,cyan:CYAN,warm:WARM,white:'#ffffff'};
const DISPLAY='"Bricolage Grotesque",system-ui,"Segoe UI",sans-serif',MONO='"Space Mono",ui-monospace,Consolas,monospace';
const SZ=10,NEAR=1.2,FAR=130,FARG=100,REST={x:0,y:3.2};
const STAGES={space:{name:'DEEP SPACE',speed:40},atmo:{name:'ATMOSPHERE',speed:24},road:{name:'NEON CIRCUIT',speed:56},hyper:{name:'HYPERDRIVE',speed:96},ufo:{name:'INVASION',speed:44},solo:{name:'DOGFIGHT',speed:96}};
const NAMES_S=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'],NAMES_F=['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
const DEG=['1','♭2','2','♭3','3','4','♯4','5','♭6','6','♭7','7'];
const clamp=(v,a,b)=>v<a?a:v>b?b:v,lerp=(a,b,p)=>a+(b-a)*p,ease=x=>x<=0?0:x>=1?1:x*x*(3-2*x);
const after=(a,t)=>{let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m].start<=t)lo=m+1;else hi=m;}return lo;};
const rng=seed=>{let s=seed;return()=>(s=s*16807%2147483647)/2147483647;};
const hsh=(a,b=0)=>{let x=(Math.imul(a|0,374761393)+Math.imul(b|0,668265263))|0;x=Math.imul(x^(x>>>13),1274126177);x^=x>>>16;return (x>>>0)/4294967296;};
const rgba=(c,a)=>`rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mk=(W,H)=>{const cv=document.createElement('canvas');cv.width=Math.max(1,Math.ceil(W));cv.height=Math.max(1,Math.ceil(H));return cv;};
const noChord=l=>!l||/^(N|N\.?C\.?|X)$/i.test(String(l).trim());
const PCN={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
const pcOf=s=>{const m=/^([A-G])([#b♯♭]?)/.exec(String(s||''));if(!m)return null;return (PCN[m[1]]+(m[2]==='#'||m[2]==='♯'?1:m[2]==='b'||m[2]==='♭'?-1:0)+12)%12;};
const dehyph=s=>String(s||'').replace(/([A-Za-z\u00C0-\u024F'])-(?=[A-Za-z\u00C0-\u024F])/g,'$1');
const fmt=s=>{s=Math.max(0,Math.ceil(s));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};

function sceneOf(name,i){
  const n=String(name||'').toLowerCase();
  if(/pre|build|lift|climb|ramp|rise/.test(n))return 'road';
  if(/chorus|hook|refrain|drop/.test(n))return 'hyper';
  if(/verse|story/.test(n))return 'atmo';
  if(/solo|shred/.test(n))return 'solo';
  if(/bridge|break|interlude|instrumental|middle|riff/.test(n))return 'ufo';
  if(!n||/intro|outro|ending|coda|tag|end/.test(n))return 'space';
  return ['atmo','road','ufo'][i%3];
}
const weave=t=>Math.sin(t*0.83)*0.65+Math.sin(t*0.31+1.3)*0.35;
function notePos(scene,pn,t){
  switch(scene){
    case 'atmo':return [weave(t)*3,2.0+pn*4.4];
    case 'road':return [(pn-0.5)*10,1.3];
    case 'hyper':return [weave(t)*2.2,1.4+pn*5.4];
    case 'ufo':case 'solo':return [weave(t)*4.5,1.6+pn*5.0];
    default:return [weave(t)*4.2,1.6+pn*5.2];
  }
}

function prep(song){
  const dur=Math.max(10,song?.duration||0);
  const secs=(song?.sections||[]).filter(s=>s&&s.end>s.start).slice().sort((a,b)=>a.start-b.start);
  const segs=[{start:-1e9,scene:'space',name:null}];let prevEnd=0;
  secs.forEach((s,i)=>{if(s.start>prevEnd+0.05&&i>0)segs.push({start:prevEnd,scene:'space',name:null});segs.push({start:s.start,scene:sceneOf(s.name,i),name:s.name});prevEnd=s.end;});
  if(secs.length)segs.push({start:prevEnd,scene:'space',name:null});
  let st=1;segs.forEach((s,i)=>{s.changed=i>0&&s.scene!==segs[i-1].scene;if(s.changed)st++;s.stage=st;s.from=i>0?segs[i-1].scene:null;});
  const segAt=t=>{let lo=0,hi=segs.length;while(lo<hi){const m=(lo+hi)>>1;if(segs[m].start<=t)lo=m+1;else hi=m;}return segs[Math.max(0,lo-1)];};
  // distance flown = integral of the stage speed over song time (ramped 1.5 s into each new stage)
  const STEP=0.05,n=Math.ceil((dur+20)/STEP)+2,D=new Float64Array(n);let j=0;
  const spd=t=>{while(j+1<segs.length&&segs[j+1].start<=t)j++;const s=segs[j],v=STAGES[s.scene].speed;if(!s.changed)return v;return lerp(STAGES[s.from].speed,v,ease((t-s.start)/1.5));};
  let pv=spd(0);for(let i=1;i<n;i++){const v=spd(i*STEP);D[i]=D[i-1]+(pv+v)*0.5*STEP;pv=v;}
  const v0=STAGES[segs[0].scene].speed,vEnd=pv;
  const dist=t=>{if(!(t>0))return (t||0)*v0;const f=t/STEP,i=Math.floor(f);if(i>=n-1)return D[n-1]+(t-(n-1)*STEP)*vEnd;return D[i]+(D[i+1]-D[i])*(f-i);};
  // melody: the merged line, plus any vocal notes it does not already contain
  const midi=song?.midi||{},mel=midi.melody?.notes||[],voc=midi.vocal?.notes||[],ins=midi.instrumental?.notes||[];
  const vox=new Set();voc.forEach(x=>vox.add(Math.round(x.start*50)));
  const isVox=s=>{const r=Math.round(s*50);return vox.has(r)||vox.has(r-1)||vox.has(r+1);};
  let src=mel.length?mel.slice():ins.slice();
  if(voc.length){const have=new Set(src.map(x=>Math.round(x.start*50)));for(const x of voc){const r=Math.round(x.start*50);if(!have.has(r)&&!have.has(r-1)&&!have.has(r+1))src.push(x);}}
  let N=src.filter(x=>x&&x.end>x.start&&isFinite(x.pitch)).map(x=>({start:x.start,end:x.end,pitch:x.pitch,str:x.strength??1})).sort((a,b)=>a.start-b.start);
  for(let i=0;i<N.length-1;i++)if(N[i].end>N[i+1].start-0.01)N[i].end=Math.max(N[i].start+0.03,N[i+1].start-0.01);
  const ps=N.map(x=>x.pitch).sort((a,b)=>a-b);let lo=60,hi=76;
  if(ps.length){lo=ps[Math.floor(ps.length*0.03)];hi=ps[Math.min(ps.length-1,Math.floor(ps.length*0.97))];}
  if(hi-lo<8){const m=(lo+hi)/2;lo=Math.floor(m-4);hi=Math.ceil(m+4);}
  const keyRoot=pcOf(song?.key),keyMinor=/minor|min\b|^[A-G][#b]?m$/i.test(String(song?.key||''));
  const flats=/b|♭/.test(String(song?.key||'').split(' ')[0])||(!keyMinor&&keyRoot===5)||(keyMinor&&[2,7,0,5].includes(keyRoot));
  let maxDur=0;
  for(const x of N){
    x.pn=clamp((x.pitch-lo)/(hi-lo),0,1);x.scene=segAt(x.start).scene;const p=notePos(x.scene,x.pn,x.start);x.x=p[0];x.y=p[1];
    x.s=dist(x.start);x.e=dist(x.end);x.pc=((x.pitch%12)+12)%12;x.home=keyRoot!=null&&x.pc===keyRoot;
    x.vox=mel.length||ins.length?isVox(x.start):voc.length>0;x.col=x.home?'warm':x.vox?'pink':'cyan';maxDur=Math.max(maxDur,x.end-x.start);
  }
  const kind=l=>{const r=pcOf(l),cc=chordColor(l);if(r!=null&&r===keyRoot&&!!cc.minor===keyMinor)return 'warm';return cc.minor?'pink':'cyan';};
  const G=(song?.chords||[]).filter(c=>!noChord(c.label)).map(c=>({t:c.start,s:dist(c.start),label:c.label,col:kind(c.label)}));
  const bars=(song?.bars||[]).slice().sort((a,b)=>a.start-b.start),BT=[];
  bars.forEach((b,bi)=>{const len=b.end?b.end-b.start:(bars[bi+1]?bars[bi+1].start-b.start:0),bs=b.beats&&b.beats.length?b.beats:len>0&&len<6?[0,1,2,3].map(q=>b.start+q*len/4):[b.start];bs.forEach((t,i)=>BT.push({t,s:dist(t),down:i===0,i:BT.length,scene:segAt(t).scene}));});
  const RH=[];let lastR=-9;
  for(const x of (song?.features?.tracks?.rhythm?.hits||[]).slice().sort((a,b)=>a.start-b.start))if(x.start-lastR>0.09){RH.push({t:x.start,s:dist(x.start),str:x.strength??0.6,side:RH.length%2,scene:segAt(x.start).scene});lastR=x.start;}
  const dh=(song?.features?.tracks?.drums?.hits||[]).map(x=>x.strength||0).sort((a,b)=>a-b),thr=dh.length?Math.max(0.2,dh[Math.floor(dh.length*0.7)]):0.8;
  const info={segs,segAt,dist,N,lo,hi,keyRoot,flats,maxDur:Math.min(8,maxDur),G,BT,RH,thr,A:[]};
  bars.forEach((b,i)=>{
    const len=b.end?b.end-b.start:(bars[i+1]?bars[i+1].start-b.start:2),sg=segAt(b.start);if(sg.scene!=='ufo')return;
    const rel=Math.round((b.start-sg.start)/Math.max(0.3,len));if(rel%4!==1)return;   // the 2nd bar of the stage, then every 4 bars
    const p=basePos(info,b.start);info.A.push({t:b.start,s:dist(b.start),warn:clamp(len,0.8,2.2),x:p.x,y:p.y,dir:p.x>0.3?-1:p.x<-0.3?1:(info.A.length%2?1:-1),ufo:info.A.length%3});
  });
  info.K=killPlan(song,segs,BT);
  return info;
}
// DOGFIGHT: a UFO is shot down on each strong lead-guitar hit (downbeats if there is no lead); its slot refills with a new one flying in
function killPlan(song,segs,BT){
  const lead=(song?.features?.tracks?.lead?.hits||[]).slice().sort((a,b)=>a.start-b.start),st=lead.map(x=>x.strength||0).sort((a,b)=>a-b);
  const thr=st.length?st[Math.floor(st.length*0.6)]:1,K=[];
  segs.forEach((sg,si)=>{if(sg.scene!=='solo')return;const end=segs[si+1]?segs[si+1].start:sg.start+60,t0=sg.start+0.9,ts=[];let last=-9;
    for(const x of lead)if(x.start>=t0&&x.start<end-0.2&&(x.strength||0)>=thr&&x.start-last>=0.45){ts.push(x.start);last=x.start;}
    if(ts.length<(end-t0)/3){ts.length=0;for(const b of BT)if(b.down&&b.t>=t0&&b.t<end-0.2)ts.push(b.t);}
    const prev=[sg.start-0.8,sg.start-0.5,sg.start-0.2];
    ts.forEach((t,i)=>{const slot=i%3;K.push({t,slot,spawn:Math.min(prev[slot],t-0.35),i:K.length,end});prev[slot]=t+0.35;});
    for(let slot=0;slot<3;slot++)K.push({t:end,slot,spawn:prev[slot],i:K.length,end,survivor:true});
  });
  return K.sort((a,b)=>a.t-b.t);
}
// where the melody puts the ship at song time t: on a note for its whole length, gliding to the next one so it arrives as it starts
function basePos(info,t){
  const N=info.N,i=after(N,t)-1,p=N[i],q=N[i+1];
  const mix=(a,b,e)=>({x:lerp(a.x,b.x,e),y:lerp(a.y,b.y,e)});
  if(!p&&!q)return REST;
  if(!p){const a=q.start-1.0;return t<a?REST:mix(REST,q,ease((t-a)/1.0));}
  if(!q)return t<p.end?p:mix(p,REST,ease((t-p.end)/0.8));
  if(q.start-p.end>2.4){
    if(t<p.end)return p;if(t<p.end+0.8)return mix(p,REST,ease((t-p.end)/0.8));
    if(t<q.start-1.0)return REST;return mix(REST,q,ease((t-(q.start-1.0))/1.0));
  }
  const minG=Math.min(0.14,(q.start-p.start)*0.6),gs=Math.min(Math.max(p.end,q.start-1.0),q.start-minG);
  return t<gs?p:mix(p,q,ease((t-gs)/(q.start-gs)));
}
function dodgeAt(info,t){
  for(const a of info.A){const d=t-a.t;if(d<-0.5||d>0.8)continue;const sh=ease((d+0.5)/0.42)*(1-ease((d-0.3)/0.5));return [a.dir*2.8*sh,a.dir*TAU*ease((d+0.5)/0.6)];}
  return [0,0];
}
function glowSprite(c){const cv=mk(64,64),x=cv.getContext('2d'),gr=x.createRadialGradient(32,32,0,32,32,32);
  gr.addColorStop(0,rgba(c,1));gr.addColorStop(0.25,rgba(c,0.45));gr.addColorStop(1,rgba(c,0));x.fillStyle=gr;x.fillRect(0,0,64,64);return cv;}

export default {
  id:'starlane',
  name:'Starlane',
  order:45,
  hud:false,   // the cockpit HUD shows the chord and the lyrics itself
  create(){
    let w=0,h=0,k=1,L=null,layKey='',info=null,infoKey='',songRef=null,art=null,glow=null,noise=null,pats=null;
    let B=null,c=null,T1=null,t1=null,T2=null,t2=null,sc=1,scan=null;
    const pcFlash=new Float32Array(12),pcCol=new Array(12).fill('cyan');
    let lastT=null,shake=0,thrust=0,gridPulse=0,bassS=0,vocS=0,leadS=0,otherS=0,altS=0.5,altA=0,altNote=null;
    let chordCur,chordPrev=null,chordWall=-9;
    const bolts=[],flares=[],comets=[],pool=[],list=[];let np=0;
    let lyr={key:''};
    const V={t:0,Dt:0,camX:0,camY:3.2,wall:0,speed:40,ship:{x:0,y:3.2},beat:0};
    let px=0,py=0,pk=0;
    const P=(x,y,z)=>{if(z<NEAR)return false;pk=L.F/z;px=L.cx+(x-V.camX)*pk;py=L.hy-(y-V.camY)*pk;return true;};

    function ensureInfo(song){
      const key=(song?.title||'')+'|'+(song?.duration||0)+'|'+Object.entries(song?.midi||{}).map(([a,b])=>a+(b?.notes?.length||0)).join(',')+'|'+(song?.features?.tracks?Object.keys(song.features.tracks).length:0)+'|'+(song?.sections?.length||0);
      if(song===songRef&&key===infoKey&&info)return;
      songRef=song;infoKey=key;info=prep(song);bolts.length=flares.length=comets.length=0;lyr={key:''};if(art)art.titleKey='';
    }
    function ensureLayout(env,g){
      const zc=env.zones?.chord||{top:0,bottom:h*0.27},zl=env.zones?.lyrics||null;
      const kk=clamp(g.getTransform?Math.abs(g.getTransform().a):1,1,2);
      const key=[w,h,kk,zc.top,zc.bottom,zl?zl.top:-1,zl?zl.bottom:-1].join('|');
      if(key===layKey)return;layKey=key;k=kk;
      const u=Math.min(w,h),top=zc.bottom,bot=zl?zl.top:h*0.97,M=Math.max(bot-top,h*0.3);
      L={u,top,bot,M,zc,zl,cx:w/2,hy:top+M*0.42,F:u*0.9};
      sc=Math.min(1,1600/w);const BW=Math.max(1,Math.round(w*sc)),BH=Math.max(1,Math.round(h*sc));
      B=mk(BW,BH);c=B.getContext('2d');T1=mk(BW,BH);t1=T1.getContext('2d');T2=mk(BW,BH);t2=T2.getContext('2d');
      buildArt();
    }
    function buildArt(){
      const u=L.u,hy=L.hy,f=hy/h,S=sc;
      const off=(W,H)=>{const cv=mk(W*S,H*S),x=cv.getContext('2d');x.scale(S,S);return [cv,x];};
      if(!glow){glow={};for(const kk of Object.keys(RGB))glow[kk]=glowSprite(RGB[kk]);}
      if(!noise){noise=[];const r=rng(77);for(let n=0;n<4;n++){const cv=mk(128,128),x=cv.getContext('2d'),im=x.createImageData(128,128);
        for(let i=0;i<im.data.length;i+=4){const on=r()<0.45,v=r()*255;im.data[i]=im.data[i+1]=im.data[i+2]=v;im.data[i+3]=on?60+r()*140:0;}x.putImageData(im,0,0);noise.push(cv);}}
      pats=null;
      art={titleKey:''};
      const sky=stops=>{const [cv,x]=off(w,h),gr=x.createLinearGradient(0,0,0,h);stops.forEach(([p,col])=>gr.addColorStop(clamp(p,0,1),col));x.fillStyle=gr;x.fillRect(0,0,w,h);return cv;};
      art.skySpace=sky([[0,INK],[f*0.8,'#1a1430'],[f,'#231a3c'],[f*1.3,'#1a1430'],[1,INK]]);
      art.skyAtmo=sky([[0,INK],[f*0.45,'#24113f'],[f*0.78,'#561a63'],[f*0.95,'#b8307f'],[f,'#ff9f7a'],[Math.min(1,f+0.001),'#1a1229'],[1,'#1a1229']]);
      art.skyRoad=sky([[0,INK],[f*0.85,'#1e1236'],[f,'#3d1c52'],[Math.min(1,f+0.001),'#0d0a16'],[1,'#0d0a16']]);
      art.skyUfo=sky([[0,INK],[f*0.8,'#1f1131'],[f,'#5a1838'],[Math.min(1,f+0.001),'#120f1d'],[1,'#120f1d']]);
      {const [cv,x]=off(w,h),gr=x.createRadialGradient(L.cx,hy,0,L.cx,hy,Math.max(w,h)*0.7);gr.addColorStop(0,'#3a1858');gr.addColorStop(0.35,'#1d1233');gr.addColorStop(1,INK);x.fillStyle=gr;x.fillRect(0,0,w,h);art.skyHyper=cv;}
      const haze=(col,a)=>{const H=L.M*0.24,[cv,x]=off(w,H),gr=x.createLinearGradient(0,0,0,H);gr.addColorStop(0,rgba(col,a));gr.addColorStop(1,rgba(col,0));x.fillStyle=gr;x.fillRect(0,0,w,H);return cv;};
      art.hazeAtmo=haze(RGB.pink,0.6);art.hazeRoad=haze(RGB.cyan,0.22);art.hazeUfo=haze(RGB.pink,0.32);art.hazeH=L.M*0.24;
      {const D=u*0.42,[cv,x]=off(D,D),gr=x.createLinearGradient(0,0,0,D);gr.addColorStop(0,'#fff0b0');gr.addColorStop(0.35,WARM);gr.addColorStop(0.72,'#ff7a7a');gr.addColorStop(1,PINK);
        x.fillStyle=gr;x.beginPath();x.arc(D/2,D/2,D/2,0,TAU);x.fill();x.globalCompositeOperation='destination-out';
        for(let i=0;i<7;i++)x.fillRect(0,D*(0.5+i*0.07),D,D*(0.006+i*0.007));art.sun=cv;art.sunD=D;}
      const ridge=(seed,W,H,n)=>{const r=rng(seed),pts=[];let v=0.5;for(let i=0;i<=n;i++){v=clamp(v+(r()-0.5)*0.7,0.1,1);pts.push([W*i/n,H*(1-v*(0.55+0.45*r()))]);}return pts;};
      {const W=w*1.3,H=u*0.11,[cv,x]=off(W,H),pts=ridge(31,W,H,26);x.beginPath();x.moveTo(0,H);pts.forEach(p=>x.lineTo(p[0],p[1]));x.lineTo(W,H);x.closePath();x.fillStyle='#1c0f2e';x.fill();
        x.beginPath();pts.forEach((p,i)=>i?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]));x.strokeStyle=PINK;x.lineWidth=1.5;x.stroke();art.mtnAtmo=cv;art.mtnW=W;art.mtnH=H;}
      {const W=w*1.3,H=u*0.09,[cv,x]=off(W,H),pts=ridge(57,W,H,34);x.beginPath();x.moveTo(0,H);pts.forEach(p=>x.lineTo(p[0],p[1]));x.lineTo(W,H);x.closePath();x.fillStyle='#140f24';x.fill();
        x.strokeStyle='rgba(0,229,255,0.35)';x.lineWidth=1;x.beginPath();pts.forEach(p=>{x.moveTo(p[0],p[1]);x.lineTo(p[0]+(p[0]-W/2)*0.04,H);});x.stroke();
        x.strokeStyle=CYAN;x.lineWidth=1.3;x.beginPath();pts.forEach((p,i)=>i?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]));x.stroke();art.mtnRoad=cv;art.mtnRH=H;}
      {const R=u*0.07,W=R*4.2,H=R*2.6,[cv,x]=off(W,H),cx=W/2,cy=H/2;
        const ring=(a0,a1)=>{x.beginPath();x.ellipse(cx,cy,R*1.9,R*0.42,-0.25,a0,a1);x.strokeStyle='rgba(255,63,164,0.75)';x.lineWidth=R*0.09;x.stroke();};
        ring(Math.PI,TAU);const gr=x.createLinearGradient(cx-R,cy-R,cx+R,cy+R);gr.addColorStop(0,'#5fd8ef');gr.addColorStop(0.35,'#4a3a8a');gr.addColorStop(1,'#1a1230');
        x.fillStyle=gr;x.beginPath();x.arc(cx,cy,R,0,TAU);x.fill();x.strokeStyle='rgba(255,255,255,0.12)';x.lineWidth=1;for(let i=-2;i<=2;i++){x.beginPath();x.ellipse(cx,cy+i*R*0.3,R*Math.sqrt(1-(i*0.3)**2),R*0.06,0,0,TAU);x.stroke();}
        ring(0,Math.PI);art.planet=cv;art.plW=W;art.plH=H;}
      {const [cv,x]=off(w,h),r=rng(4);x.filter=`blur(${Math.max(6,Math.round(u*0.05*S))}px)`;
        for(let i=0;i<11;i++){const col=i%3===0?RGB.cyan:RGB.pink;x.fillStyle=rgba(col,0.12+r()*0.16);x.beginPath();x.ellipse(r()*w,L.top*0.6+r()*(hy-L.top*0.6)*0.9,u*(0.12+r()*0.22),u*(0.04+r()*0.08),r()*0.6-0.3,0,TAU);x.fill();}
        x.filter='none';art.nebula=cv;}
      {const r=rng(1986);art.stars=[];for(let i=0;i<220;i++)art.stars.push({x:r(),y:r(),pc:Math.floor(r()*12),s:0.7+r()*1.5,f:0.4+r()*1.8,ph:r()*TAU,d:r()});}
      scan=mk(w*k,h*k);{const x=scan.getContext('2d'),step=3*k;x.fillStyle='rgba(0,0,0,0.2)';for(let y=0;y<scan.height;y+=step)x.fillRect(0,y,scan.width,Math.max(1,Math.round(k)));}
    }
    function ensureTitle(){
      const title=String(songRef?.title||'').toUpperCase().trim(),key=title+'|'+w+'|'+h+'|'+k;
      if(art.titleKey===key)return;art.titleKey=key;art.title=null;if(!title)return;
      const tmp=mk(4,4).getContext('2d');let fs=L.M*0.3;tmp.font=`800 ${fs}px ${DISPLAY}`;let tw=tmp.measureText(title).width;
      if(tw>w*0.78){fs*=w*0.78/tw;tw=w*0.78;}
      const W=tw+fs*1.4,H=fs*1.75,cv=mk(W*k,H*k),x=cv.getContext('2d');x.scale(k,k);x.translate(W/2,fs*1.08);x.transform(1,0,-0.2,1,0,0);
      x.font=`800 ${fs}px ${DISPLAY}`;x.textAlign='center';x.textBaseline='alphabetic';x.lineJoin='round';
      for(let i=7;i>=1;i--){x.fillStyle=i===1?PINK:'#5a1450';x.fillText(title,i*fs*0.012,i*fs*0.012);}
      x.strokeStyle=INK;x.lineWidth=fs*0.09;x.strokeText(title,0,0);
      const gr=x.createLinearGradient(0,-fs*0.76,0,fs*0.04);
      [[0,'#ffffff'],[0.2,'#bfe9ff'],[0.47,'#4a6fa8'],[0.5,'#1a1030'],[0.54,'#ff9ad5'],[0.78,WARM],[1,'#fff6e0']].forEach(([p,col])=>gr.addColorStop(p,col));
      x.fillStyle=gr;x.fillText(title,0,0);x.strokeStyle='rgba(255,255,255,0.75)';x.lineWidth=Math.max(1,fs*0.012);x.strokeText(title,0,0);
      x.setTransform(k,0,0,k,0,0);const ly=fs*1.42;
      x.strokeStyle='rgba(255,63,164,0.3)';x.lineWidth=fs*0.09;x.beginPath();x.moveTo(W/2-tw/2,ly);x.lineTo(W/2+tw/2,ly);x.stroke();
      x.strokeStyle='#ffc2e2';x.lineWidth=fs*0.025;x.stroke();
      art.title=cv;art.tW=W;art.tH=H;art.glint=mk(W*k,H*k);
    }

    // ---------- world pieces
    function starsLayer(x,maxY,mul){
      const par=V.camX*L.u*0.006,W=w*1.1;
      for(const s of art.stars){
        const fl=pcFlash[s.pc],Y=s.y*maxY;let X=(s.x*W-par*(0.3+s.d))%W;if(X<0)X+=W;X-=w*0.05;
        const a=Math.min(1,(0.2+0.16*Math.sin(V.wall*s.f+s.ph)+fl*0.85)*mul),r=s.s*(1+fl*1.6);
        x.fillStyle=fl>0.12?rgba(RGB[pcCol[s.pc]],a):`rgba(232,226,255,${a})`;x.fillRect(X-r/2,Y-r/2,r,r);
        if(fl>0.35){x.fillRect(X-r*2.6,Y-0.5,r*5.2,1);x.fillRect(X-0.5,Y-r*2.6,1,r*5.2);}
      }
    }
    function streaks(x,mode,spacing,lenMul,colA,colB){
      const s0=Math.floor((V.Dt-SZ+NEAR)/spacing)+1,s1=Math.floor((V.Dt-SZ+FAR)/spacing),len=Math.max(0.6,V.speed*lenMul);
      x.lineWidth=1;
      for(let pass=0;pass<2;pass++){x.strokeStyle=pass?colB:colA;x.beginPath();
        for(let i=s0;i<=s1;i++){if((i&1)!==pass)continue;const z=SZ+i*spacing-V.Dt;let xw,yw;
          if(mode===1){const a=hsh(i,1)*TAU,r=6.5+hsh(i,2)*6;xw=Math.cos(a)*r;yw=3.8+Math.sin(a)*r;}
          else{xw=(hsh(i,1)-0.5)*70;yw=(hsh(i,2)-0.5)*40+3.2;}
          if(!P(xw,yw,z))continue;const X0=px,Y0=py;P(xw,yw,z+len);x.moveTo(X0,Y0);x.lineTo(px,py);}
        x.stroke();}
    }
    function checker(x,T,Wc,colA,colB){
      x.fillStyle=colA;x.fillRect(0,L.hy,w,h-L.hy);x.beginPath();
      const n0=Math.floor((V.Dt-SZ+NEAR)/T),n1=Math.ceil((V.Dt-SZ+FARG)/T);
      for(let n=n0;n<n1;n++){let z0=SZ+n*T-V.Dt,z1=z0+T;if(z1<=NEAR)continue;if(z0<NEAR)z0=NEAR;if(z1>FARG)z1=FARG;if(z0>=z1)continue;
        const k0=L.F/z0,k1=L.F/z1,y0=L.hy+V.camY*k0,y1=L.hy+V.camY*k1,half=(w*0.5+4)/k1,m0=Math.floor((V.camX-half)/Wc),m1=Math.ceil((V.camX+half)/Wc);
        for(let m=m0;m<m1;m++){if(((n+m)&1)===0)continue;const xa=m*Wc-V.camX,xb=xa+Wc;
          x.moveTo(L.cx+xa*k0,y0);x.lineTo(L.cx+xb*k0,y0);x.lineTo(L.cx+xb*k1,y1);x.lineTo(L.cx+xa*k1,y1);x.closePath();}}
      x.fillStyle=colB;x.fill();
    }
    function grid(x,T,Wc,col,a){
      x.strokeStyle=rgba(col,a);x.lineWidth=1;x.beginPath();
      const n0=Math.floor((V.Dt-SZ+NEAR)/T)+1,n1=Math.floor((V.Dt-SZ+FARG)/T);
      for(let n=n0;n<=n1;n++){const z=SZ+n*T-V.Dt;if(z<NEAR)continue;const y=L.hy+V.camY*L.F/z;x.moveTo(0,y);x.lineTo(w,y);}
      for(let m=-16;m<=16;m++){if(!P(m*Wc,0,NEAR+0.3))continue;const X0=px,Y0=py;P(m*Wc,0,FARG);x.moveTo(X0,Y0);x.lineTo(px,py);}
      x.stroke();
    }
    function horizonArt(x,img,iw,ih,yOff){const X=(w-iw)/2-V.camX*L.u*0.012;x.drawImage(img,X,L.hy-ih+yOff,iw,ih);}

    function bgSpace(x){
      x.drawImage(art.skySpace,0,0,w,h);
      x.globalCompositeOperation='lighter';x.globalAlpha=0.12+0.55*otherS;x.drawImage(art.nebula,0,0,w,h);x.globalAlpha=1;x.globalCompositeOperation='source-over';
      starsLayer(x,h,1);
      x.drawImage(art.planet,w*0.8-art.plW/2-V.camX*L.u*0.004,L.top+L.M*0.18-art.plH/2,art.plW,art.plH);
      streaks(x,0,0.6,0.05,'rgba(232,226,255,0.55)','rgba(0,229,255,0.45)');
    }
    function bgAtmo(x){
      x.drawImage(art.skyAtmo,0,0,w,h);
      starsLayer(x,L.hy*0.55,0.8);
      x.globalCompositeOperation='lighter';x.globalAlpha=0.08+0.35*otherS;x.drawImage(art.nebula,0,0,w,h);
      const D=art.sunD*(1+0.08*bassS),sx=L.cx-V.camX*L.u*0.004,sy=L.hy-D*0.36;
      x.globalAlpha=0.35+0.5*vocS;const gs=D*2.2;x.drawImage(glow.warm,sx-gs/2,sy-gs/2,gs,gs);x.globalAlpha=1;x.globalCompositeOperation='source-over';
      x.globalAlpha=0.8+0.2*vocS;x.drawImage(art.sun,sx-D/2,sy-D/2,D,D);x.globalAlpha=1;
      horizonArt(x,art.mtnAtmo,art.mtnW,art.mtnH,1);
      checker(x,4,3,'#1a1229','#2e1a4a');
      grid(x,4,3,RGB.pink,0.1+0.25*gridPulse);
      x.drawImage(art.hazeAtmo,0,L.hy,w,art.hazeH);
    }
    function bgRoad(x){
      x.drawImage(art.skyRoad,0,0,w,h);
      starsLayer(x,L.hy*0.9,1);
      x.globalCompositeOperation='lighter';x.globalAlpha=0.1+0.45*otherS;x.drawImage(art.nebula,0,0,w,h);x.globalAlpha=1;x.globalCompositeOperation='source-over';
      horizonArt(x,art.mtnRoad,art.mtnW,art.mtnRH,1);
      grid(x,6,4,RGB.pink,0.12+0.3*gridPulse);
      // the track
      const RW=7.5;x.fillStyle='#1b1430';x.beginPath();
      P(-RW,0,NEAR+0.2);x.moveTo(px,py);P(RW,0,NEAR+0.2);x.lineTo(px,py);P(RW,0,FARG);x.lineTo(px,py);P(-RW,0,FARG);x.lineTo(px,py);x.closePath();x.fill();
      x.lineCap='round';
      for(const sd of [-1,1]){P(sd*RW,0,NEAR+0.2);const X0=px,Y0=py;P(sd*RW,0,FARG);
        x.strokeStyle='rgba(0,229,255,0.25)';x.lineWidth=L.u*0.012;x.beginPath();x.moveTo(X0,Y0);x.lineTo(px,py);x.stroke();
        x.strokeStyle=CYAN;x.lineWidth=Math.max(1.5,L.u*0.003);x.stroke();}
      x.strokeStyle=`rgba(255,209,102,${0.45+0.3*gridPulse})`;x.lineWidth=Math.max(1,L.u*0.0025);x.beginPath();
      const T=6,n0=Math.floor((V.Dt-SZ+NEAR)/T),n1=Math.ceil((V.Dt-SZ+FARG)/T);
      for(const lx of [-RW/3,RW/3])for(let n=n0;n<=n1;n++){const z0=Math.max(NEAR+0.2,SZ+n*T-V.Dt),z1=SZ+n*T+2.5-V.Dt;if(z1<=z0)continue;
        P(lx,0,z0);x.moveTo(px,py);P(lx,0,Math.min(z1,FARG));x.lineTo(px,py);}
      x.stroke();x.lineCap='butt';
      x.drawImage(art.hazeRoad,0,L.hy,w,art.hazeH);
    }
    function bgHyper(x){
      x.drawImage(art.skyHyper,0,0,w,h);
      x.globalCompositeOperation='lighter';x.globalAlpha=0.08+0.4*otherS;x.drawImage(art.nebula,0,0,w,h);x.globalAlpha=1;
      streaks(x,1,0.35,0.09,'rgba(0,229,255,0.5)','rgba(255,63,164,0.5)');
      x.globalCompositeOperation='source-over';
    }
    function saucerPos(i,t){
      let X=[-9,0,9][i]+Math.sin(V.wall*0.6+i*2)*2.2,Y=9.5+Math.sin(V.wall*1.1+i)*0.6,Z=[72,88,64][i];
      for(const a of info.A){if(a.ufo!==i)continue;const d=t-a.t;if(d<-a.warn-0.7||d>0.8)continue;
        const q=ease((d+a.warn+0.7)/0.7)*(1-ease((d-0.35)/0.45));X=lerp(X,a.x*0.6,q);Y=lerp(Y,7.2,q);Z=lerp(Z,46,q);break;}
      return [X,Y,Z];
    }
    function drawSaucer(x,X,Y,kk,i){
      const rx=2.4*kk,ry=0.6*kk;
      x.globalCompositeOperation='lighter';x.globalAlpha=0.55;x.drawImage(glow.pink,X-rx*1.3,Y-ry,rx*2.6,ry*4);x.globalAlpha=1;x.globalCompositeOperation='source-over';
      x.fillStyle='rgba(0,229,255,0.6)';x.beginPath();x.ellipse(X,Y-ry*0.45,rx*0.42,ry*1.25,0,Math.PI,TAU);x.fill();
      const gr=x.createLinearGradient(0,Y-ry,0,Y+ry);gr.addColorStop(0,'#e4def6');gr.addColorStop(0.5,'#6a5e8e');gr.addColorStop(1,'#1c1530');
      x.fillStyle=gr;x.beginPath();x.ellipse(X,Y,rx,ry,0,0,TAU);x.fill();
      x.strokeStyle=PINK;x.lineWidth=Math.max(1,kk*0.07);x.stroke();
      for(let j=0;j<6;j++){const th=Math.PI*(0.12+0.76*j/5),lit=(j+V.beat+i)%3===0;
        x.fillStyle=lit?WARM:'rgba(255,63,164,0.55)';x.beginPath();x.arc(X-Math.cos(th)*rx*0.8,Y+Math.sin(th)*ry*0.35,Math.max(1,kk*(lit?0.16:0.11)),0,TAU);x.fill();}
    }
    function bgUfo(x){
      x.drawImage(art.skyUfo,0,0,w,h);
      x.globalCompositeOperation='lighter';x.globalAlpha=0.1+0.5*otherS;x.drawImage(art.nebula,0,0,w,h);x.globalAlpha=1;x.globalCompositeOperation='source-over';
      starsLayer(x,L.hy,1);
      x.fillStyle='#120f1d';x.fillRect(0,L.hy,w,h-L.hy);
      grid(x,5,4,[150,70,210],0.28+0.35*gridPulse);
      x.drawImage(art.hazeUfo,0,L.hy,w,art.hazeH);
      streaks(x,0,1.2,0.04,'rgba(232,226,255,0.35)','rgba(255,63,164,0.3)');
      const order=[1,0,2];
      for(const i of order){const [X,Y,Z]=saucerPos(i,V.t);if(P(X,Y,Z))drawSaucer(x,px,py,pk,i);}
      // attacks: a reticle arrives where the ship will be on the bar, then the beam fires
      for(const a of info.A){const d=V.t-a.t;if(d<-a.warn||d>0.4)continue;
        const [X,Y,Z]=saucerPos(a.ufo,V.t);if(!P(X,Y-0.5,Z))continue;const sx=px,sy=py,zt=Math.max(NEAR+0.4,SZ+a.s-V.Dt);if(!P(a.x,a.y,zt))continue;const tx=px,ty=py,tk=pk;
        if(d<0){x.setLineDash([L.u*0.012,L.u*0.012]);x.lineDashOffset=-V.t*L.u*0.12;x.strokeStyle='rgba(255,209,102,0.7)';x.lineWidth=Math.max(1,L.u*0.002);
          x.beginPath();x.moveTo(sx,sy);x.lineTo(tx,ty);x.stroke();x.setLineDash([]);
          const r=tk*1.2;x.strokeStyle=WARM;x.lineWidth=Math.max(1.5,tk*0.08);x.beginPath();x.arc(tx,ty,r,0,TAU);x.stroke();
          x.beginPath();for(let q=0;q<4;q++){const an=q*Math.PI/2+V.t*2;x.moveTo(tx+Math.cos(an)*r*0.6,ty+Math.sin(an)*r*0.6);x.lineTo(tx+Math.cos(an)*r*1.4,ty+Math.sin(an)*r*1.4);}x.stroke();}
        else{const al=1-d/0.4;x.lineCap='round';x.globalCompositeOperation='lighter';
          x.strokeStyle=`rgba(255,63,164,${0.35*al})`;x.lineWidth=L.u*0.03;x.beginPath();x.moveTo(sx,sy);x.lineTo(tx,ty);x.stroke();
          x.strokeStyle=`rgba(255,230,245,${al})`;x.lineWidth=L.u*0.006;x.stroke();
          x.globalAlpha=al;const s=tk*5;x.drawImage(glow.pink,tx-s/2,ty-s/2,s,s);x.globalAlpha=1;x.globalCompositeOperation='source-over';x.lineCap='butt';}
      }
    }
    const STATION=[[-7,8.2,52],[0,10,68],[7,7.6,46]];
    function soloUfo(k,t){const [sx,sy,sz]=STATION[k.slot],q=ease((t-k.spawn)/0.8),sway=Math.sin(V.wall*1.3+k.i)*1.6;
      return [lerp(sx+(k.slot-1)*30+(k.slot===1?(k.i%2?-25:25):0),sx+sway*(1-ease((t-k.t+0.4)/0.4)),q),lerp(sy+6,sy+Math.sin(V.wall*1.7+k.i)*0.5,q),lerp(140,sz,q)];}
    function bgSolo(x){
      x.drawImage(art.skyUfo,0,0,w,h);
      x.globalCompositeOperation='lighter';x.globalAlpha=0.15+0.5*otherS;x.drawImage(art.nebula,0,0,w,h);x.globalAlpha=1;x.globalCompositeOperation='source-over';
      starsLayer(x,L.hy,1);
      x.fillStyle='#120f1d';x.fillRect(0,L.hy,w,h-L.hy);
      grid(x,5,4,[255,120,90],0.3+0.4*gridPulse);
      x.drawImage(art.hazeUfo,0,L.hy,w,art.hazeH);
      x.globalCompositeOperation='lighter';streaks(x,0,0.5,0.08,'rgba(255,209,102,0.45)','rgba(255,63,164,0.45)');x.globalCompositeOperation='source-over';
      const t=V.t,K=info.K;
      for(const k of K){
        if(t<k.spawn||t>k.t+0.9)continue;
        if(t<k.t){const [X,Y,Z]=soloUfo(k,t);if(P(X,Y,Z))drawSaucer(x,px,py,pk,k.slot);
          if(!k.survivor&&t>k.t-0.14&&P(X,Y,Z)){const ux=px,uy=py;if(P(V.ship.x,V.ship.y+0.1,SZ+(V.surge||0))){const q=(t-(k.t-0.14))/0.14;
            x.globalCompositeOperation='lighter';x.lineCap='round';x.strokeStyle='rgba(255,209,102,0.4)';x.lineWidth=L.u*0.012;x.beginPath();x.moveTo(px,py);x.lineTo(lerp(px,ux,q),lerp(py,uy,q));x.stroke();
            x.strokeStyle='#fff6e0';x.lineWidth=L.u*0.003;x.stroke();x.lineCap='butt';x.globalCompositeOperation='source-over';}}
          continue;}
        if(k.survivor)continue;
        const [X,Y,Z]=soloUfo(k,k.t),q=(t-k.t)/0.9;if(!P(X,Y,Z))continue;const ex=px,ey=py,kk=pk;
        x.globalCompositeOperation='lighter';
        x.globalAlpha=Math.max(0,1-q*1.4);const fb=kk*(3+q*7);x.drawImage(glow.warm,ex-fb/2,ey-fb/2,fb,fb);x.drawImage(glow.white,ex-fb/4,ey-fb/4,fb/2,fb/2);x.globalAlpha=1;
        x.strokeStyle=`rgba(255,63,164,${(1-q)*0.9})`;x.lineWidth=Math.max(1,kk*0.15*(1-q));x.beginPath();x.ellipse(ex,ey,kk*(1+q*6),kk*(0.4+q*2.4),0,0,TAU);x.stroke();
        x.lineCap='round';
        for(let j=0;j<14;j++){const an=hsh(k.i,j)*TAU,sp=kk*(2+hsh(j,k.i)*5),d=sp*Math.pow(q,0.6),dy=kk*3*q*q,ln=kk*(0.4+0.5*hsh(j,7));
          x.strokeStyle=j%3?`rgba(255,209,102,${1-q})`:`rgba(228,222,246,${1-q})`;x.lineWidth=Math.max(1,kk*0.12);x.beginPath();
          const X1=ex+Math.cos(an)*d,Y1=ey+Math.sin(an)*d*0.6+dy;x.moveTo(X1,Y1);x.lineTo(X1-Math.cos(an)*ln,Y1-Math.sin(an)*ln*0.6);x.stroke();}
        x.lineCap='butt';x.globalCompositeOperation='source-over';
      }
    }
    const BG={space:bgSpace,atmo:bgAtmo,road:bgRoad,hyper:bgHyper,ufo:bgUfo,solo:bgSolo};

    // ---------- shared world: notes, gates, tunnel rings, beacons (painter-sorted)
    function item(z,type,o){let it=pool[np];if(!it)it=pool[np]={};it.z=z;it.type=type;it.o=o;np++;}
    function tube(x,xw,yw,z0,z1,col,a,wd){
      if(!P(xw,yw,z0))return;const X0=px,Y0=py,k0=pk;P(xw,yw,z1);const X1=px,Y1=py,k1=pk;
      const dx=X1-X0,dy=Y1-Y0,l=Math.hypot(dx,dy)||1,nx=-dy/l,ny=dx/l,w0=wd*k0,w1=wd*k1;
      x.fillStyle=rgba(col,a*0.35);x.beginPath();x.moveTo(X0+nx*w0,Y0+ny*w0);x.lineTo(X1+nx*w1,Y1+ny*w1);x.lineTo(X1-nx*w1,Y1-ny*w1);x.lineTo(X0-nx*w0,Y0-ny*w0);x.closePath();x.fill();
      x.strokeStyle=rgba(col,a);x.lineWidth=Math.max(1,w1*0.5);x.beginPath();x.moveTo(X0,Y0);x.lineTo(X1,Y1);x.stroke();
    }
    function drawNote(x,n,zs){
      const col=RGB[n.col],ze=SZ+n.e-V.Dt,fade=clamp((FAR-zs)/(FAR*0.35),0,1),road=n.scene==='road',yR=road?0.04:n.y;
      const sounding=zs<=SZ&&ze>SZ;
      x.globalCompositeOperation='lighter';
      const z0=Math.max(zs,SZ-1.5,NEAR),z1=Math.min(ze,FAR);
      if(z1>z0+0.05)tube(x,n.x,yR,z0,z1,col,(sounding?0.95:0.6)*fade,road?0.35:0.14);
      if(zs<SZ-0.3||!P(n.x,n.y,zs)){x.globalCompositeOperation='source-over';return;}
      const X=px,Y=py,kk=pk,sz=(0.55+0.35*n.str)*kk,hex=HEX[n.col];
      x.globalAlpha=fade;
      switch(n.scene){
        case 'atmo':{x.strokeStyle=rgba(col,0.3);x.lineWidth=kk*0.3;x.beginPath();x.arc(X,Y,kk*0.95,0,TAU);x.stroke();x.strokeStyle=hex;x.lineWidth=Math.max(1,kk*0.08);x.stroke();break;}
        case 'road':{if(!P(n.x,0.02,zs))break;const gx=px,gy=py;
          const pt=(dx,dz)=>{P(n.x+dx,0.02,zs+dz);return [px,py];};
          const q=[pt(-0.9,0),pt(0,1.0),pt(0.9,0),pt(0.9,0.55),pt(0,1.55),pt(-0.9,0.55)];
          x.fillStyle=rgba(col,0.8);x.beginPath();q.forEach((p,i)=>i?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]));x.closePath();x.fill();
          x.strokeStyle=rgba(col,0.5);x.lineWidth=Math.max(1,kk*0.05);x.beginPath();x.moveTo(gx,gy);x.lineTo(X,Y);x.stroke();
          const s=sz*2.2;x.drawImage(glow[n.col],X-s/2,Y-s/2,s,s);break;}
        case 'hyper':{const r=kk*1.0;x.beginPath();x.moveTo(X,Y-r);x.lineTo(X+r,Y);x.lineTo(X,Y+r);x.lineTo(X-r,Y);x.closePath();
          x.strokeStyle=rgba(col,0.3);x.lineWidth=kk*0.3;x.stroke();x.strokeStyle=hex;x.lineWidth=Math.max(1,kk*0.08);x.stroke();break;}
        case 'ufo':case 'solo':{const s=sz*3;x.drawImage(glow[n.col],X-s/2,Y-s/2,s,s);x.fillStyle='#fff';x.beginPath();x.arc(X,Y,Math.max(1,sz*0.3),0,TAU);x.fill();
          x.strokeStyle=rgba(col,0.7);x.lineWidth=Math.max(1,kk*0.05);x.beginPath();x.arc(X,Y,sz*0.85,0,TAU);x.stroke();break;}
        default:{const s=sz*3.2;x.drawImage(glow[n.col],X-s/2,Y-s/2,s,s);x.fillStyle='#fff';const a=sz*1.3,b=Math.max(1,sz*0.12);
          x.fillRect(X-a,Y-b/2,a*2,b);x.fillRect(X-b/2,Y-a,b,a*2);}
      }
      if(n.home){x.strokeStyle=rgba(RGB.warm,0.75);x.lineWidth=Math.max(1,kk*0.04);x.beginPath();x.arc(X,Y,kk*1.5,0,TAU);x.stroke();}
      x.globalAlpha=1;x.globalCompositeOperation='source-over';
    }
    function drawGate(x,gt,z){
      const kk=L.F/z,a=Math.min(clamp((FAR-z)/(FAR*0.35),0,1),clamp((z-NEAR)/(SZ*0.7),0,1));if(a<=0.01)return;
      const col=RGB[gt.col],X=xw=>L.cx+(xw-V.camX)*kk,Y=yw=>L.hy-(yw-V.camY)*kk,top=5.6;
      x.globalCompositeOperation='lighter';x.lineJoin='round';
      for(const sd of [-1,1]){const bx=sd*7.2;x.beginPath();x.moveTo(X(bx-0.7),Y(0));x.lineTo(X(bx+0.7),Y(0));x.lineTo(X(bx),Y(top));x.closePath();
        x.fillStyle=rgba(col,0.2*a);x.fill();x.strokeStyle=rgba(col,a);x.lineWidth=Math.max(1,kk*0.07);x.stroke();
        const s=Math.min(L.u*0.12,kk*2.2);x.globalAlpha=a;x.drawImage(glow[gt.col],X(bx)-s/2,Y(top)-s/2,s,s);x.globalAlpha=1;}
      x.setLineDash([Math.max(2,kk*0.5),Math.max(2,kk*0.3)]);x.lineDashOffset=-V.t*kk*4;
      x.strokeStyle=rgba(col,0.85*a);x.lineWidth=Math.max(1,kk*0.06);x.beginPath();x.moveTo(X(-7.2),Y(top));x.lineTo(X(7.2),Y(top));x.stroke();x.setLineDash([]);
      x.globalCompositeOperation='source-over';
      const fs=kk*1.0;if(fs<7)return;
      const lab=String(gt.label).replace(/#/g,'♯').replace(/b(?=\d|$|\/|m|s|a|d)/g,'♭');
      x.font=`800 ${fs}px ${DISPLAY}`;const tw=x.measureText(lab).width,pw=tw+fs*0.9,ph=fs*1.35,cx0=X(0),cy0=Y(top+1.3);
      x.globalAlpha=a;x.fillStyle='rgba(18,15,29,0.85)';x.beginPath();x.roundRect(cx0-pw/2,cy0-ph/2,pw,ph,ph/2);x.fill();
      x.strokeStyle=HEX[gt.col];x.lineWidth=Math.max(1,kk*0.06);x.stroke();
      x.textAlign='center';x.textBaseline='middle';x.fillStyle=HEX[gt.col];x.fillText(lab,cx0,cy0+fs*0.04);x.globalAlpha=1;x.textBaseline='alphabetic';
    }
    function drawRing(x,b,z){
      const kk=L.F/z,a=Math.min(clamp((FAR-z)/(FAR*0.4),0,1),clamp((z-NEAR)/(SZ*0.8),0,1));if(a<=0.01)return;
      const col=b.down?RGB.warm:(b.i&1?RGB.pink:RGB.cyan),r=8.5,cx0=L.cx+(0-V.camX)*kk,cy0=L.hy-(3.8-V.camY)*kk,pass=clamp(1-Math.abs(z-SZ)/3,0,1);
      x.beginPath();for(let q=0;q<8;q++){const an=q*TAU/8+Math.PI/8;const X=cx0+Math.cos(an)*r*kk,Y=cy0+Math.sin(an)*r*kk;q?x.lineTo(X,Y):x.moveTo(X,Y);}x.closePath();
      x.globalCompositeOperation='lighter';x.strokeStyle=rgba(col,(0.18+0.3*pass)*a);x.lineWidth=kk*(b.down?0.7:0.45);x.stroke();
      x.strokeStyle=rgba(col,a);x.lineWidth=Math.max(1,kk*(b.down?0.14:0.08));x.stroke();x.globalCompositeOperation='source-over';
    }
    function drawBeacon(x,bc,z){
      const a=Math.min(clamp((FAR*0.75-z)/(FAR*0.3),0,1),clamp((z-NEAR)/(SZ*0.6),0,1));if(a<=0.01)return;const sd=bc.side?1:-1,hh=0.6+bc.str*1.4;
      if(!P(sd*8.8,0,z))return;const X0=px,Y0=py;P(sd*8.8,hh,z);const X1=px,Y1=py,kk=pk;
      x.strokeStyle=`rgba(185,169,214,${0.5*a})`;x.lineWidth=Math.max(1,kk*0.1);x.beginPath();x.moveTo(X0,Y0);x.lineTo(X1,Y1);x.stroke();
      const dt=V.t-bc.t,lit=dt>=0?Math.exp(-dt*6):0.3,ck=bc.str>0.8?'pink':'cyan',s=Math.min(L.u*0.07,kk*(1.2+2.2*lit));
      x.globalCompositeOperation='lighter';x.globalAlpha=a*(0.45+0.55*lit);x.drawImage(glow[ck],X1-s/2,Y1-s/2,s,s);x.globalAlpha=1;x.globalCompositeOperation='source-over';
      x.fillStyle=HEX[ck];x.fillRect(X1-kk*0.12,Y1-kk*0.12,kk*0.24,kk*0.24);
    }
    function drawItem(x,it){if(it.type===0)drawNote(x,it.o,it.z);else if(it.type===1)drawGate(x,it.o,it.z);else if(it.type===2)drawRing(x,it.o,it.z);else drawBeacon(x,it.o,it.z);}
    function collect(){
      np=0;const Dt=V.Dt,t=V.t,zOf=s=>SZ+s-Dt,maxS=Dt-SZ+FAR,minS=Dt-SZ+NEAR;
      const N=info.N;for(let i=Math.max(0,after(N,t-info.maxDur-0.2)-1);i<N.length;i++){const n=N[i];if(n.s>maxS)break;if(n.e<minS)continue;item(zOf(n.s),0,n);}
      const first=(arr,s)=>{let lo=0,hi=arr.length;while(lo<hi){const m=(lo+hi)>>1;if(arr[m].s<s)lo=m+1;else hi=m;}return lo;};
      for(let i=first(info.G,minS);i<info.G.length&&info.G[i].s<=maxS;i++)item(zOf(info.G[i].s),1,info.G[i]);
      for(let i=first(info.BT,minS);i<info.BT.length&&info.BT[i].s<=maxS;i++){const b=info.BT[i];if(b.scene==='hyper')item(zOf(b.s),2,b);}
      for(let i=first(info.RH,minS);i<info.RH.length&&info.RH[i].s<=maxS;i++){const b=info.RH[i];if(b.scene!=='hyper')item(zOf(b.s),3,b);}
      list.length=np;for(let i=0;i<np;i++)list[i]=pool[i];list.sort((a,b)=>b.z-a.z);
    }
    function constellation(x){
      const N=info.N,maxS=V.Dt-SZ+FAR;let prev=null;x.strokeStyle='rgba(0,229,255,0.28)';x.lineWidth=1;x.beginPath();
      for(let i=Math.max(0,after(N,V.t)-1);i<N.length;i++){const n=N[i];if(n.s>maxS)break;const z=SZ+n.s-V.Dt;
        if(n.scene!=='space'||!P(n.x,n.y,Math.max(z,SZ))){prev=null;continue;}
        if(prev&&n.start-prev.start<2.5){x.moveTo(prev.X,prev.Y);x.lineTo(px,py);}prev={X:px,Y:py,start:n.start};}
      x.stroke();
    }

    // ---------- ship
    function shipAt(t){const b=basePos(info,t),d=dodgeAt(info,t);return {x:b.x+d[0],y:b.y,roll:d[1]};}
    function drawTrails(x,ang){
      const u=L.u,n=12,back=4.5/Math.max(20,V.speed)/n,a=0.15+0.85*Math.min(1,leadS*1.4),wd=0.03+0.1*Math.min(1,leadS*1.4);
      const ca=Math.cos(ang),sa=Math.sin(ang);x.lineCap='butt';x.globalCompositeOperation='lighter';
      for(const sd of [-1,1]){let X0=null,Y0=0;
        for(let i=0;i<=n;i++){const tt=V.t-i*back,p=shipAt(tt),z=SZ+info.dist(tt)-V.Dt+(V.surge||0)*(1-i/n);if(!P(p.x+sd*1.0*ca,p.y+sd*1.0*sa*-1+0.16,z))break;
          if(X0!=null){const f=1-i/n;x.strokeStyle=`rgba(0,229,255,${a*f*0.8})`;x.lineWidth=Math.min(u*0.01,Math.max(1,wd*pk));x.beginPath();x.moveTo(X0,Y0);x.lineTo(px,py);x.stroke();}
          X0=px;Y0=py;}}
      x.globalCompositeOperation='source-over';x.lineCap='butt';
    }
    function drawShip(x,X,Y,s,ang,heat,bloom=0,dim=0){
      x.save();x.translate(X,Y);x.rotate(ang);x.scale(s,s);const lw=1/s;
      if(vocS>0.05||heat>0.01){x.globalCompositeOperation='lighter';x.globalAlpha=Math.min(1,0.25*vocS+heat*0.8);x.drawImage(glow.warm,-2.2,-1.6,4.4,3.2);x.globalAlpha=1;x.globalCompositeOperation='source-over';}
      // tail fin
      x.fillStyle='#3a2f5a';x.beginPath();x.moveTo(-0.07,-0.04);x.lineTo(0,-0.6);x.lineTo(0.07,-0.04);x.closePath();x.fill();x.strokeStyle=CYAN;x.lineWidth=1.3*lw;x.stroke();
      // wings + body
      const gr=x.createLinearGradient(0,-0.2,0,0.3);gr.addColorStop(0,'#f1ecff');gr.addColorStop(0.45,'#8d7fbc');gr.addColorStop(1,'#241c3d');
      x.fillStyle=gr;x.beginPath();x.moveTo(-1.02,0.16);x.lineTo(-0.26,-0.06);x.lineTo(0,-0.2);x.lineTo(0.26,-0.06);x.lineTo(1.02,0.16);x.lineTo(0.32,0.22);x.lineTo(0,0.3);x.lineTo(-0.32,0.22);x.closePath();x.fill();
      x.strokeStyle=PINK;x.lineWidth=1.5*lw;x.stroke();
      x.fillStyle='rgba(0,229,255,0.75)';x.beginPath();x.ellipse(0,-0.1,0.11,0.06,0,0,TAU);x.fill();
      // engines (flare with kicks)
      for(const ex of [-0.24,0.24]){x.fillStyle='#160f24';x.beginPath();x.arc(ex,0.12,0.11,0,TAU);x.fill();
        const th=thrust*(1-0.8*dim),gs=(0.45+th*0.75)*(1-0.45*dim)+bloom*1.4;x.globalCompositeOperation='lighter';x.drawImage(glow.pink,ex-gs,0.12-gs,gs*2,gs*2);x.drawImage(glow.warm,ex-gs*0.5,0.12-gs*0.5,gs,gs);
        if(bloom>0.02){const bs=0.6+bloom*1.8;x.globalAlpha=bloom;x.drawImage(glow.white,ex-bs/2,0.12-bs/2,bs,bs);x.globalAlpha=1;}x.globalCompositeOperation='source-over';
        x.fillStyle=dim>0.3?'#ff9a8a':'#fff6e0';x.beginPath();x.arc(ex,0.12,0.04+0.03*th+0.05*bloom,0,TAU);x.fill();}
      x.fillStyle=CYAN;for(const sd of [-1,1]){x.beginPath();x.arc(sd*1.02,0.16,0.045,0,TAU);x.fill();}
      x.restore();
    }

    // ---------- HUD (crisp, above the tape pass)
    const plate=(g,x0,y0,ww,hh,edge)=>{g.fillStyle='rgba(18,15,29,0.8)';g.beginPath();g.roundRect(x0,y0,ww,hh,hh*0.14);g.fill();g.strokeStyle=edge;g.lineWidth=1;g.stroke();};
    function chordParts(label){const m=/^([A-G])([#b]?)(.*)$/.exec(label||'');if(!m)return [label||'',''];return [m[1]+(m[2]==='#'?'♯':m[2]==='b'?'♭':''),m[3].replace(/#/g,'♯').replace(/\/([A-G])b/,'/$1♭')];}
    function chordLabel(g,label,cx,cy,maxW,fs,ck,alpha){
      if(alpha<=0.01)return;const [root,rest]=chordParts(label);
      g.font=`800 ${fs}px ${DISPLAY}`;let w1=g.measureText(root).width;g.font=`700 ${fs*0.55}px ${DISPLAY}`;let w2=rest?g.measureText(rest).width+fs*0.05:0;
      const s=Math.min(1,maxW/Math.max(1,w1+w2));fs*=s;w1*=s;w2*=s;const x0=cx-(w1+w2)/2,y=cy+fs*0.36,col=RGB[ck];
      g.globalAlpha=alpha;g.textAlign='left';g.textBaseline='alphabetic';g.lineJoin='round';
      const run=(f,ff)=>{g.font=`800 ${fs}px ${DISPLAY}`;f(root,x0+ff,y);if(rest){g.font=`700 ${fs*0.55}px ${DISPLAY}`;f(rest,x0+w1+fs*0.05+ff,y-fs*0.3);}};
      g.strokeStyle=rgba(col,0.3);g.lineWidth=fs*0.1;run((tx,a,b)=>g.strokeText(tx,a,b),0);
      g.fillStyle='rgba(255,63,164,0.5)';run((tx,a,b)=>g.fillText(tx,a,b),-1.2);g.fillStyle='rgba(0,229,255,0.5)';run((tx,a,b)=>g.fillText(tx,a,b),1.2);
      g.fillStyle=HEX[ck];run((tx,a,b)=>g.fillText(tx,a,b),0);g.globalAlpha=1;
    }
    const kindOf=l=>{if(noChord(l))return 'white';const r=pcOf(l),cc=chordColor(l),km=/minor|min\b/i.test(String(songRef?.key||''));if(r!=null&&r===info.keyRoot&&!!cc.minor===km)return 'warm';return cc.minor?'pink':'cyan';};
    function hudChord(g,fr,wall,calm){
      const zc=L.zc,Z=zc.bottom-zc.top,u=L.u,PW=Math.min(w*0.46,u*0.95),PH=Z*0.62,R={x:(w-PW)/2,y:zc.top+Z*0.18,w:PW,h:PH},ch=fr.chord||{};
      plate(g,R.x,R.y,R.w,R.h,'rgba(255,63,164,0.45)');
      g.save();g.beginPath();g.roundRect(R.x,R.y,R.w,R.h,R.h*0.14);g.clip();
      const kk=clamp((wall-chordWall)/0.28,0,1),e=ease(kk),dy=calm?0:R.h*0.5,mcx=R.x+R.w*0.31,mcy=R.y+R.h*0.5,mw=R.w*0.54,fs=R.h*0.66;
      const main=(lab,yo,al)=>{if(lab)chordLabel(g,lab,mcx,mcy+yo,mw,fs,kindOf(lab),al);else{g.globalAlpha=al;g.font=`700 ${fs*0.42}px ${MONO}`;g.textAlign='center';g.textBaseline='middle';g.fillStyle=LAV;g.fillText('N.C.',mcx,mcy+yo);g.globalAlpha=1;}};
      if(kk<1)main(chordPrev,-e*dy,1-kk);main(chordCur,(1-e)*dy,calm?1:kk);
      g.fillStyle='rgba(185,169,214,0.25)';g.fillRect(R.x+R.w*0.62,R.y+R.h*0.16,1,R.h*0.68);
      const nx=ch.next;
      if(nx&&!noChord(nx.label)){
        const x0=R.x+R.w*0.66,pw=R.w*0.29;g.font=`700 ${R.h*0.11}px ${MONO}`;g.textAlign='left';g.textBaseline='alphabetic';g.fillStyle=LAV;g.fillText('NEXT',x0,R.y+R.h*0.26);
        chordLabel(g,nx.label,x0+pw/2,R.y+R.h*0.47,pw,R.h*0.3,kindOf(nx.label),1);
        const span=ch.label?Math.max(0.1,(nx.start??0)-(ch.start??0)):4,p=clamp(1-(nx.in??0)/span,0,1),by=R.y+R.h*0.68,bh=Math.max(3,R.h*0.045);
        g.fillStyle='rgba(185,169,214,0.2)';g.fillRect(x0,by,pw,bh);g.fillStyle=HEX[kindOf(nx.label)];g.fillRect(x0,by,pw*p,bh);
        const ups=(ch.upcoming||[]).filter(q=>q.start>(nx.start??0)+1e-3&&!noChord(q.label)).slice(0,2);let ux=x0;g.font=`700 ${R.h*0.12}px ${MONO}`;
        for(const q of ups){const tx=chordParts(q.label).join('');g.fillStyle='rgba(185,169,214,0.75)';g.fillText(tx,ux,R.y+R.h*0.89);ux+=g.measureText(tx).width+R.h*0.12;}
      }
      g.restore();
      return PW;
    }
    function hudSide(g,fr,PW,seg){
      const zc=L.zc,Z=zc.bottom-zc.top,u=L.u,room=(w-PW)/2-u*0.07;if(room<u*0.14)return;
      g.textBaseline='alphabetic';
      const txt=(s,x,y,fs,font,col,al)=>{g.font=`${font} ${fs}px ${font.includes('800')?DISPLAY:MONO}`;let tw=g.measureText(s).width;if(tw>room){fs*=room/tw;g.font=`${font} ${fs}px ${font.includes('800')?DISPLAY:MONO}`;}g.fillStyle=col;g.textAlign=al;g.fillText(s,x,y);};
      const RX=w-u*0.04,y0=zc.top+Z*0.36;
      txt('STAGE '+String(seg.stage).padStart(2,'0'),RX,y0,Z*0.1,'700',WARM,'right');
      txt(STAGES[seg.scene].name,RX,y0+Z*0.2,Z*0.17,'800',CYAN,'right');
      const s=fr.section;let line=s?.name?String(s.name).toUpperCase():'';if(s?.next?.name&&s.next.in!=null)line+=(line?'  ▸ ':'▸ ')+String(s.next.name).toUpperCase()+' '+fmt(s.next.in);
      if(line)txt(line,RX,y0+Z*0.36,Z*0.085,'400',LAV,'right');
      if(seg.scene==='solo'){let n=0;for(const q of info.K)if(!q.survivor&&q.t<=fr.time&&q.t>=seg.start)n++;txt('UFOS DOWN '+String(n).padStart(2,'0'),RX,y0+Z*0.5,Z*0.09,'700',PINK,'right');}
      const b=fr.beat;if(b?.bar==null)return;
      const LX=u*0.04,by=zc.top+Z*0.56;txt('BAR '+String(b.bar).padStart(3,'0'),LX,by,Z*0.1,'700',WARM,'left');
      const n=b.beats||4,r=Z*0.035;for(let i=0;i<n;i++){const on=i===(b.beat||1)-1;g.fillStyle=on?(i===0?WARM:PINK):'rgba(185,169,214,0.3)';g.beginPath();g.arc(LX+r+i*r*3,by+Z*0.12,on?r*1.15:r*0.8,0,TAU);g.fill();}
    }
    function hudAlt(g,fr,dt){
      if(!info.N.length)return;const u=L.u,x0=u*0.05,y0=L.top+L.M*0.12,y1=L.bot-L.M*0.12,lo=info.lo,hi=info.hi;
      const act=fr.notes?.melody?.active?.[0]||fr.notes?.vocal?.active?.[0]||fr.notes?.instrumental?.active?.[0];
      if(act){altNote=act.pitch;altA=1;}else altA*=Math.exp(-dt*2);
      if(altNote!=null)altS+=(clamp((altNote-lo)/(hi-lo),0,1)-altS)*Math.min(1,dt*18);
      g.fillStyle='rgba(185,169,214,0.35)';g.fillRect(x0,y0,1,y1-y0);
      for(let p=lo;p<=hi;p++){const y=y1-(p-lo)/(hi-lo)*(y1-y0),home=info.keyRoot!=null&&((p%12)+12)%12===info.keyRoot;g.fillStyle=home?WARM:'rgba(185,169,214,0.45)';g.fillRect(x0+1,y-0.5,home?u*0.014:u*0.006,1);}
      if(altNote==null||altA<0.02)return;
      const y=y1-altS*(y1-y0),pc=((altNote%12)+12)%12,home=pc===info.keyRoot,ck=home?'warm':(pcCol[pc]||'cyan');
      g.globalAlpha=Math.min(1,altA*1.2);g.fillStyle=HEX[ck];g.beginPath();g.moveTo(x0+u*0.018,y);g.lineTo(x0+u*0.032,y-u*0.009);g.lineTo(x0+u*0.032,y+u*0.009);g.closePath();g.fill();
      const nm=(info.flats?NAMES_F:NAMES_S)[pc]+(Math.floor(altNote/12)-1);
      g.textAlign='left';g.textBaseline='middle';g.lineJoin='round';g.font=`800 ${u*0.03}px ${DISPLAY}`;g.strokeStyle=INK;g.lineWidth=u*0.008;g.strokeText(nm,x0+u*0.04,y);g.fillText(nm,x0+u*0.04,y);
      if(info.keyRoot!=null){const dg=DEG[(pc-info.keyRoot+12)%12];g.font=`700 ${u*0.016}px ${MONO}`;g.fillStyle=LAV;g.strokeText(dg,x0+u*0.04,y+u*0.028);g.fillText(dg,x0+u*0.04,y+u*0.028);}
      g.globalAlpha=1;
    }
    function lyricLayout(g,words,line,R){
      const key=line.index+'|'+line.text+'|'+R.w+'|'+R.h;if(lyr.key===key)return lyr;
      const toks=words.map(wd=>{const s=String(wd.text||'');const join=s.length>1&&s.endsWith('-');return {text:join?s.slice(0,-1):s,join};});
      const groups=[];let cur=[];toks.forEach((tk,i)=>{cur.push(i);if(!tk.join){groups.push(cur);cur=[];}});if(cur.length)groups.push(cur);
      const fs0=Math.min(R.h*0.38,R.w*0.055),maxW=R.w*0.92;
      const measure=fs=>{g.font=`700 ${fs}px ${DISPLAY}`;return {ws:toks.map(tk=>g.measureText(tk.text).width),sp:g.measureText(' ').width};};
      const wrap=m=>{const rows=[];let row=[],rw=0;for(const gr of groups){const gw=gr.reduce((a,i)=>a+m.ws[i],0),add=row.length?m.sp+gw:gw;if(row.length&&rw+add>maxW){rows.push({items:row,w:rw});row=[];rw=0;}rw+=row.length?m.sp+gw:gw;row.push(gr);}if(row.length)rows.push({items:row,w:rw});return rows;};
      let fs=fs0,m=measure(fs),rows=wrap(m);
      if(rows.length>1){fs=Math.min(fs,R.h*0.3);m=measure(fs);rows=wrap(m);}
      while((rows.length>2||rows.some(r=>r.w>maxW))&&fs>fs0*0.35){fs*=0.9;m=measure(fs);rows=wrap(m);}
      const out=[];rows.forEach((row,ri)=>{const y=rows.length===1?R.y+R.h*0.42+fs*0.35:R.y+R.h*(ri===0?0.3:0.7)+fs*0.35;let x=R.x+R.w/2-row.w/2;
        row.items.forEach((gr,gi)=>{if(gi)x+=m.sp;for(const i of gr){out.push({i,x,y,w:m.ws[i],text:toks[i].text});x+=m.ws[i];}});});
      lyr={key,fs,fs0,tokens:out,rows:rows.length};return lyr;
    }
    function hudLyrics(g,fr,t){
      const zl=L.zl;if(!zl)return;const ly=fr.lyric||{},line=ly.line,words=ly.words||[],lh=zl.bottom-zl.top,u=L.u;
      const lw=Math.min(w*0.84,w-u*0.08),R={x:(w-lw)/2,y:zl.top+lh*0.1,w:lw,h:lh*0.78};
      const soon=!line&&ly.next?.text&&ly.next.in!=null&&ly.next.in<6;
      if(!line&&!soon)return;
      plate(g,R.x,R.y,R.w,R.h,'rgba(0,229,255,0.35)');
      g.save();g.beginPath();g.rect(R.x,R.y,R.w,R.h);g.clip();g.textBaseline='alphabetic';g.lineJoin='round';
      const fit=(text,y,fs,weight,col)=>{g.font=`${weight} ${fs}px ${DISPLAY}`;const tw=g.measureText(text).width;if(tw>R.w*0.9){fs*=R.w*0.9/tw;g.font=`${weight} ${fs}px ${DISPLAY}`;}g.fillStyle=col;g.textAlign='center';g.fillText(text,R.x+R.w/2,y);};
      if(line&&words.length){
        const Lo=lyricLayout(g,words,line,R),fs=Lo.fs;g.font=`700 ${fs}px ${DISPLAY}`;g.textAlign='left';
        for(const tk of Lo.tokens){const wd=words[tk.i];if(!wd)continue;
          if(wd.state==='sung'){g.fillStyle=WARM;g.fillText(tk.text,tk.x,tk.y);}
          else if(wd.state==='now'){const p=clamp((t-wd.start)/Math.max(0.05,wd.end-wd.start),0,1);g.fillStyle=LAV;g.fillText(tk.text,tk.x,tk.y);
            g.save();g.beginPath();g.rect(tk.x-fs*0.1,tk.y-fs*1.2,(tk.w+fs*0.2)*p,fs*1.6);g.clip();g.strokeStyle='rgba(255,63,164,0.55)';g.lineWidth=fs*0.14;g.strokeText(tk.text,tk.x,tk.y);g.fillStyle='#ffffff';g.fillText(tk.text,tk.x,tk.y);g.restore();}
          else{g.fillStyle=LAV;g.fillText(tk.text,tk.x,tk.y);}}
        if(Lo.rows===1&&ly.next?.text)fit(dehyph(ly.next.text),R.y+R.h*0.84,Lo.fs0*0.4,500,'#8f82ad');
      }else if(line?.text)fit(dehyph(line.text),R.y+R.h*0.5+R.h*0.12,R.h*0.34,700,WARM);
      else if(soon){fit(dehyph(ly.next.text),R.y+R.h*0.5+R.h*0.08,R.h*0.26,500,LAV);
        const p=clamp(1-ly.next.in/6,0,1),bw=R.w*0.16,bh=Math.max(2,R.h*0.03);g.fillStyle='rgba(185,169,214,0.25)';g.fillRect(R.x+R.w/2-bw/2,R.y+R.h*0.78,bw,bh);g.fillStyle=CYAN;g.fillRect(R.x+R.w/2-bw/2,R.y+R.h*0.78,bw*p,bh);}
      g.restore();
    }
    function chromeTitle(g,t){
      if(t>7.6)return false;ensureTitle();if(!art.title)return false;
      const a=ease((t-0.15)/0.7)*(1-ease((t-6)/1.5));if(a<=0.01)return t<7.6;
      const s=1.12-0.12*ease((t-0.15)/1.3),W=art.tW*s,H=art.tH*s,X=L.cx-W/2,Y=L.top+L.M*0.3-H*0.55;
      let img=art.title;const gp=(t-1.4)/0.9;
      if(gp>0&&gp<1){const x=art.glint.getContext('2d'),GW=art.glint.width,GH=art.glint.height;x.setTransform(1,0,0,1,0,0);x.globalCompositeOperation='copy';x.drawImage(art.title,0,0);x.globalCompositeOperation='source-atop';
        const cx=-GW*0.3+gp*GW*1.6,gr=x.createLinearGradient(cx-GH*0.6,0,cx+GH*0.6,GH);gr.addColorStop(0,'rgba(255,255,255,0)');gr.addColorStop(0.5,'rgba(255,255,255,0.9)');gr.addColorStop(1,'rgba(255,255,255,0)');
        x.fillStyle=gr;x.fillRect(0,0,GW,GH);x.globalCompositeOperation='source-over';img=art.glint;}
      g.globalAlpha=a;g.drawImage(img,X,Y,W,H);g.globalAlpha=1;return true;
    }
    function stageCard(g,seg,t){
      if(!seg.changed)return;const d=t-seg.start;if(d<0||d>2.6)return;const a=ease(d/0.35)*(1-ease((d-2.0)/0.6)),u=L.u,y=L.top+L.M*0.13;
      g.globalAlpha=a;g.textAlign='center';g.textBaseline='alphabetic';g.lineJoin='round';
      g.font=`700 ${u*0.022}px ${MONO}`;g.fillStyle=WARM;g.strokeStyle=INK;g.lineWidth=u*0.008;const st='STAGE '+String(seg.stage).padStart(2,'0');g.strokeText(st,L.cx,y);g.fillText(st,L.cx,y);
      const nm=STAGES[seg.scene].name;g.font=`800 ${u*0.06}px ${DISPLAY}`;g.lineWidth=u*0.014;g.strokeText(nm,L.cx,y+u*0.065);
      g.fillStyle='rgba(255,63,164,0.6)';g.fillText(nm,L.cx-1.5,y+u*0.065);g.fillStyle='rgba(0,229,255,0.6)';g.fillText(nm,L.cx+1.5,y+u*0.065);g.fillStyle='#f4f0ff';g.fillText(nm,L.cx,y+u*0.065);
      g.globalAlpha=1;
    }

    // ---------- tape pass
    function post(g,fi,calm,band){
      const BW=B.width,BH=B.height,u=L.u;
      if(band!=null){const bh=u*0.03,Y=L.top+band*(L.bot-L.top-bh),dx=(hsh(fi,22)-0.5)*u*0.035,y0=Math.round(Y*sc),hh=Math.max(1,Math.round(bh*sc));
        c.save();c.setTransform(1,0,0,1,0,0);c.drawImage(B,0,y0,BW,hh,Math.round(dx*sc),y0,BW,hh);
        c.fillStyle='rgba(255,255,255,0.07)';c.fillRect(0,y0,BW,hh);c.fillStyle='rgba(255,255,255,0.5)';
        for(let i=0;i<12;i++)c.fillRect(hsh(fi,40+i)*BW,y0+hsh(fi,60+i)*hh,hsh(fi,80+i)*BW*0.08,1);c.restore();}
      for(const [tc,col] of [[t1,'#ff0000'],[t2,'#00ffff']]){tc.setTransform(1,0,0,1,0,0);tc.globalAlpha=1;tc.globalCompositeOperation='copy';tc.drawImage(B,0,0);tc.globalCompositeOperation='multiply';tc.fillStyle=col;tc.fillRect(0,0,BW,BH);tc.globalCompositeOperation='source-over';}
      const wx=(hsh(fi,1)-0.5)*(calm?0.6:1.8),wy=(hsh(fi,2)-0.5)*(calm?0.4:1.0),sh=2+hsh(fi,3);
      g.globalCompositeOperation='source-over';g.globalAlpha=1;g.fillStyle=INK;g.fillRect(0,0,w,h);
      g.drawImage(T2,wx-2,wy-2,w+4,h+4);g.globalCompositeOperation='lighter';g.drawImage(T1,wx-2+sh,wy-2,w+4,h+4);g.globalCompositeOperation='source-over';
      if(!calm){g.fillStyle=`rgba(0,0,0,${hsh(fi,11)*0.05})`;g.fillRect(0,0,w,h);}
      g.drawImage(scan,0,0,w,h);
      if(!pats)pats=noise.map(n=>g.createPattern(n,'repeat'));
      const pt=pats[Math.floor(hsh(fi,5)*4)%4];
      if(pt){if(pt.setTransform)pt.setTransform(new DOMMatrix([1,0,0,1,Math.floor(hsh(fi,6)*128),Math.floor(hsh(fi,7)*128)]));g.globalAlpha=calm?0.035:0.06;g.fillStyle=pt;g.fillRect(0,0,w,h);g.globalAlpha=1;}
    }

    return {
      resize(nw,nh){w=nw;h=nh;layKey='';},
      draw(g,frame,env){
        w=env.w;h=env.h;if(!w||!h)return;
        const wall=env.wall||0,calm=!!env.calm,dt=env.dt||1/60,t=frame.time||0,tr=frame.tracks||{},ev=env.events||{},playing=!!frame.playing;
        ensureInfo(env.song);ensureLayout(env,g);
        const u=L.u,jumped=lastT==null||t<lastT-0.02||t-lastT>0.5;
        if(jumped){bolts.length=0;flares.length=0;}
        V.t=t;V.wall=wall;V.Dt=info.dist(t);V.speed=(info.dist(t+0.05)-info.dist(t-0.05))/0.1;V.beat=frame.beat?.beat||0;
        const seg=info.segAt(t),tp=seg.changed?clamp((t-seg.start)/0.9,0,1):1,tpE=ease(tp);
        const wt=s=>s===seg.scene?(tp<1?tpE:1):(tp<1&&s===seg.from?1-tpE:0);
        // smoothing + reactions
        const sm=(v,x,r)=>v+((x??0)-v)*Math.min(1,dt*r);
        bassS=sm(bassS,tr.bass?.level,10);vocS=sm(vocS,tr.vocals?.level,8);leadS=sm(leadS,tr.lead?.level,8);otherS=sm(otherS,tr.other?.level,3);
        const dec=r=>Math.exp(-dt*r);thrust*=dec(7);gridPulse*=dec(5);shake*=dec(14);for(let i=0;i<12;i++)pcFlash[i]*=dec(2.6);
        const br=tr.drums?.brightness??0.5;
        for(const s of ev.hits?.drums||[]){const kick=br<0.45||s>=info.thr;if(kick)thrust=Math.max(thrust,0.4+0.6*s);if((seg.scene==='hyper'||seg.scene==='solo')&&!calm&&(kick||s>=info.thr))shake=Math.max(shake,u*(s>=info.thr?0.012:0.007)*s*(seg.scene==='solo'?0.6:1));}
        if(!jumped&&playing&&!calm)for(let q=after(info.K,lastT);q<info.K.length&&info.K[q].t<=t;q++)if(!info.K[q].survivor)shake=Math.max(shake,u*0.007);
        if(!tr.drums&&ev.beat)thrust=Math.max(thrust,ev.beat.downbeat?0.9:0.5);
        if(ev.beat){if(ev.beat.downbeat)gridPulse=1;
          if((seg.scene==='hyper'||seg.scene==='ufo'||seg.scene==='solo')&&tp>0.5){const sp=shipAt(t);for(const sd of [-1,1])if(bolts.length<40)bolts.push({x:sp.x+sd*0.95,y:sp.y+0.12,z:SZ,col:seg.scene==='ufo'?'pink':seg.scene==='solo'?'warm':'cyan'});}}
        for(const s of ev.hits?.piano||[])if(comets.length<(calm?4:16)){const a=Math.PI*(0.15+Math.random()*0.15)*(Math.random()<0.5?1:-1);comets.push({x:w*(0.1+Math.random()*0.8),y:L.top*0.4+Math.random()*(L.hy-L.top*0.4)*0.7,vx:Math.sin(a)*u*1.2,vy:Math.cos(a)*u*0.5,age:0,max:0.5+s*0.3});}
        if(!jumped&&playing){const N=info.N;for(let i=after(N,lastT);i<N.length&&N[i].start<=t;i++){const n=N[i];pcFlash[n.pc]=1;pcCol[n.pc]=n.col;if(flares.length<24)flares.push({age:0,col:n.col,big:0});}}
        if(ev.chordChanged&&flares.length<24)flares.push({age:0,col:kindOf(frame.chord?.label),big:1});
        const label=noChord(frame.chord?.label)?null:frame.chord.label;
        if(label!==chordCur){chordPrev=chordCur===undefined?null:chordCur;chordCur=label;chordWall=(jumped||!playing)?wall-1:wall;}
        lastT=t;
        // ship + camera from the melody
        const base=basePos(info,t),sp=shipAt(t),vx=(basePos(info,t+0.06).x-basePos(info,t-0.06).x)/0.12;
        V.camX=base.x*0.5;V.camY=3.2+(base.y-3.2)*0.5;const bob=Math.sin(wall*1.7)*0.06;
        const ang=clamp(vx*0.07,-0.6,0.6)+sp.roll;
        const sd0=t-seg.start,sb=seg.changed&&sd0>=0&&sd0<1.8?ease(sd0/0.35)*(1-ease((sd0-0.45)/1.3)):0;
        const fast=seg.scene==='hyper'||seg.scene==='solo',surge=fast?7*sb:seg.scene==='atmo'?-3.2*sb:0,bloom=fast?sb*(calm?0.4:1):0,dim=seg.scene==='atmo'?sb:0;
        V.surge=surge;V.ship=sp;
        // ---------- scene buffer
        c.setTransform(sc,0,0,sc,0,0);c.globalAlpha=1;c.globalCompositeOperation='source-over';
        const fi=playing?Math.floor(t*60):Math.floor(wall*60);
        if(!playing)shake=0;if(shake>0.2){const f3=fi/3,a0=Math.floor(f3),fr3=ease(f3-a0),jx=lerp(hsh(a0,30),hsh(a0+1,30),fr3)-0.5,jy=lerp(hsh(a0,31),hsh(a0+1,31),fr3)-0.5;c.translate(jx*shake*1.6,jy*shake*1.6);}
        if(tp<1&&seg.from){BG[seg.from](c);t1.setTransform(sc,0,0,sc,0,0);t1.globalAlpha=1;t1.globalCompositeOperation='source-over';BG[seg.scene](t1);
          c.save();c.setTransform(1,0,0,1,0,0);c.globalAlpha=tpE;c.drawImage(T1,0,0);c.restore();}
        else BG[seg.scene](c);
        constellation(c);
        collect();
        let i=0;for(;i<list.length&&list[i].z>=SZ;i++)drawItem(c,list[i]);
        // lasers
        c.lineCap='round';c.globalCompositeOperation='lighter';
        for(let j=bolts.length-1;j>=0;j--){const b=bolts[j];b.z+=150*dt;if(b.z>FAR){bolts[j]=bolts[bolts.length-1];bolts.pop();continue;}
          if(!P(b.x,b.y,b.z))continue;const X0=px,Y0=py,k0=pk;P(b.x,b.y,b.z+4);c.strokeStyle=rgba(RGB[b.col],0.35);c.lineWidth=Math.max(2,k0*0.35);c.beginPath();c.moveTo(X0,Y0);c.lineTo(px,py);c.stroke();
          c.strokeStyle='#ffffff';c.lineWidth=Math.max(1,k0*0.1);c.stroke();}
        c.globalCompositeOperation='source-over';c.lineCap='butt';
        drawTrails(c,ang);
        const heat=seg.scene==='atmo'?clamp(1-(t-seg.start)/3,0,1)*wt('atmo'):0;
        if(P(sp.x,sp.y+bob,SZ+surge)){const sx=px,sy=py,sk=pk;
          if(heat>0.01){c.globalCompositeOperation='lighter';c.lineCap='round';
            for(let q=0;q<18;q++){const an=hsh(q,3)*TAU,rr=((t*1.7+hsh(q,4))%1),r0=sk*(1.1+rr*2.2);c.strokeStyle=`rgba(255,${q%2?209:120},${q%2?102:90},${heat*(1-rr)*0.8})`;c.lineWidth=Math.max(1,sk*0.06);
              c.beginPath();c.moveTo(sx+Math.cos(an)*r0,sy+Math.sin(an)*r0*0.7);c.lineTo(sx+Math.cos(an)*(r0+sk*0.6),sy+Math.sin(an)*(r0+sk*0.6)*0.7);c.stroke();}
            c.globalCompositeOperation='source-over';c.lineCap='butt';}
          drawShip(c,sx,sy,sk,ang,heat,bloom,dim);
          // note and chord pass flares
          c.globalCompositeOperation='lighter';
          for(let j=flares.length-1;j>=0;j--){const f=flares[j];f.age+=dt;const life=f.big?0.6:0.4;if(f.age>life){flares.splice(j,1);continue;}const q=f.age/life,col=RGB[f.col]||RGB.white;
            c.strokeStyle=rgba(col,(1-q)*(f.big?0.8:0.6));c.lineWidth=Math.max(1,sk*(f.big?0.12:0.07));c.beginPath();c.ellipse(sx,sy,sk*(0.9+q*(f.big?4:1.6)),sk*(0.6+q*(f.big?2.6:1.1)),0,0,TAU);c.stroke();}
          c.globalCompositeOperation='source-over';}
        for(;i<list.length;i++)drawItem(c,list[i]);
        // shooting stars (piano), in the sky
        c.lineCap='round';
        for(let j=comets.length-1;j>=0;j--){const m=comets[j];m.age+=dt;if(m.age>m.max){comets.splice(j,1);continue;}m.x+=m.vx*dt;m.y+=m.vy*dt;const a=1-m.age/m.max;
          if(m.y>L.hy)continue;c.strokeStyle=`rgba(255,240,210,${a})`;c.lineWidth=1.5;c.beginPath();c.moveTo(m.x,m.y);c.lineTo(m.x-m.vx*0.06,m.y-m.vy*0.06);c.stroke();}
        c.lineCap='butt';
        if(heat>0.01){c.globalAlpha=heat*(calm?0.06:0.18);c.fillStyle=WARM;c.fillRect(0,0,w,L.hy);c.globalAlpha=1;}
        // ---------- tape pass into the real canvas
        let band=null;
        if(!calm){const per=300,win=Math.floor(fi/per),ph=fi-win*per,st=Math.floor(hsh(win,21)*(per-60));if(hsh(win,20)<0.4&&ph>=st&&ph<st+45)band=(ph-st)/45;if(seg.changed&&tp<1)band=tp;}
        // ---------- title moment, stage card, HUD (inside the tape image)
        c.setTransform(sc,0,0,sc,0,0);c.globalAlpha=1;c.globalCompositeOperation='source-over';
        const titled=chromeTitle(c,t);
        if(!titled)stageCard(c,seg,t);
        const PW=hudChord(c,frame,wall,calm);
        hudSide(c,frame,PW,seg);
        hudAlt(c,frame,dt);
        if(env.lyrics!==false)hudLyrics(c,frame,t);
        post(g,fi,calm,band);
      },
      dispose(){B=c=T1=t1=T2=t2=scan=null;art=null;bolts.length=flares.length=comets.length=0;},
    };
  },
};
