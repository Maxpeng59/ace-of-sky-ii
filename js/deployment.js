// Shared tactical-deployment math. Creative owns the map UI; Battle consumes
// the exact same coordinates so the preview is the real spawn layout.
export const DEPLOY_LIMIT = 3000;

export const DEFAULT_DEPLOYMENT = Object.freeze({
  ally: Object.freeze({ x: 0, z: -900 }),
  enemy: Object.freeze({ x: 0, z: 1600 }),
});

export function clampDeploymentPoint(point, fallback){
  const fb = fallback || { x: 0, z: 0 };
  const x = Number.isFinite(Number(point && point.x)) ? Number(point.x) : fb.x;
  const z = Number.isFinite(Number(point && point.z)) ? Number(point.z) : fb.z;
  return {
    x: Math.max(-DEPLOY_LIMIT, Math.min(DEPLOY_LIMIT, Math.round(x))),
    z: Math.max(-DEPLOY_LIMIT, Math.min(DEPLOY_LIMIT, Math.round(z))),
  };
}

export function normalizeDeployment(value){
  return {
    ally: clampDeploymentPoint(value && value.ally, DEFAULT_DEPLOYMENT.ally),
    enemy: clampDeploymentPoint(value && value.enemy, DEFAULT_DEPLOYMENT.enemy),
  };
}

// Three.js craft point down local +Z, so atan2(dx, dz) faces `from` at `to`.
export function deploymentYaw(from, to){
  return Math.atan2(to.x - from.x, to.z - from.z);
}

// Convert a formation slot (right/forward) into battlefield X/Z coordinates.
export function formationPosition(origin, yaw, lateral = 0, forward = 0, y = 0){
  return {
    x: origin.x + Math.cos(yaw) * lateral + Math.sin(yaw) * forward,
    y,
    z: origin.z - Math.sin(yaw) * lateral + Math.cos(yaw) * forward,
  };
}

export function deploymentDistance(value){
  const d = normalizeDeployment(value);
  return Math.hypot(d.enemy.x - d.ally.x, d.enemy.z - d.ally.z);
}
