// How the bars of one chart row wrap onto lines. Wrapping used to be left to the browser, which fills each line first, so four bars
// where only three fit became 3 + 1. Here the same number of lines is used but the bars are shared out evenly (2 + 2), and the last
// bar of every line is marked so it can close with a barline.

// widths: each bar's natural width; available: the room on one line. Returns how many bars go on each line.
export function planRows(widths,available){
  const n=widths.length;
  if(n<=1)return [n];
  const lines=[];let count=0,sum=0;
  for(const width of widths){
    if(count&&sum+width>available){lines.push(count);count=0;sum=0;}
    count++;sum+=width;
  }
  lines.push(count);
  if(lines.length===1)return lines;
  const base=Math.floor(n/lines.length),extra=n%lines.length;
  const even=Array.from({length:lines.length},(_,i)=>base+(i<extra?1:0));
  let at=0;
  for(const size of even){
    if(widths.slice(at,at+size).reduce((a,b)=>a+b,0)>available)return lines;      // the even split does not fit: keep the plain one
    at+=size;
  }
  return even;
}

// A repeated row has a lyric lane for every pass in every bar, but its words may all sit on its first line: a wrapped line keeps
// the lanes up to its last one with words (so each pass stays at its height) and drops the rest, instead of standing tall and empty.
// The first line is left as it is.
// used: for each lane, whether this line has words in it. Returns how many lanes the line keeps.
export function lanesToKeep(used){
  for(let i=used.length-1;i>=0;i--)if(used[i])return i+1;
  return 0;
}

// Lay out one `.bars` container: forced breaks between lines, class `row-end` on the last bar of each line, and empty lyric lanes
// at the foot of a line hidden (class `lane-idle`).
export function applyRows(container){
  if(!container?.clientWidth)return;                                   // not on screen (or no layout to measure): nothing to do yet
  const bars=[...container.children].filter(child=>child.classList?.contains('bar'));
  for(const old of [...container.children].filter(child=>child.classList?.contains('row-break')))old.remove();
  for(const bar of bars)bar.classList.remove('row-end');
  for(const lane of container.querySelectorAll?.('.lane.lane-idle')||[])lane.classList.remove('lane-idle');
  if(!bars.length)return;
  const available=container.clientWidth-6;                            // a little room for the barlines that are about to be added
  container.classList.add('measuring');                               // natural widths, before bars stretch to fill their slots
  const counts=planRows(bars.map(bar=>bar.offsetWidth||0),available);
  container.classList.remove('measuring');
  let index=0;
  counts.forEach((count,line)=>{
    const own=bars.slice(index,index+count);
    index+=count;
    const last=bars[index-1];
    const slots=own.flatMap(bar=>[...(bar.querySelectorAll?.('.lyr[data-lane]')||[])]),used=[];
    for(const slot of slots){const i=Number(slot.dataset.lane);used[i]=used[i]||!!slot.querySelector?.('.w');}
    const keep=line?lanesToKeep(Array.from(used,Boolean)):Infinity;   // the first line keeps them all (blank ones are places to type)
    for(const slot of slots)if(Number(slot.dataset.lane)>=keep)slot.closest?.('.lane')?.classList.add('lane-idle');
    last.classList.add('row-end');
    if(line<counts.length-1){const breaker=document.createElement('span');breaker.className='row-break';last.after(breaker);}
  });
}
