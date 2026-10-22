// Cozy: rain on leaves, close up. A few big soft leaves in front of a blurred evening garden full of warm bokeh. Each drum hit is a
// raindrop that falls onto a leaf and lands exactly on the hit (the hits are known ahead of time), splashing and rippling; kicks are big
// drops, hi-hats a fine patter. The bass bobs the leaves, a chord change sends a soft gust through them, the chord tints the light
// (warmer for major, cooler for minor), the vocals make the bokeh glow, and the sung melody drifts up as fireflies.
import {chordColor} from './visual-color.js';

const FALL=0.32;                                   // seconds a drop is seen falling before it lands
const LEAVES=[                                     // base (fraction of the screen), angle, length and width (fraction of the short side), tone
  {bx:-0.06,by:0.70,angle:-0.30,len:0.95,wid:0.26,tone:0},
  {bx:1.06,by:0.56,angle:Math.PI+0.36,len:0.85,wid:0.24,tone:1},
  {bx:0.30,by:1.10,angle:-1.25,len:0.70,wid:0.20,tone:2},
  {bx:0.80,by:1.12,angle:-1.92,len:0.66,wid:0.19,tone:1},
];
const TONES=[[96,38,24],[112,34,20],[84,40,28]];   // hue, saturation, lightness of each leaf

function leafPath(L,W){
  const p=new Path2D();
  p.moveTo(0,0);p.bezierCurveTo(L*0.28,-W*0.95,L*0.72,-W*0.78,L,0);p.bezierCurveTo(L*0.72,W*0.78,L*0.28,W*0.95,0,0);p.closePath();
  return p;
}
// One leaf drawn once into its own canvas (lit from the upper left), so each frame only has to place it.
function leafSprite(L,W,[hue,sat,light],blur){
  const pad=Math.ceil(W*0.6+blur*3),c=document.createElement('canvas');c.width=Math.ceil(L+pad*2);c.height=Math.ceil(W*2+pad*2);
  const g=c.getContext('2d');g.translate(pad,c.height/2);if(blur)g.filter=`blur(${blur}px)`;
  const path=leafPath(L,W);
  const body=g.createLinearGradient(0,-W,L*0.4,W);body.addColorStop(0,`hsl(${hue},${sat+10}%,${light+14}%)`);body.addColorStop(0.55,`hsl(${hue},${sat}%,${light}%)`);body.addColorStop(1,`hsl(${hue+8},${sat}%,${light-12}%)`);
  g.fillStyle=body;g.fill(path);
  g.save();g.clip(path);
  const sheen=g.createRadialGradient(L*0.35,-W*0.35,0,L*0.35,-W*0.35,L*0.55);sheen.addColorStop(0,'rgba(255,255,230,.22)');sheen.addColorStop(1,'rgba(255,255,230,0)');
  g.fillStyle=sheen;g.fillRect(0,-W,L,W*2);
  g.strokeStyle=`hsla(${hue-10},${sat}%,${light+30}%,.55)`;g.lineWidth=Math.max(1.5,W*0.035);
  g.beginPath();g.moveTo(-1,0);g.quadraticCurveTo(L*0.5,-W*0.06,L,0);g.stroke();               // midrib
  g.lineWidth=Math.max(1,W*0.016);g.strokeStyle=`hsla(${hue-10},${sat}%,${light+24}%,.35)`;
  for(let i=1;i<=8;i++){const x=L*i/9.5;for(const side of [-1,1]){g.beginPath();g.moveTo(x,-W*0.03*side*-1);g.quadraticCurveTo(x+L*0.07,side*W*0.35,x+L*0.16,side*W*0.62*Math.sin(Math.PI*(x+L*0.16)/L));g.stroke();}}
  g.restore();
  g.strokeStyle=`hsla(${hue},${sat}%,${light+28}%,.35)`;g.lineWidth=Math.max(1,W*0.012);g.stroke(path);                 // rim light
  g.strokeStyle=`hsl(${hue},${sat-5}%,${light-4}%)`;g.lineWidth=W*0.07;g.lineCap='round';g.beginPath();g.moveTo(-W*0.9,W*0.12);g.lineTo(0,0);g.stroke();   // stalk
  return {canvas:c,pad,path};
}
function backdrop(w,h){
  const c=document.createElement('canvas');c.width=Math.max(1,Math.round(w/2));c.height=Math.max(1,Math.round(h/2));   // half size: it is all blur
  const g=c.getContext('2d'),s=0.5;g.scale(s,s);
  const sky=g.createLinearGradient(0,0,0,h);sky.addColorStop(0,'#0b1a1f');sky.addColorStop(0.6,'#0f231c');sky.addColorStop(1,'#0a1410');
  g.fillStyle=sky;g.fillRect(0,0,w,h);
  g.filter='blur(14px)';
  let seed=7;const rand=()=>(seed=(seed*16807)%2147483647)/2147483647;
  for(let i=0;i<26;i++){const x=rand()*w,y=h*0.15+rand()*h*0.75,r=Math.min(w,h)*(0.08+rand()*0.18);g.fillStyle=`hsla(${110+rand()*40},35%,${10+rand()*10}%,.8)`;g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fill();}
  return c;
}

export default {
  id:'cozy',name:'Cozy',
  create(){
    let w=0,h=0,u=1,bg=null,sprites=[],far=[],bokeh=[],glows=[],tintHue=40,gust=0,bob=0,lastTime=null;
    const drops=[],splashes=[],ripples=[],flies=[],rain=[],scheduled={};
    let seed=11;const rand=()=>(seed=(seed*16807)%2147483647)/2147483647;
    function layout(){
      u=Math.min(w,h);bg=backdrop(w,h);
      sprites=LEAVES.map(l=>({...l,L:l.len*u,W:l.wid*u/2,...leafSprite(l.len*u,l.wid*u/2,TONES[l.tone],0)}));
      far=[0,1,2,3,4].map(i=>({x:(0.1+i*0.21)*w,y:h*(0.35+0.25*((i*37)%5)/5),angle:-0.6+i*0.5,...leafSprite(u*0.4,u*0.07,[100+i*6,25,13],u*0.012)}));
      bokeh=Array.from({length:34},()=>({x:rand()*w,y:h*(0.05+rand()*0.75),r:u*(0.015+rand()*0.05),warm:rand()<0.7,phase:rand()*7,drift:(rand()-0.5)*0.01}));
      // a soft glow in each of 24 hues, drawn once: bokeh and fireflies pick the nearest (a gradient per light per frame is too slow)
      glows=Array.from({length:24},(_,i)=>{const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d'),grad=x.createRadialGradient(32,32,0,32,32,32);
        grad.addColorStop(0,`hsla(${i*15},80%,72%,1)`);grad.addColorStop(0.7,`hsla(${i*15},80%,60%,.5)`);grad.addColorStop(1,`hsla(${i*15},80%,60%,0)`);x.fillStyle=grad;x.fillRect(0,0,64,64);return c;});
    }
    // where a leaf is right now: base point and angle, including wind, bass bob and gusts
    function pose(leaf,wall){
      const sway=Math.sin(wall*0.6+leaf.tone*1.7)*0.025+Math.sin(wall*1.31+leaf.bx*5)*0.012;
      return {x:leaf.bx*w,y:leaf.by*h,angle:leaf.angle+sway+(leaf.tone%2?-1:1)*(bob*0.03+gust*0.06)+(leaf.dip||0)};
    }
    function toScreen(leaf,p,lx,ly){const c=Math.cos(p.angle),s=Math.sin(p.angle);return {x:p.x+lx*c-ly*s,y:p.y+lx*s+ly*c};}
    function landingSpot(strength){
      // big drops on the big leaves, small ones anywhere; a point well inside the leaf
      const pool=strength>0.6?sprites.slice(0,2):sprites,leaf=pool[Math.floor(rand()*pool.length)];
      const along=0.25+rand()*0.6,half=leaf.W*0.75*Math.sin(Math.PI*along);
      return {leaf,lx:along*leaf.L,ly:(rand()*2-1)*half*0.7};
    }
    return {
      resize(nw,nh){w=nw;h=nh;if(w&&h)layout();},
      draw(g,frame,env){
        if(!bg||env.w!==w||env.h!==h){w=env.w;h=env.h;layout();}
        const {dt,wall,calm}=env,t=frame.time;
        // a seek or a jump: forget scheduled drops
        if(lastTime===null||Math.abs(t-lastTime)>0.5||t<lastTime-0.02){for(const k in scheduled)delete scheduled[k];drops.length=0;}
        lastTime=t;
        // light: the chord tints it, warm for major, cool for minor
        const cc=chordColor(frame.chord.label),target=cc.root===null?40:cc.minor?200+(cc.hue%60)*0.4:30+(cc.hue%60)*0.3;   // amber-gold or blue-teal
        tintHue+=(((target-tintHue+540)%360)-180)*Math.min(1,dt*1.5);
        if(env.events.chordChanged)gust=1;gust=Math.max(0,gust-dt*0.9);
        const bass=frame.tracks.bass?.level||0;bob+=(bass-bob)*Math.min(1,dt*8);
        for(const leaf of sprites)leaf.dip=(leaf.dip||0)*Math.max(0,1-dt*6);

        // schedule raindrops for drum hits that land within the next FALL seconds
        const hits=env.song.features?.tracks.drums?.hits||[],gain=frame.tracks.drums?.gain??1;
        if(frame.playing&&gain>0){
          let i=scheduled.drums??Math.max(0,frame.tracks.drums?.hitIndex+1||0);
          while(i<hits.length&&hits[i].start<=t+FALL*frame.rate){
            if(hits[i].start>t){const spot=landingSpot(hits[i].strength);
              drops.push({...spot,land:hits[i].start,strength:hits[i].strength,size:u*(0.0022+0.005*hits[i].strength)});}
            i++;
          }
          scheduled.drums=i;
        }

        // ---- background: evening garden, bokeh that glows with the vocals ----
        g.drawImage(bg,0,0,w,h);
        const voice=Math.max(frame.tracks.vocals?.level||0,(frame.tracks.lead?.level||0)*0.6);
        g.globalCompositeOperation='lighter';
        for(const b of bokeh){
          const flicker=0.6+0.4*Math.sin(wall*0.7+b.phase),glow=(0.12+0.5*voice)*flicker;
          b.x+=b.drift*u*dt;if(b.x<-b.r)b.x=w+b.r;if(b.x>w+b.r)b.x=-b.r;
          const hue=b.warm?tintHue:(tintHue+150)%360;
          g.globalAlpha=Math.min(1,glow);g.drawImage(glows[Math.round(hue/15)%24],b.x-b.r,b.y-b.r,b.r*2,b.r*2);
        }
        g.globalAlpha=1;g.globalCompositeOperation='source-over';
        // far, blurred leaves
        for(const f of far){g.save();g.translate(f.x,f.y);g.rotate(f.angle+Math.sin(wall*0.4+f.x)*0.03);g.globalAlpha=0.55;g.drawImage(f.canvas,-f.pad,-f.canvas.height/2);g.restore();}
        // light rain in the air, always falling (heavier while the drums are busy)
        const want=Math.round(40+120*(frame.tracks.drums?.level||0)*(frame.playing?1:0.4));
        while(rain.length<want)rain.push({x:rand()*w*1.2,y:rand()*-h,v:h*(1.2+rand()*0.8),l:u*(0.02+rand()*0.03)});
        g.strokeStyle='rgba(200,220,230,.18)';g.lineWidth=1;g.beginPath();
        for(let i=rain.length-1;i>=0;i--){const r=rain[i];r.y+=r.v*dt;r.x-=r.v*dt*0.12;if(r.y>h){if(rain.length>want){rain.splice(i,1);continue;}r.y=-r.l;r.x=rand()*w*1.2;}g.moveTo(r.x,r.y);g.lineTo(r.x+r.l*0.12,r.y-r.l);}
        g.stroke();

        // ---- the leaves, with ripples on them ----
        for(const leaf of sprites){
          const p=pose(leaf,wall);
          g.save();g.translate(p.x,p.y);g.rotate(p.angle);
          g.drawImage(leaf.canvas,-leaf.pad,-leaf.canvas.height/2);
          g.clip(leaf.path);
          for(const r of ripples)if(r.leaf===leaf){
            const k=1-r.life;g.strokeStyle=`rgba(230,245,235,${r.life*0.55})`;g.lineWidth=Math.max(1,u*0.003)*(1+r.strength);
            g.beginPath();g.ellipse(r.lx,r.ly,u*0.06*r.strength*k+2,u*0.03*r.strength*k+1,0,0,Math.PI*2);g.stroke();
          }
          g.restore();
        }
        // ---- falling drops; when one lands: splash, ripple and a small dip of its leaf ----
        g.fillStyle='rgba(220,240,250,.6)';
        for(let i=drops.length-1;i>=0;i--){
          const d=drops[i],p=pose(d.leaf,wall),end=toScreen(d.leaf,p,d.lx,d.ly),left=(d.land-t)/frame.rate;
          if(left<=0){
            ripples.push({leaf:d.leaf,lx:d.lx,ly:d.ly,life:1,strength:0.4+d.strength});
            d.leaf.dip=(d.leaf.dip||0)+(d.leaf.tone%2?-1:1)*0.012*d.strength*(calm?0.4:1);
            const n=Math.round(4+d.strength*10);
            for(let q=0;q<n;q++){const a=-Math.PI/2+(rand()-0.5)*2.4,v=u*(0.12+rand()*0.35)*(0.5+d.strength);splashes.push({x:end.x,y:end.y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,life:1,size:u*0.0025*(1+rand()*1.5)});}
            drops.splice(i,1);continue;
          }
          const k=left/FALL,y=end.y-k*k*h*0.6,x=end.x+k*u*0.03;
          g.beginPath();g.ellipse(x,y,d.size*0.7,d.size*1.8,0,0,Math.PI*2);g.fill();
        }
        for(let i=ripples.length-1;i>=0;i--){ripples[i].life-=dt*1.4;if(ripples[i].life<=0)ripples.splice(i,1);}
        for(let i=splashes.length-1;i>=0;i--){
          const s=splashes[i];s.life-=dt*2.2;if(s.life<=0){splashes.splice(i,1);continue;}
          s.vy+=h*1.6*dt;s.x+=s.vx*dt;s.y+=s.vy*dt;
          g.fillStyle=`rgba(225,240,250,${s.life*0.8})`;g.beginPath();g.arc(s.x,s.y,s.size,0,Math.PI*2);g.fill();
        }
        // ---- fireflies: one rises from each new sung note, higher notes higher up ----
        const melody=frame.notes.vocal?.active.length?frame.notes.vocal:null;
        for(const n of melody?.active||[])if(frame.time-n.start<dt*1.5&&flies.length<60){
          const span=Math.max(12,melody.high-melody.low),y=h*(0.68-0.4*(n.pitch-melody.low)/span);
          flies.push({x:w*(0.15+rand()*0.7),y,vx:(rand()-0.5)*u*0.03,vy:-u*0.01,life:1,phase:rand()*6});
        }
        g.globalCompositeOperation='lighter';
        for(let i=flies.length-1;i>=0;i--){
          const f=flies[i];f.life-=dt*0.28;if(f.life<=0){flies.splice(i,1);continue;}
          f.x+=f.vx*dt+Math.sin(wall*1.3+f.phase)*u*0.01*dt;f.y+=f.vy*dt;
          const a=f.life*(0.6+0.4*Math.sin(wall*6+f.phase)),r=u*0.036;
          g.globalAlpha=a;g.drawImage(glows[Math.round((tintHue+20)/15)%24],f.x-r,f.y-r,r*2,r*2);
        }
        // ---- the light: a gentle wash in the chord's mood, and a vignette ----
        g.globalAlpha=1;g.globalCompositeOperation='source-over';g.fillStyle=`hsla(${tintHue},70%,50%,.1)`;g.fillRect(0,0,w,h);
        const v=g.createRadialGradient(w/2,h*0.5,u*0.3,w/2,h*0.5,Math.max(w,h)*0.75);v.addColorStop(0,'rgba(0,0,0,0)');v.addColorStop(1,'rgba(0,0,0,.55)');
        g.fillStyle=v;g.fillRect(0,0,w,h);
      },
    };
  },
};
