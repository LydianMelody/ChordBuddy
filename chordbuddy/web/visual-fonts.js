// Fonts a visualization brings with it, and the font its shared chord and lyrics are drawn in.
//
//   fonts:{pixel:{file:'DotGothic16-Regular.ttf', weight:400, style:'normal', optional:true}},   // up to 4 files, from the "fonts" folder
//   overlay:{font:'pixel', weight:400, step:16},                                         // how the chord and lyrics are drawn on top
//
// Safety, because a font file is data from a folder the person controls and must never be a way to reach anything else:
//   - A font is a plain FILE NAME, never a path: it is looked for in one folder only, "fonts" inside My Visuals (or inside
//     web/visualizations for the ones that come with the app). The app builds the address itself, so no folder, scheme, host, drive
//     letter, "..", backslash, query or fragment can get through (checked here, again by the server, which only serves files inside
//     those folders, and by the page's Content-Security-Policy, which only allows files from the app itself). The person decides what
//     is usable by putting font files in that folder; nothing is looked for anywhere else.
//   - Only .woff2, .woff, .ttf and .otf, at most 8 MB, and the first bytes must really be a font (anything else is refused before the
//     browser sees it). The browser's own font sanitizer then checks the file, as it does for the bundled fonts.
//   - The font is registered under a private name made from the visualization's id (never "Space Mono" or any name the app or the page
//     already uses), so it can only be seen by the scene that asked for it and cannot replace or restyle anything else on the page.
//   - Nothing is loaded from the internet. A font that fails to load is reported once in the console; the scene keeps drawing in the
//     fallback font, so a missing file can never break it.
// optional:true is for a font the look can do without: if the file is not in the folder it is skipped quietly (no console note) and env.fonts
// still names the fallback. A visualization reads the result as env.fonts.pixel (a CSS font-family value, with a fallback) and env.fontsReady (false until every
// font it asked for has loaded or failed: cache nothing that depends on the exact letter shapes before then) and env.fontsLoaded ({name: true}
// for the fonts that really loaded, so a look can tell its own font from the fallback; an optional font that is not there is simply absent).
//
// overlay (all optional): font (the name of one of its fonts, or a bundled one: ui, display, mono, typewriter), weight (100-900; a
// bitmap font has one), step (4-64: the size in pixels the font was drawn at, such as 16 for a 16-pixel font; the chord and lyrics then
// use whole multiples of it, on whole pixels, with a hard one-font-pixel outline, so a pixel font stays crisp).
//
// Pure apart from the loader, which is given the browser's fetch, FontFace and font set, so everything is tested without a browser.
import {FONTS} from './visual-hud.js';

export const MAX_FONTS=4,MAX_BYTES=8*1024*1024,EXTENSIONS=['woff2','woff','ttf','otf'];
const NAME=/^[A-Za-z][A-Za-z0-9_]{0,23}$/;
const FILE_NAME=/^[A-Za-z0-9][A-Za-z0-9 _().-]*$/;                // starts with a letter or digit: no "..", no hidden files; no "/" at all
export const FONT_FOLDER='fonts/';
const FALLBACK='system-ui,"Segoe UI",sans-serif';
const own=(object,key)=>Object.hasOwn(object,key);

/** True for a plain file name like "Name.ttf": no folder, only plain characters, one of the font file types. */
export function safeFontFile(file){
  if(typeof file!=='string'||file.length>96)return false;
  const dot=file.lastIndexOf('.');if(dot<1||!EXTENSIONS.includes(file.slice(dot+1).toLowerCase()))return false;
  return FILE_NAME.test(file);
}

/** The private name a font is registered under: it can never equal a name the app or the page uses. */
export const familyName=(id,name)=>`cbv-${String(id).replace(/[^A-Za-z0-9_-]/g,'_')}-${name}`;

/**
 * What a visualization asks for. base: the folder its files are served from ("/my-visuals/" or "/visualizations/"); fonts are read from
 * the "fonts" folder inside it. Returns {fonts:[{name, family, css, url, weight, style, optional}], problems:[text]}; anything unusable is left out and named in problems.
 */
export function fontPlan(definition,base){
  const out={fonts:[],problems:[]},asked=definition?.fonts;
  if(asked===undefined||asked===null)return out;
  if(typeof asked!=='object'||Array.isArray(asked)){out.problems.push('fonts must be an object like {pixel:{file:"fonts/Name.ttf"}}');return out;}
  for(const name of Object.keys(asked)){
    if(out.fonts.length>=MAX_FONTS){out.problems.push(`only the first ${MAX_FONTS} fonts are used`);break;}
    const spec=asked[name];
    if(!NAME.test(name)){out.problems.push(`font name "${String(name).slice(0,30)}" must be letters, digits or _, starting with a letter`);continue;}
    if(!spec||typeof spec!=='object'||!safeFontFile(spec.file)){out.problems.push(`font "${name}": file must be a file name like "Name.ttf" (.woff2, .woff, .ttf or .otf) that sits in the fonts folder, with no folder or address in it`);continue;}
    const weight=spec.weight===undefined?400:spec.weight,style=spec.style===undefined?'normal':spec.style;
    if(!Number.isInteger(weight)||weight<1||weight>1000){out.problems.push(`font "${name}": weight must be a whole number from 1 to 1000`);continue;}
    if(style!=='normal'&&style!=='italic'){out.problems.push(`font "${name}": style must be "normal" or "italic"`);continue;}
    if(spec.optional!==undefined&&typeof spec.optional!=='boolean'){out.problems.push(`font "${name}": optional must be true or false`);continue;}
    const family=familyName(definition.id,name);
    out.fonts.push({name,family,css:`"${family}",${FALLBACK}`,url:base+FONT_FOLDER+encodeURIComponent(spec.file),weight,style,optional:spec.optional===true});
  }
  return out;
}

/** The overlay's style from `overlay` and the fonts it can name: {family, weight, step} (null for the app's usual look), and problems. */
export function readOverlay(definition,families={}){
  const asked=definition?.overlay,problems=[];
  if(asked===undefined||asked===null)return {style:null,problems};
  if(typeof asked!=='object'||Array.isArray(asked))return {style:null,problems:['overlay must be an object like {font:"pixel", step:16}']};
  const style={family:FALLBACK,weight:null,step:0};
  if(asked.font!==undefined){
    if(typeof asked.font==='string'&&own(families,asked.font))style.family=families[asked.font];
    else if(typeof asked.font==='string'&&own(FONTS,asked.font))style.family=FONTS[asked.font];
    else problems.push(`overlay font "${String(asked.font).slice(0,30)}" is not one of this visualization's fonts or a bundled one (ui, display, mono, typewriter)`);
  }
  if(asked.weight!==undefined){if(Number.isInteger(asked.weight)&&asked.weight>=100&&asked.weight<=900)style.weight=asked.weight;else problems.push('overlay weight must be a whole number from 100 to 900');}
  if(asked.step!==undefined){if(Number.isInteger(asked.step)&&asked.step>=4&&asked.step<=64)style.step=asked.step;else problems.push('overlay step must be a whole number from 4 to 64');}
  return {style,problems};
}

/** True when the bytes begin like a font file (WOFF2, WOFF, TrueType, OpenType/CFF or a classic Mac "true" font). */
export function looksLikeFont(bytes){
  if(!bytes||bytes.length<12)return false;
  const tag=String.fromCharCode(bytes[0],bytes[1],bytes[2],bytes[3]);
  return tag==='wOF2'||tag==='wOFF'||tag==='OTTO'||tag==='true'||(bytes[0]===0&&bytes[1]===1&&bytes[2]===0&&bytes[3]===0);
}

/**
 * Loads what visualizations ask for, once per loaded copy of each (an edited file is a new copy and loads again).
 * use(definition) -> {families:{name: css family}, style (the overlay style or null), ready, waiting, problems}
 *   ready: every font has loaded, failed or turned out not to be there.   loaded: {name: true} for the fonts that really loaded.  waiting: the overlay's own font is still loading (hold the overlay a moment rather than
 *   showing it in the wrong face).
 */
export function createFontLoader({fetchFn=globalThis.fetch?.bind(globalThis),FontFaceCtor=globalThis.FontFace,set=globalThis.document?.fonts,warn=console.warn}={}){
  const entries=new WeakMap(),faces=new Map();
  async function bytesOf(url){
    const response=await fetchFn(url,{cache:'no-cache',credentials:'same-origin'});
    if(response.status===404)throw Object.assign(Error('the file is not in the fonts folder'),{missing:true});
    if(!response.ok)throw Error(`the file could not be read (${response.status})`);
    const declared=Number(response.headers?.get?.('content-length'));
    if(declared>MAX_BYTES)throw Error('the file is larger than 8 MB');
    const buffer=await response.arrayBuffer();
    if(buffer.byteLength>MAX_BYTES)throw Error('the file is larger than 8 MB');
    if(!looksLikeFont(new Uint8Array(buffer,0,Math.min(12,buffer.byteLength))))throw Error('the file is not a font');
    return buffer;
  }
  async function start(font,state,label){
    try{
      if(!FontFaceCtor||!set)throw Error('this browser cannot load fonts from files');
      const face=new FontFaceCtor(font.family,await bytesOf(font.url),{weight:String(font.weight),style:font.style});
      await face.load();
      const key=`${font.family}|${font.weight}|${font.style}`;
      if(faces.has(key))set.delete(faces.get(key));                // an edited copy replaces the earlier one
      set.add(face);faces.set(key,face);state.state='ready';
    }catch(error){
      state.state='failed';
      if(error?.missing&&font.optional)return;                       // an optional font that was never put in the folder: nothing to report
      warn(`Visualization "${label}": font "${font.name}" was not used (${error?.message||error}); its fallback is drawn instead`);
    }
  }
  return {
    use(definition){
      let entry=entries.get(definition);
      if(!entry){
        const base=definition?.mine?'/my-visuals/':'/visualizations/',plan=fontPlan(definition,base);
        const families=Object.fromEntries(plan.fonts.map(f=>[f.name,f.css]));
        const overlay=readOverlay(definition,families),problems=[...plan.problems,...overlay.problems];
        for(const text of problems)warn(`Visualization "${definition?.name||definition?.id}": ${text}`);
        const states=plan.fonts.map(f=>({font:f,state:'loading'}));
        for(const s of states)start(s.font,s,definition?.name||definition?.id);
        const overlayIndex=overlay.style?plan.fonts.findIndex(f=>f.css===overlay.style.family):-1;
        let said='',loaded={};
        entry={families,style:overlay.style,problems,
          get loaded(){const key=states.map(s=>s.state[0]).join('');if(key!==said){said=key;loaded=Object.fromEntries(states.filter(s=>s.state==='ready').map(s=>[s.font.name,true]));}return loaded;},
          get ready(){return states.every(s=>s.state!=='loading');},
          get waiting(){return overlayIndex>=0&&states[overlayIndex].state==='loading';}};
        entries.set(definition,entry);
      }
      return entry;
    },
  };
}
