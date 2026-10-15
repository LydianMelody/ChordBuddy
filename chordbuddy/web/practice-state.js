import {compactJumpTargets,locateCompactPlayback} from './compact-chart.js';
export const createPracticeState=songId=>({songId,mode:'reading',tool:'text',snap:'eighth',selectedPasses:{},selectedChunk:null,selectedChord:null,sectionId:null,draft:null,saving:false});
export function selectedPass(state,group,seconds){
 const remembered=state.selectedPasses[group.id];
 return group.passes.some(p=>p.number===remembered)?remembered:(group.passes.find(p=>seconds>=p.start&&seconds<p.end)?.number??1);
}
export function practiceAction(state,action,view,seconds){
 if((state.draft||state.saving)&&!['chunk'].includes(action.type))return {state,intent:null,message:'Use Save or Cancel in the current inline editor before continuing.'};
 const next={...state,selectedPasses:{...state.selectedPasses}};let intent=null;
 if(action.type==='mode'){next.mode=action.mode;next.selectedChord=null;next.sectionId=null;}
 else if(action.type==='tool'){next.tool=action.tool;next.selectedChord=null;}
 else if(action.type==='snap')next.snap=action.snap;
 else if(action.type==='chunk')next.selectedChunk=action.chunk;
 else if(action.type==='section'){if(state.mode==='edit'){next.sectionId=action.sectionId;next.selectedChord=null;} }
 else if(action.type==='position'){if(state.mode==='reading')intent={type:'seek',seconds:action.seconds};}
 else if(action.type==='pass'||action.type==='chord'){
  const group=view.groups.find(g=>g.id===action.groupId);if(!group)return {state,intent:null,message:'The chart changed. Choose this position again.'};
  const pass=action.type==='pass'?action.passNumber:selectedPass(state,group,seconds);
  const target=compactJumpTargets(view,{groupId:group.id,slotId:action.slotId}).find(t=>t.passNumber===pass);
  if(!target)return {state,intent:null,message:'This occurrence is unavailable.'};
  next.selectedPasses[group.id]=pass;
  if(state.mode==='reading')intent={type:'seek',seconds:target.seconds};
  else if(action.type==='chord'){
   const occurrence=view.occurrences.find(o=>o.id===target.occurrenceId);
   if(occurrence?.chordId){next.selectedChord={groupId:group.id,slotId:action.slotId,passNumber:pass,chordId:occurrence.chordId};next.sectionId=null;intent={type:'edit-chord',...next.selectedChord};}
  }
 }
 return {state:next,intent,message:null};
}
export function buildPracticeMarkers(view){
 return view.sections.map(s=>({id:s.id,sectionId:s.id,sectionName:s.name,seconds:s.start,end:s.end})).sort((a,b)=>a.seconds-b.seconds);
}
export function actualPracticePosition(view,seconds){return locateCompactPlayback(view,seconds);}
