// Aircraft-local axes drive both the navball and flight director. +Z is north.
const TAU = Math.PI * 2;
const limit = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

export function attitude(q){
  const { x, y, z, w } = q;
  const right = { x: 1-2*(y*y+z*z), y: 2*(x*y+z*w), z: 2*(x*z-y*w) };
  const up = { x: 2*(x*y-z*w), y: 1-2*(x*x+z*z), z: 2*(y*z+x*w) };
  const forward = { x: 2*(x*z+y*w), y: 2*(y*z-x*w), z: 1-2*(x*x+y*y) };
  return { right, up, forward, yaw: Math.atan2(forward.x, forward.z),
    pitch: Math.asin(limit(forward.y, -1, 1)), bank: Math.atan2(right.y, up.y) };
}

export function localDirection(v, frame){
  const dot = a => v.x*a.x + v.y*a.y + v.z*a.z;
  return { x: dot(frame.right), y: dot(frame.up), z: dot(frame.forward) };
}

export const FLIGHT_ACTIONS = [
  ['manual', 'Free flight', '1'], ['hold', 'Hold heading', '2'], ['level', 'Level flight', '3'],
  ['roll-left', 'Roll left', '4'], ['roll-right', 'Roll right', '5'], ['break', 'Break turn', '6'],
];

export function canManeuver(p){
  return !!p?.alive && !p.isShipCraft && !p.isBalloon && !p.grounded && !p.stalled;
}

export class FlightDirector {
  constructor(){ this.cancel(); }
  cancel(){ this.mode = 'manual'; this.maneuver = null; }
  select(mode, p){
    if (!FLIGHT_ACTIONS.some(a => a[0] === mode)) return false;
    if (mode !== 'manual' && !canManeuver(p)) return false;
    this.cancel();
    if (mode === 'manual') return true;
    const a = attitude(p.group.quaternion);
    this.mode = mode; this.yaw = a.yaw; this.pitch = a.pitch; this.altitude = p.pos?.y || 0;
    if (mode.startsWith('roll') || mode === 'break'){
      this.maneuver = { elapsed: 0, progress: 0, direction: mode === 'roll-right' ? -1 : 1 };
      if (mode === 'break') this.yaw = wrapAngle(a.yaw + Math.PI);
    }
    return true;
  }
  update(dt, p){
    if (this.mode === 'manual') return null;
    if (!canManeuver(p)){ this.cancel(); return null; }
    // Feed back vertical speed as well as altitude: simply pointing level after
    // a bank/roll leaves the craft falling under its existing downward momentum.
    const recoveryPitch = limit((this.altitude-(p.pos?.y || 0))*.003 - (p.vel?.y || 0)*.035, -.35, .7);
    const m = this.maneuver;
    if (m){
      m.elapsed += dt;
      const a = attitude(p.group.quaternion);
      const done = this.mode === 'break' ? Math.abs(wrapAngle(this.yaw-a.yaw)) < .08 : m.progress >= TAU;
      if ((done && m.elapsed > .4) || m.elapsed > (this.mode === 'break' ? 45 : 22)){
        this.mode = 'level'; this.maneuver = null; this.yaw = a.yaw;
        return { yaw: this.yaw, pitch: recoveryPitch, roll: 0 };
      }
      if (this.mode !== 'break'){
        // A small circular flight-path command accompanies the full body roll.
        return { yaw: this.yaw + .12*Math.sin(m.progress)*m.direction,
          pitch: limit(recoveryPitch + .22*(1-Math.cos(m.progress)), -.35, .85), roll: m.direction };
      }
      // Lead the velocity vector around the turn instead of pointing directly
      // backwards: opposing the momentum in one go stalls even the Falcon.
      if (p.vel && Math.hypot(p.vel.x,p.vel.z)>1){
        const track=Math.atan2(p.vel.x,p.vel.z);
        return { yaw: track + limit(wrapAngle(this.yaw-track), -.95, .95), pitch: recoveryPitch, roll: 0 };
      }
    }
    return { yaw: this.yaw, pitch: this.mode === 'level' || this.mode === 'break' ? recoveryPitch : this.pitch, roll: 0 };
  }
  consumeRoll(delta){
    const m = this.maneuver;
    if (!m || !this.mode.startsWith('roll')) return delta;
    const applied = Math.min(Math.abs(delta), TAU-m.progress) * m.direction;
    m.progress += Math.abs(applied);
    return applied;
  }
}
