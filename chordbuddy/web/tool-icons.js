// The chart tools: names, wording, hand-drawn 32x32 icons, the little how-it-works pictures shown in tooltips,
// and mouse cursors drawn from the same icons. Pure SVG, no assets. Colours come from the theme (--hl, --page, --a1).
export const TOOLS={
  navigate:{label:'Navigate',key:'N',mode:'nav',
    title:'Navigate',
    body:'Click a chord, a word or a section name to play from there. Drag across the timeline below to loop a part.',
    hint:'Click a chord, a word or a section name to play from there.'},
  write:{label:'Write',key:'W',mode:'edit',
    title:'Write',
    body:'Click a chord to retype it. Click under a chord to type the words. Click a section name to rename it.',
    hint:'Click a chord to retype it, or click under a chord to type the words.'},
  cut:{label:'Split',key:'S',mode:'edit',
    title:'Split a section',
    body:'Click the edge between two bars to split the section there and start a new one. Nothing is lost, and Join puts them back together.',
    hint:'Click the edge between two bars to split the section there.'},
  glue:{label:'Join',key:'J',mode:'edit',
    title:'Join sections',
    body:'Click a section name to glue that section onto the one above it.',
    hint:'Click a section name to glue it onto the section above.'},
  repeat:{label:'Repeat',key:'R',mode:'edit',
    title:'Fold repeats',
    body:'Pick the first and last bar of a part that repeats, then choose how it folds: 2 bars ×4, 4 bars ×2, or written out in full.',
    hint:''},
  words:{label:'Time',key:'T',mode:'timing',
    title:'Time the words',
    body:'Drag a word onto a beat to pin it. Words between pins spread out by themselves. Click a pin to let a word go.',
    hint:'Drag a word onto a beat. Words between pins spread out on their own.'},
  barlines:{label:'Barlines',key:'B',mode:'timing',
    title:'Fix the barlines',
    body:'Click + on a beat to split a bar. Drag a barline to move it, or double-click it to join two bars. Use it for short and long measures.',
    hint:'Click + to split a bar. Drag a barline to move it. Double-click a barline to join two bars.'},
};
// The rail shows the tools in these groups. There are no separate modes: each tool says which view it needs
// (Navigate and the editing tools use the chart as written, Time and Barlines draw it true to time).
export const TOOL_GROUPS=[['navigate'],['write','cut','glue','repeat'],['words','barlines']];
export const TOOL_NAMES=TOOL_GROUPS.flat();
export const DEFAULT_TOOL='navigate';
export const MODE_OF=Object.fromEntries(Object.entries(TOOLS).map(([name,t])=>[name,t.mode]));
export const TOOL_FOR_KEY={N:'navigate',W:'write',E:'write',S:'cut',J:'glue',R:'repeat',T:'words',B:'barlines'};

// Icons: ink outlines with a splash of highlight yellow, like the rest of the Press Room.
const HL='fill="var(--hl)"',PG='fill="#FBF7EE"',INK='fill="currentColor" stroke="none"';
export const TOOL_ICONS={
  // a pointer arrow about to press play
  navigate:`<circle cx="24.6" cy="24.4" r="5.3" ${PG}/><path d="M23.1 21.9v5l4.3-2.5z" ${INK}/><path d="M5.8 3.6l17.6 8.7-7.2 2.3 4.7 8.4-4 2.2-4.7-8.4-5.3 5z" ${HL}/>`,
  // a fat pencil with a wavy line of handwriting under it
  write:`<path d="M5.4 22.6l1.3-5.2L20.6 3.5a2.7 2.7 0 0 1 3.8 0l1.1 1.1a2.7 2.7 0 0 1 0 3.8L11.6 22.3z" ${HL}/><path d="M18.4 5.8l5.8 5.8"/><path d="M5.4 22.6l-.9 4 4-.9z" ${PG}/><path d="M12.5 28.2c1.8-2.2 3.1 2.2 5 0s3.1 2.2 5 0 3-1.4 4.5 0"/>`,
  // scissors about to snip a dashed line
  cut:`<path d="M2.5 4.2h4M10 4.2h4M18 4.2h4M25.5 4.2h4" stroke-width="1.8" opacity=".7"/><circle cx="8.6" cy="24" r="3.9" ${HL}/><circle cx="23.4" cy="24" r="3.9" ${HL}/><path d="M11.4 21L24.2 7.2"/><path d="M20.6 21L7.8 7.2"/><circle cx="16" cy="14.1" r="1.4" ${INK}/>`,
  // two section cards pressing together
  glue:`<rect x="4.5" y="2.8" width="23" height="9" rx="2.6" ${HL}/><rect x="4.5" y="20.2" width="23" height="9" rx="2.6" ${PG}/><path d="M9 7.3h8M9 24.7h10" stroke-width="1.8"/><path d="M12 13.8l4 2.7 4-2.7M12 18.2l4-2.7 4 2.7" stroke-width="2"/>`,
  // a repeat sign with a x2 bubble
  repeat:`<path d="M20 4.5v23" stroke-width="4.4"/><path d="M13.6 4.5v23" stroke-width="1.8"/><circle cx="7.6" cy="12.6" r="2.1" ${INK}/><circle cx="7.6" cy="19.4" r="2.1" ${INK}/><rect x="21.6" y="1.8" width="9" height="8" rx="4" ${HL}/><text x="26.1" y="7.9" text-anchor="middle" font-size="6.6" font-weight="800" stroke="none" fill="currentColor" style="font-family:var(--g)">×2</text>`,
  // a word chip you slide along the beats
  words:`<rect x="6.8" y="6.5" width="18.4" height="10" rx="3.2" ${HL}/><path d="M10.6 11.6h5.4M18.6 11.6h2.2" stroke-width="1.8"/><path d="M2.4 11.5l3.2-2.8v5.6zM29.6 11.5l-3.2-2.8v5.6z" ${INK}/><path d="M7 21.5v6M13.2 21.5v6M19.4 21.5v6M25.6 21.5v6" stroke-width="1.8"/><path d="M13.2 21.5v6" stroke-width="3.2"/>`,
  // two barlines and a new one being added between them
  barlines:`<path d="M4 4.5v23M28 4.5v23" stroke-width="3.8"/><path d="M16 4.5v6.2M16 21.3v6.2" stroke-width="1.8"/><circle cx="16" cy="16" r="5.4" ${HL}/><path d="M16 13.2v5.6M13.2 16h5.6" stroke-width="2"/>`,
};
export const toolIcon=(name,cls='')=>`<svg class="tool-ic ${cls}" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICONS[name]||''}</svg>`;

// Cursors: the tool's own icon, in plain ink and yellow so it reads on any theme.
const CURSOR_HOT={navigate:[6,4],cut:[16,6],glue:[16,16],repeat:[16,16],barlines:[16,16],words:[16,16],write:[16,16]};
export function toolCursor(name){
  const body=(TOOL_ICONS[name]||'').replace(/var\(--hl\)/g,'#FFD84A').replace(/var\(--page\)/g,'#FBF7EE').replace(/currentColor/g,'#1A1C24').replace(/style="[^"]*"/g,'');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="#1A1C24" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const [x,y]=CURSOR_HOT[name]||[16,16];
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, crosshair`;
}

// How-it-works pictures for the tooltips: a tiny chart before and after, drawn light on the tooltip's dark paper.
const bars=(x,y,n,w=26,h=15,gap=4,cls='')=>Array.from({length:n},(_,i)=>`<rect class="${cls}" x="${x+i*(w+gap)}" y="${y}" width="${w}" height="${h}" rx="3"/>`).join('');
export const TOOL_ART={
  navigate:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><rect x="8" y="12" width="36" height="22" rx="6" class="a-box"/><text x="26" y="28" text-anchor="middle" class="a-chord">Am</text><rect x="54" y="12" width="36" height="22" rx="6" class="a-box a-pop"/><text x="72" y="28" text-anchor="middle" class="a-chord">F</text><rect x="100" y="12" width="36" height="22" rx="6" class="a-box"/><text x="118" y="28" text-anchor="middle" class="a-chord">C</text><circle cx="72" cy="23" r="6" class="a-ripple"/><path d="M76 26l12 6-5 1.6 3.2 5.8-2.8 1.6-3.2-5.8-3.6 3.4z" class="a-pointer"/><path d="M10 50h148" class="a-line"/><path d="M72 44v12" class="a-playhead"/></svg>`,
  write:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><rect x="10" y="8" width="40" height="22" rx="6" class="a-box"/><text x="30" y="24" text-anchor="middle" class="a-chord">Am</text><rect x="56" y="8" width="40" height="22" rx="6" class="a-box a-pop"/><text x="76" y="24" text-anchor="middle" class="a-chord a-type">F</text><path d="M82 11v16" class="a-caret"/><rect x="102" y="8" width="40" height="22" rx="6" class="a-box"/><text x="122" y="24" text-anchor="middle" class="a-chord">C</text><path d="M10 44h56" class="a-line"/><text x="12" y="49" class="a-word">first words…</text></svg>`,
  cut:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><rect x="6" y="6" width="68" height="9" rx="4" class="a-tag"/><g class="a-bars">${bars(6,20,5,26,17,4)}</g><path d="M92.5 14v38" class="a-cutline"/><g class="a-snip"><circle cx="86" cy="9" r="3.4" class="a-fill-hl"/><circle cx="99" cy="9" r="3.4" class="a-fill-hl"/><path d="M88 11.5l11 -8M97 11.5l-11 -8" class="a-blades"/></g><rect x="100" y="6" width="62" height="9" rx="4" class="a-tag a-new"/></svg>`,
  glue:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><rect x="8" y="5" width="86" height="12" rx="5" class="a-tag"/><g class="a-bars">${bars(8,21,3,26,13,4)}</g><rect x="8" y="39" width="86" height="12" rx="5" class="a-tag a-gone"/><path d="M118 22l22 8-22 8" class="a-arrow"/><g class="a-bars a-merged">${bars(126,12,1,26,34,0)}</g></svg>`,
  repeat:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><g class="a-bars a-faded">${bars(6,20,4,24,17,4)}</g><path d="M6 15h108" class="a-bracket"/><path d="M122 29h8" class="a-arrow"/><g class="a-bars a-folded"><rect x="138" y="17" width="24" height="23" rx="3"/></g><path d="M141 24v10" class="a-dots-bar"/><circle cx="146" cy="25.5" r="1.7" class="a-dot"/><circle cx="146" cy="32.5" r="1.7" class="a-dot"/><rect x="141" y="43" width="22" height="12" rx="6" class="a-fill-hl"/><text x="152" y="52" text-anchor="middle" class="a-x">×4</text></svg>`,
  words:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><path d="M10 40h148" class="a-line"/><path d="M20 34v12M56 34v12M92 34v12M128 34v12M150 34v12" class="a-tick"/><g class="a-slide"><rect x="14" y="10" width="46" height="18" rx="6" class="a-fill-hl"/><text x="37" y="23" text-anchor="middle" class="a-word a-ink">sunrise</text></g><circle cx="92" cy="40" r="4.2" class="a-pin"/></svg>`,
  barlines:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><path d="M10 8v42M158 8v42" class="a-barline"/><path d="M84 8v42" class="a-barline a-new-line"/><circle cx="84" cy="29" r="9" class="a-fill-hl a-knob"/><path d="M84 24v10M79 29h10" class="a-plus"/><path d="M20 29h46M102 29h46" class="a-line"/></svg>`,
};
