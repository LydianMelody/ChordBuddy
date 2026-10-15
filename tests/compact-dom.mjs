export class Node {
 constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.attributes={};this.value='';this.className='';this._text='';this.classList={toggle:(n,on)=>{const s=new Set(this.className.split(' ').filter(Boolean));if(on===undefined)on=!s.has(n);on?s.add(n):s.delete(n);this.className=[...s].join(' ');},add:n=>this.classList.toggle(n,true),remove:n=>this.classList.toggle(n,false)};}
 set textContent(t){this._text=String(t);this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent||'').join('');}
 append(...nodes){this.children.push(...nodes);for(const n of nodes)n.parent=this;}replaceChildren(...nodes){this.children=[];this.append(...nodes);}setAttribute(k,v){this.attributes[k]=v;}getAttribute(k){return this.attributes[k];}focus(){}remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);}querySelectorAll(sel){return all(this).filter(n=>sel[0]==='.'?n.className.split(' ').includes(sel.slice(1)):sel==='textarea'?n.tagName==='textarea':false);}querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
}
export const all=n=>n.children.flatMap(c=>[c,...all(c)]);
export function installDom(){globalThis.document={createElement:t=>new Node(t),createTextNode:t=>{const n=new Node('#text');n.textContent=t;return n;}};}
