import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Model the browser's drawing buffer: resizing a WebGL canvas clears it.
// Every animation frame must end with a draw, including frames that adapt DPR.
const source = fs.readFileSync(new URL('../js/engine.js', import.meta.url), 'utf8');
const frames = [];
const events = [];
const canvas = { painted: false };
let now = 0;
class Renderer {
  constructor(){ this.shadowMap = {}; }
  setPixelRatio(value){ canvas.painted = false; events.push(['resize', value]); }
  setSize(){ canvas.painted = false; events.push(['resize-size']); }
  render(){ canvas.painted = true; events.push(['draw']); }
  clear(){ canvas.painted = true; }
}
const context = vm.createContext({
  THREE: { WebGLRenderer: Renderer, PCFShadowMap: 1, SRGBColorSpace: 2, ACESFilmicToneMapping: 3 },
  document: { getElementById: () => canvas },
  devicePixelRatio: 2, innerWidth: 1280, innerHeight: 720,
  performance: { now: () => now },
  addEventListener(){}, requestAnimationFrame: callback => frames.push(callback),
  console,
});
vm.runInContext(source.replace(/^import .*\n/m, '').replace(/export function /g, 'function ')
  + '\nthis.api = { initEngine, setScene };', context);
context.api.initEngine(canvas);
context.api.setScene({}, {});

let resizedDuringFlight = false;
for (let i = 0; i < 30; i++){
  now += 22; // sustained ~45 FPS triggers adaptive resolution
  const frameEventsStart = events.length;
  frames.shift()(now);
  const frameEvents = events.slice(frameEventsStart);
  if (frameEvents.some(([type]) => type === 'resize')) resizedDuringFlight = true;
  assert.equal(canvas.painted, true, `frame ${i} left a cleared canvas visible`);
  assert.equal(frameEvents.at(-1)?.[0], 'draw', `frame ${i} must draw after any resize`);
}
assert.equal(resizedDuringFlight, true, 'the test must exercise an adaptive resize');
console.log('Adaptive rendering never presents an empty WebGL frame');
