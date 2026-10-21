const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const initials = name => String(name).split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase();
let state, socket, guildId=null, room=null, messages=[], search='', pendingFile=null, registration=false, generation=0;
let voiceRoom=null, localStream=null, videoStream=null, videoMode=null, muted=false, deafened=false, rtcConfig, joining=false, dmCallView=false;
const peers=new Map(), typingTimers=new Map();
let toastTimer;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
async function api(url,method='GET',body){
  const r=await fetch(`/api${url}`,{method,headers:body instanceof FormData?{}:{'Content-Type':'application/json'},body:body?(body instanceof FormData?body:JSON.stringify(body)):undefined});
  const result=await r.json();if(!r.ok){if(r.status===401&&state){leaveCall();socket?.disconnect();state=null;$('app').hidden=true;$('auth').hidden=false;}throw new Error(result.error||'Ошибка запроса');}return result;
}
function action(fn){return async(...args)=>{try{await fn(...args);}catch(e){toast(e.message);}};}
let modalCallback;
function modal(title,description,fields,submit='Готово',callback){
  $('modal-title').textContent=title;$('modal-description').textContent=description;$('modal-error').textContent='';$('modal-submit').textContent=submit;
  $('modal-fields').innerHTML=fields.map(f=>`<label>${esc(f.label)}${f.options?`<select name="${esc(f.name)}">${f.options.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>`:`<input name="${esc(f.name)}" value="${esc(f.value||'')}" placeholder="${esc(f.placeholder||'')}" ${f.required===false?'':'required'} maxlength="${f.max||120}" ${f.readonly?'readonly':''}>`}</label>`).join('');
  modalCallback=callback;$('modal').showModal();$('modal-fields').querySelector('input')?.focus();
}
$('modal-close').onclick=()=>$('modal').close();
$('modal-form').onsubmit=async e=>{e.preventDefault();$('modal-submit').disabled=true;try{const values=Object.fromEntries(new FormData(e.target));await modalCallback(values);$('modal').close();}catch(e){$('modal-error').textContent=e.message;}finally{$('modal-submit').disabled=false;}};
$('auth-toggle').onclick=()=>{registration=!registration;$('display-field').hidden=!registration;$('auth-title').textContent=registration?'Найдите свой Круг.':'С возвращением.';$('auth-subtitle').textContent=registration?'Один аккаунт для всех ваших компаний.':'Ваш круг всегда рядом.';$('auth-submit').textContent=registration?'Создать аккаунт →':'Войти в Круг →';$('auth-toggle').textContent=registration?'Уже есть аккаунт? Войти':'Впервые здесь? Создать аккаунт';$('auth-form').elements.password.autocomplete=registration?'new-password':'current-password';$('auth-error').textContent='';};
$('auth-form').onsubmit=async e=>{e.preventDefault();$('auth-submit').disabled=true;$('auth-error').textContent='';try{await api(`/auth/${registration?'register':'login'}`,'POST',Object.fromEntries(new FormData(e.target)));await boot();}catch(e){$('auth-error').textContent=e.message;}finally{$('auth-submit').disabled=false;}};
async function boot(){
  state=await api('/state');$('auth').hidden=true;$('app').hidden=false;
  socket?.disconnect();socket=io({autoConnect:false});
  socket.on('connect',()=>{$('connection').textContent='● В сети';$('connection').classList.remove('offline');if(room){socket.emit('room:join',room.id);loadMessages().catch(e=>toast(e.message));}refreshState().catch(e=>toast(e.message));});
  socket.on('disconnect',()=>{$('connection').textContent='● Переподключение';$('connection').classList.add('offline');if(voiceRoom){leaveCall();toast('Соединение потеряно. Войдите в голосовой канал снова.');}});
  socket.on('connect_error',e=>{ $('connection').textContent='● Нет соединения';$('connection').classList.add('offline'); });
  socket.on('refresh',()=>refreshState().catch(e=>toast(e.message)));
  socket.on('message',m=>{if(m.room!==room?.id)return;if(search&&!m.body.toLowerCase().includes(search.toLowerCase()))return;if(!messages.some(x=>x.id===m.id))messages.push(m);renderMessages();scrollDown();});
  socket.on('message:update',m=>{if(m.room!==room?.id)return;messages=messages.map(x=>x.id===m.id?m:x);renderMessages();});
  socket.on('message:delete',m=>{if(m.room===room?.id){messages=messages.filter(x=>x.id!==m.id);renderMessages();}});
  socket.on('typing',({room:id,user})=>{if(id!==room?.id)return;clearTimeout(typingTimers.get(user.id));$('typing').textContent=`${user.display_name} печатает…`;typingTimers.set(user.id,setTimeout(()=>$('typing').textContent='',2000));});
  socket.on('voice:state',v=>{state.voice=v;renderChannels();renderCall();});
  socket.on('voice:signal',action(handleSignal));socket.on('voice:left',({socketId})=>{closePeer(socketId);renderCall();});socket.on('voice:kicked',()=>{leaveCall();toast('Вы отключены от голосового канала.');});
  socket.connect();render();
  const invite=new URLSearchParams(location.search).get('invite');if(invite){history.replaceState({},'',location.pathname);joinGuild(invite);}
}
async function refreshState(){const next=await api('/state');state=next;if(guildId&&!state.guilds.some(g=>g.id===guildId)){guildId=null;room=null;}if(room&&!state.guilds.some(g=>g.channels.some(c=>c.id===room.id))&&!state.dms.some(d=>d.id===room.id))room=null;render();}
function render(){
  $('self-name').textContent=state.user.display_name;$('self-handle').textContent=`@${state.user.username}`;$('self-avatar').textContent=initials(state.user.display_name);
  $('guild-list').innerHTML=state.guilds.map(g=>`<button class="guild-button ${g.id===guildId?'active':''}" data-guild="${g.id}" title="${esc(g.name)}">${esc(initials(g.name))}</button>`).join('');
  $('guild-list').querySelectorAll('[data-guild]').forEach(b=>b.onclick=()=>selectGuild(b.dataset.guild));
  renderChannels();renderRoom();renderMembers();
}
function currentGuild(){return state.guilds.find(g=>g.id===guildId);}
function renderChannels(){
  const g=currentGuild();$('server-title').textContent=g?.name||'Личные сообщения';$('invite').hidden=!g;$('new-dm').hidden=!!g;
  if(g){$('channel-list').innerHTML=['text','voice'].map(kind=>`<div class="category"><span>${kind==='text'?'ТЕКСТОВЫЕ КАНАЛЫ':'ГОЛОСОВЫЕ КАНАЛЫ'}</span>${g.owner_id===state.user.id?`<button data-add="${kind}" title="Добавить канал">+</button>`:''}</div>${g.channels.filter(c=>c.kind===kind).map(c=>`<button class="channel ${room?.id===c.id?'active':''}" data-room="${c.id}"><span>${kind==='text'?'#':'♫'}</span>${esc(c.name)}${voiceRoom===c.id?'<small>●</small>':''}</button>${kind==='voice'?(state.voice||[]).filter(v=>v.room===c.id).map(v=>`<div class="voice-user">${v.muted?'♩':'●'} ${esc(v.user.display_name)}</div>`).join(''):''}`).join('')}`).join('');}
  else $('channel-list').innerHTML=`<div class="category">ЛИЧНЫЕ СООБЩЕНИЯ</div>${state.dms.map(d=>`<button class="channel ${room?.id===d.id?'active':''}" data-room="${d.id}"><span>@</span>${esc(d.display_name)}</button>`).join('')}`;
  $('channel-list').querySelectorAll('[data-room]').forEach(b=>b.onclick=()=>selectRoom(b.dataset.room));$('channel-list').querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>addChannel(b.dataset.add));
}
async function selectGuild(id){guildId=id;const g=currentGuild();const first=g?.channels.find(c=>c.kind==='text')||g?.channels[0];if(first)await selectRoom(first.id);else{room=null;render();}}
async function selectRoom(id){
  room=state.guilds.flatMap(g=>g.channels).find(c=>c.id===id)||state.dms.find(d=>d.id===id);if(!room)return;
  if(!room.kind)room={...room,kind:'dm',name:room.display_name};guildId=room.guild_id||null;
  search='';$('search').value='';messages=[];pendingFile=null;renderAttachment();$('typing').textContent='';$('message-input').value='';$('app').classList.remove('show-sidebar');render();
  socket.emit('room:join',id);if(room.kind!=='voice')try{await loadMessages();}catch(e){toast(e.message);}
}
function renderRoom(){
  const voiceView=room?.kind==='voice'||(room?.kind==='dm'&&voiceRoom===room.id&&dmCallView);$('welcome').hidden=!!room;$('call-stage').hidden=!voiceView;$('chat').hidden=!room||voiceView;
  $('room-title').textContent=room?.name||'Добро пожаловать';$('room-symbol').textContent=voiceView?'♫':room?.kind==='dm'?'@':'#';$('room-description').textContent=voiceView?'Время быть на одной волне':'Место, где все свои';$('search-form').hidden=!room||voiceView;$('dm-call').hidden=room?.kind!=='dm';
  $('message-input').placeholder=`Написать ${room?.kind==='dm'?room.name:`в #${room?.name||''}`}…`;
  if(voiceView)renderCall();else if(room)renderMessages();
}
function renderMembers(){
  const g=currentGuild();const users=g?.members||[state.user,...state.dms.map(d=>({id:d.user_id,...d}))];const unique=[...new Map(users.map(u=>[u.id,u])).values()];
  $('members-title').textContent=g?`УЧАСТНИКИ — ${unique.length}`:'ВАШ КРУГ';$('members-invite').hidden=!g;
  $('member-list').innerHTML=unique.sort((a,b)=>Number(!!b.online)-Number(!!a.online)).map(u=>`<button class="member ${u.online||u.id===state.user.id?'online':''}" data-user="${esc(u.username)}"><span class="avatar">${esc(initials(u.display_name))}</span><span class="member-name">${esc(u.display_name)}<small>${u.id===g?.owner_id?'Владелец':`@${esc(u.username)}`}</small></span></button>`).join('');
  $('member-list').querySelectorAll('[data-user]').forEach(b=>b.onclick=()=>{if(b.dataset.user===state.user.username)return;if(g?.owner_id===state.user.id){modal(b.dataset.user,'Написать участнику или исключить его из сервера.',[{name:'action',label:'Действие',options:[{value:'dm',label:'Личное сообщение'},{value:'kick',label:'Исключить из сервера'}]}],'Продолжить',async v=>{if(v.action==='dm')await openDm(b.dataset.user);else{const u=g.members.find(u=>u.username===b.dataset.user);await api(`/guilds/${g.id}/members/${u.id}`,'DELETE');}});}else openDm(b.dataset.user).catch(e=>toast(e.message));});
}
function createGuild(){modal('Новый круг друзей','Создайте сервер для своей компании. Здесь будут ваши каналы и разговоры.',[{name:'name',label:'Название сервера',placeholder:'Например, Вечерняя пати',max:60}],'Создать сервер',async v=>{const g=await api('/guilds','POST',v);await refreshState();await selectGuild(g.id);});}
function joinGuild(code=''){modal('Присоединиться к своим','Вставьте ссылку или код приглашения. Приглашения действуют 7 дней.',[{name:'code',label:'Приглашение',value:code,placeholder:'Ссылка или код',max:300}],'Присоединиться',async v=>{let c=v.code.trim();try{c=new URL(c).searchParams.get('invite')||c;}catch{}const g=await api(`/invites/${encodeURIComponent(c)}`,'POST',{});await refreshState();await selectGuild(g.id);});}
async function invite(){const g=currentGuild();if(!g)return;const {code}=await api(`/guilds/${g.id}/invites`,'POST',{});const link=`${location.origin}/?invite=${code}`;modal('Вместе веселее','Отправьте эту ссылку друзьям. Она действует 7 дней.',[{name:'link',label:'Ссылка-приглашение',value:link,readonly:true,max:1000}],'Скопировать ссылку',async()=>{try{await navigator.clipboard.writeText(link);toast('Приглашение скопировано');}catch{throw new Error('Выделите и скопируйте ссылку вручную.');}});}
function addChannel(kind){modal('Ещё одно место для общения','Каналы помогают собрать разговоры по темам.',[{name:'name',label:'Название канала',max:50},{name:'kind',label:'Тип канала',options:(kind==='voice'?[{value:'voice',label:'Голосовой'},{value:'text',label:'Текстовый'}]:[{value:'text',label:'Текстовый'},{value:'voice',label:'Голосовой'}])}],'Создать канал',async v=>{const c=await api(`/guilds/${guildId}/channels`,'POST',v);await refreshState();await selectRoom(c.id);});}
async function openDm(username){const d=await api('/dms','POST',{username});await refreshState();await selectRoom(d.id);}
$('create-guild').onclick=createGuild;$('welcome-create').onclick=createGuild;$('join-guild').onclick=()=>joinGuild();$('welcome-join').onclick=()=>joinGuild();$('invite').onclick=action(invite);$('members-invite').onclick=action(invite);
$('home').onclick=()=>{guildId=null;room=null;generation++;render();};
$('new-dm').onclick=()=>modal('Написать другу','Укажите логин, который друг выбрал при регистрации.',[{name:'username',label:'Логин друга',placeholder:'alex',max:32}],'Открыть диалог',v=>openDm(v.username));
$('server-title').onclick=()=>{const g=currentGuild();if(g&&g.owner_id!==state.user.id)modal('Покинуть сервер',`Вы покинете «${g.name}». Для возвращения понадобится приглашение.`,[],'Покинуть',async()=>{await api(`/guilds/${g.id}/members/${state.user.id}`,'DELETE');await refreshState();});};
$('profile').onclick=()=>modal('Ваш профиль','Это имя видят ваши друзья.',[{name:'display_name',label:'Отображаемое имя',value:state.user.display_name,max:40}],'Сохранить',async v=>{await api('/profile','PATCH',v);await refreshState();});
$('logout').onclick=action(async()=>{await api('/logout','POST',{});leaveCall();socket.disconnect();state=null;room=null;guildId=null;$('app').hidden=true;$('auth').hidden=false;$('auth-form').reset();});
$('toggle-members').onclick=()=>$('app').classList.toggle('members-hidden');$('mobile-menu').onclick=()=>$('app').classList.toggle('show-sidebar');
async function loadMessages(before){if(!room||room.kind==='voice')return;const seq=++generation,id=room.id;const list=await api(`/rooms/${id}/messages?search=${encodeURIComponent(search)}${before?`&before=${before}`:''}`);if(seq!==generation||room?.id!==id)return;const oldHeight=$('messages').scrollHeight;messages=before?[...list,...messages]:list;renderMessages();$('load-older').hidden=list.length<50;if(before)$('messages').scrollTop=$('messages').scrollHeight-oldHeight;else scrollDown();}
function scrollDown(){$('messages').scrollTop=$('messages').scrollHeight;}
function formatBody(body){return esc(body).replace(/https?:\/\/[^\s<>]+/g,url=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);}
function renderMessages(){
  if(!room)return;
  $('message-list').innerHTML=`<div class="room-intro"><span>${room.kind==='dm'?'@':'#'}</span><h2>${esc(room.kind==='dm'?room.name:`Добро пожаловать в #${room.name}`)}</h2><p>${search?`Результаты поиска: ${esc(search)}`:room.kind==='dm'?'Начало вашего разговора.':'Здесь начинается история вашего канала.'}</p></div>${!messages.length?'<p class="empty-results">'+(search?'Ничего не найдено.':'Пока тихо. Начните разговор 👋')+'</p>':''}`+messages.map(m=>{
    const own=m.author_id===state.user.id;const canDelete=own||currentGuild()?.owner_id===state.user.id;
    const date=new Date(m.created.replace(' ','T')+'Z');const grouped={};for(const r of m.reactions){grouped[r.emoji]??=[];grouped[r.emoji].push(r.user_id);}
    return `<article class="message" data-id="${m.id}"><span class="avatar">${esc(initials(m.author.display_name))}</span><div class="message-content"><div class="message-meta"><strong>${esc(m.author.display_name)}</strong><time title="${esc(date.toLocaleString('ru'))}">${esc(date.toLocaleDateString('ru',{day:'numeric',month:'short'}))}, ${esc(date.toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'}))}${m.edited?' · изм.':''}</time></div><div class="message-body">${formatBody(m.body)}</div>${m.attachment?`<a class="file-link" href="/api/uploads/${m.attachment.id}" download>↧ ${esc(m.attachment.name)} <small>· ${Math.ceil(m.attachment.size/1024)} КБ</small></a>`:''}<div class="reactions">${Object.entries(grouped).map(([emoji,users])=>`<button class="reaction ${users.includes(state.user.id)?'mine':''}" data-react="${esc(emoji)}">${emoji} ${users.length}</button>`).join('')}</div></div><div class="message-tools"><button data-react="👍" title="Нравится">👍</button><button data-action="react" title="Другие реакции">☺</button>${own?'<button data-action="edit" title="Редактировать">✎</button>':''}${canDelete?'<button data-action="delete" title="Удалить">×</button>':''}</div></article>`;
  }).join('');
  $('message-list').querySelectorAll('[data-react]').forEach(b=>b.onclick=action(()=>api(`/messages/${b.closest('[data-id]').dataset.id}/reactions`,'POST',{emoji:b.dataset.react})));
  $('message-list').querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{const m=messages.find(x=>x.id===Number(b.closest('[data-id]').dataset.id));if(b.dataset.action==='edit')modal('Изменить сообщение','История сохранит пометку о редактировании.',[{name:'body',label:'Текст сообщения',value:m.body,max:4000}],'Сохранить',v=>api(`/messages/${m.id}`,'PATCH',v));if(b.dataset.action==='delete')modal('Удалить сообщение','Сообщение будет удалено для всех участников.',[],'Удалить',()=>api(`/messages/${m.id}`,'DELETE'));if(b.dataset.action==='react')modal('Добавить реакцию','Небольшой знак, что вы рядом.',[{name:'emoji',label:'Реакция',options:['👍','❤️','😂','🔥','🎉','👀'].map(e=>({value:e,label:e}))}],'Добавить',v=>api(`/messages/${m.id}/reactions`,'POST',v));});
}
$('load-older').onclick=action(()=>loadMessages(messages[0]?.id));$('search-form').onsubmit=action(async e=>{e.preventDefault();search=$('search').value.trim();await loadMessages();});$('search').onsearch=action(async()=>{search=$('search').value.trim();await loadMessages();});
function renderAttachment(){$('attachment').hidden=!pendingFile;$('attachment').textContent='';if(pendingFile){const span=document.createElement('span');span.textContent=`▣ ${pendingFile.name}`;const b=document.createElement('button');b.textContent='×';b.onclick=()=>{pendingFile=null;renderAttachment();};$('attachment').append(span,b);}}
$('attach').onclick=()=>$('file-input').click();$('file-input').onchange=action(async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;if(file.size>10*1024*1024)throw new Error('Максимальный размер файла — 10 МБ');const form=new FormData();form.append('file',file);const id=room?.id;$('attach').disabled=true;try{const f=await api('/uploads','POST',form);if(room?.id===id){pendingFile=f;renderAttachment();}}finally{$('attach').disabled=false;}});
$('composer').onsubmit=action(async e=>{e.preventDefault();const body=$('message-input').value.trim(),id=room?.id;if((!body&&!pendingFile)||!id)return;$('send').disabled=true;try{const m=await api(`/rooms/${id}/messages`,'POST',{body,attachment:pendingFile?.id});if(room?.id===id){if(!messages.some(x=>x.id===m.id))messages.push(m);$('message-input').value='';$('message-input').style.height='auto';pendingFile=null;renderAttachment();renderMessages();scrollDown();}}finally{$('send').disabled=false;}});
let lastTyping=0;$('message-input').oninput=()=>{const t=$('message-input');t.style.height='auto';t.style.height=`${Math.min(t.scrollHeight,140)}px`;if(room&&Date.now()-lastTyping>1200){socket.emit('typing',room.id);lastTyping=Date.now();}};
$('message-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('composer').requestSubmit();}};$('emoji').onclick=()=>{$('message-input').value+=' 👋';$('message-input').focus();};

// One initial offer from each newcomer; a reserved video transceiver permits
// switching camera/screen without renegotiation or simultaneous-offer glare.
async function startCall(id){
  if(joining)return;joining=true;$('join-call').disabled=true;
  try{
    if(voiceRoom===id)return;if(voiceRoom)leaveCall();
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Для микрофона откройте приложение через HTTPS или localhost.');
    rtcConfig=await api('/rtc');localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    const result=await socket.timeout(8000).emitWithAck('voice:join',id);if(result.error)throw new Error(result.error);
    voiceRoom=id;muted=false;deafened=false;
    for(const p of result.peers){const peer=createPeer(p.socketId);await peer.pc.setLocalDescription(await peer.pc.createOffer());signal(p.socketId,{description:peer.pc.localDescription});}
    renderCall();renderChannels();
  }catch(e){leaveCall();throw new Error(e.name==='NotAllowedError'?'Разрешите браузеру доступ к микрофону в настройках сайта.':e.message);}
  finally{joining=false;$('join-call').disabled=false;}
}
function signal(to,payload){socket.emit('voice:signal',{to,...payload},r=>{if(r?.error)toast(r.error);});}
function createPeer(id){
  if(peers.has(id))return peers.get(id);
  const pc=new RTCPeerConnection(rtcConfig);const stream=new MediaStream();
  localStream.getAudioTracks().forEach(t=>pc.addTrack(t,localStream));
  const video=pc.addTransceiver('video',{direction:'sendrecv'});if(videoStream)video.sender.replaceTrack(videoStream.getVideoTracks()[0]);
  const audio=document.createElement('audio');audio.autoplay=true;audio.srcObject=stream;audio.muted=deafened;document.body.append(audio);
  const p={pc,stream,audio,videoSender:video.sender,candidates:[]};peers.set(id,p);
  pc.onicecandidate=e=>{if(e.candidate)signal(id,{candidate:e.candidate});};
  pc.ontrack=e=>{stream.addTrack(e.track);audio.play().catch(()=>toast('Нажмите кнопку звука, чтобы разрешить воспроизведение.'));e.track.onunmute=()=>renderCall();e.track.onmute=()=>renderCall();e.track.onended=()=>renderCall();renderCall();};
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed')toast('Не удалось соединиться с участником. Для разных сетей настройте TURN (см. инструкцию).');renderCall();};return p;
}
async function handleSignal({from,description,candidate}){
  if(!localStream)return;const p=createPeer(from);
  if(description){await p.pc.setRemoteDescription(description);for(const c of p.candidates)await p.pc.addIceCandidate(c);p.candidates=[];if(description.type==='offer'){await p.pc.setLocalDescription(await p.pc.createAnswer());signal(from,{description:p.pc.localDescription});}}
  if(candidate){if(p.pc.remoteDescription)await p.pc.addIceCandidate(candidate);else p.candidates.push(candidate);}
}
function closePeer(id){const p=peers.get(id);if(p){p.pc.close();p.audio.srcObject=null;p.audio.remove();peers.delete(id);}}
function leaveCall(){socket?.emit('voice:leave');for(const id of [...peers.keys()])closePeer(id);localStream?.getTracks().forEach(t=>t.stop());videoStream?.getTracks().forEach(t=>t.stop());localStream=null;videoStream=null;videoMode=null;voiceRoom=null;muted=false;deafened=false;dmCallView=false;renderCall();}
function renderCall(){
  $('voice-status').hidden=!voiceRoom;const vc=state?.guilds.flatMap(g=>g.channels).find(c=>c.id===voiceRoom)||state?.dms.find(d=>d.id===voiceRoom);
  $('voice-label').textContent=vc?.name||vc?.display_name||'Личный звонок';$('mute').textContent=muted?'Микрофон выкл.':'Микрофон вкл.';$('deafen').textContent=deafened?'Звук выкл.':'Звук вкл.';
  const active=voiceRoom===room?.id;$('join-call').hidden=active;$('camera').hidden=!active;$('screen').hidden=!active;$('camera').textContent=videoMode==='camera'?'Выключить камеру':'Включить камеру';$('screen').textContent=videoMode==='screen'?'Остановить показ':'Показать экран';$('call-title').textContent=room?.name||'Разговор';
  const grid=$('video-grid');const participants=(state?.voice||[]).filter(v=>v.room===room?.id);
  // Preserve existing media elements: rebuilding them on every presence event
  // would interrupt playback and create overlapping audio.
  const ids=new Set(participants.map(v=>v.socketId));for(const tile of [...grid.children])if(!ids.has(tile.dataset.peer))tile.remove();
  for(const v of participants){
    let tile=[...grid.children].find(t=>t.dataset.peer===v.socketId);if(!tile){tile=document.createElement('div');tile.className='video-tile';tile.dataset.peer=v.socketId;const avatar=document.createElement('span');avatar.className='avatar';const media=document.createElement('video');media.autoplay=true;media.playsInline=true;const label=document.createElement('span');label.className='video-name';tile.append(avatar,media,label);grid.append(tile);}
    tile.querySelector('.avatar').textContent=initials(v.user.display_name);const self=v.socketId===socket?.id;const stream=self?videoStream:peers.get(v.socketId)?.stream;const video=tile.querySelector('video');if(video.srcObject!==stream)video.srcObject=stream||null;video.muted=true;
    const hasVideo=stream?.getVideoTracks().some(t=>t.readyState==='live'&&!t.muted);video.style.opacity=hasVideo?'1':'0';tile.querySelector('.video-name').textContent=`${v.user.display_name}${self?' (вы)':''}${v.muted?' · микрофон выкл.':''}`;
    if(stream)video.play().catch(()=>{});
  }
}
async function setVideo(mode){
  if(!voiceRoom)return;
  if(videoMode===mode){await stopVideo();return;}
  if(mode==='screen'&&!navigator.mediaDevices.getDisplayMedia)throw new Error('Показ экрана не поддерживается этим браузером.');
  const stream=mode==='screen'?await navigator.mediaDevices.getDisplayMedia({video:true,audio:false}):await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720}},audio:false});
  const previous=videoStream;const track=stream.getVideoTracks()[0];
  try{await Promise.all([...peers.values()].map(p=>p.videoSender.replaceTrack(track)));}catch(e){stream.getTracks().forEach(t=>t.stop());throw e;}
  videoStream=stream;videoMode=mode;previous?.getTracks().forEach(t=>t.stop());track.onended=()=>{if(videoStream===stream)stopVideo().catch(e=>toast(e.message));};renderCall();
}
async function stopVideo(){await Promise.all([...peers.values()].map(p=>p.videoSender.replaceTrack(null)));videoStream?.getTracks().forEach(t=>t.stop());videoStream=null;videoMode=null;renderCall();}
$('join-call').onclick=action(()=>startCall(room.id));$('dm-call').onclick=action(async()=>{await startCall(room.id);dmCallView=!dmCallView;renderRoom();});$('hangup').onclick=()=>{leaveCall();renderRoom();};$('mute').onclick=()=>{muted=!muted;localStream?.getAudioTracks().forEach(t=>t.enabled=!muted);socket.emit('voice:mute',muted);renderCall();};$('deafen').onclick=()=>{deafened=!deafened;for(const p of peers.values()){p.audio.muted=deafened;if(!deafened)p.audio.play().catch(()=>{});}renderCall();};$('camera').onclick=action(()=>setVideo('camera'));$('screen').onclick=action(()=>setVideo('screen'));
$('voice-label').onclick=action(async()=>{if(!voiceRoom)return;await selectRoom(voiceRoom);if(room.kind==='dm'){dmCallView=true;renderRoom();}});
window.addEventListener('beforeunload',()=>{localStream?.getTracks().forEach(t=>t.stop());videoStream?.getTracks().forEach(t=>t.stop());});
boot().catch(e=>{if(e.message!=='Войдите в аккаунт')toast(e.message);});
