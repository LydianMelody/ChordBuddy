// A starting point for a new visualization. Copy this file to a new name in this folder (letters, digits, - or _; it must not start
// with _ or it stays hidden, like this one), change id and name, and it appears in the visualizer's toolbar the next time the visualizer
// opens. Nothing else needs editing. If it throws an error, only this visualization stops; the others keep working.
// The full guide (the data in `frame` and `env`, how to make it feel musical, sync and performance rules) is the chordbuddy-visuals skill.
import {chordColor} from '../visual-color.js';

export default {
  id:'template',          // unique, short; used to remember the choice
  name:'Template',        // the toolbar button
  order:50,               // toolbar position (lower first); the built-in ones use 10, 20, 30 and 90
  // hud:false,           // only if this draws its own chord AND lyrics; the shared overlay is almost always better
  create(){
    let w=0,h=0,hue=220,pulse=0;
    return {
      resize(nw,nh){w=nw;h=nh;},                 // rebuild anything that depends on the size (pre-rendered art) here
      draw(g,frame,env){
        const {dt,zones,calm}=env,u=Math.min(env.w,env.h);
        // the colour follows the chord, gliding towards it
        const target=chordColor(frame.chord.label).hue;hue+=(((target-hue+540)%360)-180)*Math.min(1,dt*3);
        // a pulse on every kick
        for(const strength of env.events.hits.drums||[])pulse=Math.max(pulse,strength);
        pulse=Math.max(0,pulse-dt*3);
        // paint the whole canvas every frame
        g.fillStyle=`hsl(${hue},40%,8%)`;g.fillRect(0,0,env.w,env.h);
        // keep the focal point between the chord band (top) and the lyric band (bottom)
        const top=zones.chord.bottom,bottom=zones.lyrics?zones.lyrics.top:env.h*0.97,cx=env.w/2,cy=(top+bottom)/2;
        const r=u*(0.12+0.05*(frame.tracks.bass?.level||0)+(calm?0.01:0.04)*pulse);
        g.fillStyle=`hsl(${hue},70%,55%)`;
        g.beginPath();g.arc(cx,cy,r,0,Math.PI*2);g.fill();
      },
      dispose(){},
    };
  },
};
