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

  /**
   * Поправка клетки в осях руки: { x — вылет, мм; z — высота касания, мм; a — поворот базы, ° }.
   * Прибавляется к каждой команде этой клетки: наведение, касание, штрихи знака.
   * Предел FIX_LIMITS — дальше неверны уже центр поля, шаг или высота касания.
   */
  const FIX_LIMITS = { x: 20, z: 10, a: 8 };
  const NO_FIX = { x: 0, z: 0, a: 0 };

  function cellFix(cal, i) {
    const f = cal.fix && cal.fix[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) return Object.assign({}, NO_FIX);
    const n = (v) => (Number.isFinite(+v) ? Math.round(+v) : 0);
    return { x: n(f.x), z: n(f.z), a: n(f.a) };
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
    const c = cellBoard(cell, +cal.pitch);
    const h = (+cal.pitch * clamp(+cal.size || 0.6, 0.2, 0.9)) / 2;
    const step = clamp(+cal.step || 4, 1, 20);
    if (mark === 'X') {
      return [
        densify([{ bx: c.bx - h, by: c.by + h }, { bx: c.bx + h, by: c.by - h }], step),
        densify([{ bx: c.bx + h, by: c.by + h }, { bx: c.bx - h, by: c.by - h }], step),
      ];
    }
    // ○ рисует поворот paint_pov: кончик маркера ходит по кругу радиусом смещения вокруг оси в центре клетки
    const r = markerRadius(cal) || h;
    const n = Math.max(12, Math.ceil((2 * Math.PI * r) / step));
    const ring = [];
    for (let k = 0; k <= n; k++) {
      const t = Math.PI / 2 + (2 * Math.PI * k) / n;
      ring.push({ bx: c.bx + r * Math.cos(t), by: c.by + r * Math.sin(t) });
    }
    return [ring];
  }

  /* ============================ план движения ============================ */

  // paint_pov — поле /pos/set-paint (по умолчанию 50), диапазон как у pov_gripper
  const LIMITS = { x: [10, 300], z: [10, 300], angel: [1, 360], pov_gripper: [1, 300], paint_pov: [1, 300] };

  /**
   * Высоты схвата (z команды), мм. Касание zDraw — абсолютное, подбирается на руке;
   * проезд и подход — подъём кончика маркера над листом, поэтому от длины маркера не зависят.
   */
  function heights(cal) {
    const d = +cal.zDraw;
    return { draw: d, travel: d + +cal.liftTravel, approach: d + +cal.liftApproach };
  }

  /** Высота касания с поправкой на вылет: жёсткая насадка не прощает неровностей */
  function drawZ(x, cal) {
    return +cal.zDraw + (+cal.zTilt || 0) * ((x - +cal.cu) / 100);
  }

  /* ======================= маркер смещён от оси paint_pov ======================= */

  /** Радиус круга, который описывает кончик маркера при повороте paint_pov, мм */
  const markerRadius = (cal) => Math.hypot(+cal.markerA || 0, +cal.markerB || 0);

  /**
   * Кончик маркера смещён от оси поворота paint_pov: при paint_pov = cal.paintPov он на markerA мм
   * дальше от базы и на markerB мм левее оси (если смотреть от базы вдоль руки). Смещение поворачивается
   * вместе с базой, поэтому ось ставим так, чтобы в точку (u, v) попал именно кончик:
   * кончик = (ρ + a)·e(t) + b·e⊥(t)  ⇒  ρ = √(R² − b²) − a,  t = ψ − atan2(b, ρ + a).
   * Возвращает ось (u, v) или null, если точка ближе к оси базы, чем смещение поперёк.
   */
  function tipToAxis(u, v, cal) {
    const a = +cal.markerA || 0, b = +cal.markerB || 0;
    if (!a && !b) return { u, v };
    const R = Math.hypot(u, v);
    if (R <= Math.abs(b)) return null;
    const rho = Math.sqrt(R * R - b * b) - a;
    const t = Math.atan2(v, u) - Math.atan2(b, rho + a);
    return { u: rho * Math.cos(t), v: rho * Math.sin(t) };
  }

  /** Где окажется кончик маркера при оси в (u, v) и paint_pov = cal.paintPov (обратное к tipToAxis) */
  function axisToTip(u, v, cal) {
    const a = +cal.markerA || 0, b = +cal.markerB || 0;
    const t = Math.atan2(v, u), rho = Math.hypot(u, v);
    return { u: (rho + a) * Math.cos(t) - b * Math.sin(t), v: (rho + a) * Math.sin(t) + b * Math.cos(t) };
  }

  /**
   * Поза над точкой поля; fix — поправка клетки (высота — только для касания и рисования).
   * По умолчанию в точку ставится кончик маркера; opt.axis — ось paint_pov (круг ○), opt.paint — свой paint_pov.
   */
  function pose(pt, z, cal, label, fix = NO_FIX, opt = {}) {
    const a = boardToArm(pt.bx, pt.by, cal);
    const ax = opt.axis ? a : tipToAxis(a.u, a.v, cal);
    const p = ax ? armToPolar(ax.u, ax.v) : { x: NaN, angel: NaN };
    const x = p.x + fix.x;
    return {
      x: Math.round(x),
      z: Math.round(z === 'draw' ? drawZ(x, cal) + fix.z : z),
      angel: Math.round(p.angel + fix.a),
      pov_gripper: clamp(Math.round(+cal.pov), 1, 300),
      paint_pov: Math.round(opt.paint !== undefined ? +opt.paint : +cal.paintPov),
      label,
    };
  }

  function park(cal) {
    return { x: Math.round(+cal.parkX), z: Math.round(+cal.parkZ), angel: Math.round(+cal.parkAngel), pov_gripper: clamp(Math.round(+cal.pov), 1, 300), paint_pov: Math.round(+cal.paintPov), label: 'на стоянку' };
  }

  /** Подряд идущие одинаковые позы (после округления) не отправляем */
  function dedupe(list) {
    return list.filter((p, i) => !i || ['x', 'z', 'angel', 'pov_gripper', 'paint_pov'].some((k) => p[k] !== list[i - 1][k]));
  }

  /**
   * Нарисовать знак mark ('X' | 'O') в клетке cell.
   * Возвращает позы — каждая одна команда руке; у каждой поле cell — над какой клеткой рука.
   * К клетке и от неё рука идёт на высоте подхода и опускается/поднимается вертикально:
   * поворот базы на низкой высоте — риск задеть маркером стол. Внутри клетки — высота проезда.
   */
  function drawPlan(cal, cell, mark, withPark = true) {
    if (chainOf(cal, cell)) return chainPlan(cal, cell, withPark);
    const { travel: T, approach: A } = heights(cal);
    const f = cellFix(cal, cell);
    const P = (pt, z, label, opt) => Object.assign(pose(pt, z, cal, label, f, opt), { cell });
    const out = [];
    if (mark === 'O') {
      // ○ — поворотом paint_pov: ось в центре клетки, рука стоит, маркер обходит круг сам.
      // Два прохода от середины: сначала влево (к paintFrom), потом вправо (к paintTo) —
      // обратно через середину по уже нарисованной дуге, маркер не поднимается
      const c = cellBoard(cell, +cal.pitch);
      const mid = +cal.paintMid, from = +cal.paintFrom, to = +cal.paintTo;
      const ax = (z, label, paint) => P(c, z, label, { axis: true, paint });
      out.push(ax(A, 'подход к клетке ' + cellName(cell), mid));
      out.push(ax(T, 'над клеткой ' + cellName(cell), mid));
      out.push(ax('draw', 'маркер вниз', mid));
      out.push(ax('draw', 'рисует: окружность влево (paint_pov ' + Math.round(mid) + ' → ' + Math.round(from) + ')', from));
      out.push(ax('draw', 'рисует: окружность вправо (paint_pov ' + Math.round(from) + ' → ' + Math.round(to) + ')', to));
      out.push(ax(T, 'маркер вверх', to));
      out.push(ax(A, 'отход вверх', to));
      if (withPark) out.push(park(cal));
      return dedupe(out);
    }
    const strokes = markStrokes(cell, mark, cal);
    out.push(P(strokes[0][0], A, 'подход к клетке ' + cellName(cell)));
    strokes.forEach((s, si) => {
      const name = mark === 'X' ? 'линия ' + (si + 1) + ' из 2' : 'окружность';
      out.push(P(s[0], T, si ? 'к началу линии ' + (si + 1) : 'над клеткой ' + cellName(cell)));
      out.push(P(s[0], 'draw', 'маркер вниз'));
      for (let k = 1; k < s.length; k++) out.push(P(s[k], 'draw', 'рисует: ' + name));
      out.push(P(s[s.length - 1], T, 'маркер вверх'));
    });
    const end = strokes[strokes.length - 1];
    out.push(P(end[end.length - 1], A, 'отход вверх'));
    if (withPark) out.push(park(cal));
    return dedupe(out);
  }

  /**
   * Над центром клетки: подход сверху (approach) → высота проезда; touch — ещё и опустить маркер до касания.
   * approach = false — рука уже над этой клеткой, подниматься на высоту подхода незачем.
   */
  function cellPlan(cal, cell, touch, approach = true) {
    const c = cellBoard(cell, +cal.pitch);
    const f = cellFix(cal, cell);
    const P = (z, label) => Object.assign(pose(c, z, cal, label, f), { cell });
    const h = heights(cal);
    const list = [];
    if (approach) list.push(P(h.approach, 'подход к клетке ' + cellName(cell)));
    list.push(P(h.travel, 'над клеткой ' + cellName(cell)));
    if (touch) list.push(P('draw', 'касание'));
    return list;
  }

  /* ============================ цепочки точек ============================ */

  /*
   * Цепочка клетки — абсолютные команды руке, которые она проходит по порядку: зависание над полем,
   * спуск, рисование знака, подъём. Точка: { x, z, angel, paint_pov, line }; line — идти к ней по прямой
   * (отрезок дробится с шагом step мм: рука двигается по суставам, одной командой вышла бы дуга),
   * иначе — одной командой. Цепочка своя у каждой клетки и руки; нет цепочки — рисуется по расчёту.
   */
  function chainOf(cal, cell) {
    const c = cal.chains && cal.chains[cell];
    return Array.isArray(c) && c.length ? c : null;
  }

  function chainPose(cal, cell, p, label) {
    return {
      x: Math.round(+p.x), z: Math.round(+p.z), angel: Math.round(+p.angel),
      pov_gripper: clamp(Math.round(+cal.pov), 1, 300), paint_pov: Math.round(+p.paint_pov), label, cell,
    };
  }

  /** Команды по цепочке клетки (+ стоянка) */
  function chainPlan(cal, cell, withPark = true) {
    const pts = chainOf(cal, cell) || [];
    const step = clamp(+cal.step || 4, 1, 20);
    const out = [];
    pts.forEach((p, k) => {
      const name = 'точка ' + (k + 1) + ' из ' + pts.length;
      const prev = pts[k - 1];
      if (p.line && prev) {
        const a = polarToArm(+prev.x, +prev.angel), b = polarToArm(+p.x, +p.angel);
        const dz = +p.z - +prev.z, dp = +p.paint_pov - +prev.paint_pov;
        const n = Math.max(1, Math.ceil(Math.hypot(b.u - a.u, b.v - a.v, dz) / step));
        for (let j = 1; j < n; j++) {
          const f = j / n;
          const q = armToPolar(a.u + (b.u - a.u) * f, a.v + (b.v - a.v) * f);
          out.push(chainPose(cal, cell, { x: q.x, angel: q.angel, z: +prev.z + dz * f, paint_pov: +prev.paint_pov + dp * f }, 'линия к точке ' + (k + 1)));
        }
      }
      out.push(chainPose(cal, cell, p, name));
    });
    if (withPark) out.push(park(cal));
    return dedupe(out);
  }

  /** Ошибка цепочки клетки или null: начало и конец — над листом, все команды — в рабочей зоне */
  function checkChain(cal, cell) {
    const pts = chainOf(cal, cell);
    if (!pts) return null;
    if (pts.length < 2) return 'в цепочке меньше двух точек';
    const T = Math.round(heights(cal).travel);
    if (+pts[0].z < T) return 'первая точка (z ' + pts[0].z + ') ниже высоты проезда ' + T + ' — цепочка должна начинаться над листом';
    if (+pts[pts.length - 1].z < T) return 'последняя точка (z ' + pts[pts.length - 1].z + ') ниже высоты проезда ' + T + ' — цепочка должна заканчиваться над листом';
    for (const p of chainPlan(cal, cell, false)) {
      const e = checkPose(p);
      if (e) return p.label + ': ' + e;
    }
    return null;
  }

  /**
   * Черновик цепочки по текущей калибровке — чтобы не начинать с нуля: ✕ — зависание, по каждой линии
   * спуск → линия до конца → подъём, отход вверх; ○ — те же команды, что при рисовании по расчёту.
   */
  function draftChain(cal, cell, mark) {
    const base = Object.assign({}, cal, { chains: [] });
    const pt = (q, line) => ({ x: q.x, z: q.z, angel: q.angel, paint_pov: q.paint_pov, line: !!line });
    if (mark === 'O') return drawPlan(base, cell, 'O', false).map((q) => pt(q, false));
    const { travel: T, approach: A } = heights(base);
    const f = cellFix(base, cell);
    const P = (b, z) => pose(b, z, base, '', f);
    const strokes = markStrokes(cell, 'X', base);
    const out = [pt(P(strokes[0][0], A))];
    for (const st of strokes) {
      const end = st[st.length - 1];
      out.push(pt(P(st[0], T)), pt(P(st[0], 'draw')), pt(P(end, 'draw'), true), pt(P(end, T)));
    }
    const last = strokes[strokes.length - 1];
    out.push(pt(P(last[last.length - 1], A)));
    return out.filter((q, i) => !i || ['x', 'z', 'angel', 'paint_pov'].some((k) => q[k] !== out[i - 1][k]));
  }

  /** Ошибка позы или null */
  function checkPose(p) {
    const names = { x: 'вылет', z: 'высота', angel: 'угол базы', pov_gripper: 'поворот схвата', paint_pov: 'paint_pov' };
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

  /**
   * Проверка калибровки: оба знака во всех клетках и стоянка.
   * Возвращает { cells: [ошибка|null ×9], park, list — ошибки, todo — что ещё не откалибровано }
   */
  function checkCalibration(cal) {
    const cells = [];
    const list = [];
    for (let i = 0; i < 9; i++) {
      let err = null;
      for (const mark of ['X', 'O']) {
        for (const p of drawPlan(cal, i, mark, false)) { err = checkPose(p); if (err) break; }
        if (err) break;
      }
      const ce = checkChain(cal, i);
      if (ce) err = 'цепочка: ' + ce;
      cells.push(err);
      if (err) list.push('Клетка ' + cellName(i) + ': ' + err);
      const f = cellFix(cal, i);
      // у клетки с цепочкой поправка не используется
      const over = chainOf(cal, i) ? [] : Object.keys(FIX_LIMITS).filter((k) => Math.abs(f[k]) > FIX_LIMITS[k]);
      if (over.length) {
        const names = { x: 'вылет', z: 'высота', a: 'база' };
        list.push('Клетка ' + cellName(i) + ': поправка ' + over.map((k) => names[k] + ' ' + f[k] + ' (предел ±' + FIX_LIMITS[k] + ')').join(', ') + ' — проверьте центр поля, шаг и высоту касания');
      }
    }
    const pk = checkPose(park(cal));
    if (pk) list.push('Стоянка: ' + pk);
    if (!(+cal.liftTravel >= 15)) list.push('Подъём между штрихами — хотя бы 15 мм над листом');
    const r = markerRadius(cal);
    if (2 * r > 0.9 * +cal.pitch) list.push('Круг ○ диаметром ' + Math.round(2 * r) + ' мм не помещается в клетку ' + cal.pitch + ' мм — проверьте смещение маркера');
    if (!(+cal.paintFrom < +cal.paintMid && +cal.paintMid < +cal.paintTo)) {
      list.push('Круг ○: paint_pov должен идти «влево до» < «середина» < «вправо до» (сейчас ' + cal.paintFrom + ', ' + cal.paintMid + ', ' + cal.paintTo + ')');
    }
    const todo = [];
    if (r < 3) todo.push('Смещение маркера от оси не задано: ○ рисуется поворотом paint_pov и без смещения выйдет точкой, ✕ — без компенсации смещения');
    if (!(+cal.liftApproach >= +cal.liftTravel)) list.push('Подъём при подходе к клетке должен быть не меньше подъёма между штрихами');
    return { cells, park: pk, list, todo };
  }

  const cellName = (i) => 'АБВ'[i % 3] + (3 - Math.floor(i / 3));

  /** Калибровка по умолчанию без стороны (side 0); сторону руки задаёт DEFAULT_SIDE — см. defaultCal */
  const DEFAULT_CAL = {
    side: 0, turn: 0, cu: 200, cv: 0, pitch: 50,
    // маркер торчит из держателя на 60 мм: кончик касается листа примерно при z схвата = 60
    zDraw: 60, liftTravel: 40, liftApproach: 100, zTilt: 0,
    size: 0.6, step: 4, pov: 150, paintPov: 50,
    // смещение кончика маркера от оси paint_pov при paint_pov = paintPov;
    // круг ○ — поворот paint_pov от середины влево до paintFrom, затем вправо до paintTo
    markerA: 0, markerB: 0, paintMid: 150, paintFrom: 1, paintTo: 300,
    parkX: 160, parkZ: 200, parkAngel: 260,
  };

  /** Где стоят руки на столе: лист вертикальный, рука ✕ у левого края, рука ○ у правого */
  const DEFAULT_SIDE = { X: 90, O: 270 };

  /**
   * Сохранённая калибровка старого формата (абсолютные zTravel / zApproach) → подъёмы над листом.
   * Касание z = 20 — старое значение по умолчанию для схвата без маркера: с маркером 60 мм оно вдавило бы
   * маркер в стол, поэтому поднимаем до нового значения по умолчанию. Возвращает { cal, touchReset }.
   */
  function migrateCal(saved) {
    if (!saved || typeof saved !== 'object') return { cal: saved, touchReset: false };
    const c = Object.assign({}, saved);
    const old = !('liftTravel' in c) && ('zTravel' in c || 'zDraw' in c);
    let touchReset = false;
    if (old) {
      const d = Number.isFinite(+c.zDraw) ? +c.zDraw : DEFAULT_CAL.zDraw;
      c.liftTravel = Number.isFinite(+c.zTravel) ? Math.max(15, +c.zTravel - d) : DEFAULT_CAL.liftTravel;
      c.liftApproach = Number.isFinite(+c.zApproach) ? Math.max(c.liftTravel, +c.zApproach - d) : Math.max(c.liftTravel, DEFAULT_CAL.liftApproach);
      if (d === 20) { c.zDraw = DEFAULT_CAL.zDraw; touchReset = true; }
    }
    delete c.zTravel;
    delete c.zApproach;
    return { cal: c, touchReset };
  }

  /** Копия калибровки по умолчанию для руки side ('X' | 'O'); поправки клеток — свой массив на каждую копию */
  const defaultCal = (side) => Object.assign({}, DEFAULT_CAL, {
    side: DEFAULT_SIDE[side],
    fix: Array.from({ length: 9 }, () => Object.assign({}, NO_FIX)),
    chains: Array(9).fill(null), // цепочки точек клеток (вкладка «Позиции»); null — по расчёту
  });

  const api = {
    LINES, other, result, free, turnOf, minimax, bestMoves, winningMove, chooseMove, LEVELS,
    cellBoard, cellFix, FIX_LIMITS, boardToArm, armToBoard, armToPolar, polarToArm, markStrokes,
    drawPlan, cellPlan, park, checkPose, checkCalibration, cellName, DEFAULT_CAL,
    DEFAULT_SIDE, defaultCal, heights, migrateCal, tipToAxis, axisToTip, markerRadius,
    chainOf, chainPlan, checkChain, draftChain,
  };
  root.TTT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
