// ============================================================================
//  Ace of Sky II — campaign.js
//  The CAMPAIGN HUB (#screen-campaign). A real economy loop: everything costs
//  money. You buy/design aircraft into a personal hangar, hire named wingmen,
//  commission a single aircraft carrier, then deploy those assets on missions.
//  Win → earn the reward, mark the mission complete, advance the day, and (now
//  and then) earn a promotion. Lose → you keep your kit but pay the day for it.
//
//  Public API (per CONTRACT.md):  export const Campaign  with  Campaign.show()
//  Reads/writes State.campaign + the credit economy; persists with save().
// ============================================================================
import {
  $, el, clear, fmtCr, fmtNum, toast, sfx, clamp,
} from './util.js';
import {
  State, save, spend, earn, canAfford,
  libGet, libSave, cloneDesign, newDesign, statsOf,
  importCode, STOCK_DESIGNS, stockGet, uid, bus,
} from './core.js';
import { Hangar } from './hangar.js';
import { Battle } from './battle.js?v=20261030-10p';
import { Menu } from './menu.js';

// ---------------------------------------------------------------------------
//  RANKS — completing missions advances the day; enough completions promote you.
//  Each promotion bumps your standing and (cosmetically) your reputation.
// ---------------------------------------------------------------------------
const RANKS = [
  { name: 'Cadet',         req: 0 },
  { name: 'Pilot Officer',  req: 2 },
  { name: 'Flight Lieutenant', req: 4 },
  { name: 'Squadron Leader', req: 7 },
  { name: 'Wing Commander',  req: 10 },
  { name: 'Group Captain',   req: 14 },
  { name: 'Air Commodore',   req: 18 },
  { name: 'Air Marshal',     req: 24 },
];
function rankForCompleted(n){
  let r = RANKS[0];
  for (const x of RANKS) if (n >= x.req) r = x;
  return r.name;
}

// ---------------------------------------------------------------------------
//  WINGMAN SKILL TIERS — hiring price scales with the pilot's competence, which
//  feeds straight into Battle's AI `skill` (0..1).
// ---------------------------------------------------------------------------
const SKILL_TIERS = [
  { name: 'Rookie',   skill: 0.35, fee: 1200 },
  { name: 'Regular',  skill: 0.55, fee: 2600 },
  { name: 'Veteran',  skill: 0.72, fee: 5200 },
  { name: 'Ace',      skill: 0.9,  fee: 11000 },
];
const CALLSIGNS = [
  'Viper', 'Maverick', 'Ghost', 'Reaper', 'Talon', 'Specter', 'Hawk', 'Cobra',
  'Raven', 'Falcon', 'Wraith', 'Saber', 'Banshee', 'Nomad', 'Striker', 'Echo',
  'Vandal', 'Lancer', 'Comet', 'Onyx', 'Razor', 'Phoenix', 'Jester', 'Bishop',
];
function randomCallsign(){ return CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)]; }

// ---------------------------------------------------------------------------
//  MISSIONS — the heart of the loop. Each is a discrete challenge with a brief,
//  an environment, an objective passed verbatim to Battle.start, an enemy
//  loadout (stock designs scaled by count + skill) and a reward. Every mission
//  is available immediately. Capital-ship missions provide a command-support
//  carrier when the player has not commissioned their own.
//
//  enemy entries reference STOCK_DESIGNS by id; Battle resolves them via
//  stockGet().  objective.type is whatever Battle understands — we keep to a
//  small documented vocabulary: 'deathmatch' | 'escort' | 'survive' | 'strike'.
// ---------------------------------------------------------------------------
export const MISSIONS = [
  {
    id: 'm_patrol',
    title: 'Dawn Patrol',
    brief: 'Recon drones are probing a Global Force security corridor. Sweep them from the sky before they map the coalition defences.',
    env: 'day',
    reward: 4200,
    enemies: [{ stock: 'stock_falcon', count: 4, skill: 0.3 }],
    objective: { type: 'deathmatch', label: 'Destroy all 4 recon drones' },
    timeLimit: 0,
  },
  {
    id: 'm_intercept',
    title: 'Intercept the Bomber Wave',
    brief: 'A flight of heavy bombers with light escort is inbound on the airfield. Tear into them before they reach their release point.',
    env: 'dusk',
    reward: 7600,
    enemies: [
      { stock: 'stock_fortress', count: 2, skill: 0.45 },
      { stock: 'stock_falcon', count: 3, skill: 0.4 },
    ],
    objective: { type: 'deathmatch', label: 'Down 2 bombers and their escort' },
    timeLimit: 0,
  },
  {
    id: 'm_escort',
    title: 'Escort the Carrier',
    brief: 'Your carrier is steaming through contested waters. Enemy strike craft want it on the sea floor — keep them off it until the channel is clear.',
    env: 'sea',
    reward: 9800,
    friendlyCarrier: 'stock_carrier',
    enemies: [
      { stock: 'stock_falcon', count: 3, skill: 0.55 },
      { stock: 'stock_falcon', count: 2, skill: 0.5 },
    ],
    objective: { type: 'escort', label: 'Protect your carrier — let none through' },
    timeLimit: 180,
  },
  {
    id: 'm_aceduel',
    title: 'Ace Duel: "Crimson"',
    brief: 'The enemy\'s top ace flies a hand-built interceptor and has never lost. Take on Crimson alone or bring your wingmen — the choice is yours.',
    env: 'day',
    reward: 12000,
    enemies: [{ stock: 'stock_falcon', count: 1, skill: 0.95, name: 'Crimson' }],
    objective: { type: 'deathmatch', label: 'Defeat the ace' },
    timeLimit: 0,
  },
  {
    id: 'm_strike',
    title: 'Strike: Sink the Enemy Carrier',
    brief: 'Recon found the enemy flat-top anchored in the bay, ringed by air cover. Punch through, put it under the waves, and get home.',
    env: 'sea',
    reward: 16500,
    enemyCarrier: 'stock_carrier',
    enemies: [
      { stock: 'stock_falcon', count: 3, skill: 0.6 },
      { stock: 'stock_falcon', count: 4, skill: 0.45 },
    ],
    objective: { type: 'strike', label: 'Sink the enemy carrier' },
    timeLimit: 240,
  },
  {
    id: 'm_gauntlet',
    title: 'The Gauntlet',
    brief: 'Wave after wave, no reinforcements. Survive everything they send and you walk away rich. Bring everyone you can afford.',
    env: 'night',
    reward: 22000,
    enemies: [
      { stock: 'stock_falcon', count: 4, skill: 0.6 },
      { stock: 'stock_falcon', count: 3, skill: 0.65 },
      { stock: 'stock_goliath', count: 2, skill: 0.7 },
    ],
    objective: { type: 'survive', label: 'Survive all waves', waves: 3 },
    timeLimit: 300,
  },
  {
    id: 'm_nightwatch',
    title: 'Night Watch',
    brief: 'Smugglers run drones under cover of darkness. Hunt them down — they\'re cheap, but there are a lot of them and you can\'t see far.',
    env: 'night',
    reward: 6400,
    enemies: [{ stock: 'stock_falcon', count: 6, skill: 0.4 }],
    objective: { type: 'deathmatch', label: 'Clear all 6 night runners' },
    timeLimit: 0,
  },
  {
    id: 'm_polarshield',
    title: 'Polar Shield',
    brief: 'Long-range raiders are crossing the polar route beneath a communications blackout. Intercept them before they reach the civilian air corridor.',
    env: 'day',
    reward: 8800,
    enemies: [
      { stock: 'stock_fortress', count: 2, skill: 0.48 },
      { stock: 'stock_falcon', count: 3, skill: 0.46 },
    ],
    objective: { type: 'deathmatch', label: 'Break the polar bomber formation' },
    timeLimit: 180,
  },
  {
    id: 'm_med_lifeline',
    title: 'Mediterranean Lifeline',
    brief: 'A relief fleet is trapped between two hostile air groups. Keep your carrier afloat and open a safe lane through the fighting.',
    env: 'sea',
    reward: 13200,
    friendlyCarrier: 'stock_carrier',
    enemies: [
      { stock: 'stock_falcon', count: 4, skill: 0.56 },
      { stock: 'stock_goliath', count: 2, skill: 0.5 },
    ],
    objective: { type: 'escort', label: 'Hold the relief corridor for 3 minutes' },
    timeLimit: 180,
  },
  {
    id: 'm_sahel_thunder',
    title: 'Sahel Thunder',
    brief: 'A desert offensive has overrun three forward strips. Fly low through the dust front and destroy the aircraft covering the advance.',
    env: 'dusk',
    reward: 11800,
    enemies: [
      { stock: 'stock_falcon', count: 5, skill: 0.54 },
      { stock: 'stock_goliath', count: 1, skill: 0.58 },
    ],
    objective: { type: 'deathmatch', label: 'Clear the desert offensive air cover' },
    timeLimit: 210,
  },
  {
    id: 'm_pacific_spear',
    title: 'Pacific Spear',
    brief: 'An enemy carrier group is cutting the ocean supply chain. Find the flagship in open water, fight through its combat patrol, and sink it.',
    env: 'sea',
    reward: 19400,
    enemyCarrier: 'stock_carrier',
    enemies: [
      { stock: 'stock_falcon', count: 4, skill: 0.62 },
      { stock: 'stock_goliath', count: 2, skill: 0.6 },
    ],
    objective: { type: 'strike', label: 'Sink the Pacific carrier group' },
    timeLimit: 240,
  },
  {
    id: 'm_skybridge',
    title: 'Himalayan Skybridge',
    brief: 'Mountain passes are the last route into an encircled city. Survive repeated attacks while command pushes transports through the high corridor.',
    env: 'day',
    reward: 16800,
    enemies: [
      { stock: 'stock_falcon', count: 4, skill: 0.63 },
      { stock: 'stock_fortress', count: 2, skill: 0.58 },
    ],
    objective: { type: 'survive', label: 'Keep the skybridge open through 3 waves', waves: 3 },
    timeLimit: 240,
  },
  {
    id: 'm_firebreak',
    title: 'Global Firebreak',
    brief: 'The separate wars have merged into one coordinated offensive. Global Command is committing every available squadron to stop the chain reaction.',
    env: 'night',
    reward: 32000,
    friendlyCarrier: 'stock_carrier',
    enemies: [
      { stock: 'stock_falcon', count: 5, skill: 0.72 },
      { stock: 'stock_fortress', count: 3, skill: 0.7 },
      { stock: 'stock_goliath', count: 2, skill: 0.75 },
    ],
    objective: { type: 'survive', label: 'Stop the worldwide offensive', waves: 4 },
    timeLimit: 300,
  },
  {
    id: 'm_decisive',
    title: 'Decisive Engagement',
    brief: 'The enemy commits their reserve to one last push. Defend your carrier against a full air wing AND their flagship carrier. Win this and the war is yours.',
    env: 'sea',
    reward: 40000,
    friendlyCarrier: 'stock_carrier',
    enemyCarrier: 'stock_carrier',
    enemies: [
      { stock: 'stock_falcon', count: 4, skill: 0.7 },
      { stock: 'stock_falcon', count: 4, skill: 0.7 },
      { stock: 'stock_goliath', count: 2, skill: 0.75 },
    ],
    objective: { type: 'escort', label: 'Protect your carrier and break the enemy fleet' },
    timeLimit: 300,
  },
];
function missionById(id){ return MISSIONS.find(m => m.id === id); }

// ---------------------------------------------------------------------------
//  Module state — DOM root, current tab, listeners to clean up on exit.
// ---------------------------------------------------------------------------
const TABS = [
  { key: 'hangar',   label: 'Hangar' },
  { key: 'wingmen',  label: 'Wingmen' },
  { key: 'carrier',  label: 'Carrier' },
  { key: 'missions', label: 'World Map' },
];
let root = null;
let curTab = 'missions';
let curRegion = null;        // selected world-map theatre id
let moneyOff = null;          // bus 'money' unsubscribe
const dom = {};              // cached header nodes for cheap refreshes

// ---------------------------------------------------------------------------
//  helpers
// ---------------------------------------------------------------------------
function hideOtherScreens(){
  for (const id of ['screen-menu', 'screen-creative', 'screen-mission-planner', 'screen-pvp', 'screen-hangar']){
    const n = $(id); if (n) n.classList.add('hidden');
  }
  const hud = $('hud'); if (hud) hud.classList.add('hidden');
}

// Resolve an owned-hangar id to a live design. Owned ids may point at a library
// design (player-built) or a stock design (factory). We normalise to a design.
function designForOwnedId(id){
  const lib = libGet(id);
  if (lib) return lib;
  const stock = stockGet(id);          // stockGet returns a fresh clone
  if (stock){ stock.id = id; return stock; }
  return null;
}

// The set of designs the player can deploy. Ensures at least a starter exists.
function ownedDesigns(){
  ensureStarterHangar();
  return State.campaign.hangar
    .map(id => designForOwnedId(id))
    .filter(Boolean);
}

// First-run safety: if the player owns nothing, grant one cheap library design
// so the loop is never soft-locked. (They still pay for everything after this.)
function ensureStarterHangar(){
  const c = State.campaign;
  if (!c.hangar) c.hangar = [];
  if (c.hangar.length === 0){
    // gift the cheapest library design they already have, else a Wasp clone.
    let starter = null;
    if (State.library && State.library.length){
      starter = State.library
        .slice()
        .sort((a, b) => statsOf(a).cost - statsOf(b).cost)[0];
    }
    if (!starter){
      starter = cloneDesign(STOCK_DESIGNS.find(s => s.id === 'stock_falcon'), '');
      libSave(starter);
    }
    c.hangar.push(starter.id);
    save();
  }
}

function refreshTopbar(){
  if (!dom.money) return;
  dom.money.textContent = fmtCr(State.money);
  dom.day.textContent = 'Day ' + State.campaign.day;
  dom.rank.textContent = State.campaign.rank;
  const done = State.campaign.completed.length;
  dom.progress.textContent = done + ' / ' + MISSIONS.length + ' missions';
}

// ---------------------------------------------------------------------------
//  PUBLIC: Campaign.show()
// ---------------------------------------------------------------------------
export const Campaign = {
  show(){
    root = $('screen-campaign');
    if (!root){ console.error('campaign: #screen-campaign missing'); return; }
    const c = State.campaign;
    if (!c.rank) c.rank = 'Cadet';
    if (!Number.isFinite(c.worldSeed) || c.worldSeed <= 0) c.worldSeed = Math.floor(Math.random() * 0x7fffffff) + 1;
    // migrate older saves: anyone with real progress skips the first-run flow.
    if (c.onboard == null) c.onboard = (c.completed.length || c.carrierId || c.started) ? 'done' : 'intro';
    c.started = true;
    save();

    // Optional first-run guidance (intro → tutorial → carrier → plane).
    // Every panel can jump straight to the World Map without completing it.
    if (c.onboard !== 'done'){ if (moneyOff){ moneyOff(); moneyOff = null; } renderOnboarding(); return; }

    ensureStarterHangar();
    save();
    hideOtherScreens();
    root.classList.remove('hidden');
    root.classList.add('campaign-global');

    buildShell();
    selectTab(curTab);

    // live-update the credits readout whenever the economy changes elsewhere
    if (moneyOff) moneyOff();
    moneyOff = bus.on('money', () => refreshTopbar());
  },

  // teardown — main.js may call this, and we call it ourselves on BACK.
  close(){
    if (moneyOff){ moneyOff(); moneyOff = null; }
    if (root){ clear(root); root.classList.add('hidden'); }
  },
};

// ===========================================================================
//  FIRST-RUN ONBOARDING — intro → training flight → carrier → first fighter.
//  A scripted establishment: you start with a Falcon, fly a tutorial intercept
//  against a Wasp, then Command stakes you a ¥20,000 carrier and a ¥18,000
//  operating budget for your own plane. After that, normal operations begin.
// ===========================================================================
const STARTING_BUDGET = 18000;     // the "original starting budget" for the first plane
const CARRIER_ALLOWANCE = 20000;   // Command's grant to commission a carrier

function setOnboard(p){ State.campaign.onboard = p; save(); }

// Grant (once) the player's starting Falcon, returning the owned design.
function ensureFalcon(){
  const c = State.campaign;
  if (!c.hangar) c.hangar = [];
  for (const id of c.hangar){ const d = designForOwnedId(id); if (d && /falcon/i.test(d.name || '')) return d; }
  const falcon = cloneDesign(STOCK_DESIGNS.find(s => s.id === 'stock_falcon'), '');
  falcon.author = 'You';
  libSave(falcon); c.hangar.push(falcon.id); save();
  return falcon;
}

// A centred narrative/CTA card used for every onboarding step.
function onboardPanel(eyebrow, title, bodyHTML, cta, fn, opts = {}){
  const wrap = el('div');
  wrap.style.cssText = 'max-width:680px;margin:7vh auto 0;';
  const card = el('div', 'panel'); card.style.cssText = 'padding:34px 40px;';
  card.appendChild(el('div', 'eyebrow', eyebrow));
  const h = el('div'); h.style.cssText = 'font-size:30px;font-weight:800;letter-spacing:.02em;margin:4px 0 18px;';
  h.textContent = title; card.appendChild(h);
  const b = el('div'); b.style.cssText = 'font-size:15px;line-height:1.75;color:#aab6c4;';
  b.innerHTML = bodyHTML; card.appendChild(b);
  const row = el('div', 'row'); row.style.cssText = 'margin-top:28px;justify-content:flex-end;gap:10px;align-items:center;';
  if (opts.note){ const n = el('div', 'muted small', opts.note); n.style.marginRight = 'auto'; row.appendChild(n); }
  const skip = el('button', 'btn ghost', 'Go to World Map');
  skip.onclick = () => { sfx('click'); setOnboard('done'); curTab = 'missions'; Campaign.show(); };
  row.appendChild(skip);
  const go = el('button', 'btn accent', cta); go.style.cssText = 'font-size:15px;padding:11px 24px;';
  go.onclick = () => { sfx('click'); fn(); };
  row.appendChild(go);
  card.appendChild(row); wrap.appendChild(card);
  return wrap;
}

function renderOnboarding(){
  hideOtherScreens();
  root.classList.remove('hidden');
  clear(root);
  ensureFalcon();
  const step = State.campaign.onboard;
  if (step === 'intro') return onboardIntro();
  if (step === 'tutorial') return onboardTutorial();
  if (step === 'carrier') return onboardCarrier();
  if (step === 'plane') return onboardPlane();
  setOnboard('done'); Campaign.show();   // safety: unknown step → finish
}

function onboardIntro(){
  const pages = [
    { eyebrow: 'Global Force Command · 06:00', title: 'The world is on fire',
      body: `Cadet — several wars have erupted across the globe at once. Global Force has been formed to move pilots, carriers and aircraft wherever a front breaks open.<br><br>You've been issued a <b>Falcon</b> — a clean single-seat interceptor — and a place in the worldwide response wing. Every sortie can send you to a different country.` },
    { eyebrow: 'Global Force Command · 06:02', title: 'Optional flight training',
      body: `You can head straight to the <b>World Map</b> and choose any live task, or practise with a <b>training intercept</b>: one lone <b>target drone</b>, low-grade AI.<br><br>The guided setup also helps you build a <b>carrier</b> and a home-built fighter. Neither training nor owning a carrier is required to fly a mission — Command supplies carrier support when needed.` },
  ];
  let i = 0;
  const render = () => {
    clear(root); const p = pages[i];
    root.appendChild(onboardPanel(p.eyebrow, p.title, p.body,
      i < pages.length - 1 ? 'Continue ▸' : 'Begin flight training ▸',
      () => { i++; if (i < pages.length) render(); else { setOnboard('tutorial'); renderOnboarding(); } },
      { note: `Page ${i + 1} / ${pages.length}` }));
  };
  render();
}

function onboardTutorial(){
  const body = `<b>Controls</b><br>· <b>Mouse</b> — aim; your nose chases the reticle.<br>· <b>Shift</b> — boost · <b>S</b> — brake · <b>Z</b> — cut engine to glide.<br>· <b>Left click</b> — guns. <b>Hold</b> on a target to build a missile lock, release to fire.<br>· <b>P</b> — aim-assist (snaps guns to the lead point) · <b>B</b> — airbrake.<br><br>Target: a single <b>target drone</b>. Get on its tail and put it down.`;
  root.appendChild(onboardPanel('Training Flight', 'Intercept the drone', body, 'Launch ▸', () => {
    const falcon = ensureFalcon();
    launchTutorialBattle(falcon);
  }, { note: 'Lose and you can simply re-fly it.' }));
}

function launchTutorialBattle(playerDesign){
  const wasp = stockGet('stock_falcon');
  if (!wasp){ setOnboard('carrier'); Campaign.show(); return; }
  const player = cloneDesign(playerDesign, ''); player.author = 'You';
  const config = {
    player, allies: [],
    enemies: [{ design: wasp, count: 1, skill: 0.2 }],
    env: 'day',
    objective: { type: 'deathmatch', label: 'Down the training drone' },
    timeLimit: 0, carrier: null, enemyCarrier: null, net: null,
    onEnd: (result) => {
      if (result && result.win) setOnboard('carrier');
      Campaign.show();                       // win → carrier step; lose → tutorial again
    },
  };
  if (root) root.classList.add('hidden');
  sfx('lockfull');
  try { Battle.start(config); }
  catch (e){ console.error('tutorial battle failed', e); toast('Could not start: ' + e.message, 'bad'); Campaign.show(); }
}

function onboardCarrier(){
  State.money = CARRIER_ALLOWANCE; save();    // Command's carrier grant
  const body = `Clean kill, pilot — you're cleared for operations.<br><br>Command is staking you a <b>${fmtCr(CARRIER_ALLOWANCE)}</b> allowance to commission your own <b>aircraft carrier</b>: your mobile base for the whole campaign. Big fuselages, armour, defensive guns — design the hull and spend the grant as you see fit.`;
  root.appendChild(onboardPanel('Command Grant', 'Commission your carrier', body, 'Open the carrier yard ▸', () => {
    const draft = newDesign('CV Aegis'); draft.role = 'carrier';
    Hangar.open({
      design: draft, title: 'Carrier Yard — commission (¥20,000 allowance)', budget: CARRIER_ALLOWANCE,
      actions: [{ label: '✔ Commission', kind: 'gold', fn: (d, stats) => {
        if (!stats.ok){ toast('Carrier hull invalid: ' + (stats.errors[0] || ''), 'bad'); return; }
        if (Math.round(stats.cost) > CARRIER_ALLOWANCE){ toast('Over the ¥20,000 allowance', 'bad'); sfx('lock'); return; }
        d.role = 'carrier'; libSave(d); State.campaign.carrierId = d.id;
        State.money = STARTING_BUDGET;        // reset to the operating budget for the plane step
        setOnboard('plane'); save(); sfx('lockfull');
        toast('Carrier commissioned — ' + d.name, 'good');
        Hangar.close(); Campaign.show();
      } }],
      onChange: () => {},
      onExit: () => { Hangar.close(); Campaign.show(); },
    });
  }, { note: 'Allowance: ' + fmtCr(CARRIER_ALLOWANCE) }));
}

function onboardPlane(){
  const body = `Your carrier's afloat. Now build a fighter to fly from it.<br><br>You have your operating budget of <b>${fmtCr(State.money)}</b>. Design an airframe and commit it — this one comes out of your own pocket, so spend wisely. Whatever's left funds your first contracts.`;
  root.appendChild(onboardPanel('Operating Budget', 'Build your first fighter', body, 'Open the design bay ▸', () => {
    const draft = newDesign('My Fighter'); draft.author = 'You';
    Hangar.open({
      design: draft, title: 'Design your fighter — charged on commit', budget: State.money,
      actions: [{ label: '✔ Commit & Buy', kind: 'gold', fn: (d, stats) => {
        if (!stats.ok){ toast('Will not fly: ' + (stats.errors[0] || 'invalid'), 'bad'); return; }
        const price = Math.round(stats.cost);
        if (!canAfford(price)){ toast('Need ' + fmtCr(price), 'bad'); sfx('lock'); return; }
        if (!spend(price)){ toast('Purchase failed', 'bad'); return; }
        d.author = 'You'; libSave(d); State.campaign.hangar.push(d.id);
        setOnboard('done'); save(); sfx('lockfull');
        toast('Fighter built — ' + fmtCr(price), 'good');
        Hangar.close(); Campaign.show();
      } }],
      onChange: () => {},
      onExit: () => { Hangar.close(); Campaign.show(); },
    });
  }, { note: 'Budget: ' + fmtCr(State.money) }));
}

// ---------------------------------------------------------------------------
//  SHELL — top bar (credits/day/rank), tab strip, and a body container.
// ---------------------------------------------------------------------------
function buildShell(){
  clear(root);

  // --- top bar ---
  const bar = el('div', 'topbar');
  bar.style.marginBottom = '18px';

  const brand = el('div');
  brand.innerHTML = '<div class="eyebrow">Global Force Campaign</div>';
  const title = el('div'); title.style.cssText = 'font-size:20px;font-weight:800;letter-spacing:.04em;';
  title.textContent = 'Worldwide Operations';
  brand.appendChild(title);
  bar.appendChild(brand);

  bar.appendChild(el('div', 'spacer'));

  dom.progress = el('div', 'pill mono'); bar.appendChild(dom.progress);
  dom.day = el('div', 'pill mono'); bar.appendChild(dom.day);
  dom.rank = el('div', 'pill mono'); bar.appendChild(dom.rank);

  const creditsPill = el('div', 'pill');
  creditsPill.innerHTML = '<span class="muted small">Credits </span>';
  dom.money = el('span', 'credits'); creditsPill.appendChild(dom.money);
  bar.appendChild(creditsPill);

  const back = el('button', 'btn small', '◂ Menu');
  back.onclick = () => { sfx('ui'); Campaign.close(); Menu.show(); };
  bar.appendChild(back);

  root.appendChild(bar);

  // --- tab strip ---
  const tabs = el('div', 'pill-row');
  tabs.style.marginBottom = '16px';
  dom.tabBtns = {};
  for (const t of TABS){
    const p = el('div', 'pill', t.label);
    p.onclick = () => { sfx('click'); selectTab(t.key); };
    dom.tabBtns[t.key] = p;
    tabs.appendChild(p);
  }
  root.appendChild(tabs);

  // --- body ---
  dom.body = el('div');
  dom.body.style.cssText = 'flex:1;min-height:0;';
  root.appendChild(dom.body);

  refreshTopbar();
}

function selectTab(key){
  curTab = key;
  for (const k in dom.tabBtns) dom.tabBtns[k].classList.toggle('sel', k === key);
  clear(dom.body);
  if (key === 'hangar') renderHangarTab();
  else if (key === 'wingmen') renderWingmenTab();
  else if (key === 'carrier') renderCarrierTab();
  else renderWorldMap();
  refreshTopbar();
}

// ---------------------------------------------------------------------------
//  TAB 1 — HANGAR  (own aircraft: design new, duplicate, import; all cost money)
// ---------------------------------------------------------------------------
function renderHangarTab(){
  const wrap = el('div');
  wrap.style.cssText = 'display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start;';

  // ---- left: owned aircraft grid ----
  const left = el('div', 'panel');
  const head = el('div', 'row');
  head.appendChild(el('h2', '', 'Your Hangar'));
  head.appendChild(el('div', 'spacer'));
  const lead = el('div', 'muted small mono');
  lead.textContent = State.campaign.hangar.length + ' aircraft owned';
  head.appendChild(lead);
  left.appendChild(head);

  const grid = el('div', 'grid');
  grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(240px,1fr))';

  const designs = ownedDesigns();
  if (designs.length === 0){
    grid.appendChild(el('div', 'muted', 'No aircraft. Design or buy one to fly missions.'));
  }
  for (const d of designs){
    grid.appendChild(ownedCard(d));
  }
  left.appendChild(grid);
  wrap.appendChild(left);

  // ---- right: acquisition panel ----
  const right = el('div', 'panel');
  right.appendChild(el('h2', '', 'Acquire'));
  right.appendChild(el('div', 'muted small',
    'Every airframe costs its build price in credits. Spend wisely — missions pay, but losses still cost a day.'));

  const buyNew = el('button', 'btn accent', '✚ Design & Buy New');
  buyNew.style.marginTop = '14px';
  buyNew.onclick = () => openDesignNewAircraft();
  right.appendChild(buyNew);

  const buyStock = el('button', 'btn');
  buyStock.style.marginTop = '10px';
  buyStock.textContent = '🏭 Buy a Factory Aircraft';
  buyStock.onclick = () => openBuyFactory();
  right.appendChild(buyStock);

  const imp = el('button', 'btn');
  imp.style.marginTop = '10px';
  imp.textContent = '⇩ Import a Design Code';
  imp.onclick = () => openImportDesign();
  right.appendChild(imp);

  // small credits footer
  const foot = el('div', 'mono small muted');
  foot.style.marginTop = '16px';
  foot.innerHTML = 'Balance: <span class="credits">' + fmtCr(State.money) + '</span>';
  right.appendChild(foot);

  wrap.appendChild(right);
  dom.body.appendChild(wrap);
}

function ownedCard(design){
  const s = statsOf(design);
  const card = el('div', 'card');

  const top = el('div', 'row');
  const sw = el('div'); sw.style.cssText =
    'width:18px;height:18px;border-radius:4px;border:1px solid rgba(255,255,255,.2);background:' + (design.color || '#cfd8e3');
  top.appendChild(sw);
  const nm = el('div'); nm.style.cssText = 'font-weight:700;font-size:15px;';
  nm.textContent = design.name;
  top.appendChild(nm);
  card.appendChild(top);

  const role = el('div', 'tag'); role.textContent = design.role || 'fighter';
  role.style.marginTop = '6px';
  card.appendChild(role);

  // compact stat block
  const st = el('div', 'stats'); st.style.marginTop = '10px';
  const add = (k, v, cls) => {
    st.appendChild(el('div', 'k', k));
    const ve = el('div', 'v' + (cls ? ' ' + cls : '')); ve.textContent = v; st.appendChild(ve);
  };
  add('Mass', (s.mass / 1000).toFixed(1) + ' t');
  add('TWR', s.twr.toFixed(2), s.twr >= 1 ? 'good' : 'warn');
  add('Top spd', Math.round(s.vMaxBoost * 3.6) + ' km/h');
  add('Durability', Math.round(s.durability) + ' HP');
  add('Weapons', String(s.hardpoints));
  add('Resale', fmtCr(Math.round(s.cost * 0.5)));
  card.appendChild(st);

  if (!s.ok){
    const w = el('div', 'warns');
    w.appendChild(el('div', 'err', '⚠ ' + (s.errors[0] || 'Will not fly')));
    card.appendChild(w);
  }

  // actions
  const acts = el('div', 'row'); acts.style.marginTop = '12px';

  const edit = el('button', 'btn small', 'Edit');
  edit.title = 'Modify this design (free changes that lower cost refund; pricier changes are charged the difference)';
  edit.onclick = () => openEditOwned(design);
  acts.appendChild(edit);

  const dup = el('button', 'btn small', 'Duplicate');
  dup.title = 'Buy a second copy for ' + fmtCr(Math.round(s.cost));
  dup.onclick = () => duplicateOwned(design);
  acts.appendChild(dup);

  const sell = el('button', 'btn small danger', 'Sell');
  sell.title = 'Sell for 50% of build cost';
  sell.onclick = () => sellOwned(design);
  acts.appendChild(sell);

  card.appendChild(acts);
  return card;
}

// --- Design a brand-new aircraft, charged on save -------------------------
function openDesignNewAircraft(){
  const draft = newDesign('New Aircraft');
  draft.author = 'You';
  Hangar.open({
    design: draft,
    title: 'Design New Aircraft — charged on commit',
    budget: State.money,                 // can't commit something you can't pay for
    actions: [{
      label: '✔ Commit & Buy',
      kind: 'gold',
      fn: (d, stats) => commitNewDesign(d, stats),
    }],
    onChange: () => {},
    onExit: () => { Hangar.close(); Campaign.show(); selectTab('hangar'); },
  });
}

function commitNewDesign(d, stats){
  if (!stats.ok){
    toast('This airframe will not fly: ' + (stats.errors[0] || 'invalid'), 'bad');
    return;
  }
  const price = Math.round(stats.cost);
  if (!canAfford(price)){
    toast('Insufficient credits — need ' + fmtCr(price), 'bad'); sfx('lock');
    return;
  }
  if (!spend(price)) { toast('Purchase failed', 'bad'); return; }
  // commit the design to the library + owned hangar
  d.author = 'You';
  libSave(d);
  State.campaign.hangar.push(d.id);
  save();
  sfx('lockfull');
  toast('Bought "' + d.name + '" for ' + fmtCr(price), 'good');
  Hangar.close();
  Campaign.show(); selectTab('hangar');
}

// --- Edit an OWNED design; charge/refund the cost difference ----------------
function openEditOwned(design){
  const before = Math.round(statsOf(design).cost);
  const draft = cloneDesign(design, '');     // edit a working copy, keep id
  draft.id = design.id;
  Hangar.open({
    design: draft,
    title: 'Edit ' + design.name + ' — pay/refund the cost change',
    actions: [{
      label: '✔ Apply Changes',
      kind: 'gold',
      fn: (d, stats) => {
        if (!stats.ok){ toast('Will not fly: ' + (stats.errors[0] || 'invalid'), 'bad'); return; }
        const after = Math.round(stats.cost);
        const diff = after - before;
        if (diff > 0 && !canAfford(diff)){
          toast('Upgrade costs ' + fmtCr(diff) + ' more — not enough credits', 'bad'); sfx('lock');
          return;
        }
        if (diff > 0) spend(diff);
        else if (diff < 0) earn(-diff);
        libSave(d);
        // keep id present in hangar (it is, since we preserved the id)
        if (!State.campaign.hangar.includes(d.id)) State.campaign.hangar.push(d.id);
        save();
        sfx('lockfull');
        toast(diff > 0 ? 'Upgraded — paid ' + fmtCr(diff)
              : diff < 0 ? 'Refit — refunded ' + fmtCr(-diff)
              : 'Changes applied', diff > 0 ? '' : 'good');
        Hangar.close();
        Campaign.show(); selectTab('hangar');
      },
    }],
    onChange: () => {},
    onExit: () => { Hangar.close(); Campaign.show(); selectTab('hangar'); },
  });
}

// --- Duplicate an owned design (costs its cost again) -----------------------
function duplicateOwned(design){
  const price = Math.round(statsOf(design).cost);
  if (!canAfford(price)){ toast('Need ' + fmtCr(price) + ' to duplicate', 'bad'); sfx('lock'); return; }
  confirmModal('Duplicate "' + design.name + '"?',
    'A second airframe will cost ' + fmtCr(price) + '. You will own two.',
    () => {
      if (!spend(price)){ toast('Purchase failed', 'bad'); return; }
      const copy = cloneDesign(design);
      libSave(copy);
      State.campaign.hangar.push(copy.id);
      save();
      sfx('lockfull');
      toast('Bought a second "' + design.name + '"', 'good');
      selectTab('hangar');
    });
}

// --- Sell an owned design back for 50% -------------------------------------
function sellOwned(design){
  if (State.campaign.hangar.length <= 1){
    toast('Can\'t sell your last aircraft', 'warn'); return;
  }
  const refund = Math.round(statsOf(design).cost * 0.5);
  confirmModal('Sell "' + design.name + '"?',
    'You recover ' + fmtCr(refund) + ' (50% of build cost). The airframe leaves your hangar.',
    () => {
      // remove ONE instance of this id from the hangar
      const i = State.campaign.hangar.indexOf(design.id);
      if (i >= 0) State.campaign.hangar.splice(i, 1);
      // if it's no longer owned anywhere and was a library design, leave the
      // library entry (player may re-buy) — just remove ownership.
      earn(refund);
      save();
      sfx('ui');
      toast('Sold "' + design.name + '" for ' + fmtCr(refund), 'good');
      selectTab('hangar');
    }, 'Sell', 'danger');
}

// --- Buy a factory aircraft at list price ----------------------------------
function openBuyFactory(){
  const m = openModal('Factory Aircraft');
  m.body.appendChild(el('div', 'muted small',
    'Off-the-shelf airframes from the factory. Buy one outright — it joins your hangar at list price.'));
  const list = el('div', 'list'); list.style.marginTop = '12px';
  for (const stock of STOCK_DESIGNS){
    const s = statsOf(stock);
    const price = Math.round(s.cost);
    const row = el('div', 'list-row');
    const sw = el('div'); sw.style.cssText =
      'width:16px;height:16px;border-radius:4px;border:1px solid rgba(255,255,255,.2);background:' + stock.color;
    row.appendChild(sw);
    const info = el('div'); info.style.flex = '1';
    info.innerHTML = '<div style="font-weight:700">' + stock.name + '</div>' +
      '<div class="mono small muted">' + (stock.role) + ' · ' + (s.mass / 1000).toFixed(1) + 't · TWR ' +
      s.twr.toFixed(2) + ' · ' + Math.round(s.durability) + ' HP</div>';
    row.appendChild(info);
    const cost = el('div', 'credits mono'); cost.textContent = fmtCr(price);
    cost.style.minWidth = '90px'; cost.style.textAlign = 'right';
    row.appendChild(cost);
    const buy = el('button', 'btn small gold', 'Buy');
    buy.disabled = !canAfford(price);
    buy.onclick = () => {
      if (!spend(price)){ toast('Need ' + fmtCr(price), 'bad'); sfx('lock'); return; }
      const owned = stockGet(stock.id);        // fresh clone with new id
      libSave(owned);
      State.campaign.hangar.push(owned.id);
      save();
      sfx('lockfull');
      toast('Bought "' + stock.name + '" for ' + fmtCr(price), 'good');
      closeModal();
      selectTab('hangar');
    };
    row.appendChild(buy);
    list.appendChild(row);
  }
  m.body.appendChild(list);
}

// --- Import a design code, then buy it -------------------------------------
function openImportDesign(){
  const m = openModal('Import Design Code');
  m.body.appendChild(el('div', 'muted small',
    'Paste an ASK2 design code. We\'ll price it; buying charges its build cost.'));
  const ta = el('textarea');
  ta.style.cssText = 'width:100%;height:90px;margin-top:10px;font-family:var(--mono);font-size:12px;resize:vertical;';
  ta.placeholder = 'ASK2.…';
  m.body.appendChild(ta);

  const preview = el('div', 'panel tight'); preview.style.marginTop = '10px';
  preview.style.display = 'none';
  m.body.appendChild(preview);

  let parsed = null;
  const buyBtn = el('button', 'btn gold', 'Buy'); buyBtn.disabled = true;

  const check = el('button', 'btn', 'Check Code');
  check.onclick = () => {
    parsed = importCode(ta.value.trim());
    if (!parsed){ toast('Invalid design code', 'bad'); preview.style.display = 'none'; buyBtn.disabled = true; return; }
    const s = statsOf(parsed);
    const price = Math.round(s.cost);
    preview.style.display = 'block';
    preview.innerHTML = '<div style="font-weight:700">' + parsed.name + '</div>' +
      '<div class="mono small muted">' + (parsed.role || 'fighter') + ' · ' + parsed.parts.length + ' parts · ' +
      (s.mass / 1000).toFixed(1) + 't · TWR ' + s.twr.toFixed(2) + (s.ok ? '' : ' · <span style="color:var(--bad)">WILL NOT FLY</span>') + '</div>' +
      '<div class="mono" style="margin-top:6px">Price: <span class="credits">' + fmtCr(price) + '</span></div>';
    buyBtn.disabled = !s.ok || !canAfford(price);
    buyBtn.textContent = 'Buy for ' + fmtCr(price);
  };

  buyBtn.onclick = () => {
    if (!parsed) return;
    const s = statsOf(parsed);
    const price = Math.round(s.cost);
    if (!s.ok){ toast('Design will not fly', 'bad'); return; }
    if (!spend(price)){ toast('Need ' + fmtCr(price), 'bad'); sfx('lock'); return; }
    parsed.author = 'Imported';
    libSave(parsed);
    State.campaign.hangar.push(parsed.id);
    save();
    sfx('lockfull');
    toast('Bought imported "' + parsed.name + '"', 'good');
    closeModal();
    selectTab('hangar');
  };

  const row = el('div', 'row'); row.style.marginTop = '12px';
  row.appendChild(check); row.appendChild(buyBtn);
  m.body.appendChild(row);
}

// ---------------------------------------------------------------------------
//  TAB 2 — WINGMEN  (named pilots: assign an owned airframe + a skill tier)
//  State.campaign.wingmen = [{ id, designId, name, skill, tier }]
// ---------------------------------------------------------------------------
function renderWingmenTab(){
  if (!State.campaign.wingmen) State.campaign.wingmen = [];
  const wrap = el('div');
  wrap.style.cssText = 'display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start;';

  // ---- left: hired wingmen ----
  const left = el('div', 'panel');
  const head = el('div', 'row');
  head.appendChild(el('h2', '', 'Your Squadron'));
  head.appendChild(el('div', 'spacer'));
  head.appendChild(el('div', 'muted small mono', State.campaign.wingmen.length + ' pilots'));
  left.appendChild(head);

  const list = el('div', 'list');
  if (State.campaign.wingmen.length === 0){
    list.appendChild(el('div', 'muted', 'No wingmen hired. Recruit pilots to fly alongside you.'));
  }
  for (const wm of State.campaign.wingmen){
    list.appendChild(wingmanRow(wm));
  }
  left.appendChild(list);
  wrap.appendChild(left);

  // ---- right: recruit ----
  const right = el('div', 'panel');
  right.appendChild(el('h2', '', 'Recruit a Pilot'));
  right.appendChild(el('div', 'muted small',
    'A wingman pairs a callsign and skill with one of your owned aircraft. They deploy with you on missions. Hiring is a one-time fee; you also pay for their aircraft separately.'));

  const recruit = el('button', 'btn accent', '✚ Hire Wingman');
  recruit.style.marginTop = '14px';
  recruit.onclick = () => openHireWingman();
  right.appendChild(recruit);

  const tierInfo = el('div', 'stats'); tierInfo.style.marginTop = '16px';
  tierInfo.appendChild(el('div', 'k', 'Tier'));
  tierInfo.appendChild(el('div', 'v', 'Fee'));
  for (const t of SKILL_TIERS){
    tierInfo.appendChild(el('div', 'k', t.name + ' (' + Math.round(t.skill * 100) + '%)'));
    tierInfo.appendChild(el('div', 'v', fmtCr(t.fee)));
  }
  right.appendChild(tierInfo);

  wrap.appendChild(right);
  dom.body.appendChild(wrap);
}

function wingmanRow(wm){
  const row = el('div', 'list-row');
  const design = wm.designId ? designForOwnedId(wm.designId) : null;

  const badge = el('div'); badge.style.cssText =
    'width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
    'font-weight:800;font-family:var(--mono);background:#0c1a2a;border:1px solid var(--edge);color:var(--accent);';
  badge.textContent = (wm.name || '?').slice(0, 2).toUpperCase();
  row.appendChild(badge);

  const info = el('div'); info.style.flex = '1';
  info.innerHTML = '<div style="font-weight:700">' + (wm.name || 'Unnamed') +
    ' <span class="tag" style="margin-left:6px">' + (wm.tier || (Math.round((wm.skill || 0) * 100) + '%')) + '</span></div>' +
    '<div class="mono small muted">flies ' + (design ? design.name : '⚠ no aircraft assigned') + '</div>';
  row.appendChild(info);

  const reassign = el('button', 'btn small', 'Aircraft');
  reassign.title = 'Assign which owned aircraft this pilot flies';
  reassign.onclick = () => openAssignWingmanAircraft(wm);
  row.appendChild(reassign);

  const fire = el('button', 'btn small danger', 'Dismiss');
  fire.onclick = () => {
    confirmModal('Dismiss ' + wm.name + '?', 'They leave the squadron. No refund on the hiring fee.', () => {
      State.campaign.wingmen = State.campaign.wingmen.filter(w => w.id !== wm.id);
      save(); sfx('ui'); toast(wm.name + ' dismissed'); selectTab('wingmen');
    }, 'Dismiss', 'danger');
  };
  row.appendChild(fire);

  return row;
}

function openHireWingman(){
  const owned = ownedDesigns();
  if (owned.length === 0){ toast('Buy an aircraft first', 'warn'); return; }

  const m = openModal('Hire a Wingman');
  // callsign
  const nameField = el('label', 'field');
  nameField.appendChild(el('span', '', 'Callsign'));
  const nameInput = el('input'); nameInput.type = 'text'; nameInput.value = randomCallsign();
  nameField.appendChild(nameInput);
  m.body.appendChild(nameField);
  const reroll = el('button', 'btn small', '🎲 Random callsign');
  reroll.style.marginTop = '6px';
  reroll.onclick = () => { nameInput.value = randomCallsign(); };
  m.body.appendChild(reroll);

  // skill tier
  m.body.appendChild(el('h3', '', 'Skill tier'));
  let tier = SKILL_TIERS[0];
  const tierRow = el('div', 'pill-row');
  const tierPills = [];
  for (const t of SKILL_TIERS){
    const p = el('div', 'pill', t.name + ' · ' + fmtCr(t.fee));
    p.onclick = () => { tier = t; tierPills.forEach(x => x.classList.remove('sel')); p.classList.add('sel'); updateFee(); };
    tierPills.push(p); tierRow.appendChild(p);
  }
  tierPills[0].classList.add('sel');
  m.body.appendChild(tierRow);

  // aircraft
  m.body.appendChild(el('h3', '', 'Assigned aircraft'));
  const sel = el('select');
  for (const d of owned){
    const o = el('option'); o.value = d.id; o.textContent = d.name + ' (' + (d.role || 'fighter') + ')';
    sel.appendChild(o);
  }
  m.body.appendChild(sel);

  const fee = el('div', 'mono'); fee.style.marginTop = '14px';
  m.body.appendChild(fee);
  function updateFee(){
    fee.innerHTML = 'Hiring fee: <span class="credits">' + fmtCr(tier.fee) + '</span>';
  }
  updateFee();

  const hire = el('button', 'btn gold', 'Hire');
  hire.style.marginTop = '12px';
  hire.onclick = () => {
    const name = (nameInput.value || '').trim() || randomCallsign();
    if (!canAfford(tier.fee)){ toast('Need ' + fmtCr(tier.fee), 'bad'); sfx('lock'); return; }
    if (!spend(tier.fee)){ toast('Hire failed', 'bad'); return; }
    State.campaign.wingmen.push({
      id: uid(), name, designId: sel.value, skill: tier.skill, tier: tier.name,
    });
    save(); sfx('lockfull');
    toast('Hired ' + name + ' (' + tier.name + ')', 'good');
    closeModal(); selectTab('wingmen');
  };
  m.body.appendChild(hire);
}

function openAssignWingmanAircraft(wm){
  const owned = ownedDesigns();
  if (owned.length === 0){ toast('No aircraft to assign', 'warn'); return; }
  const m = openModal('Assign Aircraft — ' + wm.name);
  const sel = el('select'); sel.style.width = '100%';
  for (const d of owned){
    const o = el('option'); o.value = d.id; o.textContent = d.name + ' (' + (d.role || 'fighter') + ')';
    if (d.id === wm.designId) o.selected = true;
    sel.appendChild(o);
  }
  m.body.appendChild(sel);
  const ok = el('button', 'btn accent', 'Assign'); ok.style.marginTop = '12px';
  ok.onclick = () => {
    wm.designId = sel.value; save(); sfx('ui');
    toast(wm.name + ' now flies ' + (designForOwnedId(sel.value)?.name || '?'), 'good');
    closeModal(); selectTab('wingmen');
  };
  m.body.appendChild(ok);
}

// ---------------------------------------------------------------------------
//  TAB 3 — CARRIER  (commission ONE big airframe as your mobile base)
//  State.campaign.carrierId points at a library design id.
// ---------------------------------------------------------------------------
function renderCarrierTab(){
  const wrap = el('div');
  wrap.style.cssText = 'display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start;';

  const left = el('div', 'panel');
  left.appendChild(el('h2', '', 'Aircraft Carrier'));

  const carrier = State.campaign.carrierId ? designForOwnedId(State.campaign.carrierId) : null;
  if (carrier){
    const s = statsOf(carrier);
    const card = el('div', 'card');
    card.appendChild(el('div', '', ''));
    const nm = el('div'); nm.style.cssText = 'font-weight:800;font-size:18px;';
    nm.textContent = carrier.name; card.appendChild(nm);
    card.appendChild(el('div', 'tag', 'fleet carrier'));

    const st = el('div', 'stats'); st.style.marginTop = '12px';
    const add = (k, v) => { st.appendChild(el('div', 'k', k)); st.appendChild(el('div', 'v', v)); };
    add('Mass', (s.mass / 1000).toFixed(1) + ' t');
    add('Durability', Math.round(s.durability) + ' HP');
    add('Length', Math.round(s.bbox.size.z) + ' m');
    add('Defences', String(s.hardpoints) + ' guns');
    add('Build cost', fmtCr(Math.round(s.cost)));
    card.appendChild(st);

    const acts = el('div', 'row'); acts.style.marginTop = '12px';
    const edit = el('button', 'btn small', 'Refit');
    edit.onclick = () => openDesignCarrier(carrier);
    acts.appendChild(edit);
    const scrap = el('button', 'btn small danger', 'Decommission');
    scrap.onclick = () => {
      const refund = Math.round(s.cost * 0.4);
      confirmModal('Decommission carrier?', 'You recover ' + fmtCr(refund) + ' (40%). Command will provide a support carrier for capital-ship missions until you build a new one.', () => {
        State.campaign.carrierId = null; earn(refund); save(); sfx('ui');
        toast('Carrier decommissioned (+' + fmtCr(refund) + ')', 'good'); selectTab('carrier');
      }, 'Decommission', 'danger');
    };
    acts.appendChild(scrap);
    card.appendChild(acts);
    left.appendChild(card);
  } else {
    left.appendChild(el('div', 'muted',
      'No carrier commissioned. Command provides a support carrier for capital-ship missions, or you can build your own mobile base here.'));
  }
  wrap.appendChild(left);

  // right: build/commission panel
  const right = el('div', 'panel');
  right.appendChild(el('h2', '', carrier ? 'Replace Carrier' : 'Commission'));
  right.appendChild(el('div', 'muted small',
    'Design a single large airframe — big fuselages, heavy armor, defensive guns. It costs its full build price. Only one carrier at a time.'));

  const build = el('button', 'btn accent', carrier ? '⟳ Build New Carrier' : '⚓ Commission Carrier');
  build.style.marginTop = '14px';
  build.onclick = () => openDesignCarrier(null);
  right.appendChild(build);

  const template = el('button', 'btn');
  template.style.marginTop = '10px';
  template.textContent = '⚓ Start From Template';
  template.title = 'Begin from the Goliath heavy airframe as a carrier hull';
  template.onclick = () => {
    const base = stockGet('stock_goliath');
    base.name = 'CV Aegis';
    base.role = 'carrier';
    openDesignCarrier(base);
  };
  right.appendChild(template);

  wrap.appendChild(right);
  dom.body.appendChild(wrap);
}

function openDesignCarrier(existing){
  let draft;
  if (existing){
    draft = cloneDesign(existing, '');
    draft.id = existing.id || uid();
  } else {
    draft = newDesign('CV Aegis');
    draft.role = 'carrier';
  }
  const prevCost = existing ? Math.round(statsOf(existing).cost) : 0;
  Hangar.open({
    design: draft,
    title: 'Carrier Yard — ' + (existing ? 'refit' : 'commission'),
    budget: existing ? (State.money + prevCost) : State.money,
    actions: [{
      label: existing ? '✔ Apply Refit' : '✔ Commission',
      kind: 'gold',
      fn: (d, stats) => {
        if (!stats.ok){ toast('Carrier hull invalid: ' + (stats.errors[0] || ''), 'bad'); return; }
        const price = Math.round(stats.cost);
        const net = price - prevCost;        // refit pays only the difference
        if (net > 0 && !canAfford(net)){
          toast('Need ' + fmtCr(net) + ' more', 'bad'); sfx('lock'); return;
        }
        if (net > 0) spend(net); else if (net < 0) earn(-net);
        d.role = d.role || 'carrier';
        libSave(d);
        State.campaign.carrierId = d.id;
        save(); sfx('lockfull');
        toast(existing ? 'Carrier refit complete' : 'Carrier commissioned — ' + fmtCr(price), 'good');
        Hangar.close(); Campaign.show(); selectTab('carrier');
      },
    }],
    onChange: () => {},
    onExit: () => { Hangar.close(); Campaign.show(); selectTab('carrier'); },
  });
}

// ---------------------------------------------------------------------------
//  TAB 4 — MISSIONS  (the deploy loop)
// ---------------------------------------------------------------------------
function carrierForMission(mission){
  if (!mission.friendlyCarrier) return null;
  const owned = State.campaign.carrierId ? designForOwnedId(State.campaign.carrierId) : null;
  return owned || stockGet(mission.friendlyCarrier);
}

// ===========================================================================
//  GLOBAL OPERATIONS MAP — real-world country locations on an Earth silhouette.
//  Four wars are active at once. Every campaign day deterministically shuffles
//  the story missions onto different countries and adds a small position jitter;
//  the pins stay stable while the player reads the map, then move after a sortie.
// ===========================================================================
const MAP_W = 1200, MAP_H = 600;
const SECURE = 100, OPEN_AT = 65;
const WAR_FRONTS = [
  { id: 'atlantic', name: 'Atlantic Coalition War', color: '#51c9ff' },
  { id: 'eurasia',  name: 'Eurasian Continental War', color: '#ff657f' },
  { id: 'indo',     name: 'Indo-Pacific Naval War', color: '#ffb84d' },
  { id: 'sahel',    name: 'Sahel Emergency', color: '#c58cff' },
];
const GLOBAL_LOCATIONS = [
  { id: 'canada', country: 'Canada', site: 'Hudson Bay', lon: -92, lat: 57, front: 'atlantic', start: 48 },
  { id: 'usa', country: 'United States', site: 'Great Plains', lon: -99, lat: 39, front: 'atlantic', start: 54 },
  { id: 'mexico', country: 'Mexico', site: 'Gulf Coast', lon: -101, lat: 23, front: 'atlantic', start: 38 },
  { id: 'brazil', country: 'Brazil', site: 'Atlantic Coast', lon: -47, lat: -15, front: 'atlantic', start: 34 },
  { id: 'argentina', country: 'Argentina', site: 'Patagonian Corridor', lon: -65, lat: -39, front: 'atlantic', start: 31 },
  { id: 'uk', country: 'United Kingdom', site: 'North Sea', lon: -2, lat: 54, front: 'atlantic', start: 51 },
  { id: 'france', country: 'France', site: 'Western Approaches', lon: 2, lat: 46, front: 'atlantic', start: 44 },
  { id: 'norway', country: 'Norway', site: 'Arctic Coast', lon: 10, lat: 62, front: 'eurasia', start: 37 },
  { id: 'ukraine', country: 'Ukraine', site: 'Black Sea Front', lon: 31, lat: 49, front: 'eurasia', start: 24 },
  { id: 'turkey', country: 'Türkiye', site: 'Anatolian Corridor', lon: 35, lat: 39, front: 'eurasia', start: 29 },
  { id: 'egypt', country: 'Egypt', site: 'Suez Corridor', lon: 30, lat: 27, front: 'sahel', start: 32 },
  { id: 'nigeria', country: 'Nigeria', site: 'Gulf of Guinea', lon: 8, lat: 9, front: 'sahel', start: 26 },
  { id: 'kenya', country: 'Kenya', site: 'East African Rift', lon: 38, lat: 1, front: 'sahel', start: 27 },
  { id: 'south_africa', country: 'South Africa', site: 'Cape Route', lon: 24, lat: -30, front: 'sahel', start: 35 },
  { id: 'india', country: 'India', site: 'Himalayan Approach', lon: 79, lat: 22, front: 'indo', start: 36 },
  { id: 'japan', country: 'Japan', site: 'Home Islands', lon: 138, lat: 37, front: 'indo', start: 42 },
  { id: 'philippines', country: 'Philippines', site: 'Luzon Strait', lon: 122, lat: 13, front: 'indo', start: 28 },
  { id: 'indonesia', country: 'Indonesia', site: 'Java Sea', lon: 118, lat: -2, front: 'indo', start: 30 },
  { id: 'australia', country: 'Australia', site: 'Coral Sea', lon: 134, lat: -25, front: 'indo', start: 47 },
];

function mapPoint(lon, lat){ return { x: (lon + 180) / 360 * MAP_W, y: (90 - lat) / 180 * MAP_H }; }
function frontFor(id){ return WAR_FRONTS.find(f => f.id === id) || WAR_FRONTS[0]; }
function seededRandom(seed){
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function activeOperations(){
  const c = State.campaign;
  const rand = seededRandom(((c.worldSeed || 1) ^ Math.imul(c.day || 1, 0x9e3779b1)) >>> 0);
  const places = GLOBAL_LOCATIONS.slice();
  for (let i = places.length - 1; i > 0; i--){ const j = Math.floor(rand() * (i + 1)); [places[i], places[j]] = [places[j], places[i]]; }
  return MISSIONS.map((mission, i) => {
    const loc = places[i % places.length], p = mapPoint(loc.lon, loc.lat);
    const tier = Math.min(4, 1 + Math.floor(i / 4));
    return { ...loc, name: loc.country, x: clamp(p.x + (rand() - 0.5) * 18, 28, MAP_W - 28),
      y: clamp(p.y + (rand() - 0.5) * 12, 34, MAP_H - 34), tier, env: mission.env,
      missions: [mission.id], operation: i + 1 };
  });
}
function ensureRegions(){
  const c = State.campaign;
  if (!c.regions) c.regions = {};
  for (const r of GLOBAL_LOCATIONS){ if (!c.regions[r.id]) c.regions[r.id] = { control: r.start }; }
}
function regionCtrl(id){ ensureRegions(); return State.campaign.regions[id] ? State.campaign.regions[id].control : 0; }
function ctrlColor(v){ return v >= OPEN_AT ? '#5fd0ff' : v >= 28 ? '#e0b14a' : '#d9534f'; }

function patrolFor(r){
  return {
    id: 'patrol_' + r.id, title: r.country + ' Air Patrol', patrol: true, env: r.env,
    reward: 1200 + r.tier * 700,
    enemies: [{ stock: 'stock_falcon', count: Math.min(6, 1 + r.tier), skill: Math.min(0.85, 0.34 + r.tier * 0.09) }],
    objective: { type: 'deathmatch', label: 'Clear the airspace over ' + r.country }, timeLimit: 0,
    brief: 'Global Command has a repeatable patrol over ' + r.site + '. Sweep the sector and shift local control in our favour.',
  };
}

function shiftRegionControl(id, win, isPatrol, firstClear){
  ensureRegions();
  const rc = State.campaign.regions[id]; if (!rc) return;
  if (win) rc.control = Math.min(SECURE, rc.control + (isPatrol ? 12 : (firstClear ? 35 : 18)));
  else rc.control = Math.max(0, rc.control - 6);
  for (const r of GLOBAL_LOCATIONS){
    if (r.id === id) continue;
    const o = State.campaign.regions[r.id];
    if (o && o.control > 0 && o.control < SECURE) o.control = Math.max(0, o.control - 1);
  }
  save();
}

function worldMapSVG(regions){
  ensureRegions();
  let s = `<svg class="global-earth" viewBox="0 0 ${MAP_W} ${MAP_H}" role="img" aria-label="World map with ${regions.length} global operations">`;
  s += '<defs><radialGradient id="oceanGlow"><stop offset="0" stop-color="#17344b"/><stop offset="1" stop-color="#07111c"/></radialGradient><filter id="pinGlow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
  s += `<rect width="${MAP_W}" height="${MAP_H}" fill="url(#oceanGlow)"/>`;
  s += '<g class="earth-grid">';
  for (let x = 100; x < MAP_W; x += 100) s += `<line x1="${x}" y1="0" x2="${x}" y2="${MAP_H}"/>`;
  for (let y = 100; y < MAP_H; y += 100) s += `<line x1="0" y1="${y}" x2="${MAP_W}" y2="${y}"/>`;
  s += '</g>';
  s += '<g class="earth-land">' +
    '<path d="M70 105 L105 72 165 55 216 66 262 88 314 91 354 122 345 151 315 167 293 205 262 236 224 222 199 191 163 181 137 198 111 177 92 145 Z"/>' +
    '<path d="M345 40 L393 28 435 51 420 93 381 106 348 80 Z"/>' +
    '<path d="M330 235 L380 246 421 286 440 342 426 401 397 472 366 521 343 469 349 410 324 355 308 292 Z"/>' +
    '<path d="M545 114 L583 96 627 105 654 128 688 137 704 169 681 192 646 187 626 210 590 201 568 174 536 160 Z"/>' +
    '<path d="M592 205 L657 199 703 229 724 286 706 354 674 421 633 474 604 418 593 350 562 298 566 246 Z"/>' +
    '<path d="M674 108 L731 75 804 65 873 79 932 68 1004 88 1089 116 1133 151 1115 188 1064 201 1032 232 990 226 958 260 908 269 872 242 823 251 789 223 747 217 713 188 692 152 Z"/>' +
    '<path d="M805 252 L846 265 869 304 850 338 817 323 794 285 Z"/>' +
    '<path d="M964 375 L1018 357 1083 374 1128 415 1112 469 1053 493 994 478 952 432 Z"/>' +
    '<path d="M1091 191 L1110 175 1123 203 1107 229 1094 216 Z"/><path d="M999 287 L1018 278 1032 305 1020 333 1004 316 Z"/>' +
    '</g>';
  s += '<g class="country-lines"><path d="M190 84L211 190M254 92L228 220M363 259L417 338M380 332L425 401M600 117L626 202M649 205L619 348M681 218L704 350M729 113L746 216M790 101L803 242M861 83L873 241M944 82L958 258M1021 94L1002 231M1000 381L1056 482"/></g>';
  const frontGroups = WAR_FRONTS.map(f => regions.filter(r => r.front === f.id));
  s += '<g class="war-lines">';
  for (let fi = 0; fi < frontGroups.length; fi++){
    const group = frontGroups[fi], front = WAR_FRONTS[fi];
    for (let i = 1; i < group.length; i++) s += `<line x1="${group[i - 1].x}" y1="${group[i - 1].y}" x2="${group[i].x}" y2="${group[i].y}" stroke="${front.color}"/>`;
  }
  s += '</g>';
  for (const r of regions){
    const m = missionById(r.missions[0]), v = regionCtrl(r.id), col = ctrlColor(v), rad = 10 + r.tier;
    s += `<g data-region="${r.id}" class="operation-pin" tabindex="0" role="button" aria-label="Operation ${r.operation}, ${m.title}, ${r.country}">`;
    s += `<title>OP ${String(r.operation).padStart(2, '0')} · ${m.title} · ${r.country}</title>`;
    s += `<circle class="operation-pulse" cx="${r.x}" cy="${r.y}" r="${rad + 8}" fill="${frontFor(r.front).color}"/>`;
    s += `<circle cx="${r.x}" cy="${r.y}" r="${rad}" fill="${col}" stroke="#06101a" stroke-width="3" filter="url(#pinGlow)"/>`;
    s += `<text x="${r.x}" y="${r.y + 4}" text-anchor="middle" class="operation-number">${r.operation}</text>`;
    s += `<text x="${r.x}" y="${r.y + rad + 17}" text-anchor="middle" class="operation-country">${r.country}</text>`;
    s += `<text x="${r.x}" y="${r.y + rad + 30}" text-anchor="middle" class="operation-status">${v >= SECURE ? 'SECURED' : v + '%'}</text>`;
    s += '</g>';
  }
  s += '</svg>';
  return s;
}

function contractRow(region, m, isPatrol){
  const done = !isPatrol && State.campaign.completed.includes(m.id);
  const row = el('div', 'card global-contract');
  const t = el('div', 'row'); const nm = el('div'); nm.style.cssText = 'font-weight:700;'; nm.textContent = m.title; t.appendChild(nm);
  t.appendChild(el('div', 'spacer'));
  if (done) t.appendChild(el('div', 'tag', '✔'));
  const rew = el('div', 'tag'); rew.style.color = 'var(--gold)';
  rew.textContent = '+' + fmtCr(isPatrol ? m.reward : (done ? Math.round(m.reward * 0.4) : m.reward));
  t.appendChild(rew); row.appendChild(t);
  const br = el('div', 'small muted'); br.style.cssText = 'margin-top:6px;line-height:1.45;'; br.textContent = m.brief; row.appendChild(br);
  const threat = (m.enemies || []).reduce((a, e) => a + e.count, 0);
  row.appendChild(el('div', 'mono small faint', 'Threat: ' + threat + ' aircraft' + (m.enemyCarrier ? ' + carrier' : '') + (isPatrol ? '  ·  repeatable' : '')));
  const act = el('div', 'row'); act.style.marginTop = '10px';
  const go = el('button', 'btn accent', isPatrol ? '➤ Fly Patrol' : (done ? '↻ Fly Again' : '➤ Deploy'));
  go.onclick = () => openDeploy({ ...m, _regionId: region.id, country: region.country, site: region.site, front: frontFor(region.front).name });
  act.appendChild(go); row.appendChild(act);
  return row;
}

function renderRegionDetail(c, r){
  if (!r){ c.appendChild(el('div', 'muted', 'No global operations available.')); return; }
  const v = regionCtrl(r.id), m = missionById(r.missions[0]), front = frontFor(r.front);
  const eyebrow = el('div', 'eyebrow', 'Operation ' + String(r.operation).padStart(2, '0') + ' · tier ' + r.tier); eyebrow.style.color = front.color; c.appendChild(eyebrow);
  const h = el('div', 'global-country-title', r.country); c.appendChild(h);
  c.appendChild(el('div', 'small muted', r.site + ' · ' + front.name));
  const bar = el('div', 'global-control-bar');
  const fill = el('div'); fill.style.cssText = `width:${v}%;background:${ctrlColor(v)};`; bar.appendChild(fill); c.appendChild(bar);
  c.appendChild(el('div', 'small mono', v >= SECURE ? 'SECURED — under Global Force control' : ('Local control: ' + v + '%')));
  c.appendChild(el('h3', '', 'Assigned Task'));
  if (m) c.appendChild(contractRow(r, m, false));
  c.appendChild(el('h3', '', 'Regional Response'));
  c.appendChild(contractRow(r, patrolFor(r), true));
}

function renderWorldMap(){
  ensureRegions();
  clear(dom.body);
  const regions = activeOperations();
  const banner = el('div', 'global-war-banner');
  const copy = el('div'); copy.innerHTML = '<div class="eyebrow">Global Force Command</div><div class="global-war-title">WORLDWIDE CONFLICT RESPONSE</div><div class="small muted">Multiple wars have erupted. Missions are reassigned to new countries whenever the campaign day advances.</div>'; banner.appendChild(copy);
  const warList = el('div', 'global-war-list');
  for (const f of WAR_FRONTS){ const chip = el('div', 'war-chip'); chip.style.borderColor = f.color; chip.innerHTML = `<i style="background:${f.color}"></i>${f.name}`; warList.appendChild(chip); }
  banner.appendChild(warList); dom.body.appendChild(banner);

  const wrap = el('div', 'campaign-world-layout');
  const mapPanel = el('div', 'panel campaign-world-panel');
  const mh = el('div', 'row'); mh.appendChild(el('div', 'eyebrow', 'Live Earth Operations Map')); mh.appendChild(el('div', 'spacer'));
  mh.appendChild(el('div', 'pill mono', regions.length + ' active tasks'));
  const reroute = el('button', 'btn small ghost', '↻ Reroute Tasks');
  reroute.onclick = () => { State.campaign.worldSeed = Math.floor(Math.random() * 0x7fffffff) + 1; curRegion = null; save(); sfx('click'); renderWorldMap(); };
  mh.appendChild(reroute); mapPanel.appendChild(mh);
  const svgWrap = el('div', 'campaign-world-map'); svgWrap.innerHTML = worldMapSVG(regions);
  const selectRegion = (node) => { const r = regions.find(x => x.id === node.getAttribute('data-region')); if (!r) return; curRegion = r.id; sfx('click'); renderWorldMap(); };
  svgWrap.querySelector('svg').addEventListener('click', (e) => { const g = e.target.closest('[data-region]'); if (g) selectRegion(g); });
  svgWrap.querySelector('svg').addEventListener('keydown', (e) => { if (e.key !== 'Enter' && e.key !== ' ') return; const g = e.target.closest('[data-region]'); if (g){ e.preventDefault(); selectRegion(g); } });
  mapPanel.appendChild(svgWrap);
  const lg = el('div', 'global-map-legend');
  lg.innerHTML = '<span style="color:#d9534f">● Enemy-held</span><span style="color:#e0b14a">● Contested</span><span style="color:#5fd0ff">● Global Force</span><span>Mission locations reroute each day</span>';
  mapPanel.appendChild(lg); wrap.appendChild(mapPanel);
  const detail = el('div', 'panel global-operation-detail');
  const r = regions.find(x => x.id === curRegion) || regions[0];
  curRegion = r ? r.id : null; renderRegionDetail(detail, r); wrap.appendChild(detail);
  dom.body.appendChild(wrap);
}

// Legacy flat mission list (kept for reference; the World Map is the live view).
function renderMissionsTab(){
  const grid = el('div', 'grid');
  grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(320px,1fr))';
  for (const m of MISSIONS) grid.appendChild(missionCard(m));
  dom.body.appendChild(grid);
}

function missionCard(m){
  const done = State.campaign.completed.includes(m.id);
  const card = el('div', 'card');
  if (done) card.style.opacity = '0.85';

  const head = el('div', 'row');
  const title = el('div'); title.style.cssText = 'font-weight:800;font-size:16px;';
  title.textContent = m.title;
  head.appendChild(title);
  head.appendChild(el('div', 'spacer'));
  if (done) head.appendChild(el('div', 'tag', '✔ Complete'));
  card.appendChild(head);

  // env + reward tags
  const tags = el('div', 'row'); tags.style.marginTop = '6px';
  tags.appendChild(el('div', 'tag', m.env));
  if (m.friendlyCarrier) tags.appendChild(el('div', 'tag', 'friendly carrier'));
  if (m.enemyCarrier) tags.appendChild(el('div', 'tag', 'enemy carrier'));
  const rew = el('div', 'tag'); rew.style.color = 'var(--gold)';
  rew.textContent = '+' + fmtCr(m.reward);
  tags.appendChild(rew);
  card.appendChild(tags);

  const brief = el('div', 'small muted'); brief.style.cssText = 'margin-top:10px;line-height:1.5;';
  brief.textContent = m.brief;
  card.appendChild(brief);

  const obj = el('div', 'mono small'); obj.style.cssText = 'margin-top:8px;color:var(--accent)';
  obj.textContent = '▸ ' + m.objective.label;
  card.appendChild(obj);

  // enemy summary
  const enemyTotal = (m.enemies || []).reduce((a, e) => a + e.count, 0);
  const en = el('div', 'mono small faint'); en.style.marginTop = '6px';
  en.textContent = 'Threat: ' + enemyTotal + ' aircraft' + (m.enemyCarrier ? ' + carrier' : '');
  card.appendChild(en);

  // deploy / replay
  const acts = el('div', 'row'); acts.style.marginTop = '12px';
  const deploy = el('button', 'btn ' + (done ? '' : 'accent'), done ? '↻ Fly Again' : '➤ Deploy');
  deploy.onclick = () => openDeploy(m);
  acts.appendChild(deploy);
  card.appendChild(acts);

  return card;
}

// ---------------------------------------------------------------------------
//  DEPLOY FLOW — choose YOUR aircraft + wingmen + (auto) carrier, then launch.
// ---------------------------------------------------------------------------
function openDeploy(mission){
  const owned = ownedDesigns();
  if (owned.length === 0){ toast('Buy an aircraft before deploying', 'warn'); selectTab('hangar'); return; }

  const m = openModal('Deploy — ' + mission.title, true);

  // brief
  if (mission.country){
    const loc = el('div', 'global-deploy-location');
    loc.innerHTML = `<span>GLOBAL FORCE TASKING</span><b>${mission.country}</b><small>${mission.site || 'Forward sector'} · ${mission.front || 'Worldwide conflict zone'}</small>`;
    m.body.appendChild(loc);
  }
  m.body.appendChild(el('div', 'small muted', mission.brief));
  const obj = el('div', 'mono small'); obj.style.cssText = 'margin:8px 0;color:var(--accent)';
  obj.textContent = '▸ ' + mission.objective.label + '   ·   Reward ' + fmtCr(mission.reward);
  m.body.appendChild(obj);

  // ---- your aircraft picker ----
  m.body.appendChild(el('h3', '', 'Your aircraft'));
  let chosen = owned[0];
  const acGrid = el('div', 'pill-row');
  const acPills = [];
  for (const d of owned){
    const s = statsOf(d);
    const p = el('div', 'pill', d.name + (s.ok ? '' : ' ⚠'));
    p.onclick = () => {
      if (!s.ok){ toast(d.name + ' will not fly', 'bad'); return; }
      chosen = d; acPills.forEach(x => x.classList.remove('sel')); p.classList.add('sel');
    };
    if (d === chosen) p.classList.add('sel');
    acPills.push(p); acGrid.appendChild(p);
  }
  m.body.appendChild(acGrid);

  // ---- wingmen picker (available for every mission) ----
  const wingmen = State.campaign.wingmen || [];
  const selectedWing = new Set();
  if (wingmen.length){
    m.body.appendChild(el('h3', '', 'Wingmen (deploy with you)'));
    const wGrid = el('div', 'pill-row');
    for (const wm of wingmen){
      const wdesign = wm.designId ? designForOwnedId(wm.designId) : null;
      const ok = wdesign && statsOf(wdesign).ok;
      const p = el('div', 'pill', wm.name + (ok ? '' : ' ⚠'));
      p.title = wdesign ? 'flies ' + wdesign.name : 'no aircraft';
      p.onclick = () => {
        if (!ok){ toast(wm.name + ' has no flyable aircraft', 'bad'); return; }
        if (selectedWing.has(wm.id)){ selectedWing.delete(wm.id); p.classList.remove('sel'); }
        else { selectedWing.add(wm.id); p.classList.add('sel'); }
      };
      wGrid.appendChild(p);
    }
    m.body.appendChild(wGrid);
  } else {
    m.body.appendChild(el('h3', '', 'Wingmen'));
    m.body.appendChild(el('div', 'small muted', 'No wingmen hired. You fly alone (recruit some in the Wingmen tab).'));
  }

  // ---- carrier note ----
  if (mission.friendlyCarrier || mission.enemyCarrier){
    m.body.appendChild(el('h3', '', 'Capital ships'));
    const cn = el('div', 'small mono muted');
    const lines = [];
    if (mission.friendlyCarrier){
      const cv = carrierForMission(mission);
      const ownsCarrier = State.campaign.carrierId && designForOwnedId(State.campaign.carrierId);
      lines.push('Friendly: ' + (cv ? cv.name : 'support carrier') + (ownsCarrier ? '' : ' (Command support)'));
    }
    if (mission.enemyCarrier){
      const ec = stockGet(mission.enemyCarrier);
      lines.push('Enemy: ' + (ec ? ec.name : 'enemy carrier'));
    }
    cn.textContent = lines.join('   ·   ');
    m.body.appendChild(cn);
  }

  // ---- launch ----
  const launch = el('button', 'btn gold big', '🚀 Launch Sortie');
  launch.style.marginTop = '16px';
  launch.onclick = () => {
    if (!statsOf(chosen).ok){ toast('Your aircraft will not fly', 'bad'); return; }
    closeModal();
    launchMission(mission, chosen, [...selectedWing]);
  };
  m.body.appendChild(launch);
}

// Build the Battle config from chosen assets and run it.
function launchMission(mission, playerDesign, wingmanIds){
  // resolve allies from wingmen (their assigned designs, skill-tagged for AI)
  const allies = [];
  for (const id of wingmanIds){
    const wm = (State.campaign.wingmen || []).find(w => w.id === id);
    if (!wm || !wm.designId) continue;
    const d = designForOwnedId(wm.designId);
    if (!d) continue;
    const ally = cloneDesign(d, '');
    ally.name = wm.name;                 // show the pilot's callsign in battle
    ally.author = 'You';
    ally.skill = wm.skill;               // hint for ai.js (clamped fallback if ignored)
    allies.push(ally);
  }

  // resolve enemies → [{design,count,skill}]
  const enemies = (mission.enemies || []).map(e => {
    const d = stockGet(e.stock);
    if (e.name && d) d.name = e.name;     // named ace
    return { design: d, count: e.count, skill: clamp(e.skill ?? 0.5, 0, 1) };
  }).filter(e => e.design);

  // carriers
  const carrier = carrierForMission(mission);
  const enemyCarrier = mission.enemyCarrier ? stockGet(mission.enemyCarrier) : null;

  // hand the battle a copy of the player's aircraft so combat damage never
  // touches the stored design.
  const player = cloneDesign(playerDesign, '');
  player.author = 'You';

  const config = {
    player,
    allies,
    enemies,
    env: mission.env || 'day',
    objective: { ...mission.objective },
    timeLimit: mission.timeLimit || 0,
    carrier,
    enemyCarrier,
    net: null,
    onEnd: (result) => onMissionEnd(mission, result),
  };

  // record the active sortie for inspection / save resilience
  State.campaign.active = {
    missionId: mission.id,
    playerId: playerDesign.id,
    wingmanIds,
    startedDay: State.campaign.day,
  };
  save();

  // hide our screen + HUD-managed-by-battle; Battle owns the render target now.
  if (root) root.classList.add('hidden');
  sfx('lockfull');
  try {
    Battle.start(config);
  } catch (e){
    console.error('Battle.start failed', e);
    toast('Could not start battle: ' + e.message, 'bad');
    Campaign.show(); selectTab('missions');
  }
}

// ---------------------------------------------------------------------------
//  MISSION RESULT — economy + progression + result modal.
// ---------------------------------------------------------------------------
function onMissionEnd(mission, result){
  result = result || { win: false, kills: 0, deaths: 0, time: 0, score: 0, reason: 'aborted' };
  const c = State.campaign;
  const isPatrol = !!mission.patrol;                      // repeatable — never "completed"
  const firstClear = !isPatrol && !c.completed.includes(mission.id);
  let payout = 0, oldRank = c.rank, promoted = false;

  if (result.win){
    // first clear pays full reward; replays/patrols pay a reduced bounty + per-kill.
    payout = firstClear ? mission.reward : Math.round(mission.reward * 0.4);
    payout += Math.round((result.kills || 0) * 250);
    earn(payout);
    if (firstClear) c.completed.push(mission.id);
    c.day += 1;                                           // a sortie burns a day; a win can rank you up
    const newRank = rankForCompleted(c.completed.length);
    if (newRank !== c.rank){ c.rank = newRank; promoted = true; }
  } else {
    c.day += 1;                                           // a failed sortie still costs a day
  }
  // shift the theatre's control (and drift the rest of the front) BEFORE re-rendering
  if (mission._regionId) shiftRegionControl(mission._regionId, result.win, isPatrol, firstClear);
  save();

  // Battle tore down its view; bring the hub (World Map) back with fresh control.
  Campaign.show();
  selectTab('missions');
  refreshTopbar();
  showResultModal(mission, result, { payout, firstClear, promoted, oldRank });
}

function showResultModal(mission, result, info){
  const win = !!result.win;
  const m = openModal(win ? 'Mission Complete' : 'Mission Failed');

  const banner = el('div'); banner.style.cssText =
    'font-size:30px;font-weight:800;letter-spacing:.04em;margin-bottom:4px;color:' +
    (win ? 'var(--good)' : 'var(--bad)') + ';';
  banner.textContent = win ? 'VICTORY' : 'DEFEAT';
  m.body.appendChild(banner);

  m.body.appendChild(el('div', 'muted', mission.title));

  // stat readout
  const st = el('div', 'stats'); st.style.marginTop = '14px';
  const add = (k, v, cls) => { st.appendChild(el('div', 'k', k)); const e = el('div', 'v' + (cls ? ' ' + cls : '')); e.textContent = v; st.appendChild(e); };
  add('Kills', String(result.kills ?? 0), 'good');
  add('Losses', String(result.deaths ?? 0), (result.deaths ? 'bad' : ''));
  if (result.time) add('Sortie time', fmtTimeShort(result.time));
  if (result.score != null) add('Score', fmtNum(result.score));
  if (result.reason) add('Outcome', String(result.reason));
  m.body.appendChild(st);

  // payout / progression
  const eco = el('div', 'panel tight'); eco.style.marginTop = '14px';
  if (win){
    eco.innerHTML =
      '<div class="mono">Reward: <span class="credits">+' + fmtCr(info.payout) + '</span>' +
      (info.firstClear ? '' : ' <span class="faint small">(replay bounty)</span>') + '</div>';
    if (info.promoted){
      const pr = el('div', 'mono'); pr.style.cssText = 'margin-top:8px;color:var(--gold)';
      pr.textContent = '★ Promoted to ' + State.campaign.rank + '!';
      eco.appendChild(pr);
    }
    const adv = el('div', 'mono small muted'); adv.style.marginTop = '6px';
    adv.textContent = 'Advanced to Day ' + State.campaign.day;
    eco.appendChild(adv);
  } else {
    eco.innerHTML = '<div class="mono muted">No reward. A day has passed (Day ' + State.campaign.day +
      ') — regroup and try again.</div>';
  }
  m.body.appendChild(eco);

  const row = el('div', 'row'); row.style.marginTop = '16px';
  const again = el('button', 'btn', '↻ Fly Again');
  again.onclick = () => { closeModal(); openDeploy(mission); };
  row.appendChild(again);
  const ok = el('button', 'btn accent', 'Continue');
  ok.onclick = () => { closeModal(); selectTab('missions'); };
  row.appendChild(ok);
  m.body.appendChild(row);

  sfx(win ? 'lockfull' : 'boom');
}

function fmtTimeShort(sec){
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

// ---------------------------------------------------------------------------
//  MODAL helpers — render into #modal-root (created if absent). Single modal.
// ---------------------------------------------------------------------------
let activeModalBg = null;

function modalRoot(){
  let r = $('modal-root');
  if (!r){ r = el('div'); r.id = 'modal-root'; document.body.appendChild(r); }
  return r;
}
function openModal(titleText, wide){
  closeModal();
  const bg = el('div', 'modal-bg');
  const modal = el('div', 'modal');
  if (wide) modal.style.width = 'min(620px,94vw)';
  const head = el('div', 'row');
  const h = el('h2'); h.style.margin = '0'; h.textContent = titleText;
  head.appendChild(h);
  head.appendChild(el('div', 'spacer'));
  const x = el('button', 'btn small ghost', '✕');
  x.onclick = () => { sfx('click'); closeModal(); };
  head.appendChild(x);
  modal.appendChild(head);
  const body = el('div'); body.style.marginTop = '12px';
  modal.appendChild(body);
  bg.appendChild(modal);
  // click outside to dismiss
  bg.addEventListener('mousedown', (ev) => { if (ev.target === bg) closeModal(); });
  modalRoot().appendChild(bg);
  activeModalBg = bg;
  return { bg, modal, body };
}
function closeModal(){
  if (activeModalBg){ activeModalBg.remove(); activeModalBg = null; }
}
function confirmModal(titleText, msg, onYes, yesLabel, yesKind){
  const m = openModal(titleText);
  m.body.appendChild(el('div', 'muted', msg));
  const row = el('div', 'row'); row.style.marginTop = '16px';
  const no = el('button', 'btn', 'Cancel');
  no.onclick = () => { sfx('click'); closeModal(); };
  row.appendChild(no);
  const yes = el('button', 'btn ' + (yesKind || 'accent'), yesLabel || 'Confirm');
  yes.onclick = () => { closeModal(); onYes && onYes(); };
  row.appendChild(yes);
  m.body.appendChild(row);
}
