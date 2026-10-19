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
  assert.deepEqual(T.checkCalibration(T.DEFAULT_CAL).list, []);
  assert.deepEqual(T.checkCalibration({ ...T.DEFAULT_CAL, side: 180 }).list, []);
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
