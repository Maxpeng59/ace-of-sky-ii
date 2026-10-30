import assert from 'node:assert/strict';
import fs from 'node:fs';

const calls = [];
let joinRoomListener = null;
const game = {
  isInstantMultiplayer: true,
  inviteParams: { room: 'ABC234', mode: 'squad3' },
  addJoinRoomListener(fn){ joinRoomListener = fn; },
  updateRoom(value){ calls.push(['updateRoom', value]); },
  showInviteButton(value){ calls.push(['showInviteButton', value]); },
  hideInviteButton(){ calls.push(['hideInviteButton']); },
  leftRoom(){ calls.push(['leftRoom']); },
  inviteLink(value){ calls.push(['inviteLink', value]); return 'https://www.crazygames.com/game/ace-of-sky-ii?room=ABC234'; },
  gameplayStart(){ calls.push(['gameplayStart']); },
  gameplayStop(){ calls.push(['gameplayStop']); },
};

globalThis.location = new URL('https://www.crazygames.com/game/ace-of-sky-ii');
globalThis.window = {
  CrazyGames: {
    SDK: {
      environment: 'crazygames',
      game,
      user: {
        isUserAccountAvailable: true,
        async getUser(){ return { username: 'SkyAce' }; },
      },
      async init(){ calls.push(['init']); },
    },
  },
};

const bridge = await import('../js/crazygames.js?test=' + Date.now());
const launch = await bridge.initCrazyGames();
assert.equal(launch.enabled, true);
assert.equal(launch.instant, true, 'IsInstantMultiplayer must route directly into multiplayer');
assert.deepEqual(launch.inviteParams, { room: 'ABC234', mode: 'squad3' });
assert.equal(bridge.crazyGamesUsername(), 'SkyAce');

assert.equal(bridge.updateCrazyGamesRoom('ABC234', 'squad3', true), true);
assert.deepEqual(calls.at(-2), ['updateRoom', {
  roomId: 'ABC234',
  isJoinable: true,
  inviteParams: { room: 'ABC234', mode: 'squad3' },
}]);
assert.deepEqual(calls.at(-1), ['showInviteButton', { room: 'ABC234', mode: 'squad3' }]);

let joined = null;
bridge.onCrazyGamesJoin((params) => { joined = params; });
joinRoomListener({ room: 'JKL567', mode: 'duel' });
assert.deepEqual(joined, { room: 'JKL567', mode: 'duel' });
assert.equal(await bridge.crazyGamesInviteLink('ABC234', 'squad3'),
  'https://www.crazygames.com/game/ace-of-sky-ii?room=ABC234');

bridge.crazyGamesGameplayStart();
bridge.crazyGamesGameplayStop();
bridge.leaveCrazyGamesRoom();
assert.ok(calls.some(([name]) => name === 'gameplayStart'));
assert.ok(calls.some(([name]) => name === 'gameplayStop'));
assert.ok(calls.some(([name]) => name === 'leftRoom'));

// The same published bundle must not wait on the SDK parent handshake when it
// runs independently on GitHub Pages; URL invites still work there.
globalThis.location = new URL('https://maxpeng59.github.io/ace-of-sky-ii/?room=JKL567&mode=duel');
let offPortalInitCalled = false;
globalThis.window.CrazyGames.SDK.init = async () => { offPortalInitCalled = true; };
const offPortalBridge = await import('../js/crazygames.js?off-portal=' + Date.now());
const offPortalLaunch = await offPortalBridge.initCrazyGames();
assert.equal(offPortalInitCalled, false);
assert.equal(offPortalLaunch.enabled, false);
assert.deepEqual(offPortalLaunch.inviteParams, { room: 'JKL567', mode: 'duel' });

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const pvpSource = fs.readFileSync(new URL('../js/pvp.js', import.meta.url), 'utf8');
assert.match(html, /https:\/\/sdk\.crazygames\.com\/crazygames-sdk-v3\.js/);
assert.match(mainSource, /launch\.instant/);
assert.match(mainSource, /Pvp\.openFromPlatform/);
assert.match(pvpSource, /COPY INVITE LINK/);
assert.match(pvpSource, /updateCrazyGamesRoom\(session\.room, session\.mode, true\)/);
assert.match(pvpSource, /same party and transport together for a rematch/);

console.log('CrazyGames multiplayer compliance tests passed');
