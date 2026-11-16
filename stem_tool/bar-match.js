// Which bar of one song is the same moment of the music as a bar of another: two analyses of the same music (a song and its lowered or
// instrumental version) rarely number their bars alike. One finds a chord two bars sooner and calls that bar 1; one starts its beat grid a
// fraction of a beat later. So bars are matched by WHEN they are, never by their numbers: a bar's partner is the bar of the other song that
// starts nearest to the same moment, and a flag keeps its beat inside the bar it lands in.
//
// A bar is {id, number (as Chord Buddy shows it), start, end (seconds), beats (how many)}. `offset` is how much later the same moment is in the
// other recording (seconds), when the two recordings do not start together (see flags.recordings_offset in Python).

const median=values=>{const s=[...values].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:0;};

/** theirs: the bars flags are copied from; mine: the bars they go onto.
 *  -> {bars: {their id: {id, beats}}, matched, unmatched: [their bars with no partner], shift: how many bar numbers higher the partners are
 *      (the commonest difference; null if they agree on nothing), mixed: true when that difference is not the same for all (the two analyses
 *      disagree about the bars somewhere), phase: the leftover time difference between the two beat grids (seconds)} */
export function matchBars(theirs,mine,offset=0){
  const out={bars:{},matched:0,unmatched:[],shift:null,mixed:false,phase:0};
  if(!theirs?.length||!mine?.length)return {...out,unmatched:[...(theirs||[])]};
  const starts=mine.map(b=>b.start);
  const nearest=t=>{let lo=0,hi=starts.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(starts[mid]<t)lo=mid+1;else hi=mid;}
    return lo>0&&Math.abs(starts[lo-1]-t)<=Math.abs(starts[lo]-t)?lo-1:lo;};
  const pair=phase=>theirs.map(b=>{const t=b.start+offset+phase,i=nearest(t),partner=mine[i];
    // a partner must start within half a bar of the same moment (half of the shorter of the two bars)
    const reach=Math.min(b.end-b.start,partner.end-partner.start)/2;
    return Math.abs(partner.start-t)<=reach?{from:b,to:partner,gap:partner.start-t}:{from:b,to:null,gap:null};});
  // the two beat grids can sit a steady fraction of a beat apart; measure that on the first pass and take it out for the second
  let pairs=pair(0);
  const gaps=pairs.filter(p=>p.to).map(p=>p.gap);
  if(gaps.length){out.phase=median(gaps);pairs=pair(out.phase);}
  // two of their bars must never share one of mine (a half-time or double-time analysis): the nearer keeps it
  const taken=new Map();
  for(const p of pairs){
    if(!p.to)continue;
    const before=taken.get(p.to.id);
    if(!before||Math.abs(p.gap)<Math.abs(before.gap)){if(before)before.to=null;taken.set(p.to.id,p);}else p.to=null;
  }
  const shifts=new Map();
  for(const p of pairs){
    if(!p.to){out.unmatched.push(p.from);continue;}
    out.bars[p.from.id]={id:p.to.id,beats:p.to.beats};out.matched++;
    const d=p.to.number-p.from.number;shifts.set(d,(shifts.get(d)||0)+1);
  }
  if(shifts.size){
    const [[shift,count]]=[...shifts].sort((a,b)=>b[1]-a[1]);
    out.shift=shift;out.mixed=count<out.matched;
  }
  return out;
}

/** What the match means, in a sentence or two for the person copying. names: {theirs, mine} (the two songs' titles). */
export function matchWords(result,theirs,names){
  if(!result.matched)return `None of “${names.theirs}”’s bars line up in time with this song’s, so nothing can be copied. Are these the same recording?`;
  const words=[];
  if(result.shift){
    const example=theirs.find(b=>result.bars[b.id]&&b.number>=1)||theirs.find(b=>result.bars[b.id]);
    words.push(`The two are counted differently: bar ${example.number} of “${names.theirs}” is bar ${example.number+result.shift} here. Flags go to the same moment in the music, not the same bar number.`);
  }
  if(result.mixed)words.push('The two analyses do not agree about every bar, so check a few flags near the end.');
  return words.join(' ');
}
