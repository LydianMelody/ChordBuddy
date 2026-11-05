// A starting point for a new visualization. Copy this file into the My Visuals folder (in Chord Buddy's main folder) under a new name
// (letters, digits, spaces, - or _; a name starting with _ stays hidden, like this one), change id and name, and it appears on the
// visualizer's toolbar within a few seconds. Nothing else needs editing. If it throws an error, only this visualization stops.
// Besides the chord, beats, sections, lyrics, MIDI melodies and stems, a frame has `frame.loop` (the loop being repeated, or null;
// env.events.loop says when it starts, ends or wraps) and `frame.midi` (extra parts from the person's own MIDI files: notes, hits and
// controls such as the sustain pedal; usually empty, so use them only when they are there).
// `inputs` (optional) names the parts the patch bay can rewire: each has a default source (what it does unchanged), and the person can
// connect any sound or signal to it instead, including their own MIDI. Read them as env.inputs.key; see visual-patch.js for the sources.
// In a show, your `inputs` can also be set or fired by the arrangement. When a live loop repeats, env.events.replay is set: to repeat the same way each
// pass, start over then, and use env.random() in place of Math.random().
// The full guide (the data in `frame` and `env`, how to make it feel musical, sync and performance rules) is the chordbuddy-visuals skill.
import {chordColor} from '../visual-color.js';

export default {
  id:'template',          // unique, up to 40 letters, digits, spaces, - _ or .; used to remember the choice
  name:'Template',        // the toolbar button
  order:50,               // toolbar position (lower first); the built-in ones use 10, 20, 30 and 90
  // hud:false,           // only if this draws its own chord AND lyrics; the shared overlay is almost always better
  inputs:{                // the parts the patch bay can rewire; types: trigger, gate, amount, bend, notes (visual-patch.js)
    pulse:{label:'Pulse',type:'trigger',default:'stem/drums/hit',help:'Makes the circle jump'},
    size:{label:'Size',type:'amount',default:'stem/bass/level',help:'How big the circle is'},
    swell:{label:'Swell',type:'gate',default:null,help:'Swells the circle gently while it is on (try a sustain pedal from your own MIDI)'},
  },
  // skin:{               // optional: restyle the picker and mixer to match this look (any key left out keeps the app's theme)
  //   paper:'#F4ECDD', ink:'#2B1E3F', highlight:'#FF9EC4',   // colors (also desk, tint, soft, accent1, accent2, accent3)
  //   font:'"Courier Prime", monospace',                     // and mono; bundled: Bricolage Grotesque, Space Mono, Courier Prime
  //   border:3, shadow:6, corners:4,                         // pixels: 0-6, 0-10, 0-24
  //   line:'#00E5FF', shadowColor:'#FF3FA4', active:'#FF3FA4', // border, shadow and pressed-button colors (default: ink)
  //   glow:10, texture:'scanlines', caps:true, tracking:0.08,  // glow 0-24 px; texture scanlines|grid|dots|paper; tracking em
  //   dark:{paper:'#1E1630', ink:'#F4ECDD'},                 // laid over the rest when the app is in its dark scheme
  //   css:`...`,            // or a whole stylesheet for the two panels (brass, wood, bevels, your own images): see machine.js
  // },                     // see starlane.js for a full one. Ink must read clearly on paper (4.5:1) and paper must be solid, or the whole skin is left out
  create(){
    let w=0,h=0,hue=220,pulse=0,held=0;
    return {
      resize(nw,nh){w=nw;h=nh;},                 // rebuild anything that depends on the size (pre-rendered art) here
      draw(g,frame,env){
        const {dt,zones,calm}=env,u=Math.min(env.w,env.h);
        // the color follows the chord, gliding toward it
        const target=chordColor(frame.chord.label).hue;hue+=(((target-hue+540)%360)-180)*Math.min(1,dt*3);
        // a pulse on every drum hit (or whatever is patched to Pulse); has() keeps it working where there is no patch bay
        const inp=env.inputs||{},has=k=>k in inp;
        for(const strength of has('pulse')?inp.pulse:env.events.hits.drums||[])pulse=Math.max(pulse,strength);
        pulse=Math.max(0,pulse-dt*3);
        // paint the whole canvas every frame
        g.fillStyle=`hsl(${hue},40%,8%)`;g.fillRect(0,0,env.w,env.h);
        // keep the focal point between the chord band (top) and the lyric band (bottom)
        const top=zones.chord.bottom,bottom=zones.lyrics?zones.lyrics.top:env.h*0.97,cx=env.w/2,cy=(top+bottom)/2;
        // the circle swells gently while Swell is on (nothing is connected to it until the person patches something there)
        held+=((inp.swell?1:0)-held)*Math.min(1,dt*6);
        const r=u*(0.12+0.05*((has('size')?inp.size:frame.tracks.bass?.level)||0)+(calm?0.01:0.04)*pulse+0.03*held);
        g.fillStyle=`hsl(${hue},70%,55%)`;
        g.beginPath();g.arc(cx,cy,r,0,Math.PI*2);g.fill();
      },
      dispose(){},
    };
  },
};
