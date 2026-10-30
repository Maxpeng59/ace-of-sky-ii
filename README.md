# Ace of Sky II

**Build · Arm · Dogfight** — a browser combat flight sim. Design an aircraft (or a whole fleet) out of ~400 parts, arm it, and fly it in dogfights, campaign missions, or human-vs-human PvP. No build step, no dependencies beyond a vendored copy of Three.js.

▶ **Play it: https://maxpeng59.github.io/ace-of-sky-ii/**

## Modes

- **Creative** — free-form skirmish. Pick a jet, set the enemies and environment, place both forces on a tactical map, and launch instantly. The chosen centers control real aircraft, ship, and carrier spawns.
- **Mission Planner** — select flight-ready enemy aircraft from your saved creation library and generate a seeded extreme operation across 12 theatres and 10 task templates. Every selected custom blueprint appears in a random-sized elite task group; the portable play code carries the aircraft designs and reproduces the complete mission on another device.
- **Campaign** — earn credits, buy aircraft & wingmen, fly missions, climb the ranks. All missions are available without prerequisites or loadout restrictions; Command supplies carrier support if you do not own one. First-run training/setup can be skipped with **Go to World Map**.
- **PvP Online** — 1v1, 3v3, 5v5, and three-vessel Oceanic Battle through the official HTTPS relay.

## Controls

- **Mouse** — fly toward the reticle (Gravity-Front control); the nose chases where you look.
- **W / S** — throttle trim · **Shift** — afterburner · **Z** — cut engine (glide) · **B** — airbrake
- **Click** — guns · **right-click / lock** — missiles · **F** — flares
- **Balloon role** — stays buoyant and uses **A / D** for level left/right turns, **Q / E** to climb/descend, **Space** to drop bombs directly, and **Click** to fire the selected gun. AI balloons use the same yaw steering and vertical control while lining up carrier attacks.
- **Ship role** — uses **A / D** as a naval helm and **W / S** for flank/slow speed. Ships stay level on the surface, follow the swell, and never bank, pitch, or fly like aircraft.
- Automatic turrets use role-based effective ranges and reduced fire-control damage: CIWS/MG/flak defend against aircraft, while heavy naval batteries target surface ships instead of unrealistically tracking fighters.
- **V** — toggle the top-down bombardment view and bomb impact/blast prediction
- In the hangar: **click** to place a part, **Shift+drag** to turn the view, **wheel** to zoom, **R / T / Y** to rotate a part.
- In the hangar: select a non-missile weapon and press **C** to combine every identical unpaired weapon into one simultaneous-fire group. Groups can contain any number of weapons and appear in flight as `Weapon ×N`; press **C** again to separate the group.
- The Hangar Library supports persistent folders and plane search. New or imported planes go into the open folder; deleting a folder keeps every aircraft and moves it to **Unfiled**.
- Localized damage rewards precise fire: direct hits through fuel tanks deal **2× damage**, cockpit/command sections **3×**, and engines **1.2×**. Jettisoned drop tanks no longer remain vulnerable targets, and successful hits are confirmed by a compact HUD cross instead of text popups.

## Run it locally

It's all static files — any static server works. A tiny one is included:

```bash
python3 serve.py 8126
# then open http://localhost:8126
```

## Human-vs-human PvP

Public PvP works out of the box through the official always-on HTTPS relay at **https://ace-of-sky-ii-relay.jimpeng.chatgpt.site**. Both players open the public game, choose **PVP ONLINE**, select **Quick Duel** or build a fleet, then one creates a room and shares the six-character code with the other. No server setup or pasted URL is required.

The game uses a store-and-forward relay: both browsers send real-time state and combat events to room mailboxes rather than making a direct peer connection. Rooms expire automatically. The public relay persists room and mailbox state in D1 so it remains usable across backend instances.

For local development or a private LAN, the dependency-free Python reference relay is still available:

```bash
python3 server/relay.py        # starts the relay (default port 8787)
```

Open **Advanced: use a custom development relay** in PvP and enter `http://localhost:8787`. Browsers block an HTTPS game from calling an HTTP development relay, so use the local `serve.py` game for that path.

## Tech

- Vanilla ES modules, no bundler. `index.html` loads `js/main.js`; an import map points `three` at `vendor/three.module.js`.
- Rendering: Three.js (WebGL). Physics, AI, and all gameplay are hand-rolled in `js/`.
- The official relay is a Sites full-stack app backed by D1; `server/relay.py` remains a dependency-free local reference implementation.

## Layout

```
index.html          entry point (import map + screens)
js/                 game code (engine, physics, ai, battle, hangar, parts, pvp, net, …)
css/                styles
vendor/             Three.js + a couple of loaders
server/relay.py     Optional local-development PvP relay
serve.py            local static dev server
```
