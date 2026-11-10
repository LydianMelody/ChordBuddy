// The locked state of a song: a song is unusable until its analysis finishes (readiness is decided by PlaybackGate/transport).
// This draws it: the full "Not analyzed yet" panel with its steps and button, or the banner over a song whose playback is locked.
// app.js makes one with createLockPanel({$, model, transport, element, currentSong, renderSections}); renderLock() is called after every
// state refresh and on every transport change (it redraws only when something it shows changed), lockMode() says 'none', 'full' or
// 'banner', and wire() attaches the panel's button.
import {isJobActive} from './editor.js';
import {analysisErrorMessage,lockStepStates,lockJobFailed} from './analysis-view.js';
import {icon} from './icons.js';

export function createLockPanel({$,model,transport,element,currentSong,renderSections}){
let lockSig='',lockedMode='none';
function lockMode(){const song=currentSong();if(!song)return 'none';if(!song.active_run)return 'full';return model.readinessChecked&&!transport.getSnapshot().ready?'banner':'none';}
function analysisJobFor(song){const job=model.state?.job;return job&&song&&job.song_id===song.id&&['analysis','separation'].includes(job.kind)?job:null;}
function renderLock(){
  const song=currentSong(),mode=lockMode(),job=analysisJobFor(song),running=!!job&&isJobActive(job),snap=transport.getSnapshot();
  const sig=JSON.stringify([mode,song?.id,job&&[job.kind,job.status,job.stage,job.error,job.stages],model.state?.engine?.ready,snap.ready,snap.readiness]);
  if(sig===lockSig)return;lockSig=sig;
  $('app').dataset.lock=mode;
  $('nav-lock').classList.toggle('hidden',!song||snap.ready);
  $('lock-banner').classList.toggle('hidden',mode!=='banner');
  $('banner-reanalyze').classList.toggle('hidden',running);               // the analysis is already running: its panel above has Cancel
  if(mode==='banner')$('lock-banner-text').textContent=(running?'Analyzing again. ':'')+(snap.readiness||'Playback is locked.')+(running?'':' Your chart is still here to view and edit.');
  $('locked-panel').classList.toggle('hidden',mode!=='full');
  if(mode==='full'){
    const failed=lockJobFailed(job);
    $('lock-title').textContent=running?'Analyzing…':failed?(job.status==='cancelled'?'Analysis cancelled':'Analysis did not finish'):'Not analyzed yet';
    $('lock-copy').textContent=running?(job.message||'This can take a few minutes. Playback unlocks when the chart and all seven stems are ready.'):failed?(analysisErrorMessage(job.error,false)||'Analyze again to unlock playback.'):'Chord Buddy needs to listen first. Analysis builds the chord chart and the seven practice stems; playback unlocks when both are ready.';
    const steps=$('lock-steps');steps.replaceChildren();
    for(const {label,glyph,state} of lockStepStates(job)){
      const step=element('div','step'+(state==='idle'?'':' '+state));
      const mark=element('span');mark.innerHTML=icon(state==='done'?'check':state==='failed'?'x':glyph);step.append(mark.firstChild,element('span','',label));
      if(state==='active'){const bar=element('span','bar-p');bar.append(document.createElement('i'));step.append(bar);}
      steps.append(step);
    }
    const cta=$('lock-cta'),text=cta.querySelector('em');
    text.textContent=running?'Cancel analysis':failed?'Analyze again':'Analyze song';
    cta.disabled=!running&&!model.state?.engine?.ready;cta.title=cta.disabled?(model.state?.engine?.message||'Set up the transcription engine first.'):'';
    cta.classList.toggle('hot',!running);
  }
  if(lockedMode!==mode){lockedMode=mode;renderSections();}
}
function wire(){
$('lock-cta').onclick=()=>{const job=analysisJobFor(currentSong());(job&&isJobActive(job)?$('cancel-job'):$('transcribe')).click();};
}
return {lockMode,analysisJobFor,renderLock,wire};
}
