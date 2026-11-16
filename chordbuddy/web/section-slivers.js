// A section shorter than one beat is not a section. Charts made before that rule can still hold one: most often a sliver of a few
// milliseconds called "Instrumental" before the first bar, left where the analysis found a gap before the first named section. It has no
// bars, so the chart never drew it, yet the player bar said "Instrumental" at 0:00 and the timeline showed a sliver of it.
// What is shown folds such a sliver into its neighbor (presentation only: the chart and its history are not changed), and the Chart page
// offers a button that joins it for good (absorbChartSection in editor.js). Sections with no beats that last a beat or longer, like a fade
// in or out at the start or end, are real and stay.
const finite=Number.isFinite;

/** The length of one beat at `seconds`: from the bar there (or the nearest bar), else 50 ms. */
export function beatLengthAt(measures,seconds){
  const bars=(measures||[]).filter(m=>finite(m?.start)&&finite(m?.end)&&m.end>m.start);
  if(!bars.length)return .05;   // beats unknown: only a few milliseconds count as a sliver
  const bar=bars.find(m=>seconds>=m.start&&seconds<m.end)||bars.reduce((a,b)=>Math.min(Math.abs(a.start-seconds),Math.abs(a.end-seconds))<=Math.min(Math.abs(b.start-seconds),Math.abs(b.end-seconds))?a:b);
  return (bar.end-bar.start)/Math.max(1,bar.beats?.length||1);
}

/** Is this section too short to be one (shorter than a beat where it sits)? */
export function isSliver(section,measures){
  return finite(section?.start)&&finite(section?.end)&&section.end-section.start<beatLengthAt(measures,(section.start+section.end)/2)-1e-9;
}

/** The section a sliver joins: the one after it when it is the first, else the one before it. */
export function sliverHome(sections,index){
  return index===0?sections[1]||null:sections[index-1]||null;
}

/** The slivers in a chart's sections, each with the section it would join: [{section, home, index}]. Only when there is somewhere to join. */
export function chartSlivers(sections,measures){
  const list=sections||[],out=[];
  if(list.length<2)return out;
  list.forEach((section,index)=>{if(isSliver(section,measures)){const home=sliverHome(list,index);if(home)out.push({section,home,index});}});
  return out;
}
