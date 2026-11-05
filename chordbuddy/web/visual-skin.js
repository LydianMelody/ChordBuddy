// A visualization's skin: an optional restyle of the visualizer's own panels (the picker and the mixer) to match the scene. It can change
// their colours, fonts, lettering, borders, shadow (hard, coloured or glowing), corners and surface texture; it cannot change what is on
// them or how they are laid out, so every
// skin keeps the controls where people expect them. Anything it leaves out keeps the app's theme, and in the app's dark scheme the
// skin's `dark` part (if any) is laid over the rest. A skin whose words would be hard to read on its paper is left out entirely.
//
//   skin:{paper:'#F4ECDD', ink:'#2B1E3F', highlight:'#FF9EC4', font:'"Courier Prime", monospace', border:3, shadow:6, corners:4,
//         dark:{paper:'#1E1630', ink:'#F4ECDD'}}
//   skin:{paper:'#120F1D', ink:'#F4F0FF', line:'#00E5FF', shadowColor:'#FF3FA4', active:'#FF3FA4', glow:10, texture:'scanlines',
//         caps:true, tracking:0.08}                 (neon: cyan edges, a pink shadow, a glow, scanlines, spaced capitals)
//
// For anything further (brushed brass, wood, bevels, ivory fader caps: a look the scene calls for), a skin can carry its own stylesheet
// as `css`. It is scoped to the two panels (CSS nesting: `&` is the panel itself, `&.visualizer-toolbar` the picker, `.rack` the mixer's
// body), and relative url()s point into the visualization's own folder, so a skin can bring its own images. It still cannot add, remove
// or move controls: they are the same buttons, faders and meters in the same order. The parts it can style:
//   picker  &.visualizer-toolbar · .visualizer-grip · .visualizer-scenes button ([aria-pressed="true"] the look showing, .pinned,
//           .broken) · button[data-control="pin|lyrics|calm|mixer|close"] ([aria-pressed="true"] when on)
//   mixer   .rack · .rack-head (b the title, .rack-count, .fold) · .presets button (.on) · .strips · .stem[data-stem="vocals|lead|rhythm|
//           bass|drums|piano|other"] (.muted .soloed .quiet) · .stem-icon · .track · .meter (i the level, its height is --lvl) · .fader
//           (::-webkit-slider-thumb, ::-webkit-slider-runnable-track) · .mute · .solo ([aria-pressed="true"]) · .strip-label · .master
//           (b, input, output) · .visualizer-mixer-note
//   in the app's dark scheme: :root[data-scheme="dark"] & { … }
// K on the visualizer turns every skin off (plain controls), in case one is ever hard to read.
//
// Pure apart from applySkin and the stylesheet: the checks for colours and fonts are passed in, so it can be tested without a browser.

// skin key -> the CSS custom property the panels' styles use (press-room.base.css, mixer-rack.css, visualizer.css)
// line: the borders (default: ink); shadowColor: the shadow (default: line); active: pressed buttons (default: ink)
export const SKIN_COLORS={paper:'--page',ink:'--ink',desk:'--desk',highlight:'--hl',accent1:'--a1',accent2:'--a2',accent3:'--a3',tint:'--tint',soft:'--soft',
  line:'--line',shadowColor:'--shadow-color',active:'--active'};
export const SKIN_FONTS={font:'--g',mono:'--m'};
// sizes in pixels, kept within these bounds (a 0px border or shadow is allowed: a flat look is still a look)
export const SKIN_SIZES={border:['--bd',0,6],shadow:['--sh',0,10],corners:['--panel-radius',0,24],glow:['--panel-glow',0,24]};
// surface textures drawn faintly in the line colour: a fixed list, so a skin cannot put anything else there
const TEXTURE=(amount,image,size)=>({image:image.replaceAll('$',`color-mix(in srgb,var(--line,var(--ink)) ${amount}%,transparent)`),size});
export const SKIN_TEXTURES={
  scanlines:TEXTURE(10,'repeating-linear-gradient(0deg,$ 0 1px,transparent 1px 3px)','auto'),
  grid:TEXTURE(9,'linear-gradient($ 1px,transparent 1px),linear-gradient(90deg,$ 1px,transparent 1px)','14px 14px'),
  dots:TEXTURE(16,'radial-gradient($ 1px,transparent 1.6px)','9px 9px'),
  paper:TEXTURE(6,'repeating-linear-gradient(45deg,$ 0 1px,transparent 1px 6px),repeating-linear-gradient(-45deg,$ 0 1px,transparent 1px 7px)','auto'),
};
const ON_HL=['#1A1C24','#FFFFFF'];              // words on a highlighted or pressed button: the app's dark ink, or white on a dark one
const ALL=['--on-hl','--on-active','--panel-texture','--panel-texture-size','--panel-caps','--panel-tracking',...Object.values(SKIN_COLORS),...Object.values(SKIN_FONTS),...Object.values(SKIN_SIZES).map(([name])=>name)];
const MIN_CONTRAST=4.5;                         // ink on paper: the WCAG level for ordinary text

// WCAG contrast of two colours given as [r, g, b] (0..255; any alpha after them is ignored)
export function contrast(a,b){
  const lum=([r,g,bl])=>{const c=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;};return 0.2126*c(r)+0.7152*c(g)+0.0722*c(bl);};
  const [hi,lo]=[lum(a),lum(b)].sort((x,y)=>y-x);return (hi+0.05)/(lo+0.05);
}

function readPart(part,{isColor,isFont},out){
  if(!part||typeof part!=='object'||Array.isArray(part))return out;
  for(const [key,name] of Object.entries(SKIN_COLORS)){const v=part[key];if(typeof v==='string'&&v.length<=60&&isColor(v))out[name]=v.trim();}
  for(const [key,name] of Object.entries(SKIN_FONTS)){const v=part[key];if(typeof v==='string'&&v.length<=120&&!/[;{}<>]/.test(v)&&isFont(v))out[name]=v.trim();}
  for(const [key,[name,min,max]] of Object.entries(SKIN_SIZES)){const v=part[key];if(Number.isFinite(v))out[name]=Math.max(min,Math.min(max,Math.round(v*2)/2))+'px';}
  if(typeof part.texture==='string'&&Object.hasOwn(SKIN_TEXTURES,part.texture)){const t=SKIN_TEXTURES[part.texture];out['--panel-texture']=t.image;out['--panel-texture-size']=t.size;}
  else if(part.texture==='none'){out['--panel-texture']='none';out['--panel-texture-size']='auto';}
  if(typeof part.caps==='boolean')out['--panel-caps']=part.caps?'uppercase':'none';
  if(Number.isFinite(part.tracking))out['--panel-tracking']=Math.max(-0.05,Math.min(0.3,Math.round(part.tracking*100)/100))+'em';
  return out;
}
/** The CSS custom properties for a scene's skin in the light or dark scheme: {'--page': '#F4ECDD', …}, or {} for no skin.
 *  check: {isColor(text), isFont(text), toRGB(text) -> [r,g,b,alpha?] or null}; theme: the app's own --page and --ink, for a skin that
 *  changes only one of the two (its contrast is checked against the other one). See-through paper (under 85% opaque) is left out too:
 *  the scene behind it would decide whether the words can be read. */
export function readSkin(skin,{dark=false,theme={},check}){
  if(!skin||typeof skin!=='object')return {};
  const vars=readPart(skin,check,{});if(dark)readPart(skin.dark,check,vars);
  const paper=vars['--page']||theme['--page'],ink=vars['--ink']||theme['--ink'];
  if((vars['--page']||vars['--ink'])&&paper&&ink){
    const p=check.toRGB(paper),i=check.toRGB(ink);
    if(!p||!i||(p[3]??1)<0.85||contrast(p,i)<MIN_CONTRAST)return {};
  }
  for(const [from,to] of [['--hl','--on-hl'],['--active','--on-active']]){
    const c=vars[from]&&check.toRGB(vars[from]);
    if(c){const [dark,light]=ON_HL.map(on=>contrast(c,check.toRGB(on)||[0,0,0]));vars[to]=dark>=light?ON_HL[0]:ON_HL[1];}
  }
  return vars;
}

// The browser's own checks: CSS.supports for colours and fonts, and a canvas to turn any colour into its red, green and blue.
let probe=null;
export const browserCheck={
  isColor:text=>globalThis.CSS?.supports?.('color',text)??false,
  isFont:text=>globalThis.CSS?.supports?.('font-family',text)??false,
  toRGB(text){
    probe??=document.createElement('canvas').getContext('2d');
    probe.fillStyle='#000';probe.fillStyle=text;const v=probe.fillStyle;           // '#rrggbb', or 'rgba(r, g, b, a)' when see-through
    if(v[0]==='#')return [1,3,5].map(i=>parseInt(v.slice(i,i+2),16));
    const m=v.match(/[\d.]+/g);return m&&m.length>=3?m.slice(0,4).map(Number):null;
  },
};
// A skin's own stylesheet, scoped to the panels: the text to load, or null for none. base: the folder its url()s are relative to.
export const SKIN_SCOPE=':is(.visualizer-toolbar,.visualizer-mixer,.visualizer-patchbay)[data-skin]';
export function skinStylesheet(css,{base}){
  if(typeof css!=='string'||!css.trim()||css.length>100000)return null;
  const text=css.replace(/url\(\s*(['"]?)(?!['"]|[a-z][a-z0-9+.-]*:|\/|#)/gi,(match,quote)=>`url(${quote}${base}`);
  return `${SKIN_SCOPE}{\n${text}\n}`;
}
// Load a stylesheet made by skinStylesheet into a constructed sheet, or null when it does not stay inside the panels (a stray } that
// closes the scope early would otherwise style the rest of the app).
export function loadSkinSheet(text){
  if(!text)return null;
  const sheet=new CSSStyleSheet();
  try{sheet.replaceSync(text);}catch{return null;}
  return sheet.cssRules.length===1&&sheet.cssRules[0] instanceof CSSStyleRule?sheet:null;
}
// Put a skin on the panels, replacing the last one (an empty skin takes them back to the app's theme).
export function applySkin(panels,vars){
  for(const panel of panels){for(const name of ALL)panel.style.removeProperty(name);for(const [name,value] of Object.entries(vars))panel.style.setProperty(name,value);}
}
