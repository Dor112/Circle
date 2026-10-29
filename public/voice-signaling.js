// WebSocket delivery is fast, while the authenticated HTTP mailbox survives a
// lost signaling event. Both paths carry the same ID and are applied only once.
export function createVoiceSignaling({socket,receive,onError=()=>{},fetcher=fetch,signal,interval=1000}){
  const socketId=socket.id,seen=new Map(),acknowledged=new Set();
  const controller=new AbortController();let timer,stopped=false;
  const stop=()=>{stopped=true;clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',stop);seen.clear();acknowledged.clear();};
  signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  const current=()=>!stopped&&socket.id===socketId;
  async function request(path,body){
    const response=await fetcher(`/api/voice/signals${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({socketId,...body}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(6000)])});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось передать параметры звонка');return result;
  }
  async function accept(message){
    if(!current())return;
    if(!message.id){await receive(message);return;}
    let pending=seen.get(message.id);
    if(!pending){
      pending=Promise.resolve().then(()=>receive(message));seen.set(message.id,pending);
      pending.catch(()=>{if(seen.get(message.id)===pending)seen.delete(message.id);});
    }
    await pending;
    if(!current())return;
    acknowledged.add(message.id);
    while(seen.size>256)seen.delete(seen.keys().next().value);
  }
  async function poll(){
    if(!current())return;let delay=interval;
    const ack=[...acknowledged];
    try{
      const result=await request('/read',{ack});if(!current())return;
      for(const id of ack)acknowledged.delete(id);
      for(const message of result.messages){await accept(message);delay=50;}
    }catch(error){if(current()&&error.name!=='AbortError')delay=2000;}
    finally{if(current())timer=setTimeout(poll,delay);}
  }
  async function send(to,payload){
    const message={id:crypto.randomUUID(),to,...payload};
    for(let attempt=0;attempt<3&&current();attempt++){
      try{
        let result;
        if(attempt===0&&socket.connected){
          try{result=await socket.timeout(1500).emitWithAck('voice:signal',message);}catch{}
        }
        if(!current())return;
        if(!result)result=await request('',message);
        if(result.error)throw new Error(result.error);
        return;
      }catch(error){if(!current())return;if(attempt===2)throw error;}
    }
  }
  timer=setTimeout(poll,0);
  return {send,receive:message=>accept(message).catch(error=>{if(current())onError(error);}),stop};
}

// Serialize operations for each peer, and resolve offer collisions by assigning
// opposite polite roles from the two socket IDs.
export function createNegotiator(pc,{polite,send}){
  let tail=Promise.resolve(),ignoreOffer=false,candidates=[];
  const serial=work=>{const result=tail.then(work);tail=result.catch(()=>{});return result;};
  const matches=candidate=>!candidate.usernameFragment||pc.remoteDescription?.sdp?.split(/\r?\n/).includes(`a=ice-ufrag:${candidate.usernameFragment}`);
  return {
    offer:()=>serial(async()=>{
      if(pc.signalingState!=='stable')return;
      await pc.setLocalDescription(await pc.createOffer());await send({description:pc.localDescription});
    }),
    receive:({description,candidate})=>serial(async()=>{
      if(description){
        const collision=description.type==='offer'&&pc.signalingState!=='stable';
        ignoreOffer=collision&&!polite;if(ignoreOffer){candidates=[];return;}
        if(description.type==='answer'&&pc.signalingState!=='have-local-offer')return;
        if(collision)await pc.setLocalDescription({type:'rollback'});
        await pc.setRemoteDescription(description);
        const pending=candidates;candidates=[];for(const c of pending)if(matches(c))await pc.addIceCandidate(c);
        if(description.type==='offer'){await pc.setLocalDescription(await pc.createAnswer());await send({description:pc.localDescription});}
      }
      if(candidate&&!ignoreOffer){if(pc.remoteDescription){if(matches(candidate))await pc.addIceCandidate(candidate);}else if(candidates.length<128)candidates.push(candidate);}
    })
  };
}
