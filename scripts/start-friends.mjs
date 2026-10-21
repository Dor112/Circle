import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateServe, serverEnv } from './tailscale-config.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
const cli = existsSync(installed) ? installed : 'tailscale';
let app, stopping = false;
async function tailscale(args, timeout = 15000) {
  try { return await exec(cli, args, { timeout, windowsHide:true, maxBuffer:2*1024*1024 }); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error('Установите Tailscale: https://tailscale.com/download/windows . Затем войдите в аккаунт и повторите запуск.');
    throw new Error([e.stderr, e.stdout].filter(Boolean).join('\n') || 'Tailscale не отвечает. Запустите клиент и войдите в аккаунт.');
  }
}
function availablePort() {
  return new Promise((resolve,reject) => {
    const probe=createServer();
    probe.once('error',()=>reject(new Error('Порт 3000 уже занят. Остановите прежний Круг (Ctrl+C в его окне), затем снова запустите start-friends.cmd.')));
    probe.listen(3000,'127.0.0.1',()=>probe.close(resolve));
  });
}
function stop(code = 0) {
  if(stopping)return;stopping=true;
  app?.kill();
  console.log('\nКруг остановлен. HTTPS-прокси Tailscale остаётся настроен, но приложение недоступно.');
  console.log(`Для удаления этого прокси: "${cli}" serve --https=443 off`);
  process.exitCode=code;
}
try {
  const {stdout}=await tailscale(['status','--json']);
  const status=JSON.parse(stdout);
  if(status.BackendState!=='Running')throw new Error('Сначала откройте Tailscale и войдите в аккаунт (Log in). Затем запустите start-friends.cmd снова.');
  const hostname=(status.Self?.DNSName || '').replace(/\.$/,'');
  const env=serverEnv(process.env,hostname);
  const config=JSON.parse((await tailscale(['serve','status','--json'])).stdout || '{}');
  validateServe(config,hostname);
  await availablePort();
  if(process.argv.includes('--check')) {
    console.log(`Готово к запуску: ${env.PUBLIC_URL}\nВход в Tailscale выполнен, порт свободен, настройки совместимы.`);
  } else {
    console.log('Запускаю Круг для закрытого теста. Не закрывайте это окно.');
    app=spawn(process.execPath,['--env-file-if-exists=.env','server.js'],{cwd:root,env,stdio:['inherit','pipe','pipe'],windowsHide:true});
    app.stderr.on('data',b=>process.stderr.write(b));
    const ready = new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Сервер не запустился за 15 секунд.')),15000);
      app.once('error',e=>{clearTimeout(timer);reject(e);});
      app.once('exit',code=>{clearTimeout(timer);reject(new Error(`Сервер завершился: ${code}`));});
      app.stdout.on('data',b=>{process.stdout.write(b);if(String(b).includes('Круг: http://localhost:')){clearTimeout(timer);resolve();}});
    });
    await ready;
    try {
      const result=await tailscale(['serve','--bg','--https=443','http://127.0.0.1:3000'],60000);
      if(result.stdout)console.log(result.stdout);
      if(result.stderr)console.log(result.stderr);
      const actual=JSON.parse((await tailscale(['serve','status','--json'])).stdout || '{}');
      validateServe(actual,hostname);
      if(actual.Web?.[`${hostname}:443`]?.Handlers?.['/']?.Proxy!=='http://127.0.0.1:3000')throw new Error('HTTPS-прокси ещё не включён. Выполните tailscale serve 3000 вручную, подтвердите HTTPS по показанной ссылке и повторите запуск.');
    } catch(e) {throw new Error(`Не удалось включить HTTPS. При запросе разрешений запустите этот файл от имени администратора.\n${e.message}`);}
    console.log(`\nВАША ССЫЛКА: ${env.PUBLIC_URL}`);
    console.log('Вы и друзья открываете именно HTTPS-ссылку. У всех должен быть включён Tailscale в общей сети.');
    console.log('Далее создайте сервер в Круге и отправьте приглашение. Остановка: Ctrl+C.\n');
    process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
    app.once('exit',code=>{if(!stopping)stop(code || 1);});
  }
} catch(e) { console.error(`\n${e.message}`);app?.kill();process.exitCode=1; }
