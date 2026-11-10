// Bringing your own MIDI to a song: drop a .mid anywhere, pick the song, line it up with the recording, say what each part is for.
// The screen is a long strip in song time: the song's bars and chords on top, what the recording has (the model's melody, faintly, and
// the moments something starts) below them, then one lane per part of your file. Drag a part to move the whole file; Shift-drag (or the
// Pin tool) pins one moment of the file to a moment of the song, like Reaper's stretch markers. Playing the song plays your notes with
// a simple tone so you can hear whether they sit. Nothing changes your file: its placement is saved beside it (midi-align.js).
//
// ctx: {api(path,body,options), bytes(path) -> ArrayBuffer, songs() -> [{id,title,artist,duration}], currentSongId(), playhead(),
//       openSong(id), songContext(id) -> {title,duration,measures,firstBar,chords,model:{vocal,instrumental},onsets,drumHits}, transport,
//       onChanged(songId), showError(error)}
import {readFile,cleanSettings,cleanParts,loadSongFiles,USES,REPLACEABLE,songParts} from './midi-user.js';
import {describeSignals,writeMidi} from './midi-file.js';
import {songGrid,placement,moveTo,rescale,switchMode,addAnchor,removeAnchor,snapSeconds,grainFor,beatSeconds,secondsBeat,barBeat,
  beatBar,guessReferences,guessAlignment,cleanAlignment,defaultAlignment} from './midi-align.js';
import {askChoice} from './dialogs.js';
import {pitchLabel} from './midi-view.js';

const summaryFiles=new Map();                   // files read for the manager's summaries, once per version (id:mtime)

const el=(tag,cls='',text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const button=(text,cls='mi-btn',title='')=>{const b=el('button',cls,text);b.type='button';if(title){b.title=title;b.setAttribute('aria-label',title);}return b;};
const timeLabel=s=>`${s<0?'-':''}${Math.floor(Math.abs(s)/60)}:${(Math.abs(s)%60).toFixed(1).padStart(4,'0')}`;
const isMidiName=name=>/\.midi?$/i.test(String(name||''));
const RULER=30,CHORDS=22,SONG=46,LANE=74,MAX_LANE=180,GAP=6;   // heights of the strip's rows (px); lanes grow to fill the space, up to MAX_LANE
const RATIO_BUTTONS=[[0.5,'½×','Half time: the file\'s beats take half as many of the song\'s'],[2,'2×','Double time'],[2/3,'⅔×','A 6/8 or 12/8 file felt in two'],[1.5,'1½×','The other way']];
const SIGNAL_TYPES={notes:'notes',trigger:'hit',gate:'on/off',amount:'0–1',bend:'±1'};

/** Which song a dropped file is for: the open one, unless the playhead is within a quarter note of its start or end (then ask). */
export function songForDrop({songId,playhead,duration,measures}){
  if(!songId||!Number.isFinite(playhead))return null;
  const grid=songGrid(measures||[]),b=secondsBeat(grid,playhead);
  const quarter=grid.beats.length>1?beatSeconds(grid,b+0.5)-beatSeconds(grid,b-0.5):0.5;
  const end=duration||(grid.end??0);
  return playhead<=quarter||(end>0&&playhead>=end-quarter)?null:songId;
}
/** Songs ordered by how likely a file is for them: a similar name first (the file's, or the track names inside it: Reaper projects are
 * often named after the song), then length. fileName may be several names joined with spaces. */
export function rankSongs(songs,fileName,fileSeconds){
  const words=s=>String(s||'').toLowerCase().replace(/\.midi?$/,'').split(/[^a-z0-9]+/).filter(w=>w.length>1);
  const theirs=new Set(words(fileName));
  return [...songs].map(song=>{
    const mine=words(song.title);const shared=mine.filter(w=>theirs.has(w)).length;
    const name=mine.length?shared/mine.length:0;
    const length=fileSeconds>0&&song.duration>0?Math.max(0,1-Math.abs(fileSeconds-song.duration)/song.duration):0;
    return {song,score:name*2+length*0.5,name,length};
  }).sort((a,b)=>b.score-a.score||String(a.song.title).localeCompare(String(b.song.title)));
}

/** A new MIDI file laid out on this song's beats, so whatever is played or drawn into it in a DAW lines up with no work at all. */
export function customMidi({measures,model={},title=''}){
  const grid=songGrid(measures),tpq=960,b=grid.beats;
  if(!b.length)throw new Error('This song has no bars yet, so there is nothing to lay a MIDI file on. Analyze it first.');
  // before the first beat: whole beats at the first beat's length, so the file's bar 1 can start at 0 s like the recording
  const first=(b[1]??b[0]+0.5)-b[0],lead=b[0]>0.02?Math.max(1,Math.round(b[0]/first)):0,tick0=lead*tpq;
  const tempos=[];if(lead)tempos.push({tick:0,usPerQuarter:Math.round(b[0]/lead*1e6)});
  const pts=grid.end!=null?[...b,grid.end]:b;
  for(let i=0;i<pts.length-1;i++){const us=Math.round((pts[i+1]-pts[i])*1e6);if(!tempos.length||tempos.at(-1).usPerQuarter!==us)tempos.push({tick:tick0+i*tpq,usPerQuarter:us});}
  if(!tempos.length)tempos.push({tick:0,usPerQuarter:500000});
  const timeSignatures=[];
  grid.bars.forEach((start,i)=>{const n=(grid.bars[i+1]??b.length)-start;if(n>0&&timeSignatures.at(-1)?.numerator!==n)timeSignatures.push({tick:tick0+start*tpq,numerator:n,denominator:4});});
  if(lead&&timeSignatures.length)timeSignatures.unshift({tick:0,numerator:lead,denominator:4});
  const toTick=s=>Math.max(0,Math.round(s<b[0]?s/b[0]*tick0:tick0+secondsBeat(grid,s)*tpq));
  const track=(name,notes)=>({name,channel:0,notes:(notes||[]).filter(n=>Number.isFinite(n.start)&&n.end>n.start).map(n=>{const tick=toTick(n.start);
    return {tick,endTick:Math.max(tick+1,toTick(n.end)),pitch:n.pitch,velocity:Math.max(1,Math.min(127,Math.round(n.velocity||90)))};})});
  const tracks=[track('Vocal melody',model.vocal),track('Instruments',model.instrumental),{name:'Your part',channel:1,notes:[]}];
  return writeMidi({ticksPerQuarter:tpq,tempos,timeSignatures,tracks,title});
}

// ---- the preview tone: your notes, played quietly under the song as it plays ------------------------------------------------------
function createTone(){
  let audio=null,master=null,scheduled=new Set(),lastTime=null,lastPlaying=false,volume=0.5;
  const LOOKAHEAD=0.18;
  const ensure=()=>{if(!audio){audio=new AudioContext();master=audio.createGain();master.gain.value=volume*0.35;master.connect(audio.destination);}return audio;};
  const hush=()=>{if(!audio)return;const g=master;g.gain.cancelScheduledValues(audio.currentTime);g.gain.setValueAtTime(0,audio.currentTime);
    master=audio.createGain();master.gain.value=volume*0.35;master.connect(audio.destination);setTimeout(()=>g.disconnect(),100);scheduled=new Set();};
  function voice(at,length,pitch,velocity,drum){
    const ctx=audio,gain=ctx.createGain(),v=Math.max(0.08,velocity/127);gain.connect(master);
    if(drum){
      const noise=ctx.createBufferSource(),buffer=ctx.createBuffer(1,Math.round(ctx.sampleRate*0.12),ctx.sampleRate),data=buffer.getChannelData(0);
      for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*(1-i/data.length)**3;
      const filter=ctx.createBiquadFilter();filter.type=pitch<40?'lowpass':'highpass';filter.frequency.value=pitch<40?180:2500;
      noise.buffer=buffer;noise.connect(filter);filter.connect(gain);gain.gain.value=v;noise.start(at);return;
    }
    const osc=ctx.createOscillator();osc.type='triangle';osc.frequency.value=440*2**((pitch-69)/12);osc.connect(gain);
    const end=at+Math.min(4,Math.max(0.06,length));
    gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(v,at+0.008);gain.gain.setTargetAtTime(v*0.55,at+0.02,0.15);
    gain.gain.setTargetAtTime(0,end,0.04);osc.start(at);osc.stop(end+0.3);
  }
  return {
    setVolume(v){volume=v;if(master)master.gain.value=v*0.35;},
    // notes: [{start,end,pitch,velocity,drum,key}] in song seconds; time: where the song is; playing; rate (1 = normal speed)
    update(notes,time,playing,rate=1){
      const jumped=lastTime!=null&&(time<lastTime-0.05||time>lastTime+0.6);
      if(!playing||jumped||!lastPlaying){if(scheduled.size)hush();}
      lastTime=time;lastPlaying=playing;if(!playing||!notes.length||!volume)return;
      const ctx=ensure();if(ctx.state==='suspended')ctx.resume();
      let lo=0,hi=notes.length;while(lo<hi){const mid=(lo+hi)>>1;if(notes[mid].start<time-0.02)lo=mid+1;else hi=mid;}
      for(let i=lo;i<notes.length&&notes[i].start<time+LOOKAHEAD*rate;i++){
        const n=notes[i];if(scheduled.has(n.key))continue;scheduled.add(n.key);
        voice(ctx.currentTime+Math.max(0,(n.start-time)/rate),(n.end-n.start)/rate,n.pitch,n.velocity,n.drum);
      }
      if(scheduled.size>4000)scheduled=new Set();
    },
    stop(){hush();lastTime=null;},
    dispose(){try{audio?.close();}catch{}audio=null;},
  };
}

export function createMidiImport(ctx){
  let open=null;                                     // the screen while it is up

  // ---- choosing the song ----
  function chooseSong(fileName,fileSeconds,inside=[]){
    return new Promise(resolve=>{
      const dialog=el('dialog','choice-dialog mi-choose');dialog.append(el('h2','','Which song is this for?'));
      dialog.append(el('p','choice-text',`${fileName}: pick the song it goes with. You'll line it up with the recording next.`));
      const search=el('input','mi-search');search.type='search';search.placeholder='Search songs';search.setAttribute('aria-label','Search songs');
      const list=el('div','mi-song-list');dialog.append(search,list);
      const ranked=rankSongs(ctx.songs(),[fileName,...inside].join(' '),fileSeconds);
      const render=()=>{
        list.replaceChildren();const q=search.value.trim().toLowerCase();
        for(const {song,name,length} of ranked.filter(r=>!q||`${r.song.title} ${r.song.artist}`.toLowerCase().includes(q))){
          const row=button('','mi-song');row.dataset.song=song.id;
          row.append(el('b','',song.title||'Untitled'),el('small','',[song.artist,song.duration?timeLabel(song.duration).replace(/\.\d$/,''):'',name>0.5?'similar name':length>0.95?'same length':''].filter(Boolean).join(' · ')));
          row.onclick=()=>finish(song.id);list.append(row);
        }
        if(!list.children.length)list.append(el('p','choice-text','No songs match.'));
      };
      const actions=el('div','choice-actions'),cancel=button('Cancel','secondary choice-cancel btn-cancel');actions.append(cancel);dialog.append(actions);
      let done=false;const finish=id=>{if(done)return;done=true;try{dialog.close();}catch{}dialog.remove();resolve(id);};
      cancel.onclick=()=>finish(null);dialog.oncancel=e=>{e.preventDefault();finish(null);};search.oninput=render;
      search.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();list.querySelector('.mi-song')?.click();}};   // Enter takes the top match
      document.body.append(dialog);render();dialog.showModal();search.focus();
    });
  }

  // ---- dropping or picking a file ----
  async function importFile(file,{songId=null}={}){
    if(!file)return;
    if(!isMidiName(file.name)){ctx.showError(new Error('Choose a MIDI file (.mid or .midi).'));return;}
    if(file.size>16*1024*1024){ctx.showError(new Error('This MIDI file is larger than 16 MB.'));return;}
    let bytes,parsed;
    try{bytes=new Uint8Array(await file.arrayBuffer());parsed=readFile(bytes);}catch(error){ctx.showError(error);return;}
    if(!parsed.sources.length){ctx.showError(new Error(`${file.name} has no notes or controllers in it.`));return;}
    let target=songId;
    if(!target){
      const current=ctx.currentSongId(),context=current?await ctx.songContext(current).catch(()=>null):null;
      target=songForDrop({songId:current,playhead:ctx.playhead(),duration:context?.duration,measures:context?.measures});
      if(!target)target=await chooseSong(file.name,parsed.clock.seconds(parsed.lastTick),parsed.parsed.tracks.map(t=>t.name).filter(Boolean));
      if(!target)return;
    }
    if(target!==ctx.currentSongId())await ctx.openSong(target);
    // the same file name again on this song: most likely a new export of it, which keeps its placement and parts
    let replace=null;
    try{
      const existing=(await ctx.api('/api/user-midi/'+encodeURIComponent(target))).files.find(f=>f.name.toLowerCase()===file.name.toLowerCase());
      if(existing){
        const choice=await askChoice({title:'Update this MIDI file?',message:[`This song already has ${existing.name}.`,'Update it to keep its placement and what each part is for, or add this one as a separate file.'],
          choices:[{id:'new',label:'Add as new',kind:'secondary'},{id:'update',label:'Update it',kind:'primary'}]});
        if(!choice)return;if(choice==='update')replace=existing;
      }
    }catch(error){ctx.showError(error);return;}
    await openWorkspace({songId:target,name:file.name,bytes,file:parsed,entry:replace,isNew:!replace,upload:true});
  }

  // ---- the manager: the files a song has ----
  async function openManager(songId){
    if(!songId)return;
    const dialog=el('dialog','choice-dialog mi-manager');dialog.append(el('h2','','Your MIDI files'));
    const intro=el('p','choice-text','MIDI you bring for the visualizer: your own performance, with real dynamics, pedals and bends. The chart and the model\'s MIDI stay as they are.');
    const list=el('div','mi-file-list'),note=el('p','choice-text mi-note','');
    const input=el('input');input.type='file';input.accept='.mid,.midi,audio/midi';input.hidden=true;
    const add=button('Add a MIDI file…','btn'),custom=button('Add custom MIDI data','btn blue','A new file laid out on this song\'s beats, ready to play or draw into in your DAW');
    const folder=button('Show folder','secondary');
    const top=el('div','mi-manager-actions');top.append(add,custom,folder,input);
    const actions=el('div','choice-actions'),close=button('Done','btn btn-ok');actions.append(close);
    dialog.append(intro,top,list,note,actions);
    let done=false;const finish=()=>{if(done)return;done=true;clearInterval(watch);try{dialog.close();}catch{}dialog.remove();};
    close.onclick=finish;dialog.oncancel=e=>{e.preventDefault();finish();};
    add.onclick=()=>input.click();
    input.onchange=()=>{const f=input.files[0];input.value='';if(f){finish();importFile(f,{songId});}};
    folder.onclick=()=>ctx.api('/api/user-midi/folder',{song_id:songId}).catch(ctx.showError);
    custom.onclick=async()=>{custom.disabled=true;try{await addCustom(songId,note);await render();}catch(error){note.textContent=error.message||String(error);}finally{custom.disabled=false;}};
    let stamp='';
    async function render(){
      const files=(await ctx.api('/api/user-midi/'+encodeURIComponent(songId))).files;
      stamp=JSON.stringify(files.map(f=>[f.id,f.mtime,f.name]));
      // each file's parts as it is now (a new export from the DAW can add or drop parts), exactly as the visualizer will read them
      const read=new Map((await loadSongFiles(songId,files,path=>ctx.bytes(path),summaryFiles)).map(x=>[x.id,x.file]));
      const partsOf=f=>read.has(f.id)?cleanParts(f.settings,read.get(f.id)):(f.settings?.parts||{});
      list.replaceChildren();
      // a melody can be replaced by one file only: the first in the list that claims it (as the visualizer reads them)
      const owner={};for(const f of files)for(const p of Object.values(partsOf(f)))if(REPLACEABLE.includes(p.use)&&!owner[p.use])owner[p.use]=f.id;
      if(!files.length)list.append(el('p','choice-text mi-empty','None yet. Drop a .mid file anywhere on the app, or add one here.'));
      for(const f of files){
        const row=el('div','mi-file'),info=el('div','mi-file-info');
        const uses=Object.values(partsOf(f)).map(p=>p.use);
        const claim=role=>!uses.includes(role)?'':owner[role]===f.id?`replaces the ${role} melody`:`would replace the ${role} melody, but ${files.find(x=>x.id===owner[role]).name} already does`;
        const summary=[claim('vocal'),claim('instrumental'),
          uses.filter(u=>u==='extra').length?`${uses.filter(u=>u==='extra').length} extra part${uses.filter(u=>u==='extra').length>1?'s':''}`:''].filter(Boolean).join(', ')||'not set up yet';
        info.append(el('b','',f.name),el('small','',`${summary} · changed ${new Date(f.mtime*1000).toLocaleString()}`));
        const edit=button('Line up','secondary'),ext=button('Open in your DAW','secondary','Opens this file in your music program. Export back over the same file and it updates here.'),
          remove=button('Remove','secondary mi-remove');
        edit.onclick=async()=>{finish();try{const bytes=new Uint8Array(await ctx.bytes(`/api/user-midi/${encodeURIComponent(songId)}/${f.id}`));
          await openWorkspace({songId,name:f.name,bytes,file:readFile(bytes),entry:f,isNew:false,upload:false});}catch(error){ctx.showError(error);}};
        ext.onclick=async()=>{try{note.textContent=(await ctx.api('/api/user-midi/open',{song_id:songId,id:f.id})).message;}catch(error){note.textContent=error.message;}};
        remove.onclick=async()=>{
          const sure=await askChoice({title:'Remove this MIDI file?',message:[`${f.name} will no longer be used by the visualizer.`,'A copy is kept in the song\'s my-midi/removed folder.'],choices:[{id:'remove',label:'Remove',kind:'danger'}]});
          if(sure!=='remove')return;try{await ctx.api('/api/user-midi/remove',{song_id:songId,id:f.id});ctx.onChanged(songId);await render();}catch(error){note.textContent=error.message;}
        };
        row.append(info,edit,ext,remove);list.append(row);
      }
    }
    // a file exported back over from the DAW shows up without reopening
    const watch=setInterval(async()=>{try{const files=(await ctx.api('/api/user-midi/'+encodeURIComponent(songId))).files;
      if(JSON.stringify(files.map(f=>[f.id,f.mtime,f.name]))!==stamp){await render();ctx.onChanged(songId);}}catch{}},4000);
    document.body.append(dialog);dialog.showModal();
    try{await render();}catch(error){note.textContent=error.message;}
  }

  // A new file on the song's beats with the model's melodies in it (to fix in place) and an empty track for your own part.
  async function addCustom(songId,note){
    const c=await ctx.songContext(songId);
    const bytes=customMidi({measures:c.measures,model:c.model,title:c.title});
    const base=`${(c.title||'Song').replace(/[\\/:*?"<>|]+/g,' ').trim()||'Song'} custom.mid`;
    const entry=await ctx.api(`/api/user-midi/upload?song=${encodeURIComponent(songId)}&name=${encodeURIComponent(base)}&unique=1`,undefined,
      {method:'POST',headers:{'Content-Type':'audio/midi'},body:bytes});
    const file=readFile(bytes);
    const settings=cleanSettings({alignment:{mode:'tempo',start:0,ratio:1}},file,{grid:songGrid(c.measures),duration:c.duration,firstBar:c.firstBar});
    // a melody another file already replaces stays with that file: this one's copy of it is left out until you choose otherwise
    const others=(await ctx.api('/api/user-midi/'+encodeURIComponent(songId))).files.filter(f=>f.id!==entry.id);
    const taken=new Set(others.flatMap(f=>Object.values(f.settings?.parts||{}).map(p=>p.use)).filter(u=>REPLACEABLE.includes(u)));
    for(const [id,p] of Object.entries(settings.parts))if(taken.has(p.use))settings.parts[id]={use:'off'};
    await ctx.api('/api/user-midi/settings',{song_id:songId,id:entry.id,settings});
    ctx.onChanged(songId);
    if(note)note.textContent=`Made ${entry.name}. Open it in your DAW (keep the tempo map when it asks), play or draw into "Your part", then export back over the same file.`;
    return entry;
  }

  // ---- the workspace ----
  async function openWorkspace({songId,name,bytes,file,entry,isNew,upload}){
    close();
    const c=await ctx.songContext(songId);
    if(!c.measures?.length){ctx.showError(new Error('This song has no bars yet. Analyze it first, then bring in your MIDI.'));return;}
    const grid=songGrid(c.measures),duration=c.duration||grid.end||0;
    let settings=cleanSettings(entry?.settings||null,file,{grid,duration,firstBar:c.firstBar});
    const hear=new Set(file.sources.filter(s=>s.notes.length).map(s=>s.id));
    let place=null,view={start:0,pps:60},follow=0,snapping=true,tool='move',guess=null,dirty=isNew||upload,saving=false;   // a new export of a file is unsaved until Save
    // melodies other files of this song replace: choosing one here takes it over from them when you save
    // (the first file in the list that claims a melody is the one the visualizer uses, as midi-user.js reads them)
    const all=(await ctx.api('/api/user-midi/'+encodeURIComponent(songId)).catch(()=>({files:[]}))).files,others=all.filter(f=>f.id!==entry?.id);
    const heldBy=role=>{const first=all.find(f=>Object.values(f.settings?.parts||{}).some(p=>p.use===role));return first&&first.id!==entry?.id?first:null;};
    const refs=guessReferences({melody:[...(c.model.vocal||[]),...(c.model.instrumental||[])],onsets:c.onsets,drumHits:c.drumHits,chords:c.chords,duration});

    // DOM
    const root=el('div','mi-overlay');root.setAttribute('role','dialog');root.setAttribute('aria-label','Line up your MIDI');
    const panel=el('div','mi-panel');root.append(panel);
    const head=el('header','mi-head');
    const title=el('div','mi-title');title.append(el('h2','','Line up your MIDI'),el('small','',`${name} → ${c.title||'this song'}`));
    const cancel=button('Cancel','btn btn-cancel'),save=button(isNew?'Save':'Save changes','btn blue');head.append(title,cancel,save);
    const bar=el('div','mi-toolbar');
    const modes=el('div','mi-seg');modes.setAttribute('role','group');modes.setAttribute('aria-label','How to place the file');
    const beatsMode=button('Follow the song\'s beats','','Lays the file\'s beats on the beats found in the recording: a missing or wrong tempo, drift and a live feel all come out right');
    const tempoMode=button('Use the file\'s tempo','','Places the file by its own tempo, in seconds: for a file made over this recording, like a Reaper export of the project');
    modes.append(beatsMode,tempoMode);
    const ratios=el('div','mi-seg mi-ratios');for(const [r,label,tip] of RATIO_BUTTONS){const b=button(label,'',tip);b.dataset.ratio=String(r);ratios.append(b);}
    const startWrap=el('label','mi-field'),startBar=el('input');startBar.type='number';startBar.min='1';startBar.step='1';startWrap.append('Starts at bar ',startBar);
    startWrap.title='The song bar where the file\'s bar 1 lands';
    const trWrap=el('div','mi-field mi-transpose'),trDown=button('−','mi-mini','Transpose down a semitone'),trValue=el('span','mi-tr','0'),trUp=button('+','mi-mini','Transpose up a semitone');
    trWrap.append('Transpose ',trDown,trValue,trUp);
    const tools=el('div','mi-seg');const moveTool=button('Move','','Drag a part to move the whole file'),pinTool=button('Pin','','Drag a note to where it belongs in the song: it is pinned there, and the file stretches between pins (Shift-drag does this too)');tools.append(moveTool,pinTool);
    const snap=button('Snap','mi-snap','Snap to the song\'s grid (it gets finer as you zoom in). Hold Alt while dragging to place freely.');
    const clearPins=button('Clear pins','secondary');
    const guessButton=button('Guess','btn','Slides your file along the song and finds where it agrees best with the recording and the chords');
    bar.append(modes,ratios,startWrap,trWrap,tools,snap,clearPins,guessButton);
    const guessLine=el('div','mi-guess');
    const strip=el('div','mi-strip'),canvas=el('canvas','mi-canvas');strip.append(canvas);canvas.tabIndex=0;canvas.setAttribute('aria-label','Your MIDI over the song. Drag to move; arrow keys nudge by the snap.');
    const foot=el('div','mi-foot');
    const zoomOut=button('−','mi-mini','Zoom out'),zoomIn=button('+','mi-mini','Zoom in'),fit=button('Fit song','secondary');
    const volume=el('input','mi-volume');volume.type='range';volume.min='0';volume.max='1';volume.step='0.05';volume.value='0.5';volume.title='Preview tone volume';volume.setAttribute('aria-label','Preview tone volume');
    const hint=el('span','mi-hint','Space plays the song with your notes as a quiet tone. Click the ruler to jump. Ctrl+wheel zooms.');
    const position=el('span','mi-position','');
    foot.append(zoomOut,zoomIn,fit,el('span','mi-label','Tone'),volume,position,hint);
    const parts=el('div','mi-parts');
    panel.append(head,bar,guessLine,strip,foot,parts);
    document.body.append(root);
    const tone=createTone();tone.setVolume(0.5);

    const colors=()=>{const s=getComputedStyle(root);const v=n=>s.getPropertyValue(n).trim();
      return {ink:v('--ink')||'#1A1C24',page:v('--page')||'#fff',soft:v('--soft')||'#666',line:v('--line')||'#0002',a1:v('--a1')||'#e5533d',a2:v('--a2')||'#2f6b5a',a3:v('--a3')||'#3b6fd8',hl:v('--hl')||'#f2c94c',desk:v('--desk')||'#eee'};};
    let palette=colors();
    const laneColor=i=>[palette.a2,palette.a3,palette.a1,palette.hl][i%4];

    // derived
    let placed=[];                                   // per source: notes in song seconds
    let toneNotes=[];
    function recompute(){
      settings.alignment=cleanAlignment(settings.alignment);
      place=placement(grid,file.clock,settings.alignment);
      placed=file.sources.map(s=>s.notes.map(n=>({start:place.seconds(n.tick),end:Math.max(place.seconds(n.tick)+0.02,place.seconds(n.endTick)),pitch:n.pitch+settings.alignment.transpose,velocity:n.velocity,tick:n.tick})));
      toneNotes=[];file.sources.forEach((s,i)=>{if(!hear.has(s.id)||settings.parts[s.id]?.use==='off')return;
        for(const [j,n] of placed[i].entries())toneNotes.push({...n,drum:s.kind==='drums',key:`${i}:${j}`});});
      toneNotes.sort((a,b)=>a.start-b.start);tone.stop();
    }
    let lane=LANE;                                 // this screen's lane height: as tall as the strip allows
    function fitLanes(){const room=(strip.clientHeight||0)-(RULER+CHORDS+SONG+GAP)-2,n=Math.max(1,file.sources.length);lane=Math.max(LANE,Math.min(MAX_LANE,Math.floor(room/n-GAP)));}
    function laneTop(i){return RULER+CHORDS+SONG+GAP+i*(lane+GAP);}
    function contentHeight(){return laneTop(file.sources.length);}
    const xOf=t=>(t-view.start)*view.pps,tOf=x=>view.start+x/view.pps;
    function clampView(){
      const width=canvas.clientWidth||800,minPps=Math.max(2,width/Math.max(10,duration+8));
      view.pps=Math.max(minPps,Math.min(1200,view.pps));view.start=Math.max(-4,Math.min(duration+4-width/view.pps,view.start));
    }
    function fitSong(){const width=canvas.clientWidth||800;view.pps=width/Math.max(10,duration+2);view.start=-1;clampView();}
    function showFirstNotes(){
      const first=Math.min(...placed.flat().map(n=>n.start).filter(Number.isFinite));
      const beat=beatSeconds(grid,1)-beatSeconds(grid,0)||0.5,width=canvas.clientWidth||800;
      view.pps=Math.max(20,Math.min(220,width/(beat*4*8)));view.start=(Number.isFinite(first)?first:0)-beat*4;clampView();
    }
    const pxPerBeat=()=>{const mid=tOf((canvas.clientWidth||800)/2),b=secondsBeat(grid,mid);return (beatSeconds(grid,b+1)-beatSeconds(grid,b))*view.pps;};
    const grain=()=>snapping?grainFor(pxPerBeat()):'free';

    // drawing
    function draw(){
      const width=canvas.clientWidth||800,height=contentHeight(),dpr=window.devicePixelRatio||1;
      if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);canvas.style.height=height+'px';}
      const g=canvas.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,width,height);
      g.fillStyle=palette.page;g.fillRect(0,0,width,height);
      const t0=view.start,t1=tOf(width);
      // grid: bars strong, beats faint (beats only when there is room)
      const showBeats=pxPerBeat()>=7;
      const b0=Math.max(0,Math.floor(secondsBeat(grid,t0))),b1=Math.min(grid.beats.length-1,Math.ceil(secondsBeat(grid,t1)));
      const barStarts=new Set(grid.bars);
      for(let b=b0;b<=b1;b++){
        const x=xOf(grid.beats[b]),isBar=barStarts.has(b);if(!isBar&&!showBeats)continue;
        g.fillStyle=isBar?palette.ink:palette.line;g.globalAlpha=isBar?0.35:1;g.fillRect(Math.round(x),RULER,1,height-RULER);g.globalAlpha=1;
      }
      // ruler: bar numbers as the chart counts them
      g.fillStyle=palette.desk;g.fillRect(0,0,width,RULER);g.fillStyle=palette.ink;g.fillRect(0,RULER-1,width,1);
      g.font='700 11px "Space Mono",monospace';g.textBaseline='middle';
      const labelEvery=Math.max(1,Math.ceil(36/Math.max(1,pxPerBeat()*4)));
      grid.bars.forEach((beat,i)=>{const t=grid.beats[beat];if(t<t0-5||t>t1)return;const n=i-c.firstBar+1;if(n<1&&i!==0)return;if((n-1)%labelEvery)return;
        const x=xOf(t);g.fillRect(Math.round(x),RULER-9,1,8);g.fillText(String(n),x+3,RULER/2-2);});
      // chords
      g.font='700 11px "Bricolage Grotesque",system-ui,sans-serif';
      for(const ch of c.chords){if(ch.end<t0||ch.start>t1||!ch.label||/^N$/i.test(ch.label))continue;const x=xOf(ch.start),w=xOf(ch.end)-x;
        g.fillStyle=palette.ink;g.globalAlpha=0.06;g.fillRect(x+1,RULER+2,w-2,CHORDS-4);g.globalAlpha=1;
        if(w>18){g.save();g.beginPath();g.rect(x,RULER,w,CHORDS);g.clip();g.fillStyle=palette.ink;g.fillText(ch.label,x+4,RULER+CHORDS/2);g.restore();}}
      // the recording: the model's melodies faintly, and the moments something starts
      const songTop=RULER+CHORDS;g.fillStyle=palette.desk;g.globalAlpha=0.6;g.fillRect(0,songTop,width,SONG);g.globalAlpha=1;
      const modelNotes=[...(c.model.vocal||[]),...(c.model.instrumental||[])];
      if(modelNotes.length){let lo=127,hi=0;for(const n of modelNotes){lo=Math.min(lo,n.pitch);hi=Math.max(hi,n.pitch);}const span=Math.max(12,hi-lo+1);
        g.fillStyle=palette.soft;g.globalAlpha=0.45;
        for(const n of modelNotes){if(n.end<t0||n.start>t1)continue;const y=songTop+4+(1-(n.pitch-lo+0.5)/span)*(SONG-12);g.fillRect(xOf(n.start),y,Math.max(1.5,(n.end-n.start)*view.pps),2.5);}
        g.globalAlpha=1;}
      g.fillStyle=palette.ink;g.globalAlpha=0.5;
      for(const t of refs.onsets){if(t<t0||t>t1)continue;g.fillRect(Math.round(xOf(t)),songTop+SONG-6,1,5);}
      g.globalAlpha=1;
      g.font='800 10px "Bricolage Grotesque",system-ui,sans-serif';g.fillStyle=palette.soft;g.textBaseline='top';g.fillText('THE RECORDING',6,songTop+3);
      // your parts
      file.sources.forEach((s,i)=>{
        const top=laneTop(i),use=settings.parts[s.id]?.use,color=laneColor(i),off=use==='off';
        g.fillStyle=color;g.globalAlpha=0.07;g.fillRect(0,top,width,lane);g.globalAlpha=1;
        g.fillStyle=palette.ink;g.fillRect(0,top+lane,width,1);
        const notes=placed[i];
        if(notes.length){
          let lo=127,hi=0;for(const n of notes){lo=Math.min(lo,n.pitch);hi=Math.max(hi,n.pitch);}const span=Math.max(12,hi-lo+1),row=(lane-16)/span;
          for(const n of notes){if(n.end<t0||n.start>t1)continue;const x=xOf(n.start),w=Math.max(2,(n.end-n.start)*view.pps),y=top+8+(hi-n.pitch)*row;
            g.globalAlpha=off?0.25:0.35+0.65*(n.velocity/127);g.fillStyle=color;g.fillRect(x,y,s.kind==='drums'?Math.max(3,Math.min(w,6)):w,Math.max(2,row-0.5));
            g.globalAlpha=off?0.25:1;g.fillStyle=palette.ink;g.fillRect(x,y,1,Math.max(2,row-0.5));}
          g.globalAlpha=1;
        }
        // controls as a thin line along the lane's foot: pedal down as a bar, amounts as a curve
        const ctl=s.controls||{};
        if(ctl.cc64?.length){g.fillStyle=palette.ink;g.globalAlpha=0.5;let down=null;
          for(const p of ctl.cc64){const t=place.seconds(p.tick);if(p.value>=0.5&&down===null)down=t;else if(p.value<0.5&&down!==null){g.fillRect(xOf(down),top+lane-5,(t-down)*view.pps,3);down=null;}}
          if(down!==null)g.fillRect(xOf(down),top+lane-5,width,3);g.globalAlpha=1;}
        // up to two continuous controls (mod wheel, expression, bend, aftertouch...) as thin curves along the lane's lower part
        const curves=Object.entries(ctl).filter(([k,p])=>p?.length&&!/^cc(6[4-9])$/.test(k)).slice(0,2);
        curves.forEach(([key,points],c)=>{
          const bipolar=key==='bend'||key==='cc8'||key==='cc10',h=18,base=top+lane-8-c*4;
          const y=v=>bipolar?base-h/2-v*h/2:base-v*h;
          g.strokeStyle=c?palette.a1:palette.ink;g.globalAlpha=0.55;g.lineWidth=1.25;g.beginPath();
          let started=false,lastY=null;
          for(const p of points){const x=xOf(place.seconds(p.tick));if(x<-50){lastY=y(p.value);continue;}if(x>width+50)break;
            if(!started){g.moveTo(-1,lastY??y(p.value));started=true;}g.lineTo(x,lastY??y(p.value));g.lineTo(x,y(p.value));lastY=y(p.value);}
          if(started)g.lineTo(width+1,lastY);g.stroke();g.globalAlpha=1;
        });
        g.font='800 11px "Bricolage Grotesque",system-ui,sans-serif';g.textBaseline='top';g.fillStyle=palette.ink;g.globalAlpha=off?0.45:1;
        const label=`${s.name}${off?' (left out)':''}`;g.fillStyle=palette.page;g.globalAlpha=0.85;g.fillRect(4,top+3,g.measureText(label).width+8,15);g.globalAlpha=off?0.45:1;g.fillStyle=palette.ink;g.fillText(label,8,top+5);g.globalAlpha=1;
      });
      // pins
      for(const a of settings.alignment.anchors){const x=xOf(a.time);if(x<-10||x>width+10)continue;
        g.fillStyle=palette.a1;g.fillRect(Math.round(x)-1,RULER,2,height-RULER);
        g.beginPath();g.moveTo(x,RULER+CHORDS+SONG-2);g.lineTo(x+7,RULER+CHORDS+SONG+7);g.lineTo(x,RULER+CHORDS+SONG+16);g.lineTo(x-7,RULER+CHORDS+SONG+7);g.closePath();g.fill();
        g.strokeStyle=palette.ink;g.lineWidth=1.5;g.stroke();}
      // the playhead
      const now=ctx.transport.getSnapshot().seconds,px=xOf(now);
      if(px>=0&&px<=width){g.fillStyle=palette.a1;g.fillRect(Math.round(px)-1,0,2,height);}
      position.textContent=`${timeLabel(now)} · bar ${Math.max(1,beatBar(grid,secondsBeat(grid,now))-c.firstBar+1)} · snap: ${grain()==='free'?'off':grain()}`;
    }

    // the controls reflect the settings
    function sync(){
      const a=settings.alignment;
      beatsMode.classList.toggle('on',a.mode==='beats');tempoMode.classList.toggle('on',a.mode==='tempo');
      beatsMode.setAttribute('aria-pressed',String(a.mode==='beats'));tempoMode.setAttribute('aria-pressed',String(a.mode==='tempo'));
      tempoMode.disabled=false;beatsMode.disabled=!file.clock.ticksPerQuarter;
      for(const b of ratios.children){const r=Number(b.dataset.ratio);b.classList.toggle('on',a.mode==='beats'&&Math.abs(a.ratio/baseRatio()-r)<1e-3);b.disabled=a.mode!=='beats';}
      const at=place.seconds(0);startBar.value=String(Math.max(1,beatBar(grid,secondsBeat(grid,at)+1e-6)-c.firstBar+1));
      trValue.textContent=a.transpose>0?`+${a.transpose}`:String(a.transpose);
      moveTool.classList.toggle('on',tool==='move');pinTool.classList.toggle('on',tool==='pin');
      moveTool.setAttribute('aria-pressed',String(tool==='move'));pinTool.setAttribute('aria-pressed',String(tool==='pin'));
      snap.classList.toggle('on',snapping);snap.setAttribute('aria-pressed',String(snapping));
      clearPins.disabled=!a.anchors.length;
      for(const chip of guessLine.querySelectorAll('.mi-fit[data-index]'))chip.classList.toggle('on',sameAlignment(guess.candidates[+chip.dataset.index].alignment,a));
      save.disabled=saving;save.textContent=saving?'Saving…':isNew?'Save':dirty?'Save changes':'Saved';
      renderParts();draw();
    }
    let base=null;const baseRatio=()=>{if(base==null){const d=defaultAlignment(file.clock,grid,{duration:0});base=d.mode==='beats'?d.ratio:1;}return base;};
    function change(next){settings={...settings,alignment:cleanAlignment(next)};dirty=true;recompute();sync();}

    // parts: what each one is, what it really has, and what it is for
    function renderParts(){
      parts.replaceChildren();
      const headRow=el('div','mi-part mi-part-head');headRow.append(el('span','','Hear'),el('span','','Part'),el('span','','What it has'),el('span','','Use as'));parts.append(headRow);
      file.sources.forEach((s,i)=>{
        const row=el('div','mi-part');row.style.setProperty('--lane',laneColor(i));
        const hearBox=el('input');hearBox.type='checkbox';hearBox.checked=hear.has(s.id);hearBox.disabled=!s.notes.length;hearBox.setAttribute('aria-label',`Hear ${s.name}`);
        hearBox.onchange=()=>{if(hearBox.checked)hear.add(s.id);else hear.delete(s.id);recompute();draw();};
        const nameCell=el('div','mi-part-name');nameCell.append(el('i','mi-swatch'),el('b','',s.name),el('small','',[s.kind==='mpe'?'MPE':s.kind==='drums'?'Drums':'',`${s.notes.length} note${s.notes.length===1?'':'s'}`,
          s.notes.length?`${pitchLabel(Math.min(...s.notes.map(n=>n.pitch)))}–${pitchLabel(Math.max(...s.notes.map(n=>n.pitch)))}`:''].filter(Boolean).join(' · ')));
        const chips=el('div','mi-chips');
        for(const sig of describeSignals(s)){const chip=el('span','mi-chip',sig.label);chip.title=`${sig.label}: ${SIGNAL_TYPES[sig.type]||sig.type}`;chip.dataset.type=sig.type;chips.append(chip);}
        const select=el('select');select.setAttribute('aria-label',`Use ${s.name} as`);
        for(const [id,label] of USES){
          const option=el('option','',label);option.value=id;
          if(REPLACEABLE.includes(id)&&!s.notes.length){option.disabled=true;option.textContent+=' (no notes)';}
          else if(REPLACEABLE.includes(id)&&heldBy(id))option.textContent+=` (takes it from ${heldBy(id).name})`;
          select.append(option);
        }
        select.value=settings.parts[s.id]?.use||'extra';
        select.onchange=()=>{
          const use=select.value,next={...settings.parts};
          if(REPLACEABLE.includes(use))for(const [id,p] of Object.entries(next))if(id!==s.id&&p.use===use)next[id]={use:'extra'};   // one part per melody
          next[s.id]={use};settings={...settings,parts:next};dirty=true;recompute();sync();
        };
        row.append(hearBox,nameCell,chips,select);parts.append(row);
      });
      const note=el('p','mi-parts-note','Only what is really in your file is listed. "Replace" changes what the visualizer sees, never the chart or the model\'s MIDI.');
      parts.append(note);
    }

    // guessing
    function runGuess(apply){
      guessLine.textContent='Guessing…';guessLine.className='mi-guess busy';
      setTimeout(()=>{
        const notes=file.sources.flatMap(s=>settings.parts[s.id]?.use==='off'?[]:s.notes.map(n=>({...n,drum:s.kind==='drums'})));
        try{guess=guessAlignment({file:file.clock,grid,notes,refs,duration,lastTick:file.lastTick});}catch(error){guess=null;guessLine.textContent='Could not guess: '+(error.message||error);return;}
        if(apply&&guess.candidates[0]){const a=guess.candidates[0].alignment;change({...a,transpose:settings.alignment.transpose,anchors:[]});dirty=isNew||upload;showFirstNotes();sync();}
        renderGuess();
      },30);
    }
    function renderGuess(){
      guessLine.replaceChildren();guessLine.className='mi-guess';
      if(!guess?.candidates.length){guessLine.textContent='No guess: there is not enough in the recording or the chords to compare with. Line it up by ear.';return;}
      const sure={high:'fairly sure',medium:'a reasonable fit',low:'not sure: check by ear'}[guess.confidence];
      guessLine.append(el('b','','Best fit: '));
      guess.candidates.forEach((cand,i)=>{
        const a=cand.alignment,label=`${a.mode==='tempo'?'file tempo, ':''}bar ${Math.max(1,cand.bar-c.firstBar+1)}${a.mode==='beats'&&Math.abs(a.ratio-baseRatio())>1e-3?` at ${+(a.ratio/baseRatio()).toFixed(2)}×`:''}`;
        const chip=button(label,'mi-fit'+(sameAlignment(a,settings.alignment)?' on':''),`Agrees with ${Math.round(cand.onset*100)}% of note starts${cand.harmony?` and ${Math.round(cand.harmony*100)}% with the chords`:''}`);
        chip.dataset.index=String(i);chip.onclick=()=>change({...a,transpose:settings.alignment.transpose,anchors:[]});
        guessLine.append(chip);if(i===0)guessLine.append(el('span','mi-sure',`(${sure})`),el('span','mi-or',guess.candidates.length>1?'Other fits:':''));
      });
      if(guess.transpose){const t=guess.transpose,fix=button(`Your notes fit the chords ${Math.abs(t)} semitone${Math.abs(t)>1?'s':''} ${t>0?'higher':'lower'}: transpose`,'mi-fit mi-key');
        fix.onclick=()=>{change({...settings.alignment,transpose:t});renderGuess();};guessLine.append(fix);}
    }
    const sameAlignment=(a,b)=>a.mode===b.mode&&Math.abs(a.start-b.start)<1e-6&&Math.abs(a.ratio-b.ratio)<1e-6&&!b.anchors.length;

    // pointer: move the file, pin a note, drag a pin, click the ruler to jump
    let drag=null;
    function nearestNote(x,y){
      const i=file.sources.findIndex((_,k)=>y>=laneTop(k)&&y<laneTop(k)+lane);if(i<0)return null;
      let best=null,bestD=10;
      for(const n of placed[i]){const d=Math.abs(xOf(n.start)-x);if(d<bestD){bestD=d;best=n;}if(xOf(n.start)>x+10)break;}
      return {lane:i,note:best};
    }
    canvas.addEventListener('pointerdown',event=>{
      const r=canvas.getBoundingClientRect(),x=event.clientX-r.left,y=event.clientY-r.top;canvas.focus();
      if(y<RULER){ctx.transport.seek(Math.max(0,tOf(x)));follow=0;return;}
      const pin=settings.alignment.anchors.find(a=>Math.abs(xOf(a.time)-x)<8&&y>=RULER);
      if(pin){drag={kind:'pin',tick:pin.tick,from:settings.alignment,grab:xOf(pin.time)-x};}
      else{
        const hit=nearestNote(x,y);if(!hit&&y<laneTop(0))return;
        // what is snapped is the file's own grid line nearest the grab (a sixteenth), so a played, slightly loose part stays on its grid
        const raw=hit?.note?hit.note.tick:place.tick(tOf(x)),q=file.clock.ticksPerQuarter?file.clock.ticksPerQuarter/4:0;
        const tick=q?Math.max(0,Math.round(raw/q)*q):raw,at=place.seconds(tick);
        drag={kind:tool==='pin'||event.shiftKey?'pin-new':'move',tick,from:settings.alignment,grab:xOf(at)-x};
      }
      canvas.setPointerCapture(event.pointerId);event.preventDefault();
    });
    canvas.addEventListener('pointermove',event=>{
      const r=canvas.getBoundingClientRect(),x=event.clientX-r.left,y=event.clientY-r.top;
      if(!drag){const pin=settings.alignment.anchors.some(a=>Math.abs(xOf(a.time)-x)<8&&y>=RULER);canvas.style.cursor=y<RULER?'pointer':pin?'ew-resize':y>=laneTop(0)?(tool==='pin'||event.shiftKey?'crosshair':'grab'):'default';return;}
      const raw=tOf(x+drag.grab),t=event.altKey?raw:snapSeconds(grid,raw,grain());
      if(drag.kind==='move')change(moveTo(grid,file.clock,drag.from,drag.tick,t));
      else change(addAnchor(drag.from,drag.tick,t));
      canvas.style.cursor='grabbing';
    });
    const endDrag=()=>{drag=null;};
    // double-click a pin to take it out (pointer events carry no click count in Chromium, so this listens for the double-click itself)
    canvas.addEventListener('dblclick',event=>{
      const r=canvas.getBoundingClientRect(),x=event.clientX-r.left,y=event.clientY-r.top;
      const pin=settings.alignment.anchors.find(a=>Math.abs(xOf(a.time)-x)<8&&y>=RULER);if(pin)change(removeAnchor(settings.alignment,pin.tick));
    });
    canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);
    canvas.addEventListener('wheel',event=>{
      event.preventDefault();const r=canvas.getBoundingClientRect(),x=event.clientX-r.left;
      if(event.ctrlKey||event.metaKey){const at=tOf(x);view.pps*=Math.exp(-event.deltaY*0.0015);clampView();view.start=at-x/view.pps;}
      else view.start+=(Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY)/view.pps;
      clampView();follow=performance.now()+4000;draw();
    },{passive:false});
    canvas.addEventListener('keydown',event=>{
      if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();
      // nudge the file by one step of the snap (a beat when snapping is off, an eighth with Shift)
      const g=grain(),steps={bar:4,beat:1,eighth:0.5,sixteenth:0.25,free:1}[g]*(event.shiftKey?0.5:1)*(event.key==='ArrowLeft'?-1:1);
      const a=settings.alignment;
      if(a.mode==='beats'&&!a.anchors.length)change({...a,start:a.start+steps});
      else{const t=place.seconds(0),b=secondsBeat(grid,t);change(moveTo(grid,file.clock,a,0,beatSeconds(grid,b+steps)));}
    });

    // toolbar
    beatsMode.onclick=()=>{if(settings.alignment.mode!=='beats')change(switchMode(grid,file.clock,settings.alignment,'beats',firstTick()));};
    tempoMode.onclick=()=>{if(settings.alignment.mode!=='tempo')change(switchMode(grid,file.clock,settings.alignment,'tempo',firstTick()));};
    for(const b of ratios.children)b.onclick=()=>{const r=Number(b.dataset.ratio)*baseRatio();change(rescale(grid,file.clock,settings.alignment,Math.abs(settings.alignment.ratio-r)<1e-6?baseRatio():r,firstTick()));};
    startBar.onchange=()=>{const n=Math.round(Number(startBar.value));if(!Number.isFinite(n))return sync();
      const target=beatSeconds(grid,barBeat(grid,Math.max(0,n-1+c.firstBar)));change(moveTo(grid,file.clock,settings.alignment,0,target));};
    trDown.onclick=()=>change({...settings.alignment,transpose:settings.alignment.transpose-1});
    trUp.onclick=()=>change({...settings.alignment,transpose:settings.alignment.transpose+1});
    moveTool.onclick=()=>{tool='move';sync();};pinTool.onclick=()=>{tool='pin';sync();};
    snap.onclick=()=>{snapping=!snapping;sync();};
    clearPins.onclick=()=>change({...settings.alignment,anchors:[]});
    guessButton.onclick=()=>runGuess(true);
    zoomIn.onclick=()=>{const mid=tOf(canvas.clientWidth/2);view.pps*=1.5;clampView();view.start=mid-canvas.clientWidth/2/view.pps;clampView();draw();};
    zoomOut.onclick=()=>{const mid=tOf(canvas.clientWidth/2);view.pps/=1.5;clampView();view.start=mid-canvas.clientWidth/2/view.pps;clampView();draw();};
    fit.onclick=()=>{fitSong();draw();};
    volume.oninput=()=>tone.setVolume(Number(volume.value));
    const firstTick=()=>{let t=Infinity;for(const s of file.sources)for(const n of s.notes)t=Math.min(t,n.tick);return Number.isFinite(t)?t:0;};

    // saving and leaving
    save.onclick=async()=>{
      if(saving)return;saving=true;sync();
      try{
        let target=entry;
        if(upload)target=await ctx.api(`/api/user-midi/upload?song=${encodeURIComponent(songId)}&name=${encodeURIComponent(name)}${entry?`&replace=${entry.id}`:''}`,undefined,
          {method:'POST',headers:{'Content-Type':'audio/midi'},body:bytes});
        await ctx.api('/api/user-midi/settings',{song_id:songId,id:target.id,settings});
        // a melody this file now replaces is released by any other file that had it
        const mine=new Set(Object.values(settings.parts).map(p=>p.use).filter(u=>REPLACEABLE.includes(u)));
        for(const f of others){
          const parts=Object.fromEntries(Object.entries(f.settings?.parts||{}).map(([id,p])=>[id,mine.has(p.use)?{use:'extra'}:p]));
          if(JSON.stringify(parts)!==JSON.stringify(f.settings?.parts||{}))await ctx.api('/api/user-midi/settings',{song_id:songId,id:f.id,settings:{...f.settings,parts}});
        }
        entry=target;upload=false;isNew=false;dirty=false;ctx.onChanged(songId);finish();
      }catch(error){ctx.showError(error);}finally{saving=false;if(open)sync();}
    };
    cancel.onclick=async()=>{
      if(dirty&&!isNew){const sure=await askChoice({title:'Leave without saving?',message:'Your changes to how this file lines up will be lost.',choices:[{id:'leave',label:'Leave',kind:'danger'}]});if(sure!=='leave')return;}
      finish();
    };
    root.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&!document.querySelector('dialog[open]')){event.preventDefault();cancel.onclick();}
      // the app's own shortcuts (chart editing and the like) stay out while this is up; Space still plays
      if(event.key!==' '&&event.key!=='Escape'&&!event.ctrlKey&&!event.metaKey)event.stopPropagation();
    });

    // keep in time with the song
    let frame=0;
    const unsubscribe=ctx.transport.subscribe(()=>{});
    const resize=new ResizeObserver(()=>{fitLanes();clampView();draw();});resize.observe(strip);
    const scheme=new MutationObserver(()=>{palette=colors();draw();});scheme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-scheme']});
    function tick(){
      frame=requestAnimationFrame(tick);
      const snap=ctx.transport.getSnapshot(),now=snap.seconds,width=canvas.clientWidth||800;
      if(snap.playIntent&&performance.now()>follow&&!drag){const x=xOf(now);if(x<width*0.1||x>width*0.85){view.start=now-width*0.2/view.pps;clampView();}}
      tone.update(toneNotes,now,!!snap.playing,(snap.rate||100)/100);
      draw();
    }
    function finish(){
      cancelAnimationFrame(frame);unsubscribe();resize.disconnect();scheme.disconnect();tone.stop();tone.dispose();root.remove();open=null;
    }
    open={finish};
    root.inspect=()=>({alignment:settings.alignment,parts:settings.parts,guess,first:placed.map(list=>list[0]?.start??null)});   // for tests: read only

    recompute();
    // a file whose own tempo does not fit the recording starts from the guess (it is only a proposal until Save)
    if(isNew&&settings.alignment.mode==='beats'&&!entry?.settings?.alignment)runGuess(true);
    else if(isNew)runGuess(false);
    else guessLine.textContent='Guess compares your file with the recording and the chords to find where it fits.';
    requestAnimationFrame(()=>{showFirstNotes();sync();tick();canvas.focus();});
  }
  function close(){open?.finish();}

  return {importFile,openManager,addCustom,close,get isOpen(){return !!open;}};
}

