// The always-visible mixer rack: one vertical channel strip per practice stem, presets, and Master.
// The audio engine owns the mix (Transport.setMix); this module is only the control surface.
import {icon} from './icons.js';

// Track order inside the PCM mixer (mix.gains/mutes/solos are indexed this way). Never reorder.
export const STEM_INDEX={bass:0,drums:1,other:2,vocals:3,piano:4,lead:5,rhythm:6};
// Order the strips are shown in.
export const STRIPS=[['vocals','Vocals','mic'],['lead','Lead guitar','guitar'],['rhythm','Rhythm guitar','guitar'],['bass','Bass','bass'],['drums','Drums','drum'],['piano','Piano','piano'],['other','Other','bolt']]
  .map(([key,label,glyph])=>({key,label,glyph,index:STEM_INDEX[key]}));
export const PRESETS=[
  {id:'full',label:'Full band',muted:[]},
  {id:'karaoke',label:'Karaoke',muted:['vocals']},
  {id:'noguitars',label:'No guitars',muted:['lead','rhythm']},
  {id:'rhythm',label:'Rhythm',muted:['vocals','lead','piano','other']},
];

// A preset resets every fader to full, clears solos, and mutes the listed stems. Master is left alone.
export function presetMix(mix,id){
  const preset=PRESETS.find(item=>item.id===id);if(!preset)throw Error('Unknown preset');
  const mutes=Array(7).fill(false);for(const key of preset.muted)mutes[STEM_INDEX[key]]=true;
  return {gains:Array(7).fill(1),mutes,solos:Array(7).fill(false),master:mix.master};
}
export function activePreset(mix){
  for(const preset of PRESETS){
    const want=presetMix(mix,preset.id);
    if(mix.gains.every(gain=>gain===1)&&mix.solos.every(solo=>!solo)&&mix.mutes.every((mute,i)=>mute===want.mutes[i]))return preset.id;
  }
  return null;
}
// What each stem is actually contributing: muted stems, and stems silenced by someone else's solo, are 0 (mute wins).
export function effectiveLevels(mix){
  const solo=mix.solos.some(Boolean);
  return mix.gains.map((gain,i)=>mix.mutes[i]||solo&&!mix.solos[i]?0:gain);
}

// A short human name for the current mix, used in the exported file's name: "Karaoke", "no Vocals, Bass", "custom mix".
export function mixLabel(mix){
  const preset=activePreset(mix);if(preset)return PRESETS.find(item=>item.id===preset).label;
  const levels=effectiveLevels(mix),names=STRIPS.filter(strip=>levels[strip.index]===0).map(strip=>strip.label);
  const soloed=STRIPS.filter(strip=>mix.solos[strip.index]&&!mix.mutes[strip.index]);
  if(mix.gains.every(gain=>gain===1)){
    if(soloed.length&&soloed.length<=3)return 'only '+soloed.map(strip=>strip.label).join(', ');
    if(names.length&&names.length<=3)return 'no '+names.join(', ');
  }
  return 'custom mix';
}
// Query string for /api/mix-export: seven levels in the player's channel order, plus master.
export function mixExportQuery(mix){
  const levels=effectiveLevels(mix).map(level=>Number(level.toFixed(3)));
  return `levels=${levels.join(',')}&master=${Number(mix.master.toFixed(3))}`;
}

// Peak amplitude (0..1) to a meter fill (0..1) on a -54 dB..0 dB scale, which reads like a real channel meter.
export const METER_FLOOR_DB=-54;
export function meterLevel(peak){
  if(!(peak>0))return 0;
  return Math.max(0,Math.min(1,(20*Math.log10(peak)-METER_FLOOR_DB)/-METER_FLOOR_DB));
}
// Peaks jump up at once and fall back gradually, so short hits stay visible.
export const METER_FALL=.8;
export function fallingLevel(previous,target){return Math.max(target,previous*METER_FALL<.004?0:previous*METER_FALL);}

const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};

export function mountMixer(root,{transport,onError=()=>{},exportTarget=()=>null}){
  const presetsRoot=root.querySelector('#rack-presets'),stripsRoot=root.querySelector('#rack-strips');
  const master=root.querySelector('#rack-master'),masterOut=root.querySelector('#rack-master-out'),exportLink=root.querySelector('#rack-export');
  const update=change=>{
    const mix=transport.getSnapshot().mix;change(mix);
    try{transport.setMix(mix);}catch(error){onError(error);}
  };
  const presetButtons=PRESETS.map(preset=>{
    const button=make('button','',preset.label);button.type='button';button.dataset.preset=preset.id;
    button.onclick=()=>update(mix=>Object.assign(mix,presetMix(mix,preset.id)));
    presetsRoot.append(button);return button;
  });
  const strips=STRIPS.map(strip=>{
    const node=make('div','stem');node.dataset.stem=strip.key;
    const cap=make('span','stem-icon');cap.innerHTML=icon(strip.glyph);
    const track=make('div','track'),meter=make('span','meter'),level=document.createElement('i');meter.append(level);meter.setAttribute('aria-hidden','true');
    const fader=make('input','fader');fader.type='range';fader.min=0;fader.max=100;fader.step=1;fader.setAttribute('aria-label',strip.label+' volume');
    fader.oninput=()=>update(mix=>{mix.gains[strip.index]=Number(fader.value)/100;});
    track.append(meter,fader);
    const mute=make('button','mute','M'),solo=make('button','solo','S');mute.type=solo.type='button';
    mute.title=`Mute ${strip.label}`;solo.title=`Solo ${strip.label}`;mute.setAttribute('aria-label',mute.title);solo.setAttribute('aria-label',solo.title);
    mute.onclick=()=>update(mix=>{mix.mutes[strip.index]=!mix.mutes[strip.index];});
    solo.onclick=()=>update(mix=>{mix.solos[strip.index]=!mix.solos[strip.index];});
    const label=make('div','strip-label',strip.label.replace(' guitar',' gtr'));label.title=strip.label;
    node.append(cap,track,mute,solo,label);stripsRoot.append(node);
    return {strip,node,fader,mute,solo,level};
  });
  master.oninput=()=>update(mix=>{mix.master=Number(master.value)/100;});

  const shown=Array(7).fill(0);
  function render(state=transport.getSnapshot()){
    const {mix,ready}=state,levels=effectiveLevels(mix),soloActive=mix.solos.some(Boolean),current=activePreset(mix),live=state.levels;
    root.classList.toggle('disabled',!ready);
    for(const {strip,node,fader,mute,solo,level} of strips){
      const i=strip.index;
      if(document.activeElement!==fader)fader.value=Math.round(mix.gains[i]*100);
      shown[i]=fallingLevel(shown[i],live?meterLevel(live[i]):0);level.parentElement.style.setProperty('--lvl',shown[i]);
      mute.setAttribute('aria-pressed',String(mix.mutes[i]));solo.setAttribute('aria-pressed',String(mix.solos[i]));
      node.classList.toggle('muted',levels[i]===0);node.classList.toggle('soloed',mix.solos[i]);
      node.classList.toggle('quiet',soloActive&&!mix.solos[i]&&!mix.mutes[i]);
      for(const control of [fader,mute,solo])control.disabled=!ready;
    }
    for(const button of presetButtons){button.classList.toggle('on',button.dataset.preset===current);button.disabled=!ready;}
    if(document.activeElement!==master)master.value=Math.round(mix.master*100);
    master.disabled=!ready;masterOut.textContent=Math.round(mix.master*100);
    const target=ready?exportTarget():null;
    if(exportLink){
      exportLink.classList.toggle('disabled',!target);
      if(target){exportLink.href=target.url(mixExportQuery(mix),`${target.title} - ${mixLabel(mix)}`);exportLink.title=`Save this mix (${mixLabel(mix)}) as an MP3`;}
      else{exportLink.removeAttribute('href');exportLink.title='Available when the stems are ready';}
    }
  }
  const unsubscribe=transport.subscribe(render);
  render();
  return {render,dispose:unsubscribe};
}
