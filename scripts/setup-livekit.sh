#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/krug
test -f public/vendor/livekit-client-2.23.0.js || { echo 'Сначала распакуйте архив интеграции LiveKit'; exit 1; }
python3 - <<'PY'
from pathlib import Path
import re
p=Path('compose.override.yaml')
s=p.read_text() if p.exists() else 'services:\n'
clean=re.sub(r'  # BEGIN Krug LiveKit\n.*?  # END Krug LiveKit\n?', '', s, flags=re.S)
if re.search(r'^  app:\s*$',clean,re.M) or re.findall(r'^(?!#)(\S[^:]*):',clean,re.M)!=['services']:
    raise SystemExit('В compose.override.yaml уже есть настройки app или другой формат. Пришлите файл без секретов для безопасного объединения.')
PY
backup=$(mktemp -d /root/krug-livekit-config-XXXXXXXX)
for file in compose.override.yaml .livekit.env; do
  if [ -f "$file" ]; then cp -p "$file" "$backup/"; fi
done
echo "Резервная копия настроек: $backup"
IFS= read -r -s -p 'LiveKit API Key (ввод скрыт): ' lk_key
printf '\n'
IFS= read -r -s -p 'LiveKit API Secret (ввод скрыт): ' lk_secret
printf '\n'
[[ "$lk_key" =~ ^[A-Za-z0-9_-]+$ && ${#lk_key} -ge 6 ]] || { echo 'Неверный формат API Key'; exit 1; }
[[ "$lk_secret" =~ ^[A-Za-z0-9_-]+$ && ${#lk_secret} -ge 20 ]] || { echo 'Неверный формат API Secret'; exit 1; }
printf '%s\n' 'VOICE_PROVIDER=livekit' 'LIVEKIT_URL=wss://the-circle-070y91tb.livekit.cloud' "LIVEKIT_API_KEY=$lk_key" "LIVEKIT_API_SECRET=$lk_secret" > .livekit.env
unset lk_key lk_secret
python3 - <<'PY'
from pathlib import Path
import re
p=Path('compose.override.yaml')
s=p.read_text() if p.exists() else 'services:\n'
s=re.sub(r'  # BEGIN Krug LiveKit\n.*?  # END Krug LiveKit\n?', '', s, flags=re.S)
s=s.rstrip()+'\n  # BEGIN Krug LiveKit\n  app:\n    env_file:\n      - .livekit.env\n  # END Krug LiveKit\n'
p.write_text(s)
ignore=Path('.dockerignore')
rules=ignore.read_text() if ignore.exists() else ''
if '.livekit.env' not in rules.splitlines():
    ignore.write_text(rules.rstrip()+'\n.livekit.env\n')
PY
echo 'LiveKit настроен. Теперь соберите и перезапустите только app. Секрет сохранён в .livekit.env.'
