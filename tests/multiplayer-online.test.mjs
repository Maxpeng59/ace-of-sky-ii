import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkHealth, createRoom, joinRoom, OFFICIAL_RELAY_URL } from '../js/net.js';

assert.equal(OFFICIAL_RELAY_URL, 'https://ace-of-sky-ii-relay.jimpeng.chatgpt.site');
assert.ok(OFFICIAL_RELAY_URL.startsWith('https://'), 'the public game must use an HTTPS relay');

const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), method: options.method || 'GET' });
  const path = new URL(String(url)).pathname;
  const body = path === '/room'
    ? { ok: true, room: 'ABC234' }
    : path === '/join'
      ? { ok: true, room: 'ABC234', peers: ['host', 'client'] }
      : { ok: true, service: 'Ace of Sky II official multiplayer relay' };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

assert.equal((await createRoom()).room, 'ABC234');
assert.deepEqual((await joinRoom(undefined, 'abc234')).peers, ['host', 'client']);
assert.equal(await checkHealth(), true);
assert.deepEqual(requests, [
  { url: OFFICIAL_RELAY_URL + '/room', method: 'POST' },
  { url: OFFICIAL_RELAY_URL + '/join', method: 'POST' },
  { url: OFFICIAL_RELAY_URL + '/health', method: 'GET' },
]);

const pvpSource = fs.readFileSync(new URL('../js/pvp.js', import.meta.url), 'utf8');
const battleSource = fs.readFileSync(new URL('../js/battle.js', import.meta.url), 'utf8');
assert.match(pvpSource, /Quick Start/);
assert.match(pvpSource, /CREATE ONLINE ROOM/);
assert.match(pvpSource, /\{ id: 'squad3', label: '3V3', size: 3, maxPlayers: 6/);
assert.match(pvpSource, /\{ id: 'squad5', label: '5V5', size: 5, maxPlayers: 10/);
assert.match(pvpSource, /\{ id: 'ocean', label: 'OCEANIC BATTLE', size: 3, maxPlayers: 6, domain: 'naval', env: 'sea'/);
assert.match(pvpSource, /fleetModeError\(session\.fleet\)/,
  'selected modes must enforce their fleet size and domain');
assert.match(pvpSource, /Keep the exact same live transport used by the lobby/,
  'match launch must preserve the lobby transport instead of sending a bye beacon');
assert.match(pvpSource, /if \(!Array\.isArray\(msg\.codes\)\) return;/,
  'an early battle fleet message must not erase the lobby fleet during launch');
assert.doesNotMatch(pvpSource, /run server\/relay\.py, then paste its address/);
assert.match(battleSource, /!Array\.isArray\(this\.cfg\.networkPlayers\) && !this\.netSpawned && this\.netFleetAccum >= 1/,
  'the legacy two-player fleet handshake must still repeat until the opponent spawns');
assert.match(battleSource, /Array\.isArray\(msg\.fleet\) && msg\.fleet\.length/,
  'delayed lobby messages must not spawn an empty battle fleet');
assert.match(battleSource, /vessel && i > 0/,
  'oceanic multiplayer must spawn the remote supporting vessels on the sea');
assert.match(battleSource, /hostilesAlive === 0 && hadRemoteForce/,
  'oceanic multiplayer must not end while a remote support vessel survives');
assert.match(pvpSource, /networkPlayers\.length !== modeDef\(\)\.maxPlayers - 1/,
  'a match must include every real human pilot in the selected lobby');
assert.match(battleSource, /remotePlayers = new Map/,
  'the battle simulation must track more than one remote human craft');

console.log('multiplayer-online tests passed');
