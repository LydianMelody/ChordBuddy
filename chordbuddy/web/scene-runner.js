// Runner: a fox in a scarf runs through a neon city at dusk. The world moves with song time, so it stops when the song pauses and every
// chord change arrives as a glowing hurdle (with the chord's name) that reaches the fox exactly as the chord changes: the fox clears it on
// the change. Its stride follows the beat; kicks pulse the street (and shake the camera, unless calm), the bass lights the windows, the
// vocals warm the sun, lead guitar draws speed streaks, and each section and chord shifts the sky.
import {chordColor,chordHsl} from './visual-color.js';

const SPEED=0.5;                 // world speed: fractions of the screen's short side per second of song
const JUMP=0.2;                  // seconds before and after a change that the fox is in the air

function lerpHue(from,to,k){const d=((to-from+540)%360)-180;return (from+d*k+360)%360;}

// A strip of skyline drawn once, tiled endlessly. Windows on their own layer, so they can glow with the bass.
function skyline(width,height,{seed,minH,maxH,minW,maxW,shade,windows,signs}){
  const body=document.createElement('canvas'),lit=document.createElement('canvas');body.width=lit.width=width;body.height=lit.height=height;
  const g=body.getContext('2d'),gl=lit.getContext('2d');let s=seed;const rand=()=>(s=(s*16807)%2147483647)/2147483647;
  const signList=[];
  for(let x=0;x<width;){
    const bw=minW+rand()*(maxW-minW),bh=minH+rand()*(maxH-minH),top=height-bh;
    g.fillStyle=shade;g.fillRect(x,top,bw+1,bh);
    if(rand()<0.3){g.fillRect(x+bw*0.4,top-bh*0.08,bw*0.06,bh*0.08);}                                   // antenna
    if(windows)for(let wy=top+bh*0.06;wy<height-6;wy+=windows*2.2)for(let wx=x+windows;wx<x+bw-windows;wx+=windows*1.9)
      if(rand()<0.32){gl.fillStyle=rand()<0.8?'rgba(255,214,150,.85)':'rgba(150,220,255,.8)';gl.fillRect(wx,wy,windows,windows*1.2);}
    if(signs&&rand()<0.35&&bw>maxW*0.5)signList.push({x:x+bw*0.15,y:top+bh*(0.12+rand()*0.2),w:bw*0.7,h:Math.min(bh*0.1,maxW*0.14),hue:[320,190,45,280][Math.floor(rand()*4)],phase:rand()*6});
    x+=bw+rand()*minW*0.3;
  }
  return {body,lit,signs:signList,width};
}

function drawFox(g,x,y,s,step,air,scarfColor,wall){
  // y is the ground under the fox; s is its size. step: running phase (one cycle per beat pair); air: 0 on the ground .. 1 at the top.
  const bob=air?0:Math.abs(Math.sin(step*Math.PI))*s*0.04;
  g.save();g.translate(x,y-bob);
  const legs=(back,front)=>{
    for(const [lx,offset,shade] of [[-0.32,back,'#b4531d'],[0.28,front,'#c8622a']]){
      const a=air?0.6*Math.sign(lx):Math.sin(step*Math.PI*2+offset)*0.7,b=air?-0.9:Math.max(0,-Math.sin(step*Math.PI*2+offset))*1.1;
      g.strokeStyle=shade;g.lineWidth=s*0.07;g.lineCap='round';
      const hx=lx*s,hy=-s*0.42,kx=hx+Math.sin(a)*s*0.2,ky=hy+Math.cos(a)*s*0.2;
      g.beginPath();g.moveTo(hx,hy);g.lineTo(kx,ky);g.lineTo(kx+Math.sin(a-b)*s*0.2,ky+Math.cos(a-b)*s*0.2);g.stroke();
    }
  };
  legs(Math.PI,Math.PI*0.3);
  // tail: a bushy curve that streams back
  const tw=Math.sin(wall*7+step*3)*0.12;
  g.fillStyle='#d9692b';g.beginPath();g.moveTo(-s*0.42,-s*0.5);
  g.quadraticCurveTo(-s*0.85,-s*(0.75+tw),-s*1.05,-s*(0.55+tw));g.quadraticCurveTo(-s*0.8,-s*(0.42+tw*0.5),-s*0.42,-s*0.38);g.fill();
  g.fillStyle='#f6efe4';g.beginPath();g.ellipse(-s*1.0,-s*(0.56+tw),s*0.09,s*0.06,-0.4,0,Math.PI*2);g.fill();
  // body
  const body=g.createLinearGradient(0,-s*0.75,0,-s*0.3);body.addColorStop(0,'#ef8a3c');body.addColorStop(1,'#c65a22');
  g.fillStyle=body;g.beginPath();g.ellipse(0,-s*0.52,s*0.48,s*0.2,-0.05,0,Math.PI*2);g.fill();
  g.fillStyle='#f6efe4';g.beginPath();g.ellipse(s*0.3,-s*0.44,s*0.17,s*0.11,0.3,0,Math.PI*2);g.fill();
  legs(Math.PI*1.3,0);
  // head
  g.save();g.translate(s*0.48,-s*0.74);g.rotate(air?-0.15:Math.sin(step*Math.PI*2)*0.04);
  g.fillStyle='#ea7d34';g.beginPath();g.ellipse(0,0,s*0.2,s*0.16,0,0,Math.PI*2);g.fill();
  g.beginPath();g.moveTo(s*0.1,-s*0.06);g.lineTo(s*0.36,s*0.03);g.lineTo(s*0.1,s*0.1);g.fill();                         // snout
  g.fillStyle='#f6efe4';g.beginPath();g.moveTo(s*0.06,s*0.04);g.lineTo(s*0.34,s*0.04);g.lineTo(s*0.08,s*0.12);g.fill();
  g.fillStyle='#222';g.beginPath();g.arc(s*0.36,s*0.03,s*0.025,0,Math.PI*2);g.fill();
  g.fillStyle='#1c1a22';g.beginPath();g.arc(s*0.07,-s*0.03,s*0.028,0,Math.PI*2);g.fill();
  g.fillStyle='#fff';g.beginPath();g.arc(s*0.078,-s*0.04,s*0.009,0,Math.PI*2);g.fill();
  g.fillStyle='#c65a22';
  for(const ex of [-0.12,0.0]){g.beginPath();g.moveTo(s*(ex-0.04),-s*0.12);g.lineTo(s*(ex+0.03),-s*0.34);g.lineTo(s*(ex+0.1),-s*0.1);g.fill();}
  g.restore();
  // scarf: knotted at the neck, its tail flapping behind
  g.fillStyle=scarfColor;g.beginPath();g.ellipse(s*0.36,-s*0.62,s*0.1,s*0.07,0.4,0,Math.PI*2);g.fill();
  g.beginPath();g.moveTo(s*0.3,-s*0.66);
  for(let i=1;i<=8;i++){const k=i/8;g.lineTo(s*(0.3-k*0.75),-s*(0.68+k*0.1)+Math.sin(wall*14-k*5)*s*0.05*k);}
  for(let i=8;i>=0;i--){const k=i/8;g.lineTo(s*(0.3-k*0.75),-s*(0.6+k*0.1)+Math.sin(wall*14-k*5)*s*0.05*k);}
  g.fill();
  g.restore();
}

export default {
  id:'runner',name:'Runner',
  create(){
    let w=0,h=0,u=1,far=null,mid=null,skyHue=280,pulse=0,shake=0,lastBeat=null,stepBase=0,lastT=null;
    const dust=[],streaks=[],stars=[];
    let seed=5;const rand=()=>(seed=(seed*16807)%2147483647)/2147483647;
    function layout(){
      u=Math.min(w,h);
      const width=Math.ceil(Math.max(w*1.6,u*2.4));
      far=skyline(width,Math.ceil(h*0.32),{seed:3,minH:h*0.08,maxH:h*0.26,minW:u*0.05,maxW:u*0.12,shade:'#241a3d',windows:Math.max(2,u*0.006)});
      mid=skyline(width,Math.ceil(h*0.42),{seed:9,minH:h*0.12,maxH:h*0.36,minW:u*0.09,maxW:u*0.2,shade:'#130f22',windows:Math.max(2,u*0.009),signs:true});
      stars.length=0;for(let i=0;i<90;i++)stars.push({x:rand()*w,y:rand()*h*0.45,r:rand()*1.4+0.3,phase:rand()*6});
    }
    return {
      resize(nw,nh){w=nw;h=nh;if(w&&h)layout();},
      draw(g,frame,env){
        if(!far||env.w!==w||env.h!==h){w=env.w;h=env.h;layout();}
        const {dt,wall,calm,zones}=env,t=frame.time,speed=SPEED*u;
        const ground=Math.min(zones.lyrics?zones.lyrics.top-u*0.02:h*0.86,h*0.86),foxX=w*0.28,foxSize=u*0.16;
        // sky colour: the section sets the time of evening, the chord nudges it
        const cc=chordColor(frame.chord.label),sectionHue=[285,255,320,230,300,200][(frame.section.index+6)%6];
        skyHue=lerpHue(skyHue,cc.root===null?sectionHue:lerpHue(sectionHue,cc.hue,0.25),Math.min(1,dt*1.2));
        // pulse and shake on kicks
        for(const s of env.events.hits.drums||[]){pulse=Math.max(pulse,s);if(!calm)shake=Math.max(shake,s*0.5);}
        pulse=Math.max(0,pulse-dt*3);shake=Math.max(0,shake-dt*4);
        const sx=calm?0:(Math.sin(wall*90)*shake*u*0.01),sy=calm?0:(Math.cos(wall*77)*shake*u*0.012);
        g.save();g.translate(sx,sy);

        // ---- sky, stars, sun ----
        const sky=g.createLinearGradient(0,0,0,ground);
        sky.addColorStop(0,`hsl(${skyHue},45%,9%)`);sky.addColorStop(0.55,`hsl(${(skyHue+25)%360},55%,22%)`);sky.addColorStop(1,`hsl(${(skyHue+70)%360},75%,48%)`);
        g.fillStyle=sky;g.fillRect(-u*0.05,-u*0.05,w+u*0.1,h+u*0.1);
        for(const s of stars){g.fillStyle=`rgba(255,255,255,${0.25+0.35*Math.sin(wall*1.5+s.phase)**2})`;g.fillRect(s.x,s.y,s.r,s.r);}
        const voice=frame.tracks.vocals?.level||0,sunR=u*0.2,sunX=w*0.66,sunY=ground-h*0.2;
        const sun=g.createLinearGradient(0,sunY-sunR,0,sunY+sunR);sun.addColorStop(0,`hsl(${(skyHue+90)%360},95%,${68+voice*14}%)`);sun.addColorStop(1,`hsl(${(skyHue+40)%360},90%,55%)`);
        const halo=g.createRadialGradient(sunX,sunY,sunR*0.8,sunX,sunY,sunR*(1.5+voice*0.6));                    // the glow (a gradient: blur is slow)
        halo.addColorStop(0,`hsla(${(skyHue+80)%360},100%,65%,${0.35+voice*0.45})`);halo.addColorStop(1,`hsla(${(skyHue+80)%360},100%,65%,0)`);
        g.fillStyle=halo;g.fillRect(sunX-sunR*2.2,sunY-sunR*2.2,sunR*4.4,sunR*4.4);
        g.fillStyle=sun;g.beginPath();g.arc(sunX,sunY,sunR,0,Math.PI*2);g.fill();
        g.fillStyle=sky;for(let i=0;i<6;i++){const y=sunY+sunR*(0.1+i*0.15);g.fillRect(sunX-sunR,y,sunR*2,sunR*0.02*(i+1));}   // synth stripes

        // ---- skylines: far and mid, tiled forever, moving with song time ----
        const bass=frame.tracks.bass?.level||0;
        const tile=(layer,factor,y,windowsAlpha,signs)=>{
          const off=((t*speed*factor)%layer.width+layer.width)%layer.width;
          for(let x=-off;x<w;x+=layer.width){
            g.drawImage(layer.body,x,y);g.globalAlpha=windowsAlpha;g.drawImage(layer.lit,x,y);g.globalAlpha=1;
            if(signs)for(const s of layer.signs){
              const flick=calm?1:(0.75+0.25*Math.sin(wall*3+s.phase)),glow=(0.45+0.55*(frame.tracks.rhythm?.level||frame.tracks.other?.level||0))*flick;
              g.strokeStyle=`hsla(${s.hue},100%,60%,${glow*0.22})`;g.lineWidth=u*0.02;g.strokeRect(x+s.x,y+s.y,s.w,s.h);         // glow
              g.strokeStyle=`hsla(${s.hue},100%,${62+glow*20}%,${0.5+glow*0.5})`;g.lineWidth=Math.max(2,u*0.005);g.strokeRect(x+s.x,y+s.y,s.w,s.h);
            }
          }
        };
        tile(far,0.18,ground-far.body.height,0.25+bass*0.4,false);
        tile(mid,0.42,ground-mid.body.height,0.35+bass*0.6,true);

        // ---- street ----
        const street=g.createLinearGradient(0,ground,0,h);street.addColorStop(0,'#1b1430');street.addColorStop(1,'#07060c');
        g.fillStyle=street;g.fillRect(-u*0.05,ground,w+u*0.1,h-ground+u*0.05);
        const glowLine=g.createLinearGradient(0,ground-u*(0.02+pulse*0.05),0,ground+u*(0.02+pulse*0.05));
        glowLine.addColorStop(0,`hsla(${(skyHue+150)%360},100%,60%,0)`);glowLine.addColorStop(0.5,`hsla(${(skyHue+150)%360},100%,60%,${0.3+pulse*0.5})`);glowLine.addColorStop(1,`hsla(${(skyHue+150)%360},100%,60%,0)`);
        g.fillStyle=glowLine;g.fillRect(0,ground-u*(0.02+pulse*0.05),w,u*(0.04+pulse*0.1));
        g.strokeStyle=`hsla(${(skyHue+150)%360},100%,${60+pulse*25}%,${0.6+pulse*0.4})`;g.lineWidth=Math.max(2,u*(0.004+pulse*0.006));
        g.beginPath();g.moveTo(0,ground);g.lineTo(w,ground);g.stroke();
        const dash=u*0.12,off=(t*speed)%(dash*2);g.fillStyle='rgba(255,255,255,.12)';
        for(let x=-off;x<w;x+=dash*2)g.fillRect(x,ground+u*0.05,dash,Math.max(2,u*0.006));

        // ---- chord hurdles: each placed at its chord's start, so it reaches the fox on the change ----
        const chords=env.song.chords.filter(c=>c.label&&c.start>t-(foxX+u*0.2)/speed&&c.start<t+(w-foxX+u*0.3)/speed);
        let air=0,airborne=false;
        for(const c of chords){
          const x=foxX+(c.start-t)*speed+foxSize*0.1,hh=u*0.075,color=chordHsl(c.label,62,1);
          g.save();g.lineCap='round';g.lineJoin='round';
          g.beginPath();g.moveTo(x-u*0.03,ground);g.lineTo(x-u*0.03,ground-hh);g.lineTo(x+u*0.03,ground-hh);g.lineTo(x+u*0.03,ground);
          g.strokeStyle=chordHsl(c.label,62,0.25);g.lineWidth=u*0.03;g.stroke();g.strokeStyle=color;g.lineWidth=Math.max(3,u*0.008);g.stroke();
          g.restore();
          g.save();g.font=`800 ${u*0.045}px system-ui,sans-serif`;g.textAlign='center';g.textBaseline='bottom';g.lineJoin='round';
          g.strokeStyle='rgba(8,6,16,.6)';g.lineWidth=u*0.008;g.strokeText(c.label,x,ground-hh-u*0.015);
          g.fillStyle=chordHsl(c.label,80,1);g.fillText(c.label,x,ground-hh-u*0.015);g.restore();
          // the jump over this hurdle, centred on the change (a short hop when changes come fast)
          const half=Math.min(JUMP,Math.max(0.08,(c.end-c.start)*0.4)),k=(t-c.start+half)/(half*2);
          if(k>0&&k<1){airborne=true;air=Math.max(air,Math.sin(Math.PI*k)*Math.min(1,half/JUMP));}
        }

        // ---- the fox: stride locked to the beat ----
        const beatsInBar=frame.beat.beats||4,beatPos=frame.beat.bar!==null?(frame.beat.bar*beatsInBar+(frame.beat.beat-1)+frame.beat.phase):t*2;
        if(lastT!==null&&Math.abs(t-lastT)>0.5)stepBase=0;lastT=t;
        const step=frame.playing||airborne?beatPos/2:stepBase;
        if(frame.playing)stepBase=step;
        if(env.events.beat&&!airborne&&frame.playing)for(let i=0;i<5;i++)dust.push({x:foxX-foxSize*0.2,y:ground,vx:-u*(0.1+rand()*0.2),vy:-u*(0.05+rand()*0.1),life:1});
        const lift=air*u*0.16,scarf=chordHsl(frame.chord.label||'C',58,1);
        // speed streaks with the lead guitar
        const lead=frame.tracks.lead?.level||0;
        if(frame.playing&&lead>0.3&&rand()<lead*0.9)streaks.push({x:foxX-foxSize*0.3,y:ground-lift-foxSize*(0.3+rand()*0.5),len:u*(0.1+rand()*0.2),life:1});
        g.strokeStyle='rgba(255,255,255,.5)';g.lineWidth=Math.max(1,u*0.003);
        for(let i=streaks.length-1;i>=0;i--){const s=streaks[i];s.life-=dt*3;s.x-=speed*dt*1.5;if(s.life<=0){streaks.splice(i,1);continue;}
          g.globalAlpha=s.life*0.6;g.beginPath();g.moveTo(s.x,s.y);g.lineTo(s.x-s.len,s.y);g.stroke();}
        g.globalAlpha=1;
        for(let i=dust.length-1;i>=0;i--){const d=dust[i];d.life-=dt*2.5;if(d.life<=0){dust.splice(i,1);continue;}
          d.x+=d.vx*dt;d.y+=d.vy*dt;d.vy+=u*0.4*dt;g.fillStyle=`rgba(200,180,255,${d.life*0.35})`;g.beginPath();g.arc(d.x,d.y,u*0.008*(1.5-d.life),0,Math.PI*2);g.fill();}
        // shadow on the street, then the fox
        g.fillStyle=`rgba(0,0,0,${0.35-air*0.2})`;g.beginPath();g.ellipse(foxX,ground+u*0.006,foxSize*(0.5-air*0.2),u*0.01,0,0,Math.PI*2);g.fill();
        drawFox(g,foxX,ground-lift,foxSize,step,airborne?air:0,scarf,wall);
        g.restore();
        // a soft vignette (unshaken)
        const v=g.createRadialGradient(w/2,h/2,u*0.35,w/2,h/2,Math.max(w,h)*0.75);v.addColorStop(0,'rgba(0,0,0,0)');v.addColorStop(1,'rgba(0,0,0,.45)');
        g.fillStyle=v;g.fillRect(0,0,w,h);
      },
    };
  },
};
