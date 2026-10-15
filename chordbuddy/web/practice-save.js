export async function commitPracticeDocument(record,next,label,expected,api){
 if(!record||record.doc.kind!=='chart'||record.doc.id!==expected.documentId||record.doc.revision!==expected.revision)throw Error('This chart changed. Cancel and reopen the inline editor to use its current revision.');
 if(record.dirty||record.saving)throw Error('Wait for the current save before saving this chart.');
 if(record.practiceConflict)throw Error('Reload this chart from View before editing again.');
 if(JSON.stringify(next)===JSON.stringify(record.doc.content))return;
 record.saving=true;record.practiceSaveError=null;
 try{
  const doc=await api('/api/document/'+encodeURIComponent(record.doc.id),{content:next,label,revision:expected.revision});
  record.doc=doc;record.draft=structuredClone(doc.content);record.dirty=false;record.error=null;record.version++;
 }catch(error){
  if(error.status===409){
   record.practiceConflict=true;
   try{
    const fresh=await api('/api/document/'+encodeURIComponent(record.doc.id));
    record.doc=fresh;record.draft=structuredClone(fresh.content);record.version++;record.practiceConflict=false;
    error.message='This chart changed in another window. Your local line is still here. Cancel and reopen it to edit the newer revision.';
   }catch{error.message='This chart changed and could not be reloaded. Keep this draft, or Cancel and use View / Reload chart when connected.';}
  }
  record.practiceSaveError=error;throw error;
 }finally{record.saving=false;}
}
