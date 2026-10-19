/*
 * Кинематика манипулятора — порт ik.py (класс InverseKinematics), см. docs/ik.md.
 *   x     — вылет середины схвата от оси базы, мм
 *   z     — высота середины схвата над низом базы, мм
 *   angel — поворот базы, градусы (180 = центр, позиция 2048)
 *
 * Схват всегда смотрит вертикально вниз: q4 = −(q2 + q3).
 * Любое изменение математики здесь должно повторять ik.py и проходить tests/kinematics.test.js.
 */
(function (root) {
  'use strict';

  const GEOM = {
    BASE_HEIGHT: 163.5,
    L1A: 195.81,
    L1B: 67.36,
    L1: 207.07,
    L2: 134.1,
    L3: 170.0,
    POSITION_OFFSET_DXL4: 30,
  };

  /**
   * Рабочая зона из docs/ik.md. ik.py её НЕ проверяет — рамки держит вызывающий код (фронт).
   *   x: снизу упор в базу, сверху длина звеньев (точнее — maxDistance(z))
   *   z: снизу стол (точное значение найти на руке; z = 20 проверено), сверху 312
   *   angle: запас до упора и кабелей
   */
  const WORK = { x: [120, 341], z: [0, 312], angle: [30, 330] };

  const ALPHA = Math.atan(GEOM.L1B / GEOM.L1A); // 18.98°
  // Геометрические смещения ik_offsets (ID1..ID4), рад
  const OFFSETS = { 1: 0, 2: Math.PI / 2 + ALPHA, 3: Math.PI / 2 - ALPHA + Math.PI, 4: Math.PI / 2 };
  // Поправки калибровки поверх геометрии, только ID2–ID4, рад (в backend задаются в градусах)
  const CAL = { 2: 0, 3: 0, 4: 0 };

  const rad = (d) => (d * Math.PI) / 180;
  const toPos = (q, id) => Math.trunc((2048 * (q + OFFSETS[id] + (CAL[id] || 0))) / Math.PI);
  const fromPos = (pos, id) => (pos * Math.PI) / 2048 - OFFSETS[id] - (CAL[id] || 0);

  /** Обратная кинематика. Возвращает { q2, q3, q4, ticks: [pos1..pos4] } или null, если точка недостижима. */
  function inverse(x, z, angle) {
    const { L1, L2, L3, BASE_HEIGHT } = GEOM;
    if (!(x > 0)) return null;
    // 1. система координат плеча: кисть на L3 выше схвата
    const zc = z - BASE_HEIGHT + L3;
    // 2. локоть, конфигурация «локоть вверх»
    const c = (x * x + zc * zc - L1 * L1 - L2 * L2) / (2 * L1 * L2);
    if (!(Math.abs(c) <= 1)) return null;
    const s = -Math.sqrt(1 - c * c);
    const q3 = Math.atan2(s, c);
    // 3. плечо
    const k1 = L1 + L2 * c;
    const k2 = L2 * s;
    const q2 = Math.atan2(zc * k1 - x * k2, x * k1 + zc * k2);
    // 4. кисть — схват строго вертикально
    const q4 = -(q2 + q3);
    // 5. позиции серво
    const ticks = [
      toPos(rad(angle), 1),
      toPos(q2, 2),
      toPos(q3, 3),
      toPos(q4, 4) + GEOM.POSITION_OFFSET_DXL4,
    ];
    if (ticks.some((t) => t < 0 || t > 4095)) return null;
    return { q2, q3, q4, ticks };
  }

  /** Как ik.is_reachable: только геометрия и диапазон 0…4095, без рамок WORK */
  const isReachable = (x, z, angle = 180) => inverse(x, z, angle) !== null;

  /** Максимальный вылет на высоте z, мм (ik.max_distance) */
  function maxDistance(z) {
    const r = GEOM.L1 + GEOM.L2;
    const zc = z - GEOM.BASE_HEIGHT + GEOM.L3;
    return Math.abs(zc) >= r ? 0 : Math.sqrt(r * r - zc * zc);
  }

  /** Точка в рабочей зоне из документации и достижима. Это и есть «рамки вызывающего кода». */
  function inWorkZone(x, z, angle = 180) {
    return x >= WORK.x[0] && x <= WORK.x[1] && z >= WORK.z[0] && z <= WORK.z[1] &&
      angle >= WORK.angle[0] && angle <= WORK.angle[1] && isReachable(x, z, angle);
  }

  /** Прямая кинематика (ik.forward): [pos1..pos4] → { x, z, angle } */
  function forward(pos) {
    const { L1, L2, L3, BASE_HEIGHT } = GEOM;
    const q2 = fromPos(pos[1], 2);
    const q3 = fromPos(pos[2], 3);
    const x = L1 * Math.cos(q2) + L2 * Math.cos(q2 + q3);
    const zc = L1 * Math.sin(q2) + L2 * Math.sin(q2 + q3);
    return { x, z: zc + BASE_HEIGHT - L3, angle: (pos[0] * 360) / 4096 };
  }

  /** Целевые тики всех 6 моторов — как в RobotARM.move_arm */
  function targetTicks(x, z, angle, pov, gripperState) {
    const ik = inverse(x, z, angle);
    if (!ik) return null;
    return [...ik.ticks, Math.ceil(pov * 3.41), gripperState ? 370 : 710];
  }

  /** Поза (углы звеньев) из тиков моторов: t — { 1: pos1, 2: pos2, … } */
  function poseFromTicks(t) {
    const g = (id, d) => (Number.isFinite(t[id]) ? t[id] : d);
    return {
      angle: (g(1, 2048) * 360) / 4096,
      shoulder: fromPos(g(2, 2048), 2),
      elbow: fromPos(g(3, 2048), 3),
      pov: g(5, 512) / 3.41,
      gripTick: g(6, 710),
    };
  }

  /** Поза из целевых координат */
  function poseFromTarget(x, z, angle, pov) {
    const ik = inverse(x, z, angle);
    if (!ik) return null;
    return { angle, shoulder: ik.q2, elbow: ik.q3, pov };
  }

  /** Точки суставов в плоскости руки (мм): плечо, локоть, кисть, середина схвата */
  function joints(p) {
    const { L1, L2, L3, BASE_HEIGHT } = GEOM;
    const s = { x: 0, z: BASE_HEIGHT };
    const e = { x: L1 * Math.cos(p.shoulder), z: BASE_HEIGHT + L1 * Math.sin(p.shoulder) };
    const w = { x: e.x + L2 * Math.cos(p.shoulder + p.elbow), z: e.z + L2 * Math.sin(p.shoulder + p.elbow) };
    const t = { x: w.x, z: w.z - L3 };
    return { s, e, w, t };
  }

  /* Калибровка — зеркало set_calibration / add_calibration / reset_calibration из ik.py (градусы, ID2–ID4).
   * Фронт не знает калибровку backend; используйте, только если она отличается от нуля на руке. */
  function setCalibration(id, deg) { if (id in CAL) CAL[id] = rad(deg); }
  function addCalibration(id, deg) { if (id in CAL) CAL[id] += rad(deg); }
  function resetCalibration() { CAL[2] = CAL[3] = CAL[4] = 0; }

  const api = {
    GEOM, WORK, inverse, isReachable, inWorkZone, maxDistance, forward, targetTicks,
    poseFromTicks, poseFromTarget, joints, setCalibration, addCalibration, resetCalibration,
  };
  root.Kin = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
