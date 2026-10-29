import { X509Certificate, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const domain = 'chat-circle.ru';
const issued = path.resolve(process.argv[2] || 'D:\\KrugTLS\\issued');
const output = path.resolve(process.argv[3] || 'D:\\KrugTLS\\out');
const openssl = process.env.KRUG_OPENSSL || 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
let stage, encrypted;
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)}: код завершения ${code}`)));
});
try {
  if (!existsSync(openssl)) throw new Error('OpenSSL не найден. Нужен OpenSSL из Git for Windows или переменная KRUG_OPENSSL с путём к нему.');
  const chainPath = path.join(issued, `${domain}-chain.pem`);
  const keyPath = path.join(issued, `${domain}-key.pem`);
  const cert = new X509Certificate(readFileSync(chainPath));
  if (!cert.checkHost(domain)) throw new Error('Сертификат выдан для другого домена.');
  if (Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now()) throw new Error('Срок сертификата ещё не начался или уже истёк.');
  const key = createPrivateKey(readFileSync(keyPath));
  const pub = k => k.export({ format: 'der', type: 'spki' });
  if (!pub(cert.publicKey).equals(pub(createPublicKey(key)))) throw new Error('Приватный ключ не соответствует сертификату.');
  mkdirSync(output, { recursive: true });
  stage = mkdtempSync(path.join(output, 'pack-'));
  copyFileSync(chainPath, path.join(stage, 'fullchain.pem'));
  copyFileSync(keyPath, path.join(stage, 'privkey.pem'));
  const installer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-manual-tls.sh');
  copyFileSync(installer, path.join(stage, 'install-manual-tls.sh'));
  const archive = path.join(stage, 'certs.tgz');
  await run('tar.exe', ['-czf', archive, '-C', stage, 'fullchain.pem', 'privkey.pem', 'install-manual-tls.sh']);
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  encrypted = path.join(output, `krug-certs-${suffix}.enc`);
  console.log('OpenSSL сейчас дважды запросит пароль. Используйте новый длинный пароль и сохраните его у себя.');
  await run(openssl, ['enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000', '-in', archive, '-out', encrypted]);
  const digest = createHash('sha256').update(readFileSync(encrypted)).digest('hex');
  writeFileSync(`${encrypted}.sha256.txt`, `${digest}  ${path.basename(encrypted)}\n`);
  console.log(`\nСертификат действителен до: ${cert.validTo}\nГотовый зашифрованный файл: ${encrypted}\nSHA-256: ${digest}`);
  console.log('На VPS сверьте SHA-256 до расшифровки. Загружайте в облако только .enc; пароль и исходные PEM не публикуйте.');
  encrypted = undefined; // Successful package is kept; partial output is removed on errors.
} catch (e) {
  console.error(`Ошибка: ${e.message}`);
  if (encrypted && path.dirname(encrypted) === output) rmSync(encrypted, { force: true });
  process.exitCode = 1;
} finally {
  if (stage && path.dirname(stage) === output && path.basename(stage).startsWith('pack-')) rmSync(stage, { recursive: true, force: true });
}
