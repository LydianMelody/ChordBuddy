// The song's tempo map as a MIDI file: where Chord Buddy found every beat and bar line, written as tempo and time-signature changes so a
// DAW's grid follows the recording (a rubato song included). midi-import.js uses gridTiming() for its custom files too.
//
// gridTiming(grid, tpq, smoothing) -> {tick0, tempos, timeSignatures, toTick(seconds), endTick}
//   grid: songGrid(measures) from midi-align.js. The file's beat i sits at tick0 + i*tpq. Before the first beat there are whole beats at
//   the first beat's length, so the file's bar 1 can start at 0 s like the recording.
//   smoothing: 'beat'   one tempo per beat: every beat is exactly where it was found
//              'bar'    one tempo per bar: bar lines are exact, beats inside a bar are evenly spaced
//              'steady' fewest changes that keep every beat within STEADY_SECONDS of where it was found
// tempoMapMidi({measures, sections, title, smoothing, markers}) -> Uint8Array: a .mid with only the tempo map, the meter, optional section
//   markers, and one long placeholder note ("Delete me") because Ableton Live only offers to import a tempo map from a file that has a
//   note spanning all of it.
import {writeMidi} from './midi-file.js';
import {songGrid,secondsBeat} from './midi-align.js';

export const SMOOTHING=Object.freeze([
  {id:'beat',label:'Every beat',hint:'Exact: every beat lands where Chord Buddy found it. Lots of tempo changes, which is busy but accurate.'},
  {id:'bar',label:'Every bar',hint:'One tempo per bar. Bar lines are exact and the beats inside a bar are evenly spaced. Easier to read and edit.'},
  {id:'steady',label:'Only when it changes',hint:'The fewest tempo changes that keep every beat within 20 thousandths of a second of the recording.'},
]);
export const STEADY_SECONDS=0.02;
const TPQ=960;

/** Beat positions in seconds, with the last bar's end as one more so the final beat has a length. */
const pointsOf=grid=>grid.end!=null?[...grid.beats,grid.end]:[...grid.beats];

/** Tempo changes as [{beat, seconds}]: a new tempo starts at each beat index, lasting `seconds` per beat. */
function segments(pts,grid,smoothing){
  const n=pts.length-1,out=[];
  if(n<1)return out;
  if(smoothing==='bar'){
    const starts=grid.bars.length?grid.bars:[0];
    for(let k=0;k<starts.length;k++){
      const a=starts[k],b=Math.min(n,starts[k+1]??n);
      if(b>a)out.push({beat:a,seconds:(pts[b]-pts[a])/(b-a)});
    }
    return out;
  }
  if(smoothing==='steady'){
    let s=0;
    while(s<n){
      let best=s+1;
      for(let j=s+1;j<=n;j++){
        const avg=(pts[j]-pts[s])/(j-s);let fine=true;
        for(let k=s+1;k<j;k++)if(Math.abs(pts[k]-(pts[s]+(k-s)*avg))>STEADY_SECONDS){fine=false;break;}
        if(!fine)break;best=j;
      }
      out.push({beat:s,seconds:(pts[best]-pts[s])/(best-s)});s=best;
    }
    return out;
  }
  for(let i=0;i<n;i++)out.push({beat:i,seconds:pts[i+1]-pts[i]});
  return out;
}

export function gridTiming(grid,tpq=TPQ,smoothing='beat'){
  const b=grid.beats;
  if(!b.length)throw new Error('This song has no bars yet, so there is nothing to lay a MIDI file on. Analyze it first.');
  const first=(b[1]??b[0]+0.5)-b[0],lead=b[0]>0.02?Math.max(1,Math.round(b[0]/first)):0,tick0=lead*tpq;
  const tempos=[];if(lead)tempos.push({tick:0,usPerQuarter:Math.round(b[0]/lead*1e6)});
  const pts=pointsOf(grid);
  for(const seg of segments(pts,grid,smoothing)){
    const us=Math.round(seg.seconds*1e6);
    if(!tempos.length||tempos.at(-1).usPerQuarter!==us)tempos.push({tick:tick0+seg.beat*tpq,usPerQuarter:us});
  }
  if(!tempos.length)tempos.push({tick:0,usPerQuarter:500000});
  const timeSignatures=[];
  grid.bars.forEach((start,i)=>{const n=(grid.bars[i+1]??b.length)-start;if(n>0&&timeSignatures.at(-1)?.numerator!==n)timeSignatures.push({tick:tick0+start*tpq,numerator:n,denominator:4});});
  if(lead&&timeSignatures.length)timeSignatures.unshift({tick:0,numerator:lead,denominator:4});
  const toTick=s=>Math.max(0,Math.round(s<b[0]?s/b[0]*tick0:tick0+secondsBeat(grid,s)*tpq));
  return {tick0,tempos,timeSignatures,toTick,endTick:tick0+(pts.length-1)*tpq};
}

export function tempoMapMidi({measures,sections=[],title='',smoothing='beat',markers=true}){
  const {tempos,timeSignatures,toTick,endTick}=gridTiming(songGrid(measures),TPQ,smoothing);
  const marks=markers?sections.filter(s=>Number.isFinite(s.start)&&s.name).map(s=>({tick:toTick(s.start),text:String(s.name)})):[];
  const placeholder={name:'Delete me - tempo map',channel:0,notes:[{tick:0,endTick,pitch:60,velocity:1}]};
  return writeMidi({ticksPerQuarter:TPQ,tempos,timeSignatures,tracks:[placeholder],markers:marks,title:title?`${title} tempo map`:'Tempo map'});
}
