# ARM·BOX — веб

Пульт, отладка и игра «крестики-нолики» для двух манипуляторов. Чистый HTML/CSS/JS, без сборки и зависимостей: папка `web/` кладётся на руку рядом с backend.

```bash
npm test           # тесты кинематики и игры
npm run serve      # http://localhost:8080/index.html?demo — без железа
python3 scripts/smoke.py   # страницы в браузере, скриншоты в scripts/out/
```

| Страница | Для чего |
| --- | --- |
| `web/index.html` | показ: джойстики, схват, лампа, камера |
| `web/debug.html` | отладка: оси, программы, телеметрия, API, адреса |
| `web/game.html` | крестики-нолики: игрок жмёт клетку, его рука рисует знак маркером |

Документация: [кинематика](docs/ik.md) · [протокол устройств](docs/api.md) · [игра](docs/game.md) · [задачи](docs/backlog.md).
Работа с Claude Code: правила проекта — в [CLAUDE.md](CLAUDE.md), навыки `/check`, `/sync-ik`, `/safety-review` — в `.claude/skills/`.
