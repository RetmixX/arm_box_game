// Игра: правила, робот и геометрия рисования (web/assets/ttt.js)
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

test('калибровка по умолчанию укладывается в рабочую зону обеих рук', () => {
  assert.deepEqual(T.checkCalibration(T.defaultCal('X')).list, []);
  assert.deepEqual(T.checkCalibration(T.defaultCal('O')).list, []);
});

test('по умолчанию рука ✕ у левого края листа, рука ○ — у правого', () => {
  const dist = (side, cell) => {
    const cal = T.defaultCal(side);
    const c = T.cellBoard(cell, cal.pitch);
    const a = T.boardToArm(c.bx, c.by, cal);
    return Math.hypot(a.u, a.v);
  };
  assert.ok(dist('X', 3) < dist('X', 5), 'рука ✕ ближе к А2, чем к В2');
  assert.ok(dist('O', 5) < dist('O', 3), 'рука ○ ближе к В2, чем к А2');
});

test('поле у самой базы ловится как ошибка калибровки', () => {
  const r = T.checkCalibration({ ...T.DEFAULT_CAL, cu: 120 });
  assert.ok(r.list.some((t) => /упора в базу/.test(t)), r.list.join('\n'));
});

test('план рисования: маркер опускается на высоту касания и поднимается', () => {
  const plan = T.drawPlan(T.DEFAULT_CAL, 4, 'X');
  const h = T.heights(T.DEFAULT_CAL);
  assert.equal(plan[0].z, h.approach);
  assert.ok(plan.some((p) => p.z === T.DEFAULT_CAL.zDraw));
  assert.equal(plan[plan.length - 1].label, 'на стоянку');
  for (const p of plan) assert.equal(T.checkPose(p), null, p.label);
});

test('маркер 60 мм: высоты по умолчанию и подход к клетке сверху', () => {
  const cal = T.defaultCal('X');
  const h = T.heights(cal);
  assert.deepEqual(h, { draw: 60, travel: 100, approach: 160 }, 'кончик маркера: касание, +40 и +100 мм над листом');
  for (const cell of [0, 4, 8]) {
    for (const mark of ['X', 'O']) {
      const plan = T.drawPlan(cal, cell, mark);
      const [a, over] = plan;
      assert.equal(a.z, h.approach, 'к клетке — на высоте подхода');
      assert.deepEqual([over.x, over.angel, over.z], [a.x, a.angel, h.travel], 'затем вертикально вниз до проезда');
      const back = plan[plan.length - 2];
      assert.equal(back.z, h.approach, 'от клетки — вверх до высоты подхода, потом стоянка');
      assert.deepEqual([back.x, back.angel], [plan[plan.length - 3].x, plan[plan.length - 3].angel]);
      // ниже проезда рука бывает только с опущенным маркером
      for (const p of plan) if (p.z < h.travel) assert.ok(/маркер вниз|рисует/.test(p.label), p.label);
    }
  }
  // касание подобрали — проезд и подход сдвинулись вместе с ним
  assert.deepEqual(T.heights({ ...cal, zDraw: 57 }), { draw: 57, travel: 97, approach: 157 });
});

test('старая калибровка (zTravel, касание 20 без маркера) переносится на подъёмы над листом', () => {
  const m = T.migrateCal({ side: 90, zDraw: 20, zTravel: 60, cu: 210 });
  assert.equal(m.touchReset, true);
  assert.equal(m.cal.zDraw, 60);
  assert.equal(m.cal.liftTravel, 40);
  assert.equal(m.cal.liftApproach, 100);
  assert.ok(!('zTravel' in m.cal));
  assert.equal(m.cal.cu, 210);
  const tuned = T.migrateCal({ zDraw: 58, zTravel: 90 }); // касание уже подобрано на руке — не трогаем
  assert.equal(tuned.touchReset, false);
  assert.equal(tuned.cal.zDraw, 58);
  assert.equal(tuned.cal.liftTravel, 32);
  const fresh = T.defaultCal('O');
  assert.deepEqual(T.migrateCal(fresh).cal, fresh, 'новый формат не меняется');
});

test('поправка клетки: вылет, высота касания и база прибавляются ко всем командам этой клетки', () => {
  const base = T.defaultCal('X');
  const cal = T.defaultCal('X');
  cal.fix[0] = { x: 4, z: -2, a: 3 };
  const [o0, t0] = T.cellPlan(base, 0, true, false);
  const [o1, t1] = T.cellPlan(cal, 0, true, false);
  assert.equal(o1.x, o0.x + 4);
  assert.equal(o1.angel, o0.angel + 3);
  assert.equal(o1.z, o0.z, 'высота проезда не меняется');
  assert.equal(t1.z, t0.z - 2, 'касание ниже на 2 мм');
  // знак: каждая точка сдвинута так же
  const d0 = T.drawPlan(base, 0, 'O', false), d1 = T.drawPlan(cal, 0, 'O', false);
  assert.equal(d1.length, d0.length);
  d1.forEach((p, i) => {
    assert.equal(p.x, d0[i].x + 4);
    assert.equal(p.angel, d0[i].angel + 3);
    assert.equal(p.z, d0[i].z > base.zDraw + 5 ? d0[i].z : d0[i].z - 2, p.label);
  });
  // другие клетки не тронуты
  assert.deepEqual(T.drawPlan(cal, 4, 'X'), T.drawPlan(base, 4, 'X'));
});

test('у каждой копии калибровки свои поправки; старые настройки без fix работают', () => {
  const a = T.defaultCal('X'), b = T.defaultCal('X');
  a.fix[4].x = 2;
  assert.deepEqual(b.fix[4], { x: 0, z: 0, a: 0 });
  assert.deepEqual(T.defaultCal('O').fix[4], { x: 0, z: 0, a: 0 });
  const old = { ...T.DEFAULT_CAL, side: 90 }; // сохранено до появления поправок
  assert.deepEqual(T.cellFix(old, 4), { x: 0, z: 0, a: 0 });
  assert.deepEqual(T.checkCalibration(old).list, []);
  assert.deepEqual(T.cellFix({ ...old, fix: [[3, 4]] }, 0), { x: 0, z: 0, a: 0 }, 'чужой формат игнорируется');
});

test('слишком большая поправка клетки — в списке проблем калибровки', () => {
  const cal = T.defaultCal('X');
  cal.fix[8] = { x: 0, z: 0, a: 9 };
  assert.ok(T.checkCalibration(cal).list.some((t) => /В1: поправка база 9/.test(t)), T.checkCalibration(cal).list.join('\n'));
});

test('позы игры — для /pos/set-paint: paint_pov из калибровки (по умолчанию 50), без gripper_state', () => {
  const cal = T.defaultCal('X');
  assert.equal(cal.paintPov, 50);
  const plan = T.drawPlan(cal, 4, 'X');
  for (const p of plan) {
    assert.equal(p.paint_pov, 50, p.label);
    assert.ok(!('grip' in p) && !('gripper_state' in p), p.label);
  }
  assert.equal(T.cellPlan({ ...cal, paintPov: 72 }, 0, true)[1].paint_pov, 72);
  assert.match(T.checkPose({ ...plan[0], paint_pov: 400 }), /paint_pov 400/);
  assert.match(T.checkPose({ ...plan[0], paint_pov: 0 }), /paint_pov 0 вне 1–300/, 'диапазон как у pov_gripper');
  assert.match(T.checkPose({ ...plan[0], paint_pov: NaN }), /paint_pov/);
});

test('маркер смещён от оси: ✕ и касание ставят в точку кончик маркера', () => {
  const cal = { ...T.defaultCal('X'), markerA: 12, markerB: -7 };
  // ось ↔ кончик — обратные преобразования
  for (const [u, v] of [[200, 0], [150, 60], [260, -80]]) {
    const ax = T.tipToAxis(u, v, cal);
    const tip = T.axisToTip(ax.u, ax.v, cal);
    assert.ok(Math.hypot(tip.u - u, tip.v - v) < 1e-9);
  }
  // по командам руки (целые x и угол) кончик попадает в точки линий ✕ с точностью квантования
  for (const cell of [0, 4, 8]) {
    const strokes = T.markStrokes(cell, 'X', cal).flat();
    const draw = T.drawPlan(cal, cell, 'X', false).filter((p) => /рисует|маркер вниз/.test(p.label));
    assert.equal(draw.length, strokes.length);
    draw.forEach((p, i) => {
      const ax = T.polarToArm(p.x, p.angel);
      const tip = T.axisToTip(ax.u, ax.v, cal);
      const want = T.boardToArm(strokes[i].bx, strokes[i].by, cal);
      assert.ok(Math.hypot(tip.u - want.u, tip.v - want.v) < 3, 'клетка ' + cell + ', точка ' + i);
    });
  }
  // без компенсации кончик ушёл бы на величину смещения
  const plain = T.cellPlan({ ...cal, markerA: 0, markerB: 0 }, 4, true, false)[1];
  const ax = T.polarToArm(plain.x, plain.angel);
  const off = T.axisToTip(ax.u, ax.v, cal);
  const c = T.boardToArm(0, 0, cal);
  assert.ok(Math.hypot(off.u - c.u, off.v - c.v) > 13);
});

test('○ рисует поворот paint_pov: ось в центре клетки, рука стоит, от середины влево, потом вправо', () => {
  const cal = { ...T.defaultCal('O'), markerA: 12, markerB: -7 };
  const plan = T.drawPlan(cal, 4, 'O');
  const center = T.cellPlan({ ...cal, markerA: 0, markerB: 0 }, 4, true, false)[1]; // ось ровно над центром
  const atCell = plan.filter((p) => p.label !== 'на стоянку');
  for (const p of atCell) assert.deepEqual([p.x, p.angel], [center.x, center.angel], p.label);
  const down = atCell.findIndex((p) => p.label === 'маркер вниз');
  assert.equal(atCell[down].paint_pov, 150, 'маркер опускается при paint_pov в середине');
  assert.equal(atCell[down + 1].paint_pov, 1, 'первый проход — влево до 1');
  assert.equal(atCell[down + 2].paint_pov, 300, 'второй проход — вправо до 300, через середину');
  for (const k of [1, 2]) assert.equal(atCell[down + k].z, atCell[down].z, 'во время поворота маркер на листе');
  assert.equal(atCell[down + 3].label, 'маркер вверх');
  assert.equal(atCell.filter((p) => p.label.startsWith('рисует')).length, 2);
  assert.equal(plan[plan.length - 1].paint_pov, 50, 'на стоянке — paint_pov по умолчанию');
  for (const p of plan) assert.equal(T.checkPose(p), null, p.label);
  // радиус круга — смещение маркера
  assert.ok(Math.abs(T.markerRadius(cal) - Math.hypot(12, 7)) < 1e-9);
});

test('смещение маркера: не задано — в «todo», круг больше клетки — ошибка калибровки', () => {
  const def = T.checkCalibration(T.defaultCal('X'));
  assert.deepEqual(def.list, []);
  assert.ok(def.todo.some((t) => /Смещение маркера/.test(t)));
  assert.deepEqual(T.checkCalibration({ ...T.defaultCal('X'), markerA: 10 }).todo, []);
  assert.ok(T.checkCalibration({ ...T.defaultCal('X'), markerA: 25 }).list.some((t) => /не помещается в клетку/.test(t)));
  assert.ok(T.checkCalibration({ ...T.defaultCal('X'), markerA: 10, paintFrom: 160 }).list.some((t) => /«влево до» < «середина»/.test(t)));
});
