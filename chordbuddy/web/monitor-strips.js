// The mixer's two extra faders, for the sound only you hear (monitor-out.js): the click, and the song's cue track. They're kept apart from the stems because they
// aren't part of the music: they never reach OBS or an exported mix. The cue track's fader stays off until the song has a cue track.
import {askChoice} from './dialogs.js';
import {icon} from './icons.js';

const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const PREF='cb-monitor';
const COUNT_WORDS=['Off','1 bar','2 bars'];
/** A song's own count-in, saved with the song (song settings travel in its zip): what practice uses, and what an arrangement or a show starts from. */
export const songCountKey=songId=>'cb-count:'+songId;
export const songCount=(prefs,songId)=>{const n=Number(prefs.get(songCountKey(songId),'0'));return [0,1,2].includes(n)?n:0;};
export const DEFAULT_MONITOR=Object.freeze({click:{gain:.6,mute:true},cue:{gain:.8,mute:false}});

/** A saved setting, or the default for anything missing or wrong. */
export function readMonitor(text){
  let saved=null;try{saved=JSON.parse(text);}catch{}
  const part=name=>{const s=saved?.[name],d=DEFAULT_MONITOR[name];return {gain:Number.isFinite(s?.gain)&&s.gain>=0&&s.gain<=1?s.gain:d.gain,mute:typeof s?.mute==='boolean'?s.mute:d.mute};};
  return {click:part('click'),cue:part('cue')};
}
/** Whether a cue track lines up well enough to say nothing about, in words for the dialog. */
export function lengthNote(trackSeconds,songSeconds){
  if(!Number.isFinite(trackSeconds)||!(songSeconds>0))return '';
  const off=trackSeconds-songSeconds;
  if(Math.abs(off)<1)return '';
  return `It’s ${Math.abs(off).toFixed(1)} seconds ${off<0?'shorter':'longer'} than this song. It starts with the song’s first moment, so check that it lines up.`;
}
const clock=seconds=>`${Math.floor(seconds/60)}:${String(Math.round(seconds%60)).padStart(2,'0')}`;

export function mountMonitorStrips(root,{api,token,prefs,transport,out,showError,countSource=null}){
  let values=readMonitor(prefs.get(PREF,'')),song=null,track=null,asked=0,planned={};
  const head=el('div','monitor-head');head.append(el('b','','Only you hear these'));
  head.title='The click and the cue track play to your headphones, the same place as the music. They aren’t sent to OBS or included when you export a mix.';
  function row(part,label,glyph,tip){
    const node=el('div','monitor-row');node.dataset.part=part;node.title=tip;
    const mark=el('span','monitor-icon');mark.innerHTML=icon(glyph);
    const fader=el('input');fader.type='range';fader.min=0;fader.max=100;fader.step=1;fader.setAttribute('aria-label',`${label} volume`);
    const mute=el('button','mute','M');mute.type='button';mute.setAttribute('aria-label',`Mute the ${label.toLowerCase()}`);
    fader.oninput=()=>change(part,{gain:Number(fader.value)/100,...(part==='click'&&values.click.mute?{mute:false}:{})});
    mute.onclick=()=>change(part,{mute:!values[part].mute});
    node.append(mark,el('b','',label),fader,mute);
    return {node,fader,mute};
  }
  const click=row('click','Click','metronome','A click on every beat, following the song’s real beats through repeats, loops and speed changes, with a higher click on the first beat of each bar. Move the fader or press M to turn it on.');
  const cue=row('cue','Cues','mic','An audio file you supply, like your own spoken or sung cues, that plays along with the song from its first moment and follows it through repeats and loops.');
  const file=el('button','monitor-file','Add');file.type='button';cue.node.append(file);
  const input=el('input');input.type='file';input.accept='audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aif,.aiff';input.hidden=true;
  const countRow=el('div','monitor-row monitor-count');
  const countMark=el('span','monitor-icon');countMark.innerHTML=icon('play');
  const countSeg=el('div','seg monitor-count-seg');countSeg.setAttribute('role','group');countSeg.setAttribute('aria-label','Count-in when you press Play');
  const countButtons=COUNT_WORDS.map((words,bars)=>{const b=el('button','',words);b.type='button';b.onclick=()=>{const source=countSource?.();
    if(source)source.set(bars);else if(song)prefs.set(songCountKey(song),String(bars));paint();};countSeg.append(b);return b;});
  countRow.append(countMark,el('b','','Count-in'),countSeg);
  root.append(head,click.node,cue.node,countRow,input);

  function change(part,edit){values={...values,[part]:{...values[part],...edit}};prefs.set(PREF,JSON.stringify(values));out.setMonitor(values);paint();}
  function paint(){
    const has=!!track,ready=transport.getSnapshot().ready;
    for(const [part,strip] of [['click',click],['cue',cue]]){
      const v=values[part],usable=part==='click'?ready:ready&&has,off=v.mute||planned[part]===false;
      if(document.activeElement!==strip.fader)strip.fader.value=Math.round(v.gain*100);
      strip.fader.disabled=strip.mute.disabled=!usable;
      strip.mute.setAttribute('aria-pressed',String(v.mute));strip.node.classList.toggle('muted',off||!usable);
      strip.mute.title=v.mute?`Turn the ${part==='click'?'click':'cue track'} on`:`Mute the ${part==='click'?'click':'cue track'}`;
    }
    const source=countSource?.(),bars=source?source.get():song?songCount(prefs,song):0;
    countButtons.forEach((b,i)=>{b.classList.toggle('on',i===bars);b.setAttribute('aria-pressed',String(i===bars));b.disabled=!song;});
    countRow.title=(source?'This arrangement’s count-in, saved with the arrangement. Until you choose one here it follows the song’s own, set on the Chart tab. A show uses it unless the set list gives this song its own. ':'This song’s count-in, saved with the song. An arrangement and a set list can each give it a different one. ')+'Clicks whole bars before the music when you press Play, with a higher click on the first beat of each bar, so you know where the downbeat lands. From the start of a song it counts into bar 1. If the count needs more time than the recording has before then, the music waits for it. It plays at the Click fader’s level, even with the click muted.';
    cue.fader.title=has?`${track.name}${track.seconds?` · ${clock(track.seconds)}`:''}`:'This song has no cue track yet. Press Add to give it one.';
    file.disabled=!song;file.textContent=has?'File':'Add';
    file.title=has?`The cue track is ${track.name}. Replace it or remove it.`:'Give this song a cue track: an audio file that lines up with the song from its first moment.';
  }
  async function refresh(id){
    const turn=++asked;song=id;track=null;paint();
    if(!id)return;
    try{const r=await api('/api/cue-track/'+encodeURIComponent(id));if(turn===asked){track=r.track;if(track)out.trackFor(id);paint();}}catch(error){showError(error);}
  }
  input.onchange=async()=>{
    const chosen=input.files[0];input.value='';if(!chosen||!song)return;
    const id=song;
    try{
      const response=await fetch(`/api/cue-track/upload?song=${encodeURIComponent(id)}&name=${encodeURIComponent(chosen.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-ChordBuddy-Token':token},body:chosen});
      const body=await response.json();if(!response.ok)throw new Error(body.error||'Chord Buddy couldn’t save that file.');
      out.forgetTrack(id);out.reset();await refresh(id);
      const note=lengthNote(body.seconds,transport.getSnapshot().duration);
      if(note)await askChoice({title:'Check that it lines up',message:note,cancel:'OK',choices:[]});
    }catch(error){showError(error);}
  };
  file.onclick=async()=>{
    if(!track){input.click();return;}
    const choice=await askChoice({title:'This song’s cue track',message:[`${track.name}${track.seconds?` (${clock(track.seconds)})`:''}`,'A removed or replaced file is kept in the song’s my-cues/removed folder.'],
      choices:[{id:'remove',label:'Remove',kind:'danger'},{id:'replace',label:'Replace',kind:'primary'}]});
    if(choice==='replace')input.click();
    if(choice==='remove'){
      try{await api('/api/cue-track/remove',{song_id:song});out.forgetTrack(song);out.reset();await refresh(song);}catch(error){showError(error);}
    }
  };
  out.setMonitor(values);
  const unsubscribe=transport.subscribe(state=>{if(state.songId!==song)refresh(state.songId);else paint();});
  return {paint,
    /** The count-in Play uses, in bars (0 for none). */
    countBars:()=>countSource?.()?.get()??(song?songCount(prefs,song):0),
    /** What the plan says at the playhead: a part a flag has turned off shows as off. */
    setPlanned(value){const next=value||{};if(next.click===planned.click&&next.cue===planned.cue)return;planned=next;paint();},
    dispose(){unsubscribe();root.replaceChildren();}};
}
