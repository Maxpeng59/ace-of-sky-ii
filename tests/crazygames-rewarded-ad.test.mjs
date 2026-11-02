import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let sdkCallbacks;
globalThis.location = new URL('https://www.crazygames.com/game/ace-of-sky-ii');
globalThis.window = { CrazyGames: { SDK: {
  environment: 'crazygames', game: {}, async init(){},
  ad: { requestAd(type, callbacks){ assert.equal(type, 'rewarded'); sdkCallbacks = callbacks; } },
} } };
const bridge = await import('../js/crazygames.js?reward=' + Date.now());
await bridge.initCrazyGames();
assert.equal(bridge.crazyGamesRewardedAdsAvailable(), true);

let starts = 0;
const success = bridge.requestCrazyGamesRewardedAd(() => starts++);
assert.deepEqual(await bridge.requestCrazyGamesRewardedAd(), { status: 'unavailable' }, 'only one request at a time');
sdkCallbacks.adStarted();
sdkCallbacks.adFinished();
sdkCallbacks.adError({ code: 'unfilled' });
assert.equal(starts, 1);
assert.deepEqual(await success, { status: 'finished' }, 'late error must not revoke a completed ad');

const disabled = bridge.requestCrazyGamesRewardedAd();
sdkCallbacks.adError({ code: 'adsDisabled' });
sdkCallbacks.adFinished();
assert.deepEqual(await disabled, { status: 'error', code: 'adsDisabled' }, 'late finish must never grant a reward');
assert.equal(bridge.crazyGamesRewardedAdsAvailable(), false, 'Basic Launch offer is removed');

globalThis.location = new URL('https://maxpeng59.github.io/ace-of-sky-ii/');
const offPortal = await import('../js/crazygames.js?off-portal-reward=' + Date.now());
await offPortal.initCrazyGames();
assert.equal(offPortal.crazyGamesRewardedAdsAvailable(), false);

const source = fs.readFileSync(new URL('../js/campaign.js', import.meta.url), 'utf8');
const State = { money: 5000, campaign: { completed: ['m_patrol'], day: 2, rank: 'Cadet', rewardedAdAt: 0 } };
const notices = [];
const audio = [];
const blockers = [];
let pendingResolve;
let onStarted;
let requests = 0;
const context = vm.createContext({
  State, Date, console, setInterval, clearInterval,
  crazyGamesRewardedAdsAvailable: () => true,
  requestCrazyGamesRewardedAd: (callback) => {
    requests++;
    onStarted = callback;
    return new Promise(resolve => { pendingResolve = resolve; });
  },
  setAdAudioMuted: value => audio.push(['sfx', value]),
  Music: { setAdMuted: value => audio.push(['music', value]) },
  el: (_tag, cls) => ({ className: cls, setAttribute(){}, remove(){ blockers.pop(); } }),
  document: { body: { appendChild(node){ blockers.push(node); } } },
  earn: amount => { State.money += amount; },
  toast: message => notices.push(message),
  fmtCr: amount => `${amount} ☼`,
});
vm.runInContext(source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '')
  .replace(/export const /g, 'const ') + `
    dom.money = {}; dom.day = {}; dom.rank = {}; dom.progress = {}; dom.adButton = {};
    this.api = { watchCampaignAd, refreshTopbar, dom };
  `, context);

context.api.refreshTopbar();
assert.equal(context.api.dom.adButton.hidden, false);
const rewarded = context.api.watchCampaignAd();
assert.equal(State.money, 5000, 'requesting an ad grants nothing');
assert.equal(blockers.length, 1, 'UI is blocked while the ad request is pending');
onStarted();
assert.deepEqual(audio.slice(0, 2), [['sfx', true], ['music', true]]);
pendingResolve({ status: 'finished' });
await rewarded;
assert.equal(State.money, 6000);
assert.ok(State.campaign.rewardedAdAt > 0);
assert.equal(blockers.length, 0);
assert.deepEqual(audio.slice(2), [['music', false], ['sfx', false]]);
assert.match(notices.at(-1), /Ad complete/);
await context.api.watchCampaignAd();
assert.equal(requests, 1, 'cooldown prevents a second ad');

State.campaign.rewardedAdAt = 0;
const failed = context.api.watchCampaignAd();
pendingResolve({ status: 'error', code: 'unfilled' });
await failed;
assert.equal(State.money, 6000, 'unfilled ads grant no credits');
assert.equal(State.campaign.rewardedAdAt, 0, 'errors do not start the cooldown');
assert.equal(blockers.length, 0);
console.log('CrazyGames rewarded ad lifecycle and campaign economy tests passed');
