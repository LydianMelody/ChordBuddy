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

// Lay out one `.bars` container: forced breaks between lines, and class `row-end` on the last bar of each line.
export function applyRows(container){
  if(!container?.clientWidth)return;                                   // not on screen (or no layout to measure): nothing to do yet
  const bars=[...container.children].filter(child=>child.classList?.contains('bar'));
  for(const old of [...container.children].filter(child=>child.classList?.contains('row-break')))old.remove();
  for(const bar of bars)bar.classList.remove('row-end');
  if(!bars.length)return;
  const available=container.clientWidth-6;                            // a little room for the barlines that are about to be added
  const counts=planRows(bars.map(bar=>bar.offsetWidth||0),available);
  let index=0;
  counts.forEach((count,line)=>{
    index+=count;
    const last=bars[index-1];
    last.classList.add('row-end');
    if(line<counts.length-1){const breaker=document.createElement('span');breaker.className='row-break';last.after(breaker);}
  });
}
