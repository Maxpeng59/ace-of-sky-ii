// CrazyGames HTML5 SDK v3 bridge. Every call is optional so the same build
// remains fully playable on GitHub Pages, localhost, and other portals.

let sdk = null;
let game = null;
let enabled = false;
let instant = false;
let inviteParams = null;
let username = '';
const joinListeners = new Set();

function cleanLaunchParams(value){
  const src = value && typeof value === 'object' ? value : {};
  const room = String(src.room || src.roomName || '').trim().toUpperCase();
  const mode = String(src.mode || '').trim();
  return {
    room: /^[A-HJ-NP-Z2-9]{6}$/.test(room) ? room : '',
    mode,
  };
}

function urlLaunchParams(){
  try {
    const q = new URLSearchParams(location.search);
    return cleanLaunchParams({ room: q.get('room'), mode: q.get('mode') });
  } catch (e){ return { room: '', mode: '' }; }
}

function isCrazyGamesRuntime(){
  try {
    const host = String(location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === 'crazygames.com' || host.endsWith('.crazygames.com');
  } catch (e){ return false; }
}

export async function initCrazyGames(){
  sdk = globalThis.window && window.CrazyGames && window.CrazyGames.SDK;
  // The SDK's init handshake intentionally waits for the CrazyGames parent.
  // Skip it on independent hosts (for example GitHub Pages), where URL invite
  // parameters still provide the same direct room-join behavior.
  if (!sdk || !isCrazyGamesRuntime()) return { enabled: false, instant: false, inviteParams: urlLaunchParams(), username: '' };
  try {
    await sdk.init();
    enabled = sdk.environment === 'local' || sdk.environment === 'crazygames';
    if (!enabled) return { enabled: false, instant: false, inviteParams: urlLaunchParams(), username: '' };
    game = sdk.game;
    instant = !!game.isInstantMultiplayer;
    inviteParams = cleanLaunchParams(game.inviteParams || urlLaunchParams());
    if (typeof game.addJoinRoomListener === 'function'){
      game.addJoinRoomListener((params) => {
        const launch = cleanLaunchParams(params);
        if (!launch.room) return;
        for (const listener of joinListeners){ try { listener(launch); } catch (e){} }
      });
    }
    if (sdk.user && sdk.user.isUserAccountAvailable && typeof sdk.user.getUser === 'function'){
      try {
        const user = await sdk.user.getUser();
        username = user && typeof user.username === 'string' ? user.username : '';
      } catch (e){ username = ''; }
    }
  } catch (e){
    console.warn('CrazyGames SDK unavailable', e);
    sdk = game = null; enabled = false; instant = false;
  }
  return { enabled, instant, inviteParams: inviteParams || urlLaunchParams(), username };
}

export function onCrazyGamesJoin(listener){
  if (typeof listener !== 'function') return () => {};
  joinListeners.add(listener);
  return () => joinListeners.delete(listener);
}

export function crazyGamesLaunch(){
  const params = inviteParams && inviteParams.room ? inviteParams : urlLaunchParams();
  return { enabled, instant, inviteParams: params, username };
}

export function crazyGamesUsername(){ return username; }

function roomParams(room, mode){ return { room: String(room || ''), mode: String(mode || 'duel') }; }

export function updateCrazyGamesRoom(room, mode, isJoinable){
  if (!enabled || !game) return false;
  const params = roomParams(room, mode);
  try {
    game.updateRoom({ roomId: params.room, isJoinable: !!isJoinable, inviteParams: params });
    if (isJoinable && typeof game.showInviteButton === 'function') game.showInviteButton(params);
    else if (!isJoinable && typeof game.hideInviteButton === 'function') game.hideInviteButton();
    return true;
  } catch (e){ console.warn('CrazyGames room update failed', e); return false; }
}

export function leaveCrazyGamesRoom(){
  if (!enabled || !game) return;
  try { if (typeof game.hideInviteButton === 'function') game.hideInviteButton(); } catch (e){}
  try { if (typeof game.leftRoom === 'function') game.leftRoom(); } catch (e){}
}

export function crazyGamesInviteLink(room, mode){
  const params = roomParams(room, mode);
  if (enabled && game && typeof game.inviteLink === 'function'){
    try { return game.inviteLink(params); } catch (e){ console.warn('CrazyGames invite link failed', e); }
  }
  try {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', params.room);
    url.searchParams.set('mode', params.mode);
    return url.toString();
  } catch (e){ return ''; }
}

export function crazyGamesGameplayStart(){
  if (enabled && game && typeof game.gameplayStart === 'function') try { game.gameplayStart(); } catch (e){}
}

export function crazyGamesGameplayStop(){
  if (enabled && game && typeof game.gameplayStop === 'function') try { game.gameplayStop(); } catch (e){}
}
