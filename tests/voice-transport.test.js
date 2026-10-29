import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {abortable,waitForVoiceConnection,joinVoice} from '../public/voice-transport.js';
class Socket extends EventEmitter {
  connected=false;calls=0;results=[];
  timeout(){return this;}
  emitWithAck(name,room){this.calls++;assert.equal(name,'voice:join');assert.equal(room,'room');const result=this.results.shift();return result instanceof Error?Promise.reject(result):Promise.resolve(result);}
}
test('voice join waits for connection before sending and removes listeners',async()=>{
  const socket=new Socket();socket.results=[{peers:[]}];
  const pending=joinVoice(socket,'room',{connectionTimeout:1000});
  assert.equal(socket.calls,0);socket.connected=true;socket.emit('connect');
  assert.deepEqual(await pending,{peers:[]});assert.equal(socket.calls,1);assert.equal(socket.listenerCount('connect'),0);
});
test('a lost acknowledgement retries the same join once',async()=>{
  const socket=new Socket();socket.connected=true;socket.results=[new Error('operation has timed out'),{peers:[]}];
  assert.deepEqual(await joinVoice(socket,'room'),{peers:[]});assert.equal(socket.calls,2);
});
test('server denials are not retried',async()=>{
  const socket=new Socket();socket.connected=true;socket.results=[{error:'Нет доступа'}];
  await assert.rejects(joinVoice(socket,'room'),{code:'VOICE_REJECTED'});assert.equal(socket.calls,1);
});
test('transport retries are bounded and have an actionable failure',async()=>{
  const socket=new Socket();socket.connected=true;socket.results=[new Error('socket has been disconnected'),new Error('operation has timed out')];
  await assert.rejects(joinVoice(socket,'room'),{code:'VOICE_TRANSPORT'});assert.equal(socket.calls,2);
});
test('cancelling a pending connection prevents a late voice join',async()=>{
  const socket=new Socket(),controller=new AbortController();
  const pending=joinVoice(socket,'room',{signal:controller.signal,connectionTimeout:1000});controller.abort();
  await assert.rejects(pending,{name:'AbortError'});socket.connected=true;socket.emit('connect');
  assert.equal(socket.calls,0);assert.equal(socket.listenerCount('connect'),0);
});
test('connection wait expires and releases its listeners',async()=>{
  const socket=new Socket();await assert.rejects(waitForVoiceConnection(socket,{timeout:5}),{code:'VOICE_TRANSPORT'});
  assert.equal(socket.listenerCount('connect'),0);
});
test('cancelling a pending acknowledgement ignores its late result',async()=>{
  const controller=new AbortController();let finish;
  const pending=abortable(new Promise(resolve=>{finish=resolve;}),controller.signal);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});finish({peers:[]});
});
