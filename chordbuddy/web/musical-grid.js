export const SNAP_QUARTERS=Object.freeze({whole:4,half:2,quarter:1,eighth:.5,sixteenth:.25,'thirty-second':.125});
const finite=Number.isFinite,near=(a,b)=>Math.abs(a-b)<1e-8;
export function addressAtSeconds(measures,seconds){
 const m=measures.find(m=>seconds>=m.start&&seconds<m.end)|| (seconds===measures.at(-1)?.end?measures.at(-1):null);if(!m)return null;
 const times=[...m.beats,m.end];if(seconds===m.end)return {measure_id:m.id,beat:m.beats.length};
 const i=times.findIndex((t,i)=>i<times.length-1&&seconds>=t&&seconds<times[i+1]);
 return i<0?null:{measure_id:m.id,beat:i+(seconds-times[i])/(times[i+1]-times[i])};
}
export function secondsAtAddress(measures,address){
 const m=measures.find(m=>m.id===address?.measure_id);if(!m||!finite(address.beat)||address.beat<0||address.beat>m.beats.length)throw Error('Choose a recorded bar and position.');
 if(address.beat===m.beats.length)return m.end;
 const i=Math.floor(address.beat),points=[...m.beats,m.end];return points[i]+(address.beat-i)*(points[i+1]-points[i]);
}
function quarterAt(m,beat){
 const q=m.quarter_positions;if(!q||q.length!==m.beats.length+1)return null;
 const i=Math.floor(beat);if(near(i,beat))return finite(q[i])?q[i]:null;
 return finite(q[i])&&finite(q[i+1])&&q[i+1]>q[i]?q[i]+(beat-i)*(q[i+1]-q[i]):null;
}
export function musicalPosition(measures,seconds){
 const address=addressAtSeconds(measures,seconds),m=measures.find(m=>m.id===address?.measure_id);
 if(!m)return null;const q=quarterAt(m,address.beat);return {...address,bar:m.number,beat:finite(q)&&m.meter?q*m.meter[1]/4+1:null,quarter:q,storedBeat:address.beat};
}
export function secondsAtMusicalPosition(measures,bar,beat){
 const m=measures.find(m=>m.number===Number(bar));if(!m?.meter||!finite(Number(beat)))throw Error('Musical timing is unavailable for this bar.');
 const q=(Number(beat)-1)*4/m.meter[1],positions=m.quarter_positions,times=[...m.beats,m.end];
 if(!positions||positions.length!==times.length)throw Error('Musical grid unavailable; keep the existing position.');
 for(let i=0;i<positions.length;i++){
  if(finite(positions[i])&&near(q,positions[i]))return times[i];
  if(i<positions.length-1&&finite(positions[i])&&finite(positions[i+1])&&q>positions[i]&&q<positions[i+1])return times[i]+(q-positions[i])/(positions[i+1]-positions[i])*(times[i+1]-times[i]);
 }
 throw Error('Choose a beat within the recorded bar; its missing timing cannot be guessed.');
}
export function buildPlacementTargets(measures,{snap='eighth',anchors=[],onsets=[]}={}){
 const step=SNAP_QUARTERS[snap];if(!step)throw Error('Choose a supported note snap.');
 const targets=[];let unavailable=false;
 function add(m,seconds,kind,address=null){
  if(!(seconds>=m.start&&seconds<m.end))return;
  const existing=targets.find(t=>t.address.measure_id===m.id&&near(t.seconds,seconds));
  if(existing){existing.kinds.push(kind);if(kind==='anchor'&&address)existing.address={...address};return;}
  address=address||addressAtSeconds([m],seconds);
  targets.push({id:m.id+':'+seconds.toPrecision(16),seconds,address:{...address},kinds:[kind],position:musicalPosition([m],seconds)});
 }
 for(const m of measures){
  const q=m.quarter_positions,times=[...m.beats,m.end];
  if(!q||q.length!==times.length){unavailable=true;continue;}
  for(let i=0;i<q.length-1;i++){
   if(!finite(q[i])||!finite(q[i+1])||q[i+1]<=q[i]){unavailable=true;continue;}
   for(let pos=Math.ceil((q[i]-1e-8)/step)*step;pos<q[i+1]-1e-8;pos+=step){
    const seconds=times[i]+(pos-q[i])/(q[i+1]-q[i])*(times[i+1]-times[i]);add(m,seconds,'grid');
   }
  }
 }
 for(const a of anchors){const m=measures.find(m=>m.id===a.measure_id);if(m&&a.beat>=0&&a.beat<m.beats.length)add(m,secondsAtAddress([m],a),'anchor',a);}
 for(const t of onsets){const m=measures.find(m=>t>=m.start&&t<m.end);if(m)add(m,t,'onset');}
 targets.sort((a,b)=>a.seconds-b.seconds);
 return {targets,reason:unavailable?'Some musical grid positions are unavailable. Exact saved anchors and chord onsets remain available.':null,step};
}
export function hitPlacementTarget(targets,geometry,pointer){
 const hits=geometry.filter(r=>pointer.x>=r.x&&pointer.x<r.x+r.width&&pointer.y>=r.y&&pointer.y<r.y+r.height);
 return hits.length===1?targets.find(t=>t.id===hits[0].id)||null:null;
}
