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

export function initEngine(canvasEl){
  canvas = canvasEl || document.getElementById('gl');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
  if (renderer && curScene && curCamera) renderer.render(curScene, curCamera);
  requestAnimationFrame(loop);
}
