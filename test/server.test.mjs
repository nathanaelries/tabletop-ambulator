import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.mjs';
import { HOST_KEY, snapshot } from './fixtures.mjs';

async function fixture(t, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ambulator-test-'));
  let app = await createApp({ dataDir: directory, hostKey: HOST_KEY, ...settings });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(path, data, cookie = '', extra = {}) {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: settings.publicOrigin || base }), ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  const created = await request('/api/rooms', { hostKey: HOST_KEY }); assert.equal(created.status, 201);
  const code = created.data.code, path = `/api/rooms/${code}`, host = created.cookie;
  const object = await request(path + '/object', {}, host);
  const bridgeToken = /local credential = '([^']+)'/.exec(object.data.script)[1];
  const bridgeHeaders = { Authorization: `Bearer ${bridgeToken}` };
  const connected = await request(path + '/bridge/connect', {}, '', bridgeHeaders);
  let session = connected.data.session, sequence = 0;
  const sync = (data = snapshot(), credential = bridgeToken) => request(path + '/bridge/sync', { ...data, session, sequence: ++sequence }, '', { Authorization: `Bearer ${credential}` });
  assert.equal((await sync()).status, 200);
  assert.equal((await request(path + '/configure', { zones: { 1: { label: 'Train cards', play: true }, 2: { label: 'Destination tickets', play: false } }, enabledDecks: {} }, host)).status, 200);
  async function player(name, color) {
    const joined = await request(path + '/join', { name }); assert.equal(joined.status, 201);
    const state = await request(path, undefined, joined.cookie);
    if (color) { assert.equal((await request(path + '/seat', { color }, joined.cookie)).status, 200); assert.equal((await request(path + '/assign', { id: state.data.me.id, color }, host)).status, 200); }
    return { cookie: joined.cookie, id: state.data.me.id };
  }
  return { get app() { return app; }, get base() { return base; }, directory, code, path, host, bridgeToken, bridgeHeaders, object, request, player, sync,
    async restart() {
      await app.close(); app = await createApp({ dataDir: directory, hostKey: HOST_KEY, ...settings }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
      const reconnect = await request(path + '/bridge/connect', {}, '', bridgeHeaders); session = reconnect.data.session; sequence = 0;
    }
  };
}

test('HTTP views include only the approved player’s two hands and no credential hashes', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red'), blue = await f.player('Bo', 'Blue'), waiting = await f.player('Waiting');
  const redView = await f.request(f.path, undefined, red.cookie), blueView = await f.request(f.path, undefined, blue.cookie);
  assert.deepEqual(redView.data.hands.map(z => z.index), [1, 2]);
  assert.ok(JSON.stringify(redView.data).includes('Red destination'));
  assert.ok(!JSON.stringify(redView.data).includes('Blue destination'));
  assert.ok(!JSON.stringify(blueView.data).includes('a00001'));
  assert.deepEqual((await f.request(f.path, undefined, waiting.cookie)).data.hands, []);
  for (const cookie of [red.cookie, blue.cookie, f.host]) {
    const value = JSON.stringify((await f.request(f.path, undefined, cookie)).data);
    assert.ok(!/tokenHash|hostHash|bridgeHash|bridgeSession/.test(value)); assert.ok(!value.includes(f.bridgeToken));
  }
  assert.equal((await f.request(f.path)).status, 401);
});

test('seat requests need host approval; seat ownership is exclusive and host routes are protected', async t => {
  const f = await fixture(t), p = await f.player('Ada'), other = await f.player('Bo', 'Blue');
  assert.equal((await f.request(f.path + '/seat', { color: 'Red' }, p.cookie)).status, 200);
  assert.deepEqual((await f.request(f.path, undefined, p.cookie)).data.hands, []);
  for (const [route, body] of [['assign', { id: p.id, color: 'Red' }], ['remove', { id: other.id }], ['lock', { locked: true }], ['object', {}], ['revoke-bridge', {}], ['close', {}], ['configure', { zones: {}, enabledDecks: {} }]]) assert.equal((await f.request(f.path + '/' + route, body, p.cookie)).status, 403, route);
  assert.equal((await f.request(f.path + '/seat', { color: 'Blue' }, p.cookie)).status, 409);
  assert.equal((await f.request(f.path + '/assign', { id: p.id, color: 'Blue' }, f.host)).status, 409);
  assert.equal((await f.request(f.path + '/assign', { id: p.id, color: 'Red' }, f.host)).status, 200);
  assert.equal((await f.request(f.path + '/join', { name: 'Overwrite' }, f.host)).status, 409);
});

test('cross-player, cross-zone, spoofed-color, disabled-play, and disabled-deck actions are denied', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  const attempts = [
    { kind: 'play', guid: 'b00001', zone: 1 }, { kind: 'highlight', guid: 'b00002', zone: 2 },
    { kind: 'play', guid: 'a00001', zone: 2 }, { kind: 'play', guid: 'a00002', zone: 2 },
    { kind: 'play', guid: 'a00001', zone: 1, color: 'Blue' }, { kind: 'draw', guid: 'd00001', zone: 1 }
  ];
  for (const attempt of attempts) assert.equal((await f.request(f.path + '/action', attempt, red.cookie)).status, 403);
  assert.equal((await f.request(f.path + '/action', { kind: 'highlight', guid: 'a00002', zone: 2 }, red.cookie)).status, 403);
  assert.equal((await f.request(f.path + '/action', { kind: 'play', guid: 'a00001', zone: 1 }, red.cookie)).status, 202);
  const pending = await f.sync(); assert.equal(pending.data.commands.length, 1); assert.equal(pending.data.commands[0].color, 'Red');
  assert.ok(!JSON.stringify(pending.data).includes(red.id));
  const acked = await f.sync({ ...snapshot(), acks: pending.data.commands.map(c => c.id) }); assert.deepEqual(acked.data.commands, []);
});

test('enabled decks can draw only into their configured hand', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  assert.equal((await f.request(f.path + '/configure', { zones: { 1: { label: 'Trains', play: true }, 2: { label: 'Tickets', play: false } }, enabledDecks: { d00002: 2 } }, f.host)).status, 200);
  assert.equal((await f.request(f.path + '/action', { kind: 'draw', guid: 'd00002', zone: 1 }, red.cookie)).status, 403);
  assert.equal((await f.request(f.path + '/action', { kind: 'draw', guid: 'd00002', zone: 2 }, red.cookie)).status, 202);
  assert.equal((await f.request(f.path + '/action', { kind: 'draw', guid: 'd00002', zone: 2 }, red.cookie)).status, 409);
  const commands = await f.sync(); assert.equal(commands.data.commands[0].zone, 2);
});

test('removal, reassignment, and ownership changes cancel queued commands', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  await f.request(f.path + '/action', { kind: 'play', guid: 'a00001', zone: 1 }, red.cookie);
  const moved = snapshot(); moved.hands.Red[0].cards = []; moved.hands.Blue[0].cards.push(snapshot().hands.Red[0].cards[0]);
  assert.deepEqual((await f.sync(moved)).data.commands, []);
  await f.sync(); await f.request(f.path + '/action', { kind: 'play', guid: 'a00001', zone: 1 }, red.cookie);
  await f.request(f.path + '/assign', { id: red.id, color: 'Blue' }, f.host); assert.deepEqual((await f.sync()).data.commands, []);
  await f.request(f.path + '/remove', { id: red.id }, f.host); assert.equal((await f.request(f.path, undefined, red.cookie)).status, 401);
});

test('TTS endpoints require their own credential; rotated credentials and replayed snapshots fail', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  for (const headers of [{}, { Authorization: 'Bearer ' + red.cookie.split('=')[1] }, { Authorization: 'Bearer ' + f.host.split('=')[1] }]) assert.equal((await f.request(f.path + '/bridge/connect', {}, '', headers)).status, 401);
  const session = f.app.store.get(f.code).bridgeSession;
  assert.equal((await f.request(f.path + '/bridge/sync', { ...snapshot(), session, sequence: 1 }, '', f.bridgeHeaders)).status, 409);
  await f.request(f.path + '/object', {}, f.host);
  assert.equal((await f.sync()).status, 401);
  assert.deepEqual((await f.request(f.path, undefined, red.cookie)).data.hands, []);
});

test('invalid snapshots and disallowed asset URLs leave the previous private state intact', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  for (const url of ['http://i.imgur.com/card.png', 'https://127.0.0.1/card.png', 'https://i.imgur.com.evil.test/card.png', 'https://user:password@i.imgur.com/card.png']) {
    const update = snapshot(); update.hands.Red[0].cards[0].face = url; assert.equal((await f.sync(update)).status, 400);
  }
  const duplicated = snapshot(); duplicated.hands.Blue[0].cards[0].guid = 'a00001'; assert.equal((await f.sync(duplicated)).status, 400);
  assert.equal((await f.request(f.path, undefined, red.cookie)).data.hands[0].cards[0].name, 'Red train');
  const empty = { hands: { Red: [{ index: 1, cards: {} }] }, decks: {}, acks: {} };
  assert.equal((await f.sync(empty)).status, 200); assert.deepEqual((await f.request(f.path, undefined, red.cookie)).data.hands[0].cards, []);
});

test('cross-origin and missing-origin writes are rejected, and sessions use secure HttpOnly cookies', async t => {
  const f = await fixture(t, { publicOrigin: 'https://games.example.test' });
  const key = f.host.split('=')[1];
  const response = await f.request('/api/rooms', { hostKey: HOST_KEY });
  assert.match(response.headers.get('set-cookie'), /HttpOnly/); assert.match(response.headers.get('set-cookie'), /Secure/); assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await f.request(f.path + '/lock', { locked: true }, f.host, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.request(f.path + '/lock', { locked: true }, f.host, { Origin: '' })).status, 403);
  assert.equal((await f.request(f.path, undefined, `amb_${f.code}=${key}; amb_${f.code}=${key}`)).status, 401);
});

test('WebSocket state is filtered and both websocket and HTTP actions enforce ownership', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  const socket = new WebSocket(f.base.replace('http:', 'ws:') + `/ws?room=${f.code}`, { headers: { Origin: f.base, Cookie: red.cookie } });
  t.after(() => socket.terminate());
  const [bytes] = await once(socket, 'message'), first = JSON.parse(bytes.toString());
  assert.ok(JSON.stringify(first).includes('Red destination')); assert.ok(!JSON.stringify(first).includes('b00002'));
  const rejected = once(socket, 'message'); socket.send(JSON.stringify({ type: 'action', kind: 'play', guid: 'b00001', zone: 1 }));
  assert.equal(JSON.parse((await rejected)[0].toString()).type, 'error');
  const revoked = once(socket, 'close'); await f.request(f.path + '/remove', { id: red.id }, f.host); assert.equal((await revoked)[0], 4001);
});

test('WebSocket handshakes require an allowed origin and an authenticated room session', async t => {
  const f = await fixture(t);
  for (const [headers, expected] of [[{ Origin: 'https://evil.test', Cookie: f.host }, 403], [{ Origin: f.base }, 401], [{ Origin: f.base, Cookie: f.host }, 404]]) {
    const code = expected === 404 ? 'ABC234' : f.code;
    const socket = new WebSocket(f.base.replace('http:', 'ws:') + `/ws?room=${code}`, { headers });
    socket.on('error', () => {});
    const response = await new Promise(resolve => socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); socket.terminate(); }));
    assert.equal(response, expected);
  }
});

test('room credentials and seats survive restart; private cards and queued actions do not persist', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  await f.request(f.path + '/action', { kind: 'play', guid: 'a00001', zone: 1 }, red.cookie);
  const disk = await readFile(join(f.directory, 'rooms.json'), 'utf8');
  assert.ok(!disk.includes('Red destination')); assert.ok(!disk.includes('a00001')); assert.ok(!disk.includes(f.bridgeToken)); assert.ok(!disk.includes(red.cookie.split('=')[1]));
  assert.equal((await stat(join(f.directory, 'rooms.json'))).mode & 0o777, 0o600);
  await f.restart();
  const restored = await f.request(f.path, undefined, red.cookie); assert.equal(restored.data.me.color, 'Red'); assert.deepEqual(restored.data.hands, []);
  assert.deepEqual((await f.sync()).data.commands, []); assert.equal((await f.request(f.path, undefined, red.cookie)).data.hands.length, 2);
});

test('locked and closed rooms reject new access and logout revokes a player', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  await f.request(f.path + '/lock', { locked: true }, f.host); assert.equal((await f.request(f.path + '/join', { name: 'Late' })).status, 403);
  await f.request(f.path + '/logout', {}, red.cookie); assert.equal((await f.request(f.path, undefined, red.cookie)).status, 401);
  await f.request(f.path + '/close', {}, f.host); assert.equal((await f.request(f.path, undefined, f.host)).status, 404); assert.equal((await f.sync()).status, 404);
});

test('legacy unprotected endpoints and image proxy are not exposed', async t => {
  const f = await fixture(t);
  for (const path of ['/create', '/hands', '/decks', '/highlights', '/card?url=http://127.0.0.1/', '/ambulator', '/upstream/server/server.js', '/lua/bridge.lua']) assert.equal((await f.request(path)).status, 404);
  const headers = (await fetch(f.base + '/')).headers;
  assert.match(headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(headers.get('cache-control'), 'no-store');
});

test('expiry invalidates HTTP access and closes existing WebSocket sessions', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  const socket = new WebSocket(f.base.replace('http:', 'ws:') + `/ws?room=${f.code}`, { headers: { Origin: f.base, Cookie: red.cookie } });
  t.after(() => socket.terminate()); await once(socket, 'message');
  const closed = once(socket, 'close'); f.app.store.get(f.code).expiresAt = Date.now() - 1;
  assert.equal((await f.request(f.path, undefined, red.cookie)).status, 404); assert.equal((await closed)[0], 4001);
});

test('credentials cannot cross rooms and disconnected tables reject actions', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  const other = await f.request('/api/rooms', { hostKey: HOST_KEY });
  const otherCode = other.data.code;
  assert.equal((await f.request(`/api/rooms/${otherCode}`, undefined, `amb_${otherCode}=${red.cookie.split('=')[1]}`)).status, 401);
  f.app.store.get(f.code).bridgeSeenAt = Date.now() - 11_000;
  assert.equal((await f.request(f.path + '/action', { kind: 'play', guid: 'a00001', zone: 1 }, red.cookie)).status, 409);
});

test('expired commands and commands disabled after enqueue are removed before TTS receives them', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  await f.request(f.path + '/action', { kind: 'play', guid: 'a00001', zone: 1 }, red.cookie);
  f.app.store.get(f.code).commands[0].createdAt = Date.now() - 16_000;
  assert.deepEqual((await f.sync()).data.commands, []);
  await f.request(f.path + '/action', { kind: 'play', guid: 'a00001', zone: 1 }, red.cookie);
  await f.request(f.path + '/configure', { zones: { 1: { label: 'Trains', play: false } }, enabledDecks: {} }, f.host);
  assert.deepEqual((await f.sync()).data.commands, []);
});

test('invalid WebSocket messages are rejected and action flooding closes the connection', async t => {
  const f = await fixture(t), red = await f.player('Ada', 'Red');
  const socket = new WebSocket(f.base.replace('http:', 'ws:') + `/ws?room=${f.code}`, { headers: { Origin: f.base, Cookie: red.cookie } });
  t.after(() => socket.terminate()); await once(socket, 'message');
  const error = once(socket, 'message'); socket.send('{malformed'); assert.equal(JSON.parse((await error)[0].toString()).type, 'error');
  const closed = once(socket, 'close');
  for (let i = 0; i < 125; i++) socket.send(JSON.stringify({ type: 'unknown' }));
  assert.equal((await closed)[0], 1008);
});

test('a failed snapshot write stops access instead of exposing an unpersisted room', async t => {
  const f = await fixture(t);
  const save = f.app.store.persist;
  f.app.store.persist = async () => { throw new Error('Disk unavailable'); };
  assert.equal((await f.request(f.path + '/lock', { locked: true }, f.host)).status, 503);
  assert.equal((await f.request(f.path, undefined, f.host)).status, 503);
  assert.equal((await f.request('/healthz')).status, 503);
  f.app.store.persist = save;
});
