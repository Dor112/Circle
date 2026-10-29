import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { once } from 'node:events';

const data=mkdtempSync(path.join(tmpdir(),'krug-test-'));
let server,base,logs='',alice,bob,outsider,gid,text,voice,mid,uploadId;
const clients=[];
async function start(){server=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:data},stdio:['ignore','pipe','pipe']});server.stderr.on('data',d=>logs+=d);base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),10000);server.stdout.on('data',d=>{const match=String(d).match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);}});server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}: ${logs}`));});});}
async function stop(){const done=once(server,'exit');server.kill();await done;}
async function request(cookie,url,method='GET',body){const r=await fetch(base+'/api'+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body?(body instanceof FormData?body:JSON.stringify(body)):undefined});const json=await r.json();return {status:r.status,json,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function register(username){const r=await request(null,'/auth/register','POST',{username,password:'test-password-123',display_name:username});assert.equal(r.status,200,JSON.stringify(r.json));return {cookie:r.cookie,user:r.json};}
async function connect(user){const s=io(base,{extraHeaders:{Cookie:user.cookie},transports:['websocket'],reconnection:false});clients.push(s);await once(s,'connect');return s;}
function event(s,name){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`No ${name}`)),3000);s.once(name,p=>{clearTimeout(timer);resolve(p);});});}
before(start);after(async()=>{clients.forEach(s=>s.disconnect());await stop();rmSync(data,{recursive:true,force:true});});
test('anonymous requests and cross-origin writes are rejected',async()=>{assert.equal((await request(null,'/state')).status,401);const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);});
test('registration, login and unique usernames',async()=>{alice=await register('alice');bob=await register('bob');outsider=await register('outsider');assert.equal((await request(null,'/auth/login','POST',{username:'alice',password:'incorrect-password'})).status,401);assert.equal((await request(null,'/auth/login','POST',{username:'alice',password:'test-password-123'})).status,200);assert.equal((await request(null,'/auth/register','POST',{username:'ALICE',password:'test-password-123'})).status,409);});
test('guild creation, invite membership, owner-only channel creation',async()=>{gid=(await request(alice.cookie,'/guilds','POST',{name:'Friends'})).json.id;let s=(await request(alice.cookie,'/state')).json;[text,voice]=s.guilds[0].channels.map(c=>c.id);assert.equal((await request(bob.cookie,`/rooms/${text}/messages`)).status,403);const code=(await request(alice.cookie,`/guilds/${gid}/invites`,'POST',{})).json.code;assert.equal((await request(bob.cookie,`/invites/${code}`,'POST',{})).status,200);assert.equal((await request(bob.cookie,`/guilds/${gid}/channels`,'POST',{name:'bad',kind:'text'})).status,403);assert.equal((await request(alice.cookie,`/guilds/${gid}/channels`,'POST',{name:'games',kind:'text'})).status,200);});
test('real-time messages, edit, reactions, pagination and search',async()=>{alice.socket=await connect(alice);bob.socket=await connect(bob);assert.ok((await alice.socket.emitWithAck('room:join',text)).ok);assert.ok((await bob.socket.emitWithAck('room:join',text)).ok);let pending=event(bob.socket,'message');const r=await request(alice.cookie,`/rooms/${text}/messages`,'POST',{body:'Hello friends <script>alert(1)</script>'});mid=r.json.id;assert.equal((await pending).id,mid);assert.equal((await request(bob.cookie,`/messages/${mid}`,'PATCH',{body:'stolen'})).status,403);pending=event(bob.socket,'message:update');assert.equal((await request(alice.cookie,`/messages/${mid}`,'PATCH',{body:'Hello updated'})).status,200);assert.equal((await pending).edited,1);await request(bob.cookie,`/messages/${mid}/reactions`,'POST',{emoji:'👍'});assert.equal((await request(alice.cookie,`/rooms/${text}/messages?search=updated`)).json[0].reactions.length,1);await request(bob.cookie,`/messages/${mid}/reactions`,'POST',{emoji:'👍'});assert.equal((await request(alice.cookie,`/rooms/${text}/messages?before=${mid}`)).json.length,0);});
test('uploads are private until attached to an accessible room',async()=>{const form=new FormData();form.append('file',new Blob(['hello file']), 'hello.txt');const r=await request(alice.cookie,'/uploads','POST',form);uploadId=r.json.id;assert.equal(r.status,200);assert.equal((await request(bob.cookie,`/uploads/${uploadId}`)).status,403);await request(alice.cookie,`/rooms/${text}/messages`,'POST',{attachment:uploadId});const download=await fetch(base+`/api/uploads/${uploadId}`,{headers:{Cookie:bob.cookie}});assert.equal(await download.text(),'hello file');assert.match(download.headers.get('content-disposition'),/attachment/);assert.equal((await request(outsider.cookie,`/uploads/${uploadId}`)).status,403);});
test('private DMs are isolated and history is persistent',async()=>{const d=(await request(alice.cookie,'/dms','POST',{username:'bob'})).json;await request(alice.cookie,`/rooms/${d.id}/messages`,'POST',{body:'Private hello'});assert.equal((await request(bob.cookie,`/rooms/${d.id}/messages`)).json[0].body,'Private hello');assert.equal((await request(outsider.cookie,`/rooms/${d.id}/messages`)).status,403);assert.equal((await request(alice.cookie,'/dms','POST',{username:'bob'})).json.id,d.id);});
test('voice signaling only reaches participants in the same authorized room',async()=>{outsider.socket=await connect(outsider);assert.ok((await outsider.socket.emitWithAck('voice:join',voice)).error);assert.deepEqual((await alice.socket.emitWithAck('voice:join',voice)).peers,[]);const joined=await bob.socket.emitWithAck('voice:join',voice);assert.equal(joined.peers[0].socketId,alice.socket.id);const pending=event(alice.socket,'voice:signal');await bob.socket.emitWithAck('voice:signal',{to:alice.socket.id,description:{type:'offer',sdp:'test-sdp'}});assert.equal((await pending).description.sdp,'test-sdp');assert.ok((await outsider.socket.emitWithAck('voice:signal',{to:alice.socket.id,candidate:{candidate:'fake'}})).error);});
test('kicking revokes text, file and active voice access',async()=>{const kicked=event(bob.socket,'voice:kicked');await request(alice.cookie,`/guilds/${gid}/members/${bob.user.id}`,'DELETE');await kicked;assert.equal((await request(bob.cookie,`/rooms/${text}/messages`)).status,403);assert.equal((await request(bob.cookie,`/uploads/${uploadId}`)).status,403);assert.ok((await bob.socket.emitWithAck('voice:join',voice)).error);});
test('logout invalidates the session and disconnects its socket',async()=>{const disconnected=event(bob.socket,'disconnect');assert.equal((await request(bob.cookie,'/logout','POST',{})).status,200);await disconnected;assert.equal((await request(bob.cookie,'/state')).status,401);});
test('SQLite retains accounts and history across server restart',async()=>{clients.forEach(s=>s.disconnect());await stop();await start();const r=await request(alice.cookie,`/rooms/${text}/messages`);assert.equal(r.status,200);assert.equal(r.json.find(m=>m.id===mid).body,'Hello updated');assert.equal((await request(alice.cookie,'/state')).json.guilds[0].name,'Friends');});

test('native login posts credentials in the body and redirects to a clean URL',async()=>{
  const html=await (await fetch(base+'/')).text();
  assert.match(html,/<form id="auth-form" method="post" action="\/">/);
  const post=(fields,origin=base)=>fetch(base+'/',{method:'POST',redirect:'manual',headers:{Origin:origin},body:new URLSearchParams(fields)});
  const fields={username:'native_user',password:'native-password-123',auth_action:'register'};
  const registered=await post(fields);
  assert.equal(registered.status,303);
  assert.equal(registered.headers.get('location'),'/');
  assert.equal(registered.headers.get('cache-control'),'no-store');
  const cookie=registered.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(cookie,'/state')).json.user.username,'native_user');
  const loggedIn=await post({...fields,auth_action:'login'});
  assert.equal(loggedIn.status,303);
  assert.ok(loggedIn.headers.get('set-cookie'));
  const wrong=await post({...fields,auth_action:'login',password:'wrong-password-123'});
  assert.equal(wrong.status,401);
  assert.equal(wrong.headers.get('set-cookie'),null);
  assert.ok(!(await wrong.text()).includes('wrong-password-123'));
  assert.equal((await post(fields,'https://untrusted.example')).status,403);
});

test('socket reads use the same authorization and data as HTTP routes',async()=>{
  const a=await connect(alice),o=await connect(outsider);
  const read=(client,path)=>client.timeout(2000).emitWithAck('data:read',{path});
  assert.equal((await read(a,'/state')).data.user.id,alice.user.id);
  const expected=(await request(alice.cookie,`/rooms/${text}/messages?search=updated`)).json;
  assert.deepEqual((await read(a,`/rooms/${text}/messages?search=updated`)).data,expected);
  assert.ok((await read(o,`/rooms/${text}/messages`)).error);
  assert.ok((await read(a,'/logout')).error);
  assert.ok((await read(a,'https://untrusted.example/state')).error);
  assert.ok((await read(a,'/rooms/unknown/messages')).error);
  assert.ok((await read(a,'/rtc')).data.iceServers[0].urls.startsWith('stun:'));
  const temporary=await register('socket_expiry');const client=await connect(temporary);
  const disconnected=event(client,'disconnect');
  await request(temporary.cookie,'/logout','POST',{});
  await disconnected;assert.equal(client.connected,false);
  const denied=io(base,{extraHeaders:{Cookie:temporary.cookie},transports:['websocket'],reconnection:false});clients.push(denied);
  const [error]=await once(denied,'connect_error');assert.equal(error.message,'Войдите в аккаунт');denied.disconnect();
});

test('voice join retries do not kick the same socket or duplicate membership',async()=>{
  const a=await connect(alice),b=await connect(outsider);
  const newGuild=(await request(alice.cookie,'/guilds','POST',{name:'Voice retry test'})).json.id;
  const code=(await request(alice.cookie,`/guilds/${newGuild}/invites`,'POST',{})).json.code;
  await request(outsider.cookie,`/invites/${code}`,'POST',{});
  const channel=(await request(alice.cookie,`/guilds/${newGuild}/channels`,'POST',{name:'Voice',kind:'voice'})).json.id;
  let kicked=0;a.on('voice:kicked',()=>kicked++);
  assert.deepEqual((await a.emitWithAck('voice:join',channel)).peers,[]);
  await b.emitWithAck('voice:join',channel);
  const retried=await a.emitWithAck('voice:join',channel);
  assert.deepEqual(retried.peers.map(p=>p.socketId),[b.id]);
  assert.equal(kicked,0);
  const snapshot=(await a.emitWithAck('data:read',{path:'/state'})).data;
  assert.equal(snapshot.voice.filter(v=>v.room===channel).length,2);
  const another=(await request(alice.cookie,`/guilds/${newGuild}/channels`,'POST',{name:'Other',kind:'voice'})).json.id;
  await a.emitWithAck('voice:join',another);assert.equal(kicked,0);
  const replacement=await connect(alice),oldKicked=event(a,'voice:kicked');
  await replacement.emitWithAck('voice:join',another);await oldKicked;assert.equal(kicked,1);
  a.disconnect();b.disconnect();replacement.disconnect();
});

test('voice mailbox recovers lost signals, deduplicates retries and enforces socket ownership',async()=>{
  const a=await connect(alice),b=await connect(outsider);
  const channel=(await request(alice.cookie,'/dms','POST',{username:'outsider'})).json.id;
  await a.emitWithAck('voice:join',channel);await b.emitWithAck('voice:join',channel);
  const offer={id:'first-offer',to:b.id,description:{type:'offer',sdp:'offer-sdp'}};
  assert.deepEqual(await a.emitWithAck('voice:signal',offer),{ok:true});
  const read=()=>request(outsider.cookie,'/voice/signals/read','POST',{socketId:b.id,ack:[]});
  let r=await read();assert.equal(r.status,200);assert.equal(r.json.messages.length,1);
  const message=r.json.messages[0];assert.equal(message.from,a.id);assert.equal(message.description.sdp,'offer-sdp');
  await a.emitWithAck('voice:signal',offer);r=await read();assert.deepEqual(r.json.messages,[message]);
  assert.equal((await request(alice.cookie,'/voice/signals/read','POST',{socketId:b.id,ack:[message.id]})).status,403);
  assert.deepEqual((await read()).json.messages,[message]);
  await request(outsider.cookie,'/voice/signals/read','POST',{socketId:b.id,ack:[message.id]});
  assert.deepEqual((await read()).json.messages,[]);
  const candidate={id:'ice-fallback',to:b.id,candidate:{candidate:'candidate:example',sdpMid:'0',sdpMLineIndex:0,usernameFragment:'abc'}};
  assert.equal((await request(alice.cookie,'/voice/signals','POST',{socketId:a.id,...candidate})).status,200);
  assert.deepEqual((await read()).json.messages[0].candidate,candidate.candidate);
  assert.equal((await request(alice.cookie,'/voice/signals','POST',{socketId:b.id,...candidate})).status,403);
  assert.equal((await request(alice.cookie,'/voice/signals','POST',{socketId:a.id,...offer,to:'unknown'})).status,403);
  assert.equal((await request(alice.cookie,'/voice/signals','POST',{socketId:a.id,...offer,description:{type:'offer',sdp:'x'.repeat(20001)}})).status,400);
  for(let n=0;n<127;n++)assert.ok((await a.emitWithAck('voice:signal',{...candidate,id:`bounded-${n}`})).ok);
  assert.ok((await a.emitWithAck('voice:signal',{...candidate,id:'overflow'})).error);
  await a.emitWithAck('voice:join',voice);
  assert.deepEqual((await read()).json.messages,[]);
  a.disconnect();b.disconnect();
});
