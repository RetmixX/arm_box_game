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

test('поправка клетки сдвигает и наведение, и знак; остальные клетки не трогает', () => {
  const base = T.defaultCal('X');
  const cal = T.defaultCal('X');
  cal.fix[0] = [4, -3];
  const c0 = T.cellBoard(0, cal.pitch);
  assert.deepEqual(T.cellCenter(cal, 0), { bx: c0.bx + 4, by: c0.by - 3 });
  // наведение: та же поза, что у поля, сдвинутого на поправку
  const moved = T.cellPlan(cal, 0, false)[0];
  const a = T.boardToArm(c0.bx + 4, c0.by - 3, cal);
  const p = T.armToPolar(a.u, a.v);
  assert.equal(moved.x, Math.round(p.x));
  assert.equal(moved.angel, Math.round(p.angel));
  // знак: центр окружности уехал ровно на поправку
  const ring = (c) => { const pts = T.markStrokes(0, 'O', c)[0]; return pts.reduce((s, q) => ({ bx: s.bx + q.bx / pts.length, by: s.by + q.by / pts.length }), { bx: 0, by: 0 }); };
  const r0 = ring(base), r1 = ring(cal);
  assert.ok(Math.abs(r1.bx - r0.bx - 4) < 0.5 && Math.abs(r1.by - r0.by + 3) < 0.5);
  assert.deepEqual(T.cellPlan(cal, 4, true), T.cellPlan(base, 4, true));
});

test('у каждой копии калибровки свои поправки; старые настройки без fix работают', () => {
  const a = T.defaultCal('X'), b = T.defaultCal('X');
  a.fix[4] = [2, 2];
  assert.deepEqual(b.fix[4], [0, 0]);
  assert.deepEqual(T.defaultCal('O').fix[4], [0, 0]);
  const old = { ...T.DEFAULT_CAL, side: 90 }; // сохранено до появления поправок
  assert.deepEqual(T.cellFix(old, 4), [0, 0]);
  assert.deepEqual(T.checkCalibration(old).list, []);
});

test('слишком большая поправка клетки — в списке проблем калибровки', () => {
  const cal = T.defaultCal('X');
  cal.fix[8] = [0, 25]; // при шаге 50 предел 20 мм
  assert.ok(T.checkCalibration(cal).list.some((t) => /В1: поправка/.test(t)), T.checkCalibration(cal).list.join('\n'));
});
