import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceSignaling,createNegotiator} from '../public/voice-signaling.js';

const response=data=>({ok:true,json:async()=>data});
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
test('a lost socket signal falls back to authenticated HTTP with the same message ID',async()=>{
  let socketPayload,body;
  const socket={id:'self',connected:true,timeout(){return this;},async emitWithAck(event,payload){assert.equal(event,'voice:signal');socketPayload=payload;throw new Error('timeout');}};
  const transport=createVoiceSignaling({socket,receive:async()=>{},fetcher:async(url,options)=>{assert.equal(url,'/api/voice/signals');body=JSON.parse(options.body);return response({ok:true});}});
  try{await transport.send('other',{description:{type:'offer',sdp:'offer'}});assert.equal(body.id,socketPayload.id);assert.equal(body.socketId,'self');assert.equal(body.to,'other');}finally{transport.stop();}
});

test('mailbox replays and concurrent socket events apply a signal only once',async()=>{
  let release,count=0;const message={id:'one',from:'other',description:{type:'offer',sdp:'offer'}};
  const transport=createVoiceSignaling({socket:{id:'self'},receive:async()=>{count++;await new Promise(resolve=>{release=resolve;});},fetcher:async()=>response({messages:[]})});
  try{const first=transport.receive(message),second=transport.receive(message);await Promise.resolve();assert.equal(count,1);release();await Promise.all([first,second]);await transport.receive(message);assert.equal(count,1);}finally{transport.stop();}
});

test('HTTP polling retrieves a missed signal and acknowledges only after it is applied',async()=>{
  let applied=false,acknowledged=false,calls=0;
  const transport=createVoiceSignaling({socket:{id:'self'},interval:1,receive:async()=>{applied=true;},fetcher:async(url,options)=>{
    assert.equal(url,'/api/voice/signals/read');const body=JSON.parse(options.body);calls++;
    if(body.ack.includes('missed')){assert.equal(applied,true);acknowledged=true;}
    return response({messages:calls===1?[{id:'missed',from:'other'}]:[]});
  }});
  try{for(let n=0;n<30&&!acknowledged;n++)await tick();assert.ok(acknowledged);}finally{transport.stop();}
});

test('stopping a call cancels the mailbox request and prevents more signal sends',async()=>{
  let started=0,aborted=false;
  const transport=createVoiceSignaling({socket:{id:'self'},receive:async()=>{},fetcher:async(url,{signal})=>{
    started++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));},{once:true}));
  }});
  await tick();transport.stop();await transport.send('other',{candidate:{candidate:'x'}});await tick();assert.equal(started,1);assert.equal(aborted,true);
});

class Peer {
  signalingState='stable';localDescription=null;remoteDescription=null;events=[];
  async createOffer(){return {type:'offer',sdp:'offer'};}
  async createAnswer(){return {type:'answer',sdp:'answer'};}
  async setLocalDescription(d){this.events.push(`local:${d.type}`);this.localDescription=d;this.signalingState=d.type==='offer'?'have-local-offer':'stable';}
  async setRemoteDescription(d){this.events.push(`remote:${d.type}`);this.remoteDescription=d;this.signalingState=d.type==='offer'?'have-remote-offer':'stable';}
  async addIceCandidate(c){this.events.push(`candidate:${c.candidate}`);}
}
test('simultaneous offers resolve to one answer instead of leaving both peers waiting',async()=>{
  const a=new Peer(),b=new Peer(),outA=[],outB=[];
  const polite=createNegotiator(a,{polite:true,send:async m=>outA.push(m)}),impolite=createNegotiator(b,{polite:false,send:async m=>outB.push(m)});
  await Promise.all([polite.offer(),impolite.offer()]);
  await Promise.all([polite.receive(outB[0]),impolite.receive(outA[0])]);
  assert.deepEqual(a.events,['local:offer','local:rollback','remote:offer','local:answer']);
  assert.deepEqual(b.events,['local:offer']);assert.equal(outA[1].description.type,'answer');
  await impolite.receive(outA[1]);assert.equal(a.signalingState,'stable');assert.equal(b.signalingState,'stable');
});
test('ICE arriving before the offer is queued and applied after the remote description',async()=>{
  const pc=new Peer(),negotiator=createNegotiator(pc,{polite:true,send:async()=>{}});
  await negotiator.receive({candidate:{candidate:'early'}});assert.deepEqual(pc.events,[]);
  await negotiator.receive({description:{type:'offer',sdp:'offer'}});
  assert.deepEqual(pc.events,['remote:offer','candidate:early','local:answer']);
});
test('ICE belonging to an abandoned offer is ignored after negotiation changes',async()=>{
  const pc=new Peer(),negotiator=createNegotiator(pc,{polite:true,send:async()=>{}});
  await negotiator.receive({candidate:{candidate:'stale',usernameFragment:'old'}});
  await negotiator.receive({description:{type:'offer',sdp:'a=ice-ufrag:new\r\n'}});
  await negotiator.receive({candidate:{candidate:'current',usernameFragment:'new'}});
  assert.deepEqual(pc.events,['remote:offer','local:answer','candidate:current']);
});
