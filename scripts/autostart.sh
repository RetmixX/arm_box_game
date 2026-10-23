#!/bin/sh
# Автозапуск фронта на Linux: служба systemd armbox-web (scripts/server.py) раздаёт web/ и держит общую
# партию для нескольких ПК; запускается при загрузке и поднимается снова, если упала.
# Страницы — http://IP:порт/game.html (index, debug). Общие настройки игры — в .data/room.json.
#
#   sudo sh scripts/autostart.sh            # поставить и запустить, порт 8080
#   sudo sh scripts/autostart.sh 8090       # другой порт
#   sudo sh scripts/autostart.sh --remove   # убрать из автозагрузки
#
# Служба раздаёт папку на месте: после git pull перезапуск не нужен, достаточно обновить страницу.
# Папку репозитория после установки не переносить — иначе поставить заново.
set -eu

NAME=armbox-web
UNIT=/etc/systemd/system/$NAME.service

if [ "$(id -u)" -ne 0 ]; then
  echo "Нужны права root: sudo sh $0 $*" >&2
  exit 1
fi
command -v systemctl >/dev/null || { echo "Нет systemd (systemctl не найден) — автозапуск этим скриптом не поставить" >&2; exit 1; }

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  echo "Служба $NAME удалена из автозагрузки"
  exit 0
fi

PORT=${1:-8080}
case $PORT in
  '' | *[!0-9]*) echo "Порт — число 1–65535, получено: $PORT" >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "Порт — число 1–65535, получено: $PORT" >&2
  exit 1
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WEB=$ROOT/web
[ -f "$WEB/game.html" ] || { echo "Не найдена папка web/ рядом со scripts/ ($WEB)" >&2; exit 1; }
PY=$(command -v python3) || { echo "Не найден python3 — установите: sudo apt install python3" >&2; exit 1; }
# служба работает от того, кто вызвал sudo, а не от root; порты ниже 1024 так не открыть
RUN_AS=${SUDO_USER:-root}
if [ "$PORT" -lt 1024 ] && [ "$RUN_AS" != root ]; then
  echo "Порт $PORT ниже 1024 недоступен пользователю $RUN_AS — возьмите 8080 или выше" >&2
  exit 1
fi

cat > "$UNIT" <<EOF
[Unit]
Description=ARM-BOX: веб-интерфейс рук ($WEB, порт $PORT)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$WEB
ExecStart="$PY" "$ROOT/scripts/server.py" --port $PORT --web "$WEB" --data "$ROOT/.data/room.json"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$NAME" >/dev/null
systemctl restart "$NAME"
sleep 1
if ! systemctl is-active --quiet "$NAME"; then
  echo "Служба $NAME не запустилась (порт $PORT занят?). Журнал:" >&2
  journalctl -u "$NAME" -n 20 --no-pager >&2
  exit 1
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Готово: $NAME запускается при загрузке системы (от пользователя $RUN_AS)."
echo "Игра: http://${IP:-localhost}:$PORT/game.html · пульт: /index.html · отладка: /debug.html"
echo "Состояние: systemctl status $NAME · журнал: journalctl -u $NAME -f"
