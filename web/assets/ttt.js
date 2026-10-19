/*
 * Крестики-нолики: правила, ход робота и геометрия рисования маркером.
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

  /** Предел поправки клетки: дальше 40 % шага знак полезет в соседнюю клетку */
  const FIX_MAX = 0.4;

  /** Поправка центра клетки i по листу, мм: [вправо, вверх]. Нет поправки — [0, 0] */
  function cellFix(cal, i) {
    const f = cal.fix && cal.fix[i];
    return Array.isArray(f) && Number.isFinite(+f[0]) && Number.isFinite(+f[1]) ? [+f[0], +f[1]] : [0, 0];
  }

  /** Центр клетки i с поправкой — куда рука ставит маркер на этом листе */
  function cellCenter(cal, i) {
    const c = cellBoard(i, +cal.pitch);
    const [dx, dy] = cellFix(cal, i);
    return { bx: c.bx + dx, by: c.by + dy };
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

  /* ============================ штрихи знаков ============================ */

  /** Ломаная с шагом не больше step мм между точками */
  function densify(pts, step) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.bx - a.bx, b.by - a.by) / step));
      for (let k = 1; k <= n; k++) out.push({ bx: a.bx + ((b.bx - a.bx) * k) / n, by: a.by + ((b.by - a.by) * k) / n });
    }
    return out;
  }

  /** Штрихи знака в координатах поля: крестик — две диагонали, нолик — окружность */
  function markStrokes(cell, mark, cal) {
    const c = cellCenter(cal, cell);
    const h = (+cal.pitch * clamp(+cal.size || 0.6, 0.2, 0.9)) / 2;
    const step = clamp(+cal.step || 4, 1, 20);
    if (mark === 'X') {
      return [
        densify([{ bx: c.bx - h, by: c.by + h }, { bx: c.bx + h, by: c.by - h }], step),
        densify([{ bx: c.bx + h, by: c.by + h }, { bx: c.bx - h, by: c.by - h }], step),
      ];
    }
    const n = Math.max(12, Math.ceil((2 * Math.PI * h) / step));
    const ring = [];
    for (let k = 0; k <= n + 1; k++) { // +1: небольшой нахлёст, чтобы кольцо замкнулось
      const t = Math.PI / 2 + (2 * Math.PI * k) / n;
      ring.push({ bx: c.bx + h * Math.cos(t), by: c.by + h * Math.sin(t) });
    }
    return [ring];
  }

  /* ============================ план движения ============================ */

  const LIMITS = { x: [10, 300], z: [10, 300], angel: [1, 360], pov_gripper: [1, 300] };

  /** Высота касания с поправкой на вылет: жёсткая насадка не прощает неровностей */
  function drawZ(x, cal) {
    return +cal.zDraw + (+cal.zTilt || 0) * ((x - +cal.cu) / 100);
  }

  function pose(pt, z, cal, label) {
    const a = boardToArm(pt.bx, pt.by, cal);
    const p = armToPolar(a.u, a.v);
    return {
      x: Math.round(p.x),
      z: Math.round(z === 'draw' ? drawZ(p.x, cal) : z),
      angel: Math.round(p.angel),
      pov_gripper: clamp(Math.round(+cal.pov), 1, 300),
      grip: !!cal.grip,
      label,
    };
  }

  function park(cal) {
    return { x: Math.round(+cal.parkX), z: Math.round(+cal.parkZ), angel: Math.round(+cal.parkAngel), pov_gripper: clamp(Math.round(+cal.pov), 1, 300), grip: !!cal.grip, label: 'на стоянку' };
  }

  /** Подряд идущие одинаковые позы (после округления) не отправляем */
  function dedupe(list) {
    return list.filter((p, i) => !i || ['x', 'z', 'angel', 'pov_gripper', 'grip'].some((k) => p[k] !== list[i - 1][k]));
  }

  /**
   * Нарисовать знак mark ('X' | 'O') в клетке cell.
   * Возвращает позы — каждая одна команда руке.
   */
  function drawPlan(cal, cell, mark, withPark = true) {
    const T = +cal.zTravel;
    const out = [];
    const strokes = markStrokes(cell, mark, cal);
    strokes.forEach((s, si) => {
      const name = mark === 'X' ? 'линия ' + (si + 1) + ' из 2' : 'окружность';
      out.push(pose(s[0], T, cal, 'к клетке ' + cellName(cell)));
      out.push(pose(s[0], 'draw', cal, 'маркер вниз'));
      for (let k = 1; k < s.length; k++) out.push(pose(s[k], 'draw', cal, 'рисует: ' + name));
      out.push(pose(s[s.length - 1], T, cal, 'маркер вверх'));
    });
    if (withPark) out.push(park(cal));
    return dedupe(out);
  }

  /** Над центром клетки; touch — опустить маркер до касания */
  function cellPlan(cal, cell, touch) {
    const c = cellCenter(cal, cell);
    const list = [pose(c, +cal.zTravel, cal, 'над клеткой ' + cellName(cell))];
    if (touch) list.push(pose(c, 'draw', cal, 'касание'));
    return list;
  }

  /** Ошибка позы или null */
  function checkPose(p) {
    const names = { x: 'вылет', z: 'высота', angel: 'угол базы', pov_gripper: 'поворот схвата' };
    for (const k of Object.keys(LIMITS)) {
      const [lo, hi] = LIMITS[k];
      if (!(p[k] >= lo && p[k] <= hi)) return names[k] + ' ' + p[k] + ' вне ' + lo + '–' + hi;
    }
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

  /** Проверка калибровки: оба знака во всех клетках и стоянка. Возвращает { cells: [ошибка|null ×9], park, list } */
  function checkCalibration(cal) {
    const cells = [];
    const list = [];
    for (let i = 0; i < 9; i++) {
      let err = null;
      for (const mark of ['X', 'O']) {
        for (const p of drawPlan(cal, i, mark, false)) { err = checkPose(p); if (err) break; }
        if (err) break;
      }
      cells.push(err);
      if (err) list.push('Клетка ' + cellName(i) + ': ' + err);
      const [dx, dy] = cellFix(cal, i);
      if (Math.max(Math.abs(dx), Math.abs(dy)) > FIX_MAX * +cal.pitch) {
        list.push('Клетка ' + cellName(i) + ': поправка ' + dx + ', ' + dy + ' мм больше ' + Math.round(FIX_MAX * +cal.pitch) + ' — проверьте центр поля и шаг клетки');
      }
    }
    const pk = checkPose(park(cal));
    if (pk) list.push('Стоянка: ' + pk);
    if (!(+cal.zTravel > +cal.zDraw + 15)) list.push('Высота проезда должна быть хотя бы на 15 мм выше касания');
    return { cells, park: pk, list };
  }

  const cellName = (i) => 'АБВ'[i % 3] + (3 - Math.floor(i / 3));

  /** Калибровка по умолчанию без стороны (side 0); сторону руки задаёт DEFAULT_SIDE — см. defaultCal */
  const DEFAULT_CAL = {
    side: 0, turn: 0, cu: 200, cv: 0, pitch: 50,
    zTravel: 60, zDraw: 20, zTilt: 0,
    size: 0.6, step: 4, pov: 150, grip: false,
    parkX: 160, parkZ: 200, parkAngel: 260,
  };

  /** Где стоят руки на столе: лист вертикальный, рука ✕ у левого края, рука ○ у правого */
  const DEFAULT_SIDE = { X: 90, O: 270 };

  /** Копия калибровки по умолчанию для руки side ('X' | 'O'); поправки клеток — свой массив на каждую копию */
  const defaultCal = (side) => Object.assign({}, DEFAULT_CAL, { side: DEFAULT_SIDE[side], fix: Array.from({ length: 9 }, () => [0, 0]) });

  const api = {
    LINES, other, result, free, turnOf, minimax, bestMoves, winningMove, chooseMove, LEVELS,
    cellBoard, cellFix, cellCenter, FIX_MAX, boardToArm, armToBoard, armToPolar, polarToArm, markStrokes,
    drawPlan, cellPlan, park, checkPose, checkCalibration, cellName, DEFAULT_CAL,
    DEFAULT_SIDE, defaultCal,
  };
  root.TTT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
