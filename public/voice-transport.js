const cancelled=()=>Object.assign(new Error('Подключение отменено'),{name:'AbortError'});
export function abortable(promise,signal){
  if(!signal)return promise;
  if(signal.aborted){Promise.resolve(promise).catch(()=>{});return Promise.reject(cancelled());}
  return new Promise((resolve,reject)=>{
    const stop=()=>{signal.removeEventListener('abort',stop);reject(cancelled());};
    signal.addEventListener('abort',stop,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',stop);resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});
  });
}
export function waitForVoiceConnection(socket,{signal,timeout=15000}={}){
  if(signal?.aborted)return Promise.reject(cancelled());
  if(socket.connected)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);socket.off('connect',ready);signal?.removeEventListener('abort',stop);};
    const ready=()=>{cleanup();resolve();};
    const stop=()=>{cleanup();reject(cancelled());};
    const timer=setTimeout(()=>{cleanup();reject(Object.assign(new Error('Сервер не восстановил соединение'),{code:'VOICE_TRANSPORT'}));},timeout);
    socket.on('connect',ready);signal?.addEventListener('abort',stop,{once:true});
    if(socket.connected)ready();
  });
}
export async function joinVoice(socket,room,{signal,timeout=8000,connectionTimeout=15000}={}){
  for(let attempt=0;attempt<2;attempt++){
    await waitForVoiceConnection(socket,{signal,timeout:connectionTimeout});
    let result;
    try{result=await abortable(socket.timeout(timeout).emitWithAck('voice:join',room),signal);}
    catch(error){
      if(error.name==='AbortError')throw error;
      if(attempt===1)throw Object.assign(new Error('Сервер не подтвердил вход в звонок'),{code:'VOICE_TRANSPORT'});
      continue;
    }
    if(result?.error)throw Object.assign(new Error(result.error),{code:'VOICE_REJECTED'});
    if(!Array.isArray(result?.peers))throw new Error('Некорректный ответ сервера звонков');
    return result;
  }
}
