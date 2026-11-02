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
- **1 / 2 / 3** — free flight / hold current heading and pitch / level flight.
- **4 / 5 / 6** — one left roll / one right roll / a 180° break turn, followed by level-flight recovery. Fixed-wing aircraft only; manual mouse steering or A/D cancels an assist or maneuver. Commands use the aircraft's own handling limits, not instant rotations.
- The bottom-center navball shows actual heading, pitch and bank (blue sky, amber ground); its green marker shows the velocity direction. The adjacent weapon schematic shows the selected weapon, ready ammunition, reserve and reload state. Combined weapons show **total** ammunition across the group.
- Quick Flight starts immediately. After seven seconds of flying, the simulation pauses for a hands-on **Tab** weapon-switch lesson, then resumes on command. **Skip tutorial** is always available; online matches are never paused by onboarding.
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

Public PvP works out of the box through the official always-on HTTPS relay at **https://ace-of-sky-ii-relay.jimpeng.chatgpt.site**. Up to ten human pilots open the public game, choose **PVP ONLINE**, select a mode and one unit to pilot, then the host creates a room and shares either the six-character code or the **COPY INVITE LINK** URL. No server setup or pasted URL is required. 1v1 uses two players, 3v3 and Oceanic Battle use six, and 5v5 uses the full ten-player lobby.

The CrazyGames HTML5 SDK v3 integration advertises joinable rooms with `updateRoom`, exposes the portal invite button plus the in-game invite-link button, reads invite parameters on startup and from the join-room listener, and routes `IsInstantMultiplayer` launches directly into a private PvP room. The room becomes non-joinable once both players connect, and the same party remains connected for rematches.

After the first completed campaign mission, eligible CrazyGames players can choose an optional rewarded video in the campaign hub for 1,000 credits. The offer has a ten-minute cooldown. Credits are granted only after the SDK's `adFinished` callback; unavailable or blocked ads give no credits, and the offer disappears for the session if CrazyGames reports `adsDisabled`. Missions remain the regular way to earn credits. The offer is hidden outside CrazyGames, including on GitHub Pages. CrazyGames disables ads and revenue sharing during Basic Launch; this integration becomes monetizable only when the game is eligible for ads on the platform.

The game uses a store-and-forward relay: every browser sends real-time state and combat events through a room event stream rather than making direct peer connections. Rooms, inactive pilot slots, and messages expire automatically. The public relay persists room state in D1 so it remains usable across backend instances.

For local development or a private LAN, the dependency-free Python reference relay is still available:

```bash
python3 server/relay.py        # starts the relay (default port 8787)
```

Open **Advanced: use a custom development relay** in PvP and enter `http://localhost:8787`. Browsers block an HTTPS game from calling an HTTP development relay, so use the local `serve.py` game for that path.

## Tech

### Lightweight project and release builds

Editable source still runs with `python3 serve.py 8126`; no npm install is required.
Run `node --test tests/*.test.mjs` for regression checks. To generate a smaller
CrazyGames upload, run `node scripts/build-release.mjs`. It bundles/minifies the
game and styles, removes unused library code, and writes a ZIP in `releases/`.
The pinned build tool uses npm's external cache (or `ESBUILD_BIN`); it does not
install a dependency tree inside this folder. Existing ZIPs are never overwritten.

Generated releases and portal media are kept outside the GitHub source tree.
The relay source and lockfile remain in `multiplayer-relay/`; install its
dependencies separately when doing relay development. Size checks should
include hidden files: `node scripts/check-size.mjs` checks both file bytes and
allocated disk space against a strict decimal 50 MB limit.

- Vanilla ES modules for development; optional minified release bundle. `index.html` loads `js/main.js`; an import map points `three` at `vendor/three.module.js`.
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
