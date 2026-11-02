// Simulation-time state machine: no timers can advance the lesson in a hidden tab.
export class FlightTutorial {
  constructor(enabled){ this.stage = enabled ? 'fly' : 'off'; this.elapsed = 0; this.switched = false; }
  get paused(){ return this.stage === 'weapon'; }
  advance(dt){
    if (this.stage !== 'fly' && this.stage !== 'practice') return false;
    this.elapsed += dt;
    if (this.stage === 'fly' && this.elapsed >= 7){ this.stage = 'weapon'; this.elapsed = 0; return true; }
    if (this.stage === 'practice' && this.elapsed >= 6) this.stage = 'done';
    return false;
  }
  weaponChanged(before, after){ if (this.paused && before !== after) this.switched = true; }
  resume(weaponCount){
    if (!this.paused || (weaponCount > 1 && !this.switched)) return false;
    this.stage = 'practice'; this.elapsed = 0; return true;
  }
  skip(){ this.stage = 'done'; }
}
