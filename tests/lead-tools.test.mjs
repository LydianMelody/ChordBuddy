import test from 'node:test';
import assert from 'node:assert/strict';
import {Node,all,installDom} from './compact-dom.mjs';
import {TOOLS,TOOL_ICONS,TOOL_ART,toolIcon,toolCursor} from '../chordbuddy/web/tool-icons.js';
import {LEAD_GROUPS,LEAD_NAMES,LEAD_DEFAULT,LEAD_FOR_KEY,EXTERNAL} from '../chordbuddy/web/lead-tool-info.js';
import {renderRail} from '../chordbuddy/web/tool-rail.js';

const has=(n,c)=>n.className.split(' ').includes(c);
const byClass=(root,c)=>all(root).filter(n=>has(n,c));

test('every lead sheet tool has a name, wording, an icon, a tooltip picture and one key',()=>{
  const keys=new Set();
  for(const name of LEAD_NAMES){
    const tool=TOOLS[name];
    assert.ok(tool.label&&tool.title&&tool.body.length>40&&tool.hint.length>10,name);
    assert.match(toolIcon(name),/<svg[\s\S]+<\/svg>/);assert.ok(TOOL_ICONS[name].length>30,name);
    assert.match(TOOL_ART[name],/^<svg class="tip-art"/);
    assert.equal(LEAD_FOR_KEY[tool.key],name);assert.ok(!keys.has(tool.key),'keys are unique');keys.add(tool.key);
    assert.match(toolCursor(name),/^url\("data:image\/svg\+xml,/);
  }
  assert.ok(LEAD_NAMES.includes(LEAD_DEFAULT));assert.equal(LEAD_GROUPS.flat().length,new Set(LEAD_NAMES).size);
  assert.ok(TOOL_ICONS.external&&TOOL_ART.external&&EXTERNAL.body.length>40);
});

test('the rail shows the held tool, disables what a frozen copy cannot do, and puts the one-off action at the foot',()=>{
  installDom();const dock=new Node();const picks=[],runs=[];
  renderRail(dock,{groups:LEAD_GROUPS,active:'chords',onPick:name=>picks.push(name),disabled:['lyrics','breaks'],
    actions:[{id:'external',label:EXTERNAL.label,title:EXTERNAL.title,body:EXTERNAL.body,run:()=>runs.push('go')}]});
  const buttons=byClass(dock,'tool-btn');
  assert.deepEqual(buttons.map(b=>b.dataset.tool),['select','chords','lyrics','breaks','external']);
  assert.deepEqual(buttons.filter(b=>b.attributes['aria-pressed']==='true').map(b=>b.dataset.tool),['chords']);
  assert.deepEqual(buttons.filter(b=>b.disabled).map(b=>b.dataset.tool),['lyrics','breaks']);
  const external=buttons.at(-1);assert.ok(has(external,'tool-action'));assert.equal(external.attributes['aria-pressed'],undefined,'an action is never "held"');
  assert.ok(buttons.every(b=>b.dataset.tip&&b.dataset.tipTitle&&b.dataset.tipArt.includes('<svg')&&b.dataset.tipSide==='right'));
  buttons[0].onclick();external.onclick();assert.deepEqual(picks,['select']);assert.deepEqual(runs,['go']);
  assert.equal(byClass(dock,'tool-sep').length,1,'a gap before the one-off action');
});
