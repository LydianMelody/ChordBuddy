// Slow, friendly tooltips. Rest the mouse on anything with a data-tip for about a second and a sticker appears next to it.
//   data-tip="What it does"   data-tip-title="Name"   data-tip-key="W"   data-tip-art="<svg …>" (a tiny how-it-works picture)
// It never shows while a button is held, and goes away on click, scroll, key press or when the mouse leaves.
const DELAY=1000;
let installed=false;

export function installTooltips(root=document){
  if(installed||typeof root?.addEventListener!=='function')return;installed=true;
  const tip=document.createElement('div');tip.className='tip';tip.id='cb-tip';tip.setAttribute('role','tooltip');tip.hidden=true;
  document.body.append(tip);
  let timer=null,owner=null;
  const hide=()=>{clearTimeout(timer);timer=null;owner=null;tip.hidden=true;tip.classList.remove('show');};
  function show(node){
    const text=node.dataset.tip;if(!text)return;
    tip.replaceChildren();
    if(node.dataset.tipArt){const art=document.createElement('div');art.className='tip-art-wrap';art.innerHTML=node.dataset.tipArt;tip.append(art);}
    const head=document.createElement('div');head.className='tip-head';
    if(node.dataset.tipTitle){const b=document.createElement('b');b.textContent=node.dataset.tipTitle;head.append(b);}
    if(node.dataset.tipKey){const k=document.createElement('kbd');k.textContent=node.dataset.tipKey;head.append(k);}
    if(head.children.length)tip.append(head);
    const body=document.createElement('p');body.textContent=text;tip.append(body);
    tip.hidden=false;tip.style.left='0px';tip.style.top='0px';
    const box=node.getBoundingClientRect(),size=tip.getBoundingClientRect(),gap=12;
    if(node.dataset.tipSide==='right'&&box.right+gap+size.width<innerWidth-8){
      // beside a vertical rail: to its right, pointing back at the tool
      let top=box.top+box.height/2-size.height/2;
      top=Math.max(8,Math.min(top,innerHeight-size.height-8));
      tip.style.left=Math.round(box.right+gap)+'px';tip.style.top=Math.round(top)+'px';
      tip.style.setProperty('--nub',Math.round(Math.max(16,Math.min(size.height-16,box.top+box.height/2-top)))+'px');
      tip.dataset.side='right';
    }else{
      let left=box.left+box.width/2-size.width/2,top=box.bottom+gap,above=false;
      if(top+size.height>innerHeight-8){top=box.top-gap-size.height;above=true;}
      left=Math.max(8,Math.min(left,innerWidth-size.width-8));
      tip.style.left=Math.round(left)+'px';tip.style.top=Math.round(Math.max(8,top))+'px';
      tip.style.setProperty('--nub',Math.round(Math.max(14,Math.min(size.width-14,box.left+box.width/2-left)))+'px');
      tip.dataset.side=above?'above':'below';
    }
    tip.classList.add('show');owner=node;
  }
  root.addEventListener('pointerover',e=>{
    if(e.buttons)return;
    const node=e.target?.closest?.('[data-tip]');
    if(!node||node===owner)return;
    hide();timer=setTimeout(()=>show(node),DELAY);
    owner=node;
  });
  root.addEventListener('pointerout',e=>{
    const node=e.target?.closest?.('[data-tip]');
    if(node&&!node.contains(e.relatedTarget))hide();
  });
  // keyboard users get the same sticker straight away while a tool has focus (Esc puts it away)
  root.addEventListener('focusin',e=>{
    const node=e.target?.closest?.('[data-tip]');
    if(!node||!node.matches(':focus-visible'))return;
    hide();show(node);node.setAttribute('aria-describedby','cb-tip');
  });
  root.addEventListener('focusout',e=>e.target?.removeAttribute?.('aria-describedby'));
  for(const type of ['pointerdown','keydown','wheel','scroll','blur'])root.addEventListener(type,hide,true);
  window.addEventListener('blur',hide);
}
