# Ace of Sky II

**Build · Arm · Dogfight** — a browser combat flight sim. Design an aircraft (or a whole fleet) out of ~400 parts, arm it, and fly it in dogfights, campaign missions, or human-vs-human PvP. No build step, no dependencies beyond a vendored copy of Three.js.

▶ **Play it: https://maxpeng59.github.io/ace-of-sky-ii/**

## Modes

- **Creative** — free-form skirmish. Pick a jet, set the enemies and environment, launch instantly.
- **Campaign** — earn credits, buy aircraft & wingmen, fly missions, climb the ranks.
- **PvP** — budget-build a fleet and dogfight another human over a relay (see below).

## Controls

- **Mouse** — fly toward the reticle (Gravity-Front control); the nose chases where you look.
- **W / S** — throttle trim · **Shift** — afterburner · **Z** — cut engine (glide) · **B** — airbrake
- **Click** — guns · **right-click / lock** — missiles · **F** — flares
- **Balloon role** — stays buoyant and flies forward like a plane; hold **Q** to climb, **E** to descend, press **Space** to drop bombs directly, and **Click** to fire the selected gun. AI balloons understand vertical steering and use bomb loadouts as their primary carrier-attack role.
- **V** — toggle the top-down bombardment view and bomb impact/blast prediction
- In the hangar: **click** to place a part, **Shift+drag** to turn the view, **wheel** to zoom, **R / T / Y** to rotate a part.
- In the hangar: select a non-missile weapon and press **C** to combine every identical unpaired weapon into one simultaneous-fire group. Groups can contain any number of weapons and appear in flight as `Weapon ×N`; press **C** again to separate the group.
- Fuel tanks are lightweight but volatile: they contribute reduced durability, and a direct hit through a tank deals **2× damage** to the aircraft. Jettisoned drop tanks no longer remain vulnerable targets.

## Run it locally

It's all static files — any static server works. A tiny one is included:

```bash
python3 serve.py 8126
# then open http://localhost:8126
```

## Human-vs-human PvP

PvP uses a small **store-and-forward relay** (`server/relay.py`) — both browsers talk to the relay, which mailboxes messages per room. There is no direct peer connection.

```bash
python3 server/relay.py        # starts the relay (default port 8787)
```

In the PvP lobby, paste the relay's address, then one player **hosts** a room and the other **joins** with the room code.

**Playing over the internet:** the hosted game at the link above is served over HTTPS, so the relay must also be reachable over **HTTPS** (browsers block an HTTPS page from calling an HTTP relay). Options: deploy `relay.py` to any small always-on host that gives you HTTPS (a free PaaS, a VPS, or a tunnel like `cloudflared`), then paste that URL. For same-machine / LAN testing, run the local dev server (`serve.py`) over plain HTTP and use the `localhost:8787` relay.

## Tech

- Vanilla ES modules, no bundler. `index.html` loads `js/main.js`; an import map points `three` at `vendor/three.module.js`.
- Rendering: Three.js (WebGL). Physics, AI, and all gameplay are hand-rolled in `js/`.
- The relay (`server/relay.py`) is dependency-free Python (standard library only).

## Layout

```
index.html          entry point (import map + screens)
js/                 game code (engine, physics, ai, battle, hangar, parts, pvp, net, …)
css/                styles
vendor/             Three.js + a couple of loaders
server/relay.py     PvP relay (run separately)
serve.py            local static dev server
```
