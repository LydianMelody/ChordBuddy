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
