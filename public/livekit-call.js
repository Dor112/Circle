import {cachedLivekitSdk} from './livekit-loader.js?v=20261029-cache1';
let sdkPromise,sdkProgress=0;const progressListeners=new Set();
export function loadLivekit(onProgress=()=>{}){
  if(globalThis.LivekitClient)return Promise.resolve(globalThis.LivekitClient);
  progressListeners.add(onProgress);onProgress(sdkProgress);
  if(!sdkPromise)sdkPromise=(async()=>{
    const bytes=await cachedLivekitSdk({onProgress:percent=>{sdkProgress=percent;for(const listener of progressListeners)listener(percent);}});
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/javascript'}));
    try{return await new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src=url;
      script.onload=()=>{script.remove();if(globalThis.LivekitClient)resolve(globalThis.LivekitClient);else reject(new Error('Модуль LiveKit не запустился'));};
      script.onerror=()=>{script.remove();reject(new Error('Браузер заблокировал запуск модуля LiveKit'));};document.head.append(script);
    });}finally{URL.revokeObjectURL(url);}
  })().catch(error=>{sdkPromise=null;throw error;});
  return sdkPromise.finally(()=>progressListeners.delete(onProgress));
}

export function createLivekitCall({sdk,channel,onChange=()=>{},onDisconnect=()=>{},onError=()=>{},document:doc=document,MediaStream:Stream=MediaStream}){
  const room=new sdk.Room({adaptiveStream:true,dynacast:true});
  const media=new Map();let closed=false,deafened=false,ready=false;
  const participants=()=>[room.localParticipant,...room.remoteParticipants.values()].filter(p=>p.identity);
  function sync(){
    if(closed)return;
    const active=new Set();
    for(const p of participants()){
      active.add(p.identity);let entry=media.get(p.identity);
      if(!entry){entry={stream:new Stream()};media.set(p.identity,entry);}
      const tracks=[...p.trackPublications.values()].filter(pub=>pub.track&&!pub.isMuted).map(pub=>pub.track.mediaStreamTrack).filter(Boolean);
      for(const track of entry.stream.getTracks())if(!tracks.includes(track))entry.stream.removeTrack(track);
      for(const track of tracks)if(!entry.stream.getTracks().includes(track))entry.stream.addTrack(track);
      if(p!==room.localParticipant&&entry.stream.getAudioTracks().length){
        if(!entry.audio){entry.audio=doc.createElement('audio');entry.audio.autoplay=true;entry.audio.srcObject=entry.stream;doc.body.append(entry.audio);}
        entry.audio.muted=deafened;entry.audio.play().catch(()=>onError(new Error('Нажмите кнопку звука, чтобы разрешить воспроизведение.')));
      }
    }
    for(const [id,entry]of media)if(!active.has(id)){entry.audio?.remove();media.delete(id);}
    onChange();
  }
  for(const event of ['participantConnected','participantDisconnected','trackSubscribed','trackUnsubscribed','trackMuted','trackUnmuted','localTrackPublished','localTrackUnpublished','reconnecting','reconnected','participantNameChanged'])room.on(event,sync);
  room.on('disconnected',()=>{if(!closed){ready=false;onDisconnect();}});
  room.on('audioPlaybackChanged',playing=>{if(!playing&&!closed)onError(new Error('Нажмите кнопку звука, чтобы разрешить воспроизведение.'));});
  function stop(){if(closed)return;closed=true;ready=false;for(const entry of media.values()){if(entry.audio){entry.audio.srcObject=null;entry.audio.remove();}}media.clear();Promise.resolve(room.disconnect()).catch(()=>{});}
  return {
    get ready(){return ready;},
    get reconnecting(){return room.state==='reconnecting'||room.state==='signalReconnecting';},
    async connect(url,token,muted=false){
      try{
        await room.connect(url,token);if(closed){await room.disconnect();return;}
        await room.localParticipant.setMicrophoneEnabled(true,{echoCancellation:true,noiseSuppression:true,autoGainControl:true});
        if(closed){await room.disconnect();return;}
        if(muted)await room.localParticipant.setMicrophoneEnabled(false);
        if(closed){await room.disconnect();return;}
        ready=true;await room.startAudio().catch(()=>{});sync();
      }catch(error){stop();throw error;}
    },
    members:()=>participants().map(p=>({socketId:p.identity,room:channel,user:{id:p.identity,display_name:p.name||'Участник'},muted:!p.isMicrophoneEnabled})),
    stream:id=>media.get(id)?.stream,
    async mute(value){await room.localParticipant.setMicrophoneEnabled(!value);sync();},
    async deafen(value){deafened=value;const playback=[];for(const entry of media.values())if(entry.audio){entry.audio.muted=value;if(!value)playback.push(entry.audio.play());}if(!value)await Promise.all([room.startAudio(),...playback]);},
    async video(mode){
      const p=room.localParticipant;
      if(mode==='screen'){await p.setCameraEnabled(false);await p.setScreenShareEnabled(true,{audio:false});}
      else if(mode==='camera'){await p.setScreenShareEnabled(false);await p.setCameraEnabled(true);}
      else {await p.setCameraEnabled(false);await p.setScreenShareEnabled(false);}
      sync();
    },
    get videoMode(){return room.localParticipant.isScreenShareEnabled?'screen':room.localParticipant.isCameraEnabled?'camera':null;},
    stop
  };
}
