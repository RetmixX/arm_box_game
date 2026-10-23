# ARM·BOX — веб

Пульт, отладка и игра «крестики-нолики» для двух манипуляторов. Чистый HTML/CSS/JS, без сборки и зависимостей: папка `web/` кладётся на руку рядом с backend.

```bash
npm test           # тесты кинематики и игры
npm run serve      # http://localhost:8080/index.html?demo — без железа
python3 scripts/smoke.py   # страницы в браузере, скриншоты в scripts/out/
python3 scripts/server.py  # страницы + общая партия для нескольких ПК (на Windows — python)
```

Автозапуск на Linux (systemd): `sudo sh scripts/autostart.sh` — служба `armbox-web` (`scripts/server.py`) раздаёт `web/` на порту 8080 и держит общую партию для нескольких ПК: руками командует один ПК, остальные видят игру и ходят за свой знак ([подробнее](docs/game.md#несколько-пк-scriptsserverpy-webassetsroomjs)) при загрузке системы и поднимается снова, если упала. Другой порт — `sudo sh scripts/autostart.sh 8090`, убрать — `sudo sh scripts/autostart.sh --remove`. Служба раздаёт папку на месте: после `git pull` достаточно обновить страницу; переместили папку — поставить заново.

| Страница | Для чего |
| --- | --- |
| `web/index.html` | показ: джойстики, схват, лампа, камера |
| `web/debug.html` | отладка: оси, программы, телеметрия, API, адреса |
| `web/game.html` | крестики-нолики: игрок жмёт клетку, его рука ставит фигурку |

Документация: [кинематика](docs/ik.md) · [протокол устройств](docs/api.md) · [игра](docs/game.md) · [задачи](docs/backlog.md).
Работа с Claude Code: правила проекта — в [CLAUDE.md](CLAUDE.md), навыки `/check`, `/sync-ik`, `/safety-review` — в `.claude/skills/`.
