// Проверка порта ik.py по опорным точкам из docs/ik.md. Запуск: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const Kin = require('../web/assets/kinematics.js');

test('опорные позы из документации', () => {
  // start_position() в main.py
  assert.deepEqual(Kin.inverse(200, 200, 180).ticks, [2048, 2051, 2094, 1003]);
  // П-образная поза (MoveHome в прошивке): плечо вертикально, предплечье горизонтально
  const home = Kin.inverse(134.1, 200.57, 180);
  assert.deepEqual(home.ticks, [2048, 2263, 1832, 1054]);
  assert.ok(Math.abs(home.q3 + Math.PI / 2) < 1e-3, 'q3 = −90°');
});

test('схват всегда вертикален: q4 = −(q2 + q3)', () => {
  for (const [x, z] of [[280, 20], [150, 50], [120, 5], [300, 150]]) {
    const r = Kin.inverse(x, z, 180);
    assert.ok(r, `точка ${x}, ${z} должна быть достижима`);
    assert.ok(Math.abs(r.q2 + r.q3 + r.q4) < 1e-12);
  }
});

test('недостижимые точки → null', () => {
  assert.equal(Kin.inverse(0, 100, 180), null, 'x ≤ 0');
  assert.equal(Kin.inverse(-10, 100, 180), null, 'x ≤ 0');
  assert.equal(Kin.inverse(400, 20, 180), null, 'дальше длины звеньев');
  assert.equal(Kin.inverse(200, 200, 361), null, 'позиция ID1 > 4095');
});

test('max_distance', () => {
  assert.equal(Math.round(Kin.maxDistance(100) * 10) / 10, 324.1);
  assert.ok(Math.abs(Kin.maxDistance(200) - 271) < 1, 'на z = 200 вылет до ~271 мм');
});

test('IK → позиции → FK: ошибка не больше 0.8 мм (квантование серво)', () => {
  let worst = 0;
  for (let z = 0; z <= 312; z += 8) {
    for (let x = 120; x <= Kin.maxDistance(z); x += 8) {
      const r = Kin.inverse(x, z, 180);
      if (!r) continue;
      const f = Kin.forward(r.ticks);
      worst = Math.max(worst, Math.hypot(f.x - x, f.z - z));
    }
  }
  assert.ok(worst <= 0.8, `худшая ошибка ${worst.toFixed(3)} мм`);
});

test('рабочая зона: x ≥ 120, угол 30…330', () => {
  assert.equal(Kin.inWorkZone(280, 20, 180), true, 'проверенная на руке точка');
  assert.equal(Kin.inWorkZone(100, 100, 180), false, 'упор в базу');
  assert.equal(Kin.inWorkZone(200, 200, 10), false, 'угол до упора');
  assert.equal(Kin.isReachable(100, 100), true, 'is_reachable рамки не проверяет — как ik.py');
});

test('калибровка: reset не уводит руку на 90°', () => {
  Kin.setCalibration(3, 1.5);
  assert.notDeepEqual(Kin.inverse(200, 200, 180).ticks, [2048, 2051, 2094, 1003]);
  Kin.resetCalibration();
  assert.deepEqual(Kin.inverse(200, 200, 180).ticks, [2048, 2051, 2094, 1003]);
});
