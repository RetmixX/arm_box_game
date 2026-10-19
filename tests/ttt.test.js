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
  assert.equal(plan[0].z, T.DEFAULT_CAL.zTravel);
  assert.ok(plan.some((p) => p.z === T.DEFAULT_CAL.zDraw));
  assert.equal(plan[plan.length - 1].label, 'на стоянку');
  for (const p of plan) assert.equal(T.checkPose(p), null, p.label);
});

test('поправка клетки: вылет, высота касания и база прибавляются ко всем командам этой клетки', () => {
  const base = T.defaultCal('X');
  const cal = T.defaultCal('X');
  cal.fix[0] = { x: 4, z: -2, a: 3 };
  const [o0, t0] = T.cellPlan(base, 0, true);
  const [o1, t1] = T.cellPlan(cal, 0, true);
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
    assert.equal(p.z, d0[i].z === base.zTravel ? base.zTravel : d0[i].z - 2);
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
  const plan = T.drawPlan(cal, 4, 'O');
  for (const p of plan) {
    assert.equal(p.paint_pov, 50, p.label);
    assert.ok(!('grip' in p) && !('gripper_state' in p), p.label);
  }
  assert.equal(T.cellPlan({ ...cal, paintPov: 72 }, 0, true)[1].paint_pov, 72);
  assert.match(T.checkPose({ ...plan[0], paint_pov: 400 }), /paint_pov 400/);
  assert.match(T.checkPose({ ...plan[0], paint_pov: 0 }), /paint_pov 0 вне 1–300/, 'диапазон как у pov_gripper');
  assert.match(T.checkPose({ ...plan[0], paint_pov: NaN }), /paint_pov/);
});
