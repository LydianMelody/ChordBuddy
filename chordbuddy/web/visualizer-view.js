// A visualizer: follows the player over the visual bridge and draws a frame of the song on a canvas, every display frame.
// For now it draws a diagnostic view (chords, beat, section, stems, MIDI) that shows the data and its timing are right; the real looks
// will replace draw() and read the same frames. Mounted by visualizer.html (pop-out window) and by the main page's full-screen view.
import {createVisualReceiver} from './visual-bridge.js';
import {SceneClock} from './visual-clock.js';
import {buildScene,sampleFrame,withFeatures,STEM_ORDER,BAND_COUNT} from './visual-scene.js';
import {setKeySpelling} from './spelling.js';

const STEM_COLORS={vocals:'#ff5d8f',lead:'#ffb84d',rhythm:'#ffe066',bass:'#7c6cff',drums:'#38d9a9',piano:'#4dabf7',other:'#c0c4cc'};
const STEM_NAMES={vocals:'Vocals',lead:'Lead gtr',rhythm:'Rhythm gtr',bass:'Bass',drums:'Drums',piano:'Piano',other:'Other'};
// MIDI documents by file name: the vocal melody, the instrumental melody and the combined melody
const MIDI_NAMES=[[/(^|\/)melody_vocal\.mid$/,'vocal'],[/(^|\/)melody_instrumental\.mid$/,'instrumental'],[/(^|\/)melody\.mid$/,'melody']];

export function midiName(file){for(const [pattern,name] of MIDI_NAMES)if(pattern.test(file))return name;return null;}

async function getJson(path,token){
  const response=await fetch(path,{headers:{'X-ChordBuddy-Token':token}});
  if(!response.ok)throw Error(`${path}: ${response.status}`);
  return response.json();
}

export function mountVisualizer(container){
  const canvas=document.createElement('canvas');canvas.className='visualizer-canvas';container.append(canvas);
  const g=canvas.getContext('2d'),clock=new SceneClock();
  let scene=null,sceneKey=null,mix=null,status='Waiting for Chord Buddy… start playback in the main window.',raf=0,disposed=false,frames=0,fpsAt=performance.now(),fps=0;

  async function loadScene(m){
    const key=JSON.stringify([m.songId,m.runId,m.revision,m.key,m.lyricGuess]);if(key===sceneKey)return;sceneKey=key;
    if(!m.songId){scene=null;status='No song is open in Chord Buddy.';return;}
    setKeySpelling(m.key||'');
    const base={content:m.content,music:m.music,title:m.title,key:m.key,lyricGuess:!!m.lyricGuess};
    scene=buildScene(base);status='';
    const midi={};
    await Promise.all((m.midiDocs||[]).map(async doc=>{
      const name=midiName(doc.name);if(!name)return;
      try{midi[name]=(await getJson('/api/document/'+encodeURIComponent(doc.id),m.token)).content?.notes||[];}catch{}
    }));
    if(sceneKey!==key||disposed)return;
    scene=buildScene({...base,midi});
    if(!m.runId){status='Split the stems to see each instrument.';return;}
    try{
      const features=await getJson('/api/visual-features/'+encodeURIComponent(m.runId),m.token);
      if(sceneKey===key&&!disposed)scene=withFeatures(scene,features);
    }catch{if(sceneKey===key)status='Stem data is not available for this song yet.';}
  }
  const receiver=createVisualReceiver({
    onScene:m=>{loadScene(m).catch(()=>{status='Could not load this song.';});},
    onClock:m=>{clock.report(m,m.at);mix=m.mix;},
  });

  function resize(){
    const ratio=window.devicePixelRatio||1,w=container.clientWidth,h=container.clientHeight;
    if(canvas.width!==Math.round(w*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);}
    g.setTransform(ratio,0,0,ratio,0,0);return [w,h];
  }
  function draw(now){
    if(disposed)return;raf=requestAnimationFrame(draw);
    frames++;if(now-fpsAt>=1000){fps=frames*1000/(now-fpsAt);frames=0;fpsAt=now;}
    const [w,h]=resize();g.fillStyle='#0d0e14';g.fillRect(0,0,w,h);
    g.textBaseline='middle';g.textAlign='center';g.fillStyle='#e9e6dc';
    if(!scene){g.font='500 18px system-ui';g.fillText(status,w/2,h/2);return;}
    const frame=sampleFrame(scene,clock.time(now),{playing:clock.playing,rate:clock.rate,mix});
    drawDiagnostic(g,frame,w,h,status,fps);
  }
  raf=requestAnimationFrame(draw);
  return {dispose(){disposed=true;cancelAnimationFrame(raf);receiver.dispose();canvas.remove();}};
}

const fmt=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}.${String(Math.floor(t%1*10))}`;

function drawDiagnostic(g,frame,w,h,status,fps){
  const {chord,beat,section}=frame,cx=w/2,top=h*0.36;
  // current chord, and a ring counting down to the next change
  g.font=`800 ${Math.round(Math.min(w,h)*0.16)}px system-ui`;g.fillStyle='#fff';g.fillText(chord.label??'—',cx,top);
  if(chord.next){
    const span=chord.end&&chord.start!==null?chord.next.start-chord.start:4,left=Math.max(0,Math.min(1,chord.timeToNext/Math.max(span,1e-3)));
    const r=Math.min(w,h)*0.045,x=cx+Math.min(w,h)*0.3,y=top;
    g.lineWidth=5;g.strokeStyle='#2a2d3a';g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.stroke();
    g.strokeStyle='#ffb84d';g.beginPath();g.arc(x,y,r,-Math.PI/2,-Math.PI/2+Math.PI*2*left);g.stroke();
    g.font=`700 ${Math.round(r*0.9)}px system-ui`;g.fillStyle='#ffb84d';g.fillText(chord.next.label,x,y);
    g.font='500 14px system-ui';g.fillStyle='#9aa0b4';
    g.fillText('then '+chord.upcoming.slice(1).map(c=>c.label).join('  '),cx,top+Math.min(w,h)*0.11);
  }
  // the lyric line being sung: words already sung, the word now, words still to come; the next line below it
  const lyric=frame.lyric,ly=top+Math.min(w,h)*0.17;
  if(lyric.line){
    g.font=`600 ${Math.round(Math.min(w,h)*0.04)}px system-ui`;
    const widths=lyric.words.map(x=>g.measureText(x.text+' ').width),total=widths.reduce((a,b)=>a+b,0);let x=cx-total/2;
    g.textAlign='left';
    lyric.words.forEach((word,i)=>{g.fillStyle=word.state==='now'?'#ffe066':word.state==='sung'?'#e9e6dc':'#5d6275';g.fillText(word.text,x,ly);x+=widths[i];});
    g.textAlign='center';
  }
  if(lyric.next){g.font=`500 ${Math.round(Math.min(w,h)*0.026)}px system-ui`;g.fillStyle='#5d6275';g.fillText(lyric.next.text,cx,ly+Math.min(w,h)*0.055);}
  // beat dots and section
  if(beat.bar!==null){
    const n=beat.beats,size=14,gap=26,x0=cx-(n-1)*gap/2,y=h*0.12;
    for(let i=0;i<n;i++){const on=i+1===beat.beat,p=on?1-beat.phase:0;g.fillStyle=on?`rgba(255,255,255,${0.35+0.65*p})`:'#2a2d3a';g.beginPath();g.arc(x0+i*gap,y,size/2+(on?4*p:0),0,Math.PI*2);g.fill();}
    g.font='600 14px system-ui';g.fillStyle='#9aa0b4';
    g.fillText(`Bar ${beat.bar} · beat ${beat.beat}/${n}${beat.bpm?` · ${Math.round(beat.bpm)} bpm`:''}${section.name?` · ${section.name}`:''}`,cx,y+24);
  }
  // stems: level column, eight bands, flash on hits
  const stems=STEM_ORDER.filter(r=>frame.tracks[r]),colW=Math.min(110,w/(stems.length+1)),baseY=h*0.92,maxH=h*0.26,x0=cx-colW*stems.length/2;
  stems.forEach((role,i)=>{
    const t=frame.tracks[role],x=x0+i*colW,color=STEM_COLORS[role];
    g.fillStyle=color;g.globalAlpha=0.15+0.85*t.pulse;g.fillRect(x+4,baseY-maxH-26,colW-8,6);g.globalAlpha=1;
    const bw=(colW-16)/BAND_COUNT;
    for(let b=0;b<BAND_COUNT;b++){const v=t.bands[b];g.fillStyle=color;g.globalAlpha=0.35+0.4*t.brightness;g.fillRect(x+8+b*bw,baseY-v*maxH,bw-2,v*maxH);}
    g.globalAlpha=1;g.fillStyle='#fff';g.fillRect(x+4,baseY-t.level*maxH,3,t.level*maxH);
    g.font='600 12px system-ui';g.fillStyle=t.gain>0?'#e9e6dc':'#555a6a';g.fillText(STEM_NAMES[role],x+colW/2,baseY+14);
  });
  // MIDI: active notes of each melody, by pitch
  let row=0;
  for(const [name,notes] of Object.entries(frame.notes)){
    const y=28+row*20;row++;                                             // top left, out of the way
    g.font='600 12px system-ui';g.textAlign='right';g.fillStyle='#9aa0b4';g.fillText(name,84,y);g.textAlign='center';
    const span=Math.max(12,(notes.high??72)-(notes.low??48));
    for(const n of notes.active){const x=96+(n.pitch-(notes.low??48))/span*w*0.22;g.fillStyle='#ff5d8f';g.globalAlpha=1-0.6*n.progress;g.beginPath();g.arc(x,y,6,0,Math.PI*2);g.fill();g.globalAlpha=1;}
  }
  g.font='500 12px ui-monospace,monospace';g.textAlign='left';g.fillStyle='#6b7085';
  g.fillText(`${fmt(frame.time)}  ${frame.playing?'playing':'paused'}  ${Math.round(frame.rate*100)}%  ${Math.round(fps)} fps${status?'  · '+status:''}`,12,h-14);
  g.textAlign='center';
}
