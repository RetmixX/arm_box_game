/*
 * ARM·BOX — общая партия для нескольких ПК через scripts/server.py («комната»).
 * Руками и лампами командует один ведущий ПК; остальные показывают его состояние и отправляют ему нажатия.
 * Страница открыта не с server.py (python -m http.server, с диска) — Room.connect вернёт null: игра на одном ПК.
 * Экспорт window.Room.
 */
(function () {
  'use strict';

  const API = 'api/room'; // относительно страницы
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

  async function call(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, Object.assign({ cache: 'no-store', signal: ctl.signal }, opts));
      const j = await r.json().catch(() => null);
      return { status: r.status, j };
    } finally {
      clearTimeout(t);
    }
  }

  class Room {
    constructor(seat) {
      this.id = newId(); // на каждую вкладку свой: две вкладки на одном ПК — тоже два участника
      this.seat = seat;
      this.boot = null;
      this.rev = 0;
      this.srev = null;
      this.leader = null;
      this.settings = null;
      this.snapshot = null;
      this.intents = [];
      this.clients = [];
      this.offline = false;
      this.onChange = () => {};
    }

    get isLeader() { return this.leader === this.id; }

    /** Ответ сервера — вид комнаты; fresh — что изменилось: settings, boot (сервер перезапущен) */
    _apply(v) {
      if (!v || !v.boot) return;
      if (v.boot === this.boot && v.rev < this.rev) return; // ответ на POST обогнал опрос — старый вид не берём
      const fresh = { boot: this.boot !== null && v.boot !== this.boot, settings: 'settings' in v };
      this.boot = v.boot;
      this.rev = v.rev;
      if (fresh.settings) { this.settings = v.settings; this.srev = v.srev; }
      this.leader = v.leader;
      this.snapshot = v.snapshot;
      this.intents = v.intents || [];
      this.clients = v.clients || [];
      this.offline = false;
      this.onChange(fresh);
    }

    _query(since) {
      return API + '?id=' + this.id + '&seat=' + (this.seat || '') + '&since=' + since + '&boot=' + (this.boot || '') + '&srev=' + (this.srev === null ? '' : this.srev);
    }

    async _loop() {
      for (;;) {
        try {
          const { status, j } = await call(this._query(this.rev), {}, 30000);
          if (status !== 200) throw new Error('HTTP ' + status);
          this._apply(j);
        } catch (_) {
          if (!this.offline) { this.offline = true; this.onChange({}); }
          await sleep(2000);
        }
      }
    }

    async _post(path, body) {
      const { status, j } = await call(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ id: this.id, seat: this.seat, boot: this.boot, srev: this.srev }, body)) }, 8000);
      if (j && j.boot) this._apply(j);
      if (status !== 200) throw Object.assign(new Error(status === 409 ? 'отказано' : (j && j.error) || 'HTTP ' + status), { status });
      return j;
    }

    claim(renew) { return this._post('/claim', { renew: !!renew }); }
    /** snapshot и settings — готовые JSON-строки; settings === null — не менялись */
    publish(snapshot, settings, ack) {
      return this._post('/publish', { snapshot: JSON.parse(snapshot), settings: settings === null ? null : JSON.parse(settings), ack });
    }
    intent(type, data) { return this._post('/intent', Object.assign({}, data, { type })); }
    release(to) { return this._post('/release', { to: to || null }); }
    /** Закрытие страницы: обычный fetch браузер может оборвать */
    releaseBeacon() {
      try { navigator.sendBeacon(API + '/release', JSON.stringify({ id: this.id })); } catch (_) { /* нет sendBeacon */ }
    }
  }

  /** Есть ли комната: server.py отвечает сразу (boot пустой), http.server — 404 */
  async function connect(seat) {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
    const room = new Room(seat);
    try {
      const { status, j } = await call(room._query(0), {}, 2500);
      if (status !== 200 || !j || !j.boot) return null;
      room._apply(j);
    } catch (_) {
      return null;
    }
    room._loop();
    return room;
  }

  window.Room = { connect };
})();
