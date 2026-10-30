# ============================================================================
#  Ace of Sky II — relay.py
#  A tiny, dependency-FREE (Python standard library only) HTTP relay server
#  that lets up to ten browsers play human-vs-human PvP without any direct P2P
#  connection. It is a "store-and-forward" mailbox: each player POSTs messages
#  and every OTHER player picks them up on the next poll. No game logic lives
#  here — it just shuttles opaque JSON between the pilots in a room.
#
#  ---------------------------------------------------------------------------
#  HOW TO RUN
#  ---------------------------------------------------------------------------
#    python3 server/relay.py            # listens on 0.0.0.0:8787
#    python3 server/relay.py 9000       # custom port
#
#  The game's net.js client talks to it over plain HTTP with these endpoints
#  (all responses are JSON, CORS is wide-open '*' so the browser can reach it):
#
#    POST /room     {maxPlayers}     -> { ok, room, playerId } create a room, get a code
#    POST /join     {room}           -> { ok, room, playerId } claim the next open slot
#    POST /msg      {room,from,data} -> { ok }                 broadcast `data` to the others
#    GET  /poll?room=<>&player=<>    -> { ok, messages:[...] } drain THIS player's mailbox
#    POST /leave    {room,player}    -> { ok }                 release a player slot
#    GET  /health                    -> { ok, rooms, uptime }  liveness probe
#
#  `from` is the player's id: "host", "p2", ... "p10". Each mailbox keeps at
#  most MAX_QUEUE messages (old state frames are disposable, so we drop the
#  oldest). Idle rooms are reaped after ROOM_TTL seconds.
#
#  ---------------------------------------------------------------------------
#  PLAYING ONLINE
#  ---------------------------------------------------------------------------
#  Both browsers must be able to REACH this server over the network:
#    * Same Wi-Fi / LAN: the joining player uses the host's LAN IP, e.g.
#        http://192.168.1.50:8787   (this script prints your LAN IP on start).
#    * Over the internet: expose the port with a tunnel, e.g.
#        ngrok http 8787            -> use the https URL it prints
#        cloudflared tunnel --url http://localhost:8787
#      then both players point net.js at that public URL.
#  There is no built-in TLS or auth — it is meant for friendly LAN/tunnel games,
#  not a public service.
# ============================================================================

import json
import sys
import socket
import threading
import time
import random
import string
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# ---- tuning knobs ----------------------------------------------------------
MAX_QUEUE = 240          # per-player mailbox cap (drop oldest beyond this)
ROOM_TTL  = 600.0        # seconds of inactivity before a room is reaped
ROOM_CODE_LEN = 6        # length of the human-typed room code
MAX_PLAYERS = 10
START_TIME = time.time()

# ---- shared room store (guarded by a lock) ---------------------------------
#   rooms[code] = {
#       'created': ts, 'touched': ts,
#       'max_players': 10,
#       'peers': set('host'/'p2'/.../'p10'),
#       'box': { player_id: [msg,...] }   # mailboxes
#   }
_rooms = {}
_lock = threading.Lock()

ROLES = ('host',) + tuple('p%d' % n for n in range(2, MAX_PLAYERS + 1))


def _now():
    return time.time()


def _gen_code():
    # unambiguous alphabet (no O/0, I/1) so codes are easy to read out loud
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    while True:
        code = ''.join(random.choice(alphabet) for _ in range(ROOM_CODE_LEN))
        if code not in _rooms:
            return code


def _reap_locked():
    """Drop rooms that have gone quiet. Caller must already hold _lock."""
    cutoff = _now() - ROOM_TTL
    stale = [c for c, r in _rooms.items() if r['touched'] < cutoff]
    for c in stale:
        del _rooms[c]
    return len(stale)


def _role_key(role):
    return 1 if role == 'host' else int(role[1:])


def _clamp_players(value):
    try:
        return max(2, min(MAX_PLAYERS, int(value)))
    except (TypeError, ValueError):
        return MAX_PLAYERS


def _wrap_message(message, sender):
    if isinstance(message, dict):
        wrapped = dict(message)
        wrapped['_from'] = sender
        return wrapped
    return message


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    # ---- low-level response helpers ----------------------------------------
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '600')

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_body(self):
        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode('utf-8'))
            return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    # silence the default noisy per-request logging
    def log_message(self, fmt, *args):
        pass

    # ---- CORS preflight ----------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ---- GET routes --------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == '/health':
            with _lock:
                self._json({'ok': True, 'rooms': len(_rooms),
                            'uptime': round(_now() - START_TIME, 1),
                            'version': 2, 'maxPlayers': MAX_PLAYERS})
            return
        if path == '/poll':
            q = parse_qs(parsed.query)
            room = (q.get('room', [''])[0] or '').upper()
            player = (q.get('player', q.get('from', ['']))[0] or '')
            if player not in ROLES:
                self._json({'ok': False, 'error': 'bad role'}, 400)
                return
            with _lock:
                _reap_locked()
                r = _rooms.get(room)
                if not r:
                    self._json({'ok': False, 'error': 'no such room', 'gone': True}, 404)
                    return
                if player not in r['peers']:
                    self._json({'ok': False, 'error': 'player not in room', 'gone': True}, 404)
                    return
                r['touched'] = _now()
                msgs = r['box'][player]
                r['box'][player] = []           # drain the mailbox
                peers = sorted(r['peers'], key=_role_key)
            self._json({'ok': True, 'messages': msgs, 'peers': peers,
                        'maxPlayers': r['max_players']})
            return
        # unknown GET
        self._json({'ok': False, 'error': 'not found'}, 404)

    # ---- POST routes -------------------------------------------------------
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/room':
            data = self._read_body()
            max_players = _clamp_players(data.get('maxPlayers', MAX_PLAYERS))
            with _lock:
                _reap_locked()
                code = _gen_code()
                ts = _now()
                _rooms[code] = {
                    'created': ts, 'touched': ts,
                    'max_players': max_players,
                    'peers': {'host'},
                    'box': {role: [] for role in ROLES},
                }
            self._json({'ok': True, 'room': code, 'playerId': 'host',
                        'peers': ['host'], 'maxPlayers': max_players})
            return

        if path == '/join':
            data = self._read_body()
            room = (str(data.get('room', '')) or '').upper()
            with _lock:
                _reap_locked()
                r = _rooms.get(room)
                if not r:
                    self._json({'ok': False, 'error': 'no such room'}, 404)
                    return
                open_roles = [role for role in ROLES[1:r['max_players']]
                              if role not in r['peers']]
                if not open_roles:
                    self._json({'ok': False, 'error': 'room full'}, 409)
                    return
                player = open_roles[0]
                r['box'][player] = []
                r['peers'].add(player)
                r['touched'] = _now()
                peers = sorted(r['peers'], key=_role_key)
            self._json({'ok': True, 'room': room, 'playerId': player,
                        'peers': peers, 'maxPlayers': r['max_players']})
            return

        if path == '/msg':
            data = self._read_body()
            room = (str(data.get('room', '')) or '').upper()
            frm = str(data.get('from', ''))
            payload = data.get('data', None)
            if frm not in ROLES:
                self._json({'ok': False, 'error': 'bad role'}, 400)
                return
            with _lock:
                _reap_locked()
                r = _rooms.get(room)
                if not r:
                    self._json({'ok': False, 'error': 'no such room', 'gone': True}, 404)
                    return
                if frm not in r['peers']:
                    self._json({'ok': False, 'error': 'player not in room'}, 403)
                    return
                r['touched'] = _now()
                messages = payload if isinstance(payload, list) else [payload]
                messages = [_wrap_message(msg, frm) for msg in messages if msg is not None]
                for player in r['peers']:
                    if player == frm:
                        continue
                    box = r['box'][player]
                    box.extend(messages)
                    if len(box) > MAX_QUEUE:
                        del box[0:len(box) - MAX_QUEUE]
            self._json({'ok': True})
            return

        if path == '/leave':
            data = self._read_body()
            room = (str(data.get('room', '')) or '').upper()
            player = str(data.get('player', ''))
            with _lock:
                r = _rooms.get(room)
                if not r:
                    self._json({'ok': True, 'gone': True})
                    return
                if player == 'host':
                    del _rooms[room]
                elif player in r['peers']:
                    r['peers'].remove(player)
                    r['box'][player] = []
                    r['touched'] = _now()
            self._json({'ok': True})
            return

        # unknown POST
        self._json({'ok': False, 'error': 'not found'}, 404)


def _lan_ip():
    """Best-effort discovery of the machine's LAN IP for the run banner."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except OSError:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip


def _banner(port):
    ip = _lan_ip()
    line = '=' * 64
    print(line)
    print('  ACE OF SKY II — PvP relay server is UP')
    print(line)
    print('  Local:   http://localhost:%d' % port)
    print('  LAN:     http://%s:%d   (share this with players on the same Wi-Fi)' % (ip, port))
    print('')
    print('  In the game PvP lobby, set the relay URL to one of the above,')
    print('  then HOST creates a room and up to nine others join the 6-letter code.')
    print('')
    print('  Internet play: tunnel this port and share the public URL, e.g.')
    print('     ngrok http %d' % port)
    print('     cloudflared tunnel --url http://localhost:%d' % port)
    print('')
    print('  Endpoints: POST /room  POST /join  POST /msg  GET /poll  GET /health')
    print('  Rooms reaped after %ds idle. Ctrl+C to stop.' % int(ROOM_TTL))
    print(line)
    sys.stdout.flush()


def main():
    port = 8787
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print('Bad port "%s"; using %d' % (sys.argv[1], port))
    server = ThreadingHTTPServer(('0.0.0.0', port), RelayHandler)
    server.daemon_threads = True
    _banner(port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down relay...')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
