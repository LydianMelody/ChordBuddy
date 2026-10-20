// The lead sheet's tools: names, wording, icons and tooltip pictures, in the same shared registry the chord chart uses (see tool-icons.js).
import {TOOLS,TOOL_ICONS,TOOL_ART} from './tool-icons.js';

const HL='fill="var(--hl)"',INK='fill="currentColor" stroke="none"';

// The tray groups, the tool that is held at first, and the keys. The keys only act while the lead sheet is showing.
export const LEAD_GROUPS=[['select','chords','lyrics','breaks']];
export const LEAD_NAMES=LEAD_GROUPS.flat();
export const LEAD_DEFAULT='select';
export const LEAD_FOR_KEY={V:'select',C:'chords',L:'lyrics',B:'breaks'};
// Not a tool: a button at the foot of the tray that takes the score out of Chord Buddy.
export const EXTERNAL={
  label:'Editor',title:'Open in another editor',
  body:'Saves this lead sheet as a MusicXML file and opens it in MuseScore, or whichever program your computer uses for that. Chord Buddy does not read your changes back, so from then on this lead sheet stops following the chord chart.',
};

Object.assign(TOOLS,{
  select:{label:'Select',key:'V',mode:'lead',title:'Select notes',
    body:'Click a note to select it and play from there. The arrow keys move along the notes, Up and Down change the pitch, Delete makes a rest.',
    hint:'Click a note to select it. ← → move along, ↑ ↓ change the pitch, Delete makes a rest.'},
  chords:{label:'Chords',key:'C',mode:'lead',title:'Edit chords',
    body:'Click a chord symbol to retype it. A changed chord is changed in the chord chart too.',
    hint:'Click a chord symbol above the staff to retype it.'},
  lyrics:{label:'Lyrics',key:'L',mode:'lead',title:'Type lyrics',
    body:'Click under a staff and type the words, or drag a word onto a note to pin it there. The words belong to the chord chart as well, so both views stay in step.',
    hint:'Click under a staff and type the words. Drag a word onto a note to pin it.'},
  breaks:{label:'Lines',key:'B',mode:'lead',title:'Choose the line breaks',
    body:'Click the end of a bar to start a new line there, or click a marked break to take it away. The bar counter sets how many bars fit on a line.',
    hint:'Click the end of a bar to start a new line there. Click a marked break to remove it.'},
});

Object.assign(TOOL_ICONS,{
  // an eighth note inside a dashed selection box
  select:`<rect x="3.8" y="3.8" width="24.4" height="24.4" rx="5" stroke-dasharray="3 3" stroke-width="1.8" opacity=".8"/><ellipse cx="13" cy="21.4" rx="4.4" ry="3.3" transform="rotate(-20 13 21.4)" ${HL}/><path d="M17.2 20V8.2c0 3.4 3.8 3.6 5 7.4"/>`,
  // a chord tag with a text cursor under it
  chords:`<rect x="3" y="3.5" width="26" height="14" rx="4.5" ${HL}/><text x="16" y="14" text-anchor="middle" font-size="10" font-weight="800" stroke="none" fill="currentColor" style="font-family:var(--g)">Am7</text><path d="M16 21v7.5M12.5 21h7M12.5 28.5h7"/>`,
  // two notes with a word sung under them
  lyrics:`<ellipse cx="8.5" cy="9" rx="3.4" ry="2.6" transform="rotate(-20 8.5 9)" ${INK}/><path d="M11.6 8V2.6M22.5 8.4V3"/><ellipse cx="20" cy="10" rx="3.4" ry="2.6" transform="rotate(-20 20 10)" ${INK}/><path d="M22.9 9V3.4"/><rect x="2.5" y="16.5" width="27" height="12.5" rx="4" ${HL}/><text x="16" y="26" text-anchor="middle" font-size="9.5" font-weight="800" stroke="none" fill="currentColor" style="font-family:var(--g)">la-la</text>`,
  // a staff that wraps onto the next line
  breaks:`<path d="M4 4.5h22M4 9h22M4 13.5h22" stroke-width="1.8"/><path d="M28.5 15v5.5a2.5 2.5 0 0 1-2.5 2.5H8"/><path d="M12.2 18.7L7.6 23l4.6 4.3"/><path d="M4 28.5h9" stroke-width="1.8"/>`,
  // a window with an arrow leaving it
  external:`<rect x="3.5" y="9.5" width="19" height="18.5" rx="3.5" ${HL}/><path d="M15.5 16.5L28 4M20.5 4H28v7.5"/>`,
});

const staff=y=>`<path d="M8 ${y}h152M8 ${y+5}h152M8 ${y+10}h152M8 ${y+15}h152M8 ${y+20}h152" class="a-line"/>`;
const note=(x,y,cls='a-note')=>`<g class="${cls}"><ellipse cx="${x}" cy="${y}" rx="4.4" ry="3.3" transform="rotate(-20 ${x} ${y})"/><path d="M${x+3.8} ${y-1.2}V${y-17}"/></g>`;
Object.assign(TOOL_ART,{
  select:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true">${staff(10)}${note(30,30)}${note(62,25)}<g class="a-pick">${note(96,20,'a-note a-hot')}<rect x="85" y="5" width="24" height="34" rx="6" class="a-ring"/></g>${note(130,25)}<path d="M96 46v8M92.5 50l3.5-4 3.5 4" class="a-arrow a-bob"/></svg>`,
  chords:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><rect x="10" y="10" width="42" height="22" rx="6" class="a-box"/><text x="31" y="26" text-anchor="middle" class="a-chord">Am</text><rect x="62" y="10" width="46" height="22" rx="6" class="a-box a-pop"/><text x="81" y="26" text-anchor="middle" class="a-chord">F</text><text x="92" y="26" class="a-chord a-type">maj7</text><rect x="118" y="10" width="42" height="22" rx="6" class="a-box"/><text x="139" y="26" text-anchor="middle" class="a-chord">C</text>${staff(38)}</svg>`,
  lyrics:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true">${staff(8)}${note(28,23)}${note(62,18)}${note(98,23)}${note(132,28)}<text x="22" y="53" class="a-word a-w1">Dan-</text><text x="56" y="53" class="a-word a-w2">cing</text><text x="92" y="53" class="a-word a-w3">through</text><path d="M60 54h40" class="a-caret a-slide-caret"/></svg>`,
  breaks:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><path d="M10 8h148M10 14h148M10 20h148" class="a-line"/><path d="M10 6v16M58 6v16M106 6v16M158 6v16" class="a-barline"/><g class="a-nl"><circle cx="106" cy="14" r="9" class="a-fill-hl"/><path d="M110 10.5v5h-8M104.2 12.3l-2.8 3.2 2.8 3.2" class="a-ret"/></g><path d="M10 38h148M10 44h148M10 50h148" class="a-line a-second"/><path d="M10 36v16M82 36v16" class="a-barline a-second"/></svg>`,
  external:`<svg class="tip-art" viewBox="0 0 168 58" aria-hidden="true"><rect x="12" y="8" width="62" height="42" rx="7" class="a-box"/><path d="M22 22h42M22 29h42M22 36h42" class="a-line"/><path d="M88 29h44M122 19l12 10-12 10" class="a-arrow a-go"/><rect x="142" y="12" width="18" height="34" rx="4" class="a-fill-hl"/></svg>`,
});
