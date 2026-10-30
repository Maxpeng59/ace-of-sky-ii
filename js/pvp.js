// ============================================================================
//  Ace of Sky II — pvp.js
//  HUMAN vs HUMAN player-versus-player. Never PvE — the opponent's aircraft are
//  driven by the remote human over the relay (see net.js + server/relay.py),
//  not by AI.
//
//  Flow (rendered into #screen-pvp):
//    1. SETUP   — pick a build budget (State.pvp.budget) and a design countdown
//                 (State.pvp.designSeconds, default 300s / 5 min).
//    2. DESIGN  — a live countdown; design as many / as good aircraft as the
//                 budget allows via Hangar.open. Saved craft accumulate into a
//                 FLEET; total spent is tracked against the budget. At 0 (or on
//                 "LOCK FLEET") the fleet is frozen.
//    3. LOBBY   — connect to the relay (net.connect). HOST creates a room and
//                 reads out the code; CLIENT joins by code. Each side exchanges
//                 its fleet as exportCode() strings and flags readiness.
//    4. MATCH   — when BOTH are ready, Battle.start({ player:lead, allies:rest,
//                 enemies:[], net:{role,send,onMsg,close}, objective:{type:'pvp'},
//                 onEnd }). The enemy fleet is spawned from the peer's codes and
//                 driven by the remote human via net.
//
//  Public API (FROZEN): export const Pvp = { show() }.  BACK -> Menu.show().
// ============================================================================
import { $, el, clear, show, hide, toast, sfx, fmtCr, fmtTime, clamp } from './util.js';
import { State, newDesign, cloneDesign, exportCode, importCode, statsOf, save } from './core.js';
import { connect, createRoom, joinRoom, checkHealth, OFFICIAL_RELAY_URL } from './net.js';
import { Hangar } from './hangar.js';
import { Battle } from './battle.js';
import { Menu } from './menu.js';
import {
  crazyGamesGameplayStart, crazyGamesGameplayStop, crazyGamesInviteLink, crazyGamesUsername,
  leaveCrazyGamesRoom, updateCrazyGamesRoom,
} from './crazygames.js';

const ROOT_ID = 'screen-pvp';
const SCREEN_IDS = ['screen-menu', 'screen-creative', 'screen-mission-planner', 'screen-campaign', 'screen-pvp', 'screen-hangar'];
const RELAY_KEY = 'aceofsky2.relayUrl';
const PVP_MODES = [
  { id: 'duel', label: '1V1', size: 1, domain: 'air', env: 'day', budget: 40000 },
  { id: 'squad3', label: '3V3', size: 3, domain: 'air', env: 'day', budget: 90000 },
  { id: 'squad5', label: '5V5', size: 5, domain: 'air', env: 'day', budget: 150000 },
  { id: 'ocean', label: 'OCEANIC BATTLE', size: 3, domain: 'naval', env: 'sea', budget: 150000 },
];

function initialRelayUrl(){
  const saved = (localStorage.getItem(RELAY_KEY) || '').trim();
  // Existing players may have the old development default persisted. Migrate
  // it automatically so public PvP works without asking them to clear storage.
  if (!saved || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(saved)) return OFFICIAL_RELAY_URL;
  return saved;
}

// ---- module-scoped session state (one PvP session at a time) ---------------
let root = null;
let session = null;     // see makeSession()
let designTimer = null; // setInterval handle for the design countdown
let net = null;         // live transport from net.connect()
let battleSubs = new Set(); // Battle subscribers once the lobby becomes a match
let teardownFns = [];   // listeners to remove on exit

function makeSession(){
  const savedMode = PVP_MODES.some(m => m.id === State.pvp.mode) ? State.pvp.mode : 'duel';
  return {
    phase: 'setup',                          // setup | design | lobby | match
    budget: State.pvp.budget || 60000,
    designSeconds: State.pvp.designSeconds || 300,
    remaining: State.pvp.designSeconds || 300,
    fleet: [],                               // array of AircraftDesign (mine)
    locked: false,                           // fleet frozen?
    mode: savedMode,
    peerMode: null,
    playerName: crazyGamesUsername() || 'You',
    peerName: 'Opponent',
    relayUrl: initialRelayUrl(),
    role: null,                              // 'host' | 'client'
    room: '',
    connected: false,
    peerJoined: false,
    myReady: false,
    peerReady: false,
    myFleetCodes: [],                        // exportCode() of my fleet
    peerFleetCodes: [],                      // received from peer
    peerFleetMeta: [],                       // [{name, cost}] for display
    status: '',                              // lobby status line
  };
}

// ---------------------------------------------------------------------------
//  Screen lifecycle
// ---------------------------------------------------------------------------
export const Pvp = {
  show(){
    root = $(ROOT_ID);
    if (!root){ console.error('pvp: #screen-pvp missing'); return; }
    // hide every other screen root, reveal ours
    for (const id of SCREEN_IDS){ const s = $(id); if (s) (id === ROOT_ID ? show(s) : hide(s)); }
    hide($('hud'));
    if (!session) session = makeSession();
    renderPhase();
  },
  openFromPlatform(params){ openFromPlatform(params); },
};

function openFromPlatform(params = {}){
  if (session) cleanupSession();
  Battle.stop();
  session = makeSession();
  if (PVP_MODES.some(m => m.id === params.mode)) session.mode = params.mode;
  session.budget = modeDef().budget;
  Pvp.show();
  const design = quickDuelDesign();
  if (!design){ toast('No compatible saved unit for ' + modeDef().label, 'bad'); return; }
  session.fleet = Array.from({ length: modeDef().size }, () => cloneDesign(design, ''));
  lockFleet(modeDef().label + ' ready');
  const room = String(params.room || '').trim().toUpperCase();
  if (/^[A-HJ-NP-Z2-9]{6}$/.test(room)) void doJoin(room);
  else void doHost();
}

function exitToMenu(){
  cleanupSession();
  Menu.show();
}

function cleanupSession(){
  stopDesignTimer();
  if (net){ try { net.close(); } catch (e){} net = null; }
  leaveCrazyGamesRoom();
  crazyGamesGameplayStop();
  for (const fn of teardownFns){ try { fn(); } catch (e){} }
  teardownFns = [];
  battleSubs.clear();
  matchStarting = false;
  session = null;
}

// fleet spend helper -> total cost of all saved designs
function fleetCost(fleet){
  let c = 0;
  for (const d of fleet){ try { c += statsOf(d).cost; } catch (e){} }
  return c;
}

function modeDef(id = session && session.mode){
  return PVP_MODES.find(m => m.id === id) || PVP_MODES[0];
}

function isVessel(d){
  return !!(d && (d.isCarrier || d.role === 'carrier' || d.role === 'ship' || d.role === 'cruiser'));
}

function modeAllowsDesign(d, mode = modeDef()){
  if (!d) return false;
  const rightDomain = mode.domain === 'naval' ? isVessel(d) : !isVessel(d);
  if (!rightDomain) return false;
  try { return !!statsOf(d).ok; } catch (e){ return false; }
}

function fleetModeError(fleet, mode = modeDef()){
  if (!Array.isArray(fleet) || fleet.length !== mode.size) return `This mode requires exactly ${mode.size} ${mode.domain === 'naval' ? 'vessels' : 'aircraft'}.`;
  if (fleet.some(d => !modeAllowsDesign(d, mode))) return mode.domain === 'naval' ? 'Oceanic Battle accepts ships, cruisers, and carriers only.' : 'This mode accepts flight-ready aircraft only.';
  return '';
}

function isOfficialRelay(){
  return session && session.relayUrl.replace(/\/$/, '') === OFFICIAL_RELAY_URL;
}

function quickDuelDesign(){
  const mode = modeDef();
  return (State.library || []).find(d => modeAllowsDesign(d, mode)) || null;
}

function addRelayStatus(container){
  const card = el('div', 'card');
  card.style.marginTop = '14px';
  const row = el('div', 'row');
  row.appendChild(el('b', '', isOfficialRelay() ? 'Official relay' : 'Custom relay'));
  row.appendChild(el('div', 'spacer'));
  const state = el('span', 'small mono', 'CHECKING…');
  state.style.color = 'var(--warn)';
  row.appendChild(state);
  card.appendChild(row);
  if (!isOfficialRelay()) card.appendChild(el('div', 'small muted', session.relayUrl));
  container.appendChild(card);
  const checkedUrl = session.relayUrl;
  checkHealth(checkedUrl).then(ok => {
    if (!state.isConnected || !session || session.relayUrl !== checkedUrl) return;
    state.textContent = ok ? 'ONLINE' : 'UNREACHABLE';
    state.style.color = ok ? 'var(--good)' : 'var(--bad)';
  });
}

function addAdvancedRelayControls(container){
  const details = el('details');
  details.style.marginTop = '12px';
  const summary = el('summary', 'small muted', 'Custom relay');
  summary.style.cursor = 'pointer';
  details.appendChild(summary);
  const field = el('label', 'field'); field.style.marginTop = '10px';
  field.appendChild(el('span', '', 'Custom relay URL'));
  const input = el('input'); input.type = 'url'; input.value = session.relayUrl; input.placeholder = 'http://localhost:8787';
  input.style.width = '100%';
  input.onchange = () => {
    session.relayUrl = input.value.trim() || OFFICIAL_RELAY_URL;
    localStorage.setItem(RELAY_KEY, session.relayUrl);
    renderPhase();
  };
  field.appendChild(input); details.appendChild(field);
  if (!isOfficialRelay()){
    const reset = el('button', 'btn small', 'USE OFFICIAL RELAY');
    reset.style.marginTop = '8px';
    reset.onclick = () => {
      session.relayUrl = OFFICIAL_RELAY_URL;
      localStorage.setItem(RELAY_KEY, OFFICIAL_RELAY_URL);
      renderPhase();
    };
    details.appendChild(reset);
  }
  container.appendChild(details);
}

// ---------------------------------------------------------------------------
//  Phase router
// ---------------------------------------------------------------------------
function renderPhase(){
  if (!root || !session) return;
  clear(root);
  if (session.phase === 'setup') renderSetup();
  else if (session.phase === 'design') renderDesign();
  else if (session.phase === 'lobby') renderLobby();
  // 'match' hands off to Battle which owns the screen; nothing to render here.
}

// ===========================================================================
//  PHASE 1 — SETUP
// ===========================================================================
function renderSetup(){
  const wrap = el('div');
  wrap.style.cssText = 'max-width:760px;margin:0 auto;width:100%;';

  const head = el('div', 'row');
  head.style.marginBottom = '6px';
  const back = el('button', 'btn small', '◂ MENU');
  back.onclick = () => { sfx('click'); exitToMenu(); };
  head.appendChild(back);
  const sp = el('div', 'spacer'); head.appendChild(sp);
  wrap.appendChild(head);

  const eyebrow = el('div', 'eyebrow', 'MULTIPLAYER · HUMAN vs HUMAN');
  const h1 = el('h1', 'title', 'PVP ONLINE');
  h1.style.fontSize = '48px';
  wrap.appendChild(eyebrow); wrap.appendChild(h1);

  const modePanel = el('div', 'panel');
  modePanel.style.marginTop = '22px';
  modePanel.appendChild(el('h2', '', 'Mode'));
  const modeRow = el('div', 'pill-row');
  for (const mode of PVP_MODES){
    const button = el('button', 'pill' + (session.mode === mode.id ? ' sel' : ''), mode.label);
    button.onclick = () => {
      if (session.mode === mode.id) return;
      session.mode = mode.id;
      session.budget = mode.budget;
      session.fleet = [];
      sfx('click');
      renderPhase();
    };
    modeRow.appendChild(button);
  }
  modePanel.appendChild(modeRow);
  wrap.appendChild(modePanel);

  const quickDesign = quickDuelDesign();
  const mode = modeDef();
  const quick = el('div', 'panel');
  quick.style.cssText = 'margin-top:14px;border-color:var(--good);';
  quick.appendChild(el('h2', '', 'Quick Start'));
  const unitWord = mode.domain === 'naval' ? 'VESSEL' : 'AIRCRAFT';
  const quickBtn = el('button', 'btn accent big', quickDesign ? `USE ${quickDesign.name} ×${mode.size}` : `NO READY ${unitWord}`);
  quickBtn.style.marginTop = '14px'; quickBtn.disabled = !quickDesign;
  quickBtn.onclick = () => {
    session.fleet = Array.from({ length: mode.size }, () => cloneDesign(quickDesign, ''));
    lockFleet(mode.label + ' ready');
  };
  quick.appendChild(quickBtn);
  addRelayStatus(quick);
  wrap.appendChild(quick);

  const panel = el('div', 'panel');
  panel.style.marginTop = '22px';
  panel.appendChild(el('h2', '', 'Custom Fleet'));

  // budget control
  const bField = el('label', 'field');
  bField.appendChild(el('span', '', 'Budget'));
  const bRow = el('div', 'row');
  const bInput = el('input');
  bInput.type = 'number'; bInput.min = '5000'; bInput.max = '500000'; bInput.step = '5000';
  bInput.value = String(session.budget); bInput.style.width = '160px';
  const bPreview = el('span', 'credits mono', fmtCr(session.budget));
  bInput.oninput = () => {
    const v = clamp(parseInt(bInput.value || '0', 10) || 0, 5000, 500000);
    session.budget = v; bPreview.textContent = fmtCr(v);
  };
  bRow.appendChild(bInput); bRow.appendChild(bPreview);
  // quick presets
  for (const v of [40000, 60000, 90000, 150000]){
    const p = el('button', 'pill', fmtCr(v));
    p.onclick = () => { session.budget = v; bInput.value = String(v); bPreview.textContent = fmtCr(v); sfx('click'); };
    bRow.appendChild(p);
  }
  bField.appendChild(bRow);
  panel.appendChild(bField);

  // design time control
  const tField = el('label', 'field');
  tField.style.marginTop = '14px';
  tField.appendChild(el('span', '', 'Design time'));
  const tRow = el('div', 'pill-row');
  const choices = [
    { s: 120, label: '2 min' }, { s: 300, label: '5 min' },
    { s: 600, label: '10 min' }, { s: 1200, label: '20 min' },
  ];
  const tPills = [];
  for (const c of choices){
    const p = el('button', 'pill' + (session.designSeconds === c.s ? ' sel' : ''), c.label);
    p.onclick = () => {
      session.designSeconds = c.s; session.remaining = c.s;
      tPills.forEach(x => x.classList.remove('sel')); p.classList.add('sel'); sfx('click');
    };
    tPills.push(p); tRow.appendChild(p);
  }
  tField.appendChild(tRow);
  panel.appendChild(tField);

  addAdvancedRelayControls(panel);

  // start design phase
  const actions = el('div', 'row');
  actions.style.marginTop = '20px';
  const go = el('button', 'btn accent big', 'START DESIGN PHASE  ▸');
  go.onclick = () => {
    State.pvp.budget = session.budget;
    State.pvp.designSeconds = session.designSeconds;
    State.pvp.mode = session.mode;
    session.remaining = session.designSeconds;
    save();
    sfx('ui');
    session.phase = 'design';
    startDesignTimer();
    renderPhase();
  };
  actions.appendChild(go);

  // option to reuse last fleet
  if (Array.isArray(State.pvp.lastFleet) && !fleetModeError(State.pvp.lastFleet, mode)){
    const reuse = el('button', 'btn', 'Reuse last fleet (' + State.pvp.lastFleet.length + ')');
    reuse.onclick = () => {
      session.fleet = State.pvp.lastFleet.map(d => cloneDesign(d, ''));
      toast('Loaded ' + session.fleet.length + ' saved aircraft into the fleet', 'good');
      sfx('ui');
    };
    actions.appendChild(reuse);
  }
  panel.appendChild(actions);

  wrap.appendChild(panel);
  root.appendChild(wrap);
}

// ===========================================================================
//  PHASE 2 — DESIGN  (countdown + fleet management + Hangar.open)
// ===========================================================================
function startDesignTimer(){
  stopDesignTimer();
  designTimer = setInterval(() => {
    if (!session || session.phase !== 'design') return;
    session.remaining -= 1;
    updateTimerDisplay();
    if (session.remaining <= 0){
      session.remaining = 0;
      lockFleet('Time! Fleet locked.');
    }
  }, 1000);
}
function stopDesignTimer(){ if (designTimer){ clearInterval(designTimer); designTimer = null; } }

let timerEl = null, spentEl = null, spentBar = null;
function updateTimerDisplay(){
  if (timerEl){
    timerEl.textContent = fmtTime(Math.max(0, session.remaining));
    timerEl.classList.toggle('hud-warn-tone', session.remaining <= 30 && session.remaining > 0);
  }
}

function renderDesign(){
  const wrap = el('div');
  wrap.style.cssText = 'max-width:980px;margin:0 auto;width:100%;';

  // top bar: timer, budget, spent
  const bar = el('div', 'topbar');
  bar.style.marginBottom = '18px';
  bar.appendChild(el('span', '', modeDef().label));
  const tPill = el('span', 'pill');
  tPill.appendChild(el('span', 'muted', 'TIME '));
  timerEl = el('span', 'mono', fmtTime(session.remaining));
  timerEl.style.fontSize = '16px'; timerEl.style.color = 'var(--accent)';
  tPill.appendChild(timerEl);
  bar.appendChild(tPill);
  const sp = el('div', 'spacer'); bar.appendChild(sp);
  const bPill = el('span', 'pill');
  bPill.appendChild(el('span', 'muted', 'BUDGET '));
  bPill.appendChild(el('span', 'credits', fmtCr(session.budget)));
  bar.appendChild(bPill);
  wrap.appendChild(bar);

  // spent bar
  const spent = fleetCost(session.fleet);
  const spendPanel = el('div', 'panel tight');
  spendPanel.style.marginBottom = '14px';
  const spLabel = el('div', 'hud-bar-label');
  spentEl = el('span', '', fmtCr(spent) + ' / ' + fmtCr(session.budget));
  spLabel.appendChild(el('span', '', 'FLEET COST'));
  spLabel.appendChild(spentEl);
  spendPanel.appendChild(spLabel);
  const barOuter = el('div', 'statbar'); barOuter.style.height = '10px';
  spentBar = el('i');
  const frac = session.budget > 0 ? clamp(spent / session.budget, 0, 1) : 0;
  spentBar.style.width = (frac * 100).toFixed(1) + '%';
  if (spent > session.budget) spentBar.style.background = 'var(--bad)';
  barOuter.appendChild(spentBar);
  spendPanel.appendChild(barOuter);
  if (spent > session.budget){
    const over = el('div', 'warns'); over.style.marginTop = '6px';
    over.innerHTML = '<span class="err">Over budget by ' + fmtCr(spent - session.budget) + ' — trim the fleet before locking in.</span>';
    spendPanel.appendChild(over);
  }
  const modeError = fleetModeError(session.fleet);
  if (session.fleet.length && modeError){
    const warning = el('div', 'warns'); warning.style.marginTop = '6px';
    warning.textContent = modeError;
    spendPanel.appendChild(warning);
  }
  wrap.appendChild(spendPanel);

  // header row
  const hrow = el('div', 'row');
  hrow.style.marginBottom = '8px';
  const mode = modeDef();
  hrow.appendChild(el('h2', '', `Your ${mode.label} Fleet (${session.fleet.length}/${mode.size})`));
  const hsp = el('div', 'spacer'); hrow.appendChild(hsp);
  const newBtn = el('button', 'btn accent', mode.domain === 'naval' ? '✚ NEW VESSEL' : '✚ NEW AIRCRAFT');
  newBtn.disabled = session.fleet.length >= mode.size;
  newBtn.onclick = () => openDesignEditor(null);
  hrow.appendChild(newBtn);
  const impBtn = el('button', 'btn', '⇩ IMPORT CODE');
  impBtn.onclick = importDesignPrompt;
  hrow.appendChild(impBtn);
  wrap.appendChild(hrow);

  // fleet list
  const list = el('div', 'list');
  if (session.fleet.length === 0){
    const empty = el('div', 'panel');
    empty.style.textAlign = 'center'; empty.style.color = 'var(--ink-dim)';
    empty.textContent = `Add ${mode.size} ${mode.domain === 'naval' ? 'vessels' : 'aircraft'}.`;
    list.appendChild(empty);
  } else {
    session.fleet.forEach((d, i) => list.appendChild(fleetRow(d, i)));
  }
  wrap.appendChild(list);

  // footer
  const foot = el('div', 'row');
  foot.style.marginTop = '20px';
  const back = el('button', 'btn small', '◂ SETUP');
  back.onclick = () => { stopDesignTimer(); session.phase = 'setup'; renderPhase(); };
  foot.appendChild(back);
  const fsp = el('div', 'spacer'); foot.appendChild(fsp);
  const lock = el('button', 'btn gold big', '🔒 LOCK FLEET & GO TO LOBBY');
  lock.disabled = !!modeError || spent > session.budget;
  lock.onclick = () => lockFleet('Fleet locked.');
  foot.appendChild(lock);
  wrap.appendChild(foot);

  updateTimerDisplay();
  root.appendChild(wrap);
}

function fleetRow(d, i){
  const row = el('div', 'list-row');
  let st; try { st = statsOf(d); } catch (e){ st = null; }
  const swatch = el('div');
  swatch.style.cssText = 'width:30px;height:30px;border-radius:6px;flex:none;border:1px solid rgba(255,255,255,.2);background:' + (d.color || '#cfd8e3');
  row.appendChild(swatch);

  const info = el('div'); info.style.flex = '1';
  const nameLine = el('div');
  nameLine.appendChild(el('b', '', d.name || 'Aircraft'));
  if (i === 0){ const lead = el('span', 'tag'); lead.textContent = 'LEAD'; lead.style.marginLeft = '8px'; lead.style.color = 'var(--gold)'; nameLine.appendChild(lead); }
  info.appendChild(nameLine);
  const meta = el('div', 'small faint mono');
  if (st){
    const warn = (!st.ok) ? ' · ⚠ ' + (st.errors[0] || 'invalid') : '';
    meta.textContent = `${fmtCr(st.cost)} · ${(st.mass/1000).toFixed(1)}t · TWR ${st.twr.toFixed(2)} · ${Math.round(st.vMaxBoost*3.6)}km/h · ${Math.round(st.durability)}HP${warn}`;
    if (!st.ok) meta.style.color = 'var(--bad)';
  } else meta.textContent = 'stats unavailable';
  info.appendChild(meta);
  row.appendChild(info);

  const edit = el('button', 'btn small', 'EDIT');
  edit.onclick = () => openDesignEditor(i);
  row.appendChild(edit);
  const dup = el('button', 'btn small', 'DUP');
  dup.disabled = session.fleet.length >= modeDef().size;
  dup.onclick = () => { session.fleet.splice(i + 1, 0, cloneDesign(d)); sfx('click'); renderPhase(); };
  row.appendChild(dup);
  const exp = el('button', 'btn small', 'CODE');
  exp.onclick = () => exportDesignPrompt(d);
  row.appendChild(exp);
  if (i > 0){
    const up = el('button', 'btn small', '▲');
    up.title = 'Promote (move toward lead)';
    up.onclick = () => { const t = session.fleet[i - 1]; session.fleet[i - 1] = d; session.fleet[i] = t; sfx('click'); renderPhase(); };
    row.appendChild(up);
  }
  const del = el('button', 'btn small danger', '✕');
  del.onclick = () => { session.fleet.splice(i, 1); sfx('click'); renderPhase(); };
  row.appendChild(del);
  return row;
}

// open the KSP-style hangar to edit a fleet entry (or create a new one),
// enforcing the remaining-budget as the hangar's budget bar.
function openDesignEditor(index){
  const isNew = index == null;
  if (isNew && session.fleet.length >= modeDef().size){ toast('Fleet is full', 'warn'); return; }
  const base = isNew ? newDesign('Fleet ' + (session.fleet.length + 1)) : session.fleet[index];
  const editing = cloneDesign(base, '');         // edit a clone; commit on exit
  editing.id = base.id;                           // keep id stable for in-place save
  // remaining budget available to THIS craft = total budget minus other craft
  const spentOthers = fleetCost(session.fleet.filter((_, i) => i !== index));
  const budgetForThis = Math.max(0, session.budget - spentOthers);

  sfx('ui');
  Hangar.open({
    design: editing,
    title: (isNew ? 'NEW AIRCRAFT' : 'EDIT — ' + (base.name || 'Aircraft')) + '   ·   FLEET BUDGET LEFT ' + fmtCr(budgetForThis),
    budget: budgetForThis,
    actions: [
      { label: '✔ SAVE TO FLEET', kind: 'gold', fn: (design, stats) => {
          commitDesign(index, design, stats);
        } },
    ],
    onExit: (design) => {
      // closing without explicit save still commits the current edit (KSP-like)
      let st; try { st = statsOf(design); } catch (e){ st = null; }
      commitDesign(index, design, st);
    },
  });
}

function commitDesign(index, design, stats){
  if (!session) return;
  if (index == null && session.fleet.length >= modeDef().size){ toast('Fleet is full', 'warn'); return; }
  // validate vs budget for the whole fleet
  const others = session.fleet.filter((_, i) => i !== index);
  const cost = stats ? stats.cost : fleetCost([design]);
  const projected = fleetCost(others) + cost;
  if (index == null){
    session.fleet.push(design);
  } else if (index >= 0 && index < session.fleet.length){
    session.fleet[index] = design;
  } else {
    session.fleet.push(design);
  }
  if (projected > session.budget){
    toast('Saved, but fleet is ' + fmtCr(projected - session.budget) + ' over budget', 'warn');
  } else {
    toast('Saved "' + (design.name || 'Aircraft') + '" to fleet', 'good');
  }
  // back to the design phase screen
  if (Hangar.close) try { Hangar.close(); } catch (e){}
  Pvp.show();
}

function exportDesignPrompt(d){
  const code = exportCode(d);
  showCodeModal('Share code for "' + (d.name || 'Aircraft') + '"', code, false);
  sfx('click');
}
function importDesignPrompt(){
  if (session.fleet.length >= modeDef().size){ toast('Fleet is full', 'warn'); return; }
  showCodeModal('Paste an ASK2 design code', '', true, (code) => {
    const d = importCode(code);
    if (!d){ toast('Invalid design code', 'bad'); return; }
    session.fleet.push(d);
    toast('Imported "' + d.name + '"', 'good');
    renderPhase();
  });
}

function lockFleet(msg){
  // drop invalid/empty craft, warn if over budget but allow (battle clamps)
  session.fleet = session.fleet.filter(d => d && d.parts && d.parts.length);
  const modeError = fleetModeError(session.fleet);
  if (modeError){ toast(modeError, 'bad'); session.phase = 'design'; renderPhase(); return; }
  stopDesignTimer();
  session.locked = true;
  // persist for reuse next session
  State.pvp.lastFleet = session.fleet.map(d => cloneDesign(d, ''));
  State.pvp.mode = session.mode;
  save();
  session.myFleetCodes = session.fleet.map(d => exportCode(d));
  toast(msg || 'Fleet locked', 'good');
  sfx('lockfull');
  session.phase = 'lobby';
  renderPhase();
}

// ===========================================================================
//  PHASE 3 — LOBBY  (relay connect, fleet exchange, readiness)
// ===========================================================================
function renderLobby(){
  const wrap = el('div');
  wrap.style.cssText = 'max-width:820px;margin:0 auto;width:100%;';

  const head = el('div', 'row');
  head.style.marginBottom = '6px';
  const back = el('button', 'btn small', '◂ DESIGN');
  back.onclick = () => {
    if (net){ try { net.close(); } catch (e){} net = null; }
    leaveCrazyGamesRoom();
    session.connected = false; session.peerJoined = false; session.peerReady = false; session.myReady = false;
    session.role = null; session.room = ''; session.peerMode = null;
    startDesignTimer();
    session.phase = 'design'; renderPhase();
  };
  head.appendChild(back);
  head.appendChild(el('div', 'spacer'));
  head.appendChild(el('div', 'eyebrow', 'LOBBY'));
  wrap.appendChild(head);

  const h1 = el('h1', 'title', modeDef().label + ' LOBBY'); h1.style.fontSize = '40px';
  wrap.appendChild(h1);

  const grid = el('div', 'split');
  grid.style.marginTop = '14px';

  // ---- left: connection ----
  const conn = el('div', 'panel');
  conn.appendChild(el('h2', '', 'Connection'));

  if (!session.connected){
    addRelayStatus(conn);

    const btnRow = el('div', 'row'); btnRow.style.marginTop = '14px';
    const hostBtn = el('button', 'btn accent', '⌂ CREATE ONLINE ROOM');
    hostBtn.onclick = () => doHost();
    btnRow.appendChild(hostBtn);
    conn.appendChild(btnRow);

    const joinField = el('label', 'field'); joinField.style.marginTop = '14px';
    joinField.appendChild(el('span', '', 'Join with room code'));
    const jrow = el('div', 'row');
    const jInput = el('input'); jInput.type = 'text'; jInput.placeholder = 'ABC234'; jInput.maxLength = 6;
    jInput.style.width = '120px'; jInput.style.textTransform = 'uppercase'; jInput.style.fontFamily = 'var(--mono)';
    const joinBtn = el('button', 'btn', 'JOIN');
    joinBtn.onclick = () => doJoin((jInput.value || '').trim().toUpperCase());
    jInput.onkeydown = (e) => { if (e.key === 'Enter') joinBtn.onclick(); };
    jrow.appendChild(jInput); jrow.appendChild(joinBtn);
    joinField.appendChild(jrow);
    conn.appendChild(joinField);

    addAdvancedRelayControls(conn);
  } else {
    // connected — show room + role + peer status
    const roomLine = el('div', 'topbar'); roomLine.style.marginBottom = '12px';
    roomLine.appendChild(el('span', '', session.role === 'host' ? 'HOSTING' : 'JOINED'));
    const codePill = el('span', 'pill');
    codePill.appendChild(el('span', 'muted', 'ROOM '));
    const codeVal = el('span', 'mono', session.room);
    codeVal.style.fontSize = '18px'; codeVal.style.letterSpacing = '.2em'; codeVal.style.color = 'var(--gold)';
    codePill.appendChild(codeVal);
    roomLine.appendChild(codePill);
    if (session.role === 'host'){
      const copy = el('button', 'btn small', 'COPY');
      copy.onclick = () => { copyText(session.room); toast('Code copied — give it to your opponent', 'good'); };
      roomLine.appendChild(copy);
      const invite = el('button', 'btn small accent', 'COPY INVITE LINK');
      invite.onclick = async () => {
        const link = await Promise.resolve(crazyGamesInviteLink(session.room, session.mode));
        if (!link){ toast('Invite link unavailable', 'bad'); return; }
        copyText(link); toast('Invite link copied', 'good');
      };
      roomLine.appendChild(invite);
    }
    conn.appendChild(roomLine);

    // peer presence
    const peerBox = el('div', 'card');
    peerBox.appendChild(statusDot(session.peerName || 'Opponent', session.peerJoined, session.peerJoined ? 'connected' : 'waiting…'));
    conn.appendChild(peerBox);

    const me = el('div', 'card'); me.style.marginTop = '10px';
    me.appendChild(statusDot(session.playerName || 'You', true, session.myReady ? 'READY' : 'not ready'));
    conn.appendChild(me);

    const drop = el('button', 'btn small danger'); drop.textContent = 'Leave room';
    drop.style.marginTop = '12px';
    drop.onclick = () => {
      if (net){ try { net.close(); } catch (e){} net = null; }
      leaveCrazyGamesRoom();
      session.connected = false; session.peerJoined = false; session.peerReady = false; session.myReady = false;
      session.peerMode = null;
      renderPhase();
    };
    conn.appendChild(drop);

    if (session.status){ const s = el('div', 'small muted'); s.style.marginTop = '10px'; s.textContent = session.status; conn.appendChild(s); }
  }
  grid.appendChild(conn);

  // ---- right: fleets + readiness ----
  const right = el('div', 'panel');
  right.appendChild(el('h2', '', 'Fleets'));

  const mine = el('div');
  mine.appendChild(el('h3', '', 'Your fleet (' + session.fleet.length + ') — ' + fmtCr(fleetCost(session.fleet))));
  for (const d of session.fleet){
    const r = el('div', 'list-row'); r.style.padding = '6px 10px';
    const sw = el('div'); sw.style.cssText = 'width:18px;height:18px;border-radius:4px;flex:none;background:' + (d.color || '#cfd8e3');
    r.appendChild(sw);
    r.appendChild(el('span', '', d.name || 'Aircraft'));
    mine.appendChild(r);
  }
  right.appendChild(mine);

  const peer = el('div'); peer.style.marginTop = '12px';
  const peerCount = session.peerFleetMeta.length;
  peer.appendChild(el('h3', '', 'Opponent fleet (' + (peerCount || '—') + ')'));
  if (peerCount){
    for (const m of session.peerFleetMeta){
      const r = el('div', 'list-row'); r.style.padding = '6px 10px';
      r.appendChild(el('span', '', m.name || 'Aircraft'));
      const sp = el('div', 'spacer'); r.appendChild(sp);
      r.appendChild(el('span', 'small faint mono', fmtCr(m.cost || 0)));
      peer.appendChild(r);
    }
  } else {
    const w = el('div', 'small faint'); w.textContent = session.peerJoined ? 'Waiting for opponent to lock & send fleet…' : 'No opponent yet.';
    peer.appendChild(w);
  }
  right.appendChild(peer);

  // readiness + launch
  if (session.connected){
    const peerModeOk = !session.peerMode || session.peerMode === session.mode;
    const peerFleetOk = peerModeOk && peerCount === modeDef().size;
    const ready = el('div', 'row'); ready.style.marginTop = '16px';
    const readyBtn = el('button', 'btn ' + (session.myReady ? '' : 'accent'),
      session.myReady ? '✓ READY (click to unready)' : 'I AM READY');
    readyBtn.disabled = peerCount > 0 && !peerFleetOk;
    readyBtn.onclick = () => toggleReady();
    ready.appendChild(readyBtn);
    right.appendChild(ready);

    const both = session.myReady && session.peerReady && session.peerJoined && peerFleetOk;
    const status = el('div', 'small'); status.style.marginTop = '10px';
    if (!peerModeOk) { status.style.color = 'var(--bad)'; status.textContent = `Mode mismatch: opponent selected ${modeDef(session.peerMode).label}.`; }
    else if (peerCount > 0 && peerCount !== modeDef().size) { status.style.color = 'var(--bad)'; status.textContent = `Opponent needs ${modeDef().size} units.`; }
    else if (both) { status.style.color = 'var(--good)'; status.textContent = 'Launching…'; }
    else if (session.myReady && !session.peerReady) { status.style.color = 'var(--warn)'; status.textContent = 'Waiting for opponent…'; }
    else { status.style.color = 'var(--ink-dim)'; status.textContent = 'Ready when set.'; }
    right.appendChild(status);
  }
  grid.appendChild(right);

  wrap.appendChild(grid);
  root.appendChild(wrap);
}

function statusDot(label, on, text){
  const row = el('div', 'row');
  const dot = el('span');
  dot.style.cssText = 'width:12px;height:12px;border-radius:50%;flex:none;background:' + (on ? 'var(--good)' : 'var(--ink-faint)') +
    (on ? ';box-shadow:0 0 8px var(--good)' : '');
  row.appendChild(dot);
  row.appendChild(el('b', '', label));
  row.appendChild(el('div', 'spacer'));
  const txt = el('span', 'small mono', text);
  txt.style.color = on ? 'var(--good)' : 'var(--ink-dim)';
  row.appendChild(txt);
  return row;
}

// ---- relay host / join ----
async function doHost(){
  session.status = 'Creating room…'; renderPhase();
  localStorage.setItem(RELAY_KEY, session.relayUrl);
  const res = await createRoom(session.relayUrl);
  if (!res.ok){ toast('Could not create room: ' + res.error, 'bad'); session.status = res.error; renderPhase(); return; }
  session.role = 'host'; session.room = res.room;
  startLiveNet();
  session.connected = true; session.status = 'Room ' + res.room + ' created. Share the code.';
  updateCrazyGamesRoom(session.room, session.mode, true);
  toast('Room created: ' + res.room, 'good'); sfx('lockfull');
  renderPhase();
}
async function doJoin(code){
  if (!code){ toast('Enter a room code', 'warn'); return; }
  session.status = 'Joining ' + code + '…'; renderPhase();
  localStorage.setItem(RELAY_KEY, session.relayUrl);
  const res = await joinRoom(session.relayUrl, code);
  if (!res.ok){ toast('Could not join: ' + res.error, 'bad'); session.status = res.error; renderPhase(); return; }
  session.role = 'client'; session.room = res.room;
  startLiveNet();
  session.connected = true;
  session.peerJoined = (res.peers || []).indexOf('host') >= 0;
  session.status = 'Joined room ' + res.room + '.';
  updateCrazyGamesRoom(session.room, session.mode, false);
  toast('Joined ' + res.room, 'good'); sfx('lockfull');
  renderPhase();
}

// open the live transport and wire lobby-phase handlers
function startLiveNet(){
  if (net){ try { net.close(); } catch (e){} net = null; }
  net = connect({
    url: session.relayUrl,
    room: session.room,
    role: session.role,
    onState: (m) => {
      if (session && session.phase === 'match') dispatchBattleMsg(m);
    },
    onEvent: (m) => {
      if (session && session.phase === 'match') dispatchBattleMsg(m);
      else onLobbyMsg(m);
    },
    onPeer: (info) => {
      if (session && session.phase === 'match'){
        if (info && info.timedOut) dispatchBattleMsg({ t: 'event', kind: 'peerTimeout' });
      } else onPeerChange(info);
    },
    onClose: (reason) => {
      if (session && session.phase === 'lobby'){
        session.connected = false; session.peerJoined = false; session.peerReady = false;
        session.status = 'Disconnected: ' + reason;
        leaveCrazyGamesRoom();
        toast('Connection lost: ' + reason, 'bad');
        renderPhase();
      } else if (session && session.phase === 'match'){
        dispatchBattleMsg({ t: 'event', kind: 'netClose', reason });
      }
    },
  });
  // announce ourselves + send fleet immediately so a peer already present gets it
  sendHello();
}

function dispatchBattleMsg(msg){
  for (const cb of battleSubs){ try { cb(msg); } catch (e){} }
}

function sendHello(){
  if (!net) return;
  net.send({ t: 'hello', role: session.role, mode: session.mode, name: session.playerName });
  // send fleet codes + lightweight meta for the lobby display
  net.send({
    t: 'fleet',
    mode: session.mode,
    name: session.playerName,
    codes: session.myFleetCodes,
    meta: session.fleet.map(d => { let c = 0; try { c = statsOf(d).cost; } catch (e){} return { name: d.name, cost: c }; }),
  });
  net.send({ t: 'ready', ready: session.myReady });
}

function onPeerChange(info){
  if (!session) return;
  if (info.joined){
    session.peerJoined = true;
    session.status = 'Opponent connected.';
    if (session.role === 'host') updateCrazyGamesRoom(session.room, session.mode, false);
    // re-send our fleet so the late joiner gets it
    sendHello();
    if (session.phase === 'lobby') renderPhase();
  } else if (info.timedOut){
    session.peerJoined = false;
    if (session.role === 'host') updateCrazyGamesRoom(session.room, session.mode, true);
    if (session.phase === 'lobby'){ session.status = 'Opponent went quiet…'; renderPhase(); }
  }
}

function onLobbyMsg(msg){
  if (!session || !msg) return;
  if (msg.t === 'hello'){
    session.peerJoined = true;
    if (typeof msg.name === 'string' && msg.name.trim()) session.peerName = msg.name.trim().slice(0, 32);
    if (PVP_MODES.some(m => m.id === msg.mode)) session.peerMode = msg.mode;
    // someone just arrived — make sure they have our fleet/ready state
    sendHello();
    if (session.phase === 'lobby') renderPhase();
    return;
  }
  if (msg.t === 'fleet'){
    // Battle uses the same message type with a `fleet` payload. It can arrive
    // during the 600 ms lobby-to-match transition; do not let it erase the
    // already exchanged lobby `codes` payload.
    if (!Array.isArray(msg.codes)) return;
    if (PVP_MODES.some(m => m.id === msg.mode)) session.peerMode = msg.mode;
    if (typeof msg.name === 'string' && msg.name.trim()) session.peerName = msg.name.trim().slice(0, 32);
    session.peerFleetCodes = Array.isArray(msg.codes) ? msg.codes : [];
    session.peerFleetMeta = Array.isArray(msg.meta) ? msg.meta : session.peerFleetCodes.map(() => ({ name: 'Aircraft', cost: 0 }));
    session.peerJoined = true;
    if (session.phase === 'lobby'){ renderPhase(); maybeStartMatch(); }
    return;
  }
  if (msg.t === 'ready'){
    session.peerReady = !!msg.ready;
    session.peerJoined = true;
    if (session.phase === 'lobby'){ renderPhase(); maybeStartMatch(); }
    return;
  }
  if (msg.t === 'bye'){
    session.peerJoined = false; session.peerReady = false;
    if (session.role === 'host') updateCrazyGamesRoom(session.room, session.mode, true);
    if (session.phase === 'lobby'){ session.status = 'Opponent left.'; renderPhase(); }
    return;
  }
}

function toggleReady(){
  session.myReady = !session.myReady;
  if (net) net.send({ t: 'ready', ready: session.myReady });
  sfx(session.myReady ? 'lock' : 'click');
  renderPhase();
  maybeStartMatch();
}

// both ready + both fleets exchanged -> start the duel.
// The HOST waits a beat to make sure the CLIENT also transitions (both sides
// independently check the same condition, so both will start).
let matchStarting = false;
function maybeStartMatch(){
  if (matchStarting || !session) return;
  if (session.phase !== 'lobby') return;
  if (!(session.myReady && session.peerReady)) return;
  if (!session.peerJoined) return;
  if (!session.peerFleetCodes || session.peerFleetCodes.length === 0) return;
  if (!session.fleet || session.fleet.length === 0) return;
  if (session.peerMode !== session.mode) return;
  if (session.peerFleetCodes.length !== modeDef().size) return;
  matchStarting = true;
  session.status = 'Launching…';
  // small delay so the final 'ready' has time to round-trip both ways
  setTimeout(() => startMatch(), 600);
}

// ===========================================================================
//  PHASE 4 — MATCH  (hand off to Battle with a net transport)
// ===========================================================================
function startMatch(){
  if (!session) return;
  matchStarting = false;
  session.phase = 'match';
  updateCrazyGamesRoom(session.room, session.mode, false);
  crazyGamesGameplayStart();

  // build the enemy fleet from the peer's design codes (human-driven over net)
  const enemyDesigns = [];
  for (const code of session.peerFleetCodes){
    const d = importCode(code);
    if (d) enemyDesigns.push(d);
  }
  if (enemyDesigns.length === 0){
    toast('Opponent fleet missing — cannot start', 'bad');
    session.phase = 'lobby'; renderPhase(); return;
  }
  if (enemyDesigns.length !== modeDef().size || enemyDesigns.some(d => !modeAllowsDesign(d))){
    toast('Opponent fleet does not match ' + modeDef().label, 'bad');
    session.phase = 'lobby'; renderPhase(); return;
  }

  const myLead = session.fleet[0];
  const myAllies = session.fleet.slice(1);

  // Adapt our net transport to Battle's expected shape:
  //   net: { role, send(msg), onMsg(cb), close() }
  // Battle pushes its own 'state'/'event' messages through send and subscribes
  // via onMsg; we route incoming through a single dispatcher.
  battleSubs.clear();
  const battleNet = {
    role: session.role,
    send: (m) => { if (net) net.send(m); },
    onMsg: (cb) => { battleSubs.add(cb); return () => battleSubs.delete(cb); },
    close: () => { /* net is closed in onEnd */ },
    // metadata Battle may use to spawn/identify the remote fleet
    peerFleet: enemyDesigns,
    peerFleetCodes: session.peerFleetCodes.slice(),
  };

  // Keep the exact same live transport used by the lobby. Closing it here
  // would send a `bye` beacon and disconnect the opponent during launch.

  // hide our screen; Battle owns #hud and the GL view from here
  hide(root);
  sfx('lockfull');

  Battle.start({
    player: myLead,
    allies: myAllies,
    enemies: [],                                   // PvE list is empty — this is human vs human
    env: modeDef().env,
    objective: { type: 'pvp', label: modeDef().label, host: session.role === 'host' },
    net: battleNet,
    onEnd: (result) => onMatchEnd(result),
  });
}

function onMatchEnd(result){
  // Keep the same party and transport together for a rematch. CrazyGames
  // requires groups to remain together after a round-based match.
  crazyGamesGameplayStop();
  if (!session){ Menu.show(); return; }
  session.connected = !!net; session.peerJoined = !!net; session.peerReady = false; session.myReady = false;
  session.phase = 'lobby';
  session.status = 'Round complete — ready up for a rematch.';
  updateCrazyGamesRoom(session.room, session.mode, false);
  if (net) net.send({ t: 'ready', ready: false });

  if (result){
    const r = result.win ? 'VICTORY' : (result.reason === 'draw' ? 'DRAW' : 'DEFEAT');
    toast(r + ' — ' + (result.kills || 0) + ' kills, ' + (result.deaths || 0) + ' losses', result.win ? 'good' : 'bad');
  }
  // show the PvP lobby again with the same room and opponent connected
  Pvp.show();
}

// ===========================================================================
//  Small shared UI: a code modal (share / paste) and clipboard helper
// ===========================================================================
function showCodeModal(title, value, editable, onAccept){
  const mroot = $('modal-root') || (() => { const m = el('div'); m.id = 'modal-root'; document.body.appendChild(m); return m; })();
  clear(mroot);
  const bg = el('div', 'modal-bg');
  const modal = el('div', 'modal');
  modal.appendChild(el('h2', '', title));
  const ta = el('textarea');
  ta.style.cssText = 'width:100%;height:120px;font-family:var(--mono);font-size:11px;resize:vertical;';
  ta.value = value || '';
  ta.readOnly = !editable;
  ta.spellcheck = false;
  modal.appendChild(ta);
  const row = el('div', 'row'); row.style.marginTop = '14px'; row.style.justifyContent = 'flex-end';
  if (!editable){
    const copy = el('button', 'btn accent', 'COPY');
    copy.onclick = () => { ta.select(); copyText(ta.value); toast('Copied', 'good'); };
    row.appendChild(copy);
  } else {
    const ok = el('button', 'btn accent', 'IMPORT');
    ok.onclick = () => { const v = ta.value.trim(); clear(mroot); if (onAccept) onAccept(v); };
    row.appendChild(ok);
  }
  const close = el('button', 'btn', 'CLOSE');
  close.onclick = () => clear(mroot);
  row.appendChild(close);
  modal.appendChild(row);
  bg.appendChild(modal);
  bg.onclick = (e) => { if (e.target === bg) clear(mroot); };
  mroot.appendChild(bg);
  if (!editable) setTimeout(() => ta.select(), 0); else setTimeout(() => ta.focus(), 0);
}

function copyText(t){
  try {
    if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t); return; }
  } catch (e){ /* fall through */ }
  // legacy fallback
  const ta = el('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e){}
  ta.remove();
}
