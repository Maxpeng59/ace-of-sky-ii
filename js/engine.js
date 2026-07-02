// ============================================================================
//  Ace of Sky II — engine.js
//  ONE shared WebGL renderer + ONE rAF loop for the whole game, so the hangar,
//  the battle sim and any preview never create competing WebGL contexts.
//  Screens call setScene(scene,camera) to choose what's drawn and onFrame(fn)
//  to register a per-frame update; both are cleared on screen switch.
// ============================================================================
import * as THREE from 'three';

let renderer = null, canvas = null;
let curScene = null, curCamera = null;
const frameCbs = new Set();
let running = false, last = 0;

// Adaptive resolution — hold a smooth ~60 FPS by trading render scale ONLY under load, and
// restoring full sharpness when the GPU has headroom. A complex ship battle scales the render
// buffer down to keep framerate; the menu/hangar/light fights stay at full DPR. Touches only
// the WebGL drawing-buffer resolution (CSS size and the separate 2D HUD canvas are unaffected).
let dprCap = 1, dprFloor = 0.8, curDpr = 1, frameEMA = 1 / 60, adaptT = 0;

export function initEngine(canvasEl){
  canvas = canvasEl || document.getElementById('gl');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  dprCap = Math.min(devicePixelRatio || 1, 2);
  curDpr = dprCap;
  renderer.setPixelRatio(curDpr);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
  // PCF (not PCFSoft): the soft variant taps the shadow map many more times PER LIT PIXEL —
  // at Retina resolutions that's a large hidden fill cost for a barely-visible edge change.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  addEventListener('resize', resize);
  resize();
  start();
  return renderer;
}
export function getRenderer(){ return renderer; }
export function getCanvas(){ return canvas; }

export function resize(){
  if (!renderer) return;
  renderer.setSize(innerWidth, innerHeight, false);
  if (curCamera && curCamera.isPerspectiveCamera){ curCamera.aspect = innerWidth / innerHeight; curCamera.updateProjectionMatrix(); }
  for (const fn of frameCbs) if (fn._onResize) fn._onResize();
}

export function setScene(scene, camera){
  curScene = scene; curCamera = camera;
  // start every scene at full render scale; the adaptive scaler drops it only if THIS scene
  // can't hold ~60 FPS — so the menu/hangar/light fights stay crisp and a heavy ship battle
  // scales itself down. (Up-scaling mid-scene is unreliable under vsync, so we reset here.)
  curDpr = dprCap; frameEMA = 1 / 60; adaptT = 0;
  if (renderer){ renderer.setPixelRatio(curDpr); renderer.setSize(innerWidth, innerHeight, false); }
  if (camera && camera.isPerspectiveCamera){ camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
}

// register update(dt) called every frame; returns an unsubscribe fn
export function onFrame(fn){ frameCbs.add(fn); return () => frameCbs.delete(fn); }
export function clearFrame(){ frameCbs.clear(); }

// fully reset the render target when leaving a screen
export function resetView(){ clearFrame(); curScene = null; curCamera = null; if (renderer) renderer.clear(); }

export function start(){ if (running) return; running = true; last = performance.now(); requestAnimationFrame(loop); }
export function stop(){ running = false; }

function loop(now){
  if (!running) return;
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1;                 // clamp after tab-switches
  for (const fn of frameCbs){ try { fn(dt); } catch (e){ console.error('frame cb', e); } }
  if (renderer && curScene && curCamera){
    renderer.render(curScene, curCamera);
    // Adaptive down-scale: if frames are sustained slower than ~60 FPS, shed render resolution
    // (toward dprFloor) to recover smoothness. EMA-smoothed so a single hitch doesn't trigger it;
    // re-evaluated twice a second; reset to full on each setScene(). Only the WebGL buffer scales.
    if (dprCap > dprFloor){
      frameEMA += (dt - frameEMA) * 0.1;
      adaptT += dt;
      if (adaptT >= 0.5){
        adaptT = 0;
        if (frameEMA * 1000 > 17.5 && curDpr > dprFloor){
          curDpr = Math.max(dprFloor, curDpr - 0.15);
          renderer.setPixelRatio(curDpr);
          renderer.setSize(innerWidth, innerHeight, false);
        }
      }
    }
  }
  requestAnimationFrame(loop);
}
