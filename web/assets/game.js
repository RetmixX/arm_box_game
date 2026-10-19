/*
 * ARM·BOX — крестики-нолики двумя руками-манипуляторами.
 * Игроки нажимают клетки на экране, рука игрока рисует знак маркером на листе.
 * Зависит от window.Kin (kinematics.js), window.Driver (driver.js), window.TTT (ttt.js).
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SIDES = ['X', 'O'];
  const SIGN = { X: '✕', O: '○' };
  const LAMP_OFF = { red: false, yellow: false, green: false, blue: false };

  /* ================================ настройки ================================ */

  const KEY = 'armbox.game';
  const SHARED = 'armbox.settings'; // тема — общая с пультом
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (_) { return {}; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* приватный режим */ } };

  const DEFAULTS = () => ({
    dev: { xHost: '', xPort: '', xLampHost: '', xLampPort: '', oHost: '', oPort: '', oLampHost: '', oLampPort: '', camHost: '', camPort: '' },
    transport: 'ws',
    demo: false,
    mode: 'pvr',
    human: 'X',
    level: 'medium',
    physical: true,
    lamps: true,
    speed: 30, // %, POST /api/motors/speed — обе руки
    score: { X: 0, O: 0, D: 0 },
    cal: { X: TTT.defaultCal('X'), O: TTT.defaultCal('O') },
    edit: 'X',
    page: 'play',
  });

  function loadSettings() {
    const d = DEFAULTS();
    const s = read(KEY);
    const out = Object.assign(d, s);
    out.dev = Object.assign(d.dev, s.dev);
    out.score = Object.assign({ X: 0, O: 0, D: 0 }, s.score);
    out.cal = {};
    SIDES.forEach((side) => {
      const m = TTT.migrateCal(s.cal && s.cal[side]);
      out.cal[side] = Object.assign(TTT.defaultCal(side), m.cal);
      if (m.touchReset) touchResetFor.push(side);
    });
    return out;
  }
  const touchResetFor = []; // руки, у которых старое касание z = 20 поднято под маркер 60 мм
  const S = loadSettings();
  if (/[?&]demo\b/.test(location.search)) S.demo = true;
  const save = () => write(KEY, S);

  let theme = read(SHARED).theme || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  /* ================================ адреса ================================ */

  const p = (side) => side.toLowerCase();
  const cleanHost = (h) => String(h || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const bracket = (h) => (h.includes(':') ? '[' + h + ']' : h);

  function armAddr(side) {
    const h = cleanHost(S.dev[p(side) + 'Host']);
    return h ? h + ':' + (+S.dev[p(side) + 'Port'] || 8000) : '';
  }
  function lampAddr(side) {
    const h = cleanHost(S.dev[p(side) + 'LampHost']) || cleanHost(S.dev[p(side) + 'Host']);
    const port = +S.dev[p(side) + 'LampPort'] || 80;
    return h ? h + (port === 80 ? '' : ':' + port) : '';
  }
  function urls(side) {
    const h = cleanHost(S.dev[p(side) + 'Host']);
    if (!h) return null;
    const base = bracket(h) + ':' + (+S.dev[p(side) + 'Port'] || 8000);
    const l = lampAddr(side);
    return { api: 'http://' + base + '/api/motors', ws: 'ws://' + base + '/ws', lamp: 'http://' + l + '/api/lamp' };
  }
  function camBase() {
    const h = cleanHost(S.dev.camHost);
    return h ? 'http://' + bracket(h) + ':' + (+S.dev.camPort || 8080) : '';
  }

  /* ================================ руки ================================ */

  const arms = {};
  SIDES.forEach((side) => {
    arms[side] = { side, driver: null, link: 'none', err: '', pos: {}, gen: 0, timer: null, lamp: Object.assign({}, LAMP_OFF), lampKey: '', lampBusy: false, lampErr: '', view: null };
  });

  function startArm(side) {
    const a = arms[side];
    a.gen++;
    clearTimeout(a.timer);
    if (a.driver) a.driver.dispose();
    const u = urls(side);
    a.driver = S.demo ? new Driver.DemoDriver() : u ? new Driver.RealDriver(u.api, u.ws, u.lamp) : null;
    Object.assign(a, { link: a.driver ? 'unknown' : 'none', err: '', pos: {}, lampKey: '', lampErr: '', speedApplied: null, speedErr: '' });
    if (!a.driver) { render(); return; }
    if (S.demo) a.driver.connect(); // движения игры — только POST /pos/set-paint, WebSocket не нужен
    const my = a.gen;
    const poll = async () => {
      if (my !== a.gen) return;
      try {
        const pos = await a.driver.getPos();
        if (my !== a.gen) return;
        const first = a.link !== 'online';
        a.pos = pos;
        a.link = 'online';
        a.err = '';
        if (first) { render(); syncLamps(); }
      } catch (e) {
        if (my !== a.gen) return;
        if (a.link !== 'offline') { a.link = 'offline'; a.err = e.message; render(); }
      }
      dirty = true;
      a.timer = setTimeout(poll, S.demo ? 120 : a.link === 'offline' ? 3000 : 400);
    };
    poll();
    render();
  }
  const startArms = () => SIDES.forEach(startArm);
  const armReady = (side) => !!arms[side].driver && (S.demo || arms[side].link === 'online');

  /** Обе руки работают над одним листом — двигаем строго по очереди */
  let chain = Promise.resolve();
  function enqueue(fn) {
    const job = chain.then(fn);
    chain = job.catch(() => {});
    return job;
  }

  let active = null; // { side, i, n, label, title }

  async function runPlan(side, plan, title) {
    const a = arms[side];
    if (!a.driver) throw new Error('Рука ' + SIGN[side] + ' не настроена — укажите её адрес на вкладке «Настройка»');
    if (!armReady(side)) throw new Error('Рука ' + SIGN[side] + ' не отвечает (' + armAddr(side) + ')' + (a.err ? ': ' + a.err : ''));
    // переезд к другой клетке или на стоянку — сначала вертикально вверх на высоту подхода,
    // чтобы база не поворачивалась, пока маркер низко над листом
    const up = Math.round(TTT.heights(S.cal[side]).approach);
    if (a.last && plan.length && plan[0].cell !== a.last.cell && a.last.z < up) {
      plan = [Object.assign({}, a.last, { z: up, label: 'вверх перед переездом' })].concat(plan);
    }
    // скорость: GET в backend нет — выставляем сами перед первым движением после подключения и после смены
    if (a.speedApplied !== S.speed) {
      try { await applySpeed(side); } catch (e) { throw new Error('Рука ' + SIGN[side] + ': скорость ' + S.speed + ' % не выставлена — ' + e.message + '. Движение не начато'); }
    }
    for (const step of plan) {
      const e = TTT.checkPose(step);
      if (e) throw new Error('Калибровка руки ' + SIGN[side] + ': ' + step.label + ' — ' + e);
    }
    active = { side, i: 0, n: plan.length, label: plan[0].label, title };
    render();
    try {
      for (let i = 0; i < plan.length; i++) {
        const s = plan[i];
        Object.assign(active, { i, label: s.label });
        renderProgress();
        await a.driver.movePaint({ x: s.x, z: s.z, angel: s.angel, pov_gripper: s.pov_gripper, paint_pov: s.paint_pov });
        a.last = s;
      }
    } finally {
      active = null;
      render();
    }
  }

  /** POST /api/motors/speed; вызывать только из очереди enqueue — не посреди движения */
  async function applySpeed(side) {
    const a = arms[side];
    const v = S.speed;
    try {
      await a.driver.setSpeed(v);
      a.speedApplied = v;
      a.speedErr = '';
    } catch (e) {
      a.speedErr = e.message;
      throw e;
    } finally {
      renderSpeed();
    }
  }

  const drawMark = (side, cell) => enqueue(() => runPlan(side, TTT.drawPlan(S.cal[side], cell, side), 'рисует ' + SIGN[side] + ' в ' + TTT.cellName(cell)));

  /* ================================ лампы ================================ */

  // Переливание лампы победителя (человека или робота): цвета по кругу с наплывом соседнего, потом — зелёный
  const PARTY_MS = 5000;
  const PARTY_STEP_MS = 300;
  const PARTY = [['red'], ['red', 'yellow'], ['yellow'], ['yellow', 'green'], ['green'], ['green', 'blue'], ['blue'], ['blue', 'red']];
  let partyTimer = null;

  const partyOn = (side) => !!(game.party && game.party.side === side && !game.party.failed && Date.now() < game.party.until);

  /** Запустить переливание; таймер только будит syncLamps — кадр считает lampFor по времени */
  function startParty(side) {
    clearInterval(partyTimer);
    game.party = { side, start: Date.now(), until: Date.now() + PARTY_MS, failed: false };
    const id = game.id;
    partyTimer = setInterval(() => {
      if (id !== game.id || !game.party || Date.now() >= game.party.until || game.party.failed) {
        clearInterval(partyTimer);
        partyTimer = null;
      }
      syncLamps();
    }, PARTY_STEP_MS);
  }

  function lampFor(side) {
    const on = (...c) => Object.assign({}, LAMP_OFF, Object.fromEntries(c.map((k) => [k, true])));
    if (partyOn(side)) return on(...PARTY[Math.floor((Date.now() - game.party.start) / PARTY_STEP_MS) % PARTY.length]);
    if (game.res) return game.res.draw ? on('yellow') : on(game.res.side === side ? 'green' : 'red');
    if ((active && active.side === side) || (game.pending && game.pending.side === side)) return on('blue');
    if (game.error && game.error.side === side) return on('red');
    if (game.thinking && robotSide() === side) return on('yellow');
    if (!game.pending && !game.thinking && !game.error && TTT.turnOf(game.board) === side) return on('green');
    return Object.assign({}, LAMP_OFF);
  }

  function syncLamps() {
    if (!S.lamps) return;
    SIDES.forEach(async (side) => {
      const a = arms[side];
      if (!a.driver || a.lampBusy) return;
      const want = lampFor(side);
      const key = JSON.stringify(want);
      if (key === a.lampKey) return;
      a.lampBusy = true;
      try {
        await a.driver.setLamp(want);
        a.lamp = want;
        a.lampKey = key;
        a.lampErr = '';
      } catch (e) {
        a.lampKey = key; // не долбим лампу повторно, пока состояние игры не изменится
        a.lampErr = e.message;
        if (partyOn(side)) game.party.failed = true; // лампа не отвечает — без переливания, сразу итог
      } finally {
        a.lampBusy = false;
        renderArms();
        if (JSON.stringify(lampFor(side)) !== a.lampKey) syncLamps();
      }
    });
  }

  /* ================================ игра ================================ */

  const game = { id: 0, board: Array(9).fill(null), res: null, pending: null, thinking: false, error: null, party: null, fresh: new Set() };

  const robotSide = () => (S.mode === 'pvr' ? TTT.other(S.human) : null);
  const playerOf = (side) => (S.mode === 'pvr' && side !== S.human ? 'robot' : 'human');
  const nameOf = (side) => (S.mode === 'pvr' ? (side === S.human ? 'Вы' : 'Робот') : 'Игрок ' + SIGN[side]);
  const gameBusy = () => !!(game.pending || game.thinking || game.error);
  const turnSide = () => TTT.turnOf(game.board);

  function canClick(i) {
    return !game.board[i] && !game.res && !gameBusy() && !testing && playerOf(turnSide()) === 'human';
  }

  async function makeMove(cell, side) {
    const id = game.id;
    if (!S.physical) { commit(cell, side); return; }
    game.pending = { cell, side };
    render();
    try {
      await drawMark(side, cell);
      if (id !== game.id) return;
      commit(cell, side);
    } catch (e) {
      if (id !== game.id) return;
      game.pending = null;
      game.error = { cell, side, msg: e.message };
      render();
    }
  }

  function commit(cell, side) {
    game.pending = null;
    game.error = null;
    game.board[cell] = side;
    game.fresh.add(cell);
    game.res = TTT.result(game.board);
    if (game.res) {
      if (game.res.draw) S.score.D++;
      else S.score[game.res.side]++;
      save();
      if (!game.res.draw) startParty(game.res.side);
    }
    render();
    if (!game.res) robotTurn();
  }

  async function robotTurn() {
    const side = turnSide();
    if (playerOf(side) !== 'robot' || game.res || gameBusy()) return;
    const id = game.id;
    game.thinking = true;
    render();
    await sleep(700);
    if (id !== game.id) return;
    game.thinking = false;
    const cell = TTT.chooseMove(game.board, side, S.level);
    makeMove(cell, side);
  }

  function resetGame() {
    game.id++;
    Object.assign(game, { board: Array(9).fill(null), res: null, pending: null, thinking: false, error: null, party: null });
    game.fresh.clear();
    render();
    robotTurn();
  }

  /** Новая партия; на бумаге уже что-то нарисовано — просим положить новый лист */
  async function newGame() {
    if (game.pending || active) { toast('Дождитесь, пока рука закончит рисовать'); return false; }
    const used = game.board.some(Boolean);
    if (S.physical && used) {
      const dlg = $('#dlg-new');
      dlg.returnValue = '';
      dlg.showModal();
      const v = await new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue), { once: true }));
      if (v !== 'ok') return false;
    }
    resetGame();
    return true;
  }

  /* ================================ интерфейс ================================ */

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
  }

  const MARK_SVG = {
    X: '<svg viewBox="0 0 100 100" class="mx"><path pathLength="1" d="M18 18L82 82"/><path pathLength="1" d="M82 18L18 82"/></svg>',
    O: '<svg viewBox="0 0 100 100" class="mo"><circle pathLength="1" cx="50" cy="50" r="33" transform="rotate(-90 50 50)"/></svg>',
  };

  const KEYS = [7, 8, 9, 4, 5, 6, 1, 2, 3]; // цифровой блок клавиатуры
  const boardEl = $('#board');
  const cells = [];
  for (let i = 0; i < 9; i++) {
    const b = document.createElement('button');
    b.className = 'cell';
    b.setAttribute('role', 'gridcell');
    b.dataset.i = i;
    b.innerHTML = '<span class="tag">' + TTT.cellName(i) + '</span><span class="key">' + KEYS[i] + '</span><span class="mark"></span>';
    boardEl.appendChild(b);
    cells.push({ el: b, mark: b.querySelector('.mark'), shown: '' });
  }
  const winSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  winSvg.setAttribute('class', 'winline');
  winSvg.setAttribute('viewBox', '0 0 300 300');
  winSvg.setAttribute('preserveAspectRatio', 'none');
  boardEl.appendChild(winSvg);

  function renderBoard() {
    const turn = turnSide();
    const line = game.res && game.res.line;
    cells.forEach((c, i) => {
      const v = game.board[i];
      const pend = game.pending && game.pending.cell === i ? game.pending.side : null;
      const err = game.error && game.error.cell === i ? game.error.side : null;
      const can = canClick(i);
      let want;
      if (v) want = 'v' + v + (game.fresh.has(i) ? '!' : '');
      else if (pend || err) want = 'g' + (pend || err);
      else if (can) want = 'g' + turn;
      else want = '';
      if (c.shown !== want) {
        if (v) c.mark.innerHTML = MARK_SVG[v].replace('<svg ', '<svg ' + (game.fresh.has(i) ? 'data-draw ' : ''));
        else if (want) c.mark.innerHTML = MARK_SVG[want.slice(1)].replace('class="', 'class="ghost ');
        else c.mark.innerHTML = '';
        const svg = c.mark.querySelector('svg');
        if (svg && svg.hasAttribute('data-draw')) svg.classList.add('draw');
        c.shown = want;
        game.fresh.delete(i);
      }
      c.el.classList.toggle('can', can);
      c.el.classList.toggle('pending', !!(pend || err));
      c.el.classList.toggle('win', !!(line && line.includes(i)));
      c.el.classList.toggle('dim', !!(game.res && v && !(line && line.includes(i))));
      c.el.disabled = !can;
      const name = TTT.cellName(i);
      c.el.setAttribute('aria-label', name + ': ' + (v ? SIGN[v] : 'пусто'));
    });
    if (line) {
      const ctr = (i) => [(i % 3) * 100 + 50, Math.floor(i / 3) * 100 + 50];
      const [a, b] = [ctr(line[0]), ctr(line[2])];
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), k = 28 / len;
      const html = '<line pathLength="1" x1="' + (a[0] - dx * k) + '" y1="' + (a[1] - dy * k) + '" x2="' + (b[0] + dx * k) + '" y2="' + (b[1] + dy * k) + '"/>';
      if (winSvg.innerHTML !== html) winSvg.innerHTML = html;
    } else winSvg.innerHTML = '';
  }

  function renderTurn() {
    const mark = $('#turn-mark'), title = $('#turn-title'), text = $('#turn-text');
    const side = turnSide();
    mark.className = 'turn-mark';
    if (game.res) {
      if (game.res.draw) {
        mark.textContent = '='; mark.classList.add('draw');
        title.textContent = 'Ничья';
        text.textContent = 'Новая партия — на новом листе';
      } else {
        const w = game.res.side;
        mark.textContent = SIGN[w]; mark.classList.add('done');
        title.textContent = S.mode === 'pvr' ? (w === S.human ? 'Вы победили!' : 'Победил робот') : 'Победа ' + SIGN[w];
        text.textContent = S.mode === 'pvr' && w !== S.human ? 'Попробуйте ещё раз или выберите уровень полегче' : 'Три в ряд — ' + game.res.line.map(TTT.cellName).join(', ');
      }
      return;
    }
    const s = game.pending ? game.pending.side : game.error ? game.error.side : side;
    mark.textContent = SIGN[s];
    if (s === 'X') mark.classList.add('x');
    if (game.error) {
      title.textContent = 'Ход ' + SIGN[s] + ' не нарисован';
      text.textContent = 'Выберите, что делать дальше';
    } else if (game.pending) {
      mark.classList.add('pulse');
      title.textContent = 'Рука ' + SIGN[s] + ' рисует';
      text.textContent = 'Клетка ' + TTT.cellName(game.pending.cell) + ' · ' + (S.mode === 'pvr' ? (s === S.human ? 'ваш ход' : 'ход робота') : 'игрок ' + SIGN[s]);
    } else if (game.thinking) {
      mark.classList.add('pulse');
      title.textContent = 'Робот думает';
      text.textContent = 'Уровень: ' + TTT.LEVELS[S.level].name.toLowerCase();
    } else {
      title.textContent = S.mode === 'pvr' ? (playerOf(s) === 'human' ? 'Ваш ход' : 'Ход робота') : 'Ход ' + SIGN[s];
      text.textContent = testing ? 'Идёт проверка руки на вкладке «Настройка»' : 'Выберите клетку · клавиши 1–9';
    }
  }

  function renderProgress() {
    const box = $('#progress');
    box.hidden = !active;
    if (!active) return;
    $('#progress-who').textContent = 'Рука ' + SIGN[active.side] + ' ' + active.title;
    $('#progress-step').textContent = active.label;
    $('#progress-bar').style.width = Math.round(((active.i + 1) / active.n) * 100) + '%';
  }

  function renderAlert() {
    const e = game.error;
    $('#alert').hidden = !e;
    if (!e) return;
    $('#alert-title').textContent = 'Рука ' + SIGN[e.side] + ' не нарисовала ' + SIGN[e.side] + ' в ' + TTT.cellName(e.cell);
    $('#alert-text').textContent = e.msg + '. Проверьте лист: если знак всё-таки нарисован, засчитайте ход.';
    $('#err-cancel').hidden = playerOf(e.side) === 'robot';
  }

  function armState(side) {
    const a = arms[side];
    if (S.demo) return { cls: active && active.side === side ? 'busy' : 'demo', text: active && active.side === side ? active.label : 'демо' };
    if (!a.driver) return { cls: '', text: 'адрес не задан', bad: true };
    if (active && active.side === side) return { cls: 'busy', text: active.label };
    if (a.link === 'online') return { cls: 'ok', text: armAddr(side) };
    if (a.link === 'offline') return { cls: 'bad', text: 'нет связи · ' + armAddr(side), bad: true };
    return { cls: '', text: 'подключение…' };
  }

  function renderArms() {
    const role = (side) => (S.mode === 'pvr' ? (side === S.human ? 'ваша' : 'робота') : 'игрока ' + SIGN[side]);
    $('#arm-cards').innerHTML = SIDES.map((side) => {
      const st = armState(side);
      const a = arms[side];
      const lamp = ['red', 'yellow', 'green', 'blue'].map((c) => '<i class="' + (a.lamp[c] ? 'on' : '') + '" style="--c:var(--l-' + c + ')"></i>').join('');
      return '<div class="arm"><span class="arm-mark ' + (side === 'X' ? 'x' : '') + '">' + SIGN[side] + '</span>' +
        '<div><div class="arm-name">Рука ' + role(side) + '</div><div class="arm-sub ' + (st.bad ? 'bad' : '') + '" title="' + esc(a.err) + '">' + esc(st.text) + '</div></div>' +
        '<span class="lamp ' + (a.lampErr ? 'err' : '') + '" title="' + esc(a.lampErr ? 'Лампа ' + lampAddr(side) + ': ' + a.lampErr : 'Лампа ' + (S.demo ? 'демо' : lampAddr(side) || '—')) + '">' + lamp + '</span></div>';
    }).join('');
    SIDES.forEach((side) => {
      const st = armState(side);
      const el = $('#st-' + side);
      el.className = 'status ' + st.cls;
      el.title = st.text;
    });
  }
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderSetupControls() {
    $$('#mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S.mode)));
    $$('#human button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S.human)));
    $$('#level button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S.level)));
    $$('[data-show="pvr"]').forEach((el) => { el.hidden = S.mode !== 'pvr'; });
    $('#physical').checked = S.physical;
    SIDES.forEach((side) => { $('#sc-' + side).textContent = S.score[side]; $('#sc-' + side + '-name').textContent = nameOf(side); });
    $('#sc-D').textContent = S.score.D;
    $('#new-game').disabled = !!(game.pending || active);
  }

  function render() {
    renderBoard();
    renderTurn();
    renderProgress();
    renderAlert();
    renderArms();
    renderSetupControls();
    renderTestState();
    renderSpeed();
    if (S.page === 'teach') renderTeach();
    syncLamps();
    dirty = true;
  }

  /* ------------------------------ события игры ------------------------------ */

  boardEl.addEventListener('click', (e) => {
    const b = e.target.closest('.cell');
    if (!b) return;
    const i = +b.dataset.i;
    if (canClick(i)) makeMove(i, turnSide());
  });
  boardEl.addEventListener('mouseenter', () => boardEl.classList.add('show-keys'));
  boardEl.addEventListener('mouseleave', () => boardEl.classList.remove('show-keys'));

  $('#err-retry').addEventListener('click', () => { const e = game.error; if (!e) return; game.error = null; makeMove(e.cell, e.side); });
  $('#err-accept').addEventListener('click', () => { const e = game.error; if (e) commit(e.cell, e.side); });
  $('#err-cancel').addEventListener('click', () => { game.error = null; render(); });

  $('#new-game').addEventListener('click', () => newGame());
  $('#score-reset').addEventListener('click', () => { S.score = { X: 0, O: 0, D: 0 }; save(); render(); });

  /** Смена режима посреди партии начинает новую партию */
  async function changeGameSetting(key, value) {
    if (S[key] === value) return;
    const prev = S[key];
    S[key] = value;
    if (game.board.some(Boolean) || gameBusy()) {
      if (!(await newGame())) { S[key] = prev; render(); return; }
    } else resetGame();
    save();
    render();
  }
  const segPick = (sel, key) => $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) changeGameSetting(key, b.dataset.v);
  });
  segPick('#mode', 'mode');
  segPick('#human', 'human');
  $('#level').addEventListener('click', (e) => { // сложность можно менять на ходу
    const b = e.target.closest('button[data-v]');
    if (b) { S.level = b.dataset.v; save(); render(); }
  });
  $('#physical').addEventListener('change', (e) => {
    if (game.pending || active) { e.target.checked = S.physical; toast('Дождитесь, пока рука закончит рисовать'); return; }
    S.physical = e.target.checked;
    save();
    render();
  });

  window.addEventListener('keydown', (e) => {
    if (S.page !== 'play' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '') || document.querySelector('dialog[open]')) return;
    const d = /^(Digit|Numpad)([1-9])$/.exec(e.code);
    if (d) {
      const i = KEYS.indexOf(+d[2]);
      if (canClick(i)) { e.preventDefault(); makeMove(i, turnSide()); }
    } else if (e.code === 'KeyN') { e.preventDefault(); newGame(); }
  });

  /* ============================== схема стола ============================== */

  let dirty = true;
  const C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['alu', 'plate', 'rule', 'steel', 'ink', 'signal', 'bad', 'ok']) C[k] = cs.getPropertyValue('--' + k).trim();
    dirty = true;
  }

  /** Кончик руки (маркер) в координатах поля: из телеметрии или последней команды */
  function tipOf(side) {
    const a = arms[side];
    const cal = S.cal[side];
    let x, z, angle;
    if ([1, 2, 3].every((i) => Number.isFinite(a.pos[i]))) {
      const pose = Kin.poseFromTicks(a.pos);
      const t = Kin.joints(pose).t;
      x = t.x; z = t.z; angle = pose.angle;
    } else {
      const l = a.last || TTT.park(cal);
      x = l.x; z = l.z; angle = l.angel;
    }
    const uv = TTT.polarToArm(x, angle);
    const b = TTT.armToBoard(uv.u, uv.v, cal);
    return { bx: b.bx, by: b.by, z };
  }

  function stepViews(dt) {
    let moving = false;
    const k = 1 - Math.exp(-10 * dt);
    SIDES.forEach((side) => {
      const t = tipOf(side);
      const v = arms[side].view;
      if (!v) { arms[side].view = t; moving = true; return; }
      for (const key of ['bx', 'by', 'z']) {
        const d = t[key] - v[key];
        if (Math.abs(d) > 0.05) { v[key] += d * k; moving = true; } else v[key] = t[key];
      }
    });
    return moving;
  }

  function drawTable(cv, setup) {
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);

    const edit = S.edit;
    const pitch = +S.cal[setup ? edit : 'X'].pitch;
    const bases = {};
    SIDES.forEach((side) => { bases[side] = TTT.armToBoard(0, 0, S.cal[side]); });
    // рамка мира: поле и обе базы
    const pts = [{ bx: -1.5 * pitch, by: -1.5 * pitch }, { bx: 1.5 * pitch, by: 1.5 * pitch }, bases.X, bases.O];
    if (setup) SIDES.forEach((side) => { const c = S.cal[side]; const uv = TTT.polarToArm(+c.parkX, +c.parkAngel); pts.push(TTT.armToBoard(uv.u, uv.v, c)); });
    const minX = Math.min(...pts.map((q) => q.bx)) - 40, maxX = Math.max(...pts.map((q) => q.bx)) + 40;
    const minY = Math.min(...pts.map((q) => q.by)) - 40, maxY = Math.max(...pts.map((q) => q.by)) + 40;
    const pad = 12;
    const s = Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY));
    const ox = (r.width - (maxX - minX) * s) / 2 - minX * s;
    const oy = (r.height + (maxY - minY) * s) / 2 + minY * s;
    const X = (bx) => ox + bx * s, Y = (by) => oy - by * s;

    // лист с полем
    const half = 1.5 * pitch;
    g.fillStyle = C.alu;
    g.beginPath();
    if (g.roundRect) g.roundRect(X(-half - 12), Y(half + 12), (2 * half + 24) * s, (2 * half + 24) * s, 6);
    else g.rect(X(-half - 12), Y(half + 12), (2 * half + 24) * s, (2 * half + 24) * s);
    g.fill();
    if (setup) {
      const chk = TTT.checkCalibration(S.cal[edit]).cells;
      for (let i = 0; i < 9; i++) {
        // куда реально встанет кончик маркера (поправка клетки, смещение маркера, округление команды)
        const o = TTT.cellPlan(S.cal[edit], i, false)[0];
        const ax = TTT.polarToArm(o.x, o.angel);
        const tip = TTT.axisToTip(ax.u, ax.v, S.cal[edit]);
        const c = TTT.armToBoard(tip.u, tip.v, S.cal[edit]);
        g.fillStyle = chk[i] ? C.bad : C.signal;
        g.globalAlpha = chk[i] ? 0.25 : 1;
        if (chk[i]) g.fillRect(X(c.bx - pitch / 2) + 1, Y(c.by + pitch / 2) + 1, pitch * s - 2, pitch * s - 2);
        else { g.beginPath(); g.arc(X(c.bx), Y(c.by), 3, 0, Math.PI * 2); g.fill(); }
        g.globalAlpha = 1;
      }
    }
    g.strokeStyle = C.rule;
    g.lineWidth = 1.5;
    g.beginPath();
    for (const k of [-0.5, 0.5]) {
      g.moveTo(X(k * pitch), Y(half)); g.lineTo(X(k * pitch), Y(-half));
      g.moveTo(X(-half), Y(k * pitch)); g.lineTo(X(half), Y(k * pitch));
    }
    g.stroke();

    // знаки на листе — ровно теми штрихами, что рисует рука
    const strokeMark = (i, side, alpha) => {
      g.globalAlpha = alpha;
      g.strokeStyle = side === 'X' ? C.signal : C.ink;
      g.lineWidth = Math.max(1.5, 2.2 * s);
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const st of TTT.markStrokes(i, side, S.cal[side])) {
        g.beginPath();
        st.forEach((q, k) => (k ? g.lineTo(X(q.bx), Y(q.by)) : g.moveTo(X(q.bx), Y(q.by))));
        g.stroke();
      }
      g.globalAlpha = 1;
    };
    if (!setup) {
      game.board.forEach((v, i) => v && strokeMark(i, v, 1));
      if (game.pending) strokeMark(game.pending.cell, game.pending.side, 0.25);
    } else {
      strokeMark(+$('#t-cell').value || 4, edit, 0.35);
    }

    // руки
    SIDES.forEach((side) => {
      const cal = S.cal[side];
      const b = bases[side];
      const focus = setup ? side === edit : !!(active && active.side === side);
      const dimmed = setup && side !== edit;
      g.globalAlpha = dimmed ? 0.35 : 1;
      // зона досягаемости
      g.setLineDash([4, 5]);
      g.strokeStyle = C.rule;
      g.lineWidth = 1;
      g.beginPath(); g.arc(X(b.bx), Y(b.by), 300 * s, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
      // стоянка
      if (setup) {
        const uv = TTT.polarToArm(+cal.parkX, +cal.parkAngel);
        const pk = TTT.armToBoard(uv.u, uv.v, cal);
        const bad = TTT.checkPose(TTT.park(cal));
        g.strokeStyle = bad ? C.bad : C.steel;
        g.lineWidth = 1.5;
        g.strokeRect(X(pk.bx) - 5, Y(pk.by) - 5, 10, 10);
      }
      // звено: от базы к маркеру
      const v = arms[side].view || tipOf(side);
      const down = v.z <= +cal.zDraw + 4;
      g.strokeStyle = focus ? C.signal : C.steel;
      g.lineWidth = Math.max(6, 22 * s);
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(X(b.bx), Y(b.by)); g.lineTo(X(v.bx), Y(v.by)); g.stroke();
      // маркер: закрашен — касается листа
      g.beginPath(); g.arc(X(v.bx), Y(v.by), Math.max(5, 9 * s), 0, Math.PI * 2);
      g.fillStyle = down ? C.ink : C.plate;
      g.fill();
      g.lineWidth = 2; g.strokeStyle = C.ink; g.stroke();
      // основание
      const R = Math.max(14, 34 * s);
      g.beginPath(); g.arc(X(b.bx), Y(b.by), R, 0, Math.PI * 2);
      g.fillStyle = side === 'X' ? C.signal : C.ink; g.fill();
      g.fillStyle = side === 'X' ? '#fff' : C.alu;
      g.font = '600 ' + Math.round(R * 0.9) + 'px Unbounded, Onest, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(SIGN[side], X(b.bx), Y(b.by) + 1);
      g.globalAlpha = 1;
    });
    g.textAlign = 'start'; g.textBaseline = 'alphabetic';
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const moving = stepViews(dt);
    if (moving || dirty) {
      if (S.page === 'play') drawTable($('#cv-table'), false);
      else drawTable($('#cv-setup'), true);
      dirty = false;
    }
    requestAnimationFrame(frame);
  }
  window.addEventListener('resize', () => { dirty = true; });
  if (document.fonts) document.fonts.ready.then(() => { dirty = true; });

  /* ================================ камера ================================ */

  const cam = { running: null, live: false, busy: false, error: '', timer: null };
  const img = $('#cam-img');
  const camera = () => (camBase() ? new Driver.Camera(camBase()) : null);

  function renderCam() {
    const t = $('#cam-toggle');
    t.checked = !!cam.running;
    t.disabled = cam.busy || !camBase();
    $('#cam-toggle-text').textContent = cam.busy ? (cam.running ? 'Выключаем…' : 'Включаем…') : cam.running ? 'Камера включена' : 'Камера выключена';
    img.hidden = !cam.live;
    $('#cam-live').hidden = !cam.live;
    $('#cam-empty').hidden = cam.live;
    $('#cam-empty').textContent = !camBase()
      ? 'Адрес камеры не задан — вкладка «Настройка»'
      : cam.error ? 'Камера не отвечает: ' + cam.error
        : cam.running ? 'Подключаемся к потоку…' : 'Включите камеру, чтобы все видели лист';
  }
  function showStream() {
    const c = camera();
    if (!c) return;
    img.onload = () => { cam.live = true; cam.error = ''; renderCam(); };
    img.onerror = () => { cam.live = false; renderCam(); };
    img.src = c.streamUrl();
  }
  function hideStream() {
    img.onload = img.onerror = null;
    img.removeAttribute('src');
    cam.live = false;
  }
  async function refreshCam() {
    const c = camera();
    if (!c || cam.busy) { renderCam(); return; }
    try {
      const st = await c.status();
      cam.error = '';
      cam.running = st.running === null ? cam.running !== false : st.running;
    } catch (e) {
      cam.error = e.message.replace(/\.$/, '');
    }
    if (S.page === 'play') {
      if (cam.running && !cam.error && !img.getAttribute('src')) showStream();
      if ((!cam.running || cam.error) && img.getAttribute('src')) hideStream();
    }
    renderCam();
  }
  $('#cam-toggle').addEventListener('change', async (e) => {
    const want = e.target.checked;
    const c = camera();
    if (!c) return;
    cam.busy = true;
    cam.error = '';
    renderCam();
    try {
      if (want) { await c.start(); cam.running = true; await sleep(600); hideStream(); showStream(); }
      else { hideStream(); await c.stop(); cam.running = false; }
    } catch (err) {
      cam.error = err.message.replace(/\.$/, '');
    } finally {
      cam.busy = false;
      renderCam();
    }
  });
  const toggleBig = () => { $('#cam-card').classList.toggle('big'); $('#cam-big').textContent = $('#cam-card').classList.contains('big') ? 'свернуть' : 'крупно'; };
  $('#cam-big').addEventListener('click', toggleBig);
  img.addEventListener('click', toggleBig);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#cam-card').classList.contains('big')) toggleBig(); });

  /* ============================== настройка ============================== */

  let testing = false;

  function renderTestState() {
    const busy = testing || !!game.pending || !!active;
    $$('[data-test], [data-fix]').forEach((b) => { b.disabled = busy; });
    const cal = S.cal[S.edit];
    const empty = (i) => { const f = TTT.cellFix(cal, i); return !f.x && !f.z && !f.a; };
    $('#fix-reset').disabled = busy || empty(+$('#t-cell').value);
    $('#fix-reset-all').disabled = Array.from({ length: 9 }, (_, i) => i).every(empty);
    const el = $('#test-state');
    if (testing && active) el.textContent = 'Рука ' + SIGN[active.side] + ': ' + active.label + '…';
  }

  function fillForm() {
    $$('[data-d]').forEach((el) => { if (document.activeElement !== el) el.value = S.dev[el.dataset.d] || ''; });
    $('#demo').checked = S.demo;
    $('#lamps-on').checked = S.lamps;
    $$('#edit-side button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === S.edit)));
    const cal = S.cal[S.edit];
    $$('[data-k]').forEach((el) => {
      if (document.activeElement === el) return;
      const sc = +el.dataset.scale || 1;
      el.value = Math.round(+cal[el.dataset.k] * sc * 10) / 10;
    });
    $$('#cal-side button').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.v === +cal.side)));
    renderFix();
    renderSpeed();
    renderChecks();
  }

  function renderChecks() {
    const res = {};
    SIDES.forEach((side) => { res[side] = TTT.checkCalibration(S.cal[side]); });
    const items = [];
    SIDES.forEach((side) => res[side].list.forEach((t) => items.push('<li>Рука ' + SIGN[side] + ' · ' + esc(t) + '</li>')));
    const todo = [];
    SIDES.forEach((side) => res[side].todo.forEach((t) => todo.push('<li class="todo">Рука ' + SIGN[side] + ' · ' + esc(t) + '</li>')));
    if (+S.cal.X.pitch !== +S.cal.O.pitch) items.push('<li>Шаг клетки у рук разный (' + S.cal.X.pitch + ' и ' + S.cal.O.pitch + ' мм) — лист один, шаг должен совпадать</li>');
    if (!items.length) items.push('<li class="ok">Обе руки достают до всех клеток и стоянки</li>');
    $('#checks').innerHTML = items.concat(todo).join('');
    const r = TTT.markerRadius(S.cal[S.edit]);
    $('#marker-hint').dataset.r = r ? 'Круг ○ — диаметр ' + Math.round(2 * r) + ' мм. ' : '';
    $$('.fld').forEach((f) => f.classList.remove('bad'));
    dirty = true;
  }

  // адреса устройств применяются кнопкой, чтобы не переподключаться на каждую цифру
  $('#dev-apply').addEventListener('click', () => {
    for (const el of $$('[data-d]')) {
      const k = el.dataset.d;
      const v = el.value.trim();
      if (/Port$/.test(k) && v && !(+v >= 1 && +v <= 65535 && Number.isInteger(+v))) { toast('Порт должен быть от 1 до 65535'); el.focus(); return; }
      if (/Host$/.test(k) && v && !/^[\w.\-:[\]]+$/.test(cleanHost(v))) { toast('Некорректный адрес: ' + v); el.focus(); return; }
      S.dev[k] = /Host$/.test(k) ? cleanHost(v) : v;
    }
    save();
    startArms();
    hideStream();
    cam.running = null; cam.error = '';
    refreshCam();
    fillForm();
    toast('Адреса применены');
  });

  $('#dev-test').addEventListener('click', async () => {
    const out = $('#dev-result');
    out.innerHTML = '<li class="ok">Проверка…</li>';
    const lines = [];
    for (const side of SIDES) {
      const u = urls(side);
      if (!u) { lines.push(['Рука ' + SIGN[side] + ': адрес не задан', false]); continue; }
      const t0 = performance.now();
      try {
        const pos = await Driver.request(u.api + '/pos', undefined, 5000).then(Driver.asDict);
        lines.push(['Рука ' + SIGN[side] + ' ' + armAddr(side) + ': ' + Object.keys(pos).length + ' моторов, ' + Math.round(performance.now() - t0) + ' мс', true]);
      } catch (e) { lines.push(['Рука ' + SIGN[side] + ' ' + armAddr(side) + ': ' + e.message, false]); }
    }
    const c = camera();
    if (!c) lines.push(['Камера: адрес не задан', false]);
    else {
      try { const st = await c.status(); lines.push(['Камера: ' + (st.running === true ? 'включена' : st.running === false ? 'выключена' : 'отвечает'), true]); } catch (e) { lines.push(['Камера: ' + e.message, false]); }
    }
    lines.push(['Лампы проверяются при смене хода — цвет виден на карточках рук', true]);
    out.innerHTML = lines.map(([t, ok]) => '<li class="' + (ok ? 'ok' : '') + '">' + (ok ? '✓ ' : '✗ ') + esc(t) + '</li>').join('');
  });

  $('#demo').addEventListener('change', (e) => {
    if (active) { e.target.checked = S.demo; toast('Дождитесь окончания движения'); return; }
    S.demo = e.target.checked;
    save(); startArms(); fillForm();
  });
  $('#lamps-on').addEventListener('change', (e) => {
    S.lamps = e.target.checked;
    save();
    if (S.lamps) { SIDES.forEach((s) => { arms[s].lampKey = ''; }); syncLamps(); }
    else SIDES.forEach((s) => arms[s].driver && arms[s].driver.setLamp(LAMP_OFF).then(() => { arms[s].lamp = Object.assign({}, LAMP_OFF); arms[s].lampKey = ''; renderArms(); }, () => {}));
  });

  $('#edit-side').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) { S.edit = b.dataset.v; save(); fillForm(); }
  });
  $('#cal-side').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) { S.cal[S.edit].side = +b.dataset.v; save(); fillForm(); }
  });
  $$('[data-k]').forEach((el) => {
    el.addEventListener('input', () => {
      const v = Number(el.value.replace(',', '.'));
      const ok = el.value.trim() !== '' && Number.isFinite(v);
      el.closest('.fld').classList.toggle('bad', !ok);
      if (!ok) return;
      S.cal[S.edit][el.dataset.k] = v / (+el.dataset.scale || 1);
      save();
      renderChecks();
    });
    el.addEventListener('blur', fillForm);
    el.addEventListener('focus', () => el.select());
  });

  /** Подтверждение окном на странице (не confirm(): его браузер может подавить, и сброс молча не сработает) */
  function ask(title, text, okLabel) {
    const dlg = $('#dlg-ask');
    $('#ask-title').textContent = title;
    $('#ask-text').textContent = text;
    $('#ask-ok').textContent = okLabel;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue === 'ok'), { once: true }));
  }

  $('#cal-reset').addEventListener('click', async () => {
    const side = S.edit;
    if (!(await ask('Сбросить калибровку руки ' + SIGN[side] + '?', 'Сторона, центр поля, шаг, маркер, paint_pov, стоянка и поправки клеток вернутся к значениям по умолчанию. Рука не двигается.', 'Сбросить всё'))) return;
    S.cal[side] = TTT.defaultCal(side);
    save(); fillForm();
    $('#test-state').textContent = 'Рука ' + SIGN[side] + ': калибровка сброшена к значениям по умолчанию. Рука не двигалась.';
  });

  /* ------------------------------ скорость ------------------------------ */

  function renderSpeed() {
    $$('#speed-presets button').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.v === S.speed)));
    const inp = $('#speed');
    if (document.activeElement !== inp) inp.value = S.speed;
    $('#speed-state').textContent = SIDES.map((side) => {
      const a = arms[side];
      if (!a.driver) return 'Рука ' + SIGN[side] + ': не настроена';
      if (a.speedErr && a.speedApplied !== S.speed) return 'Рука ' + SIGN[side] + ': ✗ ' + a.speedErr;
      return 'Рука ' + SIGN[side] + ': ' + (a.speedApplied === S.speed ? S.speed + ' % ✓' : S.speed + ' % — выставится перед движением');
    }).join(' · ');
  }

  function setSpeed(v) {
    v = Math.round(v);
    if (!(v >= 1 && v <= 100)) { toast('Скорость — от 1 до 100 %'); renderSpeed(); return; }
    if (v === S.speed) { renderSpeed(); return; }
    S.speed = v;
    save();
    SIDES.forEach((side) => {
      const a = arms[side];
      a.speedApplied = null;
      // через общую очередь: если рука сейчас едет, скорость сменится после движения
      if (armReady(side)) enqueue(() => applySpeed(side)).catch((e) => toast('Рука ' + SIGN[side] + ': скорость не выставлена — ' + e.message));
    });
    renderSpeed();
  }

  $('#speed-presets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) setSpeed(+b.dataset.v);
  });
  $('#speed').addEventListener('change', (e) => setSpeed(Number(String(e.target.value).replace(',', '.'))));
  $('#speed').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#speed').addEventListener('focus', (e) => e.target.select());

  $('#t-cell').innerHTML = Array.from({ length: 9 }, (_, i) => '<option value="' + i + '"' + (i === 4 ? ' selected' : '') + '>Клетка ' + TTT.cellName(i) + '</option>').join('');
  $('#t-cell').addEventListener('change', () => { renderFix(); dirty = true; });

  async function test(kind) {
    if (testing || game.pending || active) return;
    const side = S.edit;
    const cal = S.cal[side];
    const cell = +$('#t-cell').value;
    if (kind === 'down' || kind === 'up') {
      cal.zDraw = +cal.zDraw + (kind === 'up' ? 1 : -1);
      save(); fillForm();
      kind = 'touch';
    }
    const near = atCell(side, cell); // уже над этой клеткой — подниматься на высоту подхода незачем
    const plans = {
      over: [TTT.cellPlan(cal, cell, false, !near), 'над клеткой ' + TTT.cellName(cell)],
      touch: [TTT.cellPlan(cal, cell, true, !near), 'касание, высота ' + cal.zDraw + ' мм'],
      // проверка рисования — без стоянки: рука остаётся над клеткой, знак видно сразу
      X: [TTT.drawPlan(cal, cell, 'X', false), 'рисует ✕ в ' + TTT.cellName(cell)],
      O: [TTT.drawPlan(cal, cell, 'O', false), 'рисует ○ в ' + TTT.cellName(cell)],
      park: [[TTT.park(cal)], 'на стоянку'],
    };
    const [plan, title] = plans[kind];
    // «касание» повторно: маркер уже внизу — достаточно одной точки
    const run = kind === 'touch' && near && markerDown(side) ? plan.slice(-1) : plan;
    await runTest(side, run, title, kind === 'touch' ? ' Маркер должен едва касаться листа; если нет — −1 / +1.' : '');
  }
  $$('[data-test]').forEach((b) => b.addEventListener('click', () => test(b.dataset.test)));

  const markerDown = (side) => !!(arms[side].last && arms[side].last.label === 'касание');
  const atCell = (side, cell) => !!(arms[side].last && arms[side].last.cell === cell);

  async function runTest(side, plan, title, note) {
    testing = true;
    render();
    const out = S.page === 'teach' ? $('#teach-state') : $('#test-state');
    try {
      await enqueue(() => runPlan(side, plan, title));
      out.textContent = 'Рука ' + SIGN[side] + ': ' + title + ' — готово.' + (note || '');
      return true;
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      return false;
    } finally {
      testing = false;
      render();
    }
  }

  /* --------------------- поправка клетки: вылет, высота, база --------------------- */

  const FIX_KEYS = { x: 'вылет', z: 'высота', a: 'база' };

  function fixText(cal, cell) {
    const f = TTT.cellFix(cal, cell);
    const sg = (v) => (v > 0 ? '+' : '−') + Math.abs(v);
    const parts = [];
    if (f.x) parts.push('вылет ' + sg(f.x) + ' мм');
    if (f.z) parts.push('высота ' + sg(f.z) + ' мм');
    if (f.a) parts.push('база ' + sg(f.a) + '°');
    return TTT.cellName(cell) + ': ' + (parts.length ? parts.join(', ') : 'без поправки');
  }

  function renderFix() {
    const cal = S.cal[S.edit];
    const cell = +$('#t-cell').value;
    $('#fix-state').textContent = fixText(cal, cell);
    $('#fix-reset').textContent = 'клетку ' + TTT.cellName(cell);
    $('#cal-reset').textContent = 'всю калибровку руки ' + SIGN[S.edit];
    renderTestState();
  }

  /**
   * Задать поправку клетки и сразу показать её на руке.
   * Вылет и база — рука над клеткой (маркер опущен — сначала поднять, чтобы не чиркнуть по листу);
   * высота — касание: сбоку рука не сдвигается, меняется только z.
   */
  async function setFix(cell, next, key) {
    if (testing || game.pending || active) return;
    const side = S.edit;
    const cal = S.cal[side];
    for (const k of Object.keys(TTT.FIX_LIMITS)) {
      if (Math.abs(next[k]) > TTT.FIX_LIMITS[k]) {
        toast('Поправка клетки: ' + FIX_KEYS[k] + ' — не больше ±' + TTT.FIX_LIMITS[k] + (k === 'a' ? '°' : ' мм') + '. Если нужно больше, поправьте центр поля, шаг или высоту касания');
        return;
      }
    }
    const fix = Array.from({ length: 9 }, (_, i) => TTT.cellFix(cal, i));
    fix[cell] = next;
    const trial = Object.assign({}, cal, { fix });
    const down = markerDown(side) && atCell(side, cell);
    const touch = down || key === 'z';
    let plan = TTT.cellPlan(trial, cell, touch, !atCell(side, cell));
    if (down) plan = key === 'z' ? plan.slice(-1) : [Object.assign({}, arms[side].last, { z: Math.round(TTT.heights(cal).travel), label: 'маркер вверх' })].concat(plan);
    for (const p of plan) {
      const e = TTT.checkPose(p);
      if (e) { toast('Так нельзя: ' + e); return; }
    }
    cal.fix = fix;
    save(); renderFix(); renderChecks();
    const last = plan[plan.length - 1];
    await runTest(side, plan, fixText(cal, cell), ' Команда: x ' + last.x + ' мм, z ' + last.z + ' мм, база ' + last.angel + '°.');
  }

  $$('[data-fix]').forEach((b) => b.addEventListener('click', (e) => {
    const cell = +$('#t-cell').value;
    const key = b.dataset.fix[0];
    const f = TTT.cellFix(S.cal[S.edit], cell);
    const m = e.shiftKey && key !== 'z' ? 5 : 1; // высоту — только по 1 мм: насадка жёсткая
    f[key] += (b.dataset.fix[1] === '+' ? 1 : -1) * m;
    setFix(cell, f, key);
  }));
  $('#fix-reset').addEventListener('click', () => {
    const cell = +$('#t-cell').value;
    if (S.cal[S.edit].taught) S.cal[S.edit].taught[cell] = false;
    setFix(cell, { x: 0, z: 0, a: 0 }, 'x');
  });
  $('#fix-reset-all').addEventListener('click', async () => {
    const side = S.edit;
    if (!(await ask('Обнулить поправки клеток руки ' + SIGN[side] + '?', 'Вылет, высота и база всех 9 клеток станут 0. Общая калибровка останется. Рука не двигается.', 'Обнулить'))) return;
    S.cal[side].fix = TTT.defaultCal(side).fix;
    S.cal[side].taught = TTT.defaultCal(side).taught;
    save(); fillForm();
    $('#test-state').textContent = 'Рука ' + SIGN[side] + ': поправки всех клеток обнулены. Рука не двигалась.';
  });

  /* ============================ позиции клеток ============================ */

  // Рука вручную ставится над каждой клеткой по очереди. pose — текущая команда касания в центре клетки
  // (x, z касания, angel); пока маркер поднят, рука стоит над этой точкой на высоте проезда.
  const teach = { cell: null, pose: null, down: false, zSet: false };

  const tCal = () => S.cal[S.edit];
  const touchPose = (cal, cell) => TTT.cellPlan(cal, cell, true, false)[1];

  /** Команда руке для позы teach: над точкой (z проезда) или касание */
  function teachStep(p, down, label) {
    const cal = tCal();
    return {
      x: p.x, z: down ? p.z : p.z + Math.round(+cal.liftTravel), angel: p.angel,
      pov_gripper: Math.round(+cal.pov), paint_pov: Math.round(+cal.paintPov), cell: teach.cell, label,
    };
  }

  /** Рука не над этой клеткой (например, на стоянке) — сначала подход сверху, как при рисовании */
  function withApproach(plan, p) {
    if (atCell(S.edit, teach.cell)) return plan;
    const z = p.z + Math.round(+tCal().liftApproach);
    return [Object.assign(teachStep(p, false, 'подход к клетке ' + TTT.cellName(teach.cell)), { z })].concat(plan);
  }

  /** Проверить позы и отправить; ошибка рабочей зоны — подсказка, рука не двигается */
  function teachRun(plan, title) {
    for (const p of plan) {
      const e = TTT.checkPose(p);
      if (e) { toast('Так нельзя: ' + e); return Promise.resolve(false); }
    }
    return runTest(S.edit, plan, title);
  }

  /** Перейти к клетке: рука подходит сверху и встаёт над её текущей позицией */
  async function teachGo(cell) {
    if (testing || game.pending || active) return;
    if (!(cell >= 0 && cell <= 8)) return;
    const side = S.edit;
    teach.cell = cell;
    teach.pose = touchPose(tCal(), cell);
    teach.down = false;
    teach.zSet = false;
    renderTeach();
    await teachRun(TTT.cellPlan(tCal(), cell, false, !atCell(side, cell)), 'над клеткой ' + TTT.cellName(cell));
  }

  /** Сдвиг: вылет (x, мм), база (a, °), касание (z, мм — опускает маркер) */
  async function teachJog(key, d) {
    if (testing || game.pending || active) return;
    if (teach.cell === null) { toast('Сначала выберите клетку слева'); return; }
    const prev = teach.pose;
    const next = Object.assign({}, prev, key === 'x' ? { x: prev.x + d } : key === 'a' ? { angel: prev.angel + d } : { z: prev.z + d });
    let plan;
    if (key === 'z') plan = [teachStep(next, true, 'касание')];
    // маркер внизу — поднять на месте, сдвинуться, опустить: по листу не тащим
    else if (teach.down) plan = [teachStep(prev, false, 'маркер вверх'), teachStep(next, false, 'над клеткой'), teachStep(next, true, 'касание')];
    else plan = [teachStep(next, false, 'над клеткой ' + TTT.cellName(teach.cell))];
    plan = withApproach(plan, next);
    for (const p of plan) {
      const e = TTT.checkPose(p);
      if (e) { toast('Так нельзя: ' + e); return; }
    }
    teach.pose = next;
    if (key === 'z') { teach.down = true; teach.zSet = true; }
    renderTeach();
    await runTest(S.edit, plan, TTT.cellName(teach.cell) + ': вылет ' + next.x + ' мм, база ' + next.angel + '°' + (teach.down ? ', касание ' + next.z + ' мм' : ''));
  }

  async function teachToggleDown() {
    if (testing || game.pending || active || teach.cell === null) return;
    teach.down = !teach.down;
    if (teach.down) teach.zSet = true;
    renderTeach();
    const step = teachStep(teach.pose, teach.down, teach.down ? 'касание' : 'маркер вверх');
    const plan = teach.down ? withApproach([teachStep(teach.pose, false, 'над клеткой'), step], teach.pose) : withApproach([step], teach.pose);
    await teachRun(atCell(S.edit, teach.cell) && teach.down ? [step] : plan, teach.down ? 'маркер опущен' : 'маркер поднят');
  }

  /** Запомнить позицию клетки (как поправку) и перейти к следующей незапомненной */
  async function teachSave() {
    if (testing || game.pending || active || teach.cell === null) return;
    const cal = tCal();
    const cell = teach.cell;
    const fix = Array.from({ length: 9 }, (_, i) => TTT.cellFix(cal, i));
    fix[cell] = TTT.fixFromPose(cal, cell, teach.pose, teach.zSet);
    cal.fix = fix;
    cal.taught = Array.from({ length: 9 }, (_, i) => !!(cal.taught && cal.taught[i]));
    cal.taught[cell] = true;
    save(); fillForm(); renderTeach();
    const note = teach.zSet ? '' : ' Касание не подбирали — высота клетки осталась прежней.';
    const next = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => (cell + k) % 9).find((i) => !cal.taught[i]);
    if (next === undefined) {
      if (teach.down) await teachToggleDown();
      $('#teach-state').textContent = 'Рука ' + SIGN[S.edit] + ': ' + TTT.cellName(cell) + ' запомнена. Все 9 клеток выставлены.' + note;
      return;
    }
    await teachGo(next);
    $('#teach-state').textContent = TTT.cellName(cell) + ' запомнена.' + note + ' Теперь ' + TTT.cellName(next) + '.';
  }

  function renderTeach() {
    const cal = tCal();
    const busy = testing || !!game.pending || !!active;
    $$('#teach-side button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === S.edit)));
    const grid = $('#teach-cells');
    if (!grid.children.length) {
      grid.innerHTML = Array.from({ length: 9 }, (_, i) => '<button data-cell="' + i + '" role="gridcell"><span class="nm">' + TTT.cellName(i) + '</span><span class="st"></span></button>').join('');
    }
    $$('#teach-cells button').forEach((b) => {
      const i = +b.dataset.cell;
      const f = TTT.cellFix(cal, i);
      const done = !!(cal.taught && cal.taught[i]);
      b.classList.toggle('ok', done);
      b.classList.toggle('cur', i === teach.cell);
      b.disabled = busy;
      b.querySelector('.st').textContent = done ? '✓ запомнена' : f.x || f.z || f.a ? 'есть поправка' : 'по расчёту';
    });
    const n = cal.taught ? cal.taught.filter(Boolean).length : 0;
    $('#teach-progress').textContent = 'Рука ' + SIGN[S.edit] + ': выставлено ' + n + ' из 9 клеток.' + (n < 9 ? ' Остальные рисуются по расчёту (центр поля и шаг клетки).' : '');
    const p = teach.pose;
    $('#tn-cell').textContent = teach.cell === null ? '—' : TTT.cellName(teach.cell);
    $('#tn-x').textContent = p ? p.x : '—';
    $('#tn-z').textContent = p ? (teach.down ? p.z : p.z + Math.round(+cal.liftTravel)) : '—';
    $('#tn-a').textContent = p ? p.angel : '—';
    if (p) {
      const m = touchPose(Object.assign({}, cal, { fix: [] }), teach.cell);
      const sg = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v);
      $('#tn-delta').textContent = 'От расчёта: вылет ' + sg(p.x - m.x) + ' мм, база ' + sg(p.angel - m.angel) + '°, касание ' + sg(p.z - m.z) + ' мм · маркер ' + (teach.down ? 'опущен, высота — касание' : 'поднят, высота — проезд');
    } else $('#tn-delta').textContent = '';
    const down = $('#teach-down');
    down.setAttribute('aria-pressed', String(teach.down));
    down.textContent = teach.down ? 'Поднять маркер' : 'Опустить маркер';
    const none = teach.cell === null;
    $$('[data-tj], #teach-down, #teach-save').forEach((b) => { b.disabled = busy || none; });
    $('#teach-prev').disabled = busy || none || teach.cell === 0;
    $('#teach-next').disabled = busy || none || teach.cell === 8;
    $('#teach-reset').disabled = busy || none;
    $('#teach-reset').textContent = none ? 'клетку' : 'клетку ' + TTT.cellName(teach.cell);
  }

  $('#teach-cells').addEventListener('click', (e) => { const b = e.target.closest('button[data-cell]'); if (b) teachGo(+b.dataset.cell); });
  $('#teach-side').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.dataset.v === S.edit || testing || active) return;
    S.edit = b.dataset.v;
    save();
    Object.assign(teach, { cell: null, pose: null, down: false, zSet: false });
    fillForm(); renderTeach();
  });
  $$('[data-tj]').forEach((b) => b.addEventListener('click', () => { const [k, d] = b.dataset.tj.split(':'); teachJog(k, +d); }));
  $('#teach-down').addEventListener('click', teachToggleDown);
  $('#teach-save').addEventListener('click', teachSave);
  $('#teach-prev').addEventListener('click', () => teachGo(teach.cell - 1));
  $('#teach-next').addEventListener('click', () => teachGo(teach.cell + 1));
  $('#teach-reset').addEventListener('click', async () => {
    if (testing || game.pending || active || teach.cell === null) return;
    const cal = tCal(), cell = teach.cell;
    const fix = Array.from({ length: 9 }, (_, i) => TTT.cellFix(cal, i));
    fix[cell] = { x: 0, z: 0, a: 0 };
    cal.fix = fix;
    if (cal.taught) cal.taught[cell] = false;
    save(); fillForm();
    if (teach.down) await teachToggleDown();
    await teachGo(cell);
  });
  $('#teach-reset-all').addEventListener('click', async () => {
    const side = S.edit;
    if (!(await ask('Сбросить позиции клеток руки ' + SIGN[side] + '?', 'Все 9 клеток вернутся к расчётным позициям (центр поля и шаг клетки), поправки клеток обнулятся. Рука не двигается.', 'Сбросить позиции'))) return;
    S.cal[side].fix = TTT.defaultCal(side).fix;
    S.cal[side].taught = TTT.defaultCal(side).taught;
    Object.assign(teach, { cell: null, pose: null, down: false, zSet: false });
    save(); fillForm(); renderTeach();
    $('#teach-state').textContent = 'Рука ' + SIGN[side] + ': позиции всех клеток сброшены к расчётным. Рука не двигалась.';
  });

  document.addEventListener('keydown', (e) => {
    if (S.page !== 'teach' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || document.querySelector('dialog[open]')) return;
    if (tag === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return; // на кнопке — нажимается сама кнопка
    const m = e.shiftKey;
    const keys = {
      ArrowUp: () => teachJog('x', m ? 10 : 1), ArrowDown: () => teachJog('x', m ? -10 : -1),
      ArrowLeft: () => teachJog('a', m ? 5 : 1), ArrowRight: () => teachJog('a', m ? -5 : -1),
      PageUp: () => teachJog('z', 1), PageDown: () => teachJog('z', -1),
      ' ': teachToggleDown, Enter: teachSave,
    };
    if (!keys[e.key]) return;
    e.preventDefault();
    keys[e.key]();
  });

  // перенос настроек на вторую вебку
  $('#cfg-save').addEventListener('click', () => {
    const data = { app: 'armbox-ttt', version: 1, dev: S.dev, transport: S.transport, lamps: S.lamps, speed: S.speed, cal: S.cal };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'armbox-ttt.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#cfg-load').addEventListener('click', () => $('#cfg-file').click());
  $('#cfg-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d || d.app !== 'armbox-ttt') throw new Error('это не файл настроек игры');
      Object.assign(S.dev, d.dev || {});
      if (d.transport) S.transport = d.transport;
      if (typeof d.lamps === 'boolean') S.lamps = d.lamps;
      if (Number.isInteger(d.speed) && d.speed >= 1 && d.speed <= 100) S.speed = d.speed;
      SIDES.forEach((side) => { if (d.cal && d.cal[side]) S.cal[side] = Object.assign(TTT.defaultCal(side), TTT.migrateCal(d.cal[side]).cal); });
      save(); fillForm(); startArms(); refreshCam();
      toast('Настройки загружены');
    } catch (err) {
      toast('Не удалось загрузить: ' + err.message);
    }
  });

  /* ============================ вкладки и тема ============================ */

  function setPage(page) {
    S.page = page;
    save();
    $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.page === page)));
    $('#page-play').hidden = page !== 'play';
    $('#page-setup').hidden = page !== 'setup';
    $('#page-teach').hidden = page !== 'teach';
    clearInterval(cam.timer);
    if (page === 'play') { refreshCam(); cam.timer = setInterval(refreshCam, 5000); }
    else { hideStream(); fillForm(); renderCam(); }
    if (page === 'teach') renderTeach();
    dirty = true;
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-page]'); if (b) setPage(b.dataset.page); });

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = theme === 'dark' ? '#16191D' : '#E4E7EA';
    readColors();
  }
  $('#theme').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    const all = read(SHARED); all.theme = theme; write(SHARED, all);
    applyTheme();
  });
  $('#fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  });

  /* ================================ старт ================================ */

  applyTheme();
  startArms();
  setPage(['setup', 'teach'].includes(S.page) ? S.page : 'play');
  render();
  robotTurn();
  requestAnimationFrame(frame);
  if (touchResetFor.length) {
    save();
    toast('Высота касания руки ' + touchResetFor.map((s) => SIGN[s]).join(' и ') + ' поднята до ' + TTT.DEFAULT_CAL.zDraw + ' мм: маркер торчит на 60 мм. Подберите касание заново на вкладке «Настройка»');
  }
})();
