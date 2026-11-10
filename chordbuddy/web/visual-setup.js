// How a song is shown in the visualizer. Pure: no DOM, no storage, so it can be tested.
// A song can have its own look pinned to it (its "setup"); every other song uses the usual look. Both are kept as small JSON strings in
// the library's preferences (prefs.js): 'cb-visual:<song id>' for a song's setup and 'cb-visual-usual' for the usual look and switches.
// A setup that names a visualization that is gone (its file deleted or broken) quietly falls back: the usual look, then the default.
import {readPlace} from './visual-layout.js';

export const DEFAULT_SCENE='abstract';
const PANELS=['picker','mixer','patchbay'];     // the floating panels whose place a setup can keep (visual-layout.js)
// a visualization's id: letters, digits, space, _ . - and at most 40 long (a whole setup must fit in one saved preference)
export const ID_TEXT=/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const ID={test:value=>typeof value==='string'&&ID_TEXT.test(value)};

const parse=text=>{if(!text)return null;try{const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}};
const places=(value,out)=>{for(const panel of PANELS){const place=readPlace(value[panel]);if(place)out[panel]=place;}return out;};
// A song's setup from its saved text: {scene, picker?, mixer?} (the look and where its panels sit), or null for none or anything unreadable.
export function readSetup(text){
  const value=parse(text);if(!value||!ID.test(value.scene))return null;
  return places(value,{scene:value.scene});
}
// The usual look, switches and panel places: {scene, lyrics, calm, picker, mixer}; anything missing or unreadable is left out.
export function readUsual(text){
  const value=parse(text)||{},out={};
  if(ID.test(value.scene))out.scene=value.scene;
  for(const key of ['lyrics','calm'])if(typeof value[key]==='boolean')out[key]=value[key];
  return places(value,out);
}
/** The Default Visualization menu: [value, label] pairs. Empty means My usual look. A pinned look whose file is gone stays listed, and says so. */
export function defaultVisualOptions(scenes,pinned,usual){
  const usualName=scenes.find(s=>s.id===usual)?.name;
  const options=[['',usualName?`My usual look (${usualName})`:'My usual look'],...scenes.map(s=>[s.id,s.mine?`${s.name} (My Visuals)`:s.name])];
  if(pinned&&!scenes.some(s=>s.id===pinned.scene))options.push([pinned.scene,`${pinned.scene} (file missing, shows your usual look)`]);
  return options;
}
export const writeSetup=setup=>setup&&ID.test(setup.scene)?JSON.stringify(readSetup(JSON.stringify(setup))):'';
export const writeUsual=usual=>JSON.stringify(readUsual(JSON.stringify(usual||{})));
// Where a panel sits: the song's own place for it, else the usual one, else null (its built-in spot).
export const panelPlace=(panel,{pinned=null,usual=null}={})=>pinned?.[panel]||usual?.[panel]||null;

// The visualization to draw: the one chosen for now (a click in the picker), else the song's own, else the usual one, else the default,
// else the first there is. Each step is skipped when that visualization is not loaded.
export function pickScene(scenes,{showing=null,pinned=null,usual=null}={}){
  for(const id of [showing,pinned?.scene,usual?.scene,DEFAULT_SCENE]){const found=id&&scenes.find(s=>s.id===id);if(found)return found;}
  return scenes[0]||null;
}
