// The job panel at the top of the page: what the app is working on (an analysis, a stem separation, a rhythm correction), how far it
// is, and its Cancel or Dismiss button.
// app.js makes one with createJobPanel({$, model, api, currentSong, refreshState, showError}) and calls renderJob() after every state
// refresh; wire() attaches the Cancel button.
import {isJobActive,jobProgress} from './editor.js';
import {analysisErrorMessage} from './analysis-view.js';

export function createJobPanel({$,model,api,currentSong,refreshState,showError}){
const jobKey=job=>JSON.stringify([job?.id,job?.kind,job?.status,job?.stage]);
function renderJob(){
  const finished=model.state?.job&&['completed','cancelled'].includes(model.state.job.status),dismissed=model.state?.job&&model.dismissedJob===jobKey(model.state.job);
  if(!model.state?.job||finished||dismissed){$('job-panel').classList.add('hidden');return;}
  const activeJob=model.state?.job;if(['analysis','rhythm'].includes(activeJob?.kind)){const running=isJobActive(activeJob);$('job-panel').classList.remove('hidden');$('job-title').textContent=activeJob.kind==='rhythm'?'Drum-based rhythm correction':'Analyze song';$('job-message').textContent=analysisErrorMessage(activeJob.error,!!currentSong()?.active_run)||activeJob.retention_warning||activeJob.retention?.warning||activeJob.stage;$('cancel-job').classList.toggle('hidden',false);$('cancel-job').textContent=running?'Cancel':'Dismiss';$('cancel-job').classList.toggle('btn-cancel',running);$('cancel-job').disabled=activeJob.status==='cancelling';const progress=$('job-progress'),p=activeJob.progress;progress.classList.toggle('indeterminate',running&&!p?.total);progress.style.width=p?.total?`${Math.min(100,100*p.completed/p.total)}%`:activeJob.status==='completed'?'100%':'25%';return;}

  const job=model.state?.job;const running=isJobActive(job);
  $('job-panel').classList.toggle('hidden',!job);if(!job)return;
  const song=model.state.songs.find(item=>item.id===job.song_id);
  const titles={failed:'Transcription failed',error:'Transcription failed',partial:'Partial transcription · outputs preserved',completed:'Transcription complete',cancelled:'Transcription cancelled',cancelling:'Cancelling transcription',starting:'Starting transcription'};
  if(job.kind==='separation'){
    $('job-title').textContent='Separation'+(song?' — '+song.title:'');
    $('job-message').textContent=job.error||job.retention?.warning||job.message||job.stage;
    const p=job.progress,value=p?.total?100*p.completed/p.total:0;
    $('job-progress').classList.toggle('indeterminate',running&&!value);$('job-progress').style.width=(value||25)+'%';
    $('cancel-job').classList.toggle('hidden',!running);$('cancel-job').disabled=job.status==='cancelling';return;
  }
  $('job-title').textContent=`${titles[job.status] || 'Transcribing'}${song?' · '+song.title:''}`;
  $('job-message').textContent=[job.message || job.stage,job.windows?`Window ${job.window || 0} of ${job.windows}`:null].filter(Boolean).join(' · ');
  const progress=$('job-progress'),value=jobProgress(job);progress.classList.toggle('indeterminate',value.indeterminate);progress.style.width=value.indeterminate?'25%':`${value.percent}%`;
  $('cancel-job').classList.toggle('hidden',!running);
  $('cancel-job').disabled=job.status==='cancelling';
}
function wire(){
$('cancel-job').onclick=async()=>{try{const job=model.state?.job;if(job&&!isJobActive(job)){model.dismissedJob=jobKey(job);renderJob();return;}const path=['analysis','rhythm'].includes(job?.kind)?'/api/analysis/'+job.id+'/cancel':job?.kind==='separation'?'/api/separation/cancel':'/api/cancel';await api(path,job?.kind==='separation'?{job_id:job.id}:{});await refreshState();}catch(error){showError(error);}};
}
return {jobKey,renderJob,wire};
}
