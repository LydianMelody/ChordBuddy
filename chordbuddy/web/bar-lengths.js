// Bars that are shorter or longer than the song's usual bar. Two bars can look identical on the page while one lasts four beats
// and the other two, so those get a small note: "2 beats" on the chart and a real time signature (2/4) on the lead sheet.

// How many beats a bar usually has in this song: the most common count (the later one wins a tie, so a song that mostly
// repeats one bar length is never judged by a single odd bar).
export function usualBeats(measures){
  const counts=new Map();
  for(const m of measures||[]){const n=m.beats?.length;if(n)counts.set(n,(counts.get(n)||0)+1);}
  let best=4,most=0;
  for(const [n,count] of counts)if(count>=most){most=count;best=n;}
  return best;
}

export const isOddBar=(measure,usual)=>!!measure?.beats?.length&&measure.beats.length!==usual;

// The informal note for the chart.
export const beatsLabel=n=>`${n} beat${n===1?'':'s'}`;

// A time signature for a bar of n quarter-note beats, or null when that would be silly.
export const meterOf=n=>Number.isInteger(n)&&n>=1&&n<=12?{num:String(n),den:'4'}:null;

// The song's time signature as [beats, note value]: the one most bars carry (the later one wins a tie). The model tags every beat with a meter and
// sometimes gets the very first, a pickup, wrong (a lone 1/8 before a song of 4/4 bars), so the first bar alone is never trusted.
export function usualMeter(measures){
  const counts=new Map();
  for(const m of measures||[]){
    const meter=m.meter;if(!Array.isArray(meter)||meter.length!==2||!(meter[0]>0)||!(meter[1]>0))continue;
    const key=meter.join('/'),entry=counts.get(key)||{meter,count:0};entry.count++;counts.set(key,entry);
  }
  let best=null;
  for(const entry of counts.values())if(!best||entry.count>=best.count)best=entry;
  return best?best.meter:null;
}

// The signatures offered for changing it, and reading one back from a saved choice.
export const METER_CHOICES=['2/4','3/4','4/4','5/4','6/4','7/4','2/2','3/2','3/8','6/8','7/8','9/8','12/8'];
export function parseMeter(text){
  const found=/^(\d{1,2})\/(\d{1,2})$/.exec(String(text||''));
  return found&&METER_CHOICES.includes(found[0])?[Number(found[1]),Number(found[2])]:null;
}
