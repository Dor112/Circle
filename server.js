import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
mkdirSync(path.join(data, 'uploads'), { recursive: true });
const db = new DatabaseSync(path.join(data, 'krug.sqlite'));
db.function('fold', { deterministic: true }, value => String(value ?? '').normalize('NFKC').toLowerCase());
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT, password TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, expires INTEGER);
CREATE TABLE IF NOT EXISTS guilds(id TEXT PRIMARY KEY, name TEXT, owner_id TEXT REFERENCES users(id));
CREATE TABLE IF NOT EXISTS members(guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id), PRIMARY KEY(guild_id,user_id));
CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE, name TEXT, kind TEXT CHECK(kind IN ('text','voice')));
CREATE TABLE IF NOT EXISTS invites(code TEXT PRIMARY KEY, guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE, expires INTEGER);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, a TEXT REFERENCES users(id), b TEXT REFERENCES users(id), UNIQUE(a,b));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, author_id TEXT REFERENCES users(id), body TEXT, attachment TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP, edited INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS message_room ON messages(room,id);
CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), name TEXT, size INTEGER);
CREATE TABLE IF NOT EXISTS reactions(message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id), emoji TEXT, PRIMARY KEY(message_id,user_id,emoji));`);
const get = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const transaction = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const str = (v, min = 1, max = 80) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : fail(400, `Нужно от ${min} до ${max} символов`);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const publicUser = u => ({ id: u.id, username: u.username, display_name: u.display_name });
const cookieToken = req => { try { return decodeURIComponent((req.headers.cookie || '').split(';').find(x => x.trim().startsWith('krug='))?.trim().slice(5) || ''); } catch { return ''; } };
function session(req) { return get('SELECT u.*,s.token AS session_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', hashToken(cookieToken(req)), Date.now()); }
function member(uid, gid) { return !!get('SELECT 1 FROM members WHERE user_id=? AND guild_id=?', uid, gid); }
function roomAccess(uid, id) {
  const c = get('SELECT * FROM channels WHERE id=?', id);
  if (c) return member(uid, c.guild_id) ? c : null;
  return get('SELECT *,\'dm\' AS kind FROM conversations WHERE id=? AND (a=? OR b=?)', id, uid, uid);
}
function owner(uid, gid) { if (!get('SELECT 1 FROM guilds WHERE id=? AND owner_id=?', gid, uid)) fail(403, 'Нужны права владельца сервера'); }
const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req,res,next) => {
  res.set({ 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin', 'X-Frame-Options':'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`)) return res.status(403).json({ error:'Недопустимый источник запроса' });
  next();
});
app.use(express.json({ limit:'32kb' }));
const http = createServer(app);
const io = new Server(http, { maxHttpBufferSize: 100_000, allowRequest: (req, cb) => {
  const expected = process.env.PUBLIC_URL || `http://${req.headers.host}`;
  cb(null, !req.headers.origin || req.headers.origin === expected);
} });
const rates = new Map();
function limited(key, max, period) { const now=Date.now(); let r=rates.get(key); if (!r || r.end<now) {r={count:0,end:now+period};rates.set(key,r);} if (++r.count>max) fail(429,'Слишком много запросов. Попробуйте позже.'); }
const cleanup = setInterval(() => { for (const [k,v] of rates) if(v.end<Date.now()) rates.delete(k); run('DELETE FROM sessions WHERE expires<?',Date.now()); run('DELETE FROM invites WHERE expires<?',Date.now()); },60_000); cleanup.unref();
app.use('/api', (req,res,next)=>{try{limited(`http:${req.ip}`,600,60_000);next();}catch(e){next(e);}});
function login(res, uid) {
  const token=randomBytes(32).toString('hex');
  run('INSERT INTO sessions VALUES(?,?,?)',hashToken(token),uid,Date.now()+30*86400_000);
  res.cookie('krug',token,{ httpOnly:true, sameSite:'strict', secure:process.env.COOKIE_SECURE==='1', maxAge:30*86400_000, path:'/' });
}
app.get('/api/health', (req,res)=>res.json({ok:true}));
app.post('/api/auth/:action', async (req,res,next)=>{try{
  limited(`auth:${req.ip}`,20,15*60_000);
  const username=str(req.body.username,3,32).toLowerCase();
  if(!/^[a-z0-9_]+$/.test(username)) fail(400,'Логин: латинские буквы, цифры и _');
  const password=req.body.password;
  if(typeof password!=='string'||password.length<10||password.length>128)fail(400,'Пароль должен содержать от 10 до 128 символов');
  if(req.params.action==='register') {
    if(process.env.ALLOW_REGISTRATION==='0') fail(403,'Регистрация закрыта');
    if(get('SELECT 1 FROM users WHERE username=?',username)) fail(409,'Логин уже занят');
    const salt=randomBytes(16).toString('hex'), derived=await promisify(scrypt)(password,salt,64);
    const uid=randomUUID();
    try{run('INSERT INTO users(id,username,display_name,password) VALUES(?,?,?,?)',uid,username,str(req.body.display_name || username,1,40),`${salt}:${derived.toString('hex')}`);}catch(e){if(String(e).includes('UNIQUE'))fail(409,'Логин уже занят');throw e;}
    login(res,uid); return res.json(publicUser(get('SELECT * FROM users WHERE id=?',uid)));
  }
  if(req.params.action!=='login') fail(404,'Не найдено');
  const u=get('SELECT * FROM users WHERE username=?',username);
  const [salt,expected]=(u?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const actual=await promisify(scrypt)(password,salt,64);
  if(!u || !timingSafeEqual(actual,Buffer.from(expected,'hex'))) fail(401,'Неверный логин или пароль');
  login(res,u.id);res.json(publicUser(u));
}catch(e){next(e);}});
app.use('/api',(req,res,next)=>{req.user=session(req);if(!req.user)return res.status(401).json({error:'Войдите в аккаунт'});next();});
app.post('/api/logout',(req,res)=>{run('DELETE FROM sessions WHERE token=?',req.user.session_token);for(const s of io.sockets.sockets.values())if(s.sessionToken===req.user.session_token)s.disconnect(true);res.clearCookie('krug',{path:'/'}).json({ok:true});});
const online = new Map();
const voice = new Map();
function state(uid) {
  const guilds=all('SELECT g.* FROM guilds g JOIN members m ON m.guild_id=g.id WHERE m.user_id=?',uid).map(g=>({...g,channels:all('SELECT * FROM channels WHERE guild_id=? ORDER BY rowid',g.id),members:all('SELECT u.id,u.username,u.display_name FROM users u JOIN members m ON m.user_id=u.id WHERE m.guild_id=?',g.id).map(u=>({...u,online:online.has(u.id)}))}));
  const dms=all('SELECT c.id,u.id AS user_id,u.username,u.display_name FROM conversations c JOIN users u ON u.id=CASE WHEN c.a=? THEN c.b ELSE c.a END WHERE c.a=? OR c.b=?',uid,uid,uid);
  return {user:publicUser(get('SELECT * FROM users WHERE id=?',uid)),guilds,dms,voice:[...voice].filter(([,v])=>roomAccess(uid,v.room)).map(([id,v])=>({socketId:id,...v}))};
}
app.get('/api/state',(req,res)=>res.json(state(req.user.id)));
function refresh(uid) {io.to(`user:${uid}`).emit('refresh');}
function refreshGuild(gid) {for(const m of all('SELECT user_id FROM members WHERE guild_id=?',gid))refresh(m.user_id);}
app.patch('/api/profile',(req,res)=>{run('UPDATE users SET display_name=? WHERE id=?',str(req.body.display_name,1,40),req.user.id);for(const m of all('SELECT guild_id FROM members WHERE user_id=?',req.user.id))refreshGuild(m.guild_id);refresh(req.user.id);res.json({ok:true});});
app.post('/api/guilds',(req,res)=>{
  const gid=randomUUID(), uid=req.user.id; const name=str(req.body.name,1,60);
  transaction(()=>{run('INSERT INTO guilds VALUES(?,?,?)',gid,name,uid);run('INSERT INTO members VALUES(?,?)',gid,uid);run('INSERT INTO channels VALUES(?,?,?,?)',randomUUID(),gid,'общий','text');run('INSERT INTO channels VALUES(?,?,?,?)',randomUUID(),gid,'Гостиная','voice');});
  refresh(uid);res.json({id:gid});
});
app.post('/api/guilds/:id/channels',(req,res)=>{owner(req.user.id,req.params.id);const name=str(req.body.name,1,50);if(!['text','voice'].includes(req.body.kind))fail(400,'Неверный тип канала');const id=randomUUID();run('INSERT INTO channels VALUES(?,?,?,?)',id,req.params.id,name,req.body.kind);refreshGuild(req.params.id);res.json({id});});
app.post('/api/guilds/:id/invites',(req,res)=>{if(!member(req.user.id,req.params.id))fail(403,'Нет доступа');const code=randomBytes(12).toString('hex');run('INSERT INTO invites VALUES(?,?,?)',code,req.params.id,Date.now()+7*86400_000);res.json({code});});
app.post('/api/invites/:code',(req,res)=>{const inv=get('SELECT * FROM invites WHERE code=? AND expires>?',req.params.code,Date.now());if(!inv)fail(404,'Приглашение истекло или не существует');run('INSERT OR IGNORE INTO members VALUES(?,?)',inv.guild_id,req.user.id);refreshGuild(inv.guild_id);res.json({id:inv.guild_id});});
app.delete('/api/guilds/:gid/members/:uid',(req,res)=>{
  const {gid,uid}=req.params; const g=get('SELECT * FROM guilds WHERE id=?',gid);if(!g)fail(404,'Сервер не найден');if(uid!==req.user.id)owner(req.user.id,gid);if(g.owner_id===uid)fail(400,'Владелец не может покинуть свой сервер');
  run('DELETE FROM members WHERE guild_id=? AND user_id=?',gid,uid);
  for(const s of io.sockets.sockets.values())if(s.user.id===uid){for(const room of s.rooms)if(get('SELECT 1 FROM channels WHERE id=? AND guild_id=?',room,gid))s.leave(room);if(voice.get(s.id)&&get('SELECT 1 FROM channels WHERE id=? AND guild_id=?',voice.get(s.id).room,gid)){leaveVoice(s);s.emit('voice:kicked');}}
  refresh(uid);refreshGuild(gid);res.json({ok:true});
});
app.post('/api/dms',(req,res)=>{const u=get('SELECT * FROM users WHERE username=?',str(req.body.username,3,32));if(!u)fail(404,'Пользователь не найден');if(u.id===req.user.id)fail(400,'Укажите логин друга');const [a,b]=[req.user.id,u.id].sort();run('INSERT OR IGNORE INTO conversations VALUES(?,?,?)',randomUUID(),a,b);const c=get('SELECT * FROM conversations WHERE a=? AND b=?',a,b);refresh(a);refresh(b);res.json({id:c.id});});
function message(row) {return {...row,author:publicUser(get('SELECT * FROM users WHERE id=?',row.author_id)),attachment:row.attachment?get('SELECT id,name,size FROM uploads WHERE id=?',row.attachment):null,reactions:all('SELECT emoji,user_id FROM reactions WHERE message_id=?',row.id)};}
app.get('/api/rooms/:id/messages',(req,res)=>{if(!roomAccess(req.user.id,req.params.id))fail(403,'Нет доступа');const before=Number(req.query.before)||Number.MAX_SAFE_INTEGER;const search=String(req.query.search||'').slice(0,100);res.json(all('SELECT * FROM messages WHERE room=? AND id<? AND instr(fold(body),fold(?))>0 ORDER BY id DESC LIMIT 50',req.params.id,before,search).reverse().map(message));});
app.post('/api/rooms/:id/messages',(req,res)=>{
  const c=roomAccess(req.user.id,req.params.id);if(!c)fail(403,'Нет доступа');if(c.kind==='voice')fail(400,'Выберите текстовый канал');limited(`msg:${req.user.id}`,40,10_000);
  const body=req.body.body?str(req.body.body,1,4000):'';const attachment=req.body.attachment || null;
  if(!body&&!attachment)fail(400,'Пустое сообщение');if(attachment&&!get('SELECT 1 FROM uploads WHERE id=? AND owner_id=?',attachment,req.user.id))fail(403,'Нет доступа к файлу');
  const result=run('INSERT INTO messages(room,author_id,body,attachment) VALUES(?,?,?,?)',req.params.id,req.user.id,body,attachment);
  const m=message(get('SELECT * FROM messages WHERE id=?',Number(result.lastInsertRowid)));io.to(req.params.id).emit('message',m);res.json(m);
});
app.patch('/api/messages/:id',(req,res)=>{const m=get('SELECT * FROM messages WHERE id=?',req.params.id);if(!m||m.author_id!==req.user.id||!roomAccess(req.user.id,m.room))fail(403,'Нет доступа');run('UPDATE messages SET body=?,edited=1 WHERE id=?',str(req.body.body,1,4000),m.id);io.to(m.room).emit('message:update',message(get('SELECT * FROM messages WHERE id=?',m.id)));res.json({ok:true});});
app.delete('/api/messages/:id',(req,res)=>{const m=get('SELECT * FROM messages WHERE id=?',req.params.id);if(!m||!roomAccess(req.user.id,m.room))fail(403,'Нет доступа');if(m.author_id!==req.user.id){const c=get('SELECT * FROM channels WHERE id=?',m.room);if(!c)fail(403,'Нет доступа');owner(req.user.id,c.guild_id);}run('DELETE FROM messages WHERE id=?',m.id);io.to(m.room).emit('message:delete',{id:m.id,room:m.room});res.json({ok:true});});
app.post('/api/messages/:id/reactions',(req,res)=>{const m=get('SELECT * FROM messages WHERE id=?',req.params.id);if(!m||!roomAccess(req.user.id,m.room))fail(403,'Нет доступа');const emoji=str(req.body.emoji,1,12);if(!['👍','❤️','😂','🔥','🎉','👀'].includes(emoji))fail(400,'Неизвестная реакция');if(get('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?',m.id,req.user.id,emoji))run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?',m.id,req.user.id,emoji);else run('INSERT INTO reactions VALUES(?,?,?)',m.id,req.user.id,emoji);io.to(m.room).emit('message:update',message(m));res.json({ok:true});});
const upload=multer({storage:multer.diskStorage({destination:path.join(data,'uploads'),filename:(req,file,cb)=>cb(null,randomUUID())}),limits:{fileSize:10*1024*1024,files:1}});
app.post('/api/uploads',(req,res,next)=>{limited(`upload:${req.user.id}`,20,60_000);next();},upload.single('file'),(req,res)=>{if(!req.file)fail(400,'Выберите файл');const f=req.file;run('INSERT INTO uploads VALUES(?,?,?,?)',f.filename,req.user.id,path.basename(f.originalname).slice(0,180),f.size);res.json({id:f.filename,name:f.originalname,size:f.size});});
app.get('/api/uploads/:id',(req,res)=>{const f=get('SELECT * FROM uploads WHERE id=?',req.params.id);if(!f)fail(404,'Файл не найден');if(f.owner_id!==req.user.id&&!all('SELECT room FROM messages WHERE attachment=?',f.id).some(m=>roomAccess(req.user.id,m.room)))fail(403,'Нет доступа');res.set('Content-Security-Policy',"default-src 'none'; sandbox");res.download(path.join(data,'uploads',f.id),f.name);});
app.get('/api/rtc',(req,res)=>{const iceServers=[{urls:process.env.STUN_URL || 'stun:stun.l.google.com:19302'}];if(process.env.TURN_URL){const username=`${Math.floor(Date.now()/1000)+86400}:${req.user.id}`;const credential=process.env.TURN_SECRET?createHmac('sha1',process.env.TURN_SECRET).update(username).digest('base64'):process.env.TURN_PASSWORD;iceServers.push({urls:process.env.TURN_URL.split(','),username:process.env.TURN_SECRET?username:process.env.TURN_USERNAME,credential});}res.json({iceServers});});
function emitVoice() {for(const s of io.sockets.sockets.values())s.emit('voice:state',[...voice].filter(([,v])=>roomAccess(s.user.id,v.room)).map(([socketId,v])=>({socketId,...v})));}
function leaveVoice(s) {const v=voice.get(s.id);if(v){voice.delete(s.id);s.to(`voice:${v.room}`).emit('voice:left',{socketId:s.id});s.leave(`voice:${v.room}`);emitVoice();}}
io.use((s,next)=>{const u=session(s.request);if(!u)return next(new Error('Войдите в аккаунт'));s.user=publicUser(u);s.sessionToken=u.session_token;next();});
io.on('connection',s=>{
  const uid=s.user.id; s.join(`user:${uid}`);online.set(uid,(online.get(uid)||0)+1);
  for(const m of all('SELECT guild_id FROM members WHERE user_id=?',uid))refreshGuild(m.guild_id);
  const guard=fn=>(payload,ack=()=>{})=>{try{if(!get('SELECT 1 FROM sessions WHERE token=? AND expires>?',s.sessionToken,Date.now())){s.disconnect(true);return;}limited(`ws:${s.id}`,180,10_000);fn(payload,ack);}catch(e){ack({error:e.status?e.message:'Ошибка события'});}};
  s.on('room:join',guard((id,ack)=>{if(!roomAccess(uid,id))fail(403,'Нет доступа');for(const r of s.rooms)if(!r.startsWith('user:')&&!r.startsWith('voice:')&&r!==s.id)s.leave(r);s.join(id);ack({ok:true});}));
  s.on('typing',guard(id=>{if(roomAccess(uid,id))s.to(id).emit('typing',{room:id,user:s.user});}));
  s.on('voice:join',guard((room,ack)=>{
    const c=roomAccess(uid,room);if(!c||c.kind==='text')fail(403,'Голосовой канал недоступен');
    if([...voice.values()].filter(v=>v.room===room).length>=8)fail(400,'В голосовом канале уже 8 участников');
    for(const [sid,v] of voice)if(v.user.id===uid){const old=io.sockets.sockets.get(sid);leaveVoice(old);old.emit('voice:kicked');}
    leaveVoice(s);const peers=[...voice].filter(([,v])=>v.room===room).map(([socketId,v])=>({socketId,...v}));voice.set(s.id,{room,user:s.user,muted:false});s.join(`voice:${room}`);ack({peers});emitVoice();
  }));
  s.on('voice:signal',guard(({to,description,candidate},ack)=>{const a=voice.get(s.id),b=voice.get(to);if(!a||!b||a.room!==b.room||!roomAccess(uid,a.room))fail(403,'Нет доступа');io.to(to).emit('voice:signal',{from:s.id,description,candidate});ack({ok:true});}));
  s.on('voice:mute',guard(value=>{if(voice.has(s.id)){voice.get(s.id).muted=!!value;emitVoice();}}));
  s.on('voice:leave',()=>leaveVoice(s));
  s.on('disconnect',()=>{leaveVoice(s);const n=(online.get(uid)||1)-1;if(n)online.set(uid,n);else online.delete(uid);for(const m of all('SELECT guild_id FROM members WHERE user_id=?',uid))refreshGuild(m.guild_id);});
});
app.use('/api',(req,res)=>res.status(404).json({error:'Маршрут не найден'}));
app.use(express.static(path.join(root,'public')));
app.use((err,req,res,next)=>{if(!err.status&&!(err instanceof multer.MulterError))console.error(err);res.status(err.status || (err instanceof multer.MulterError?400:500)).json({error:err.status?err.message:err instanceof multer.MulterError?'Файл слишком большой (максимум 10 МБ)':'Ошибка сервера'});});
const port=Number(process.env.PORT || 3000);
http.listen(port,process.env.HOST || '0.0.0.0',()=>console.log(`Круг: http://localhost:${http.address().port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{io.close();http.close(()=>{db.close();process.exit(0);});});
