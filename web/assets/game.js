/*
 * ARM·BOX — крестики-нолики двумя руками-манипуляторами.
 * Игроки нажимают клетки на экране, рука игрока берёт фигурку из своего лотка и ставит в клетку.
 * После партии руки убирают фигурки обратно в лотки.
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
    tray: TTT.emptyTray(), // где фигурки: в гнезде, в клетке, в схвате
    edit: 'X',
    page: 'play',
  });

  const droppedFor = []; // руки, у которых удалены цепочки рисования маркером
  const shiftedFor = []; // [рука, сдвиг мм] — высота захвата сдвинута под новую фигурку
  function loadCal(side, saved) {
    const m = TTT.migrateCal(saved);
    if (m.dropped) droppedFor.push(side);
    if (m.shift) shiftedFor.push([side, m.shift]);
    const cal = Object.assign(TTT.defaultCal(side), m.cal);
    if (!Array.isArray(cal.slots)) cal.slots = TTT.defaultCal(side).slots;
    return cal;
  }
  const shiftNote = () => 'Новые фигурки: высота захвата ' + shiftedFor.map(([s, dz]) => 'руки ' + SIGN[s] + ' ' + (dz > 0 ? 'поднята' : 'опущена') + ' на ' + Math.abs(dz) + ' мм').join(', ')
    + ' — вместе с нижними точками записанных цепочек. Проверьте захват кнопкой «▶ Проиграть» на вкладке «Позиции»';

  function loadSettings() {
    const d = DEFAULTS();
    const s = read(KEY);
    const out = Object.assign(d, s);
    out.dev = Object.assign(d.dev, s.dev);
    out.score = Object.assign({ X: 0, O: 0, D: 0 }, s.score);
    out.tray = TTT.normalizeTray(s.tray);
    out.cal = {};
    SIDES.forEach((side) => { out.cal[side] = loadCal(side, s.cal && s.cal[side]); });
    return out;
  }
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
    if (S.demo) a.driver.connect(); // движения игры — только POST /pos/set (REST), WebSocket не нужен
    const my = a.gen;
    const poll = async () => {
      if (my !== a.gen) return;
      if (a.driver.moving) { a.timer = setTimeout(poll, 150); return; } // рука едет — шину не трогаем
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

  /** Обе руки работают над одним полем — двигаем строго по очереди */
  let chain = Promise.resolve();
  function enqueue(fn) {
    const job = chain.then(fn);
    chain = job.catch(() => {});
    return job;
  }

  let active = null; // { side, i, n, label, title }

  /** Фигурка сменила место (поза плана с trayTo пройдена) — запоминаем сразу: страницу могут закрыть */
  function setTray(side, slot, to) {
    S.tray[side][slot] = to;
    save();
    dirty = true;
  }

  /** Ошибка до первой команды: рука не двигалась, фигурка на месте */
  const before = (msg) => Object.assign(new Error(msg), { notStarted: true });

  async function runPlan(side, plan, title) {
    const a = arms[side];
    if (!a.driver) throw before('Рука ' + SIGN[side] + ' не настроена — укажите её адрес на вкладке «Настройка»');
    if (!armReady(side)) throw before('Рука ' + SIGN[side] + ' не отвечает (' + armAddr(side) + ')' + (a.err ? ': ' + a.err : ''));
    // переезд к другой клетке, гнезду или на стоянку — сначала вертикально вверх на высоту проезда,
    // чтобы база не поворачивалась, пока схват низко над полем
    const H = Math.round(+S.cal[side].zSafe);
    const l = a.last;
    if (l && plan.length && plan[0].target !== l.target && l.z < H) {
      plan = [{ x: l.x, z: H, angel: l.angel, pov_gripper: l.pov_gripper, closed: l.closed, gripper_state: l.gripper_state, target: l.target, label: 'вверх перед переездом' }].concat(plan);
    }
    // скорость: GET в backend нет — выставляем сами перед первым движением после подключения и после смены
    if (a.speedApplied !== S.speed) {
      try { await applySpeed(side); } catch (e) { throw before('Рука ' + SIGN[side] + ': скорость ' + S.speed + ' % не выставлена — ' + e.message + '. Движение не начато'); }
    }
    for (const step of plan) {
      const e = TTT.checkPose(step);
      if (e) throw before('Рука ' + SIGN[side] + ': ' + step.label + ' — ' + e);
    }
    active = { side, i: 0, n: plan.length, label: plan[0].label, title };
    render();
    try {
      for (let i = 0; i < plan.length; i++) {
        const s = plan[i];
        Object.assign(active, { i, label: s.label });
        renderProgress();
        await a.driver.move({ x: s.x, z: s.z, angel: s.angel, pov_gripper: s.pov_gripper, gripper_state: s.gripper_state }, 'rest');
        a.last = s;
        if ('trayTo' in s) setTray(side, s.slot, s.trayTo);
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

  /** Путь к клетке / гнезду (записанная цепочка или расчёт) обязан пройти проверку — иначе ход не начинается */
  function needChain(side, kind, i) {
    const cal = S.cal[side];
    const name = kind === 'cell' ? 'клетка ' + TTT.cellName(i) : 'гнездо ' + (i + 1);
    const e = TTT.checkChain(cal, kind, i);
    if (e) throw before('Рука ' + SIGN[side] + ', ' + name + ': ' + e + '. ' + (TTT.chainOf(cal, kind, i) ? 'Исправьте цепочку на вкладке «Позиции»' : 'Поправьте калибровку на вкладке «Настройка»'));
  }

  /** Взять фигурку из лотка (или ту, что уже в схвате) и поставить в клетку */
  function placePiece(side, cell) {
    return enqueue(async () => {
      const { slot, inHand } = TTT.nextSlot(S.tray[side]);
      if (slot < 0) throw before('Лоток руки ' + SIGN[side] + ' пуст — все фигурки на поле. Начните новую партию');
      if (!inHand) needChain(side, 'slot', slot);
      needChain(side, 'cell', cell);
      await runPlan(side, TTT.movePlan(S.cal[side], slot, cell, { inHand }), 'ставит ' + SIGN[side] + ' в ' + TTT.cellName(cell));
    });
  }

  /** Фигурка из схвата — обратно в её гнездо (отмена хода, уборка) */
  function returnHand(side) {
    return enqueue(async () => {
      const slot = S.tray[side].indexOf('hand');
      if (slot < 0) return;
      needChain(side, 'slot', slot);
      await runPlan(side, TTT.returnPlan(S.cal[side], null, slot), 'возвращает ' + SIGN[side] + ' в гнездо ' + (slot + 1));
    });
  }

  const piecesOut = () => SIDES.some((side) => S.tray[side].some((v) => v !== null));

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
    if (active && active.side === side) return on('blue');
    if (partyOn(side)) return on(...PARTY[Math.floor((Date.now() - game.party.start) / PARTY_STEP_MS) % PARTY.length]);
    if (game.res) return game.res.draw ? on('yellow') : on(game.res.side === side ? 'green' : 'red');
    if (game.pending && game.pending.side === side) return on('blue');
    if (game.error && game.error.side === side) return on('red');
    if (game.thinking && robotSide() === side) return on('yellow');
    if (!game.pending && !game.thinking && !game.error && !game.cleaning && TTT.turnOf(game.board) === side) return on('green');
    return Object.assign({}, LAMP_OFF);
  }

  /** Ошибка лампы для человека: адрес и что проверить */
  function lampErrText(side, e) {
    const addr = lampAddr(side);
    if (/нет ответа|нет связи/.test(e.message)) {
      return 'лампа ' + addr + ' не отвечает — проверьте, что она включена и адрес лампы в «Настройке» верный; если адрес верный, лампа не разрешает запросы с этой страницы (CORS)';
    }
    return 'лампа ' + addr + ': ' + e.message;
  }

  const LAMP_RETRY_MS = 5000;

  /** Лампа не ответила — через LAMP_RETRY_MS пробуем снова, пока не ответит или лампы не выключат */
  function retryLamp(side) {
    const a = arms[side];
    if (a.lampRetry) return;
    a.lampRetry = setTimeout(() => {
      a.lampRetry = null;
      if (!S.lamps || !a.lampErr) return;
      a.lampKey = '';
      syncLamps();
    }, LAMP_RETRY_MS);
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
        a.lampKey = key; // не долбим лампу на каждый кадр — повтор через LAMP_RETRY_MS
        a.lampErr = lampErrText(side, e);
        retryLamp(side);
        if (partyOn(side)) game.party.failed = true; // лампа не отвечает — без переливания, сразу итог
      } finally {
        a.lampBusy = false;
        renderArms();
        if (JSON.stringify(lampFor(side)) !== a.lampKey) syncLamps();
      }
    });
  }

  /* ================================ игра ================================ */

  // error: { kind: 'move', cell, side, msg } — ход сорвался; { kind: 'clean', side, msg } — уборка сорвалась
  const game = { id: 0, board: Array(9).fill(null), res: null, pending: null, thinking: false, error: null, cleaning: false, party: null, fresh: new Set() };

  // фигурки остались на поле с прошлого раза — продолжаем ту же партию (счёт уже записан)
  if (S.physical) {
    const b = TTT.boardFromTray(S.tray);
    if (b && b.some(Boolean)) { game.board = b; game.res = TTT.result(b); }
  }

  const robotSide = () => (S.mode === 'pvr' ? TTT.other(S.human) : null);
  const playerOf = (side) => (S.mode === 'pvr' && side !== S.human ? 'robot' : 'human');
  const nameOf = (side) => (S.mode === 'pvr' ? (side === S.human ? 'Вы' : 'Робот') : 'Игрок ' + SIGN[side]);
  const gameBusy = () => !!(game.pending || game.thinking || game.error || game.cleaning);
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
      await placePiece(side, cell);
      if (id !== game.id) return;
      commit(cell, side);
    } catch (e) {
      if (id !== game.id) return;
      game.pending = null;
      // фигурка уже отпущена в клетке — сорвался подъём или стоянка: ход сделан, рука уйдёт вверх перед следующим
      if (S.tray[side].includes(cell)) {
        toast('Рука ' + SIGN[side] + ' поставила фигурку, но не ушла на стоянку: ' + e.message);
        commit(cell, side);
        return;
      }
      game.error = { kind: 'move', cell, side, msg: e.message, notStarted: !!e.notStarted };
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

  /** Руки возвращают все фигурки с поля (и из схвата) в их гнёзда; false — сорвалось, причина в game.error */
  async function cleanup() {
    game.cleaning = true;
    game.error = null;
    render();
    let side = SIDES[0];
    try {
      for (side of SIDES) {
        let moved = false;
        for (let k = 0; k < TTT.SLOTS; k++) {
          const v = S.tray[side][k];
          if (v === null) continue;
          await enqueue(async () => {
            if (v !== 'hand') needChain(side, 'cell', v);
            needChain(side, 'slot', k);
            const from = v === 'hand' ? 'из схвата' : 'из ' + TTT.cellName(v);
            await runPlan(side, TTT.returnPlan(S.cal[side], v === 'hand' ? null : v, k, { park: false }), 'убирает ' + SIGN[side] + ' ' + from + ' в гнездо ' + (k + 1));
          });
          if (v !== 'hand' && game.board[v] === side) { game.board[v] = null; render(); }
          moved = true;
        }
        if (moved) await enqueue(() => runPlan(side, [TTT.park(S.cal[side])], 'на стоянку'));
      }
      return true;
    } catch (e) {
      game.error = { kind: 'clean', side, msg: e.message };
      return false;
    } finally {
      game.cleaning = false;
      render();
    }
  }

  /** Новая партия; на поле фигурки — руки уберут их в лотки (или человек уберёт сам) */
  async function newGame() {
    if (game.pending || active || game.cleaning) { toast('Дождитесь, пока рука закончит'); return false; }
    if (piecesOut()) {
      const dlg = $('#dlg-new');
      dlg.returnValue = '';
      dlg.showModal();
      const v = await new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue), { once: true }));
      if (v === 'manual') {
        S.tray = TTT.emptyTray();
        save();
      } else if (v !== 'arms' || !(await cleanup())) return false;
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
    toastTimer = setTimeout(() => { el.hidden = true; }, Math.max(3600, text.length * 60));
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
      const err = game.error && game.error.kind === 'move' && game.error.cell === i ? game.error.side : null;
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
    if (game.cleaning) {
      mark.textContent = active ? SIGN[active.side] : '…';
      if (active && active.side === 'X') mark.classList.add('x');
      mark.classList.add('pulse');
      title.textContent = 'Руки убирают фигурки';
      text.textContent = 'Обратно в лотки — потом новая партия';
      return;
    }
    if (game.error && game.error.kind === 'clean') {
      mark.textContent = SIGN[game.error.side];
      if (game.error.side === 'X') mark.classList.add('x');
      title.textContent = 'Фигурки убраны не все';
      text.textContent = 'Выберите, что делать дальше';
      return;
    }
    if (game.res) {
      if (game.res.draw) {
        mark.textContent = '='; mark.classList.add('draw');
        title.textContent = 'Ничья';
      } else {
        const w = game.res.side;
        mark.textContent = SIGN[w]; mark.classList.add('done');
        title.textContent = S.mode === 'pvr' ? (w === S.human ? 'Вы победили!' : 'Победил робот') : 'Победа ' + SIGN[w];
      }
      const lost = !game.res.draw && S.mode === 'pvr' && game.res.side !== S.human;
      text.textContent = lost ? 'Попробуйте ещё раз или выберите уровень полегче'
        : !game.res.draw ? 'Три в ряд — ' + game.res.line.map(TTT.cellName).join(', ')
          : S.physical ? 'Новая партия — руки уберут фигурки в лотки' : 'Начните новую партию';
      return;
    }
    const s = game.pending ? game.pending.side : game.error ? game.error.side : side;
    mark.textContent = SIGN[s];
    if (s === 'X') mark.classList.add('x');
    if (game.error) {
      title.textContent = 'Ход ' + SIGN[s] + ' не сделан';
      text.textContent = 'Выберите, что делать дальше';
    } else if (game.pending) {
      mark.classList.add('pulse');
      title.textContent = game.pending.back ? 'Рука ' + SIGN[s] + ' возвращает фигурку' : 'Рука ' + SIGN[s] + ' ставит фигурку';
      text.textContent = (game.pending.back ? 'В лоток' : 'Клетка ' + TTT.cellName(game.pending.cell)) + ' · ' + (S.mode === 'pvr' ? (s === S.human ? 'ваш ход' : 'ход робота') : 'игрок ' + SIGN[s]);
    } else if (game.thinking) {
      mark.classList.add('pulse');
      title.textContent = 'Робот думает';
      text.textContent = 'Уровень: ' + TTT.LEVELS[S.level].name.toLowerCase();
    } else {
      title.textContent = S.mode === 'pvr' ? (playerOf(s) === 'human' ? 'Ваш ход' : 'Ход робота') : 'Ход ' + SIGN[s];
      text.textContent = testing ? 'Рука занята проверкой на вкладке «Настройка» или «Позиции»' : 'Выберите клетку · клавиши 1–9';
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
    if (e.kind === 'clean') {
      $('#alert-title').textContent = 'Рука ' + SIGN[e.side] + ' не убрала фигурки';
      $('#alert-text').textContent = e.msg + '. Можно повторить или убрать оставшиеся фигурки руками и разложить по гнёздам.';
      $('#err-retry').textContent = 'Повторить уборку';
      $('#err-accept').textContent = 'Убрал сам — новая партия';
      $('#err-accept').hidden = false;
      $('#err-cancel').textContent = 'Закрыть';
      $('#err-cancel').hidden = false;
      return;
    }
    const hand = S.tray[e.side].includes('hand');
    $('#alert-title').textContent = 'Рука ' + SIGN[e.side] + ' не поставила ' + SIGN[e.side] + ' в ' + TTT.cellName(e.cell);
    $('#alert-text').textContent = e.msg.replace(/\.$/, '') + '. ' + (e.notStarted ? 'Рука не двигалась.' : (hand ? 'Фигурка, похоже, в схвате. ' : '') + 'Если фигурка всё-таки стоит в клетке, засчитайте ход.');
    $('#err-retry').textContent = 'Повторить';
    $('#err-accept').textContent = 'Фигурка стоит — засчитать';
    $('#err-accept').hidden = !!e.notStarted;
    $('#err-cancel').textContent = hand ? 'Отменить ход — вернуть в лоток' : 'Отменить ход';
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

  function trayText(side) {
    const t = S.tray[side];
    const inSlots = t.filter((v) => v === null).length;
    return 'лоток ' + inSlots + '/' + TTT.SLOTS + (t.includes('hand') ? ' · фигурка в схвате' : '');
  }

  function renderArms() {
    const role = (side) => (S.mode === 'pvr' ? (side === S.human ? 'ваша' : 'робота') : 'игрока ' + SIGN[side]);
    $('#arm-cards').innerHTML = SIDES.map((side) => {
      const st = armState(side);
      const a = arms[side];
      const lampBad = S.lamps && a.lampErr ? '<div class="arm-sub bad" title="' + esc(a.lampErr) + '">лампа не отвечает</div>' : '';
      const lamp = ['red', 'yellow', 'green', 'blue'].map((c) => '<i class="' + (a.lamp[c] ? 'on' : '') + '" style="--c:var(--l-' + c + ')"></i>').join('');
      return '<div class="arm"><span class="arm-mark ' + (side === 'X' ? 'x' : '') + '">' + SIGN[side] + '</span>' +
        '<div><div class="arm-name">Рука ' + role(side) + '</div><div class="arm-sub ' + (st.bad ? 'bad' : '') + '" title="' + esc(a.err) + '">' + esc(st.text) + ' · ' + esc(trayText(side)) + '</div>' + lampBad + '</div>' +
        '<span class="lamp ' + (a.lampErr ? 'err' : '') + '" title="' + esc(a.lampErr ? a.lampErr : 'Лампа ' + (S.demo ? 'демо' : lampAddr(side) || '—')) + '">' + lamp + '</span></div>';
    }).join('');
    SIDES.forEach((side) => {
      const st = armState(side);
      const el = $('#st-' + side);
      el.className = 'status ' + st.cls;
      el.title = st.text;
    });
  }
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderSetupControls() {
    $$('#mode button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S.mode)));
    $$('#human button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S.human)));
    $$('#level button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S.level)));
    $$('[data-show="pvr"]').forEach((el) => { el.hidden = S.mode !== 'pvr'; });
    $('#physical').checked = S.physical;
    SIDES.forEach((side) => { $('#sc-' + side).textContent = S.score[side]; $('#sc-' + side + '-name').textContent = nameOf(side); });
    $('#sc-D').textContent = S.score.D;
    $('#new-game').disabled = !!(game.pending || active || game.cleaning);
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

  $('#err-retry').addEventListener('click', async () => {
    const e = game.error;
    if (!e) return;
    game.error = null;
    if (e.kind === 'clean') { if (await cleanup()) resetGame(); return; }
    makeMove(e.cell, e.side); // фигурка в схвате — рука сразу понесёт её к клетке
  });
  $('#err-accept').addEventListener('click', () => {
    const e = game.error;
    if (!e) return;
    if (e.kind === 'clean') { S.tray = TTT.emptyTray(); save(); resetGame(); return; }
    // человек видит фигурку в клетке: она из схвата или из первого полного гнезда
    const t = S.tray[e.side];
    if (!t.includes(e.cell)) {
      const { slot } = TTT.nextSlot(t);
      if (slot >= 0) setTray(e.side, slot, e.cell);
    }
    commit(e.cell, e.side);
  });
  $('#err-cancel').addEventListener('click', async () => {
    const e = game.error;
    if (!e) return;
    game.error = null;
    if (e.kind === 'clean' || !S.tray[e.side].includes('hand')) { render(); return; }
    const id = game.id;
    game.pending = { cell: e.cell, side: e.side, back: true };
    render();
    try {
      await returnHand(e.side);
      if (id !== game.id) return;
      game.pending = null;
      render();
    } catch (err) {
      if (id !== game.id) return;
      game.pending = null;
      game.error = Object.assign({}, e, { msg: 'Не удалось вернуть фигурку в лоток: ' + err.message });
      render();
    }
  });

  $('#new-game').addEventListener('click', () => newGame());
  $('#score-reset').addEventListener('click', () => { S.score = { X: 0, O: 0, D: 0 }; save(); render(); });

  /** Смена режима посреди партии начинает новую партию */
  async function changeGameSetting(key, value) {
    if (S[key] === value) return;
    const prev = S[key];
    S[key] = value;
    if (game.board.some(Boolean) || gameBusy() || piecesOut()) {
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
    // посреди партии фигурки на поле разошлись бы с ходами на экране
    if (game.pending || active || game.cleaning || (game.board.some(Boolean) && !game.res)) {
      e.target.checked = S.physical;
      toast('Переключайте между партиями — сейчас на поле идёт игра');
      return;
    }
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

  /** Середина схвата в координатах поля и закрыт ли схват: из телеметрии или последней команды */
  function tipOf(side) {
    const a = arms[side];
    const cal = S.cal[side];
    const l = a.last || TTT.park(cal);
    let x = l.x, z = l.z, angle = l.angel, closed = l.closed;
    if ([1, 2, 3].every((i) => Number.isFinite(a.pos[i]))) {
      const pose = Kin.poseFromTicks(a.pos);
      const t = Kin.joints(pose).t;
      x = t.x; z = t.z; angle = pose.angle;
    }
    if (Number.isFinite(a.pos[6])) {
      // 370 / 710 — тики схвата для gripper_state true / false; с фигуркой схват не дожимает до конца
      const closedTick = TTT.gripState(cal, true) ? 370 : 710;
      closed = Math.abs(a.pos[6] - closedTick) < 170;
    }
    const uv = TTT.polarToArm(x, angle);
    const b = TTT.armToBoard(uv.u, uv.v, cal);
    return { bx: b.bx, by: b.by, z, closed };
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
      if (v.closed !== t.closed) { v.closed = t.closed; moving = true; }
    });
    return moving;
  }

  /** Нижняя точка цепочки в координатах поля — где стоит фигурка */
  function bottomOnBoard(side, kind, i) {
    const cal = S.cal[side];
    const b = TTT.chainBottom(cal, kind, i);
    if (!b) return null;
    const uv = TTT.polarToArm(+b.x, +b.angel);
    return TTT.armToBoard(uv.u, uv.v, cal);
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
    const bases = {}, slots = {};
    SIDES.forEach((side) => {
      bases[side] = TTT.armToBoard(0, 0, S.cal[side]);
      slots[side] = Array.from({ length: TTT.SLOTS }, (_, k) => bottomOnBoard(side, 'slot', k));
    });
    // рамка мира: поле, обе базы, гнёзда лотков
    const pts = [{ bx: -1.5 * pitch, by: -1.5 * pitch }, { bx: 1.5 * pitch, by: 1.5 * pitch }, bases.X, bases.O];
    SIDES.forEach((side) => slots[side].forEach((q) => q && pts.push(q)));
    if (setup) SIDES.forEach((side) => { const c = S.cal[side]; const uv = TTT.polarToArm(+c.parkX, +c.parkAngel); pts.push(TTT.armToBoard(uv.u, uv.v, c)); });
    const minX = Math.min(...pts.map((q) => q.bx)) - 40, maxX = Math.max(...pts.map((q) => q.bx)) + 40;
    const minY = Math.min(...pts.map((q) => q.by)) - 40, maxY = Math.max(...pts.map((q) => q.by)) + 40;
    const pad = 12;
    const s = Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY));
    const ox = (r.width - (maxX - minX) * s) / 2 - minX * s;
    const oy = (r.height + (maxY - minY) * s) / 2 + minY * s;
    const X = (bx) => ox + bx * s, Y = (by) => oy - by * s;

    // поле
    const half = 1.5 * pitch;
    g.fillStyle = C.alu;
    g.beginPath();
    if (g.roundRect) g.roundRect(X(-half - 12), Y(half + 12), (2 * half + 24) * s, (2 * half + 24) * s, 6);
    else g.rect(X(-half - 12), Y(half + 12), (2 * half + 24) * s, (2 * half + 24) * s);
    g.fill();
    let chk = null;
    if (setup) {
      // клетки настраиваемой руки: точка — куда рука ставит фигурку, красная клетка — битая цепочка
      chk = TTT.checkCalibration(S.cal[edit], edit);
      for (let i = 0; i < 9; i++) {
        const c = TTT.cellBoard(i, pitch);
        if (chk.cells[i]) {
          g.fillStyle = C.bad; g.globalAlpha = 0.25;
          g.fillRect(X(c.bx - pitch / 2) + 1, Y(c.by + pitch / 2) + 1, pitch * s - 2, pitch * s - 2);
          g.globalAlpha = 1;
        }
        const q = bottomOnBoard(edit, 'cell', i);
        if (q) { g.fillStyle = chk.cells[i] ? C.bad : C.signal; g.beginPath(); g.arc(X(q.bx), Y(q.by), 3, 0, Math.PI * 2); g.fill(); }
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

    // фигурка: ✕ — оранжевая, ○ — тёмная
    const piece = (q, side, alpha, R) => {
      g.globalAlpha = alpha;
      g.beginPath(); g.arc(X(q.bx), Y(q.by), R, 0, Math.PI * 2);
      g.fillStyle = side === 'X' ? C.signal : C.ink; g.fill();
      g.fillStyle = side === 'X' ? '#fff' : C.alu;
      g.font = '600 ' + Math.round(R * 1.1) + 'px Unbounded, Onest, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(SIGN[side], X(q.bx), Y(q.by) + 1);
      g.globalAlpha = 1;
    };
    const R = Math.max(7, pitch * 0.32 * s);
    if (!setup) {
      game.board.forEach((v, i) => v && piece(TTT.cellBoard(i, pitch), v, 1, R));
      if (game.pending && !game.pending.back) piece(TTT.cellBoard(game.pending.cell, pitch), game.pending.side, 0.25, R);
    }

    // лотки: полное гнездо — фигурка, пустое — кольцо
    const r2 = Math.max(5, pitch * 0.22 * s);
    SIDES.forEach((side) => {
      slots[side].forEach((q, k) => {
        if (!q) return;
        const dim = setup && side !== edit;
        const bad = setup && side === edit && chk.slots[k];
        if (S.tray[side][k] === null) piece(q, side, dim ? 0.3 : 1, r2);
        g.globalAlpha = dim ? 0.3 : 1;
        g.strokeStyle = bad ? C.bad : C.steel;
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(X(q.bx), Y(q.by), r2 + 3, 0, Math.PI * 2); g.stroke();
        if (setup) {
          g.fillStyle = C.steel;
          g.font = '500 11px Onest, sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(String(k + 1), X(q.bx), Y(q.by) - r2 - 10);
        }
        g.globalAlpha = 1;
      });
    });

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
      // звено: от базы к схвату
      const v = arms[side].view || tipOf(side);
      g.strokeStyle = focus ? C.signal : C.steel;
      g.lineWidth = Math.max(6, 22 * s);
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(X(b.bx), Y(b.by)); g.lineTo(X(v.bx), Y(v.by)); g.stroke();
      // схват: закрашен — закрыт (держит фигурку)
      g.beginPath(); g.arc(X(v.bx), Y(v.by), Math.max(5, 9 * s), 0, Math.PI * 2);
      g.fillStyle = v.closed ? C.ink : C.plate;
      g.fill();
      g.lineWidth = 2; g.strokeStyle = C.ink; g.stroke();
      // основание
      const RB = Math.max(14, 34 * s);
      g.beginPath(); g.arc(X(b.bx), Y(b.by), RB, 0, Math.PI * 2);
      g.fillStyle = side === 'X' ? C.signal : C.ink; g.fill();
      g.fillStyle = side === 'X' ? '#fff' : C.alu;
      g.font = '600 ' + Math.round(RB * 0.9) + 'px Unbounded, Onest, sans-serif';
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
      else if (S.page === 'setup') drawTable($('#cv-setup'), true);
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
        : cam.running ? 'Подключаемся к потоку…' : 'Включите камеру, чтобы все видели поле';
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
  const busyNow = () => testing || !!game.pending || !!active || game.cleaning;

  function renderTestState() {
    const busy = busyNow();
    $$('[data-test], [data-fix]').forEach((b) => { b.disabled = busy; });
    const cal = S.cal[S.edit];
    const t = tSel();
    const empty = (kind, i) => { const f = TTT.fixOf(cal, kind, i); return !f.x && !f.z && !f.a && !f.r; };
    $('#fix-reset').disabled = busy || empty(t.kind, t.i);
    $('#fix-reset-all').disabled = Array.from({ length: 9 }, (_, i) => i).every((i) => empty('cell', i)) && Array.from({ length: TTT.SLOTS }, (_, k) => k).every((k) => empty('slot', k));
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
      el.value = Math.round(+cal[el.dataset.k] * 10) / 10;
    });
    $$('#cal-side button').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.v === +cal.side)));
    $$('#grip-true button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === cal.gripTrue)));
    $$('#pov-follow button').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.v === Math.sign(+cal.povFollow || 0))));
    $('#cal-reset').textContent = 'всю калибровку руки ' + SIGN[S.edit];
    renderFix();
    renderSpeed();
    renderChecks();
  }

  function renderChecks() {
    const res = {};
    SIDES.forEach((side) => { res[side] = TTT.checkCalibration(S.cal[side], side); });
    const items = [];
    SIDES.forEach((side) => res[side].list.forEach((t) => items.push('<li>Рука ' + SIGN[side] + ' · ' + esc(t) + '</li>')));
    const todo = [];
    SIDES.forEach((side) => res[side].todo.forEach((t) => todo.push('<li class="todo">Рука ' + SIGN[side] + ' · ' + esc(t) + '</li>')));
    if (!items.length) items.push('<li class="ok">Обе руки достают до всех клеток, гнёзд и стоянки</li>');
    $('#checks').innerHTML = items.concat(todo).join('');
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
    // лампе отправляем то, что она и так должна показывать, — цвет не меняется
    for (const side of SIDES) {
      const a = arms[side];
      const addr = lampAddr(side);
      if (!a.driver || !addr) { lines.push(['Лампа ' + SIGN[side] + ': адрес не задан (по умолчанию — адрес руки, порт 80)', false]); continue; }
      try {
        await a.driver.setLamp(lampFor(side));
        a.lampErr = '';
        lines.push(['Лампа ' + SIGN[side] + ' ' + addr + ': отвечает' + (S.lamps ? '' : ' (в игре лампы выключены — «Показывают ход»)'), true]);
      } catch (e) {
        a.lampErr = lampErrText(side, e);
        lines.push(['Лампа ' + SIGN[side] + ' ' + a.lampErr.replace(/^лампа /, ''), false]);
      }
      a.lampKey = '';
    }
    syncLamps();
    renderArms();
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
    if (b && !busyNow()) { S.edit = b.dataset.v; save(); Object.assign(ch, { kind: null, i: null, pose: null, sel: -1 }); fillForm(); }
  });
  $('#cal-side').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) { S.cal[S.edit].side = +b.dataset.v; save(); fillForm(); }
  });
  $('#grip-true').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || busyNow()) return;
    S.cal[S.edit].gripTrue = b.dataset.v;
    arms[S.edit].last = null; // прежние команды записаны со старым смыслом gripper_state
    save(); fillForm();
  });
  // рука не двигается: новый поворот уйдёт со следующей командой к клетке
  $('#pov-follow').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || busyNow()) return;
    S.cal[S.edit].povFollow = +b.dataset.v;
    save(); fillForm();
  });
  $$('[data-k]').forEach((el) => {
    el.addEventListener('input', () => {
      const v = Number(el.value.replace(',', '.'));
      const ok = el.value.trim() !== '' && Number.isFinite(v);
      el.closest('.fld').classList.toggle('bad', !ok);
      if (!ok) return;
      S.cal[S.edit][el.dataset.k] = v;
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
    if (!(await ask('Сбросить калибровку руки ' + SIGN[side] + '?', 'Сторона, центр поля, шаг, лоток, высоты, схват, стоянка, поправки и все цепочки клеток и гнёзд вернутся к значениям по умолчанию. Рука не двигается.', 'Сбросить всё'))) return;
    S.cal[side] = TTT.defaultCal(side);
    Object.assign(ch, { kind: null, i: null, pose: null, sel: -1 });
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

  /* ------------------------------ проверка на руке ------------------------------ */

  // Цель проверки: клетка ('c0'…'c8') или гнездо ('s0'…'s4') — по расчёту, с поправкой (как раньше с маркером)
  $('#t-cell').innerHTML =
    '<optgroup label="Клетки">' + Array.from({ length: 9 }, (_, i) => '<option value="c' + i + '"' + (i === 4 ? ' selected' : '') + '>Клетка ' + TTT.cellName(i) + '</option>').join('') + '</optgroup>' +
    '<optgroup label="Лоток">' + Array.from({ length: TTT.SLOTS }, (_, k) => '<option value="s' + k + '">Гнездо ' + (k + 1) + '</option>').join('') + '</optgroup>';
  $('#t-cell').addEventListener('change', () => { renderFix(); dirty = true; });

  /** Текущая поза руки по нашим командам (схват — как в последней команде) */
  const lastPose = (side) => arms[side].last;

  const tSel = () => { const v = $('#t-cell').value; return { kind: v[0] === 's' ? 'slot' : 'cell', i: +v.slice(1) }; };
  const tName = (t) => (t.kind === 'cell' ? 'клетка ' + TTT.cellName(t.i) : 'гнездо ' + (t.i + 1));
  const atTarget = (side, t) => { const l = lastPose(side); return !!l && l.target === TTT.targetOf(t.kind, t.i); };
  const isDown = (side, t) => atTarget(side, t) && lastPose(side).z < Math.round(+S.cal[side].zSafe);
  const heightKey = (t) => (t.kind === 'cell' ? 'zPlace' : 'zPick');

  /**
   * Над расчётной точкой цели на высоте подхода. Схват низко у этой цели — сначала вертикально вверх,
   * чтобы не задеть фигурку сдвигом вбок. Схват не трогаем.
   */
  function overPlan(cal, side, t, label) {
    const l = lastPose(side);
    const closed = !!(l && l.closed);
    const target = TTT.targetOf(t.kind, t.i);
    const hover = TTT.calcChain(cal, t.kind, t.i)[0];
    const plan = [];
    if (isDown(side, t)) plan.push(TTT.command(cal, { x: l.x, z: hover.z, angel: l.angel, pov: l.pov_gripper, closed }, 'вверх', { target }));
    plan.push(TTT.command(cal, Object.assign({}, hover, { closed }), label || 'над: ' + tName(t), { target }));
    return plan;
  }

  /** Опустить схват по прямой до высоты захвата (схват не трогаем); уже внизу у цели — сразу в новую точку */
  function downPlan(cal, side, t) {
    const l = lastPose(side);
    const closed = !!(l && l.closed);
    const target = TTT.targetOf(t.kind, t.i);
    const bottom = Object.assign({}, TTT.calcBottom(cal, t.kind, t.i), { closed, line: true });
    if (isDown(side, t)) return TTT.pathPlan(cal, [{ x: l.x, z: l.z, angel: l.angel, pov: l.pov_gripper, closed }, bottom], 'высота захвата', { target });
    const over = overPlan(cal, side, t);
    const hover = over[over.length - 1];
    return over.concat(TTT.pathPlan(cal, [{ x: hover.x, z: hover.z, angel: hover.angel, pov: hover.pov_gripper, closed }, bottom], 'вниз', { target }).slice(1));
  }

  /** Повернуть схват на месте (у цели) на поворот по расчёту — вылет, высоту и схват не трогаем */
  function turnStep(cal, side, t) {
    const l = lastPose(side);
    const pov = TTT.calcBottom(cal, t.kind, t.i).pov;
    return TTT.command(cal, { x: l.x, z: l.z, angel: l.angel, pov, closed: l.closed }, 'поворот схвата ' + pov + '°', { target: l.target });
  }

  const hasChain = (side, t) => !!TTT.chainOf(S.cal[side], t.kind, t.i);
  const chainNote = (side, t) => (hasChain(side, t) ? ' У цели записана цепочка — в игре рука идёт по ней, а не по расчёту.' : '');

  async function test(kind) {
    if (busyNow()) return;
    const side = S.edit;
    const cal = S.cal[side];
    const l = lastPose(side);
    const closed = !!(l && l.closed);
    const t = tSel();
    if (kind === 'over') {
      await runTest(side, overPlan(cal, side, t), 'над: ' + tName(t), ' По расчёту: центр ' + (t.kind === 'cell' ? 'клетки по геометрии поля' : 'гнезда на прямой от гнезда 1 до ' + TTT.SLOTS) + ', с поправкой.' + chainNote(side, t));
    } else if (kind === 'down' || kind === 'h-' || kind === 'h+') {
      if (kind !== 'down') {
        cal[heightKey(t)] = +cal[heightKey(t)] + (kind === 'h+' ? 1 : -1);
        save(); fillForm();
      }
      const b = TTT.calcBottom(cal, t.kind, t.i);
      await runTest(side, downPlan(cal, side, t), tName(t) + ': схват на высоте захвата ' + b.z + ' мм', ' Губки должны охватывать пластину фигурки по середине; если нет — «Высота захвата» −1 / +1.' + chainNote(side, t));
    } else if (kind.startsWith('p:')) {
      // общий поворот схвата: у выбранной цели — поворачиваем на месте, иначе — над целью с новым поворотом
      const next = Math.round(+cal.pov + +kind.slice(2));
      if (!(next >= TTT.LIMITS.pov_gripper[0] && next <= TTT.LIMITS.pov_gripper[1])) { toast('Поворот схвата — от ' + TTT.LIMITS.pov_gripper.join(' до ') + '°'); return; }
      const trial = Object.assign({}, cal, { pov: next });
      const plan = atTarget(side, t) ? [turnStep(trial, side, t)] : overPlan(trial, side, t);
      const e = plan.map(TTT.checkPose).find(Boolean);
      if (e) { toast('Так нельзя: ' + e); return; }
      cal.pov = next;
      save(); fillForm();
      await runTest(side, plan, 'поворот схвата ' + next + '°', ' Общий для всех клеток и гнёзд по расчёту и стоянки. Пластина фигурки должна встать между губками.' + chainNote(side, t));
    } else if (kind === 'open' || kind === 'close') {
      if (!l) { toast('Сначала отправьте руку над клеткой или на стоянку — схват меняется на месте'); return; }
      const step = TTT.command(cal, { x: l.x, z: l.z, angel: l.angel, pov: l.pov_gripper, closed: kind === 'close' }, kind === 'close' ? 'схват закрывается' : 'схват открывается', { target: l.target });
      await runTest(side, [step], kind === 'close' ? 'схват закрыт' : 'схват открыт', ' gripper_state = ' + step.gripper_state + '. Если схват сделал обратное — переключите «gripper_state = true — это…».');
    } else if (kind === 'park') {
      await runTest(side, [TTT.park(cal, closed)], 'на стоянку');
    }
  }
  $$('[data-test]').forEach((b) => b.addEventListener('click', () => test(b.dataset.test)));

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

  /* --------------------- поправка клетки / гнезда: вылет, высота, база --------------------- */

  const FIX_NAMES = { x: 'вылет', z: 'высота', a: 'база', r: 'поворот схвата' };
  const fixKey = (t) => (t.kind === 'cell' ? 'fix' : 'slotFix');

  function fixText(cal, t) {
    const f = TTT.fixOf(cal, t.kind, t.i);
    const sg = (v) => (v > 0 ? '+' : '−') + Math.abs(v);
    const parts = [];
    if (f.x) parts.push('вылет ' + sg(f.x) + ' мм');
    if (f.z) parts.push('высота ' + sg(f.z) + ' мм');
    if (f.a) parts.push('база ' + sg(f.a) + '°');
    if (f.r) parts.push('поворот ' + sg(f.r) + '°');
    return tName(t)[0].toUpperCase() + tName(t).slice(1) + ': ' + (parts.length ? parts.join(', ') : 'без поправки');
  }

  function renderFix() {
    const cal = S.cal[S.edit];
    const t = tSel();
    const b = TTT.calcBottom(cal, t.kind, t.i);
    const auto = t.kind === 'cell' ? Math.round(TTT.povAuto(cal, b.angel)) : 0;
    $('#fix-state').textContent = fixText(cal, t) + ' · захват: вылет ' + b.x + ', высота ' + b.z + ', база ' + b.angel + '°, поворот ' + b.pov + '°' + (auto ? ' (за базой ' + (auto > 0 ? '+' : '−') + Math.abs(auto) + '°)' : '') + (hasChain(S.edit, t) ? ' · записана цепочка — поправка в игре не действует' : '');
    $('#fix-reset').textContent = tName(t);
    $('#h-name').textContent = t.kind === 'cell' ? 'захвата в клетках' : 'захвата в гнёздах';
    renderTestState();
  }

  /**
   * Задать поправку цели и сразу показать её на руке. Вылет и база — рука над целью (если схват внизу —
   * сначала вверх, чтобы не сдвинуть фигурку); высота — опускает схват до высоты захвата.
   */
  async function setFix(t, next, key) {
    if (busyNow()) return;
    const side = S.edit;
    const cal = S.cal[side];
    for (const k of Object.keys(TTT.FIX_LIMITS)) {
      if (Math.abs(next[k]) > TTT.FIX_LIMITS[k]) {
        toast('Поправка: ' + FIX_NAMES[k] + ' — не больше ±' + TTT.FIX_LIMITS[k] + (k === 'a' || k === 'r' ? '°' : ' мм') + '. Если нужно больше, поправьте ' + (t.kind === 'cell' ? 'центр поля, шаг' : 'гнёзда 1 и ' + TTT.SLOTS) + ' или высоту захвата');
        return;
      }
    }
    const n = t.kind === 'cell' ? 9 : TTT.SLOTS;
    const fix = Array.from({ length: n }, (_, i) => TTT.fixOf(cal, t.kind, i));
    fix[t.i] = next;
    const trial = Object.assign({}, cal, { [fixKey(t)]: fix });
    const plan = key === 'r' && atTarget(side, t) ? [turnStep(trial, side, t)]
      : key === 'z' || (key === null && isDown(side, t)) ? downPlan(trial, side, t) : overPlan(trial, side, t);
    for (const q of plan) {
      const e = TTT.checkPose(q);
      if (e) { toast('Так нельзя: ' + e); return; }
    }
    cal[fixKey(t)] = fix;
    save(); renderFix(); renderChecks();
    const last = plan[plan.length - 1];
    await runTest(side, plan, fixText(cal, t), ' Команда: x ' + last.x + ' мм, z ' + last.z + ' мм, база ' + last.angel + '°, поворот ' + last.pov_gripper + '°.' + chainNote(side, t));
  }

  $$('[data-fix]').forEach((b) => b.addEventListener('click', (e) => {
    const t = tSel();
    const key = b.dataset.fix[0];
    const f = TTT.fixOf(S.cal[S.edit], t.kind, t.i);
    const m = e.shiftKey && key !== 'z' ? 5 : 1; // высоту — только по 1 мм
    f[key] += (b.dataset.fix[1] === '+' ? 1 : -1) * m;
    setFix(t, f, key);
  }));
  $('#fix-reset').addEventListener('click', () => setFix(tSel(), { x: 0, z: 0, a: 0, r: 0 }, null));
  $('#fix-reset-all').addEventListener('click', async () => {
    const side = S.edit;
    if (!(await ask('Обнулить поправки руки ' + SIGN[side] + '?', 'Вылет, высота, база и поворот схвата всех клеток и гнёзд станут 0. Остальная калибровка и цепочки останутся. Рука не двигается.', 'Обнулить'))) return;
    const d = TTT.defaultCal(side);
    S.cal[side].fix = d.fix;
    S.cal[side].slotFix = d.slotFix;
    save(); fillForm();
    $('#test-state').textContent = 'Рука ' + SIGN[side] + ': поправки всех клеток и гнёзд обнулены. Рука не двигалась.';
  });

  /* ======================= цепочки клеток и гнёзд (вкладка «Позиции») ======================= */

  // pose — где рука по нашим командам { x, z, angel, pov, closed }; кнопки двигают её одной командой,
  // «+ Точка» записывает её в цепочку выбранной клетки / гнезда (после выбранной точки или в конец).
  const ch = { kind: null, i: null, pose: null, sel: -1, busy: false };

  const tCal = () => S.cal[S.edit];
  const curChain = () => (ch.kind === null ? null : TTT.chainOf(tCal(), ch.kind, ch.i));
  const curName = () => (ch.kind === 'cell' ? 'клетка ' + TTT.cellName(ch.i) : 'гнездо ' + (ch.i + 1));
  const zSafe = () => Math.round(+tCal().zSafe);
  const gripText = (closed) => (closed ? 'закрыт' : 'открыт');
  const poseText = (p) => 'вылет ' + p.x + ' мм, высота ' + p.z + ' мм, база ' + p.angel + '°, поворот ' + p.pov + '°, схват ' + gripText(p.closed);
  const PT_KEYS = ['x', 'z', 'angel', 'pov'];
  const asPose = (p) => ({ x: Math.round(+p.x), z: Math.round(+p.z), angel: Math.round(+p.angel), pov: Math.round(p.pov !== undefined ? +p.pov : +tCal().pov), closed: !!p.closed });

  /** Команда руке из точки */
  const cmd = (p, label) => TTT.command(tCal(), p, label, { target: TTT.targetOf(ch.kind, ch.i) });

  /**
   * Переезд в точку: низко и надо вбок — сначала вверх до высоты проезда, над точкой — вниз,
   * схват меняется уже на месте. Из другой клетки, гнезда или со стоянки подъём добавит runPlan.
   */
  function gotoPlan(target, label) {
    const l = lastPose(S.edit);
    const H = zSafe();
    const keep = l ? l.closed : target.closed; // по дороге схват не трогаем — в нём может быть фигурка
    const t = Object.assign({}, target, { closed: keep });
    const sideways = !l || l.x !== t.x || l.angel !== t.angel;
    const plan = [];
    if (sideways && l && l.target === TTT.targetOf(ch.kind, ch.i) && l.z < H) plan.push(cmd({ x: l.x, z: H, angel: l.angel, pov: l.pov_gripper, closed: keep }, 'вверх'));
    if (sideways && t.z < H) plan.push(cmd(Object.assign({}, t, { z: H }), 'над точкой'));
    plan.push(cmd(t, label));
    if (keep !== !!target.closed) plan.push(cmd(target, target.closed ? 'схват закрывается' : 'схват открывается'));
    return plan;
  }

  function chainRun(plan, title) {
    for (const q of plan) {
      const e = TTT.checkPose(q);
      if (e) { toast('Так нельзя: ' + e); return Promise.resolve(false); }
    }
    return runTest(S.edit, plan, title);
  }

  function setChain(pts) {
    const cal = tCal();
    const key = ch.kind === 'cell' ? 'chains' : 'slots';
    const n = ch.kind === 'cell' ? 9 : TTT.SLOTS;
    cal[key] = Array.from({ length: n }, (_, i) => (cal[key] && cal[key][i]) || null);
    cal[key][ch.i] = pts && pts.length ? pts : null;
    save(); renderChecks(); renderChain(); renderTeach();
  }

  /** Выбрать клетку или гнездо: рука встаёт в первую точку цепочки; нет цепочки — над расчётной точкой */
  async function chainSelect(kind, i) {
    if (busyNow()) return;
    Object.assign(ch, { kind, i, sel: -1 });
    const pts = curChain();
    const l = lastPose(S.edit);
    const here = l ? asPose({ x: l.x, z: l.z, angel: l.angel, pov: l.pov_gripper, closed: l.closed }) : asPose(TTT.park(tCal()));
    if (pts) ch.pose = asPose(pts[0]);
    else ch.pose = asPose(Object.assign({}, TTT.calcChain(tCal(), kind, i)[0], { closed: here.closed }));
    renderChain(); renderTeach();
    await chainRun(gotoPlan(ch.pose, pts ? 'точка 1' : 'над: ' + curName()), (pts ? 'точка 1, ' : 'по расчёту, над: ') + curName());
  }

  /** Ручной сдвиг одной командой: x / z (мм), a — база (°), r — поворот схвата (°) */
  async function chainJog(key, d) {
    if (busyNow()) return;
    if (ch.kind === null) { toast('Сначала выберите клетку или гнездо слева'); return; }
    const k = { x: 'x', z: 'z', a: 'angel', r: 'pov' }[key];
    const next = Object.assign({}, ch.pose, { [k]: ch.pose[k] + d });
    const step = cmd(next, curName() + ': вручную');
    const e = TTT.checkPose(step);
    if (e) { toast('Так нельзя: ' + e); return; }
    ch.pose = next;
    renderTeach();
    await runTest(S.edit, [step], poseText(next));
  }

  /** Открыть / закрыть схват на месте */
  async function chainGrip(closed) {
    if (busyNow()) return;
    if (ch.kind === null) { toast('Сначала выберите клетку или гнездо слева'); return; }
    const next = Object.assign({}, ch.pose, { closed });
    ch.pose = next;
    renderTeach();
    await runTest(S.edit, [cmd(next, closed ? 'схват закрывается' : 'схват открывается')], 'схват ' + gripText(closed));
  }

  function chainAdd(line) {
    if (busyNow() || ch.kind === null || !ch.pose) return;
    const pts = (curChain() || []).slice();
    const at = ch.sel >= 0 ? ch.sel + 1 : pts.length;
    const q = Object.assign({}, ch.pose, { line: !!line && at > 0 });
    pts.splice(at, 0, q);
    ch.sel = at;
    setChain(pts);
    $('#teach-state').textContent = 'Точка ' + (at + 1) + ' записана: ' + poseText(q) + (q.line ? ', по прямой от предыдущей.' : '.');
  }

  function renderChain() {
    const list = $('#chain');
    const pts = curChain();
    $('#chain-title').textContent = ch.kind === null ? 'Цепочка' : 'Цепочка: ' + curName() + (pts ? ' · ' + pts.length + ' точ.' : ' · нет, по расчёту');
    if (!pts) {
      list.innerHTML = '<li class="empty">' + (ch.kind === null ? 'Выберите клетку или гнездо слева.' : 'Цепочки нет — рука ходит по расчёту (калибровка на вкладке «Настройка»). Чтобы задать путь вручную: «Черновик по расчёту» и подправить точки, или подвести схват туда, где ' + (ch.kind === 'cell' ? 'фигурка должна встать' : 'фигурка лежит в гнезде') + ', и нажать «Черновик отсюда».') + '</li>';
      return;
    }
    const names = { x: 'Вылет', z: 'Высота', angel: 'База', pov: 'Поворот схвата' };
    const off = busyNow() ? ' disabled' : '';
    list.innerHTML = pts.map((q, i) => {
      const e = TTT.checkPose(cmd(q, ''));
      const v = asPose(q);
      return '<li data-i="' + i + '" class="' + (i === ch.sel ? 'sel' : '') + (e ? ' bad' : '') + (v.closed ? ' closed' : '') + '"' + (e ? ' title="' + esc(e) + '"' : '') + '>' +
        '<span class="n">' + (i + 1) + '</span>' +
        PT_KEYS.map((k) => '<input class="input mono" data-ck="' + k + '" value="' + esc(v[k]) + '" inputmode="numeric" aria-label="' + names[k] + ', точка ' + (i + 1) + '"' + off + '>').join('') +
        '<span class="opts">' +
          '<label class="ln" title="Схват в этой точке закрыт"><input type="checkbox" data-grip' + (v.closed ? ' checked' : '') + off + '>схват закрыт</label>' +
          '<label class="ln" title="Идти к точке по прямой от предыдущей"><input type="checkbox" data-line' + (q.line ? ' checked' : '') + (i && !off ? '' : ' disabled') + '>прямо</label>' +
        '</span>' +
        '<span class="acts">' +
          '<button data-act="go" title="Ехать в точку"' + off + '>⌖</button>' +
          '<button data-act="set" title="Записать сюда текущее положение руки"' + off + '>✎</button>' +
          '<button data-act="up" title="Выше в списке"' + (i && !off ? '' : ' disabled') + '>↑</button>' +
          '<button data-act="down" title="Ниже в списке"' + (i < pts.length - 1 && !off ? '' : ' disabled') + '>↓</button>' +
          '<button data-act="del" title="Удалить точку"' + off + '>×</button>' +
        '</span></li>';
    }).join('');
  }

  function renderTeach() {
    const cal = tCal();
    const busy = busyNow();
    $$('#teach-side button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === S.edit)));
    const grid = $('#teach-cells');
    if (!grid.children.length) {
      grid.innerHTML = Array.from({ length: 9 }, (_, i) => '<button data-kind="cell" data-i="' + i + '" role="gridcell"><span class="nm">' + TTT.cellName(i) + '</span><span class="st"></span></button>').join('');
      $('#teach-slots').innerHTML = Array.from({ length: TTT.SLOTS }, (_, k) => '<button data-kind="slot" data-i="' + k + '"><span class="nm">' + (k + 1) + '</span><span class="st"></span></button>').join('');
    }
    const need = TTT.NEED_SLOTS[S.edit];
    const count = { cell: 0, slot: 0 };
    $$('#teach-cells button, #teach-slots button').forEach((b) => {
      const kind = b.dataset.kind, i = +b.dataset.i;
      const pts = TTT.chainOf(cal, kind, i);
      const err = pts && TTT.checkChain(cal, kind, i);
      if (pts && !err) count[kind]++;
      b.classList.toggle('ok', !!pts && !err);
      b.classList.toggle('bad', !!err);
      b.classList.toggle('cur', kind === ch.kind && i === ch.i);
      b.classList.toggle('opt', kind === 'slot' && i >= need && !pts);
      b.disabled = busy;
      b.title = err ? 'Цепочка: ' + err : '';
      b.querySelector('.st').textContent = err ? '✗ ошибка' : pts ? '✓ ' + pts.length + ' точ.' : kind === 'slot' && i >= need ? 'не нужно' : 'по расчёту';
    });
    $('#teach-progress').textContent = 'Рука ' + SIGN[S.edit] + ': цепочки у ' + count.cell + ' из 9 клеток и ' + count.slot + ' из ' + need + ' гнёзд. ' +
      (count.cell < 9 || count.slot < need ? 'Остальные — по расчёту: центр поля, лоток, высоты захвата и поправки на вкладке «Настройка».' : 'Все пути записаны вручную.');
    const q = ch.pose;
    $('#tn-cell').textContent = ch.kind === null ? '—' : ch.kind === 'cell' ? TTT.cellName(ch.i) : 'г' + (ch.i + 1);
    $('#tn-x').textContent = q ? q.x : '—';
    $('#tn-z').textContent = q ? q.z : '—';
    $('#tn-a').textContent = q ? q.angel : '—';
    $('#tn-r').textContent = q ? q.pov : '—';
    $('#tn-g').textContent = q ? gripText(q.closed) : '—';
    const H = zSafe();
    $('#tn-note').textContent = q ? 'Высота проезда — ' + H + ' мм: цепочка начинается и кончается не ниже.' + (q.z < H ? ' Сейчас ниже — сдвиг вбок может задеть фигурки.' : '') : '';
    const none = ch.kind === null;
    $$('[data-tj], #chain-add, #chain-add-line, #chain-draft, #chain-calc, #grip-open, #grip-close').forEach((b) => { b.disabled = busy || none; });
    $('#grip-open').setAttribute('aria-pressed', String(!!q && !q.closed));
    $('#grip-close').setAttribute('aria-pressed', String(!!q && q.closed));
    $('#chain-play').disabled = busy || !curChain();
    $('#chain-back').disabled = busy || !curChain();
    $('#chain-clear').disabled = busy || !curChain();
    $('#chain-clear-all').disabled = busy || !((cal.chains || []).some(Boolean) || (cal.slots || []).some(Boolean));
    // пока рука едет, список точек заблокирован; закончила — перерисовать его разблокированным
    if (busy !== ch.busy) { ch.busy = busy; renderChain(); }
  }

  const pickTarget = (e) => { const b = e.target.closest('button[data-kind]'); if (b) chainSelect(b.dataset.kind, +b.dataset.i); };
  $('#teach-cells').addEventListener('click', pickTarget);
  $('#teach-slots').addEventListener('click', pickTarget);
  $('#teach-side').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.dataset.v === S.edit || busyNow()) return;
    S.edit = b.dataset.v;
    save();
    Object.assign(ch, { kind: null, i: null, pose: null, sel: -1 });
    fillForm(); renderChain(); renderTeach();
  });
  $$('[data-tj]').forEach((b) => b.addEventListener('click', () => { const [k, d] = b.dataset.tj.split(':'); chainJog(k, +d); }));
  $('#grip-open').addEventListener('click', () => chainGrip(false));
  $('#grip-close').addEventListener('click', () => chainGrip(true));
  $('#chain-add').addEventListener('click', () => chainAdd(false));
  $('#chain-add-line').addEventListener('click', () => chainAdd(true));

  /** Пройти цепочку на руке без стоянки; back — задом наперёд (забрать из клетки / вернуть в гнездо) */
  async function chainPlay(back) {
    if (busyNow() || !curChain()) return;
    const cal = tCal();
    const e = TTT.checkChain(cal, ch.kind, ch.i);
    if (e) { $('#teach-state').textContent = '✗ Цепочка: ' + curName() + ': ' + e; return; }
    const pts = curChain();
    const end = back ? 0 : pts.length - 1;
    ch.pose = asPose(pts[end]);
    ch.sel = end;
    renderChain(); renderTeach();
    const what = back ? (ch.kind === 'cell' ? 'фигурка забрана из клетки' : 'фигурка возвращена в гнездо') : (ch.kind === 'cell' ? 'фигурка поставлена' : 'фигурка взята');
    await runTest(S.edit, TTT.chainPlan(cal, ch.kind, ch.i, back), curName() + (back ? ' задом наперёд' : '') + ' — ' + what);
  }
  $('#chain-play').addEventListener('click', () => chainPlay(false));
  $('#chain-back').addEventListener('click', () => chainPlay(true));

  $('#chain-draft').addEventListener('click', async () => {
    if (busyNow() || ch.kind === null || !ch.pose) return;
    const H = zSafe();
    if (ch.pose.z >= H) { toast('Сначала опустите схват к ' + (ch.kind === 'cell' ? 'месту фигурки в клетке' : 'фигурке в гнезде') + ' — сейчас он на высоте проезда (' + H + ' мм) или выше'); return; }
    if (curChain() && !(await ask('Заменить цепочку: ' + curName() + '?', 'Точки заменятся черновиком от текущего положения схвата: над ним на высоте проезда → по прямой вниз → схват → по прямой вверх. Рука не двигается.', 'Заменить'))) return;
    const draft = TTT.draftChain(tCal(), ch.kind, ch.pose);
    ch.sel = -1;
    setChain(draft);
    const e = TTT.checkChain(tCal(), ch.kind, ch.i);
    $('#teach-state').textContent = e ? '✗ Черновик записан, но с ошибкой: ' + e
      : 'Черновик для «' + curName() + '»: ' + draft.length + ' точки от текущего положения. Проверьте «▶ Проиграть» и «◀ Обратно»; точку можно подправить — «⌖» ведёт в неё руку, «✎» записывает текущее положение.';
  });

  $('#chain-calc').addEventListener('click', async () => {
    if (busyNow() || ch.kind === null) return;
    if (curChain() && !(await ask('Заменить цепочку: ' + curName() + '?', 'Точки заменятся расчётом из калибровки (центр, лоток, высота захвата, поправка). Рука не двигается.', 'Заменить'))) return;
    ch.sel = -1;
    setChain(TTT.calcChain(tCal(), ch.kind, ch.i));
    $('#teach-state').textContent = 'Черновик по расчёту для «' + curName() + '»: ' + curChain().length + ' точки. Подправьте точки — «⌖» ведёт руку в точку, «✎» записывает текущее положение — и проверьте «▶ Проиграть».';
  });

  $('#chain-clear').addEventListener('click', async () => {
    if (busyNow() || !curChain()) return;
    if (!(await ask('Очистить цепочку: ' + curName() + '?', 'Рука будет ' + (ch.kind === 'cell' ? 'ставить фигурку в эту клетку' : 'брать фигурку из этого гнезда') + ' по расчёту. Рука не двигается.', 'Очистить'))) return;
    ch.sel = -1;
    setChain(null);
    $('#teach-state').textContent = 'Цепочка «' + curName() + '» очищена — дальше по расчёту.';
  });

  $('#chain-clear-all').addEventListener('click', async () => {
    const side = S.edit;
    if (busyNow() || !(await ask('Удалить все цепочки руки ' + SIGN[side] + '?', 'Цепочки всех 9 клеток и ' + TTT.SLOTS + ' гнёзд будут удалены. Рука не двигается.', 'Удалить все'))) return;
    const d = TTT.defaultCal(side);
    S.cal[side].chains = d.chains;
    S.cal[side].slots = d.slots;
    ch.sel = -1;
    save(); renderChecks(); renderChain(); renderTeach();
    $('#teach-state').textContent = 'Рука ' + SIGN[side] + ': все цепочки удалены.';
  });

  // список точек: выбор строки, правка чисел, схват, «по прямой», действия
  $('#chain').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li || busyNow()) return;
    const i = +li.dataset.i;
    const b = e.target.closest('button[data-act]');
    const pts = curChain().slice();
    if (!b) {
      if (e.target.closest('input, label')) return;
      ch.sel = ch.sel === i ? -1 : i;
      renderChain();
      return;
    }
    const act = b.dataset.act;
    if (act === 'go') {
      ch.pose = asPose(pts[i]);
      ch.sel = i;
      renderChain(); renderTeach();
      await chainRun(gotoPlan(ch.pose, 'точка ' + (i + 1)), 'точка ' + (i + 1) + ', ' + curName());
      return;
    }
    if (act === 'set') {
      pts[i] = Object.assign({}, ch.pose, { line: !!pts[i].line && i > 0 });
      $('#teach-state').textContent = 'Точка ' + (i + 1) + ' перезаписана: ' + poseText(pts[i]) + '.';
    }
    if (act === 'up' && i > 0) { [pts[i - 1], pts[i]] = [pts[i], pts[i - 1]]; ch.sel = i - 1; }
    if (act === 'down' && i < pts.length - 1) { [pts[i + 1], pts[i]] = [pts[i], pts[i + 1]]; ch.sel = i + 1; }
    if (act === 'del') { pts.splice(i, 1); ch.sel = Math.min(i, pts.length - 1); }
    if (pts.length) pts[0] = Object.assign({}, pts[0], { line: false }); // к первой точке «по прямой» не бывает
    setChain(pts);
  });
  $('#chain').addEventListener('change', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const i = +li.dataset.i;
    const pts = curChain().slice();
    if (e.target.matches('[data-line]')) { pts[i] = Object.assign({}, pts[i], { line: e.target.checked }); setChain(pts); return; }
    if (e.target.matches('[data-grip]')) { pts[i] = Object.assign({}, pts[i], { closed: e.target.checked }); setChain(pts); return; }
    const k = e.target.dataset.ck;
    const v = Number(String(e.target.value).replace(',', '.'));
    if (!k || !Number.isFinite(v)) { e.target.value = asPose(pts[i])[k]; toast('Нужно число'); return; }
    pts[i] = Object.assign({}, pts[i], { [k]: Math.round(v) });
    setChain(pts);
  });
  $('#chain').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[data-ck]')) e.target.blur(); });

  document.addEventListener('keydown', (e) => {
    if (S.page !== 'teach' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || document.querySelector('dialog[open]')) return;
    if (tag === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return; // на кнопке — нажимается сама кнопка
    const m = e.shiftKey;
    const keys = {
      ArrowUp: () => chainJog('x', m ? 10 : 1), ArrowDown: () => chainJog('x', m ? -10 : -1),
      ArrowLeft: () => chainJog('a', m ? 5 : 1), ArrowRight: () => chainJog('a', m ? -5 : -1),
      PageUp: () => chainJog('z', m ? 10 : 1), PageDown: () => chainJog('z', m ? -10 : -1),
      ']': () => chainJog('r', 1), '[': () => chainJog('r', -1), '}': () => chainJog('r', 10), '{': () => chainJog('r', -10),
      Enter: () => chainAdd(m),
    };
    const fn = keys[e.key] || (e.code === 'KeyG' && ch.pose ? () => chainGrip(!ch.pose.closed) : null);
    if (!fn) return;
    e.preventDefault();
    fn();
  });

  // перенос настроек на вторую вебку
  $('#cfg-save').addEventListener('click', () => {
    const data = { app: 'armbox-ttt', version: 2, dev: S.dev, transport: S.transport, lamps: S.lamps, speed: S.speed, cal: S.cal };
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
    if (busyNow()) { toast('Дождитесь окончания движения'); return; }
    try {
      const d = JSON.parse(await f.text());
      if (!d || d.app !== 'armbox-ttt') throw new Error('это не файл настроек игры');
      Object.assign(S.dev, d.dev || {});
      if (d.transport) S.transport = d.transport;
      if (typeof d.lamps === 'boolean') S.lamps = d.lamps;
      if (Number.isInteger(d.speed) && d.speed >= 1 && d.speed <= 100) S.speed = d.speed;
      droppedFor.length = 0;
      shiftedFor.length = 0;
      SIDES.forEach((side) => { if (d.cal && d.cal[side]) S.cal[side] = loadCal(side, d.cal[side]); });
      Object.assign(ch, { kind: null, i: null, pose: null, sel: -1 });
      save(); fillForm(); startArms(); refreshCam();
      if (S.page === 'teach') { renderChain(); renderTeach(); }
      toast(droppedFor.length ? 'Настройки загружены. Цепочки рисования маркером удалены — запишите цепочки фигурок на вкладке «Позиции»'
        : shiftedFor.length ? 'Настройки загружены. ' + shiftNote() : 'Настройки загружены');
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
    if (page === 'teach') { renderChain(); renderTeach(); }
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
  if (droppedFor.length) {
    save();
    toast('Игра теперь ставит фигурки: цепочки рисования маркером руки ' + droppedFor.map((s) => SIGN[s]).join(' и ') + ' удалены. Запишите цепочки клеток и гнёзд на вкладке «Позиции»');
  } else if (shiftedFor.length) {
    save();
    toast(shiftNote());
  }
  if (game.board.some(Boolean)) toast('На поле фигурки с прошлого раза — партия продолжается');
})();
