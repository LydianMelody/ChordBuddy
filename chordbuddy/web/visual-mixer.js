// The visualizer's slide-out mixer: the same presets, faders, mute and solo as the player's mixer rack, controlling the real mix over the
// visual bridge, so the mix can be changed while the visualizer is full screen or on another monitor. It shows the mix the player reports,
// and each stem's level as the scene sees it.
import {STRIPS,PRESETS,presetMix,activePreset} from './mixer-rack.js';

const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};

/** container: the visualizer's stage. send(mix): ask the player to use this mix. Returns {toggle(open?), setMix(mix), setLevels(frame), dispose()}. */
export function mountMixerDrawer(container,{send}){
  const drawer=el('aside','visualizer-mixer');drawer.setAttribute('aria-label','Mixer');drawer.hidden=true;
  const head=el('div','vm-head'),title=el('strong','','Mixer'),close=el('button','vm-close','×');
  close.type='button';close.title='Close the mixer (M)';close.setAttribute('aria-label','Close the mixer');head.append(title,close);
  const presets=el('div','vm-presets'),rows=el('div','vm-rows'),masterRow=el('label','vm-master');
  const presetButtons=PRESETS.map(p=>{const b=el('button','',p.label);b.type='button';b.onclick=()=>change(mix=>Object.assign(mix,presetMix(mix,p.id)));presets.append(b);return b;});
  const strips=STRIPS.map(strip=>{
    const row=el('div','vm-row'),name=el('span','vm-name',strip.label.replace(' guitar',' gtr')),meter=el('span','vm-meter'),fill=el('i');meter.append(fill);
    const fader=el('input','vm-fader');fader.type='range';fader.min=0;fader.max=100;fader.step=1;fader.setAttribute('aria-label',strip.label+' volume');
    const mute=el('button','vm-mute','M'),solo=el('button','vm-solo','S');mute.type=solo.type='button';mute.title=`Mute ${strip.label}`;solo.title=`Solo ${strip.label}`;
    fader.oninput=()=>change(mix=>{mix.gains[strip.index]=Number(fader.value)/100;});
    mute.onclick=()=>change(mix=>{mix.mutes[strip.index]=!mix.mutes[strip.index];});
    solo.onclick=()=>change(mix=>{mix.solos[strip.index]=!mix.solos[strip.index];});
    row.append(name,mute,solo,fader,meter);rows.append(row);
    return {strip,row,fader,mute,solo,fill};
  });
  const master=el('input','vm-fader');master.type='range';master.min=0;master.max=100;master.step=1;master.setAttribute('aria-label','Master volume');
  master.oninput=()=>change(mix=>{mix.master=Number(master.value)/100;});
  masterRow.append(el('span','vm-name','Master'),master);
  const note=el('p','vm-note','Waiting for the player…');
  drawer.append(head,presets,rows,masterRow,note);container.append(drawer);
  close.onclick=()=>toggle(false);
  // keys inside the drawer (arrows on a fader, space on a button) belong to the drawer, not to the visualizer's shortcuts
  drawer.addEventListener('keydown',event=>{if(event.key!=='Escape'&&event.key!=='m'&&event.key!=='M')event.stopPropagation();});

  let mix=null,open=false;
  function change(edit){if(!mix)return;const next=structuredClone(mix);edit(next);mix=next;send(next);render();}
  function render(){
    const ready=!!mix;note.hidden=ready;
    for(const b of [...presetButtons,master,...strips.flatMap(s=>[s.fader,s.mute,s.solo])])b.disabled=!ready;
    if(!ready)return;
    const current=activePreset(mix),soloing=mix.solos.some(Boolean);
    presetButtons.forEach((b,i)=>b.setAttribute('aria-pressed',String(PRESETS[i].id===current)));
    for(const {strip,row,fader,mute,solo} of strips){
      const i=strip.index;
      if(document.activeElement!==fader)fader.value=Math.round(mix.gains[i]*100);
      mute.setAttribute('aria-pressed',String(mix.mutes[i]));solo.setAttribute('aria-pressed',String(mix.solos[i]));
      row.classList.toggle('quiet',mix.mutes[i]||soloing&&!mix.solos[i]);
    }
    if(document.activeElement!==master)master.value=Math.round(mix.master*100);
  }
  function toggle(value=!open){open=!!value;drawer.hidden=false;requestAnimationFrame(()=>drawer.classList.toggle('open',open));drawer.setAttribute('aria-hidden',String(!open));
    if(!open)setTimeout(()=>{if(!open)drawer.hidden=true;},300);}
  render();
  return {
    toggle,
    get open(){return open;},
    // the mix the player reports (while a fader is held, that fader keeps the value under the finger)
    setMix(value){if(!value||JSON.stringify(value)===JSON.stringify(mix))return;mix=structuredClone(value);render();},
    setLevels(frame){if(!open)return;for(const {strip,fill} of strips)fill.style.width=Math.round((frame.tracks[strip.key]?.level||0)*100)+'%';},
    dispose(){drawer.remove();},
  };
}
