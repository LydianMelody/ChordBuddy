// Loads the bundled abcjs into Node (it needs a few browser names to exist) so score analysis can be tested without a browser.
import {readFileSync} from 'node:fs';

export function loadAbcjs(){
  if(globalThis.ABCJS)return globalThis.ABCJS;
  globalThis.window=globalThis;
  const code=readFileSync(new URL('../chordbuddy/web/vendor/abcjs-basic-min.js',import.meta.url),'utf8');
  new Function('window','self','document',code+';')(globalThis,globalThis,{createElementNS(){return {};},createElement(){return {style:{}};}});
  return globalThis.ABCJS;
}
