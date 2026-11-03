import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [menu, battle, campaign, css] = await Promise.all([
  readFile(new URL('../js/menu.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/battle.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/campaign.js', import.meta.url), 'utf8'),
  readFile(new URL('../css/style.css', import.meta.url), 'utf8'),
]);

assert.match(menu, /'TUTORIAL', ''/);
assert.match(menu, /showGuide:\s*true/);
assert.match(menu, /Shoot down both enemy fighters/);
assert.match(menu, /HOW TO FLY/);

assert.match(battle, /el\('div', 'flight-guide'\)/);
assert.match(battle, /RESUME FLIGHT/);
assert.match(battle, /this\.guideOpen = false/);
assert.match(battle, /this\.tutorial\.advance\(dt\)/);
assert.match(battle, /arrowdown/);
assert.match(battle, /arrowup/);
assert.match(battle, /arrowleft/);
assert.match(battle, /arrowright/);
assert.doesNotMatch(battle, /k === ['"]escape['"]/i);
assert.match(battle, /makeCloudTex/);
assert.match(battle, /makeMountainRing/);
assert.match(battle, /viewBase = p\.isShipCraft/);
assert.match(battle, /coreMat\.opacity/);

assert.match(campaign, /W \/ ↑/);
assert.match(campaign, /S \/ ↓/);
assert.match(css, /\.flight-guide\{/);
assert.match(css, /\.flight-guide-grid\{/);
assert.match(css, /#hud::after/);

console.log('Quality onboarding and fullscreen-safe control checks passed');
