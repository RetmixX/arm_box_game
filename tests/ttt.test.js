// Игра: правила, робот, цепочки «взять из гнезда → поставить в клетку» и лотки (web/assets/ttt.js)
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.Kin = require('../web/assets/kinematics.js');
const T = require('../web/assets/ttt.js');

test('уровень «Непобедимый» не проигрывает ни одной партии', () => {
  let games = 0, losses = 0;
  const explore = (b, robot) => {
    const r = T.result(b);
    if (r) { games++; if (r.side && r.side !== robot) losses++; return; }
    const turn = T.turnOf(b);
    const moves = turn === robot ? T.bestMoves(b, robot) : T.free(b);
    for (const m of moves) { const c = b.slice(); c[m] = turn; explore(c, robot); }
  };
  explore(Array(9).fill(null), 'X');
  explore(Array(9).fill(null), 'O');
  assert.ok(games > 1000);
  assert.equal(losses, 0);
});

test('«Средне» добивает и блокирует', () => {
  const b = ['X', 'X', null, 'O', 'O', null, null, null, null];
  assert.equal(T.chooseMove(b, 'X', 'medium', () => 0.99), 2, 'выигрыш');
  assert.equal(T.chooseMove(['X', 'X', null, 'O', null, null, null, null, null], 'O', 'medium', () => 0.99), 2, 'блок');
});

test('поле ↔ рука: обратное преобразование', () => {
  const cal = { ...T.DEFAULT_CAL, side: 90, turn: 7, cu: 180, cv: 20 };
  for (let i = 0; i < 9; i++) {
    const e = T.cellBoard(i, cal.pitch);
    const a = T.boardToArm(e.bx, e.by, cal);
    const b = T.armToBoard(a.u, a.v, cal);
    assert.ok(Math.hypot(b.bx - e.bx, b.by - e.by) < 1e-9);
  }
});

test('по умолчанию рука ✕ у левого края поля, рука ○ — у правого', () => {
  const dist = (side, cell) => {
    const cal = T.defaultCal(side);
    const c = T.cellBoard(cell, cal.pitch);
    const a = T.boardToArm(c.bx, c.by, cal);
    return Math.hypot(a.u, a.v);
  };
  assert.ok(dist('X', 3) < dist('X', 5), 'рука ✕ ближе к А2, чем к В2');
  assert.ok(dist('O', 5) < dist('O', 3), 'рука ○ ближе к В2, чем к А2');
});

test('«над клеткой» и стоянка по умолчанию — в рабочей зоне; поле у базы ловится', () => {
  for (const side of ['X', 'O']) {
    const cal = T.defaultCal(side);
    for (let i = 0; i < 9; i++) assert.equal(T.checkPose(T.overCell(cal, i)), null, side + ' ' + T.cellName(i));
    assert.equal(T.checkPose(T.park(cal)), null);
    assert.equal(T.overCell(cal, 4).z, cal.zSafe, 'над клеткой — на высоте проезда');
  }
  const near = { ...T.defaultCal('X'), side: 0, cu: 120 };
  assert.match(T.checkPose(T.overCell(near, 7)), /упора в базу/);
});

test('команды — для /pos/set: целые, gripper_state по настройке gripTrue', () => {
  const cal = T.defaultCal('X');
  const p = T.command(cal, { x: 200.4, z: 99.6, angel: 180.2, closed: true }, 'проба');
  assert.deepEqual([p.x, p.z, p.angel, p.pov_gripper], [200, 100, 180, 150], 'pov по умолчанию — из калибровки');
  assert.equal(p.closed, true);
  assert.equal(p.gripper_state, true, 'по умолчанию true — закрыт: так на руке (в пульте наоборот)');
  assert.equal(T.command(cal, { x: 200, z: 100, angel: 180, closed: false }, '').gripper_state, false);
  assert.equal(T.command({ ...cal, gripTrue: 'open' }, { x: 200, z: 100, angel: 180, closed: true }, '').gripper_state, false);
  assert.ok(!('paint_pov' in p));
  assert.match(T.checkPose({ ...p, pov_gripper: 0 }), /поворот схвата 0 вне 1–300/);
  assert.match(T.checkPose({ ...p, gripper_state: undefined }), /состояние схвата/);
});

/** Рука ✕ с цепочками гнезда 0 и клетки Б2 (черновики от точки захвата / установки) */
function armWithChains(side = 'X') {
  const cal = T.defaultCal(side);
  const o = T.overCell(cal, 4);
  cal.slots[0] = T.draftChain(cal, 'slot', { x: 230, z: 40, angel: 120 });
  cal.chains[4] = T.draftChain(cal, 'cell', { x: o.x, z: 45, angel: o.angel });
  return cal;
}

test('черновик: над точкой на высоте проезда → по прямой вниз → схват → по прямой вверх', () => {
  const cal = armWithChains();
  const s = cal.slots[0], c = cal.chains[4];
  assert.deepEqual(s.map((q) => [q.z, q.closed, q.line]), [[150, false, false], [40, false, true], [40, true, false], [150, true, true]], 'гнездо: пустой пришёл, с фигуркой ушёл');
  assert.deepEqual(c.map((q) => [q.z, q.closed]), [[150, true], [45, true], [45, false], [150, false]], 'клетка: принёс фигурку, отпустил');
  assert.equal(T.checkChain(cal, 'slot', 0), null);
  assert.equal(T.checkChain(cal, 'cell', 4), null);
  // точка захвата выше проезда − 30 — подъём хотя бы на 30 мм
  assert.equal(T.draftChain(cal, 'slot', { x: 200, z: 140, angel: 180 })[0].z, 170);
});

test('ход: взять из гнезда → поставить в клетку → стоянка; лоток отмечается на смене схвата', () => {
  const cal = armWithChains();
  const plan = T.movePlan(cal, 0, 4);
  for (const p of plan) assert.equal(T.checkPose(p), null, p.label);
  assert.equal(plan[plan.length - 1].label, 'на стоянку');
  assert.equal(plan[plan.length - 1].closed, false, 'на стоянку — со свободным схватом');
  const marks = plan.filter((p) => 'trayTo' in p);
  assert.deepEqual(marks.map((p) => [p.slot, p.trayTo, p.closed, p.z]), [[0, 'hand', true, 40], [0, 4, false, 45]]);
  // схват меняется только внизу, на месте: координаты как у предыдущей позы
  plan.forEach((p, k) => {
    if (k && p.closed !== plan[k - 1].closed) assert.deepEqual([p.x, p.z, p.angel], [plan[k - 1].x, plan[k - 1].z, plan[k - 1].angel], p.label);
  });
  // с фигуркой в руке рука не опускается ниже проезда вне гнезда и клетки
  const pick = plan.filter((p) => p.stage === 'pick'), place = plan.filter((p) => p.stage === 'place');
  assert.ok(pick.every((p) => p.target === 's0') && place.every((p) => p.target === 'c4'));
  assert.ok(pick[pick.length - 1].z >= cal.zSafe && place[0].z >= cal.zSafe);
  // фигурка уже в схвате — сразу к клетке
  const again = T.movePlan(cal, 0, 4, { inHand: true });
  assert.ok(again.every((p) => p.stage !== 'pick'));
  assert.deepEqual(again.filter((p) => 'trayTo' in p).map((p) => p.trayTo), [4]);
});

test('по прямой: вертикальный спуск — одной командой, у самой базы дробится с шагом step', () => {
  const cal = armWithChains();
  assert.equal(T.chainPlan(cal, 'slot', 0).filter((p) => /по прямой/.test(p.label)).length, 0, 'спуск и подъём без остановок');
  const near = T.defaultCal('X');
  near.slots[0] = [
    { x: 125, z: 150, angel: 120, closed: false },
    { x: 125, z: 40, angel: 120, closed: false, line: true },
    { x: 125, z: 40, angel: 120, closed: true },
    { x: 125, z: 150, angel: 120, closed: true },
  ];
  const down = T.chainPlan(near, 'slot', 0).filter((p) => /по прямой к точке 2/.test(p.label));
  assert.equal(down.length, Math.ceil((150 - 40) / near.step) - 1);
  for (const p of down) {
    assert.deepEqual([p.x, p.angel, p.closed], [125, 120, false]);
    assert.ok(p.z > 40 && p.z < 150);
  }
  // наклонная прямая — в плоскости стола точки на отрезке
  const c = T.defaultCal('X');
  c.chains[0] = [
    { x: 190, z: 160, angel: 185, closed: true },
    { x: 215, z: 160, angel: 176, closed: true, line: true },
    { x: 215, z: 60, angel: 176, closed: true },
    { x: 215, z: 60, angel: 176, closed: false },
    { x: 215, z: 160, angel: 176, closed: false },
  ];
  const a = T.polarToArm(190, 185), b = T.polarToArm(215, 176);
  for (const p of T.chainPlan(c, 'cell', 0).filter((q) => /по прямой/.test(q.label))) {
    const q = T.polarToArm(p.x, p.angel);
    const cross = Math.abs((b.u - a.u) * (q.v - a.v) - (b.v - a.v) * (q.u - a.u)) / Math.hypot(b.u - a.u, b.v - a.v);
    assert.ok(cross < 2.5, 'отклонение от прямой ' + cross.toFixed(2) + ' мм (квантование команды)');
  }
  assert.equal(T.checkChain(c, 'cell', 0), null);
});

test('уборка — те же цепочки задом наперёд: забрать из клетки, вернуть в гнездо', () => {
  const cal = armWithChains();
  const back = T.returnPlan(cal, 4, 0);
  for (const p of back) assert.equal(T.checkPose(p), null, p.label);
  const marks = back.filter((p) => 'trayTo' in p);
  assert.deepEqual(marks.map((p) => [p.trayTo, p.closed, p.z]), [['hand', true, 45], [null, false, 40]]);
  // клетка задом наперёд: пустой сверху → вниз (вертикаль — одной командой) → закрыть → вверх
  const fromCell = back.filter((p) => p.stage === 'pick');
  assert.deepEqual(fromCell.map((p) => [p.z, p.closed]), [[150, false], [45, false], [45, true], [150, true]]);
  // флаг «по прямой» переезжает на соседнюю точку
  const pts = cal.chains[4];
  assert.deepEqual(T.reversePoints(pts).map((q) => q.line), [false, true, false, true]);
  assert.deepEqual(T.reversePoints(T.reversePoints(pts)), pts.map((q) => ({ ...q, line: !!q.line })));
  // фигурка уже в схвате — только в гнездо
  const hand = T.returnPlan(cal, null, 0);
  assert.ok(hand.every((p) => p.stage !== 'pick'));
  assert.deepEqual(hand.filter((p) => 'trayTo' in p).map((p) => p.trayTo), [null]);
});

test('проверка цепочки: верх, схват в начале и в конце, одна смена схвата, рабочая зона', () => {
  const cal = T.defaultCal('O');
  const hi = { x: 200, z: 160, angel: 180, closed: true };
  const lo = { ...hi, z: 60 };
  const set = (pts) => { cal.chains[4] = pts; return T.checkChain(cal, 'cell', 4); };
  assert.equal(set([hi, lo, { ...lo, closed: false }, { ...hi, closed: false }]), null);
  assert.match(set([lo, { ...hi, closed: false }]), /первая точка .* ниже высоты проезда/);
  assert.match(set([hi, { ...lo, closed: false }]), /последняя точка/);
  assert.match(set([{ ...hi, closed: false }, { ...hi, closed: false }]), /в начале схват должен быть закрыт/);
  assert.match(set([hi, lo, hi]), /в конце схват должен быть открыт/);
  assert.match(set([hi, { ...lo, closed: false }, lo, { ...lo, closed: false }, { ...hi, closed: false }]), /меняется 3 раза/);
  assert.match(set([hi, { ...lo, x: 100 }, { ...lo, closed: false }, { ...hi, closed: false }]), /точка 2 из 4: вылет 100 мм ближе упора в базу/);
  assert.match(set([hi]), /меньше двух точек/);
  cal.slots[1] = [{ ...hi, closed: true }, { ...hi, closed: false }];
  assert.match(T.checkChain(cal, 'slot', 1), /в начале схват должен быть открыт/);
  assert.equal(T.checkChain(cal, 'slot', 2), null, 'нет цепочки — не ошибка цепочки');
});

test('проверка руки: без цепочек — по расчёту, ○ хватает 4 гнёзд, битая цепочка — ошибка', () => {
  for (const side of ['X', 'O']) {
    const r = T.checkCalibration(T.defaultCal(side), side);
    assert.deepEqual(r.list, [], side + ': калибровка по умолчанию достаёт до всех клеток, гнёзд и стоянки');
    assert.ok(r.todo.some((t) => /По расчёту: клеток 9, гнёзд /.test(t)));
  }
  const o = T.defaultCal('O');
  o.trayNA = 340; // пятое гнездо ○ вне зоны — руке ○ оно не нужно
  o.tray1A = 280;
  assert.ok(T.checkChain(o, 'slot', 4));
  assert.equal(T.checkCalibration(o, 'O').slots[4], null);
  assert.ok(T.checkCalibration(o, 'X').list.some((t) => /Гнездо 5: по расчёту: .*угол базы/.test(t)), 'руке ✕ пятое нужно');
  const x = T.defaultCal('X');
  x.chains[2] = [{ x: 200, z: 160, angel: 180, closed: true }];
  const bad = T.checkCalibration(x, 'X');
  assert.ok(bad.list.some((t) => /Клетка В3: в цепочке меньше двух точек/.test(t)));
  assert.equal(bad.cells[2], 'в цепочке меньше двух точек');
});

test('по расчёту: клетка — центр по полю, гнёзда — на прямой от 1 до 5, путь как у черновика', () => {
  const cal = T.defaultCal('X');
  const c = T.boardToArm(0, 0, cal), b4 = T.calcBottom(cal, 'cell', 4);
  const p = T.armToPolar(c.u, c.v);
  assert.deepEqual([b4.x, b4.angel, b4.z], [Math.round(p.x), Math.round(p.angel), cal.zPlace]);
  const s0 = T.calcBottom(cal, 'slot', 0), s4 = T.calcBottom(cal, 'slot', 4), s2 = T.calcBottom(cal, 'slot', 2);
  assert.deepEqual([s0.x, s0.angel, s0.z], [cal.tray1X, cal.tray1A, cal.zPick]);
  assert.deepEqual([s4.x, s4.angel], [cal.trayNX, cal.trayNA]);
  const a = T.polarToArm(cal.tray1X, cal.tray1A), z = T.polarToArm(cal.trayNX, cal.trayNA), m = T.polarToArm(s2.x, s2.angel);
  assert.ok(Math.hypot(m.u - (a.u + z.u) / 2, m.v - (a.v + z.v) / 2) < 2, 'среднее гнездо — посередине');
  // нет цепочки — путь по расчёту, тот же, что «Черновик по расчёту»
  assert.equal(T.chainOf(cal, 'cell', 4), null);
  assert.deepEqual(T.pointsOf(cal, 'cell', 4), T.draftChain(cal, 'cell', b4));
  const plan = T.movePlan(cal, 0, 4);
  for (const q of plan) assert.equal(T.checkPose(q), null, q.label);
  assert.deepEqual(plan.filter((q) => 'trayTo' in q).map((q) => [q.trayTo, q.z]), [['hand', cal.zPick], [4, cal.zPlace]]);
  for (const q of T.returnPlan(cal, 4, 0)) assert.equal(T.checkPose(q), null, q.label);
  // записанная цепочка важнее расчёта
  const own = T.draftChain(cal, 'cell', { x: 210, z: 40, angel: 181 });
  cal.chains[4] = own;
  assert.deepEqual(T.pointsOf(cal, 'cell', 4), own);
  assert.equal(T.chainBottom(cal, 'cell', 4).z, 40);
});

test('поправка клетки / гнезда прибавляется к точке захвата, высота проезда не меняется', () => {
  const base = T.defaultCal('X'), cal = T.defaultCal('X');
  cal.fix[0] = { x: 4, z: -2, a: 3, r: -7 };
  cal.slotFix[1] = { x: -5, z: 1, a: 0 };
  const d = (kind, i) => [T.calcBottom(cal, kind, i), T.calcBottom(base, kind, i)];
  let [f, o] = d('cell', 0);
  assert.deepEqual([f.x - o.x, f.z - o.z, f.angel - o.angel, f.pov - o.pov], [4, -2, 3, -7]);
  assert.ok(T.calcChain(cal, 'cell', 0).every((q) => q.pov === base.pov - 7), 'поворот схвата — во всём пути клетки');
  [f, o] = d('slot', 1);
  assert.deepEqual([f.x - o.x, f.z - o.z, f.angel - o.angel, f.pov - o.pov], [-5, 1, 0, 0]);
  // общий поворот схвата — для всех клеток и гнёзд по расчёту
  const turned = { ...base, pov: 170 };
  assert.equal(T.calcBottom(turned, 'cell', 4).pov, 170);
  assert.equal(T.calcBottom(turned, 'slot', 3).pov, 170);
  assert.ok(T.checkCalibration({ ...cal, fix: [{ r: 50 }] }, 'X').list.some((t) => /поправка поворот 50 \(предел ±45\)/.test(t)));
  assert.equal(T.calcChain(cal, 'cell', 0)[0].z, cal.zSafe, 'над клеткой — на высоте проезда');
  assert.deepEqual(T.calcBottom(cal, 'cell', 4), T.calcBottom(base, 'cell', 4), 'другие клетки не тронуты');
  assert.deepEqual(T.fixOf({ fix: [[3, 4]] }, 'cell', 0), { x: 0, z: 0, a: 0, r: 0 }, 'чужой формат игнорируется');
  assert.deepEqual(T.fixOf({ fix: [{ x: 2, z: 1, a: 1 }] }, 'cell', 0), { x: 2, z: 1, a: 1, r: 0 }, 'поправка без поворота — поворот 0');
  cal.fix[8] = { x: 0, z: 0, a: 9 };
  assert.ok(T.checkCalibration(cal, 'X').list.some((t) => /Клетка В1: поправка база 9/.test(t)));
  const own = T.defaultCal('X');
  own.fix[8] = { x: 0, z: 0, a: 9 };
  own.chains[8] = T.calcChain(T.defaultCal('X'), 'cell', 8);
  assert.ok(!T.checkCalibration(own, 'X').list.some((t) => /поправка/.test(t)), 'у клетки с цепочкой поправка не используется');
});

test('лоток: откуда брать, восстановление поля после перезагрузки', () => {
  const t = T.emptyTray();
  assert.deepEqual(T.nextSlot(t.X), { slot: 0, inHand: false });
  t.X = [4, 0, 'hand', null, null];
  assert.deepEqual(T.nextSlot(t.X), { slot: 2, inHand: true }, 'сначала — фигурка из схвата');
  t.X = [4, 0, 8, 1, 7];
  assert.equal(T.nextSlot(t.X).slot, -1, 'лоток пуст');
  // поле по лоткам
  const tray = { X: [4, 0, null, null, null], O: [8, null, null, null, null] };
  assert.deepEqual(T.boardFromTray(tray), ['X', null, null, null, 'X', null, null, null, 'O']);
  assert.equal(T.boardFromTray({ X: [4, null, null, null, null], O: [4, null, null, null, null] }), null, 'две фигурки в клетке');
  assert.equal(T.boardFromTray({ X: [null, null, null, null, null], O: [4, null, null, null, null] }), null, '○ не ходит первым');
  // сохранённое значение чистится
  assert.deepEqual(T.normalizeTray({ X: [4, 'hand', 12, 'x', -1, 3], O: 'мусор' }), { X: [4, 'hand', null, null, null], O: [null, null, null, null, null] });
});

test('калибровка рисования маркером переносится: поле и стоянка остаются, цепочки рисования удаляются', () => {
  const old = {
    side: 90, cu: 210, pitch: 48, parkAngel: 250, zDraw: 60, liftTravel: 40, markerA: 10, paintPov: 50, fix: [],
    chains: [null, null, null, null, [{ x: 200, z: 160, angel: 180, paint_pov: 50 }, { x: 200, z: 60, angel: 180, paint_pov: 50 }], null, null, null, null],
  };
  const m = T.migrateCal(old);
  assert.equal(m.dropped, true);
  assert.deepEqual([m.cal.side, m.cal.cu, m.cal.pitch, m.cal.parkAngel], [90, 210, 48, 250]);
  for (const k of ['zDraw', 'liftTravel', 'markerA', 'paintPov', 'fix']) assert.ok(!(k in m.cal), k + ' (поправки маркера к схвату не подходят)');
  assert.ok(m.cal.chains.every((c) => c === null));
  const fresh = armWithChains();
  assert.deepEqual(T.migrateCal(fresh), { cal: fresh, dropped: false, raised: false }, 'новый формат не меняется');
});

test('у каждой копии калибровки свои массивы цепочек', () => {
  const a = T.defaultCal('X'), b = T.defaultCal('X');
  a.chains[4] = [{ x: 1 }];
  a.slots[0] = [{ x: 1 }];
  a.fix[0].x = 3;
  a.slotFix[0].z = 2;
  assert.deepEqual([b.fix[0], b.slotFix[0]], [{ x: 0, z: 0, a: 0, r: 0 }, { x: 0, z: 0, a: 0, r: 0 }]);
  assert.equal(b.chains[4], null);
  assert.equal(b.slots[0], null);
  assert.equal(T.defaultCal('X').slots.length, T.SLOTS);
});

test('смысл gripper_state: сохранённое «true — открыт» переводится на «true — закрыт» один раз', () => {
  const old = { ...T.defaultCal('X'), gripTrue: 'open' };
  delete old.gripV;
  const m = T.migrateCal(old).cal;
  assert.equal(m.gripTrue, 'closed');
  assert.equal(m.gripV, 2);
  // после перевода выбор человека не трогаем
  assert.equal(T.migrateCal({ ...m, gripTrue: 'open' }).cal.gripTrue, 'open');
  assert.equal(T.defaultCal('O').gripTrue, 'closed');
});

test('поворот за базой: в клетке схват доворачивается на угол базы относительно Б2, гнёзда — нет', () => {
  const off = T.defaultCal('X');
  assert.equal(off.povFollow, 0, 'по умолчанию выключено');
  for (const dir of [1, -1]) {
    const cal = { ...T.defaultCal('X'), povFollow: dir };
    assert.equal(T.calcBottom(cal, 'cell', 4).pov, cal.pov, 'в Б2 — общий поворот');
    for (let i = 0; i < 9; i++) {
      const b = T.calcBottom(cal, 'cell', i), c = T.calcBottom(T.defaultCal('X'), 'cell', 4);
      assert.ok(Math.abs(b.pov - (cal.pov + dir * (b.angel - c.angel))) <= 1, 'клетка ' + i);
    }
    assert.notEqual(T.calcBottom(cal, 'cell', 0).pov, cal.pov, 'в углу доворот есть');
    for (let k = 0; k < T.SLOTS; k++) assert.equal(T.calcBottom(cal, 'slot', k).pov, cal.pov, 'гнездо ' + k);
    assert.ok(T.calcChain(cal, 'cell', 0).every((q) => q.pov === T.calcBottom(cal, 'cell', 0).pov), 'доворот — во всём пути клетки');
  }
  // доворот считается от фактического угла базы — с поправкой a; поправка r прибавляется сверху
  const cal = { ...T.defaultCal('X'), povFollow: 1 };
  cal.fix[0] = { x: 0, z: 0, a: 3, r: 2 };
  const plain = { ...T.defaultCal('X'), povFollow: 1 };
  assert.equal(T.calcBottom(cal, 'cell', 0).pov - T.calcBottom(plain, 'cell', 0).pov, 5);
  // переход через 0°/360° не даёт скачка на 360°
  assert.equal(T.povAuto({ ...plain, cu: 200, cv: 0, side: 0 }, 181), 1);
  assert.ok(Math.abs(T.povAuto({ ...plain, cu: -200, cv: 1, side: 0 }, 359)) < 5);
});

test('фигурка «знак стоя»: сохранённая высота захвата и цепочки поднимаются один раз', () => {
  const old = { zPlace: 30, zPick: 33, zSafe: 150, slots: [[{ x: 200, z: 150, angel: 235, closed: false }, { x: 200, z: 40, angel: 235, closed: false, line: true }], null], chains: Array(9).fill(null) };
  const m = T.migrateCal(old);
  assert.equal(m.raised, true);
  assert.deepEqual([m.cal.zPlace, m.cal.zPick, m.cal.zSafe, m.cal.pieceV], [30 + T.PIECE_DZ, 33 + T.PIECE_DZ, 150, 2]);
  assert.deepEqual(m.cal.slots[0].map((p) => p.z), [150 + T.PIECE_DZ, 40 + T.PIECE_DZ]);
  assert.equal(m.cal.slots[0][1].line, true);
  assert.equal(old.slots[0][1].z, 40, 'сохранённый объект не меняется');
  const again = T.migrateCal(m.cal);
  assert.equal(again.raised, false);
  assert.equal(again.cal.zPick, 33 + T.PIECE_DZ);
  // новая калибровка уже под знак стоя — не поднимается
  const fresh = T.migrateCal(JSON.parse(JSON.stringify(T.defaultCal('X'))));
  assert.equal(fresh.raised, false);
  assert.deepEqual([fresh.cal.zPlace, fresh.cal.zPick], [34, 36]);
});
