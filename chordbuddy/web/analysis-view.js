export function analysisUiState(song,job){
 return {label:song?.active_run?'Analyze again':'Analyze song',busy:!!job&&['running','cancelling','starting'].includes(job.status),stage:job?.stage||'',error:job?.error||''};
}

export function songStatusLabel(song){
 if(['error','failed'].includes(song.status))return song.active_run?'Saved chart; latest analysis failed':'Transcription failed';
 if(song.status==='partial')return song.active_run?'Saved chart; analysis partly complete':'Partial analysis - outputs preserved';
 if(song.status==='completed'||song.active_run)return 'Transcribed';
 return song.status==='imported'?'Ready to analyze':song.status||'Imported';
}
export function analysisErrorMessage(error,hasPrior=false){
 const text=String(error||'');
 if(/confidence\.json|confidence metadata/i.test(text)&&/Access is denied|file replacement|refused/i.test(text)){
  return 'The latest analysis could not finish saving confidence metadata. '+(hasPrior?'Your earlier chart and stems are preserved. Saved playback is available when its stems validate.':'Exported files are preserved; this analysis did not complete.');
 }
 return text;
}

// Locked-state progress list. A job reports the running stage by name (job.stage) and finished ones in job.stages.
export const LOCK_STEPS=[['source','Preparing the audio','clock'],['separation','Separating the seven stems','layers'],['transcription','Listening for chords','wave'],['chart','Building your chart','chart']];
const FAILED=['failed','error','partial','cancelled','interrupted'];
export function lockStepStates(job){
 const running=!!job&&['running','cancelling','starting','preparing','separating','refining','validating','loading','transcribing','exporting'].includes(job.status);
 const separationOnly=job?.kind==='separation';
 return LOCK_STEPS.map(([kind,label,glyph])=>{
  const status=job?.stages?.[kind]?.status;
  const done=status==='completed'||running&&separationOnly&&kind==='source';
  const active=!done&&running&&(job.stage===kind||separationOnly&&kind==='separation');
  const failed=!done&&!active&&status==='failed';
  return {kind,label,glyph,state:done?'done':active?'active':failed?'failed':running?'wait':'idle'};
 });
}
export function lockJobFailed(job){return !!job&&FAILED.includes(job.status);}
