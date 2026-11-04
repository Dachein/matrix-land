// A newly uploaded Worker can briefly be absent from the separate metadata API.
// Retry only this post-upload read failure, not missing resources or permissions.
export async function deployWithMetadataRetry(execute,{accountId,workerName,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onRetry=()=>{}}){
 for(let attempt=0;attempt<3;attempt++){
  try{return await execute();}
  catch(error){
   const output=String(error.output??'').replace(/\x1b\[[0-9;]*m/g,'');
   const transient=output.includes(`Uploaded ${workerName} (`)
    &&output.includes(`/accounts/${accountId}/workers/workers/${workerName}`)
    &&/\[code:\s*10007\]/.test(output);
   if(!transient||attempt===2)throw error;
   onRetry({attempt:attempt+2});await wait(1500*(attempt+1));
  }
 }
}
