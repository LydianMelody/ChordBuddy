// Reading and writing Standard MIDI Files, so a visual can use a real performance (velocity, pedals, mod wheel, bend, MPE) instead of guessing.
// Pure functions with no DOM and no dependencies: the same file runs in the browser and in Node tests.
//
// parseMidi    bytes -> a neutral structure (tempo map, tracks of typed events), or a friendly Error
// timeMap      parsed -> {seconds(tick), tick(seconds)} that follows the tempo map
// extractSources  parsed -> "sources" (one per instrument): notes plus the controls that really exist in the file
// describeSignals source -> the typed signals a visual may map; anything not listed must stay locked in the UI
// writeMidi    a plain description -> bytes of a format 1 file (used for tests and for exporting performance data)
const MAX_BYTES=16*1024*1024;
const NOT=()=>new Error('This is not a MIDI file.'),BAD=()=>new Error('This MIDI file is damaged.');
const RPN_CCS=new Set([6,38,98,99,100,101]);       // data-entry plumbing: used for bend range and MPE setup, never shown as a control
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const tag=(b,p)=>String.fromCharCode(b[p],b[p+1],b[p+2],b[p+3]);
const u32=(b,p)=>b[p]*16777216+(b[p+1]<<16)+(b[p+2]<<8)+b[p+3];
const u16=(b,p)=>(b[p]<<8)|b[p+1];

/** Reads a Standard MIDI File. Throws an Error with a message that is fine to show to a person. */
export function parseMidi(input){
  let b;
  if(input instanceof ArrayBuffer)b=new Uint8Array(input);
  else if(ArrayBuffer.isView(input))b=new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
  else throw NOT();
  if(b.length>MAX_BYTES)throw new Error('This MIDI file is too big (the limit is 16 MB).');
  if(b.length<4||tag(b,0)!=='MThd')throw NOT();
  if(b.length<14)throw BAD();
  const hl=u32(b,4);if(hl<6||8+hl>b.length)throw BAD();
  const format=u16(b,8),division=u16(b,12);
  if(format>2||!division)throw BAD();
  let ticksPerQuarter=null,ticksPerSecond=null;
  if(division&0x8000){const fps=256-(division>>8),tpf=division&255;if(!tpf)throw BAD();ticksPerSecond=(fps===29?29.97:fps)*tpf;}   // 29 in the header means 29.97 drop-frame
  else ticksPerQuarter=division;
  const tempos=[],timeSignatures=[],keySignatures=[],markers=[],tracks=[];let length=0;
  const text=(p,e)=>{let s='';try{s=new TextDecoder('utf-8').decode(b.subarray(p,e));}catch{for(let i=p;i<e;i++)s+=String.fromCharCode(b[i]);}return s.replace(/\0+$/,'');};
  const readTrack=(s,e)=>{
    let p=s,tick=0,run=0,name=null;const events=[];
    const vl=()=>{let v=0;for(let i=0;i<4;i++){if(p>=e)throw BAD();const c=b[p++];v=v*128+(c&127);if(c<128)return v;}throw BAD();};   // 4 bytes at most, so garbage cannot loop us
    while(p<e){
      tick+=vl();if(p>=e)throw BAD();
      let st=b[p];
      if(st<128){if(!run)throw BAD();st=run;}                 // running status: the status byte is left out, the data starts right here
      else{p++;if(st<0xF0)run=st;else if(st===0xF0||st===0xF7)run=0;}
      if(st===0xFF){
        if(p>=e)throw BAD();const type=b[p++],len=vl();if(p+len>e)throw BAD();
        const q=p;p+=len;
        if(type===0x2F)break;
        if(type===0x03){if(name===null)name=text(q,q+len);}
        else if(type===0x51&&len>=3){const us=(b[q]<<16)|(b[q+1]<<8)|b[q+2];if(us>0)tempos.push({tick,usPerQuarter:us});}
        else if(type===0x58&&len>=2)timeSignatures.push({tick,numerator:b[q],denominator:2**Math.min(b[q+1],15)});
        else if(type===0x59&&len>=2)keySignatures.push({tick,sharps:(b[q]<<24)>>24,minor:b[q+1]===1});
        else if(type===0x06)markers.push({tick,text:text(q,q+len)});
      }else if(st===0xF0||st===0xF7){const len=vl();if(p+len>e)throw BAD();p+=len;}
      else if(st>=0x80&&st<0xF0){
        const hi=st>>4,ch=st&15,n=(hi===0xC||hi===0xD)?1:2;
        if(p+n>e)throw BAD();const d1=b[p],d2=n===2?b[p+1]:0;
        if(d1>127||d2>127)throw BAD();p+=n;
        if(hi===8)events.push({tick,type:'noteOff',channel:ch,pitch:d1,velocity:d2});
        else if(hi===9)events.push(d2?{tick,type:'noteOn',channel:ch,pitch:d1,velocity:d2}:{tick,type:'noteOff',channel:ch,pitch:d1,velocity:0});
        else if(hi===0xA)events.push({tick,type:'polyPressure',channel:ch,pitch:d1,value:d2});
        else if(hi===0xB)events.push({tick,type:'cc',channel:ch,controller:d1,value:d2});
        else if(hi===0xC)events.push({tick,type:'program',channel:ch,program:d1});
        else if(hi===0xD)events.push({tick,type:'pressure',channel:ch,value:d1});
        else events.push({tick,type:'bend',channel:ch,value:d1|(d2<<7)});
      }else throw BAD();
    }
    length=Math.max(length,tick);
    return {name:name||'',events,length:tick};
  };
  let p=8+hl;
  while(p+8<=b.length){
    const id=tag(b,p),len=u32(b,p+4);p+=8;
    if(p+len>b.length)throw BAD();                          // cut off in the middle of a chunk
    if(id==='MTrk')tracks.push(readTrack(p,p+len));         // anything else (a vendor chunk, say) is skipped by length
    p+=len;
  }
  if(!tracks.length)throw BAD();
  const byTick=(a,c)=>a.tick-c.tick;
  tempos.sort(byTick);timeSignatures.sort(byTick);keySignatures.sort(byTick);markers.sort(byTick);
  const hasTempo=tempos.length>0;
  const merged=[];for(const t of tempos){if(merged.length&&merged[merged.length-1].tick===t.tick)merged[merged.length-1]=t;else merged.push(t);}   // two tempos on one tick: the later one wins
  if(!merged.length||merged[0].tick>0)merged.unshift({tick:0,usPerQuarter:500000});
  if(!timeSignatures.length||timeSignatures[0].tick>0)timeSignatures.unshift({tick:0,numerator:4,denominator:4});
  return {format,ticksPerQuarter,ticksPerSecond,hasTempo,tempos:merged,timeSignatures,keySignatures,markers,tracks,length};
}

/** Ticks <-> seconds, following the tempo map (or the fixed rate of an SMPTE file). Both directions extrapolate past the ends. */
export function timeMap(parsed){
  const tps=parsed.ticksPerSecond;
  if(tps)return {seconds:t=>Math.max(0,t)/tps,tick:s=>Math.max(0,s)*tps};
  const tpq=parsed.ticksPerQuarter,segs=[];let sec=0;
  parsed.tempos.forEach((t,i)=>{
    if(i)sec+=(t.tick-segs[i-1].tick)*segs[i-1].us/(tpq*1e6);
    segs.push({tick:t.tick,sec,us:t.usPerQuarter});
  });
  const find=(key,v)=>{let lo=0,hi=segs.length-1;while(lo<hi){const m=(lo+hi+1)>>1;if(segs[m][key]<=v)lo=m;else hi=m-1;}return segs[lo];};
  return {
    seconds:t=>{t=Math.max(0,t);const s=find('tick',t);return s.sec+(t-s.tick)*s.us/(tpq*1e6);},
    tick:x=>{x=Math.max(0,x);const s=find('sec',x);return s.tick+(x-s.sec)*tpq*1e6/s.us;},
  };
}

/** The value in effect at `tick` (the last point at or before it), or `fallback` when nothing has happened yet. Points must be sorted. */
export function valueAt(points,tick,fallback){
  let lo=0,hi=points.length-1,at=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(points[m].tick<=tick){at=m;lo=m+1;}else hi=m-1;}
  return at<0?fallback:points[at].value;
}
/** Pedals and switches are on from 64 up (0.5 once normalized). */
export const gateAt=(points,tick)=>valueAt(points,tick,0)>=.5;

// Walks channel events once per (channel, pitch) queue: the oldest open note of a pitch is the one a note-off closes (first in, first out).
function pairNotes(evs,lastTick,tpq){
  const open=new Map(),notes=[];
  for(const e of evs){
    const key=e.channel*128+(e.pitch??0);
    if(e.type==='noteOn'){const n={tick:e.tick,endTick:-1,pitch:e.pitch,velocity:e.velocity,channel:e.channel,offVelocity:0};notes.push(n);if(!open.has(key))open.set(key,[]);open.get(key).push(n);}
    else if(e.type==='noteOff'){const q=open.get(key);if(q&&q.length){const n=q.shift();n.endTick=e.tick;n.offVelocity=e.velocity;}}
    else if(e.type==='polyPressure'){const q=open.get(key);if(q&&q.length)(q[0].pressure||(q[0].pressure=[])).push({tick:e.tick,value:e.value/127});}
  }
  for(const n of notes){
    if(n.endTick<0)n.endTick=lastTick>n.tick?lastTick:n.tick+tpq;      // never ended: hold to the end of the track
    if(n.endTick<=n.tick)n.endTick=n.tick+1;                           // zero length notes are kept, just made visible
  }
  return notes;
}

// Per channel: the first bend range (RPN 0) and any MPE zone setup (RPN 6 on the master channels). Bend range is semitones plus cents.
function rpnPass(evs){
  const info=new Map(),st=new Map();
  for(const e of evs){
    if(e.type!=='cc'||!RPN_CCS.has(e.controller))continue;
    const s=st.get(e.channel)||(st.set(e.channel,{msb:127,lsb:127,nrpn:false,fill:false}),st.get(e.channel));
    const i=info.get(e.channel)||(info.set(e.channel,{range:null,mpe:0}),info.get(e.channel));
    const c=e.controller;
    if(c===101){s.msb=e.value;s.nrpn=false;}else if(c===100){s.lsb=e.value;s.nrpn=false;}
    else if(c===99||c===98)s.nrpn=true;
    else if(c===6&&!s.nrpn){
      if(s.msb===0&&s.lsb===0){if(i.range===null){i.range=e.value;s.fill=true;}else s.fill=false;}
      else if(s.msb===0&&s.lsb===6&&(e.channel===0||e.channel===15))i.mpe=e.value;
    }else if(c===38&&!s.nrpn&&s.msb===0&&s.lsb===0&&s.fill){i.range+=e.value/100;s.fill=false;}
  }
  return info;
}

// Normalized control lanes for a set of channels: cc -> 0..1, bend -> -1..1, channel pressure -> 0..1. Only lanes that have points exist.
function collect(evs,chans){
  const c={},add=(k,tick,value)=>(c[k]||(c[k]=[])).push({tick,value});
  for(const e of evs){
    if(!chans.has(e.channel))continue;
    if(e.type==='cc'&&!RPN_CCS.has(e.controller))add('cc'+e.controller,e.tick,e.value/127);
    else if(e.type==='bend')add('bend',e.tick,clamp((e.value-8192)/8192,-1,1));
    else if(e.type==='pressure')add('pressure',e.tick,e.value/127);
  }
  return c;
}

// Share of the time a channel sounds during which it plays at most one note: MPE gives every note its own channel, a chord instrument does not.
function monoShare(notes){
  const edges=[];for(const n of notes){edges.push([n.tick,1],[n.endTick,-1]);}
  edges.sort((a,c)=>a[0]-c[0]||a[1]-c[1]);
  let depth=0,at=0,sounding=0,crowded=0;
  for(const [t,d] of edges){if(depth>=1)sounding+=t-at;if(depth>=2)crowded+=t-at;depth+=d;at=t;}
  return sounding?1-crowded/sounding:1;
}

/** Splits a parsed file into instruments ("sources"), each with its notes and only the controls it really contains. */
export function extractSources(parsed){
  const out=[],tpq=parsed.ticksPerQuarter||Math.round((parsed.ticksPerSecond||960)/2);
  parsed.tracks.forEach((track,ti)=>{
    const evs=track.events.filter(e=>e.channel!==undefined),last=track.length??(evs.length?evs[evs.length-1].tick:0);
    const base=track.name||'Track '+(ti+1);
    const mel=evs.filter(e=>e.channel!==9),drum=evs.filter(e=>e.channel===9);
    const notes=pairNotes(mel,last,tpq),byCh=new Map();
    for(const n of notes){if(!byCh.has(n.channel))byCh.set(n.channel,[]);byCh.get(n.channel).push(n);}
    const rpn=rpnPass(mel),program=chans=>{const e=mel.find(x=>x.type==='program'&&chans.has(x.channel));return e?e.program:null;};
    // Is this one MPE instrument? Either it says so (RPN 6) or it behaves like one.
    let mpe=null;
    const masters=new Set([0,15].filter(c=>(rpn.get(c)?.mpe||0)>0));
    if(masters.size)mpe={masters};
    else if(byCh.size>=3){
      const expressive=[...byCh.keys()].filter(c=>mel.some(e=>e.channel===c&&(e.type==='bend'||e.type==='pressure'||(e.type==='cc'&&e.controller===74))));
      if(expressive.length>=2&&[...byCh.values()].every(ns=>monoShare(ns)>=.8))mpe={masters:new Set(byCh.has(0)?[]:[0])};
    }
    const drumNotes=pairNotes(drum,last,tpq),drumControls=collect(drum,new Set([9]));
    const hasDrums=drumNotes.length>0||Object.keys(drumControls).length>0;
    const parts=[];                                                   // melodic sources before their ids are settled
    if(mpe){
      const members=new Set(byCh.keys()),lanes=new Map();
      for(const c of members)lanes.set(c,collect(mel,new Set([c])));
      const mc=collect(mel,mpe.masters),chans=new Set([...members,...[...mpe.masters].filter(c=>mel.some(e=>e.channel===c))]);
      const range=[...members].map(c=>rpn.get(c)?.range).find(r=>r!=null);
      for(const n of notes){
        const l=lanes.get(n.channel)||{};
        const pick=(arr,def)=>{const pts=[{tick:n.tick,value:valueAt(arr||[],n.tick,def)}];for(const p of arr||[])if(p.tick>n.tick&&p.tick<n.endTick)pts.push(p);return pts;};   // starting value first, then every change until the note ends
        n.bend=pick(l.bend,0);n.pressure=pick(l.pressure,0);n.slide=pick(l.cc74,0);
      }
      parts.push({mpe:true,channels:chans,notes,controls:mc,bendRange:range??48});
    }else{
      const used=new Set(byCh.keys());
      for(const e of mel)if((e.type==='cc'&&!RPN_CCS.has(e.controller))||e.type==='bend'||e.type==='pressure')used.add(e.channel);   // a channel that only moves a pedal still counts
      const list=[...used].sort((a,c)=>a-c);
      for(const c of list){
        const set=new Set([c]);
        parts.push({mpe:false,channels:set,channel:c,notes:byCh.get(c)||[],controls:collect(mel,set),bendRange:rpn.get(c)?.range??2});
      }
    }
    const total=parts.length+(hasDrums?1:0),split=!mpe&&total>1;
    for(const part of parts){
      const chs=[...part.channels].sort((a,c)=>a-c);
      let id='t'+ti,name=base;
      if(part.mpe)id='t'+ti+'mpe';
      else if(split){id='t'+ti+'c'+(part.channel+1);name=base+' (ch '+(part.channel+1)+')';}
      out.push({id,track:ti,channels:chs,name,kind:part.mpe?'mpe':'notes',program:program(part.channels),bendRange:part.bendRange,notes:part.notes,controls:part.controls});
    }
    if(hasDrums)out.push({id:parts.length?'t'+ti+'c10':'t'+ti,track:ti,channels:[9],name:parts.length?'Drums':base,kind:'drums',program:null,bendRange:2,notes:drumNotes,controls:drumControls});
  });
  return out.filter(s=>s.notes.length||Object.keys(s.controls).length);
}

const CC_INFO={64:['Sustain pedal','gate'],66:['Sostenuto pedal','gate'],67:['Soft pedal','gate'],68:['Legato footswitch','gate'],69:['Hold 2','gate'],
  1:['Mod wheel','amount'],2:['Breath','amount'],4:['Foot controller','amount'],7:['Volume','amount'],8:['Balance','bend'],10:['Pan','bend'],11:['Expression','amount'],74:['Brightness','amount'],71:['Resonance','amount']};

/** The typed signals a source really has. Visuals lock their mapping to this list, so nothing that is absent can be offered. */
export function describeSignals(source){
  const out=[],notes=source.notes||[],ctl=source.controls||{};
  if(notes.length){
    out.push({key:'notes',label:'Notes',type:'notes'},{key:'hits',label:source.kind==='drums'?'Drum hits':'Note starts',type:'trigger'});
    if(notes.some(n=>n.velocity!==notes[0].velocity))out.push({key:'velocity',label:'Velocity',type:'amount'});
  }
  const ccs=Object.keys(ctl).filter(k=>/^cc\d+$/.test(k)&&ctl[k].length).sort((a,b)=>a.slice(2)-b.slice(2));
  for(const k of ccs){const n=+k.slice(2),i=CC_INFO[n];out.push({key:k,label:i?i[0]:'Controller '+n,type:i?i[1]:'amount'});}
  if(ctl.bend&&ctl.bend.length)out.push({key:'bend',label:'Pitch bend',type:'bend'});
  if(ctl.pressure&&ctl.pressure.length)out.push({key:'pressure',label:'Aftertouch',type:'amount'});
  if(source.kind==='mpe'){
    const live=(k,def)=>notes.some(n=>(n[k]||[]).some((p,i)=>i>0||p.value!==def));
    if(live('bend',0))out.push({key:'noteBend',label:'Per-note bend',type:'bend'});
    if(live('pressure',0))out.push({key:'notePressure',label:'Per-note pressure',type:'amount'});
    if(live('slide',0))out.push({key:'noteSlide',label:'Per-note slide',type:'amount'});
  }else if(notes.some(n=>n.pressure&&n.pressure.length))out.push({key:'polyPressure',label:'Key pressure',type:'amount'});
  return out;
}

const vlqBytes=n=>{n=Math.max(0,Math.round(n));const r=[n&127];while(n>>=7)r.unshift((n&127)|128);return r;};
const be=(n,len)=>Array.from({length:len},(_,i)=>(n>>>(8*(len-1-i)))&255);
const str=s=>[...new TextEncoder().encode(String(s))];
const chunk=(id,data)=>[...str(id),...be(data.length,4),...data];

/** Writes a format 1 file: track 0 holds tempo, meter and markers, then one track per entry. Round-trips through parseMidi/extractSources. */
export function writeMidi({ticksPerQuarter=960,tempos=[{tick:0,usPerQuarter:500000}],timeSignatures=[{tick:0,numerator:4,denominator:4}],tracks=[],markers=[],title=''}={}){
  const meta=(type,data)=>[0xFF,type,...vlqBytes(data.length),...data];
  const build=items=>{                                              // items: {tick, pri, bytes}; at one tick: note-offs, then controls, then note-ons
    items.sort((a,b)=>a.tick-b.tick||a.pri-b.pri);
    const data=[];let at=0;
    for(const it of items){data.push(...vlqBytes(it.tick-at),...it.bytes);at=it.tick;}
    data.push(...vlqBytes(0),...meta(0x2F,[]));
    return chunk('MTrk',data);
  };
  const T=t=>Math.max(0,Math.round(t));
  const cond=[];
  if(title)cond.push({tick:0,pri:-2,bytes:meta(0x03,str(title))});
  for(const t of tempos)cond.push({tick:T(t.tick),pri:0,bytes:meta(0x51,be(clamp(Math.round(t.usPerQuarter),1,0xFFFFFF),3))});
  for(const s of timeSignatures)cond.push({tick:T(s.tick),pri:0,bytes:meta(0x58,[clamp(s.numerator,1,255),clamp(Math.round(Math.log2(s.denominator||4)),0,15),24,8])});
  for(const m of markers)cond.push({tick:T(m.tick),pri:1,bytes:meta(0x06,str(m.text))});
  const body=[build(cond)];
  for(const tr of tracks){
    const ch=clamp(tr.channel||0,0,15),items=[];
    if(tr.name)items.push({tick:0,pri:-2,bytes:meta(0x03,str(tr.name))});
    if(tr.program!=null)items.push({tick:0,pri:-1,bytes:[0xC0|ch,clamp(tr.program,0,127)]});
    for(const n of tr.notes||[]){
      const on=T(n.tick),off=Math.max(on+1,T(n.endTick)),pitch=clamp(n.pitch,0,127);
      items.push({tick:on,pri:2,bytes:[0x90|ch,pitch,clamp(Math.round(n.velocity),1,127)]},{tick:off,pri:0,bytes:[0x80|ch,pitch,clamp(Math.round(n.offVelocity??64),0,127)]});
    }
    for(const [k,pts] of Object.entries(tr.controls||{})){
      const m=/^cc(\d+)$/.exec(k);
      for(const p of pts){
        const v=clamp(p.value,k==='bend'?-1:0,1),tick=T(p.tick);
        if(m)items.push({tick,pri:1,bytes:[0xB0|ch,clamp(+m[1],0,127),Math.round(v*127)]});
        else if(k==='bend'){const raw=clamp(Math.round(v*8192+8192),0,16383);items.push({tick,pri:1,bytes:[0xE0|ch,raw&127,raw>>7]});}
        else if(k==='pressure')items.push({tick,pri:1,bytes:[0xD0|ch,Math.round(v*127)]});
      }
    }
    body.push(build(items));
  }
  return new Uint8Array([...chunk('MThd',[...be(1,2),...be(body.length,2),...be(ticksPerQuarter,2)]),...body.flat()]);
}
