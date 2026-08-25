// Localized component damage shared by every projectile path.
// Kept separate from battle.js so the exact rotated hit volumes can be tested
// without booting the full game simulation.
import * as THREE from '../vendor/three.module.js';
import { partCenter } from './physics.js';
import { PARTS } from './parts.js';

export const DAMAGE_ZONE_MULTIPLIERS = Object.freeze({
  fuel: 2,
  command: 3,
  engine: 1.2,
});

const _worldInv = new THREE.Quaternion();
const _craftA = new THREE.Vector3(), _craftB = new THREE.Vector3();
const _partA = new THREE.Vector3(), _partB = new THREE.Vector3();

export function buildDamageZoneHitboxes(design, centroidOff, scale = 1){
  const boxes = [];
  const off = centroidOff || { x: 0, y: 0, z: 0 };
  const E = Math.PI / 4;
  for (const p of (design && design.parts) || []){
    const def = PARTS[p.key];
    const multiplier = def && DAMAGE_ZONE_MULTIPLIERS[def.category];
    if (!multiplier) continue;
    const c = partCenter(p, def);
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      -((p.rx || 0) * 2 + (p.hp || 0)) * E,
      -((p.rot || 0) * 2 + (p.hy || 0)) * E,
      -((p.rz || 0) * 2 + (p.hr || 0)) * E, 'YXZ'));
    boxes.push({
      center: new THREE.Vector3((c.x - off.x) * scale, (c.y - off.y) * scale, (c.z - off.z) * scale),
      half: new THREE.Vector3((def.size?.[0] || 1) * 0.5 * scale, (def.size?.[1] || 1) * 0.5 * scale, (def.size?.[2] || 1) * 0.5 * scale),
      invRotation: rot.invert(),
      category: def.category,
      multiplier,
      jettison: !!def.jettison,
    });
  }
  return boxes;
}

// Return the strongest component intersected by the projectile segment. A
// command section wins over tankage/engine if intentionally overlapped.
export function hitDamageZone(a, b, target, pad = 0){
  const boxes = target && target.damageZoneHitboxes;
  if (!boxes || !boxes.length) return null;
  const transform = target.group || target.mesh;
  if (!transform) return null;
  const q = _worldInv.copy(transform.quaternion).invert();
  const la = _craftA.copy(a).sub(target.pos).applyQuaternion(q);
  const lb = _craftB.copy(b).sub(target.pos).applyQuaternion(q);
  let strongest = null;
  for (const box of boxes){
    if (box.jettison && target.dropTanksGone) continue;
    const pa = _partA.copy(la).sub(box.center).applyQuaternion(box.invRotation);
    const pb = _partB.copy(lb).sub(box.center).applyQuaternion(box.invRotation);
    let t0 = 0, t1 = 1, hit = true;
    for (const axis of ['x', 'y', 'z']){
      const p0 = pa[axis], d = pb[axis] - p0, extent = box.half[axis] + pad;
      if (Math.abs(d) < 1e-9){
        if (p0 < -extent || p0 > extent){ hit = false; break; }
        continue;
      }
      let near = (-extent - p0) / d, far = (extent - p0) / d;
      if (near > far){ const swap = near; near = far; far = swap; }
      if (near > t0) t0 = near;
      if (far < t1) t1 = far;
      if (t0 > t1){ hit = false; break; }
    }
    if (hit && (!strongest || box.multiplier > strongest.multiplier)) strongest = box;
  }
  return strongest;
}
