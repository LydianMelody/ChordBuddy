// Starlane Stage: Starlane remapped onto the stage screens of a VRChat charity show. The show's projection map is a 1024 x 1024 square
// that OBS stretches across a 16:9 canvas and the world squishes back, so this draws the square map stretched over the whole window
// on purpose (circles look wide here and round in the world).
//   Sun dome          -> the Starlane flight: the ship, its rings, a stage per kind of song section, the song title at the start.
//                        The dome is already a sun, so the sunset stage has a crescent moon instead of Starlane's striped sun.
//   Stripes 2-5       -> the ground of the same world, seen through the slats (grid, track, mountains, beacons on rhythm strums).
//   Stripe 1          -> the lyric line in chunky pixel letters, scrolling with the singer: sung words warm, the current word wiped white.
//   Triangle 4        -> the song section: its name big, the stage, the next section with its countdown and a bar filling toward it.
//                        In the invasion and the dogfight it turns into an enemy ship with a glowing eye: on the bar, a glow runs along
//                        its two long edges to the tip that points at the dome, a laser fires at the ship (which always dodges) and the
//                        recoil washes back across it. When the stage ends the ship shoots it and it bursts into pixels, then reboots.
//   Triangle 6        -> the chord and the next one, with a bar counting down to the change.
//   Triangle 1        -> the bar number and the beat pips; the screen flashes in the chord's color on every downbeat.
//   Triangle 2        -> seven stem meters: bass, drums, other, vocals, piano, lead and rhythm, each flicking white on its hits.
//   Triangle 5        -> the song title, the time and how far through the song it is.
//   Triangle 3        -> (mostly hidden from the audience) a glow with the bass in the chord's color.
//   All triangles     -> a light sweeps across them, left to right, at each new section; their edges light up in turn on the first
//                        downbeat of every four bars; in hyperdrive, speed lines stream out of the dome across them.
//   Stage color dot   -> lights the sides of every screen in the world: the chord's color, gliding between chords, brighter for a moment
//                        at each new section and a touch on downbeats (not in calm mode). Always one solid color, never a picture.
//   Vocal MIDI        -> the ship's flight path only: a ring (star, diamond...) for every sung note, the ship climbing for high notes
//                        and diving for low ones.
//   Instrumental MIDI -> the pitch stars only: a row of stars across the sky, one per semitone from the song's lowest instrumental note
//                        (left) to its highest (right), at fixed random heights. Each lights while its note sounds, and a line streaks
//                        from the last star to the new one: warm when the tune climbs, cyan when it falls.
//   Melody MIDI       -> not used: it is the two above merged, so it would show every note twice.
//   Drums -> engine flares, camera shake in the fast stages.   Bass -> moon swell, triangle 3.   Vocals -> warm glow.
//   Lead -> wingtip trails.   Rhythm -> beacons.   Piano -> shooting stars.   Other -> nebula haze.   All seven -> triangle 2's meters.
// Lining it up: set TEST_CARD to true below and save. Every screen then shows its number, an UP arrow and the letter F (it reads
// backward on a mirrored screen). Turn a triangle's content with its `up` angle in TRI; mirror it with flip:true.
// Post pass on the sun (from Starlane): chroma shift, gate weave, flicker, scanlines, tape noise. Calm mode: no shake, flicker or flashes.
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

// ---------- the stage map (map pixels, measured from the show's 1024 x 1024 template)
const TEST_CARD=false;   // true: draw the alignment test card instead of the show
// where the enemy's shots in the dome come from, measured from the dome's center against triangle 4's tip on the map:
// FOE_TURN degrees clockwise (down toward the right horizon), FOE_DIST times as far out. Tuned by eye in the world.
const FOE_TURN=43,FOE_DIST=0.75;
const MAPW=1024,SUN={x:515,y:494,r:332},BOX=SUN.r*2,BOX_X=SUN.x-SUN.r,BOX_Y=SUN.y-SUN.r,HZ=500,CAMY=1.2;
const BANDS=[[150,500],[521,565],[587,628],[651,692],[715,758],[778,829]];   // the dome, then stripes 1-5 (3 px of bleed on each edge)
const LYR=[524,562],DOT={x:511.5,y:510.5,r:14};
// a triangle's own frame (R = its right, D = its down, around the centroid), the largest rectangle of its aspect that fits inside
// that frame, and its outline pushed out 5 px so the content bleeds past the mapped edge
function prepTri(T){
  const cx=(T.pts[0][0]+T.pts[1][0]+T.pts[2][0])/3,cy=(T.pts[0][1]+T.pts[1][1]+T.pts[2][1])/3,a=T.up*Math.PI/180,U=[Math.cos(a),Math.sin(a)];
  const R=T.flip?[U[1],-U[0]]:[-U[1],U[0]],D=[-U[0],-U[1]];
  const loc=T.pts.map(p=>[(p[0]-cx)*R[0]+(p[1]-cy)*R[1],(p[0]-cx)*D[0]+(p[1]-cy)*D[1]]);
  const inside=(x,y)=>{let s=0;for(let i=0;i<3;i++){const A=loc[i],B=loc[(i+1)%3],q=(B[0]-A[0])*(y-A[1])-(B[1]-A[1])*(x-A[0]);if(q>0)s|=1;else if(q<0)s|=2;}return s!==3;};
  const xs=loc.map(p=>p[0]),ys=loc.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  let best={x:0,y:0,h:0};
  for(let i=1;i<40;i++)for(let j=1;j<40;j++){const X=x0+(x1-x0)*i/40,Y=y0+(y1-y0)*j/40;if(!inside(X,Y))continue;let lo=0,hi=y1-y0;
    for(let k=0;k<18;k++){const m=(lo+hi)/2,hx=m*T.asp;if(inside(X-hx,Y-m)&&inside(X+hx,Y-m)&&inside(X-hx,Y+m)&&inside(X+hx,Y+m))lo=m;else hi=m;}
    if(lo>best.h)best={x:X,y:Y,h:lo};}
  const hh=best.h*0.86,rect={x:best.x-hh*T.asp,y:best.y-hh,w:2*hh*T.asp,h:2*hh};
  const bleed=T.pts.map(p=>{const dx=p[0]-cx,dy=p[1]-cy,l=Math.hypot(dx,dy)||1;return [p[0]+dx/l*5,p[1]+dy/l*5];});
  return {...T,c:[cx,cy],R,D,rect,bleed};
}
// up: the direction (degrees: 0 = right, 90 = down) that is "up" on that screen in the world, read from the show's annotated template
const TRI=[
  {id:1,pts:[[4,4],[273,6],[9,160]],up:-90,flip:false,asp:2.0},
  {id:2,pts:[[309,9],[314,184],[16,180]],up:30,flip:false,asp:1.6,streakTurn:30,fromDome:true,domeFlip:true},   // tuned by eye in the world
  {id:3,pts:[[6,216],[149,196],[16,504]],up:-140,flip:false,asp:1.3},
  {id:4,pts:[[696,9],[1011,8],[1012,166]],up:-34,flip:false,asp:1.7,streakTurn:-40,fromDome:true},   // tuned by eye in the world
  {id:5,pts:[[706,28],[981,175],[847,265]],up:115,flip:false,asp:1.5,streakTurn:25},   // tuned by eye in the world
  {id:6,pts:[[806,275],[1013,277],[1004,596]],up:17,flip:false,asp:2.0,fromDome:true,domeFlip:true},   // tuned by eye in the world
].map(prepTri);
const hsl2rgb=(H,S,Lg)=>{const f=n=>{const k=(n+H/30)%12,a=S*Math.min(Lg,1-Lg);return 255*(Lg-a*Math.max(-1,Math.min(k-3,9-k,1)));};return [f(0),f(8),f(4)];};

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

// notes: the melody wired to Melody rings (the patch bay's whole list for it), or null without a patch bay: then the song's own melodies
function prep(song,notes=null){
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
  let src=notes?notes.slice():voc.slice();   // the stage version flies the sung melody only (the instrumental lights the pitch stars)
  // in time order, a chord's notes low to high; the same note twice (two melodies that share it) is drawn once
  let N=src.filter(x=>x&&x.end>x.start&&isFinite(x.pitch)).map(x=>({start:x.start,end:x.end,pitch:x.pitch,str:x.strength??1})).sort((a,b)=>a.start-b.start||a.pitch-b.pitch);
  N=N.filter((x,i)=>!N.slice(Math.max(0,i-4),i).some(y=>y.pitch===x.pitch&&Math.abs(y.start-x.start)<0.02));
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
    x.vox=true;x.col=x.home?'warm':x.vox?'pink':'cyan';maxDur=Math.max(maxDur,x.end-x.start);
  }
  const kind=l=>{const r=pcOf(l),cc=chordColor(l);if(r!=null&&r===keyRoot&&!!cc.minor===keyMinor)return 'warm';return cc.minor?'pink':'cyan';};
  const G=(song?.chords||[]).filter(c=>!noChord(c.label)).map(c=>({t:c.start,s:dist(c.start),label:c.label,col:kind(c.label)}));
  const bars=(song?.bars||[]).slice().sort((a,b)=>a.start-b.start),BT=[];
  bars.forEach((b,bi)=>{const len=b.end?b.end-b.start:(bars[bi+1]?bars[bi+1].start-b.start:0),bs=b.beats&&b.beats.length?b.beats:len>0&&len<6?[0,1,2,3].map(q=>b.start+q*len/4):[b.start];bs.forEach((t,i)=>BT.push({t,s:dist(t),down:i===0,i:BT.length,scene:segAt(t).scene}));});
  const RH=[];let lastR=-9;
  for(const x of (song?.features?.tracks?.rhythm?.hits||[]).slice().sort((a,b)=>a.start-b.start))if(x.start-lastR>0.09){RH.push({t:x.start,s:dist(x.start),str:x.strength??0.6,side:RH.length%2,scene:segAt(x.start).scene});lastR=x.start;}
  const dh=(song?.features?.tracks?.drums?.hits||[]).map(x=>x.strength||0).sort((a,b)=>a-b),thr=dh.length?Math.max(0.2,dh[Math.floor(dh.length*0.7)]):0.8;
  // S: the wired melody untrimmed, in time order (a chord low to high), for the pitch gauge
  const S=notes?notes.filter(x=>x&&x.end>x.start&&isFinite(x.pitch)).sort((a,b)=>a.start-b.start||a.pitch-b.pitch):null;
  const info={segs,segAt,dist,N,S,lo,hi,keyRoot,flats,maxDur:Math.min(8,maxDur),G,BT,RH,thr,A:[]};
  bars.forEach((b,i)=>{
    const len=b.end?b.end-b.start:(bars[i+1]?bars[i+1].start-b.start:2),sg=segAt(b.start);if(sg.scene!=='ufo'&&sg.scene!=='solo')return;
    const rel=Math.round((b.start-sg.start)/Math.max(0.3,len));if(rel%2!==1)return;   // every other bar from the 2nd: one bar charging, then the shot
    const p=basePos(info,b.start);info.A.push({t:b.start,s:dist(b.start),warn:clamp(len,0.8,2.2),x:p.x,y:p.y,dir:p.x>0.3?-1:p.x<-0.3?1:(info.A.length%2?1:-1),ufo:info.A.length%3});
  });
  info.K=killPlan(song,segs,BT);
  // when triangle 4 is an enemy: the invasion and dogfight stages, back to back ones merged
  info.E=[];segs.forEach((s,i)=>{if(s.scene!=='ufo'&&s.scene!=='solo')return;const end=segs[i+1]?segs[i+1].start:dur,last=info.E[info.E.length-1];
    if(last&&Math.abs(last.end-s.start)<0.05)last.end=end;else info.E.push({start:s.start,end});});
  info.A=info.A.filter(a=>!info.E.some(e=>a.t>e.end-1.2&&a.t<e.end+0.2));   // no shot as the stage ends: that moment is the ship's
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
// the note the pitch gauge shows at t: of those sounding, the last to start (the highest of a chord), as the melody's own notes are listed
function soundingAt(S,t){
  let a=0,b=S.length-1,i=-1;while(a<=b){const m=(a+b)>>1;if(S[m].start<=t){i=m;a=m+1;}else b=m-1;}
  for(let k=i;k>=0&&k>i-64;k--)if(t<S[k].end)return S[k];
  return null;
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
  id:'starlane-stage',
  name:'Starlane Stage',
  order:46,
  hud:false,   // the chord is on triangle 6 and the lyrics on the first stripe
  inputs:{
    engines:{label:'Engine flare',type:'trigger',default:'stem/drums/hit',help:'Flares the ship’s engines on strong hits (and shakes the camera in hyperdrive)'},
    stars:{label:'Shooting stars',type:'trigger',default:'stem/piano/hit',help:'Sends a shooting star across the sky'},
    grid:{label:'Grid pulse',type:'trigger',default:'song/downbeat',help:'Makes the ground grid glow'},
    lasers:{label:'Lasers',type:'trigger',default:'song/beat',help:'Fires the ship’s lasers (in hyperdrive, the invasion and the dogfight)'},
    chordFlare:{label:'Ring flare',type:'trigger',default:'song/chord',help:'Sends a big ring out around the ship'},
    rings:{label:'Melody rings',type:'notes',default:'melody/vocal/notes',help:'The notes the ship flies through (rings, arrows, diamonds or stars, by stage) and the path it follows'},
    pitchStars:{label:'Pitch stars',type:'notes',default:'melody/instrumental/notes',help:'The melody that lights the row of stars in the sky, one star per note from low (left) to high (right)'},
    sideLift:{label:'Side flash',type:'trigger',default:'song/section',help:'Brightens the color on the sides of every screen for a moment'},
    sun:{label:'Moon size',type:'amount',default:'stem/bass/level',help:'How big the crescent moon swells in the sunset stage'},
    glow:{label:'Warm glow',type:'amount',default:'stem/vocals/level',help:'The moon’s brightness and the warm light around the ship'},
    trails:{label:'Wingtip trails',type:'amount',default:'stem/lead/level',help:'How bright and wide the trails behind the wings are'},
    haze:{label:'Nebula haze',type:'amount',default:'stem/other/level',help:'How thick the nebula haze is'},
  },
  // the picker and mixer as cockpit consoles: night-sky panels with cyan neon edges, a hot-pink shadow, scanlines and spaced capitals
  skin:{paper:INK,ink:'#f4f0ff',desk:'#1a1430',tint:'#2a2145',soft:LAV,line:CYAN,shadowColor:PINK,active:PINK,highlight:WARM,
    accent1:PINK,accent2:'#4a3a8a',accent3:CYAN,font:MONO,mono:MONO,border:2,shadow:4,glow:12,corners:3,texture:'scanlines',caps:true,tracking:0.08},
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

    let ringsRef=null;
    function ensureInfo(song,rings){
      const key=(song?.title||'')+'|'+(song?.duration||0)+'|'+Object.entries(song?.midi||{}).map(([a,b])=>a+(b?.notes?.length||0)).join(',')+'|'+(song?.features?.tracks?Object.keys(song.features.tracks).length:0)+'|'+(song?.sections?.length||0);
      if(song===songRef&&key===infoKey&&info&&rings===ringsRef)return;
      songRef=song;infoKey=key;ringsRef=rings;info=prep(song,rings);bolts.length=flares.length=comets.length=0;lyr={key:''};if(art)art.titleKey='';
    }
    let SC=null,sg=null,LB=null,lb=null,W0=0,H0=0;
    // the sun is drawn as its own square picture (w x h here), then laid into the map
    function ensureLayout(){
      const key=String(w);if(key===layKey)return;layKey=key;k=1;
      L={u:w,top:w*0.06,bot:w,M:w*0.94,cx:w/2,hy:(HZ-BOX_Y)/BOX*w,F:w*0.9};
      sc=Math.min(1,1600/w);const BW=Math.max(1,Math.round(w*sc)),BH=Math.max(1,Math.round(h*sc));
      B=mk(BW,BH);c=B.getContext('2d');T1=mk(BW,BH);t1=T1.getContext('2d');T2=mk(BW,BH);t2=T2.getContext('2d');
      SC=mk(w,h);sg=SC.getContext('2d');
      if(!LB){LB=mk(LW,LH);lb=LB.getContext('2d',{willReadFrequently:true});}
      PS.key='';
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
      // the crescent moon: the dark side faint, the lit side a pale gradient with soft craters, cut by an offset disc, a bright rim
      {const D=u*0.34,R=D/2,[cv,x]=off(D,D),[cv2,y]=off(D,D);
        x.fillStyle='rgba(120,100,200,0.08)';x.beginPath();x.arc(R,R,R*0.985,0,TAU);x.fill();
        const gr=y.createLinearGradient(0,D,D*0.6,0);gr.addColorStop(0,PINK);gr.addColorStop(0.35,'#ffb3d9');gr.addColorStop(0.75,'#fff0f6');gr.addColorStop(1,'#ffffff');
        y.fillStyle=gr;y.beginPath();y.arc(R,R,R,0,TAU);y.fill();
        const r=rng(9);y.fillStyle='rgba(185,120,200,0.28)';for(let i=0;i<9;i++){const a=r()*TAU,d=r()*R*0.8,s=R*(0.05+r()*0.1);y.beginPath();y.arc(R+Math.cos(a)*d,R+Math.sin(a)*d,s,0,TAU);y.fill();}
        y.globalCompositeOperation='destination-out';y.fillStyle='#000';y.beginPath();y.arc(R+R*0.5,R-R*0.3,R*0.97,0,TAU);y.fill();
        y.globalCompositeOperation='source-atop';y.strokeStyle='rgba(255,255,255,0.9)';y.lineWidth=R*0.03;y.beginPath();y.arc(R,R,R*0.985,0,TAU);y.stroke();
        x.drawImage(cv2,0,0,D,D);art.sun=cv;art.sunD=D;}
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
      const tmp=mk(4,4).getContext('2d');let fs=L.M*0.15;tmp.font=`800 ${fs}px ${DISPLAY}`;let tw=tmp.measureText(title).width;
      if(tw>w*0.6){fs*=w*0.6/tw;tw=w*0.6;}
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
      const D=art.sunD*(1+0.08*bassS),sx=L.cx-w*0.2-V.camX*L.u*0.004,sy=L.hy-D*0.7;   // off to the left, clear of the ship
      x.globalAlpha=0.25+0.45*vocS;const gs=D*2.2;x.drawImage(glow.pink,sx-gs/2,sy-gs/2,gs,gs);x.globalAlpha=1;x.globalCompositeOperation='source-over';
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
    let parX=0,parY=0,eS=0,ePk=0.05;
    // low-poly 3D ship: x right, y up, z forward (nose away from camera). Yaw/pitch come from screen position + turning; roll stays a canvas rotate.
    const SV={N:[0,0,2.1],C:[0,0.23,0.7],RT:[0,0.2,0],RL:[-0.3,0,0],RR:[0.3,0,0],RB:[0,-0.15,0],ML:[-0.24,0,1.0],MR:[0.24,0,1.0],MB:[0,-0.1,1.0],
      WL:[-1.05,-0.03,0.2],WR:[1.05,-0.03,0.2],WLb:[-0.92,-0.03,-0.12],WRb:[0.92,-0.03,-0.12],FT:[0,0.68,-0.06],FF:[0,0.22,0.5]};
    const SF=[
      ['N','C','ML','g'],['N','MR','C','g'],['C','RL','ML','h'],['C','RT','RL','h'],['C','MR','RR','h'],['C','RR','RT','h'],
      ['N','ML','MB','h'],['N','MB','MR','h'],['ML','RL','MB','h'],['RL','RB','MB','h'],['MR','MB','RR','h'],['RR','MB','RB','h'],
      ['RL','RT','RR','r'],['RL','RR','RB','r'],
      ['WL','ML','RL','w'],['WL','RL','WLb','w'],['WR','RR','MR','w'],['WR','WRb','RR','w'],['FT','FF','RT','f']];
    const SHC=[0,0.03,0.7],LIT=(()=>{const v=[0.35,0.85,-0.45],m=Math.hypot(...v);return v.map(q=>q/m);})();
    const mixc=(a,b,t)=>`rgb(${a.map((q,i)=>Math.round(q+(b[i]-q)*t)).join(',')})`;
    const PAL={h:[[30,22,52],[214,204,248]],w:[[36,26,62],[190,176,236]],r:[[22,15,36],[120,104,170]],g:[[0,60,90],[120,245,255]],f:[[40,30,72],[170,160,220]]};
    function drawShip(x,X,Y,s,ang,heat,bloom=0,dim=0,yaw=0,pitch=0.15){
      x.save();x.translate(X,Y);x.rotate(ang);x.scale(s,s);const lw=1/s;
      if(vocS>0.05||heat>0.01){x.globalCompositeOperation='lighter';x.globalAlpha=Math.min(1,0.25*vocS+heat*0.8);x.drawImage(glow.warm,-2.2,-1.6,4.4,3.2);x.globalAlpha=1;x.globalCompositeOperation='source-over';}
      const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
      const rot=v=>{const x1=v[0]*cy+v[2]*sy,z1=-v[0]*sy+v[2]*cy,y2=v[1]*cp+z1*sp,z2=-v[1]*sp+z1*cp;return [x1,y2,z2];};
      const R={},Pj={};for(const k in SV){const r=rot(SV[k]);R[k]=r;const f=1/(1+Math.max(-0.5,r[2])*0.1);Pj[k]=[r[0]*f,-r[1]*f+0.06];}
      const hc=rot(SHC),faces=[];
      for(const F of SF){const A=R[F[0]],B=R[F[1]],C=R[F[2]],t=F[3];
        const u=[B[0]-A[0],B[1]-A[1],B[2]-A[2]],v=[C[0]-A[0],C[1]-A[1],C[2]-A[2]];let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
        const m=Math.hypot(...n)||1;n=n.map(q=>q/m);const cz=(A[2]+B[2]+C[2])/3,ctr=[(A[0]+B[0]+C[0])/3,(A[1]+B[1]+C[1])/3,cz];
        const two=t==='w'||t==='f';
        if(!two){if((ctr[0]-hc[0])*n[0]+(ctr[1]-hc[1])*n[1]+(ctr[2]-hc[2])*n[2]<0)n=n.map(q=>-q);if(n[2]>0.02)continue;}
        else if(n[2]>0)n=n.map(q=>-q);
        faces.push({F,t,n,z:cz});}
      faces.sort((p,q)=>q.z-p.z);
      x.lineJoin='round';
      for(const fc of faces){const [a0,b0,c0]=fc.F.map(k=>Pj[k]),d=Math.max(0,fc.n[0]*LIT[0]+fc.n[1]*LIT[1]+fc.n[2]*LIT[2]),pl=PAL[fc.t];
        x.beginPath();x.moveTo(a0[0],a0[1]);x.lineTo(b0[0],b0[1]);x.lineTo(c0[0],c0[1]);x.closePath();
        x.fillStyle=mixc(pl[0],pl[1],0.15+0.85*d);x.fill();
        x.strokeStyle=fc.t==='g'||fc.t==='f'?'rgba(0,229,255,0.9)':'rgba(255,63,164,0.85)';x.lineWidth=(fc.t==='r'?1:1.4)*lw;x.stroke();}
      // engines on the rear plate
      const rv=-rot([0,0,-1])[2];
      if(rv>0.05)for(const ex of [-0.15,0.15]){const e=rot([ex,0.03,-0.01]),f=1/(1+e[2]*0.1),EX=e[0]*f,EY=-e[1]*f+0.06;
        x.fillStyle='#160f24';x.beginPath();x.ellipse(EX,EY,0.1*Math.abs(cy),0.1*cp,0,0,TAU);x.fill();
        const th=thrust*(1-0.8*dim),gs=(0.45+th*0.75)*(1-0.45*dim)+bloom*1.4;x.globalCompositeOperation='lighter';x.drawImage(glow.pink,EX-gs,EY-gs,gs*2,gs*2);x.drawImage(glow.warm,EX-gs*0.5,EY-gs*0.5,gs,gs);
        if(bloom>0.02){const bs=0.6+bloom*1.8;x.globalAlpha=bloom;x.drawImage(glow.white,EX-bs/2,EY-bs/2,bs,bs);x.globalAlpha=1;}x.globalCompositeOperation='source-over';
        x.fillStyle=dim>0.3?'#ff9a8a':'#fff6e0';x.beginPath();x.arc(EX,EY,0.035+0.03*th+0.05*bloom,0,TAU);x.fill();}
      x.fillStyle=CYAN;for(const k of ['WL','WR']){x.beginPath();x.arc(Pj[k][0],Pj[k][1],0.05,0,TAU);x.fill();}
      x.restore();
    }

    const kindOf=l=>{if(noChord(l))return 'white';const r=pcOf(l),cc=chordColor(l),km=/minor|min\b/i.test(String(songRef?.key||''));if(r!=null&&r===info.keyRoot&&!!cc.minor===km)return 'warm';return cc.minor?'pink':'cyan';};

    // ---------- pitch stars (instrumental MIDI): one star per semitone, low on the left to high on the right, at fixed random heights
    const PS={key:'',lo:60,n:1,stars:[],lit:new Float32Array(64),lines:[],last:null};
    function psLayout(lo,hi){
      const key=lo+'|'+hi+'|'+w;if(PS.key===key)return;PS.key=key;
      const n=clamp(hi-lo+1,1,64),r=rng(2024+lo*7+hi),R=w/2;PS.lo=lo;PS.n=n;PS.stars=[];PS.lit.fill(0);PS.lines.length=0;PS.last=null;
      for(let i=0;i<n;i++){const X=L.cx+((i+0.5)/n-0.5)*w*0.84,dx=X-R,top=R-Math.sqrt(Math.max(0,R*R-dx*dx))+w*0.05,bot=L.hy-w*0.1;
        PS.stars.push({x:X,y:top+r()*Math.max(0,bot-top),ph:r()*TAU,f:0.6+r()*1.4});}
    }
    function pitchStars(x,fr,env,dt,jumped){
      const inp=env.inputs||{},src='pitchStars' in inp?inp.pitchStars:fr.notes?.instrumental,mid=env.song?.midi?.instrumental;
      const lo=src?.low??mid?.low,hi=src?.high??mid?.high,ok=lo!=null&&hi!=null&&hi>=lo;
      psLayout(ok?lo:55,ok?hi:84);
      const n=PS.n,lit=PS.lit,dec=Math.exp(-dt*3);for(let i=0;i<n;i++)lit[i]*=dec;
      if(jumped){PS.lines.length=0;PS.last=null;}
      for(const a of src?.active||[]){if(!isFinite(a?.pitch))continue;const i=clamp(Math.round(a.pitch-PS.lo),0,n-1);lit[i]=Math.max(lit[i],0.55+0.45*(a.strength??1));
        if(!PS.last||a.start>PS.last.start+1e-3){if(PS.last&&PS.last.i!==i&&a.start-PS.last.start<2.5&&PS.lines.length<8)PS.lines.push({a:PS.last.i,b:i,age:0});PS.last={i,start:a.start};}}
      x.globalCompositeOperation='lighter';x.lineCap='round';
      for(let j=PS.lines.length-1;j>=0;j--){const ln=PS.lines[j];ln.age+=dt;if(ln.age>1.4){PS.lines.splice(j,1);continue;}
        const A=PS.stars[ln.a],Z=PS.stars[ln.b],q=1-ln.age/1.4,col=ln.b>ln.a?RGB.warm:RGB.cyan;
        x.strokeStyle=rgba(col,0.25*q);x.lineWidth=w*0.008;x.beginPath();x.moveTo(A.x,A.y);x.lineTo(Z.x,Z.y);x.stroke();
        x.strokeStyle=rgba(col,0.9*q);x.lineWidth=Math.max(1,w*0.0025);x.stroke();}
      for(let i=0;i<n;i++){const s=PS.stars[i],l=lit[i],tw=0.22+0.1*Math.sin((env.wall||0)*s.f+s.ph);
        if(l>0.03){const gs=w*(0.03+0.05*l);x.globalAlpha=Math.min(1,l);x.drawImage(glow.cyan,s.x-gs/2,s.y-gs/2,gs,gs);x.globalAlpha=1;}
        const r=w*(0.002+0.004*l);x.fillStyle=`rgba(230,250,255,${Math.min(1,tw+l)})`;x.fillRect(s.x-r,s.y-r,r*2,r*2);
        if(l>0.4){x.fillRect(s.x-r*4,s.y-0.5,r*8,1);x.fillRect(s.x-0.5,s.y-r*4,1,r*8);}}
      x.globalCompositeOperation='source-over';x.lineCap='butt';
    }

    // ---------- the stage map: everything below draws in map pixels (1024 x 1024), stretched to the window
    const sunPath=g=>{g.beginPath();g.arc(SUN.x,SUN.y,SUN.r+3,0,TAU);};
    const bandsPath=(g,list)=>{g.beginPath();for(const [a,b] of list)g.rect(0,a,MAPW,b-a);};
    const triPath=(g,pts)=>{g.beginPath();pts.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();};
    // draw in a triangle's own upright frame; fn gets the rectangle that fits inside it
    function inLocal(g,T,fn){g.save();triPath(g,T.bleed);g.clip();g.translate(T.c[0],T.c[1]);g.transform(T.R[0],T.R[1],T.D[0],T.D[1],0,0);fn(T.rect);g.restore();}
    // flash: white over the whole screen (the section sweep); boost: a brighter, wider edge (the downbeat chase)
    function screen(g,T,edge,tint,tintA,flash=0,boost=0){
      g.save();triPath(g,T.bleed);g.clip();g.fillStyle=INK;g.fillRect(0,0,MAPW,MAPW);
      if(tintA>0.005){g.fillStyle=`rgba(${tint[0]|0},${tint[1]|0},${tint[2]|0},${Math.min(1,tintA)})`;g.fillRect(0,0,MAPW,MAPW);}
      if(flash>0.005){g.fillStyle=`rgba(255,250,245,${Math.min(1,flash)})`;g.fillRect(0,0,MAPW,MAPW);}
      const e=edge.map(v=>Math.round(v+(255-v)*boost*0.6));
      triPath(g,T.pts);g.lineJoin='round';g.strokeStyle=rgba(e,0.3+0.4*boost);g.lineWidth=16+14*boost;g.stroke();g.strokeStyle=rgba(e,0.9);g.lineWidth=4+4*boost;g.stroke();
      g.restore();
    }
    // hyperdrive: speed lines streaming out from the dome's center across a screen
    // hyperdrive streaks: level with the screen's text (its world "up"), streaming away from the dome toward a vanishing point
    // past the screen's outer side; they ride the flight distance, so they stop when the song pauses
    // (a screen's streakTurn turns its streaks that many degrees clockwise on the map, away from its text direction;
    //  fromDome puts its vanishing point on the dome's side instead, so the streaks spread out as they leave the dome;
    //  domeFlip is for a screen whose map position puts the dome on the other side of it than it really is in the world)
    function speedLines(g,T,a){
      if(a<0.02)return;const rt=(T.streakTurn||0)*Math.PI/180,cr=Math.cos(rt),sr=Math.sin(rt),un=([x,y])=>[x*cr+y*sr,-x*sr+y*cr];
      const loc=T.pts.map(p=>un([(p[0]-T.c[0])*T.R[0]+(p[1]-T.c[1])*T.R[1],(p[0]-T.c[0])*T.D[0]+(p[1]-T.c[1])*T.D[1]]));
      const xs=loc.map(p=>p[0]),ys=loc.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
      const sun=un([(SUN.x-T.c[0])*T.R[0]+(SUN.y-T.c[1])*T.R[1],(SUN.x-T.c[0])*T.D[0]+(SUN.y-T.c[1])*T.D[1]]),mid=un([T.rect.x+T.rect.w/2,T.rect.y+T.rect.h/2]);
      const s=(sun[0]>0?-1:1)*(T.domeFlip?-1:1),near=s>0?x0:x1,far=s>0?x1:x0,VX=T.fromDome?near-s*700:far+s*700,VY=mid[1],anchor=T.fromDome?far:near;
      inLocal(g,T,()=>{g.rotate(rt);g.globalCompositeOperation='lighter';g.lineCap='round';
        for(let i=0;i<18;i++){const yi=lerp(y0-15,y1+15,hsh(i,T.id)),ph=(((V.Dt/60)*(0.6+hsh(T.id,i)*0.8)+hsh(i,T.id+9))%1+1)%1,ln=30+70*ph,
            xb=near+s*(-40+(Math.abs(far-near)+120)*ph),xa=xb-s*ln,yAt=x=>VY+(yi-VY)*(x-VX)/(anchor-VX);
          g.strokeStyle=rgba(i%2?RGB.cyan:RGB.pink,0.65*a);g.lineWidth=2+4*ph;g.beginPath();g.moveTo(xa,yAt(xa));g.lineTo(xb,yAt(xb));g.stroke();}});
    }

    // ---------- triangle 4 as the enemy (the invasion and the dogfight). Its tip (its first corner) points at the dome.
    // The ship always dodges; when the stage ends, the ship shoots it and it bursts into pixels, then reboots to the section screen.
    const lerp2=(p,q,f)=>[lerp(p[0],q[0],f),lerp(p[1],q[1],f)];
    function enemyState(t){
      for(const e of info.E){if(t<e.start)break;if(t<e.end)return {on:ease(clamp((t-e.start)/0.8,0,1)),boom:-1,e};if(t<e.end+1.6)return {on:1,boom:(t-e.end)/1.6,e};}
      return null;
    }
    function attackNow(t){for(const a of info.A){const d=t-a.t;if(d>=-a.warn&&d<0.9)return [a,d];}return null;}
    // a world point (the dome's 3D space) in map pixels, or null behind the camera
    const toMap=(X,Y,Z)=>P(X,Y,Z)?[BOX_X+px*BOX/w,BOX_Y+py*BOX/h,pk*BOX/w]:null;
    function beam(g,x0,y0,x1,y1,col,al,wd){
      g.globalCompositeOperation='lighter';g.lineCap='round';g.strokeStyle=rgba(col,0.4*al);g.lineWidth=wd*4;g.beginPath();g.moveTo(x0,y0);g.lineTo(x1,y1);g.stroke();
      g.strokeStyle=`rgba(255,245,250,${al})`;g.lineWidth=wd;g.stroke();g.globalCompositeOperation='source-over';g.lineCap='butt';
    }
    const domeClip=g=>{sunPath(g);g.clip();bandsPath(g,BANDS);g.clip();};
    function triEnemy(g,a,charge,fire,wall){
      const T=TRI[3],tip=T.pts[0],A=T.pts[1],Bv=T.pts[2],[cx,cy]=T.c,far=lerp2(A,Bv,0.5);
      g.save();triPath(g,T.bleed);g.clip();g.globalAlpha=a;
      const gr=g.createLinearGradient(tip[0],tip[1],far[0],far[1]);gr.addColorStop(0,'#5a0c24');gr.addColorStop(1,'#16040f');g.fillStyle=gr;g.fillRect(0,0,MAPW,MAPW);
      g.strokeStyle='rgba(255,60,100,0.35)';g.lineWidth=3;
      for(const f of [0.32,0.56,0.8]){const p=lerp2(tip,A,f),q=lerp2(tip,Bv,f);g.beginPath();g.moveTo(p[0],p[1]);g.lineTo(q[0],q[1]);g.stroke();}
      // the eye, looking down the tip at the ship
      const an=Math.atan2(tip[1]-cy,tip[0]-cx),ex=cx+Math.cos(an)*12,ey=cy+Math.sin(an)*12,lit=0.55+0.45*charge+0.1*Math.sin(wall*3);
      g.globalCompositeOperation='lighter';const gs=110*(0.7+0.6*charge);g.globalAlpha=a*lit;g.drawImage(glow.pink,ex-gs/2,ey-gs/2,gs,gs);g.globalAlpha=a;g.globalCompositeOperation='source-over';
      g.save();g.translate(ex,ey);g.rotate(an);g.fillStyle='#ff3355';g.beginPath();g.ellipse(0,0,30,13,0,0,TAU);g.fill();
      g.fillStyle=`rgba(255,235,240,${lit})`;g.beginPath();g.ellipse(9,0,7,10,0,0,TAU);g.fill();g.fillStyle='#2a0512';g.beginPath();g.ellipse(11,0,3,8,0,0,TAU);g.fill();g.restore();
      g.lineJoin='round';triPath(g,T.pts);g.strokeStyle='rgba(255,40,80,0.35)';g.lineWidth=16;g.stroke();g.strokeStyle='#ff3355';g.lineWidth=4;g.stroke();
      // the charge: a glow running along both long edges toward the tip
      g.globalCompositeOperation='lighter';g.lineCap='round';
      if(charge>0)for(const P0 of [A,Bv]){const hd=lerp2(P0,tip,charge),lg=g.createLinearGradient(P0[0],P0[1],hd[0],hd[1]);
        lg.addColorStop(0,'rgba(255,60,90,0)');lg.addColorStop(1,'rgba(255,140,160,0.95)');g.strokeStyle=lg;g.lineWidth=14;g.beginPath();g.moveTo(P0[0],P0[1]);g.lineTo(hd[0],hd[1]);g.stroke();
        const s=60+40*charge;g.drawImage(glow.white,hd[0]-s/2,hd[1]-s/2,s,s);}
      // the recoil: a glow washing back from the tip across the whole ship
      if(fire>=0&&fire<0.9){const r=ease(fire/0.6)*380,al=1-fire/0.9,rg=g.createRadialGradient(tip[0],tip[1],Math.max(0,r-110),tip[0],tip[1],r+1);
        rg.addColorStop(0,'rgba(255,80,110,0)');rg.addColorStop(0.8,`rgba(255,120,150,${0.75*al})`);rg.addColorStop(1,'rgba(255,220,230,0)');g.fillStyle=rg;g.fillRect(0,0,MAPW,MAPW);}
      g.restore();
    }
    function enemyFx(g,t,es,at,calm){
      const T=TRI[3],tip=T.pts[0];
      // inside the dome the shots come from where the enemy appears in the world: the tip's direction from the dome's center,
      // turned FOE_TURN degrees down toward the right horizon (the flat map puts the tip almost straight overhead)
      const ta=Math.atan2(tip[1]-SUN.y,tip[0]-SUN.x)+FOE_TURN*Math.PI/180,td=Math.hypot(tip[0]-SUN.x,tip[1]-SUN.y)*FOE_DIST,src=[SUN.x+Math.cos(ta)*td,SUN.y+Math.sin(ta)*td];
      // the shot: an aiming line and a reticle where the ship will be on the bar, then the laser from the tip (the ship has rolled aside)
      if(at){const [a,d]=at,m=toMap(a.x,a.y,SZ+Math.max(0,a.s-V.Dt));   // once fired, the shot stays where the ship was
        if(m){const [tx,ty,mpk]=m,rr=Math.max(12,mpk*1.2);g.save();domeClip(g);
          if(d<0){const q=clamp((d+a.warn)/a.warn,0,1);g.setLineDash([12,12]);g.lineDashOffset=-t*120;g.strokeStyle=`rgba(255,209,102,${0.7*q})`;g.lineWidth=2;
            g.beginPath();g.moveTo(src[0],src[1]);g.lineTo(tx,ty);g.stroke();g.setLineDash([]);
            g.strokeStyle=rgba(RGB.warm,q);g.lineWidth=3;g.beginPath();g.arc(tx,ty,rr,0,TAU);g.stroke();g.beginPath();
            for(let i=0;i<4;i++){const an=i*Math.PI/2+t*2;g.moveTo(tx+Math.cos(an)*rr*0.6,ty+Math.sin(an)*rr*0.6);g.lineTo(tx+Math.cos(an)*rr*1.4,ty+Math.sin(an)*rr*1.4);}g.stroke();}
          else if(d<0.45){const al=1-d/0.45;beam(g,src[0],src[1],tx,ty,[255,63,110],al,6);
            g.globalCompositeOperation='lighter';g.globalAlpha=al;const s=rr*5;g.drawImage(glow.pink,tx-s/2,ty-s/2,s,s);g.globalAlpha=1;g.globalCompositeOperation='source-over';}
          g.restore();}}
      if(!es)return;
      // the ship's answer, just before the stage ends
      const dEnd=t-es.e.end;
      if(dEnd>-0.3&&dEnd<0.1){const m=toMap(V.ship.x,V.ship.y+0.1,SZ+(V.surge||0));if(m){const al=dEnd<0?1:1-dEnd/0.1,q=clamp((dEnd+0.3)/0.12,0,1),hx=lerp(m[0],tip[0],q),hy=lerp(m[1],tip[1],q);
        g.save();domeClip(g);beam(g,m[0],m[1],lerp(m[0],src[0],q),lerp(m[1],src[1],q),RGB.cyan,al,5);g.restore();g.save();triPath(g,T.bleed);g.clip();beam(g,m[0],m[1],hx,hy,RGB.cyan,al,5);g.restore();}}
      // the burst: a flash, a shock ring, and the screen's pixels flying apart and falling
      if(es.boom>=0){const b=es.boom,[cx,cy]=T.c,P0=T.pts[0],P1=T.pts[1],P2=T.pts[2];g.save();
        if(!calm&&b<0.2){g.save();triPath(g,T.bleed);g.clip();g.fillStyle=`rgba(255,245,235,${1-b/0.2})`;g.fillRect(0,0,MAPW,MAPW);g.restore();}
        g.globalCompositeOperation='lighter';g.strokeStyle=rgba(RGB.warm,(1-b)*0.9);g.lineWidth=2+8*(1-b);g.beginPath();g.arc(cx,cy,20+ease(b)*200,0,TAU);g.stroke();
        const cols=[RGB.warm,RGB.pink,RGB.white,[255,51,85],RGB.cyan];g.globalCompositeOperation='source-over';
        for(let i=0;i<46;i++){let u1=hsh(i,51),u2=hsh(i,52);if(u1+u2>1){u1=1-u1;u2=1-u2;}
          const sx=P0[0]+(P1[0]-P0[0])*u1+(P2[0]-P0[0])*u2,sy=P0[1]+(P1[1]-P0[1])*u1+(P2[1]-P0[1])*u2,dx=sx-cx,dy=sy-cy,l=Math.hypot(dx,dy)||1,sp=60+hsh(i,53)*220,f=Math.sqrt(b);
          const X=sx+dx/l*sp*f+T.D[0]*160*b*b,Y=sy+dy/l*sp*f+T.D[1]*160*b*b,s=Math.round((8+hsh(i,54)*12)*(1-b*0.6));
          g.fillStyle=rgba(cols[i%cols.length],1-b);g.fillRect(Math.round(X/4)*4,Math.round(Y/4)*4,s,s);}
        g.restore();}
    }
    function txt(g,s,x,y,fs,maxW,weight,fam,col,align='left'){
      g.font=`${weight} ${fs}px ${fam}`;const tw=g.measureText(s).width;if(tw>maxW){fs*=maxW/tw;g.font=`${weight} ${fs}px ${fam}`;}
      g.textAlign=align;g.textBaseline='alphabetic';g.fillStyle=col;g.fillText(s,x,y);return fs;
    }
    const plate=(g,x0,y0,ww,hh)=>{g.fillStyle='rgba(185,169,214,0.2)';g.fillRect(x0,y0,ww,hh);};
    function chordParts(label){const m=/^([A-G])([#b]?)(.*)$/.exec(label||'');if(!m)return [label||'',''];return [m[1]+(m[2]==='#'?'♯':m[2]==='b'?'♭':''),m[3].replace(/#/g,'♯').replace(/\/([A-G])b/,'/$1♭')];}
    function chordLabel(g,label,cx,cy,maxW,fs,ck,alpha){
      if(alpha<=0.01)return;const [root,rest]=chordParts(label);
      g.font=`800 ${fs}px ${DISPLAY}`;let w1=g.measureText(root).width;g.font=`700 ${fs*0.55}px ${DISPLAY}`;let w2=rest?g.measureText(rest).width+fs*0.05:0;
      const s=Math.min(1,maxW/Math.max(1,w1+w2));fs*=s;w1*=s;w2*=s;const x0=cx-(w1+w2)/2,y=cy+fs*0.36;
      g.globalAlpha=alpha;g.textAlign='left';g.textBaseline='alphabetic';
      const run=ff=>{g.font=`800 ${fs}px ${DISPLAY}`;g.fillText(root,x0+ff,y);if(rest){g.font=`700 ${fs*0.55}px ${DISPLAY}`;g.fillText(rest,x0+w1+fs*0.05+ff,y-fs*0.3);}};
      g.fillStyle='rgba(255,63,164,0.55)';run(-1.5);g.fillStyle='rgba(0,229,255,0.55)';run(1.5);g.fillStyle=HEX[ck]||'#ffffff';run(0);g.globalAlpha=1;
    }
    // triangle 4: the section
    function triSection(g,fr,seg){inLocal(g,TRI[3],r=>{
      const s=fr.section,name=String(s?.name||STAGES[seg.scene].name).toUpperCase();
      txt(g,'STAGE '+String(seg.stage).padStart(2,'0')+'  '+STAGES[seg.scene].name,r.x,r.y+r.h*0.17,r.h*0.15,r.w,700,MONO,WARM);
      let fs=r.h*0.4;g.font=`800 ${fs}px ${DISPLAY}`;const tw=g.measureText(name).width;if(tw>r.w)fs*=r.w/tw;
      const y=r.y+r.h*0.6;g.font=`800 ${fs}px ${DISPLAY}`;g.textAlign='left';g.textBaseline='alphabetic';
      g.fillStyle='rgba(255,63,164,0.65)';g.fillText(name,r.x-1.5,y);g.fillStyle='rgba(0,229,255,0.65)';g.fillText(name,r.x+1.5,y);g.fillStyle='#f4f0ff';g.fillText(name,r.x,y);
      if(s?.next?.name)txt(g,'▸ '+String(s.next.name).toUpperCase()+'  '+fmt(s.next.in??0),r.x,r.y+r.h*0.8,r.h*0.13,r.w,700,MONO,LAV);
      const by=r.y+r.h*0.9,bh=r.h*0.07;plate(g,r.x,by,r.w,bh);g.fillStyle=CYAN;g.fillRect(r.x,by,r.w*clamp(s?.progress??0,0,1),bh);
    });}
    // triangle 6: the chord and the next one
    function triChord(g,fr,wall,calm){inLocal(g,TRI[5],r=>{
      const ch=fr.chord||{},kk=clamp((wall-chordWall)/0.28,0,1),e=ease(kk),dy=calm?0:r.h*0.5,mcx=r.x+r.w*0.3,mcy=r.y+r.h*0.5,mw=r.w*0.56,fs=r.h*0.7;
      g.save();g.beginPath();g.rect(r.x-r.w*0.1,r.y-r.h*0.05,r.w*0.75,r.h*1.1);g.clip();
      const main=(lab,yo,al)=>{if(lab)chordLabel(g,lab,mcx,mcy+yo,mw,fs,kindOf(lab),al);else{g.globalAlpha=al;txt(g,'N.C.',mcx,mcy+yo+fs*0.14,fs*0.4,mw,700,MONO,LAV,'center');g.globalAlpha=1;}};
      if(kk<1)main(chordPrev,-e*dy,1-kk);main(chordCur,(1-e)*dy,calm?1:kk);g.restore();
      const nx=ch.next;if(!nx||noChord(nx.label))return;
      const x0=r.x+r.w*0.68,pw=r.w*0.32;txt(g,'NEXT',x0,r.y+r.h*0.2,r.h*0.14,pw,700,MONO,LAV);
      chordLabel(g,nx.label,x0+pw/2,r.y+r.h*0.48,pw,r.h*0.36,kindOf(nx.label),1);
      const span=ch.label?Math.max(0.1,(nx.start??0)-(ch.start??0)):4,p=clamp(1-(nx.in??0)/span,0,1),by=r.y+r.h*0.78,bh=r.h*0.07;
      plate(g,x0,by,pw,bh);g.fillStyle=HEX[kindOf(nx.label)]||CYAN;g.fillRect(x0,by,pw*p,bh);
    });}
    // triangle 1: bar and beat
    function triBeat(g,fr){inLocal(g,TRI[0],r=>{
      const b=fr.beat;if(b?.bar==null){txt(g,'BAR ---',r.x,r.y+r.h*0.5,r.h*0.36,r.w,700,MONO,LAV);return;}
      txt(g,'BAR '+String(b.bar).padStart(3,'0'),r.x,r.y+r.h*0.5,r.h*0.36,r.w,700,MONO,WARM);
      const n=clamp(b.beats||4,1,12),gap=r.w/n,rr=Math.min(gap*0.3,r.h*0.13);
      for(let i=0;i<n;i++){const on=i===(b.beat||1)-1;g.fillStyle=on?(i===0?WARM:PINK):'rgba(185,169,214,0.3)';g.beginPath();g.arc(r.x+gap*(i+0.5),r.y+r.h*0.8,on?rr*1.2:rr*0.8,0,TAU);g.fill();}
    });}
    // triangle 2: seven stem meters
    const STEMS=[['bass',PINK],['drums',WARM],['other',LAV],['vocals','#ffffff'],['piano',CYAN],['lead','#ff7a7a'],['rhythm','#5fd8ef']],lv=new Float32Array(7);
    function triStems(g,fr,dt){const tr=fr.tracks||{};inLocal(g,TRI[1],r=>{
      const gap=r.w/7,bw=gap*0.62,bh=r.h*0.8,segs=10,sh=bh/segs;
      STEMS.forEach(([key,col],i)=>{const tk=tr[key],v=clamp(((tk?.level??0)-0.15)/0.7,0,1);lv[i]+=(v-lv[i])*Math.min(1,dt*14);
        const x0=r.x+gap*i+(gap-bw)/2,on=Math.round(lv[i]*segs);plate(g,x0,r.y,bw,bh);
        g.fillStyle=col;for(let q=0;q<on;q++){g.globalAlpha=0.5+0.5*q/segs;g.fillRect(x0,r.y+bh-(q+1)*sh+sh*0.12,bw,sh*0.76);}
        const pu=tk?.pulse??0;if(pu>0.05){g.globalAlpha=Math.min(1,pu);g.fillStyle='#ffffff';g.fillRect(x0,r.y+bh-Math.max(1,on)*sh+sh*0.12,bw,sh*0.76);}
        g.globalAlpha=1;txt(g,key[0].toUpperCase(),x0+bw/2,r.y+r.h,r.h*0.15,gap,700,MONO,LAV,'center');});
    });}
    // triangle 5: the song and how far through it
    function triSong(g,fr){inLocal(g,TRI[4],r=>{
      const title=String(fr.title||songRef?.title||'').toUpperCase(),d=fr.duration||songRef?.duration||0,t=fr.time||0;
      if(title)txt(g,title,r.x,r.y+r.h*0.35,r.h*0.26,r.w,800,DISPLAY,'#f4f0ff');
      if(d>0)txt(g,fmt(t)+' / '+fmt(d),r.x,r.y+r.h*0.62,r.h*0.16,r.w,700,MONO,LAV);
      plate(g,r.x,r.y+r.h*0.78,r.w,r.h*0.1);g.fillStyle=PINK;g.fillRect(r.x,r.y+r.h*0.78,r.w*(d>0?clamp(t/d,0,1):0),r.h*0.1);
    });}
    // the stage color: lights the sides of every screen in the world
    const side=[120,100,170];let lift=0,beatFlash=0,sweepT=-9,chaseT=-9;
    const SWEEP=[2,0,1,4,3,5];   // the triangles left to right across the room: 3, 1, 2, 5, 4, 6
    function chordRgb(label){if(noChord(label))return [120,100,170];const cc=chordColor(label);return hsl2rgb(((cc.hue??0)%360+360)%360,cc.minor?0.7:0.9,cc.minor?0.5:0.56);}
    function stageScreens(g,fr,env,seg,dt,calm){
      const inp=env.inputs||{},ev=env.events||{},wall=env.wall||0,tgt=chordRgb(fr.chord?.label);
      for(let i=0;i<3;i++)side[i]+=(tgt[i]-side[i])*Math.min(1,dt*4);
      lift*=Math.exp(-dt*1.6);beatFlash*=Math.exp(-dt*5);
      const secHit=('sideLift' in inp?inp.sideLift.length:ev.sectionChanged);
      if(secHit){lift=1;sweepT=wall;}
      if(ev.beat?.downbeat){beatFlash=1;if(!calm)lift=Math.max(lift,0.3);if(!secHit&&ev.beat.bar!=null&&((ev.beat.bar-1)%4+4)%4===0)chaseT=wall;}
      if(sweepT>wall||chaseT>wall)sweepT=chaseT=-9;
      const t=fr.time||0,es=enemyState(t),at=es?attackNow(t):null;
      // triangle 4: the enemy's hull over the section screen; the section comes back after the burst
      const foe=es?(es.boom<0?es.on:1-ease(clamp(es.boom/0.25,0,1))):0,infoA=es?(es.boom<0?1-es.on:ease(clamp((es.boom-0.45)/0.55,0,1))):1;
      const tint=[0.06+(calm?0.12:0.35)*beatFlash,0.04,0.08+0.5*bassS+(calm?0.05:0.2)*thrust,0.05,0.04,0.05],edges=[RGB.cyan,RGB.cyan,RGB.cyan,RGB.pink,RGB.pink,RGB.pink];
      const wave=(t0,i,rate)=>{const d=wall-t0-SWEEP.indexOf(i)*0.08;return d<0?0:Math.exp(-d*rate);};
      TRI.forEach((T,i)=>{screen(g,T,edges[i],side,tint[i],wave(sweepT,i,5)*(calm?0.12:0.4),wave(chaseT,i,7));if(!(i===3&&foe>0.5))speedLines(g,T,V.hyperW||0);});
      triBeat(g,fr);triStems(g,fr,dt);triChord(g,fr,wall,calm);triSong(g,fr);
      if(infoA>0.01){g.save();g.globalAlpha=infoA;triSection(g,fr,seg);g.restore();}
      if(foe>0.01)triEnemy(g,foe,at&&at[1]<0?ease(clamp((at[1]+at[0].warn)/at[0].warn,0,1)):0,at?at[1]:-1,wall);
      enemyFx(g,t,es,at,calm);
    }
    function stageDot(g,calm){
      const m=Math.min(1,lift)*(calm?0.15:0.4),col=side.map(v=>Math.round(v+(255-v)*m));
      g.fillStyle=`rgb(${col[0]},${col[1]},${col[2]})`;g.beginPath();g.arc(DOT.x,DOT.y,DOT.r,0,TAU);g.fill();
    }
    // the triangle screens through the same tape as the dome: drawn into their own layer, the dome's glitch band crossing each
    // screen along its own "up", the red/cyan split and wobble, then scanlines level with each screen's text, and the noise
    let TL=null,tl=null,TR=null,tr2=null,TC=null,tc=null,scanPat=null,tpats=null;
    function screensVHS(g,fr,env,seg,dt,calm,fi,band,SX,SY){
      const PW=Math.max(1,Math.round(W0)),PH=Math.max(1,Math.round(H0));
      if(!TL||TL.width!==PW||TL.height!==PH){TL=mk(PW,PH);tl=TL.getContext('2d');TR=mk(PW,PH);tr2=TR.getContext('2d');TC=mk(PW,PH);tc=TC.getContext('2d');}
      tl.setTransform(1,0,0,1,0,0);tl.globalAlpha=1;tl.globalCompositeOperation='source-over';tl.clearRect(0,0,PW,PH);tl.setTransform(SX,0,0,SY,0,0);
      stageScreens(tl,fr,env,seg,dt,calm);
      if(band!=null)TRI.forEach((T,i)=>{const ys=T.pts.map(p=>(p[0]-T.c[0])*T.D[0]+(p[1]-T.c[1])*T.D[1]),y0=Math.min(...ys),y1=Math.max(...ys),bh=10,
          Y=y0+band*(y1-y0-bh),dx=(hsh(fi,22+i)-0.5)*14;
        tl.save();tl.setTransform(SX,0,0,SY,0,0);triPath(tl,T.bleed);tl.clip();tl.translate(T.c[0],T.c[1]);tl.transform(T.R[0],T.R[1],T.D[0],T.D[1],0,0);
        tl.beginPath();tl.rect(-800,Y,1600,bh);tl.clip();tl.setTransform(1,0,0,1,0,0);
        tl.drawImage(TL,Math.round(dx*T.R[0]*SX),Math.round(dx*T.R[1]*SY));tl.fillStyle='rgba(255,255,255,0.07)';tl.fillRect(0,0,PW,PH);tl.restore();});
      for(const [x,col] of [[tr2,'#ff0000'],[tc,'#00ffff']]){x.setTransform(1,0,0,1,0,0);x.globalAlpha=1;x.globalCompositeOperation='copy';x.drawImage(TL,0,0);
        x.globalCompositeOperation='multiply';x.fillStyle=col;x.fillRect(0,0,PW,PH);x.globalCompositeOperation='destination-in';x.drawImage(TL,0,0);x.globalCompositeOperation='source-over';}
      const wx=(hsh(fi,31)-0.5)*(calm?0.6:1.8),wy=(hsh(fi,32)-0.5)*(calm?0.4:1.0),sh=2+hsh(fi,33);
      g.save();const M0=g.getTransform();
      g.drawImage(TC,wx,wy,W0,H0);g.globalCompositeOperation='lighter';g.drawImage(TR,wx+sh,wy,W0,H0);g.globalCompositeOperation='source-over';
      g.scale(SX,SY);
      if(!scanPat){const cv=mk(1,3),x=cv.getContext('2d');x.fillStyle='rgba(0,0,0,0.2)';x.fillRect(0,0,1,1);scanPat=g.createPattern(cv,'repeat');}
      const sp=3/Math.max(SX,SY);if(scanPat.setTransform)scanPat.setTransform(new DOMMatrix([1,0,0,sp/3,0,0]));
      TRI.forEach(T=>inLocal(g,T,()=>{g.fillStyle=scanPat;g.fillRect(-800,-800,1600,1600);}));
      g.beginPath();TRI.forEach(T=>T.bleed.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1])));g.clip();g.setTransform(M0);
      if(!calm){g.fillStyle=`rgba(0,0,0,${hsh(fi,34)*0.05})`;g.fillRect(0,0,W0,H0);}
      if(!tpats&&noise)tpats=noise.map(n=>g.createPattern(n,'repeat'));
      const pt=tpats&&tpats[Math.floor(hsh(fi,35)*4)%4];
      if(pt){if(pt.setTransform)pt.setTransform(new DOMMatrix([1,0,0,1,Math.floor(hsh(fi,36)*128),Math.floor(hsh(fi,37)*128)]));g.globalAlpha=calm?0.035:0.06;g.fillStyle=pt;g.fillRect(0,0,W0,H0);g.globalAlpha=1;}
      g.restore();
      g.save();g.scale(SX,SY);stageDot(g,calm);g.restore();
    }
    // stripe 1: the lyric line in hard pixels (a 220 x 13 picture blown up three times), scrolling with the singer
    const LW=220,LH=13,LPX=3;let lyrS={key:'',toks:null,total:0,scroll:null};
    function lyricStripe(g,fr,t,dt,on){
      if(!on||!lb)return;const ly=fr.lyric||{},line=ly.line,words=ly.words||[];
      const soon=!line&&ly.next?.text&&ly.next.in!=null&&ly.next.in<5;if(!line?.text&&!words.length&&!soon)return;
      const x=lb,base=10;x.setTransform(1,0,0,1,0,0);x.clearRect(0,0,LW,LH);x.font=`700 10px ${MONO}`;x.textBaseline='alphabetic';x.textAlign='left';
      if(line&&words.length){
        const key=line.index+'|'+line.text;
        if(lyrS.key!==key){const toks=[],sp=x.measureText(' ').width;let X=0;
          words.forEach((wd,i)=>{const s=String(wd.text||''),join=s.length>1&&s.endsWith('-'),tx=join?s.slice(0,-1):s,ww=x.measureText(tx).width;toks.push({i,x:X,w:ww,text:tx});X+=ww+(join?0:sp);});
          lyrS={key,toks,total:Math.max(0,X-sp),scroll:null};}
        const prog=wd=>clamp((t-wd.start)/Math.max(0.05,wd.end-wd.start),0,1);
        let s=0;for(const tk of lyrS.toks){const wd=words[tk.i];if(!wd)continue;if(wd.state==='now'){s=tk.x+tk.w*prog(wd);break;}if(wd.state==='sung')s=tk.x+tk.w;}
        const target=lyrS.total<=LW-8?-(LW-lyrS.total)/2:clamp(s-LW*0.42,-4,lyrS.total-LW+4);
        lyrS.scroll=lyrS.scroll==null?target:lyrS.scroll+(target-lyrS.scroll)*Math.min(1,dt*6);const off=Math.round(lyrS.scroll);
        for(const tk of lyrS.toks){const wd=words[tk.i];if(!wd)continue;const X=tk.x-off;if(X>LW||X+tk.w<0)continue;
          if(wd.state==='sung'){x.fillStyle=WARM;x.fillText(tk.text,X,base);}
          else if(wd.state==='now'){x.fillStyle=LAV;x.fillText(tk.text,X,base);x.save();x.beginPath();x.rect(X,0,tk.w*prog(wd),LH);x.clip();x.fillStyle='#ffffff';x.fillText(tk.text,X,base);x.restore();}
          else{x.fillStyle='rgba(185,169,214,0.75)';x.fillText(tk.text,X,base);}}
      }else{const s=dehyph(line?.text||ly.next.text),tw=x.measureText(s).width;x.fillStyle=line?WARM:'rgba(185,169,214,0.75)';x.fillText(s,Math.round(tw<LW-8?(LW-tw)/2:4),base);lyrS.key='';}
      // every pixel fully on or off, for the chunky look
      const im=x.getImageData(0,0,LW,LH),d=im.data;for(let i=3;i<d.length;i+=4)d[i]=d[i]>110?255:0;x.putImageData(im,0,0);
      g.save();sunPath(g);g.clip();g.fillStyle=INK;g.fillRect(0,LYR[0]-3,MAPW,LYR[1]-LYR[0]+6);
      g.imageSmoothingEnabled=false;g.drawImage(LB,SUN.x-LW*LPX/2,LYR[0]+0.5,LW*LPX,LH*LPX);g.restore();
    }
    // the alignment test card (TEST_CARD = true)
    function testCard(g){
      g.fillStyle='#000';g.fillRect(0,0,MAPW,MAPW);
      g.save();sunPath(g);g.clip();bandsPath(g,BANDS);g.clip();g.fillStyle='#3a1858';g.fillRect(0,0,MAPW,MAPW);
      g.strokeStyle=CYAN;g.lineWidth=2;for(let i=-4;i<=4;i++){const X=SUN.x+i*SUN.r/4;g.beginPath();g.moveTo(X,0);g.lineTo(X,MAPW);g.stroke();}
      g.fillStyle='#ffffff';g.textAlign='center';g.textBaseline='middle';g.font=`800 64px ${DISPLAY}`;g.fillText('SUN  F',SUN.x,SUN.y-160);
      BANDS.slice(1).forEach(([a,b],i)=>{g.font=`700 ${Math.round((b-a)*0.6)}px ${MONO}`;g.fillText('STRIPE '+(i+1)+'  F',SUN.x,(a+b)/2);});
      g.restore();
      TRI.forEach((T,i)=>{g.save();triPath(g,T.bleed);g.fillStyle=i<3?'#2a4bd8':'#d82a50';g.fill();g.restore();
        inLocal(g,T,r=>{const s=r.h,ax=r.x+r.w*0.18;g.strokeStyle='#ffffff';g.fillStyle='#ffffff';g.lineWidth=s*0.09;g.lineCap='round';g.lineJoin='round';
          g.beginPath();g.moveTo(ax,r.y+s*0.95);g.lineTo(ax,r.y+s*0.08);g.moveTo(ax-s*0.16,r.y+s*0.26);g.lineTo(ax,r.y+s*0.06);g.lineTo(ax+s*0.16,r.y+s*0.26);g.stroke();
          g.font=`800 ${s*0.6}px ${DISPLAY}`;g.textAlign='left';g.textBaseline='middle';g.fillText(T.id+' F',r.x+r.w*0.38,r.y+s*0.55);});});
      g.fillStyle='#00ffff';g.beginPath();g.arc(DOT.x,DOT.y,DOT.r,0,TAU);g.fill();
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
      if(!seg.changed)return;const d=t-seg.start;if(d<0||d>2.6)return;const a=ease(d/0.35)*(1-ease((d-2.0)/0.6)),u=L.u,y=L.top+L.M*0.2;
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
      resize(){layKey='';},
      draw(g,frame,env){
        W0=env.w;H0=env.h;if(!W0||!H0)return;
        const SX=W0/MAPW,SY=H0/MAPW;
        if(TEST_CARD){g.save();g.scale(SX,SY);testCard(g);g.restore();return;}
        w=h=Math.round(clamp(BOX*Math.max(SX,SY),320,1400));
        const wall=env.wall||0,calm=!!env.calm,dt=env.dt||1/60,t=frame.time||0,tr=frame.tracks||{},ev=env.events||{},playing=!!frame.playing;
        ensureInfo(env.song,env.inputs?.rings?.all||null);ensureLayout();
        const u=L.u,jumped=lastT==null||t<lastT-0.02||t-lastT>0.5;
        if(jumped){bolts.length=0;flares.length=0;}
        V.t=t;V.wall=wall;V.Dt=info.dist(t);V.speed=(info.dist(t+0.05)-info.dist(t-0.05))/0.1;V.beat=frame.beat?.beat||0;
        // while a loop repeats, section changes snap instead of replaying the crossfade, title and stage card
        const again=!!(frame.loop&&frame.loop.inside&&frame.loop.pass>1);
        const seg=info.segAt(t),tp=seg.changed&&!again?clamp((t-seg.start)/0.9,0,1):1,tpE=ease(tp);
        const wt=s=>s===seg.scene?(tp<1?tpE:1):(tp<1&&s===seg.from?1-tpE:0);
        // smoothing + reactions
        const sm=(v,x,r)=>v+((x??0)-v)*Math.min(1,dt*r);
        {let e=0;for(const k in tr)e+=tr[k]?.level||0;eS=sm(eS,e,4);ePk=Math.max(eS,ePk*Math.exp(-dt/25),0.05);}
        const ampI=clamp(eS/ePk,0,1),amp=0.15+0.85*ampI*ampI;
        const inp=env.inputs||{},has=k=>k in inp;
        bassS=sm(bassS,has('sun')?inp.sun:tr.bass?.level,10);vocS=sm(vocS,has('glow')?inp.glow:tr.vocals?.level,8);
        leadS=sm(leadS,has('trails')?inp.trails:tr.lead?.level,8);otherS=sm(otherS,has('haze')?inp.haze:tr.other?.level,3);
        const dec=r=>Math.exp(-dt*r);thrust*=dec(7);gridPulse*=dec(5);shake*=dec(14);for(let i=0;i<12;i++)pcFlash[i]*=dec(2.6);
        const br=tr.drums?.brightness??0.5;
        for(const s of has('engines')?inp.engines:ev.hits?.drums||[]){const kick=br<0.45||s>=info.thr;if(kick)thrust=Math.max(thrust,(0.4+0.6*s)*(0.5+0.5*amp));if((seg.scene==='hyper'||seg.scene==='solo')&&!calm&&(kick||s>=info.thr))shake=Math.max(shake,u*(s>=info.thr?0.012:0.007)*s*(seg.scene==='solo'?0.6:1)*amp);}
        if(!jumped&&playing&&!calm)for(let q=after(info.K,lastT);q<info.K.length&&info.K[q].t<=t;q++)if(!info.K[q].survivor)shake=Math.max(shake,u*0.007*(0.4+0.6*amp));
        if(!tr.drums&&ev.beat)thrust=Math.max(thrust,ev.beat.downbeat?0.9:0.5);
        if(has('grid')?inp.grid.length:ev.beat?.downbeat)gridPulse=1;
        if(has('lasers')?inp.lasers.length:ev.beat){
          if((seg.scene==='hyper'||seg.scene==='ufo'||seg.scene==='solo')&&tp>0.5){const sp=shipAt(t);for(const sd of [-1,1])if(bolts.length<40)bolts.push({x:sp.x+sd*0.95,y:sp.y+0.12,z:SZ,col:seg.scene==='ufo'?'pink':seg.scene==='solo'?'warm':'cyan'});}}
        for(const s of has('stars')?inp.stars:ev.hits?.piano||[])if(comets.length<(calm?4:16)){const a=Math.PI*(0.15+Math.random()*0.15)*(Math.random()<0.5?1:-1);comets.push({x:w*(0.1+Math.random()*0.8),y:L.top*0.4+Math.random()*(L.hy-L.top*0.4)*0.7,vx:Math.sin(a)*u*1.2,vy:Math.cos(a)*u*0.5,age:0,max:0.5+s*0.3});}
        if(!jumped&&playing){const N=info.N;for(let i=after(N,lastT);i<N.length&&N[i].start<=t;i++){const n=N[i];if(flares.length<24)flares.push({age:0,col:n.col,big:0});}}
        if((has('chordFlare')?inp.chordFlare.length:ev.chordChanged)&&flares.length<24)flares.push({age:0,col:kindOf(frame.chord?.label),big:1});
        const label=noChord(frame.chord?.label)?null:frame.chord.label;
        if(label!==chordCur){chordPrev=chordCur===undefined?null:chordCur;chordCur=label;chordWall=(jumped||!playing)?wall-1:wall;}
        lastT=t;
        // ship + camera from the melody
        const base=basePos(info,t),sp=shipAt(t),vx=(basePos(info,t+0.06).x-basePos(info,t-0.06).x)/0.12;
        V.camX=base.x*0.5;V.camY=CAMY+(base.y-3.2)*0.3;   // a low camera, so the ship flies up in the dome
        const bob=Math.sin(wall*1.7)*0.06;
        const ang=clamp(vx*0.07,-0.6,0.6)+sp.roll;
        const sd0=t-seg.start,sb=seg.changed&&sd0>=0&&sd0<1.8?ease(sd0/0.35)*(1-ease((sd0-0.45)/1.3)):0;
        const fast=seg.scene==='hyper'||seg.scene==='solo',surge=fast?7*sb:seg.scene==='atmo'?-3.2*sb:0,bloom=fast?sb*(calm?0.4:1)*(0.4+0.6*amp):0,dim=seg.scene==='atmo'?sb:0;
        V.surge=surge;V.ship=sp;V.hyperW=wt('hyper');
        // ---------- scene buffer
        c.setTransform(sc,0,0,sc,0,0);c.globalAlpha=1;c.globalCompositeOperation='source-over';
        const fi=playing?Math.floor(t*60):Math.floor(wall*60);
        if(!playing)shake=0;if(shake>0.2){const f3=fi/3,a0=Math.floor(f3),fr3=ease(f3-a0),jx=lerp(hsh(a0,30),hsh(a0+1,30),fr3)-0.5,jy=lerp(hsh(a0,31),hsh(a0+1,31),fr3)-0.5;c.translate(jx*shake*1.6,jy*shake*1.6);}
        if(tp<1&&seg.from){BG[seg.from](c);t1.setTransform(sc,0,0,sc,0,0);t1.globalAlpha=1;t1.globalCompositeOperation='source-over';BG[seg.scene](t1);
          c.save();c.setTransform(1,0,0,1,0,0);c.globalAlpha=tpE;c.drawImage(T1,0,0);c.restore();}
        else BG[seg.scene](c);
        constellation(c);
        pitchStars(c,frame,env,dt,jumped);
        collect();
        let i=0;for(;i<list.length&&list[i].z>=SZ;i++)drawItem(c,list[i]);
        // lasers
        c.lineCap='round';c.globalCompositeOperation='lighter';
        for(let j=bolts.length-1;j>=0;j--){const b=bolts[j];b.z+=150*dt;if(b.z>FAR){bolts[j]=bolts[bolts.length-1];bolts.pop();continue;}
          if(!P(b.x,b.y,b.z))continue;const X0=px,Y0=py,k0=pk;P(b.x,b.y,b.z+4);c.strokeStyle=rgba(RGB[b.col],0.35);c.lineWidth=Math.max(2,k0*0.35);c.beginPath();c.moveTo(X0,Y0);c.lineTo(px,py);c.stroke();
          c.strokeStyle='#ffffff';c.lineWidth=Math.max(1,k0*0.1);c.stroke();}
        c.globalCompositeOperation='source-over';c.lineCap='butt';
        drawTrails(c,ang);
        const heat=seg.scene==='atmo'&&!again?clamp(1-(t-seg.start)/3,0,1)*wt('atmo'):0;
        if(P(sp.x,sp.y+bob,SZ+surge)){const sx=px,sy=py,sk=pk;
          if(heat>0.01){c.globalCompositeOperation='lighter';c.lineCap='round';
            for(let q=0;q<18;q++){const an=hsh(q,3)*TAU,rr=((t*1.7+hsh(q,4))%1),r0=sk*(1.1+rr*2.2);c.strokeStyle=`rgba(255,${q%2?209:120},${q%2?102:90},${heat*(1-rr)*0.8})`;c.lineWidth=Math.max(1,sk*0.06);
              c.beginPath();c.moveTo(sx+Math.cos(an)*r0,sy+Math.sin(an)*r0*0.7);c.lineTo(sx+Math.cos(an)*(r0+sk*0.6),sy+Math.sin(an)*(r0+sk*0.6)*0.7);c.stroke();}
            c.globalCompositeOperation='source-over';c.lineCap='butt';}
          {const ox=clamp((sx-L.cx)/(w*0.5),-1.2,1.2),oy=clamp((sy-L.hy)/(h*0.5),-1,1),tx=clamp(-ox*0.8+clamp(vx*0.07,-0.55,0.55),-1.1,1.1),ty=clamp(0.1+oy*0.7,-0.25,0.7);
            parX+=(tx-parX)*Math.min(1,dt*6);parY+=(ty-parY)*Math.min(1,dt*6);}
          drawShip(c,sx,sy,sk,ang,heat,bloom,dim,parX,parY);
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
        const titled=!again&&chromeTitle(c,t);
        if(!titled&&!again)stageCard(c,seg,t);
        post(sg,fi,calm,band);
        // ---------- the stage map, stretched over the whole window
        g.fillStyle='#000';g.fillRect(0,0,W0,H0);
        g.save();g.scale(SX,SY);
        g.save();sunPath(g);g.clip();bandsPath(g,BANDS);g.clip();g.drawImage(SC,BOX_X,BOX_Y,BOX,BOX);g.restore();
        lyricStripe(g,frame,t,dt,env.lyrics!==false);
        g.restore();
        screensVHS(g,frame,env,seg,dt,calm,fi,band,SX,SY);
      },
      dispose(){B=c=T1=t1=T2=t2=scan=SC=sg=LB=lb=null;TL=tl=TR=tr2=TC=tc=scanPat=tpats=null;art=null;bolts.length=flares.length=comets.length=0;},
    };
  },
};
