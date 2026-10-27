// Writing a score in another key signature without changing a single pitch. Pure: no DOM.
// In ABC a plain note takes the key signature's sharp or flat, and an accidental lasts to the end of its bar. So moving a score from
// K:B (five sharps) to K:C#m (four) means every plain A, which meant A sharp, now needs its sharp written. The note letters stay as
// they are (no respelling of F# as Gb): only the accidentals the new signature needs are written, and the ones it makes redundant go.

const LETTER_FIFTHS={F:-1,C:0,G:1,D:2,A:3,E:4,B:5};
const MODE_FIFTHS={major:0,maj:0,ion:0,mix:-1,dor:-2,minor:-3,min:-3,m:-3,aeo:-3,phr:-4,loc:-5,lyd:1};
const SHARPS='FCGDAEB',ALTER={'^^':2,'^':1,'=':0,'_':-1,'__':-2},WRITE={2:'^^',1:'^',0:'=','-1':'_','-2':'__'};

// Sharps (positive) or flats (negative) of a key: K: field text ("B", "C#m", "Eb mix") or a key label ("C# minor"). null if unreadable.
export function keyFifths(text){
  const m=/^\s*([A-G])([#b]?)\s*(major|minor|maj|min|ion|mix|dor|aeo|phr|loc|lyd|m)?(?![a-z])/i.exec(String(text||''));
  if(!m)return null;
  const fifths=LETTER_FIFTHS[m[1].toUpperCase()]+(m[2]==='#'?7:m[2]==='b'?-7:0)+MODE_FIFTHS[(m[3]||'major').toLowerCase()];
  return fifths>=-7&&fifths<=7?fifths:null;
}
// letter -> +1 / -1 / 0 under a key signature
function signature(fifths){
  const sig={};for(const l of SHARPS)sig[l]=0;
  if(fifths>0)for(const l of SHARPS.slice(0,fifths))sig[l]=1;
  if(fifths<0)for(const l of [...SHARPS].reverse().slice(0,-fifths))sig[l]=-1;
  return sig;
}
// "C# minor" -> "C#m", "Eb major" -> "Eb"
function keyField(label){
  const m=/^\s*([A-G][#b]?)\s*(major|minor)/i.exec(label||'');return m?m[1]+(/minor/i.test(m[2])?'m':''):null;
}

// abc rewritten in the key `label` ("C# minor"). Returns {abc, map} where map[i] is where character i of the old text is now (so chord
// positions can follow), or null when the score cannot be safely rewritten (no plain key, a key change part-way, explicit accidentals in
// K:) or is already in that key's signature.
export function rekeyAbc(abc,label){
  const field=keyField(label),to=keyFifths(label);if(!field||to===null)return null;
  const lines=abc.split('\n');let keyLine=-1;
  for(let i=0;i<lines.length;i++)if(/^\s*K:/.test(lines[i])){keyLine=i;break;}
  if(keyLine<0)return null;
  const spec=lines[keyLine].replace(/^\s*K:\s*/,'').replace(/%.*/,'').trim(),from=keyFifths(spec);
  if(from===null||/\bexp\b|[\^_=][a-gA-G]/.test(spec)||from===to)return null;
  for(let i=keyLine+1;i<lines.length;i++)if(/^\s*K:/.test(lines[i])||/\[K:/.test(lines[i].replace(/"[^"]*"/g,'')))return null;
  const oldSig=signature(from),newSig=signature(to);
  const rest=spec.replace(/^\s*[A-G][#b]?\s*(major|minor|maj|min|ion|mix|dor|aeo|phr|loc|lyd|m)?(?![a-z])/i,'');
  let out='',map=new Array(abc.length+1),pos=0;
  const copy=(text)=>{for(let k=0;k<text.length;k++)map[pos+k]=out.length+k;out+=text;pos+=text.length;};
  const states=new Map();let voice='';
  const state=()=>{if(!states.has(voice))states.set(voice,{heard:{},written:{}});return states.get(voice);};
  lines.forEach((line,i)=>{
    if(i>0)copy('\n');
    if(i<keyLine||/^\s*(%|[A-Za-z]:)/.test(line)&&i!==keyLine){
      const v=/^\s*V:\s*(\S+)/.exec(line);if(v&&i>keyLine)voice=v[1];
      copy(line);return;
    }
    if(i===keyLine){                       // the new K: field, with whatever followed the key (clef= and the like)
      const start=out.length;out+=/^\s*K:\s*/.exec(line)[0]+field+rest+(line.endsWith('\r')?'\r':'');
      for(let k=0;k<line.length;k++)map[pos+k]=Math.min(start+k,out.length);pos+=line.length;return;
    }
    let j=0;
    while(j<line.length){
      const c=line[j];
      if(c==='%'){copy(line.slice(j));break;}
      const close={'"':'"','!':'!','+':'+'}[c];
      if(close){const end=line.indexOf(close,j+1);const stop=end<0?line.length:end+1;copy(line.slice(j,stop));j=stop;continue;}
      if(c==='['&&/^\[[A-Za-z]:/.test(line.slice(j))){const end=line.indexOf(']',j);const stop=end<0?line.length:end+1;copy(line.slice(j,stop));j=stop;continue;}
      if(c==='|'){const s=state();s.heard={};s.written={};copy(c);j++;continue;}
      const note=/^(\^\^|\^|__|_|=)?([A-Ga-g])([',]*)/.exec(line.slice(j));
      if(note){
        const [all,acc,letter,octave]=note,key=letter+octave,upper=letter.toUpperCase(),s=state();
        if(acc)s.heard[key]=ALTER[acc];
        const sounding=acc?ALTER[acc]:s.heard[key]??oldSig[upper];
        const shown=s.written[key]??newSig[upper];
        const start=out.length;
        if(sounding!==shown){out+=WRITE[sounding];s.written[key]=sounding;}
        // the old accidental's characters map onto the new one (or the note), the letter and octave marks onto themselves
        for(let k=0;k<(acc||'').length;k++)map[pos+k]=start;
        pos+=(acc||'').length;copy(letter+octave);j+=all.length;continue;
      }
      copy(c);j++;
    }
  });
  map[abc.length]=out.length;
  return {abc:out,map};
}
