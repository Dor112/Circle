import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createLivekitCall} from '../public/livekit-call.js';
class Stream {
  tracks=[];
  getTracks(){return this.tracks.slice();}
  getAudioTracks(){return this.tracks.filter(track=>track.kind==='audio');}
  addTrack(track){this.tracks.push(track);}
  removeTrack(track){this.tracks=this.tracks.filter(item=>item!==track);}
}
function fixture(){
  const events=[],audios=[],room=new EventEmitter();room.state='connected';room.remoteParticipants=new Map();
  const local={identity:'self',name:'Self',trackPublications:new Map(),isMicrophoneEnabled:false,isCameraEnabled:false,isScreenShareEnabled:false,
    async setMicrophoneEnabled(value){events.push(['microphone',value]);this.isMicrophoneEnabled=value;},
    async setCameraEnabled(value){events.push(['camera',value]);this.isCameraEnabled=value;},
    async setScreenShareEnabled(value){events.push(['screen',value]);this.isScreenShareEnabled=value;}};
  room.localParticipant=local;room.connect=async()=>events.push(['connect']);room.startAudio=async()=>events.push(['audio']);room.disconnect=async()=>{events.push(['disconnect']);room.emit('disconnected');};
  const doc={body:{append(){}},createElement(){const audio={play:async()=>{},remove(){this.removed=true;}};audios.push(audio);return audio;}};
  let disconnected=0;
  const call=createLivekitCall({sdk:{Room:class{constructor(){return room;}}},channel:'channel',MediaStream:Stream,document:doc,onDisconnect:()=>disconnected++});
  return {call,room,local,events,audios,get disconnected(){return disconnected;}};
}
test('LiveKit publishes microphone, attaches remote audio once and controls mute and deafen',async()=>{
  const f=fixture();await f.call.connect('wss://test','token');assert.equal(f.call.ready,true);assert.equal(f.local.isMicrophoneEnabled,true);
  const track={kind:'audio'},participant={identity:'other',name:'Other',isMicrophoneEnabled:true,trackPublications:new Map([['audio',{track:{mediaStreamTrack:track},isMuted:false}]])};
  f.room.remoteParticipants.set('other',participant);f.room.emit('trackSubscribed');f.room.emit('trackUnmuted');
  assert.equal(f.audios.length,1);assert.deepEqual(f.call.stream('other').getTracks(),[track]);assert.equal(f.call.members().length,2);
  await f.call.mute(true);assert.equal(f.local.isMicrophoneEnabled,false);
  await f.call.deafen(true);assert.equal(f.audios[0].muted,true);await f.call.deafen(false);assert.equal(f.audios[0].muted,false);
  f.call.stop();assert.equal(f.call.ready,false);assert.equal(f.audios[0].removed,true);assert.equal(f.disconnected,0);
});
test('switching camera and screen disables the previous video source',async()=>{
  const f=fixture();await f.call.connect('url','token');await f.call.video('camera');assert.equal(f.call.videoMode,'camera');
  await f.call.video('screen');assert.equal(f.local.isCameraEnabled,false);assert.equal(f.call.videoMode,'screen');
  await f.call.video(null);assert.equal(f.call.videoMode,null);f.call.stop();
});
test('cancelling a pending connection prevents late microphone capture',async()=>{
  const f=fixture();let finish;f.room.connect=()=>new Promise(resolve=>{finish=resolve;});
  const pending=f.call.connect('url','token');f.call.stop();finish();await pending;
  assert.equal(f.call.ready,false);assert.ok(!f.events.some(([event])=>event==='microphone'));
});
test('LiveKit terminal disconnect is reported while reconnecting preserves the call',async()=>{
  const f=fixture();await f.call.connect('url','token');f.room.state='reconnecting';f.room.emit('reconnecting');
  assert.equal(f.call.ready,true);assert.equal(f.call.reconnecting,true);assert.equal(f.disconnected,0);
  f.room.emit('disconnected');assert.equal(f.call.ready,false);assert.equal(f.disconnected,1);f.call.stop();
});
