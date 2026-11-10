// Small helpers the main page (app.js) uses everywhere: the session token, the one function every request to the local app goes through,
// and a few formatters. None of them keeps anything about the open song; app.js imports them by name.
import {isNoChordLabel} from './chart-layout.js';
import {displayChordLabel} from './editor.js';
import {spellChord} from './spelling.js';

// The session token arrives in the address (#token=...). Keep it for this tab only and take it out of the address, so it is not left in the
// browser's history or in a copied link; a reload finds it again in the tab's own storage.
export function readSessionToken(){
  let found = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  try {
    if (found) { sessionStorage.setItem('chordbuddy-token', found); history.replaceState(null, '', location.pathname + location.search); }
    else found = sessionStorage.getItem('chordbuddy-token') || '';
  } catch { /* storage blocked: the token in the address still works for this load */ }
  return found;
}
// 75 -> "1:15"
export const timeLabel = seconds => `${Math.floor(Math.max(0,seconds)/60)}:${String(Math.floor(Math.max(0,seconds)%60)).padStart(2,'0')}`;
// A new element with a class and text, in one line.
export const element = (tag,className,text) => {const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text;return node;};
// Every request to the local app: createApi(token) gives api(path, body, options). A body makes it a POST of JSON; the answer is the parsed
// JSON, and an answer that is not OK is thrown as an Error carrying the app's message and the status.
export function createApi(token){
async function api(path, body, options={}) {
  const headers={'X-ChordBuddy-Token':token,...options.headers};
  const init={...options,headers};
  if(body!==undefined) {init.method='POST';init.body=JSON.stringify(body);headers['Content-Type']='application/json';}
  // `options.etag` is a {tag} holder for an answer that is asked for again and again: the last tag goes out with the request, and when the
  // app says nothing changed (304, no body) this returns undefined instead of a result. A new answer leaves its tag in the holder.
  const etag=options.etag;if(etag){delete init.etag;if(etag.tag)headers['If-None-Match']=etag.tag;}
  const response=await fetch(path,init);
  if(etag&&response.status===304)return undefined;
  if(etag&&response.ok)etag.tag=response.headers.get('ETag');
  let result;try{result=await response.json();}catch{throw new Error(`The local app returned an unreadable response (${response.status}).`);}
  if(!response.ok){const error=new Error(result.error || `Request failed (${response.status}).`);error.status=response.status;throw error;}
  return result;
}
return api;
}
// Whether a key press is going into a text box (so shortcuts leave it alone). Tick boxes, sliders and buttons do not count as typing.
export const typingTarget=t=>!!t&&(t.isContentEditable||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||(t.tagName==='INPUT'&&!/^(checkbox|radio|range|button|submit|reset|file|color)$/.test(t.type||'text')));
// What a list of songs adds up to, in seconds.
export const listLength=songs=>songs.reduce((sum,song)=>sum+(Number(song.duration)||0),0);
// What the player's "now" and "next" show: the chord sounding at this time, and the next different one.
export function nowAndNext(chords,chord,time){
  const label=c=>c&&!isNoChordLabel(c.label)?spellChord(displayChordLabel(c.label)):'';
  const current=label(chord);
  const upcoming=[...chords].filter(c=>c.start>time&&label(c)&&label(c)!==current).sort((a,b)=>a.start-b.start)[0];
  return {chord:current||'—',next:label(upcoming)};
}
