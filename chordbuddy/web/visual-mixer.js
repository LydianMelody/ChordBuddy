// The visualizer's slide-out mixer: the main window's mixer rack (same markup and styles, mixer-rack.css), on a darkened panel that
// slides in from the right edge. It controls the real mix over the visual bridge, so the mix can be changed while the visualizer is
// full screen or on another monitor. It shows the mix the player reports, and each stem's level as the scene sees it.
import {STRIPS,PRESETS,presetMix,activePreset,effectiveLevels,fallingLevel} from './mixer-rack.js';
import {icon} from './icons.js';

const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const withIcon=(node,name)=>{node.insertAdjacentHTML('afterbegin',icon(name));return node;};

/** container: the visualizer's stage. send(mix): ask the player to use this mix. Returns {toggle(open?), setMix(mix), setLevels(frame), dispose()}. */
export function mountMixerDrawer(container,{send}){
  const drawer=el('div','visualizer-mixer');drawer.hidden=true;
  const rack=el('aside','rack');rack.setAttribute('aria-label','Mixer');
  const head=el('div','rack-head'),title=withIcon(el('b','','Mixer'),'layers'),close=withIcon(el('button','fold'),'chevron');
  close.type='button';close.title='Hide the mixer (M)';close.setAttribute('aria-label','Hide the mixer');
  head.append(title,el('span','rack-count',STRIPS.length+' STEMS'),close);
  const presets=el('div','presets'),stripsRoot=el('div','strips');
  const presetButtons=PRESETS.map(p=>{const b=el('button','',p.label);b.type='button';b.onclick=()=>change(mix=>Object.assign(mix,presetMix(mix,p.id)));presets.append(b);return b;});
  const strips=STRIPS.map(strip=>{
    const node=el('div','stem');node.dataset.stem=strip.key;
    const cap=withIcon(el('span','stem-icon'),strip.glyph);
    const track=el('div','track'),meter=el('span','meter'),level=document.createElement('i');meter.append(level);meter.setAttribute('aria-hidden','true');
    const fader=el('input','fader');fader.type='range';fader.min=0;fader.max=100;fader.step=1;fader.setAttribute('aria-label',strip.label+' volume');
    track.append(meter,fader);
    const mute=el('button','mute','M'),solo=el('button','solo','S');mute.type=solo.type='button';
    mute.title=`Mute ${strip.label}`;solo.title=`Solo ${strip.label}`;mute.setAttribute('aria-label',mute.title);solo.setAttribute('aria-label',solo.title);
    fader.oninput=()=>change(mix=>{mix.gains[strip.index]=Number(fader.value)/100;});
    mute.onclick=()=>change(mix=>{mix.mutes[strip.index]=!mix.mutes[strip.index];});
    solo.onclick=()=>change(mix=>{mix.solos[strip.index]=!mix.solos[strip.index];});
    const label=el('div','strip-label',strip.label.replace(' guitar',' gtr'));label.title=strip.label;
    node.append(cap,track,mute,solo,label);stripsRoot.append(node);
    return {strip,node,fader,mute,solo,meter};
  });
  const masterRow=withIcon(el('div','master'),'volume'),master=el('input'),masterOut=el('output','','100');
  master.type='range';master.min=0;master.max=100;master.step=1;master.setAttribute('aria-label','Master volume');
  master.oninput=()=>change(mix=>{mix.master=Number(master.value)/100;});
  masterRow.append(el('b','','Master'),master,masterOut);
  const note=el('p','visualizer-mixer-note','Waiting for the player…');
  rack.append(head,note,presets,stripsRoot,masterRow);drawer.append(rack);container.append(drawer);
  close.onclick=()=>toggle(false);
  // clicking the darkened area beside the rack closes it, like the M key
  drawer.addEventListener('click',event=>{if(event.target===drawer)toggle(false);});
  // keys inside the drawer (arrows on a fader, space on a button) belong to the drawer, not to the visualizer's shortcuts
  drawer.addEventListener('keydown',event=>{if(event.key!=='Escape'&&event.key!=='m'&&event.key!=='M')event.stopPropagation();});

  let mix=null,open=false;
  const shown=Array(7).fill(0);
  function change(edit){if(!mix)return;const next=structuredClone(mix);edit(next);mix=next;send(next);render();}
  function render(){
    const ready=!!mix;note.hidden=ready;rack.classList.toggle('disabled',!ready);
    for(const b of [...presetButtons,master,...strips.flatMap(s=>[s.fader,s.mute,s.solo])])b.disabled=!ready;
    if(!ready)return;
    const current=activePreset(mix),soloing=mix.solos.some(Boolean),levels=effectiveLevels(mix);
    presetButtons.forEach((b,i)=>{b.classList.toggle('on',PRESETS[i].id===current);b.setAttribute('aria-pressed',String(PRESETS[i].id===current));});
    for(const {strip,node,fader,mute,solo} of strips){
      const i=strip.index;
      if(document.activeElement!==fader)fader.value=Math.round(mix.gains[i]*100);
      mute.setAttribute('aria-pressed',String(mix.mutes[i]));solo.setAttribute('aria-pressed',String(mix.solos[i]));
      node.classList.toggle('muted',levels[i]===0);node.classList.toggle('soloed',mix.solos[i]);
      node.classList.toggle('quiet',soloing&&!mix.solos[i]&&!mix.mutes[i]);
    }
    if(document.activeElement!==master)master.value=Math.round(mix.master*100);
    masterOut.textContent=Math.round(mix.master*100);
  }
  function toggle(value=!open){open=!!value;drawer.hidden=false;requestAnimationFrame(()=>drawer.classList.toggle('open',open));drawer.setAttribute('aria-hidden',String(!open));
    if(!open)setTimeout(()=>{if(!open)drawer.hidden=true;},300);}
  render();
  return {
    toggle,
    get open(){return open;},
    // the mix the player reports (while a fader is held, that fader keeps the value under the finger)
    setMix(value){if(!value||JSON.stringify(value)===JSON.stringify(mix))return;mix=structuredClone(value);render();},
    // the scene's loudness per stem (already 0..1), falling back gradually like the main rack's meters
    setLevels(frame){if(!open)return;for(const {strip,meter} of strips){const i=strip.index;shown[i]=fallingLevel(shown[i],frame.tracks[strip.key]?.level||0);meter.style.setProperty('--lvl',shown[i]);}},
    dispose(){drawer.remove();},
  };
}
