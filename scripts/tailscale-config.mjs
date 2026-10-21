// Refuse to overwrite another app's Serve setup or reuse a public Funnel.
export function validateServe(config, hostname) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Не удалось прочитать настройки Tailscale Serve.');
  if (Object.values(config.AllowFunnel || {}).some(Boolean)) throw new Error('На ПК включён публичный Tailscale Funnel. Сначала отключите его для этого адреса: нужен закрытый Serve.');
  const tcp = Object.entries(config.TCP || {});
  const web = Object.entries(config.Web || {});
  if (!tcp.length && !web.length && !Object.keys(config.Services || {}).length) return;
  const handler = config.Web?.[`${hostname}:443`]?.Handlers;
  if (tcp.length === 1 && tcp[0][0] === '443' && tcp[0][1].HTTPS === true && web.length === 1 && handler && Object.keys(handler).length === 1 && handler['/']?.Proxy === 'http://127.0.0.1:3000' && !Object.keys(config.Services || {}).length) return;
  throw new Error('Tailscale Serve уже настроен для другого сервиса. Настройки сохранены; используйте отдельный ПК или настройте прокси вручную.');
}
export function serverEnv(env, hostname) {
  if (!/^[a-z0-9][a-z0-9.-]*\.ts\.net$/i.test(hostname)) throw new Error('В Tailscale не найден адрес *.ts.net. Проверьте MagicDNS и вход в аккаунт.');
  return { ...env, PORT:'3000', HOST:'127.0.0.1', PUBLIC_URL:`https://${hostname}`, COOKIE_SECURE:'1', TRUST_PROXY:'1' };
}
