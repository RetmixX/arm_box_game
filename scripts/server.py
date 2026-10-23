"""ARM·BOX: страницы web/ и общая партия для нескольких ПК («комната»). Только стандартная библиотека.

    python3 scripts/server.py                     # http://0.0.0.0:8080/game.html
    python3 scripts/server.py --port 8090 --data /path/room.json

В бою запускается службой armbox-web (scripts/autostart.sh) на одной из рук.

Комната одна на сервер:
- ведущий — единственная страница, которая командует руками и лампами. Пока от неё идут запросы
  (долгий опрос открыт почти всегда), она остаётся ведущей; закрылась — ведущим станет другой ПК;
- settings — общие настройки игры (адреса, калибровка, лотки, счёт). Пишет только ведущий;
  хранятся в файле --data, чтобы пережить перезагрузку руки;
- snapshot — что показывать на экранах: поле, чей ход, движение, ошибки. Пишет только ведущий;
- intents — нажатия на других ПК (ход, новая партия, …). Ведущий выполняет их и подтверждает (ack);
- команды — каждому ПК сервер сам назначает свою: первому ✕, второму ○ (seat в запросе — только пожелание,
  например прежняя команда после перезапуска сервера). Обе заняты — ПК без команды: не ходит, не ведущий,
  страница показывает «обе команды заняты» и займёт команду, когда она освободится.

API, JSON. Каждый ответ — вид комнаты для этого ПК (см. Room.view):
  GET  /api/room?id=&seat=&since=REV&boot=&srev=  долгий опрос: ответ, когда rev > since (до 20 с); you.seat — команда ПК
  (в POST ещё boot и srev, как в GET)
  POST /api/room/claim   {id, seat, renew}         стать ведущим, если ведущего нет; renew — продлить своё
  POST /api/room/publish {id, snapshot, settings?, ack}   только ведущий
  POST /api/room/intent  {id, seat, type, ...}     нажатие — ведущему
  POST /api/room/release {id, to?, leave?}         ведущий уходит; to — передать ПК to; leave — страница закрыта, команда свободна
"""
import argparse
import json
import os
import pathlib
import secrets
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

LEASE_S = 8       # ведущий молчит дольше (и опрос не открыт) — ведущего нет
POLL_S = 20       # долгий опрос держим не дольше
CLIENT_S = 30     # ПК пропал из списка, если столько не спрашивал
INTENT_S = 15     # невыполненное нажатие устаревает
MAX_BODY = 2 << 20
SEATS = ('X', 'O')

ROOT = pathlib.Path(__file__).resolve().parent.parent


class Room:
    def __init__(self, data_path):
        self.cond = threading.Condition()
        self.boot = secrets.token_hex(4)  # сервер перезапущен — страницы узнают по смене boot
        self.started = time.monotonic()
        self.rev = 1
        self.srev = 0
        self.settings = None
        self.snapshot = None
        self.leader = None
        self.leader_seen = 0.0
        self.polls = {}    # id → открытых долгих опросов
        self.clients = {}  # id → {seat, seen}
        self.intents = []
        self.seq = 0
        self.path = data_path
        if data_path and data_path.exists():
            try:
                self.settings = json.loads(data_path.read_text(encoding='utf-8'))
                self.srev = 1
            except (OSError, ValueError) as e:
                print(f'Не прочитал {data_path}: {e} — настройки возьмём у первого ведущего ПК', flush=True)

    # --- под self.cond ---

    def _alive(self, now):
        return self.leader is not None and (self.polls.get(self.leader, 0) > 0 or now - self.leader_seen < LEASE_S)

    def _bump(self):
        self.rev += 1
        self.cond.notify_all()

    def _active(self, cid, now):
        c = self.clients.get(cid)
        return c is not None and (self.polls.get(cid, 0) > 0 or now - c['seen'] < CLIENT_S)

    def _touch(self, cid, want, now):
        """ПК спросил: запомнить и, если у него нет команды, дать свободную (сначала желаемую)"""
        if not cid:
            return
        c = self.clients.get(cid)
        if c is None:
            c = self.clients[cid] = {'seat': None, 'seen': now}
            self.rev += 1  # новый ПК — пусть остальные увидят
        c['seen'] = now
        if c['seat'] is None:
            taken = {o['seat'] for k, o in self.clients.items() if k != cid and self._active(k, now)}
            free = [s for s in SEATS if s not in taken]
            if free:
                c['seat'] = want if want in free else free[0]
                self.rev += 1
                print(f'ПК {cid} играет за {c["seat"]}', flush=True)
        if cid == self.leader:
            self.leader_seen = now

    def seat(self, cid):
        return self.clients.get(cid, {}).get('seat')

    def view(self, cid, boot=None, srev=None):
        now = time.monotonic()
        alive = self._alive(now)
        out = {
            'boot': self.boot,
            'rev': self.rev,
            'srev': self.srev,
            'leader': self.leader if alive else None,
            'snapshot': self.snapshot,
            'you': {'seat': self.seat(cid)},
            'clients': [{'id': k, 'seat': c['seat'], 'leader': alive and k == self.leader}
                        for k, c in self.clients.items() if self._active(k, now)],
        }
        if boot != self.boot or str(srev) != str(self.srev):
            out['settings'] = self.settings
        if alive and cid == self.leader:
            out['intents'] = self.intents
        return out

    def tick(self):
        """Раз в секунду: ведущий пропал или ПК ушёл — разбудить опросы, чтобы все узнали"""
        was_alive, known = False, 0
        while True:
            time.sleep(1)
            with self.cond:
                now = time.monotonic()
                alive = self._alive(now)
                gone = [k for k in self.clients if not self._active(k, now)]
                for k in gone:
                    del self.clients[k]
                self.intents = [i for i in self.intents if now - i['at'] < INTENT_S]
                if (was_alive and not alive) or gone or len(self.clients) != known:
                    self._bump()
                was_alive, known = alive, len(self.clients)

    # --- запросы ---

    def poll(self, cid, seat, since, boot, srev):
        with self.cond:
            now = time.monotonic()
            self._touch(cid, seat, now)
            self.polls[cid] = self.polls.get(cid, 0) + 1
            try:
                end = now + POLL_S
                while boot == self.boot and self.rev <= since:
                    left = end - time.monotonic()
                    if left <= 0:
                        break
                    self.cond.wait(left)
            finally:
                self.polls[cid] = max(0, self.polls.get(cid, 0) - 1)
                if cid in self.clients:  # страница ушла (leave) — опрос в полёте команду не возвращает
                    self._touch(cid, seat, time.monotonic())
            return self.view(cid, boot, srev)

    def claim(self, cid, seat, renew, known):
        with self.cond:
            now = time.monotonic()
            self._touch(cid, seat, now)
            if self.leader == cid:
                self.leader_seen = now
                return True, self.view(cid, *known)
            if not self.seat(cid):  # ПК без команды (обе заняты) руками не командует
                return False, self.view(cid, *known)
            # сервер только что запущен: прежний ведущий мог не заметить перезапуска — ждём, пока он продлит
            if self._alive(now) or (not renew and now - self.started < LEASE_S):
                return False, self.view(cid, *known)
            self.leader, self.leader_seen = cid, now
            self.intents = []
            self._bump()
            print(f'Ведущий ПК: {cid}', flush=True)
            return True, self.view(cid, *known)

    def publish(self, cid, body, known):
        with self.cond:
            now = time.monotonic()
            if cid != self.leader or not self._alive(now):
                return False, self.view(cid, *known)
            self._touch(cid, None, now)
            if 'snapshot' in body:
                self.snapshot = body['snapshot']
            if body.get('settings') is not None:
                self.settings = body['settings']
                self.srev += 1
                self._save()
            ack = body.get('ack')
            if isinstance(ack, int):
                self.intents = [i for i in self.intents if i['seq'] > ack]
            self._bump()
            return True, self.view(cid, *known)

    def intent(self, cid, seat, body, known):
        with self.cond:
            now = time.monotonic()
            self._touch(cid, seat, now)
            if not self._alive(now) or not self.seat(cid):
                return False, self.view(cid, *known)
            self.seq += 1
            item = {k: v for k, v in body.items() if k not in ('id', 'seq', 'at', 'from', 'seat', 'boot', 'srev')}
            item.update(seq=self.seq, at=now, seat=self.seat(cid), **{'from': cid})
            self.intents.append(item)
            self._bump()
            return True, self.view(cid, *known)

    def release(self, cid, to, leave, known):
        with self.cond:
            now = time.monotonic()
            if leave and cid in self.clients:
                del self.clients[cid]  # страница закрыта — команда свободна сразу
                self.polls.pop(cid, None)
                self._bump()
            if cid != self.leader:
                return bool(leave), self.view(cid, *known)
            self.leader = to if to in self.clients and self.seat(to) else None
            self.leader_seen = now
            self.intents = []
            self._bump()
            print(f'Ведущий ПК {cid} ушёл' + (f', передал {to}' if self.leader else ''), flush=True)
            return True, self.view(cid, *known)

    def _save(self):
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix('.tmp')
            tmp.write_text(json.dumps(self.settings, ensure_ascii=False), encoding='utf-8')
            os.replace(tmp, self.path)
        except OSError as e:
            print(f'Не сохранил настройки в {self.path}: {e}', flush=True)


def handler(room, web):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(web), **kw)

        def end_headers(self):
            # после git pull страницы должны обновиться без очистки кэша
            if not self.path.startswith('/api/'):
                self.send_header('Cache-Control', 'no-cache')
            super().end_headers()

        def log_message(self, fmt, *args):
            if not self.path.startswith('/api/room'):  # опрос каждые 20 с — журнал не засоряем
                super().log_message(fmt, *args)

        def send_json(self, code, data):
            raw = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            u = urlsplit(self.path)
            if u.path != '/api/room':
                return super().do_GET()
            q = {k: v[-1] for k, v in parse_qs(u.query).items()}
            try:
                since = int(q.get('since', 0))
            except ValueError:
                since = 0
            self.send_json(200, room.poll(q.get('id', ''), q.get('seat'), since, q.get('boot'), q.get('srev')))

        def do_POST(self):
            u = urlsplit(self.path)
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_BODY:
                return self.send_json(413, {'error': 'Слишком большой запрос'})
            try:
                body = json.loads(self.rfile.read(n) or b'{}')  # sendBeacon шлёт text/plain — разбираем как JSON
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {'error': 'Нужен JSON-объект'})
            cid = str(body.get('id') or '')
            if not cid:
                return self.send_json(400, {'error': 'Нет id страницы'})
            seat = body.get('seat')
            known = (body.get('boot'), body.get('srev'))  # настройки в ответ — только если у страницы устарели
            if u.path == '/api/room/claim':
                ok, v = room.claim(cid, seat, bool(body.get('renew')), known)
            elif u.path == '/api/room/publish':
                ok, v = room.publish(cid, body, known)
            elif u.path == '/api/room/intent':
                ok, v = room.intent(cid, seat, body, known)
            elif u.path == '/api/room/release':
                ok, v = room.release(cid, body.get('to'), bool(body.get('leave')), known)
            else:
                return self.send_json(404, {'error': 'Нет такого адреса'})
            self.send_json(200 if ok else 409, dict(v, ok=ok))

    return Handler


def main():
    ap = argparse.ArgumentParser(description='ARM·BOX: страницы web/ и общая партия для нескольких ПК')
    ap.add_argument('--port', type=int, default=8080)
    ap.add_argument('--bind', default='0.0.0.0')
    ap.add_argument('--web', type=pathlib.Path, default=ROOT / 'web')
    ap.add_argument('--data', type=pathlib.Path, default=ROOT / '.data' / 'room.json',
                    help='где хранить общие настройки игры (калибровку, лотки, счёт)')
    a = ap.parse_args()
    if not (a.web / 'game.html').is_file():
        raise SystemExit(f'Нет {a.web / "game.html"} — укажите папку страниц: --web')
    room = Room(a.data)
    threading.Thread(target=room.tick, daemon=True).start()
    srv = ThreadingHTTPServer((a.bind, a.port), handler(room, a.web))
    srv.daemon_threads = True
    print(f'ARM·BOX: http://{a.bind}:{a.port}/game.html · страницы {a.web} · настройки {a.data}', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
