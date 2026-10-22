// Skyward: a pastel pegasus-unicorn flies through cloud gates, one gate per chord.
//   Chords            -> cloud gates, tinted by chord color and labelled. The same chord always sits at the same height, so a progression
//                        draws a recognizable path. The pegasus is placed by song time and is exactly in each gap on the change.
//   Its flight path   -> the rainbow trail: the trail IS the path it flew (song time), so it shows the progression just played.
//   Melody/vocal MIDI -> each upcoming note is a bird; the flock's shape is the melody's shape (height = pitch). A bird sings as it passes the
//                        pegasus; its ribbon is the note's length and glows while it sounds.
//   Beat              -> wing beats (downstroke on the beat).        Section -> time of day (sky palette).
//   Kick              -> the pegasus bounces and kicks up a cloud puff.   Bright drum hits -> twinkles in the sky.
//   Bass              -> the big front clouds swell and rise.          Vocals -> the sun glows.
//   Lead guitar       -> glitter sheds from the rainbow trail.         Rhythm guitar -> the trail flares on each strum.
//   Piano             -> bubbles rise from the clouds.                 Other -> the big background rainbow fades in.
import {chordColor} from '../visual-color.js';

const TAU=Math.PI*2;
const ROUND='ui-rounded,"Arial Rounded MT Bold","Segoe UI Rounded","Segoe UI",system-ui,sans-serif';
const RAINBOW=[[350,85,82],[28,92,80],[50,92,77],[135,52,77],[198,72,79],[268,58,83]];
const PALETTES=[[262,58,83,18,88,89],[205,72,81,190,65,92],[290,42,79,30,92,86],[245,48,80,320,65,91]]; // dawn, day, sunset, lilac (top hsl, bottom hsl)
const BIRD={vocal:340,melody:198,instrumental:150};
const noChord=l=>!l||/^(N|N\.?C\.?|X)$/i.test(String(l).trim());
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const smoother=x=>x*x*x*(x*(6*x-15)+10);
const after=(a,t)=>{let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m].start<=t)lo=m+1;else hi=m;}return lo;};
const rng=seed=>{let s=seed;return()=>(s=s*16807%2147483647)/2147483647;};
const mkCanvas=(w,h)=>{const c=document.createElement('canvas');c.width=Math.max(1,Math.ceil(w));c.height=Math.max(1,Math.ceil(h));return c;};
const angLerp=(a,b,f)=>a+(((b-a+540)%360)-180)*f;
const hsl=(c,a=1)=>`hsla(${c[0]},${c[1]}%,${c[2]}%,${a})`;
const chordText=l=>String(l).replace(/^([A-G])#/,'$1♯').replace(/^([A-G])b/,'$1♭');

function analyze(song){
  const midi=song?.midi||{};
  let tracks=['melody','vocal'].map(n=>({name:n,hue:BIRD[n],notes:midi[n]?.notes||[]})).filter(d=>d.notes.length);
  if(!tracks.length&&midi.instrumental?.notes?.length)tracks=[{name:'instrumental',hue:BIRD.instrumental,notes:midi.instrumental.notes}];
  const all=[];
  for(const tr of tracks){tr.notes=tr.notes.filter(n=>n&&n.end>n.start).slice().sort((a,b)=>a.start-b.start);
    tr.maxDur=Math.min(20,tr.notes.reduce((m,n)=>Math.max(m,n.end-n.start),0));for(const n of tr.notes)all.push(n.pitch);}
  all.sort((a,b)=>a-b);
  let lo=60,hi=80;if(all.length){lo=all[Math.floor(all.length*0.02)];hi=all[Math.min(all.length-1,Math.floor(all.length*0.98))];}
  if(hi-lo<12){const m=(lo+hi)/2;lo=m-6;hi=m+6;}
  const gates=(song?.chords||[]).filter(c=>!noChord(c.label)&&c.end>c.start);
  return {tracks,lo,hi,gates};
}

export default {
  id:'skyward',
  name:'Skyward',
  order:45,
  create(){
    let w=0,h=0,k=1,L=null,layKey='',info=null,infoKey='',songRef=null,S=null;
    let sky=PALETTES[1].slice(),skyT=sky.slice(),lastSec=null,cHue=200,cAmt=0;
    let lastT=null,squash=0,rhyFlare=0,bassS=0,vocS=0,leadS=0,otherS=0,glitAcc=0;
    const sparks=[],puffs=[],bubbles=[],glyphs=[];
    const fracMemo=new Map();
    const rnd=Math.random;

    function frac(label){ // stable gap height per chord: circle-of-fifths root spread out so neighbours differ
      let f=fracMemo.get(label);if(f!==undefined)return f;
      const c=chordColor(label),r=c.root??0;f=((r*5)%12)/11+(c.minor?0.04:0);fracMemo.set(label,f);return f;
    }
    const gapY=label=>L.top+L.M*(0.3+0.4*frac(label));
    function pathY(t){
      const G=info.gates;if(!G.length)return L.top+L.M*0.5;
      const i=after(G,t),a=G[i-1],b=G[i];
      if(!a)return gapY(b.label);if(!b)return gapY(a.label);
      const x=clamp((t-a.start)/(b.start-a.start),0,1),s=x<0.12?0:(x-0.12)/0.88;
      const ya=gapY(a.label),yb=gapY(b.label);return ya+(yb-ya)*smoother(s);
    }

    function ensureInfo(song){
      const key=(song?.chords?.length||0)+'|'+Object.entries(song?.midi||{}).map(([a,b])=>a+(b?.notes?.length||0)).join(',');
      if(song===songRef&&key===infoKey&&info)return;songRef=song;infoKey=key;info=analyze(song);
    }

    // ---------- pre-rendered art
    function off(W,H){const c=mkCanvas(W*k,H*k),x=c.getContext('2d');x.scale(k,k);return [c,x];}
    function glowSprite(col){const c=mkCanvas(64,64),x=c.getContext('2d'),gr=x.createRadialGradient(32,32,0,32,32,32);gr.addColorStop(0,col(1));gr.addColorStop(0.35,col(0.4));gr.addColorStop(1,col(0));x.fillStyle=gr;x.fillRect(0,0,64,64);return c;}
    function cloudSprite(seed,W,H,top,bottom){
      const [c,x]=off(W,H),r=rng(seed),blobs=[];
      const n=5+Math.floor(r()*3);for(let i=0;i<n;i++){const q=(i+0.5)/n;blobs.push([W*(0.12+0.76*q),H*(0.62-0.32*Math.sin(q*Math.PI)*(0.7+r()*0.5)),H*(0.22+0.2*Math.sin(q*Math.PI)+r()*0.08)]);}
      blobs.push([W*0.5,H*0.72,H*0.26]);
      const gr=x.createLinearGradient(0,H*0.15,0,H*0.95);gr.addColorStop(0,top);gr.addColorStop(1,bottom);
      x.filter=`blur(${Math.max(0.5,H*0.012*k)}px)`;x.fillStyle=gr;x.beginPath();for(const [bx,by,br] of blobs){x.moveTo(bx+br,by);x.arc(bx,by,br,0,TAU);}x.fill();x.filter='none';
      x.fillStyle='rgba(255,255,255,0.55)';x.beginPath();for(const [bx,by,br] of blobs){x.moveTo(bx+br*0.5,by-br*0.35);x.arc(bx-br*0.15,by-br*0.35,br*0.45,0,TAU);}x.fill();
      return c;
    }
    function drawPegasus(x){
      const OUT='hsl(262,32%,66%)',FILL='hsl(285,70%,98.5%)',SH='hsl(268,45%,90%)';
      x.lineJoin='round';x.lineCap='round';
      const curls=(pts,lw)=>{x.fillStyle=OUT;for(const p of pts){x.beginPath();x.arc(p[0],p[1],p[2]+lw,0,TAU);x.fill();}for(const p of pts){x.fillStyle=hsl(p[3]);x.beginPath();x.arc(p[0],p[1],p[2],0,TAU);x.fill();x.fillStyle='rgba(255,255,255,0.45)';x.beginPath();x.arc(p[0]-p[2]*0.3,p[1]-p[2]*0.35,p[2]*0.35,0,TAU);x.fill();}};
      const tail=[];for(let i=6;i>=0;i--){const q=i/6;tail.push([-46-60*q,-4+26*q-18*Math.sin(q*Math.PI),15-6*q,RAINBOW[i%6]]);}
      curls(tail,2.6);
      const legs=[[[-12,28],[-28,46],[-20,58]],[[18,28],[34,44],[28,57]],[[-28,26],[-46,42],[-38,56]],[[30,26],[48,38],[42,53]]];
      for(const [i,l] of legs.entries()){
        const path=()=>{x.beginPath();x.moveTo(...l[0]);x.lineTo(...l[1]);x.lineTo(...l[2]);};
        path();x.strokeStyle=OUT;x.lineWidth=15;x.stroke();path();x.strokeStyle=i<2?SH:FILL;x.lineWidth=10;x.stroke();
        const hx=l[1][0]+(l[2][0]-l[1][0])*0.55,hy=l[1][1]+(l[2][1]-l[1][1])*0.55;x.beginPath();x.moveTo(hx,hy);x.lineTo(...l[2]);x.strokeStyle='hsl(305,50%,84%)';x.stroke();
      }
      const shapes=[
        ()=>{x.beginPath();x.ellipse(0,8,52,31,0,0,TAU);},
        ()=>{x.beginPath();x.moveTo(22,-6);x.lineTo(42,-56);x.lineTo(64,-48);x.lineTo(48,10);x.closePath();},
        ()=>{x.beginPath();x.arc(60,-56,24,0,TAU);},
        ()=>{x.beginPath();x.ellipse(80,-44,19,15,0.15,0,TAU);},
        ()=>{x.beginPath();x.moveTo(49,-74);x.lineTo(43,-95);x.lineTo(61,-80);x.closePath();},
      ];
      x.strokeStyle=OUT;x.lineWidth=5.2;for(const s of shapes){s();x.stroke();}
      const gr=x.createLinearGradient(0,-80,0,40);gr.addColorStop(0,FILL);gr.addColorStop(0.7,FILL);gr.addColorStop(1,SH);
      x.fillStyle=gr;for(const s of shapes){s();x.fill();}
      x.fillStyle='hsl(340,80%,88%)';x.beginPath();x.moveTo(49.5,-78);x.lineTo(46,-90);x.lineTo(56,-81);x.closePath();x.fill();
      const mane=[];for(let i=6;i>=0;i--){const q=i/6;mane.push([48-26*q-7*Math.sin(q*Math.PI),-80+72*q,12-3*q,RAINBOW[i%6]]);}
      curls(mane,2.6);curls([[62,-79,8,RAINBOW[5]]],2.4);
      x.beginPath();x.moveTo(58,-78);x.lineTo(84,-116);x.lineTo(70,-75);x.closePath();
      x.strokeStyle='hsl(36,55%,62%)';x.lineWidth=3.4;x.stroke();x.fillStyle='hsl(46,95%,85%)';x.fill();
      x.strokeStyle='hsl(36,70%,70%)';x.lineWidth=1.6;for(let i=1;i<4;i++){const q=i/4;x.beginPath();x.moveTo(58+26*q-0.5,-78-38*q+3);x.lineTo(70+14*q,-75-41*q-2);x.stroke();}
      x.fillStyle='hsl(265,40%,24%)';x.beginPath();x.ellipse(68,-55,6.2,8.8,0,0,TAU);x.fill();
      x.fillStyle='#fff';x.beginPath();x.arc(70,-58.5,2.7,0,TAU);x.fill();x.beginPath();x.arc(66.5,-51,1.3,0,TAU);x.fill();
      x.strokeStyle='hsl(265,40%,24%)';x.lineWidth=1.8;x.beginPath();x.moveTo(72,-62);x.lineTo(76,-65);x.moveTo(73.5,-59);x.lineTo(78,-60.5);x.stroke();
      x.fillStyle='hsla(345,95%,78%,0.75)';x.beginPath();x.ellipse(77,-43,6.5,3.6,0,0,TAU);x.fill();
      x.fillStyle='hsl(300,25%,60%)';x.beginPath();x.arc(93,-44,1.6,0,TAU);x.fill();
      x.strokeStyle='hsl(300,25%,60%)';x.lineWidth=1.8;x.beginPath();x.arc(86,-38,5,0.3,1.3);x.stroke();
    }
    function drawWing(x,dark){
      const OUT='hsl(262,32%,66%)',lobes=[[-2.3,60,12],[-2.05,74,14],[-1.8,82,15],[-1.55,70,14]];
      x.lineJoin='round';
      const lobe=([a,len,wd])=>{x.beginPath();x.ellipse(Math.cos(a)*len/2,Math.sin(a)*len/2,len/2,wd,a,0,TAU);};
      x.strokeStyle=OUT;x.lineWidth=5;for(const l of lobes){lobe(l);x.stroke();}
      for(const [i,l] of lobes.entries()){const gr=x.createLinearGradient(0,0,Math.cos(l[0])*l[1],Math.sin(l[0])*l[1]);
        gr.addColorStop(0,dark?'hsl(270,35%,86%)':'hsl(285,70%,98.5%)');gr.addColorStop(0.6,dark?'hsl(275,40%,84%)':'hsl(300,70%,96%)');gr.addColorStop(1,dark?'hsl(310,45%,80%)':hsl(RAINBOW[[0,5,4,0][i]]));
        x.fillStyle=gr;lobe(l);x.fill();}
    }
    function buildArt(){
      const u=L.u;let x,gr;S={};
      S.glowW=glowSprite(a=>`rgba(255,250,240,${a})`);S.glowSun=glowSprite(a=>`hsla(48,100%,80%,${a})`);
      S.puff=glowSprite(a=>`rgba(255,255,255,${a*0.9})`);
      S.clouds=[0,1,2,3].map(i=>cloudSprite(11+i*97,u*0.42,u*0.2,'#ffffff','hsl(265,45%,92%)'));
      S.cloudsFar=[0,1,2].map(i=>cloudSprite(501+i*31,u*0.42,u*0.2,'rgba(255,255,255,0.95)','hsla(280,50%,94%,0.95)'));
      S.gates=[];for(let i=0;i<12;i++)S.gates.push(cloudSprite(900+i,L.gs*1.5,L.gs,`hsl(${i*30},85%,93%)`,`hsl(${i*30},55%,81%)`));
      // background rainbow arch
      [S.rainbow,x]=off(w,h);const cx=w*0.62,cy=h*1.08,R0=Math.max(w,h)*0.62,bw=u*0.032;
      x.filter=`blur(${Math.max(1,u*0.008*k)}px)`;
      RAINBOW.forEach((c,i)=>{x.strokeStyle=hsl(c);x.lineWidth=bw*1.05;x.beginPath();x.arc(cx,cy,R0-i*bw,Math.PI,TAU);x.stroke();});x.filter='none';
      // bottom haze
      [S.haze,x]=off(w,h);gr=x.createLinearGradient(0,L.bot-u*0.15,0,h);gr.addColorStop(0,'rgba(255,250,255,0)');gr.addColorStop(1,'hsla(275,40%,80%,0.28)');x.fillStyle=gr;x.fillRect(0,0,w,h);
      // pegasus parts
      const s=L.ps;
      [S.body,x]=off(240*s,192*s);x.scale(s,s);x.translate(118,120);drawPegasus(x);
      [S.wing,x]=off(130*s,125*s);x.scale(s,s);x.translate(100,100);drawWing(x,false);
      [S.wingFar,x]=off(130*s,125*s);x.scale(s,s);x.translate(100,100);drawWing(x,true);
    }
    function ensure(env,g){
      const zc=env.zones.chord,zl=env.zones.lyrics,kk=clamp(g.getTransform?Math.abs(g.getTransform().a):1,1,2);
      const key=[w,h,kk,zc.bottom,zl?zl.top:-1].join('|');if(key===layKey)return;layKey=key;k=kk;
      const u=Math.min(w,h),top=zc.bottom,bot=zl?zl.top:h*0.97,M=Math.max(bot-top,h*0.3);
      L={u,top,bot,M,pegX:w*0.27,speed:u*0.42,ps:u*0.24/240,gs:u*0.12,gap:M*0.22,sun:{x:w*0.83,y:Math.max(u*0.12,zc.bottom*0.55),r:u*0.06}};
      const r=rng(77),layer=(n,f,y0,y1,sc,set)=>{const arr=[];for(let i=0;i<n;i++)arr.push({x0:r()*(w+u*0.9),y:y0+(y1-y0)*r(),v:Math.floor(r()*set),sc:sc*(0.75+r()*0.5),ph:r()*TAU});return {arr,f};};
      L.far=layer(7,0.15,h*0.05,top+M*0.55,0.55,3);L.mid=layer(5,0.4,top+M*0.15,bot,0.85,4);L.near=layer(7,1.35,bot+u*0.06,h+u*0.08,1.15,4);
      buildArt();
    }

    // ---------- small helpers
    function star(g,x,y,r){g.beginPath();g.moveTo(x,y-r);g.quadraticCurveTo(x,y,x+r,y);g.quadraticCurveTo(x,y,x,y+r);g.quadraticCurveTo(x,y,x-r,y);g.quadraticCurveTo(x,y,x,y-r);g.fill();}
    function sparkle(x,y,vx,vy,r,hue,life){if(sparks.length<220)sparks.push({x,y,vx,vy,r,hue,age:0,max:life});}
    function drawLayer(g,lay,t,sprites,alpha,extra){
      const u=L.u,tw=w+u*0.9;
      for(const c of lay.arr){const x=((c.x0-t*L.speed*lay.f)%tw+tw)%tw-u*0.45,sp=sprites[c.v%sprites.length],sc=c.sc*(extra?extra.scale:1);
        const cw=u*0.42*sc,chh=u*0.2*sc,y=c.y+Math.sin(L.wall*0.5+c.ph)*u*0.004-(extra?extra.lift:0);
        g.globalAlpha=alpha;g.drawImage(sp,x-cw/2,y-chh/2,cw,chh);}
      g.globalAlpha=1;
    }
    function bird(g,x,y,r,hue,flap,singing){
      if(singing){const s=r*7;g.globalAlpha=0.7;g.drawImage(S.glowW,x-s/2,y-s/2,s,s);g.globalAlpha=1;}
      g.fillStyle=`hsl(${hue},55%,72%)`;g.beginPath();g.moveTo(x-r*0.8,y);g.lineTo(x-r*1.7,y-r*0.5);g.lineTo(x-r*1.6,y+r*0.4);g.closePath();g.fill();
      g.fillStyle=`hsl(${hue},75%,82%)`;g.beginPath();g.arc(x,y,r,0,TAU);g.fill();
      g.fillStyle=`hsl(${hue},80%,93%)`;g.beginPath();g.ellipse(x+r*0.15,y+r*0.35,r*0.6,r*0.45,0,0,TAU);g.fill();
      g.fillStyle=`hsl(${hue},55%,70%)`;g.beginPath();g.ellipse(x-r*0.25,y-r*0.1,r*0.62,r*0.32,-0.5-flap*0.9,0,TAU);g.fill();
      g.fillStyle='hsl(265,35%,25%)';g.beginPath();g.arc(x+r*0.42,y-r*0.22,r*0.16,0,TAU);g.fill();
      g.fillStyle='hsl(40,95%,72%)';
      if(singing){g.beginPath();g.moveTo(x+r*0.85,y-r*0.1);g.lineTo(x+r*1.5,y-r*0.3);g.lineTo(x+r*0.9,y+r*0.02);g.fill();g.beginPath();g.moveTo(x+r*0.85,y+r*0.08);g.lineTo(x+r*1.4,y+r*0.35);g.lineTo(x+r*0.9,y+r*0.2);g.fill();}
      else{g.beginPath();g.moveTo(x+r*0.85,y-r*0.12);g.lineTo(x+r*1.45,y+r*0.02);g.lineTo(x+r*0.85,y+r*0.16);g.fill();}
      g.fillStyle='hsla(345,95%,80%,0.7)';g.beginPath();g.arc(x+r*0.55,y+r*0.15,r*0.13,0,TAU);g.fill();
    }

    return {
      resize(nw,nh){w=nw;h=nh;layKey='';},
      draw(g,frame,env){
        w=env.w;h=env.h;
        const {wall,calm}=env,dt=env.dt||1/60,t=frame.time||0,tr=frame.tracks||{},ev=env.events||{},playing=!!frame.playing;
        ensureInfo(env.song);ensure(env,g);L.wall=wall;
        const u=L.u,sp=L.speed,pegX=L.pegX,prevT=lastT,jumped=lastT==null||t<lastT-0.02||t-lastT>0.5;lastT=t;
        // palette: section sets the time of day, the chord tints the top of the sky
        const si=frame.section?.index??-1;
        if(si!==lastSec){skyT=PALETTES[((si%4)+4)%4].slice();if(lastSec===null||jumped)sky=skyT.slice();lastSec=si;}
        for(let i=0;i<6;i++)sky[i]+=(skyT[i]-sky[i])*Math.min(1,dt*0.8);
        const lab=frame.chord?.label;
        if(!noChord(lab)){cHue=angLerp(cHue,chordColor(lab).hue,Math.min(1,dt*2));cAmt=Math.min(1,cAmt+dt);}else cAmt=Math.max(0,cAmt-dt);
        const sm=(v,x,r)=>v+((x??0)-v)*Math.min(1,dt*r);
        bassS=sm(bassS,tr.bass?.level,10);vocS=sm(vocS,tr.vocals?.level,6);leadS=sm(leadS,tr.lead?.level,8);otherS=sm(otherS,tr.other?.level,3);
        // pegasus pose (song time)
        const b=frame.beat,slow=(b?.bpm||0)>160,beatPh=b?.bar!=null&&playing?(slow?(((b.beat-1)%2)+b.phase)/2:b.phase):(wall*1.1)%1;
        const flap=0.5+0.5*Math.cos(beatPh*TAU);                      // 1 = wing down, on the beat
        const py=pathY(t)+Math.sin(beatPh*TAU+0.6)*u*0.006;
        const dy=pathY(t+0.08)-pathY(t-0.08),tilt=clamp(Math.atan2(dy,sp*0.16)*0.7,-0.4,0.4);
        // reactions
        const bright=(tr.drums?.brightness??0.3)>=0.45;
        for(const s of ev.hits?.drums||[]){
          if(bright){const n=calm?1:2;for(let i=0;i<n;i++)sparkle(rnd()*w,rnd()*(L.top+L.M*0.4),0,0,u*(0.008+rnd()*0.01)*(0.6+s*0.6),[48,330,198,268][Math.floor(rnd()*4)],0.55);}
          else{if(!calm)squash=Math.max(squash,s);for(let i=0;i<(calm?2:4);i++)puffs.push({x:pegX-u*0.02+rnd()*u*0.05,y:py+L.ps*55,vx:-sp*(0.3+rnd()*0.3),vy:u*(rnd()-0.6)*0.08,s:u*(0.03+rnd()*0.03),age:0,max:0.7});}
        }
        for(const s of ev.hits?.rhythm||[])rhyFlare=Math.max(rhyFlare,s);
        for(const s of ev.hits?.piano||[])if(bubbles.length<40)bubbles.push({x:rnd()*w,y:L.bot+u*0.03,vy:-u*(0.07+rnd()*0.07),r:u*(0.01+0.014*s+rnd()*0.008),ph:rnd()*TAU,age:0,hue:Math.floor(rnd()*360)});
        if(ev.chordChanged)for(let i=0;i<(calm?5:12);i++){const a=rnd()*TAU,v=u*(0.1+rnd()*0.25);sparkle(pegX+u*0.03,py-u*0.03,Math.cos(a)*v-sp*0.4,Math.sin(a)*v,u*(0.008+rnd()*0.008),RAINBOW[i%6][0],0.6+rnd()*0.4);}
        const dec=r=>Math.exp(-dt*r);squash*=dec(9);rhyFlare*=dec(6);
        // sky
        const topHue=angLerp(sky[0],cHue,0.22*cAmt),grd=g.createLinearGradient(0,0,0,h);
        grd.addColorStop(0,`hsl(${topHue},${sky[1]}%,${sky[2]}%)`);grd.addColorStop(1,`hsl(${sky[3]},${sky[4]}%,${sky[5]}%)`);
        g.fillStyle=grd;g.fillRect(0,0,w,h);
        // sun (vocals)
        const sn=L.sun,gl=sn.r*(4+3*vocS);g.globalAlpha=0.55+0.45*vocS;g.drawImage(S.glowSun,sn.x-gl/2,sn.y-gl/2,gl,gl);g.globalAlpha=1;
        g.fillStyle='hsl(48,100%,88%)';g.beginPath();g.arc(sn.x,sn.y,sn.r,0,TAU);g.fill();
        g.strokeStyle='hsl(30,60%,62%)';g.lineWidth=Math.max(1.2,u*0.003);g.lineCap='round';
        g.beginPath();g.arc(sn.x-sn.r*0.32,sn.y-sn.r*0.05,sn.r*0.13,Math.PI*1.1,Math.PI*1.9);g.stroke();
        g.beginPath();g.arc(sn.x+sn.r*0.32,sn.y-sn.r*0.05,sn.r*0.13,Math.PI*1.1,Math.PI*1.9);g.stroke();
        g.beginPath();g.arc(sn.x,sn.y+sn.r*0.12,sn.r*0.22,0.2*Math.PI,0.8*Math.PI);g.stroke();
        g.fillStyle='hsla(345,95%,80%,0.6)';g.beginPath();g.arc(sn.x-sn.r*0.55,sn.y+sn.r*0.2,sn.r*0.12,0,TAU);g.arc(sn.x+sn.r*0.55,sn.y+sn.r*0.2,sn.r*0.12,0,TAU);g.fill();
        // background rainbow (other)
        g.globalAlpha=tr.other?0.12+0.55*Math.min(1,otherS*1.4):0.3;g.drawImage(S.rainbow,0,0,w,h);g.globalAlpha=1;
        drawLayer(g,L.far,t,S.cloudsFar,0.7);drawLayer(g,L.mid,t,S.clouds,0.9);
        // chord gates
        const G=info.gates,gs=L.gs,gw=gs*1.5,i0=after(G,t-(pegX+gw)/sp);
        g.font=`700 ${Math.round(u*0.03)}px ${ROUND}`;g.textAlign='center';g.textBaseline='middle';
        for(let i=i0;i<G.length;i++){
          const c=G[i],x=pegX+(c.start-t)*sp;if(x>w+gw)break;if(x<-gw)continue;
          const yc=gapY(c.label),hh=chordColor(c.label).hue,spr=S.gates[Math.round(hh/30)%12];
          const since=t-c.start,pop=since>0&&since<0.5&&!calm?Math.sin(since*18)*Math.exp(-since*7)*0.08:0,gwp=gw*(1+pop),ghp=gs*(1+pop);
          const tops=[],bots=[];
          for(let y=yc-L.gap-gs*0.32;y>-gs;y-=gs*0.42)tops.push(y);
          for(let y=yc+L.gap+gs*0.32;y<h+gs;y+=gs*0.42)bots.push(y);
          for(let j=tops.length-1;j>=0;j--)g.drawImage(spr,x-gwp/2,tops[j]-ghp/2,gwp,ghp);
          for(let j=bots.length-1;j>=0;j--)g.drawImage(spr,x-gwp/2,bots[j]-ghp/2,gwp,ghp);
          const txt=chordText(c.label),tw=g.measureText(txt).width,ph=u*0.045,pw=tw+u*0.035,ty=yc-L.gap-gs*0.2;
          g.fillStyle='rgba(255,255,255,0.92)';g.beginPath();g.roundRect(x-pw/2,ty-ph/2,pw,ph,ph/2);g.fill();
          g.strokeStyle=`hsl(${hh},60%,78%)`;g.lineWidth=Math.max(1.5,u*0.003);g.stroke();
          g.fillStyle=`hsl(${hh},55%,38%)`;g.fillText(txt,x,ty+u*0.002);
        }
        // rainbow trail = the path flown
        const s=L.ps,tailX=pegX-48*s,bw=u*0.0085*(1+0.6*rhyFlare*(calm?0.5:1)),steps=Math.ceil((tailX+u*0.05)/sp*30);
        const pts=new Float32Array((steps+1)*2);
        for(let j=0;j<=steps;j++){const tau=t-j/30;pts[j*2]=tailX-(t-tau)*sp;pts[j*2+1]=pathY(tau);}
        g.lineCap='round';g.lineJoin='round';g.lineWidth=bw*1.08;
        RAINBOW.forEach((c,ci)=>{const off=(ci-2.5)*bw;g.strokeStyle=hsl([c[0],c[1],c[2]+rhyFlare*6],0.9);g.beginPath();g.moveTo(pts[0],pts[1]+off);for(let j=1;j<=steps;j++)g.lineTo(pts[j*2],pts[j*2+1]+off);g.stroke();});
        if(playing&&leadS>0.05){glitAcc+=dt*leadS*(calm?12:36);while(glitAcc>=1){glitAcc-=1;const j=Math.floor(rnd()*Math.min(steps,40));sparkle(pts[j*2],pts[j*2+1]+(rnd()-0.5)*bw*6,-sp*0.2,u*0.02,u*(0.004+rnd()*0.005),RAINBOW[Math.floor(rnd()*6)][0],0.7);}}
        // pegasus
        const rot=0.35-1.3*flap,q=squash;
        g.save();g.translate(pegX,py);g.rotate(tilt);g.scale(s*(1+0.05*q),s*(1-0.07*q));
        g.save();g.translate(14,-20);g.rotate(rot*0.92-0.08);g.drawImage(S.wingFar,-100,-100,130,125);g.restore();
        g.drawImage(S.body,-118,-120,240,192);
        g.save();g.translate(8,-16);g.rotate(rot);g.drawImage(S.wing,-100,-100,130,125);g.restore();
        g.restore();
        // birds = upcoming MIDI notes; height = pitch
        const pyN=p=>L.top+L.M*0.05+(1-clamp((p-info.lo)/(info.hi-info.lo),0,1))*L.M*0.5;
        const tMin=t-(pegX+u*0.08)/sp,tMax=t+(w-pegX+u*0.08)/sp;
        for(const trk of info.tracks){
          const a=trk.notes,hue=trk.hue;let idx=0;
          for(let i=after(a,tMin-trk.maxDur);i<a.length;i++){const n=a[i];if(n.start>tMax)break;if(n.end<tMin)continue;
            const x0=pegX+(n.start-t)*sp,x1=pegX+(n.end-t)*sp,y=pyN(n.pitch),on=t>=n.start&&t<n.end,r=u*0.02;
            g.strokeStyle=on?`hsla(${hue},95%,88%,0.95)`:`hsla(${hue},80%,90%,0.55)`;g.lineWidth=r*(on?0.7:0.5);g.lineCap='round';
            if(x1-x0>r*1.5){g.beginPath();g.moveTo(x0,y);g.lineTo(x1,y);g.stroke();}
            bird(g,x0,y,r,hue,Math.sin(wall*14+i*1.7),on);idx++;}
          if(playing&&!jumped&&prevT!=null)for(let i=after(a,prevT);i<a.length&&a[i].start<=t;i++){
            if(glyphs.length<40)glyphs.push({x:pegX+(a[i].start-t)*sp+u*0.02,y:pyN(a[i].pitch)-u*0.02,hue,age:0,max:1.3,ch:rnd()<0.5?'♪':'♫'});}
        }
        // particles
        g.globalCompositeOperation='source-over';
        for(let i=puffs.length-1;i>=0;i--){const p=puffs[i];p.age+=dt;if(p.age>p.max){puffs[i]=puffs[puffs.length-1];puffs.pop();continue;}
          p.x+=p.vx*dt;p.y+=p.vy*dt;const qq=p.age/p.max,ss=p.s*(1+qq*1.5);g.globalAlpha=(1-qq)*0.8;g.drawImage(S.puff,p.x-ss/2,p.y-ss/2,ss,ss);}
        for(let i=bubbles.length-1;i>=0;i--){const bb=bubbles[i];bb.age+=dt;bb.y+=bb.vy*dt;const bx=bb.x+Math.sin(bb.age*2.5+bb.ph)*u*0.012;
          if(bb.y<L.top-u*0.05||bb.age>8){bubbles[i]=bubbles[bubbles.length-1];bubbles.pop();continue;}
          g.globalAlpha=Math.min(1,bb.age*3)*0.9;g.fillStyle=`hsla(${bb.hue},90%,90%,0.18)`;g.strokeStyle=`hsla(${bb.hue},70%,96%,0.9)`;g.lineWidth=Math.max(1,u*0.0022);
          g.beginPath();g.arc(bx,bb.y,bb.r,0,TAU);g.fill();g.stroke();g.fillStyle='rgba(255,255,255,0.85)';g.beginPath();g.arc(bx-bb.r*0.35,bb.y-bb.r*0.35,bb.r*0.22,0,TAU);g.fill();}
        g.globalAlpha=1;
        for(let i=sparks.length-1;i>=0;i--){const p=sparks[i];p.age+=dt;if(p.age>p.max){sparks[i]=sparks[sparks.length-1];sparks.pop();continue;}
          p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=Math.exp(-dt*2);p.vy*=Math.exp(-dt*2);const qq=p.age/p.max,a=qq<0.2?qq/0.2:1-(qq-0.2)/0.8,rr=p.r*(0.6+0.6*Math.sin(qq*Math.PI));
          g.globalAlpha=a*0.5;g.drawImage(S.glowW,p.x-rr*3,p.y-rr*3,rr*6,rr*6);g.globalAlpha=a;g.fillStyle=`hsl(${p.hue},95%,86%)`;star(g,p.x,p.y,rr*1.6);g.fillStyle='#fff';star(g,p.x,p.y,rr*0.8);}
        g.globalAlpha=1;
        g.font=`700 ${Math.round(u*0.034)}px ${ROUND}`;g.textAlign='center';g.textBaseline='middle';g.lineJoin='round';
        for(let i=glyphs.length-1;i>=0;i--){const p=glyphs[i];p.age+=dt;if(p.age>p.max){glyphs[i]=glyphs[glyphs.length-1];glyphs.pop();continue;}
          const qq=p.age/p.max,x=p.x-sp*0.3*p.age+Math.sin(p.age*5)*u*0.006,y=p.y-u*0.07*p.age;
          g.globalAlpha=1-qq*qq;g.strokeStyle='rgba(255,255,255,0.95)';g.lineWidth=u*0.006;g.strokeText(p.ch,x,y);g.fillStyle=`hsl(${p.hue},60%,55%)`;g.fillText(p.ch,x,y);}
        g.globalAlpha=1;
        // big front clouds (bass)
        drawLayer(g,L.near,t,S.clouds,0.85,{scale:1+0.07*bassS,lift:bassS*u*0.03});
        g.drawImage(S.haze,0,0,w,h);
      },
      dispose(){S=null;sparks.length=puffs.length=bubbles.length=glyphs.length=0;},
    };
  },
};
