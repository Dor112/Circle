const expectedHash='fb646f2260d84f91238d0a2dc10726c456631d6a26c7cafc43cfee5959b4d31d';
async function verify(bytes){const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')===expectedHash;}
export async function cachedLivekitSdk({fetcher=fetch,onProgress=()=>{},storage=globalThis.caches}={}){
  let cache;const key='/vendor/verified-livekit-2.23.0';
  try{
    cache=await storage?.open('krug-livekit-sdk-v1');
    const response=await cache?.match(key);
    if(response){const bytes=new Uint8Array(await response.arrayBuffer());if(await verify(bytes)){onProgress(100);return bytes;}await cache.delete(key);}
  }catch{/* Cache may be unavailable in private browsing. */}
  const bytes=await downloadLivekitSdk(fetcher,onProgress);
  try{await cache?.put(key,new Response(bytes,{headers:{'Content-Type':'application/javascript'}}));}catch{}
  return bytes;
}
// Keep each response below the size where large asset downloads have stalled.
export async function downloadLivekitSdk(fetcher=fetch,onProgress=()=>{}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
  const parts=new Array(19);let next=0,completed=0;
  try{
    async function worker(){
      while(next<parts.length){
        const index=next++;let lastError;
        for(let attempt=0;attempt<3;attempt++){
          try{
            const response=await fetcher(`/vendor/livekit-2.23.0-${index}.bin`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});
            if(!response.ok)throw new Error(`HTTP ${response.status}`);
            const bytes=new Uint8Array(await response.arrayBuffer());
            if(bytes.length!==(index===18?7116:8192))throw new Error('Неполный файл');
            parts[index]=bytes;completed++;onProgress(Math.round(completed*100/parts.length));lastError=null;break;
          }catch(error){lastError=error;if(controller.signal.aborted)throw error;}
        }
        if(lastError)throw new Error('Не удалось загрузить часть модуля LiveKit. Повторите вход в канал.');
      }
    }
    await Promise.all([worker(),worker(),worker()]);
    if(typeof DecompressionStream==='undefined')throw new Error('Для звонков обновите браузер до актуальной версии.');
    const stream=new Blob(parts).stream().pipeThrough(new DecompressionStream('gzip'));
    const bytes=new Uint8Array(await new Response(stream).arrayBuffer());
    if(!await verify(bytes))throw new Error('Проверка целостности модуля LiveKit не прошла. Обновите страницу.');
    return bytes;
  }finally{clearTimeout(timer);controller.abort();}
}
