// Abstract: a harmonic bloom. Each stem is a glowing ring whose shape is its eight frequency bands, repeated with a symmetry that changes
// with each section; hits throw sparks off their ring, kicks send out a shockwave, the beat breathes in the centre, and the vocal melody
// orbits as a comet (higher notes further out). The palette follows the chord's place on the circle of fifths.
import {STEM_ORDER,BAND_COUNT} from './visual-scene.js';
import {chordColor} from './visual-color.js';

const FOLDS=[6,5,7,8,4,9];                       // symmetry by section
const RING_ORDER=['bass','drums','piano','rhythm','lead','other','vocals'];   // inside to outside
const MAX_SPARKS=900;

function lerpHue(from,to,k){const d=((to-from+540)%360)-180;return (from+d*k+360)%360;}

export default {
  id:'abstract',name:'Abstract',
  create(){
    let hue=220,fold=6,foldTarget=6,foldMix=1,breath=0,spin=0;
    const sparks=[],waves=[],trail=[];
    const smooth=Object.fromEntries(STEM_ORDER.map(r=>[r,new Float32Array(BAND_COUNT)]));
    return {
      draw(g,frame,env){
        const {w,h,dt,calm,zones}=env,cx=w/2;
        const top=zones.chord.bottom,bottom=zones.lyrics?zones.lyrics.top:h*0.97,cy=(top+bottom)/2;
        const R=Math.min(w*0.42,(bottom-top)*0.5);
        // colour follows the chord, gliding rather than snapping
        const c=chordColor(frame.chord.label);hue=lerpHue(hue,c.hue,Math.min(1,dt*3));
        const sat=c.root===null?25:c.minor?55:75;
        if(env.events.sectionChanged){foldTarget=FOLDS[(frame.section.index+FOLDS.length)%FOLDS.length];foldMix=0;}
        foldMix=Math.min(1,foldMix+dt*1.5);if(foldMix>=1)fold=foldTarget;
        breath=Math.max(0,breath-dt*3.5);
        if(env.events.beat)breath=env.events.beat.downbeat?1:0.55;
        spin+=dt*(0.05+0.25*(frame.tracks.drums?.level||0))*(frame.playing?1:0.3);

        // background: a deep wash in the chord's colour, brighter at the centre
        g.fillStyle=`hsl(${hue},40%,4%)`;g.fillRect(0,0,w,h);
        const bg=g.createRadialGradient(cx,cy,0,cx,cy,Math.max(w,h)*0.7);
        bg.addColorStop(0,`hsla(${hue},${sat}%,${14+breath*(calm?2:6)}%,1)`);bg.addColorStop(0.5,`hsla(${(hue+30)%360},${sat*0.7}%,7%,1)`);bg.addColorStop(1,`hsla(${hue},30%,3%,1)`);
        g.fillStyle=bg;g.fillRect(0,0,w,h);

        g.globalCompositeOperation='lighter';
        // stem rings
        RING_ORDER.forEach((role,i)=>{
          const t=frame.tracks[role];if(!t)return;
          const s=smooth[role];for(let b=0;b<BAND_COUNT;b++)s[b]+=(t.bands[b]-s[b])*Math.min(1,dt*14);
          const base=R*(0.3+i*0.1),amp=R*0.11,dir=i%2?1:-1,points=96,ringHue=(hue+i*16)%360;
          const k=foldMix<1?fold+(foldTarget-fold)*foldMix:fold;
          g.beginPath();
          for(let p=0;p<=points;p++){
            const a=p/points*Math.PI*2,phase=(a*k/(Math.PI*2))%1,pos=phase*2<1?phase*2:2-phase*2;   // mirrored sweep over the bands
            const f=pos*(BAND_COUNT-1),lo=Math.floor(f),v=s[lo]+(s[Math.min(BAND_COUNT-1,lo+1)]-s[lo])*(f-lo);
            const r=base+amp*v*v*1.6+amp*0.15*t.pulse*(calm?0.3:1);
            const x=cx+Math.cos(a+spin*dir)*r,y=cy+Math.sin(a+spin*dir)*r;
            p?g.lineTo(x,y):g.moveTo(x,y);
          }
          const glow=0.2+t.level*0.8;
          g.strokeStyle=`hsla(${ringHue},${sat}%,${50+t.brightness*25}%,${0.15+glow*0.35})`;g.lineWidth=R*0.05*glow;g.stroke();
          g.strokeStyle=`hsla(${ringHue},${sat}%,${70+t.brightness*20}%,${0.3+glow*0.6})`;g.lineWidth=Math.max(1,R*0.008);g.stroke();
          // sparks from new hits on this stem
          for(const strength of env.events.hits[role]||[]){
            const n=Math.round((calm?3:8)+strength*(calm?6:22));
            for(let q=0;q<n&&sparks.length<MAX_SPARKS;q++){
              const a=Math.random()*Math.PI*2,speed=R*(0.25+Math.random()*0.9)*(0.4+strength);
              sparks.push({x:cx+Math.cos(a)*base,y:cy+Math.sin(a)*base,vx:Math.cos(a)*speed,vy:Math.sin(a)*speed,life:1,decay:0.8+Math.random()*1.2,hue:ringHue,size:1+strength*2.2});
            }
            if(role==='drums'&&t.brightness<0.45&&strength>0.35&&!calm)waves.push({r:base,life:1,hue:ringHue});   // a kick: shockwave
          }
        });
        // shockwaves
        for(let i=waves.length-1;i>=0;i--){
          const wv=waves[i];wv.r+=R*dt*1.8;wv.life-=dt*1.4;if(wv.life<=0){waves.splice(i,1);continue;}
          g.strokeStyle=`hsla(${wv.hue},70%,70%,${wv.life*0.35})`;g.lineWidth=R*0.02*wv.life;g.beginPath();g.arc(cx,cy,wv.r,0,Math.PI*2);g.stroke();
        }
        // sparks
        for(let i=sparks.length-1;i>=0;i--){
          const p=sparks[i];p.life-=dt*p.decay;if(p.life<=0){sparks.splice(i,1);continue;}
          p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=1-dt*1.2;p.vy*=1-dt*1.2;
          g.fillStyle=`hsla(${p.hue},80%,70%,${p.life*(calm?0.5:0.9)})`;g.beginPath();g.arc(p.x,p.y,p.size*(0.5+p.life),0,Math.PI*2);g.fill();
        }
        // centre: breathes on the beat
        const core=R*(0.16+0.04*breath*(calm?0.4:1));
        const cg=g.createRadialGradient(cx,cy,0,cx,cy,core*2.4);
        cg.addColorStop(0,`hsla(${hue},${sat}%,${62+breath*15}%,${0.55+breath*0.3})`);cg.addColorStop(1,`hsla(${hue},${sat}%,40%,0)`);
        g.fillStyle=cg;g.beginPath();g.arc(cx,cy,core*2.4,0,Math.PI*2);g.fill();
        // the vocal melody (or the instrumental one when there is none) as a comet with a trail
        const melody=frame.notes.vocal?.active.length?frame.notes.vocal:frame.notes.instrumental||frame.notes.melody;
        const note=melody?.active[0];
        if(note&&melody.high!==null){
          const span=Math.max(12,melody.high-melody.low),r=R*(0.45+0.6*(note.pitch-melody.low)/span),a=frame.time*1.3;
          trail.push({x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r,life:1});
        }
        for(let i=trail.length-1;i>=0;i--){trail[i].life-=dt*1.2;if(trail[i].life<=0)trail.splice(i,1);}
        for(const p of trail){g.fillStyle=`hsla(${(hue+180)%360},70%,75%,${p.life*0.5})`;g.beginPath();g.arc(p.x,p.y,R*0.012*(0.4+p.life),0,Math.PI*2);g.fill();}
        g.globalCompositeOperation='source-over';
        // vignette
        const v=g.createRadialGradient(cx,cy,Math.min(w,h)*0.35,cx,cy,Math.max(w,h)*0.75);v.addColorStop(0,'rgba(0,0,0,0)');v.addColorStop(1,'rgba(0,0,0,.6)');
        g.fillStyle=v;g.fillRect(0,0,w,h);
      },
    };
  },
};
