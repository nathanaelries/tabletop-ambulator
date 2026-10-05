import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Rooms, Fault, requireThat, matches, hash } from './rooms.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cookieName = code => `amb_${code}`;
const credentialFrom = (request, code) => {
  const entries = (request.headers.cookie || '').split(';').map(item => item.trim().split('='));
  const selected = entries.filter(([name]) => name === cookieName(code));
  return selected.length === 1 ? selected[0][1] : '';
};
const bearer = request => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1] || '';
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
async function body(request, limit = 512 * 1024) {
  requireThat(request.headers['content-type']?.split(';')[0] === 'application/json', 'Send JSON.', 415);
  requireThat(!request.headers['content-encoding'], 'Compressed requests are not supported.', 415);
  let length = 0; const chunks = [];
  for await (const chunk of request) { length += chunk.length; requireThat(length <= limit, 'Request is too large.', 413); chunks.push(chunk); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Fault(400, 'Invalid JSON.'); }
  requireThat(result && typeof result === 'object' && !Array.isArray(result), 'Send a JSON object.'); return result;
}
export async function createApp(options = {}) {
  const dataDir = options.dataDir || resolve('data');
  const hostKey = options.hostKey ?? (await readFile(process.env.HOST_KEY_FILE || resolve('secrets/host_key.txt'), 'utf8')).trim();
  requireThat(typeof hostKey === 'string' && hostKey.length >= 32, 'The host key must contain at least 32 characters.', 500);
  const hostKeyHash = hash(hostKey);
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    requireThat(parsed.origin === publicOrigin && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 'PUBLIC_ORIGIN must be an origin without a path.', 500);
    requireThat(parsed.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'Use HTTPS for public hosting.', 500);
  }
  const secure = publicOrigin.startsWith('https:');
  const store = new Rooms({ dataDir, ttlMs: options.ttlMs ?? Number(process.env.ROOM_TTL_HOURS || 48) * 3600_000, maxRooms: options.maxRooms ?? Number(process.env.MAX_ROOMS || 100), ...(process.env.ASSET_HOSTS ? { assetHosts: process.env.ASSET_HOSTS.split(',').map(host => host.trim()).filter(Boolean) } : {}), ...options.storeOptions });
  await store.load();
  const luaTemplate = await readFile(join(root, 'lua/bridge.lua'), 'utf8');
  const objectTemplate = JSON.parse(await readFile(join(root, 'lua/object-template.json'), 'utf8'));
  const files = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async file => [file, await readFile(join(root, 'public', file))])));
  const buckets = new Map();
  function rate(key, maximum, windowMs = 60_000) {
    const now = Date.now(); let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) { bucket = { start: now, count: 0 }; buckets.set(key, bucket); }
    requireThat(++bucket.count <= maximum, 'Too many requests. Try again shortly.', 429);
  }
  function origin(request) {
    if (publicOrigin) return publicOrigin;
    // Local development never trusts forwarded headers or arbitrary Host values.
    let url; try { url = new URL(`http://${request.headers.host}`); } catch { throw new Fault(403, 'Invalid host.'); }
    requireThat(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port || 80) === server.address()?.port, 'Set PUBLIC_ORIGIN before public hosting.', 403);
    return url.origin;
  }
  const checkOrigin = request => requireThat(request.headers.origin === origin(request), 'Origin is not allowed.', 403);
  const setCookie = (response, code, credential, expiresAt) => response.setHeader('Set-Cookie', `${cookieName(code)}=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}${secure ? '; Secure' : ''}`);
  const clients = new Set();
  const authorize = (request, code) => {
    const room = store.get(code), credential = credentialFrom(request, code);
    return { room, credential, identity: store.authenticate(room, credential) };
  };
  function sendState(client) {
    try {
      const room = store.get(client.code), identity = store.authenticate(room, client.credential);
      if (client.socket.bufferedAmount > 512 * 1024) { client.socket.close(1013, 'Connection is too slow.'); return; }
      const serialized = JSON.stringify({ type: 'state', state: store.view(room, identity) });
      if (serialized !== client.lastState && client.socket.readyState === WebSocket.OPEN) { client.socket.send(serialized); client.lastState = serialized; }
    } catch { client.socket.close(4001, 'Session ended.'); }
  }
  const broadcast = code => { for (const client of clients) if (client.code === code) sendState(client); };
  let storageFailed = false;
  async function persist() {
    try { await store.persist(); } catch (error) {
      storageFailed = true;
      for (const client of clients) client.socket.close(1011, 'Storage is unavailable.');
      console.error('Room storage failed; stopped accepting game requests.');
      throw new Fault(503, 'Storage is unavailable. Restart after checking the data volume.');
    }
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src https:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/healthz' && request.method === 'GET') { json(response, storageFailed ? 503 : 200, { ok: !storageFailed }); return; }
      requireThat(!storageFailed, 'Storage is unavailable.', 503);
      // TLS terminates at the explicitly configured proxy. Forwarded headers never select URLs or cookie policy.
      rate(`ip:${request.socket.remoteAddress}`, 1200);
      if (request.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        origin(request);
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' }); response.end(files.get(file)); return;
      }
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        checkOrigin(request); rate(`create:${request.socket.remoteAddress}`, 10);
        const input = await body(request, 4096);
        requireThat(matches(input.hostKey, hostKeyHash), 'The host key is incorrect.', 401);
        const { room, credential } = store.create(); await persist(); setCookie(response, room.code, credential, room.expiresAt);
        json(response, 201, { code: room.code }); return;
      }
      const path = /^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})(?:\/(.*))?$/.exec(url.pathname);
      requireThat(path, 'Not found.', 404);
      const [, code, route = ''] = path;
      if (route.startsWith('bridge/')) {
        requireThat(request.method === 'POST', 'Method not allowed.', 405);
        const room = store.get(code), credential = bearer(request);
        requireThat(matches(credential, room.bridgeHash), 'TTS authentication failed.', 401);
        rate(`bridge:${code}`, 180);
        const input = await body(request);
        if (route === 'bridge/connect') { const session = store.connectBridge(room, credential); broadcast(code); json(response, 200, { session }); return; }
        if (route === 'bridge/sync') { const result = store.sync(room, credential, input); broadcast(code); json(response, 200, result); return; }
        throw new Fault(404, 'Not found.');
      }
      if (request.method !== 'GET') checkOrigin(request);
      if (route === 'join' && request.method === 'POST') {
        rate(`join:${request.socket.remoteAddress}`, 40);
        const room = store.get(code);
        const existing = credentialFrom(request, code);
        if (existing) {
          try { store.authenticate(room, existing); throw new Fault(409, 'You already have a session in this room.'); }
          catch (error) { if (error.status !== 401) throw error; }
        }
        const input = await body(request, 4096), { credential } = store.join(room, input.name);
        await persist(); setCookie(response, code, credential, room.expiresAt); broadcast(code); json(response, 201, { code }); return;
      }
      const { room, credential, identity } = authorize(request, code);
      rate(`session:${hash(credential)}`, 180);
      if (route === '' && request.method === 'GET') { json(response, 200, store.view(room, identity)); return; }
      requireThat(request.method === 'POST', 'Method not allowed.', 405);
      const input = await body(request, 32 * 1024);
      if (route === 'seat') store.requestSeat(room, identity, input.color);
      else if (route === 'assign') store.assign(room, identity, input.id, input.color);
      else if (route === 'remove') store.remove(room, identity, input.id);
      else if (route === 'lock') { store.host(identity); requireThat(typeof input.locked === 'boolean'); room.locked = input.locked; }
      else if (route === 'configure') store.configure(room, identity, input);
      else if (route === 'action') { const id = store.action(room, identity, input); broadcast(code); json(response, 202, { id }); return; }
      else if (route === 'logout') {
        requireThat(identity.role === 'player', 'Close the room to end the host session.', 403);
        room.players = room.players.filter(p => p.id !== identity.player.id); room.commands = room.commands.filter(c => c.playerId !== identity.player.id);
        setCookie(response, code, '', Date.now());
      }
      else if (route === 'close') { store.host(identity); store.rooms.delete(code); setCookie(response, code, '', Date.now()); }
      else if (route === 'revoke-bridge') { store.host(identity); room.bridgeHash = null; store.clearBridge(room); }
      else if (route === 'object') {
        const bridgeCredential = store.rotateBridge(room, identity); await persist(); broadcast(code);
        const script = luaTemplate.replace('__ORIGIN__', origin(request)).replace('__ROOM__', code).replace('__TOKEN__', bridgeCredential);
        const object = { ObjectStates: [{ ...objectTemplate, GUID: hash(bridgeCredential).slice(0, 6), Nickname: `Ambulator ${code}`, Description: 'Private phone companion. Keep this saved object private.', LuaScript: script }] };
        json(response, 200, { object, script }); return;
      }
      else throw new Fault(404, 'Not found.');
      await persist(); broadcast(code); json(response, 200, { ok: true });
    } catch (error) {
      if (!response.headersSent) json(response, error instanceof Fault ? error.status : 500, { error: error instanceof Fault ? error.message : 'The server could not complete the request.' });
      else response.end();
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.timeout = 15_000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    try {
      requireThat(!storageFailed, 'Storage is unavailable.', 503); checkOrigin(request);
      rate(`upgrade:${request.socket.remoteAddress}`, 120);
      const url = new URL(request.url, 'http://localhost'); requireThat(url.pathname === '/ws', 'Not found.', 404);
      const code = url.searchParams.get('room'), { credential } = authorize(request, code);
      requireThat(clients.size < 300 && [...clients].filter(c => c.credential === credential).length < 3, 'Connection limit reached.', 429);
      sockets.handleUpgrade(request, socket, head, ws => {
        const client = { socket: ws, code, credential, alive: true, lastState: '' }; clients.add(client); sendState(client);
        ws.on('pong', () => { client.alive = true; });
        ws.on('error', () => {});
        ws.on('close', () => { clients.delete(client); });
        ws.on('message', (bytes, binary) => {
          try {
            requireThat(!storageFailed, 'Storage is unavailable.', 503);
            requireThat(!binary, 'Send JSON text.');
            rate(`ws:${hash(credential)}`, 120);
            let input; try { input = JSON.parse(bytes.toString()); } catch { throw new Fault(400, 'Invalid JSON.'); }
            requireThat(input && typeof input === 'object' && !Array.isArray(input) && input.type === 'action', 'Unknown message.');
            const room = store.get(code), identity = store.authenticate(room, credential);
            const id = store.action(room, identity, input); ws.send(JSON.stringify({ type: 'accepted', id })); broadcast(code);
          } catch (error) {
            if (error.status === 401 || error.status === 404) ws.close(4001, 'Session ended.');
            else if (error.status === 429) ws.close(1008, 'Too many actions.');
            else ws.send(JSON.stringify({ type: 'error', error: error instanceof Fault ? error.message : 'Invalid request.' }));
          }
        });
      });
    } catch (error) {
      const status = error instanceof Fault ? error.status : 400;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  const tick = setInterval(() => {
    for (const client of clients) sendState(client);
    for (const [key, bucket] of buckets) if (Date.now() - bucket.start > 60_000) buckets.delete(key);
  }, 2000); tick.unref();
  const heartbeat = setInterval(() => {
    for (const client of clients) { if (!client.alive) client.socket.terminate(); else { client.alive = false; client.socket.ping(); } }
  }, 30_000); heartbeat.unref();
  return {
    server, store,
    async close() {
      clearInterval(tick); clearInterval(heartbeat);
      for (const client of clients) client.socket.terminate();
      await new Promise(resolve => sockets.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await store.writeQueue;
    }
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireThat(process.env.NODE_ENV !== 'production' || !!process.env.PUBLIC_ORIGIN, 'Set PUBLIC_ORIGIN for production hosting.', 500);
    const app = await createApp();
    const port = Number(process.env.PORT || 3001), host = process.env.HOST || '127.0.0.1';
    app.server.listen(port, host, () => console.log(`Ambulator listening on ${host}:${port}`));
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); });
  } catch (error) { console.error(error.code === 'ENOENT' ? 'Host key is missing. Run npm run setup first.' : error.message); process.exit(1); }
}
