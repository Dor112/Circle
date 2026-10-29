import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {io} from 'socket.io-client';
import {TokenVerifier} from 'livekit-server-sdk';

test('LiveKit tokens are session-bound, private, scoped to one authorized voice room and short lived',async()=>{
  const data=mkdtempSync(path.join(tmpdir(),'krug-livekit-'));
  const key='devkey',secret='not-a-real-secret-long-enough-for-test';
  const server=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:data,VOICE_PROVIDER:'livekit',LIVEKIT_URL:'wss://the-circle-070y91tb.livekit.cloud',LIVEKIT_API_KEY:key,LIVEKIT_API_SECRET:secret},stdio:['ignore','pipe','pipe']});
  const sockets=[];let logs='';server.stderr.on('data',d=>logs+=d);
  try{
    const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs||'Server did not start')),10000);server.stdout.on('data',d=>{const m=String(d).match(/localhost:(\d+)/);if(m){clearTimeout(timer);resolve(`http://127.0.0.1:${m[1]}`);}});server.on('exit',()=>{clearTimeout(timer);reject(new Error(logs));});});
    const req=async(cookie,url,body)=>{const response=await fetch(base+'/api'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,headers:response.headers,body:await response.json()};};
    const registered=await req(null,'/auth/register',{username:'livekit_user',password:'test-password-123'}),cookie=registered.headers.get('set-cookie').split(';')[0];
    const outsider=await req(null,'/auth/register',{username:'other_user',password:'test-password-123'}),otherCookie=outsider.headers.get('set-cookie').split(';')[0];
    const guild=await req(cookie,'/guilds',{name:'Test'}),state=await req(cookie,'/state');
    const [text,voice]=state.body.guilds.find(g=>g.id===guild.body.id).channels;
    const socket=io(base,{extraHeaders:{Cookie:cookie},transports:['websocket'],reconnection:false});sockets.push(socket);await once(socket,'connect');
    assert.deepEqual((await req(cookie,'/rtc')).body,{provider:'livekit'});
    assert.equal((await req(null,`/rooms/${voice.id}/livekit`,{socketId:socket.id})).status,401);
    assert.equal((await req(otherCookie,`/rooms/${voice.id}/livekit`,{socketId:socket.id})).status,403);
    assert.equal((await req(cookie,`/rooms/${voice.id}/livekit`,{socketId:socket.id})).status,403);
    await socket.emitWithAck('voice:join',voice.id);
    assert.equal((await req(cookie,`/rooms/${text.id}/livekit`,{socketId:socket.id})).status,403);
    const result=await req(cookie,`/rooms/${voice.id}/livekit`,{socketId:socket.id});
    assert.equal(result.status,200,logs);assert.equal(result.headers.get('cache-control'),'no-store');
    assert.equal(result.body.url,'wss://the-circle-070y91tb.livekit.cloud');
    assert.ok(!JSON.stringify(result.body).includes(secret));
    const claims=await new TokenVerifier(key,secret).verify(result.body.token);
    assert.equal(claims.sub,registered.body.id);assert.equal(claims.video.room,`krug-${voice.id}`);assert.equal(claims.video.roomJoin,true);assert.ok(!claims.video.roomAdmin);assert.equal(claims.video.canPublishData,false);
    assert.ok(claims.exp-Math.floor(Date.now()/1000)<=120);assert.equal(claims.roomConfig.maxParticipants,8);
    const login=await req(null,'/auth/login',{username:'livekit_user',password:'test-password-123'}),secondCookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await req(secondCookie,`/rooms/${voice.id}/livekit`,{socketId:socket.id})).status,403);
    const vendor=await fetch(base+'/vendor/livekit-client-2.23.0.js');assert.equal(vendor.status,200);assert.equal(vendor.headers.get('content-encoding'),'gzip');assert.ok((await vendor.text()).includes('LivekitClient'));
  }finally{
    sockets.forEach(socket=>socket.disconnect());if(server.exitCode===null){const stopped=once(server,'exit');server.kill();await stopped;}
    rmSync(data,{recursive:true,force:true});
  }
});
