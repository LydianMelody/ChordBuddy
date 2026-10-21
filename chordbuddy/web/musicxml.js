// A lead sheet as a MusicXML file, so MuseScore, Dorico, Sibelius, Finale and others can open it. MusicXML is an open, published format;
// this is our own small writer for it (melody, chord symbols, lyrics, key, meter and tempo). It reads the notation abcjs has already parsed.

const DIVISIONS=24;                          // per quarter note: enough for sixteenths, thirty-seconds and triplets
// Standard note lengths, longest first, as [divisions, type, dots].
const SHAPES=[[96,'whole',0],[72,'half',1],[48,'half',0],[36,'quarter',1],[24,'quarter',0],[18,'eighth',1],[12,'eighth',0],[9,'16th',1],[6,'16th',0],[4.5,'32nd',1],[3,'32nd',0],[1.5,'64th',0]];
const esc=text=>String(text??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ACC_ALTER={sharp:1,flat:-1,natural:0,dblsharp:2,dblflat:-2};

// A length in divisions, as a run of standard lengths that are tied together (5 sixteenths: a quarter tied to a sixteenth).
export function splitLength(divisions){
  const parts=[];let left=Math.round(divisions*2)/2;
  while(left>0.01){
    const shape=SHAPES.find(s=>s[0]<=left+1e-6);
    if(!shape){parts.push([left,'64th',0]);break;}
    parts.push(shape);left=Math.round((left-shape[0])*2)/2;
  }
  return parts.length?parts:[[divisions,'quarter',0]];
}

// "F#m7/C" → the pieces MusicXML wants. Anything we cannot read becomes kind "other" with the text kept as written.
const KINDS=[['maj7','major-seventh'],['M7','major-seventh'],['m7b5','half-diminished'],['m7','minor-seventh'],['min7','minor-seventh'],['dim7','diminished-seventh'],['dim','diminished'],['aug','augmented'],['+','augmented'],
  ['m6','minor-sixth'],['6','major-sixth'],['m9','minor-ninth'],['9','dominant-ninth'],['sus4','suspended-fourth'],['sus2','suspended-second'],['sus','suspended-fourth'],['7','dominant'],['m','minor'],['min','minor'],['','major']];
export function parseChord(label){
  const match=/^([A-G])([#b♯♭]?)([^/]*)(?:\/([A-G])([#b♯♭]?))?$/.exec(String(label||'').trim());
  if(!match)return null;
  const alter=a=>({'#':1,'♯':1,'b':-1,'♭':-1}[a]||0);
  const quality=match[3],known=KINDS.find(([text])=>text===quality);
  return {rootStep:match[1],rootAlter:alter(match[2]),kind:known?known[1]:'other',text:quality,bassStep:match[4]||null,bassAlter:alter(match[5])};
}
const harmony=name=>{
  const chord=parseChord(name);
  if(!chord)return `<harmony><root><root-step>C</root-step></root><kind text="${esc(name)}">other</kind></harmony>`;
  return `<harmony><root><root-step>${chord.rootStep}</root-step>${chord.rootAlter?`<root-alter>${chord.rootAlter}</root-alter>`:''}</root><kind text="${esc(chord.text)}">${chord.kind}</kind>`+
    (chord.bassStep?`<bass><bass-step>${chord.bassStep}</bass-step>${chord.bassAlter?`<bass-alter>${chord.bassAlter}</bass-alter>`:''}</bass>`:'')+'</harmony>';
};

// Sharps/flats of the key signature as abcjs lists them → the circle-of-fifths count MusicXML uses.
function fifthsOf(key){
  const list=key?.accidentals||[];
  if(!list.length)return 0;
  return list[0].acc==='flat'?-list.length:list.length;
}
const stepName=(letter)=>letter.toUpperCase();

// tune: the result of abcjs.parseOnly(abc)[0]. options: {title, artist, staffIndex, voiceIndex, partName, lyrics: Map(noteIndex -> {syllable, divider}),
// chordLabel(chordName, position) -> text to show (so edited chord labels are used), tempo}
export function tuneToMusicXml(tune,options={}){
  const {staffIndex=0,voiceIndex=0,lyrics=new Map(),chordLabel=name=>name}=options;
  const firstLine=tune.lines.find(l=>l.staff)?.staff?.[staffIndex];
  // The time signature you chose for the song, when it fills a bar as long as the score's own (a relabel such as 6/8 for 3/4); otherwise the score's.
  const found=tune.getMeterFraction?.()||{num:4,den:4},chosen=options.meter;
  const meter=chosen&&Math.abs(chosen.num/chosen.den-found.num/found.den)<1e-9?chosen:found;
  const barLength=meter.num/meter.den;
  let beats=meter.num,beatType=meter.den,fifths=fifthsOf(firstLine?.key);
  const tempo=options.tempo||tune.metaText?.tempo?.bpm||null,tempoUnit=tune.metaText?.tempo?.duration?.[0]||0.25;
  const measures=[];let current=null,noteIndex=0,keyAccidentals=firstLine?.key?.accidentals||[];
  let barAlterations=new Map(),pendingAttributes=true,lastHyphen=false;
  const start=()=>{
    if(current)return;
    current={number:measures.length+1,xml:[],total:0};barAlterations=new Map();
    if(pendingAttributes){
      current.xml.push(`<attributes><divisions>${DIVISIONS}</divisions><key><fifths>${fifths}</fifths></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`);
      if(measures.length===0&&tempo)current.xml.push(`<direction placement="above"><direction-type><metronome><beat-unit>${tempoUnit>=.5?'half':tempoUnit>=.25?'quarter':'eighth'}</beat-unit><per-minute>${Math.round(tempo)}</per-minute></metronome></direction-type><sound tempo="${Math.round(tempo*(tempoUnit/0.25))}"/></direction>`);
      pendingAttributes=false;
    }
  };
  // abcjs reports a changed meter inconsistently, so each bar's meter comes from its own length: a bar that is not as long as the meter in
  // force starts a new one (a 2-beat bar in 4/4 is a 2/4 bar), and the first bar, when short, is a pickup.
  const meterOfLength=total=>{const quarters=total/DIVISIONS;return Number.isInteger(quarters)?{b:quarters,t:4}:Number.isInteger(quarters*2)?{b:quarters*2,t:8}:null;};
  const finish=()=>{
    if(!current)return;
    const expected=beats*(4/beatType)*DIVISIONS;
    if(Math.abs(current.total-expected)>1e-6&&current.total>0){
      if(measures.length===0)current.pickup=true;
      else{
        const meter=meterOfLength(current.total);
        if(meter){beats=meter.b;beatType=meter.t;current.xml.unshift(`<attributes><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time></attributes>`);}
      }
    }
    measures.push(current);current=null;
  };
  const alterFor=pitch=>{
    const letter=stepName(pitch.name.replace(/^[\^_=]+/,'')[0]),key=letter+'@'+pitch.pitch;
    if(pitch.accidental){const alter=ACC_ALTER[pitch.accidental]??0;barAlterations.set(key,alter);return alter;}
    if(barAlterations.has(key))return barAlterations.get(key);
    const inKey=keyAccidentals.find(k=>String(k.note).toUpperCase()===letter);
    return inKey?(inKey.acc==='flat'?-1:inKey.acc==='sharp'?1:0):0;
  };
  const noteXml=(item,pitch,length,tieStart,tieStop,first,chordNames,lyric)=>{
    const [divs,type,dots]=length;
    let xml='<note>';
    if(pitch){
      const letter=stepName(pitch.name.replace(/^[\^_=]+/,'')[0]),octave=4+Math.floor(pitch.pitch/7),alter=alterFor(pitch);
      xml+=`<pitch><step>${letter}</step>${alter?`<alter>${alter}</alter>`:''}<octave>${octave}</octave></pitch>`;
    }else xml+='<rest/>';
    xml+=`<duration>${divs}</duration>`;
    if(tieStop)xml+='<tie type="stop"/>';
    if(tieStart)xml+='<tie type="start"/>';
    xml+=`<voice>1</voice><type>${type}</type>${'<dot/>'.repeat(dots)}`;
    const notations=(tieStop?'<tied type="stop"/>':'')+(tieStart?'<tied type="start"/>':'');
    if(notations)xml+=`<notations>${notations}</notations>`;
    if(lyric&&first&&pitch){
      const hyphen=lyric.divider==='-';
      const syllabic=hyphen?(lastHyphen?'middle':'begin'):(lastHyphen?'end':'single');
      xml+=`<lyric number="1"><syllabic>${syllabic}</syllabic><text>${esc(String(lyric.syllable).trim())}</text></lyric>`;
      lastHyphen=hyphen;
    }
    return xml+'</note>';
  };
  const emitRest=(divisions)=>{
    for(const length of splitLength(divisions)){start();current.xml.push(noteXml(null,null,length,false,false,true,[],null));}
    current.total+=divisions;
  };
  for(const line of tune.lines){
    const voice=line.staff?.[staffIndex]?.voices?.[voiceIndex];if(!voice)continue;
    if(line.staff[staffIndex].key)keyAccidentals=line.staff[staffIndex].key.accidentals||keyAccidentals;
    for(const item of voice){
      if(item.el_type==='bar'){finish();continue;}
      if(item.el_type!=='note')continue;
      const duration=item.duration||0,divisions=Math.round(duration*4*DIVISIONS*2)/2;
      if(item.rest){
        if(item.rest.type==='multimeasure'){
          const bars=Math.max(1,Math.round(duration/barLength));
          for(let k=0;k<bars;k++){finish();start();current.xml.push(`<note><rest measure="yes"/><duration>${Math.round(barLength*4*DIVISIONS)}</duration><voice>1</voice></note>`);current.total=Math.round(barLength*4*DIVISIONS);finish();}
        }else emitRest(divisions);
        continue;
      }
      start();
      const pitch=item.pitches?.[0];if(!pitch){emitRest(divisions);continue;}
      const startsTie=!!pitch.startTie,endsTie=!!pitch.endTie;
      const sounded=item.pitches.some(p=>!p.endTie);
      const lyric=sounded?lyrics.get(noteIndex):null;
      const names=options.chordsFor?options.chordsFor(item):(item.chord||[]).map(c=>chordLabel(c.name));
      for(const name of names)current.xml.push(harmony(name));
      const parts=splitLength(divisions);
      parts.forEach((length,k)=>{
        const lastPart=k===parts.length-1,firstPart=k===0;
        const tieStart=startsTie&&lastPart||!lastPart,tieStop=endsTie&&firstPart||!firstPart;
        current.xml.push(noteXml(item,pitch,length,tieStart,tieStop,firstPart,[],lyric));
      });
      current.total+=divisions;
      if(sounded)noteIndex++;
    }
  }
  finish();
  if(!measures.length)throw new Error('There is no music to export.');
  const title=esc(options.title||tune.metaText?.title||'Lead sheet'),part=esc(options.partName||'Vocal Melody');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="3.1">`+
    `<work><work-title>${title}</work-title></work><identification>${options.artist?`<creator type="composer">${esc(options.artist)}</creator>`:''}<encoding><software>Chord Buddy</software></encoding></identification>`+
    `<part-list><score-part id="P1"><part-name>${part}</part-name></score-part></part-list><part id="P1">`+
    measures.map(m=>`<measure number="${m.number+(measures[0]?.pickup?-1:0)}"${m.pickup?' implicit="yes"':''}>${m.xml.join('')}</measure>`).join('')+'</part></score-partwise>\n';
}

export function exportFileName(title){
  return (String(title||'Lead sheet').replace(/[\\/:*?"<>|\x00-\x1f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,100)||'Lead sheet')+'.musicxml';
}
