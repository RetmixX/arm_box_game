/*
 * Крестики-нолики: правила, ход робота, цепочки «взять из гнезда → поставить в клетку» и лотки.
 * Чистые функции без DOM — работают и в браузере (window.TTT), и в node (module.exports).
 *
 * Системы координат
 *   поле   (bx, by), мм — центр поля в нуле, bx вправо, by вверх (как на экране)
 *   рука   (u, v),   мм — от оси базы руки: u вперёд (angel = 180°), v влево
 *   команда (x, angel)  — как в API: x = |(u, v)|, angel = 180 + atan2(v, u)
 */
(function (root) {
  'use strict';

  /* =============================== правила =============================== */

  const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  const other = (s) => (s === 'X' ? 'O' : 'X');

  /** null — партия идёт; { side, line } — победа; { side: null, draw: true } — ничья */
  function result(b) {
    for (const l of LINES) {
      const [a, c, d] = l;
      if (b[a] && b[a] === b[c] && b[a] === b[d]) return { side: b[a], line: l };
    }
    return b.every(Boolean) ? { side: null, line: null, draw: true } : null;
  }

  const free = (b) => b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);

  /** Чей ход: крестики всегда начинают */
  function turnOf(b) {
    const x = b.filter((v) => v === 'X').length;
    const o = b.filter((v) => v === 'O').length;
    return x > o ? 'O' : 'X';
  }

  /* ================================ робот ================================ */

  /** Оценка позиции для side (ход за turn): +10 — победа, −10 — поражение, быстрее — лучше */
  function minimax(b, side, turn, depth) {
    const r = result(b);
    if (r) return r.draw ? 0 : r.side === side ? 10 - depth : depth - 10;
    let best = turn === side ? -Infinity : Infinity;
    for (const i of free(b)) {
      b[i] = turn;
      const s = minimax(b, side, other(turn), depth + 1);
      b[i] = null;
      best = turn === side ? Math.max(best, s) : Math.min(best, s);
    }
    return best;
  }

  function bestMoves(board, side) {
    const b = board.slice();
    let best = -Infinity;
    let moves = [];
    for (const i of free(b)) {
      b[i] = side;
      const s = minimax(b, side, other(side), 1);
      b[i] = null;
      if (s > best) { best = s; moves = [i]; } else if (s === best) moves.push(i);
    }
    return moves;
  }

  function winningMove(board, side) {
    for (const i of free(board)) {
      const b = board.slice();
      b[i] = side;
      const r = result(b);
      if (r && r.side === side) return i;
    }
    return -1;
  }

  const LEVELS = {
    easy: { name: 'Легко', p: 0.35 },
    medium: { name: 'Средне', p: 0.75 },
    hard: { name: 'Непобедимый', p: 1 },
  };

  /**
   * Ход робота.
   *   easy   — чаще случайный ход
   *   medium — всегда добивает и блокирует, в остальном чаще лучший
   *   hard   — минимакс, не проигрывает
   */
  function chooseMove(board, side, level, rnd = Math.random) {
    const moves = free(board);
    if (!moves.length) return -1;
    const pick = (list) => list[Math.floor(rnd() * list.length) % list.length];
    if (level === 'medium') {
      const win = winningMove(board, side);
      if (win >= 0) return win;
      const block = winningMove(board, other(side));
      if (block >= 0) return block;
    }
    const p = (LEVELS[level] || LEVELS.hard).p;
    return rnd() < p ? pick(bestMoves(board, side)) : pick(moves);
  }

  /* =============================== геометрия =============================== */

  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Центр клетки 0..8 (0 — левая верхняя, А3) в координатах поля */
  function cellBoard(i, pitch) {
    const r = Math.floor(i / 3), c = i % 3;
    return { bx: (c - 1) * pitch, by: (1 - r) * pitch };
  }

  const rotOf = (cal) => rad((+cal.side || 0) + (+cal.turn || 0));

  /** Поле → рука. side: 0 — рука снизу поля и смотрит вверх, 90 — слева, 180 — сверху, 270 — справа */
  function boardToArm(bx, by, cal) {
    const t = rotOf(cal);
    const rx = bx * Math.cos(t) - by * Math.sin(t);
    const ry = bx * Math.sin(t) + by * Math.cos(t);
    return { u: +cal.cu + ry, v: +cal.cv - rx };
  }

  function armToBoard(u, v, cal) {
    const rx = +cal.cv - v;
    const ry = u - +cal.cu;
    const t = rotOf(cal);
    return { bx: rx * Math.cos(t) + ry * Math.sin(t), by: -rx * Math.sin(t) + ry * Math.cos(t) };
  }

  function armToPolar(u, v) {
    let a = 180 + deg(Math.atan2(v, u));
    if (a < 1) a += 360;
    return { x: Math.hypot(u, v), angel: a };
  }

  function polarToArm(x, angel) {
    const t = rad(angel - 180);
    return { u: x * Math.cos(t), v: x * Math.sin(t) };
  }

  /* ============================ команды руке ============================ */

  // POST /api/motors/pos/set: всё целое, gripper_state — bool
  const LIMITS = { x: [10, 300], z: [10, 300], angel: [1, 360], pov_gripper: [1, 300] };

  const SLOTS = 5; // гнёзд в лотке каждой руки
  const NEED_SLOTS = { X: 5, O: 4 }; // ✕ ходит первым: за партию ✕ ставит до 5 фигурок, ○ — до 4

  const cellName = (i) => 'АБВ'[i % 3] + (3 - Math.floor(i / 3));
  const slotName = (k) => 'гнездо ' + (k + 1);

  /** gripper_state для «схват закрыт»: что значит true — настройка руки gripTrue, как в пульте */
  const gripState = (cal, closed) => (cal.gripTrue === 'closed' ? !!closed : !closed);

  /**
   * Команда руке из точки { x, z, angel, pov, closed }. Поза хранит и closed (для логики),
   * и gripper_state (для backend). extra — служебные поля: target, stage, slot, trayTo.
   */
  function command(cal, p, label, extra) {
    const pov = p.pov !== undefined && p.pov !== null ? +p.pov : +cal.pov;
    return Object.assign({
      x: Math.round(+p.x), z: Math.round(+p.z), angel: Math.round(+p.angel), pov_gripper: Math.round(pov),
      closed: !!p.closed, gripper_state: gripState(cal, p.closed), label,
    }, extra);
  }

  /** Стоянка; closed — оставить схват закрытым (рука держит фигурку) */
  function park(cal, closed = false) {
    return command(cal, { x: cal.parkX, z: cal.parkZ, angel: cal.parkAngel, closed }, 'на стоянку', { target: 'park' });
  }

  /** Над центром клетки на высоте проезда — по геометрии поля; начальная точка для записи цепочки */
  function overCell(cal, cell, closed = false) {
    const c = cellBoard(cell, +cal.pitch);
    const a = boardToArm(c.bx, c.by, cal);
    const p = armToPolar(a.u, a.v);
    return command(cal, { x: p.x, z: cal.zSafe, angel: p.angel, closed }, 'над клеткой ' + cellName(cell), { target: 'c' + cell });
  }

  /** Подряд идущие одинаковые позы (после округления) не отправляем */
  function dedupe(list) {
    return list.filter((p, i) => !i || ['x', 'z', 'angel', 'pov_gripper', 'closed'].some((k) => p[k] !== list[i - 1][k]));
  }

  /* ============================ цепочки точек ============================ */

  /*
   * Цепочка — абсолютные точки { x, z, angel, pov, closed, line }, которые рука проходит по порядку.
   *   гнездо k (cal.slots[k]):  над гнездом, схват открыт → спуск → схват закрывается → подъём с фигуркой
   *   клетка i (cal.chains[i]): над клеткой с фигуркой → спуск → схват открывается → подъём
   * line — идти к точке по прямой от предыдущей (отрезок дробится с шагом step мм: рука двигается
   * по суставам, одной командой вышла бы дуга). Обратный проход той же цепочки — обратное действие:
   * клетка задом наперёд забирает фигурку, гнездо задом наперёд возвращает её в лоток.
   */
  const KINDS = { cell: 'chains', slot: 'slots' };
  const targetOf = (kind, i) => (kind === 'cell' ? 'c' : 's') + i;
  const placeName = (kind, i) => (kind === 'cell' ? 'клетка ' + cellName(i) : slotName(i));

  function chainOf(cal, kind, i) {
    const list = cal[KINDS[kind]];
    const c = Array.isArray(list) ? list[i] : null;
    return Array.isArray(c) && c.length ? c : null;
  }

  /** Точки задом наперёд: «по прямой» относится к отрезку, поэтому флаг переезжает на соседнюю точку */
  function reversePoints(pts) {
    const r = pts.slice().reverse();
    return r.map((p, k) => Object.assign({}, p, { line: k > 0 && !!r[k - 1].line }));
  }

  const povOf = (cal, p) => (p.pov !== undefined && p.pov !== null ? +p.pov : +cal.pov);

  function expand(cal, pts, name, extra) {
    const step = clamp(+cal.step || 10, 1, 50);
    const out = [];
    pts.forEach((p, k) => {
      const prev = pts[k - 1];
      if (p.line && prev) {
        const a = polarToArm(+prev.x, +prev.angel), b = polarToArm(+p.x, +p.angel);
        const dz = +p.z - +prev.z;
        const pa = povOf(cal, prev), pb = povOf(cal, p);
        const n = Math.max(1, Math.ceil(Math.hypot(b.u - a.u, b.v - a.v, dz) / step));
        for (let j = 1; j < n; j++) {
          const f = j / n;
          const q = armToPolar(a.u + (b.u - a.u) * f, a.v + (b.v - a.v) * f);
          // схват меняется только в самой точке, по дороге — как в предыдущей
          out.push(command(cal, { x: q.x, angel: q.angel, z: +prev.z + dz * f, pov: pa + (pb - pa) * f, closed: prev.closed }, name + ': по прямой к точке ' + (k + 1), extra));
        }
      }
      const grip = prev && !!prev.closed !== !!p.closed ? (p.closed ? 'схват закрывается' : 'схват открывается') : 'точка ' + (k + 1) + ' из ' + pts.length;
      out.push(command(cal, p, name + ': ' + grip, extra));
    });
    return out;
  }

  /** Команды по цепочке; reverse — задом наперёд (забрать из клетки / вернуть в гнездо) */
  function chainPlan(cal, kind, i, reverse = false) {
    let pts = chainOf(cal, kind, i) || [];
    if (reverse) pts = reversePoints(pts);
    return dedupe(expand(cal, pts, placeName(kind, i), { target: targetOf(kind, i) }));
  }

  /**
   * Отметить в плане, где фигурка меняет место: первая поза после смены схвата на closed.
   * runPlan, пройдя такую позу, записывает лоток: tray[slot] = trayTo.
   */
  function markTray(plan, closed, slot, trayTo, stage) {
    plan.forEach((p) => { p.stage = stage; });
    const k = plan.findIndex((p, j) => j > 0 && p.closed === closed && plan[j - 1].closed !== closed);
    if (k >= 0) Object.assign(plan[k], { slot, trayTo });
    return plan;
  }

  /**
   * Ход: взять фигурку из гнезда slot и поставить в клетку cell, затем стоянка.
   * opt.inHand — фигурка уже в схвате (прошлый ход сорвался после захвата): сразу к клетке.
   */
  function movePlan(cal, slot, cell, opt = {}) {
    const pick = opt.inHand ? [] : markTray(chainPlan(cal, 'slot', slot), true, slot, 'hand', 'pick');
    const place = markTray(chainPlan(cal, 'cell', cell), false, slot, cell, 'place');
    const out = pick.concat(place);
    if (opt.park !== false) out.push(Object.assign(park(cal), { stage: 'park' }));
    return dedupe(out);
  }

  /** Уборка: забрать фигурку из клетки cell (null — она уже в схвате) и вернуть в гнездо slot */
  function returnPlan(cal, cell, slot, opt = {}) {
    const pick = cell === null ? [] : markTray(chainPlan(cal, 'cell', cell, true), true, slot, 'hand', 'pick');
    const place = markTray(chainPlan(cal, 'slot', slot, true), false, slot, null, 'place');
    const out = pick.concat(place);
    if (opt.park !== false) out.push(Object.assign(park(cal), { stage: 'park' }));
    return dedupe(out);
  }

  /**
   * Ошибка цепочки или null (нет цепочки — тоже null, это проверяет вызывающий).
   * Начало и конец — не ниже высоты проезда; схват меняется ровно один раз: к гнезду рука
   * приходит пустой и уносит фигурку, к клетке — наоборот. Все команды, включая точки прямых, — в рабочей зоне.
   */
  function checkChain(cal, kind, i) {
    const pts = chainOf(cal, kind, i);
    if (!pts) return null;
    if (pts.length < 2) return 'в цепочке меньше двух точек';
    const H = Math.round(+cal.zSafe);
    const first = pts[0], last = pts[pts.length - 1];
    if (+first.z < H) return 'первая точка (z ' + first.z + ') ниже высоты проезда ' + H + ' — цепочка должна начинаться сверху';
    if (+last.z < H) return 'последняя точка (z ' + last.z + ') ниже высоты проезда ' + H + ' — цепочка должна заканчиваться сверху';
    const slot = kind === 'slot';
    if (!!first.closed !== !slot) return slot ? 'в начале схват должен быть открыт — рука приходит за фигуркой пустой' : 'в начале схват должен быть закрыт — рука приносит фигурку';
    if (!!last.closed !== slot) return slot ? 'в конце схват должен быть закрыт — рука уносит фигурку' : 'в конце схват должен быть открыт — фигурка остаётся в клетке';
    const changes = pts.filter((p, k) => k && !!p.closed !== !!pts[k - 1].closed).length;
    if (changes !== 1) return 'схват должен ' + (slot ? 'закрыться' : 'открыться') + ' один раз, а меняется ' + changes + ' раза';
    for (const p of chainPlan(cal, kind, i)) {
      const e = checkPose(p);
      if (e) return p.label + ': ' + e;
    }
    return null;
  }

  /**
   * Черновик цепочки от точки захвата / установки bottom { x, z, angel, pov }: над ней на высоте проезда
   * (и не ниже bottom + 30 мм) → по прямой вниз → схват → по прямой вверх.
   */
  function draftChain(cal, kind, bottom) {
    const zb = Math.round(+bottom.z);
    const b = { x: Math.round(+bottom.x), z: zb, angel: Math.round(+bottom.angel), pov: Math.round(povOf(cal, bottom)) };
    const up = Object.assign({}, b, { z: Math.max(Math.round(+cal.zSafe), zb + 30) });
    const carry = kind === 'cell'; // к клетке рука приходит с фигуркой
    return [
      Object.assign({}, up, { closed: carry, line: false }),
      Object.assign({}, b, { closed: carry, line: true }),
      Object.assign({}, b, { closed: !carry, line: false }),
      Object.assign({}, up, { closed: !carry, line: true }),
    ];
  }

  /** Нижняя точка цепочки — где стоит фигурка (для схемы стола) */
  function chainBottom(cal, kind, i) {
    const pts = chainOf(cal, kind, i);
    if (!pts) return null;
    return pts.reduce((m, p) => (+p.z < +m.z ? p : m), pts[0]);
  }

  /** Ошибка позы или null */
  function checkPose(p) {
    const names = { x: 'вылет', z: 'высота', angel: 'угол базы', pov_gripper: 'поворот схвата' };
    for (const k of Object.keys(LIMITS)) {
      const [lo, hi] = LIMITS[k];
      if (!(p[k] >= lo && p[k] <= hi)) return names[k] + ' ' + p[k] + ' вне ' + lo + '–' + hi;
    }
    if (typeof p.gripper_state !== 'boolean') return 'не задано состояние схвата';
    const Kin = root.Kin;
    if (!Kin) return null;
    if (!Kin.isReachable(p.x, p.z, p.angel)) return 'точка x ' + p.x + ', z ' + p.z + ' недостижима';
    // рамки из docs/ik.md: ik.py их не проверяет, держим здесь
    if (Kin.WORK && !Kin.inWorkZone(p.x, p.z, p.angel)) {
      const W = Kin.WORK;
      if (p.x < W.x[0]) return 'вылет ' + p.x + ' мм ближе упора в базу (' + W.x[0] + ')';
      if (p.angel < W.angle[0] || p.angel > W.angle[1]) return 'угол базы ' + p.angel + '° вне ' + W.angle[0] + '–' + W.angle[1];
      return 'точка x ' + p.x + ', z ' + p.z + ' вне рабочей зоны';
    }
    return null;
  }

  /**
   * Проверка руки side: цепочки всех клеток и гнёзд, стоянка, высота проезда.
   * { cells: [ошибка|null ×9], slots: [ошибка|null ×5], park, list — ошибки, todo — что ещё не записано, ready }
   */
  function checkCalibration(cal, side) {
    const list = [], todo = [];
    const need = NEED_SLOTS[side] || SLOTS;
    const run = (kind, n, name) => {
      const errs = [], missing = [];
      for (let i = 0; i < n; i++) {
        const e = checkChain(cal, kind, i);
        errs.push(e);
        if (e) list.push(name(i) + ': ' + e);
        if (!chainOf(cal, kind, i)) missing.push(i);
      }
      return { errs, missing };
    };
    const cells = run('cell', 9, (i) => 'Клетка ' + cellName(i));
    const slots = run('slot', SLOTS, (k) => 'Гнездо ' + (k + 1));
    if (cells.missing.length) todo.push('Нет цепочек клеток: ' + cells.missing.map(cellName).join(', '));
    const needMissing = slots.missing.filter((k) => k < need);
    if (needMissing.length) todo.push('Нет цепочек гнёзд: ' + needMissing.map((k) => k + 1).join(', ') + ' (нужно ' + need + ')');
    const pk = checkPose(park(cal));
    if (pk) list.push('Стоянка: ' + pk);
    if (!(+cal.zSafe >= LIMITS.z[0] && +cal.zSafe <= LIMITS.z[1])) list.push('Высота проезда ' + cal.zSafe + ' вне ' + LIMITS.z.join('–') + ' мм');
    return { cells: cells.errs, slots: slots.errs, park: pk, list, todo, ready: !list.length && !todo.length };
  }

  /* ================================ лотки ================================ */

  /*
   * Лоток руки — SLOTS гнёзд; tray[k]: null — фигурка в гнезде, 0…8 — стоит в клетке, 'hand' — в схвате.
   * Сохраняется, чтобы после перезагрузки страницы руки знали, что убирать.
   */
  const emptyTray = () => ({ X: Array(SLOTS).fill(null), O: Array(SLOTS).fill(null) });

  function normalizeTray(saved) {
    const t = emptyTray();
    for (const side of ['X', 'O']) {
      const src = saved && Array.isArray(saved[side]) ? saved[side] : [];
      for (let k = 0; k < SLOTS; k++) {
        const v = src[k];
        t[side][k] = v === 'hand' || (Number.isInteger(v) && v >= 0 && v < 9) ? v : null;
      }
    }
    return t;
  }

  /** Откуда брать фигурку: та, что уже в схвате, иначе первое полное гнездо; slot −1 — лоток пуст */
  function nextSlot(tray) {
    const h = tray.indexOf('hand');
    return h >= 0 ? { slot: h, inHand: true } : { slot: tray.indexOf(null), inHand: false };
  }

  /** Поле по фигуркам из лотков; null — расклад невозможен (две фигурки в клетке, неверный счёт) */
  function boardFromTray(tray) {
    const b = Array(9).fill(null);
    for (const side of ['X', 'O']) {
      for (const v of tray[side]) {
        if (!Number.isInteger(v)) continue;
        if (b[v]) return null;
        b[v] = side;
      }
    }
    const x = b.filter((v) => v === 'X').length, o = b.filter((v) => v === 'O').length;
    return x === o || x === o + 1 ? b : null;
  }

  /* ============================== калибровка ============================== */

  /** Калибровка по умолчанию без стороны (side 0); сторону руки задаёт DEFAULT_SIDE — см. defaultCal */
  const DEFAULT_CAL = {
    side: 0, turn: 0, cu: 200, cv: 0, pitch: 50,
    zSafe: 150, // высота проезда: цепочки начинаются и кончаются не ниже, переезды — на ней
    step: 10, pov: 150, gripTrue: 'open', // gripper_state = true — схват открыт (как в пульте)
    parkX: 160, parkZ: 200, parkAngel: 260,
  };

  /** Где стоят руки на столе: рука ✕ у левого края поля, рука ○ у правого */
  const DEFAULT_SIDE = { X: 90, O: 270 };

  // поля рисования маркером — до перехода на фигурки
  const OLD_KEYS = ['zDraw', 'liftTravel', 'liftApproach', 'zTilt', 'size', 'paintPov', 'markerA', 'markerB', 'paintMid', 'paintFrom', 'paintTo', 'fix', 'zTravel', 'zApproach'];

  /**
   * Калибровка времён рисования маркером → фигурки. Геометрия поля и стоянка остаются;
   * цепочки рисования (точки с paint_pov) к фигуркам не подходят — удаляются. Возвращает { cal, dropped }.
   */
  function migrateCal(saved) {
    if (!saved || typeof saved !== 'object') return { cal: saved, dropped: false };
    const c = Object.assign({}, saved);
    OLD_KEYS.forEach((k) => delete c[k]);
    const painted = Array.isArray(c.chains) && c.chains.some((pts) => Array.isArray(pts) && pts.some((p) => p && 'paint_pov' in p));
    if (painted) c.chains = Array(9).fill(null);
    return { cal: c, dropped: painted };
  }

  /** Копия калибровки по умолчанию для руки side ('X' | 'O'); цепочки — свои массивы на каждую копию */
  const defaultCal = (side) => Object.assign({}, DEFAULT_CAL, {
    side: DEFAULT_SIDE[side],
    chains: Array(9).fill(null), // клетки: поставить фигурку
    slots: Array(SLOTS).fill(null), // гнёзда лотка: взять фигурку
  });

  const api = {
    LINES, other, result, free, turnOf, minimax, bestMoves, winningMove, chooseMove, LEVELS,
    cellBoard, boardToArm, armToBoard, armToPolar, polarToArm, cellName, slotName,
    SLOTS, NEED_SLOTS, LIMITS, gripState, command, park, overCell, targetOf,
    chainOf, chainPlan, reversePoints, movePlan, returnPlan, checkChain, draftChain, chainBottom,
    checkPose, checkCalibration, emptyTray, normalizeTray, nextSlot, boardFromTray,
    DEFAULT_CAL, DEFAULT_SIDE, defaultCal, migrateCal,
  };
  root.TTT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
