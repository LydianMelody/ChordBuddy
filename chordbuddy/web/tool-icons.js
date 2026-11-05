// The tools in the rails (chord chart, lead sheet, MIDI): names, wording, hand-drawn 32x32 icons, the little how-it-works pictures shown
// in tooltips, and mouse cursors drawn from the same icons. Pure SVG, no assets. Colours come from the theme (--hl, --page, --a1).
// The chord chart's three tools are here; the lead sheet adds its own (lead-tool-info.js). The other drawings (cut, glue, repeat,
// barlines) are the pictures and cursors of the places on the chart that the Edit and Timing tools work on.
export const TOOLS={
  play:{label:'Play',key:'V',title:'Play from a click',
    body:'Click any chord, word, bar number or section name to play from there. Hold Ctrl to edit for one click instead.'},
  edit:{label:'Edit',key:'E',title:'Edit the chart',
    body:'Click a chord row to retype its chords, under it to type the words, or a section name to rename it. The strip above a line starts a new section there; a barline joins two bars. Hold Ctrl to play from a click instead.'},
  timing:{label:'Timing',key:'T',title:'Line words and chords up in time',
    body:'Draws the chart true to time, so you can drag words and chords onto the beat and fold repeats. A click still plays from there. Holding Shift shows this until you let go.'},
  cue:{label:'Cue',key:'Q',title:'Write a cue',
    body:'Click a chord to put a short note above it for that moment, like “pick scratch”, “count-in” or “feedback”. The chord stays as it is. Click a cue to retype it; empty it to remove it.'},
};
export const CHART_TOOLS=['play','edit','timing','cue'];
export const CHART_FOR_KEY={V:'play',E:'edit',T:'timing',Q:'cue'};

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
  // a MIDI plug (five pins) with a cable: your own MIDI files
  yourmidi:`<circle cx="16" cy="13.5" r="10.2" ${HL}/><circle cx="16" cy="13.5" r="6.6" ${PG}/><circle cx="11.6" cy="13.5" r="1.2" ${INK}/><circle cx="20.4" cy="13.5" r="1.2" ${INK}/><circle cx="16" cy="9.1" r="1.2" ${INK}/><circle cx="12.9" cy="10.4" r="1.2" ${INK}/><circle cx="19.1" cy="10.4" r="1.2" ${INK}/><path d="M16 23.7v5.3"/>`,
  // a speech bubble with a line of writing in it, over a chord's bar: a note for that moment
  cue:`<path d="M4.5 5.5h23a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5H15l-5 4.5v-4.5H4.5A2.5 2.5 0 0 1 2 17V8a2.5 2.5 0 0 1 2.5-2.5z" ${HL}/><path d="M7.5 12.5h9M19 12.5h4.5" stroke-width="1.8"/><path d="M4 28.5h24" stroke-width="1.8"/>`,
  barlines:`<path d="M4 4.5v23M28 4.5v23" stroke-width="3.8"/><path d="M16 4.5v6.2M16 21.3v6.2" stroke-width="1.8"/><circle cx="16" cy="16" r="5.4" ${HL}/><path d="M16 13.2v5.6M13.2 16h5.6" stroke-width="2"/>`,
};
// the chart's tools wear the drawings of the places they work on
TOOL_ICONS.play=TOOL_ICONS.navigate;TOOL_ICONS.edit=TOOL_ICONS.write;TOOL_ICONS.timing=TOOL_ICONS.words;
export const toolIcon=(name,cls='')=>`<svg class="tool-ic ${cls}" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICONS[name]||''}</svg>`;

// Cursors: the tool's own icon, in plain ink and yellow so it reads on any theme.
const CURSOR_HOT={cue:[10,24],navigate:[6,4],cut:[16,6],glue:[16,16],repeat:[16,16],barlines:[16,16],words:[16,16],write:[16,16]};
// `turn` rotates the icon (in degrees): the glue cards pressing side by side are joining bars, not sections.
export function toolCursor(name,turn=0){
  const icon=(TOOL_ICONS[name]||'').replace(/var\(--hl\)/g,'#FFD84A').replace(/var\(--page\)/g,'#FBF7EE').replace(/currentColor/g,'#1A1C24').replace(/style="[^"]*"/g,'');
  const body=turn?`<g transform="rotate(${turn} 16 16)">${icon}</g>`:icon;
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
  cue:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><rect x="10" y="4" width="78" height="17" rx="6" class="a-fill-hl a-pop"/><text x="49" y="16" text-anchor="middle" class="a-word a-ink">pick scratch</text><path d="M84 7v11" class="a-caret"/><rect x="10" y="28" width="40" height="22" rx="6" class="a-box"/><text x="30" y="44" text-anchor="middle" class="a-chord">N</text><rect x="58" y="28" width="40" height="22" rx="6" class="a-box"/><text x="78" y="44" text-anchor="middle" class="a-chord">D#m</text><rect x="106" y="28" width="40" height="22" rx="6" class="a-box"/><text x="126" y="44" text-anchor="middle" class="a-chord">C#</text></svg>`,
  barlines:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><path d="M10 8v42M158 8v42" class="a-barline"/><path d="M84 8v42" class="a-barline a-new-line"/><circle cx="84" cy="29" r="9" class="a-fill-hl a-knob"/><path d="M84 24v10M79 29h10" class="a-plus"/><path d="M20 29h46M102 29h46" class="a-line"/></svg>`,
};
TOOL_ART.play=TOOL_ART.navigate;TOOL_ART.edit=TOOL_ART.write;TOOL_ART.timing=TOOL_ART.words;
