/* Export retry never writes a draft or appends a document edit. */
export async function retryDocumentExport(record,request,onChange=()=>{}){
 if(!record||record.exporting||record.saving||record.dirty||!record.doc.export_warning)return false;
 const id=record.doc.id,revision=record.doc.revision;record.exporting=true;onChange();
 try{
  const doc=await request(`/api/document/${encodeURIComponent(id)}/export`,{revision});
  // Do not overwrite an edit or history response that completed during this request.
  if(record.doc.revision===revision){record.doc={...record.doc};if(doc.export_warning)record.doc.export_warning=doc.export_warning;else delete record.doc.export_warning;}
  return !doc.export_warning;
 }catch(error){if(record.doc.revision===revision)record.doc={...record.doc,export_warning:`Edit saved; export retry failed: ${error.message||error}`};return false;}
 finally{record.exporting=false;onChange();}
}
