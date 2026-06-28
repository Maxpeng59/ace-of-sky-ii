// ============================================================================
//  Ace of Sky II — music.js
//  Looping menu background music (a cinematic track). Distinct from the Web-Audio
//  `sfx` engine: this is a single <audio> element that plays on the menu/lobby
//  screens and pauses during a battle (Battle.start/stop drive it).
//
//  Honours two settings: `masterVol` (the music sits a little under the SFX) and a
//  dedicated `music` on/off toggle. Browsers block audio until a user gesture, so
//  the first click/keypress kicks playback off if the initial play() was refused.
//
//  API:  Music.play()    — intent: we're on a menu screen, start/resume the loop
//        Music.pause()   — intent: a battle started, hold the loop
//        Music.refresh() — re-read the volume/toggle settings (call on slider/toggle)
// ============================================================================
import { State } from './core.js';

const TRACK = 'assets/menu-music.mp3';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let audio = null;
let wantPlay = false;          // are we on a menu screen (vs in a battle)?
let gestureHooked = false;

function musicOn(){ return (State.settings && State.settings.music) !== false; }
function vol(){ return clamp(((State.settings && State.settings.masterVol) ?? 0.8) * 0.55, 0, 1); }

function ensure(){
  if (audio) return audio;
  audio = new Audio(TRACK);
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = vol();
  return audio;
}

// The browser refuses audio.play() until the user interacts. Retry once on the
// first gesture, then stop listening.
function hookGesture(){
  if (gestureHooked) return;
  gestureHooked = true;
  const kick = () => {
    removeEventListener('pointerdown', kick); removeEventListener('keydown', kick); removeEventListener('touchstart', kick);
    gestureHooked = false;
    if (wantPlay && musicOn()) start();
  };
  addEventListener('pointerdown', kick); addEventListener('keydown', kick); addEventListener('touchstart', kick);
}

function start(){
  ensure();
  audio.volume = vol();
  const p = audio.play();
  if (p && p.catch) p.catch(() => hookGesture());   // blocked → wait for a gesture
}

export const Music = {
  play(){
    wantPlay = true;
    if (musicOn()) start(); else hookGesture();
    hookGesture();
  },
  pause(){
    wantPlay = false;
    if (audio) audio.pause();
  },
  refresh(){
    if (audio) audio.volume = vol();
    if (!musicOn()){ if (audio) audio.pause(); return; }
    if (wantPlay && (!audio || audio.paused)) start();
  },
};
