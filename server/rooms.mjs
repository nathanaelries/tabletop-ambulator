import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export const COLORS = ['White', 'Brown', 'Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink'];
export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const matches = (value, expected) => typeof value === 'string' && typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(expected, 'hex'));
export class Fault extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireThat(ok, message = 'Invalid request.', status = 400) { if (!ok) throw new Fault(status, message); }
const codePattern = /^[A-HJ-NP-Z2-9]{6}$/;
const guidPattern = /^[a-f0-9]{6}$/;
const own = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value, maximum) => Array.isArray(value) && value.length <= maximum;
// TTS's Lua JSON encoder can represent an empty table as either [] or {}.
const luaList = value => record(value) && Object.keys(value).length === 0 ? [] : value;
const cleanName = (value, max = 48) => {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), 'Use a short, nonempty name.');
  return value.trim();
};
const defaultZones = () => ({ '1': { label: 'Train cards', play: false }, '2': { label: 'Destination tickets', play: false } });

export class Rooms {
  constructor({ dataDir, ttlMs = 48 * 3600_000, maxRooms = 100, assetHosts = ['steamusercontent.com', '*.steamusercontent.com', 'steamusercontent-a.akamaihd.net', 'i.imgur.com', 'raw.githubusercontent.com'] }) {
    this.dataDir = dataDir; this.ttlMs = ttlMs; this.maxRooms = maxRooms;
    requireThat(Number.isFinite(ttlMs) && ttlMs >= 60_000 && ttlMs <= 30 * 24 * 3600_000 && Number.isInteger(maxRooms) && maxRooms >= 1 && maxRooms <= 10_000, 'Invalid room limits.', 500);
    this.assetHosts = assetHosts; this.rooms = new Map(); this.writeQueue = Promise.resolve();
  }
  async load() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    let source;
    try { source = JSON.parse(await readFile(join(this.dataDir, 'rooms.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('Room storage could not be read; refusing to start.', { cause: error }); }
    requireThat(source.version === 1 && list(source.rooms, this.maxRooms), 'Invalid room storage.', 500);
    for (const saved of source.rooms) {
      requireThat(record(saved) && codePattern.test(saved.code) && /^[a-f0-9]{64}$/.test(saved.hostHash) && list(saved.players, 10) && Number.isFinite(saved.expiresAt), 'Invalid room storage.', 500);
      if (saved.expiresAt <= Date.now()) continue;
      this.rooms.set(saved.code, { ...saved, hands: {}, decks: [], commands: [], bridgeSession: null, sequence: 0, bridgeSeenAt: 0 });
    }
  }
  persist() {
    // Never persist hands, deck contents, command queues, or plaintext credentials.
    const rooms = [...this.rooms.values()].map(({ hands, decks, commands, bridgeSession, sequence, bridgeSeenAt, ...saved }) => saved);
    const body = JSON.stringify({ version: 1, rooms });
    const write = this.writeQueue.then(async () => {
      const temporary = join(this.dataDir, 'rooms.json.tmp');
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, join(this.dataDir, 'rooms.json'));
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }
  get(code) {
    const room = codePattern.test(code) ? this.rooms.get(code) : null;
    requireThat(room && room.expiresAt > Date.now(), 'Room not found or expired.', 404);
    return room;
  }
  authenticate(room, credential) {
    if (matches(credential, room.hostHash)) return { role: 'host' };
    const player = room.players.find(p => matches(credential, p.tokenHash));
    requireThat(player, 'Your session has ended. Join again or ask the host.', 401);
    return { role: 'player', player };
  }
  create() {
    for (const [code, room] of this.rooms) if (room.expiresAt <= Date.now()) this.rooms.delete(code);
    requireThat(this.rooms.size < this.maxRooms, 'The server has reached its room limit.', 503);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from(randomBytes(6), byte => alphabet[byte % alphabet.length]).join(''); } while (this.rooms.has(code));
    const credential = token();
    const room = { code, createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs, hostHash: hash(credential), bridgeHash: null, locked: false, players: [], zones: defaultZones(), enabledDecks: {}, hands: {}, decks: [], commands: [], bridgeSession: null, sequence: 0, bridgeSeenAt: 0 };
    this.rooms.set(code, room); return { room, credential };
  }
  join(room, name) {
    requireThat(!room.locked, 'This room is locked. Ask the host to open it.', 403);
    requireThat(room.players.length < 10, 'This room is full.', 409);
    const credential = token();
    const player = { id: randomUUID(), name: cleanName(name), tokenHash: hash(credential), color: null, requestedColor: null };
    room.players.push(player); return { player, credential };
  }
  host(identity) { requireThat(identity.role === 'host', 'Host access required.', 403); }
  requestSeat(room, identity, color) {
    requireThat(identity.role === 'player', 'Player access required.', 403);
    requireThat(COLORS.includes(color) && own(room.hands, color), 'That seat is not available. Connect TTS first.');
    requireThat(!room.players.some(p => p.id !== identity.player.id && p.color === color), 'That seat is already assigned.', 409);
    identity.player.requestedColor = color;
  }
  assign(room, identity, id, color) {
    this.host(identity);
    const player = room.players.find(p => p.id === id);
    requireThat(player, 'Player not found.', 404);
    requireThat(color === null || (COLORS.includes(color) && own(room.hands, color)), 'That seat is not available.');
    requireThat(color === null || !room.players.some(p => p.id !== id && p.color === color), 'That seat is already assigned.', 409);
    room.commands = room.commands.filter(c => c.playerId !== id);
    player.color = color; player.requestedColor = null;
  }
  remove(room, identity, id) {
    this.host(identity); requireThat(room.players.some(p => p.id === id), 'Player not found.', 404);
    room.players = room.players.filter(p => p.id !== id); room.commands = room.commands.filter(c => c.playerId !== id);
  }
  rotateBridge(room, identity) {
    this.host(identity); const credential = token(); room.bridgeHash = hash(credential);
    this.clearBridge(room); return credential;
  }
  clearBridge(room) { room.hands = {}; room.decks = []; room.commands = []; room.bridgeSession = null; room.sequence = 0; room.bridgeSeenAt = 0; }
  connectBridge(room, credential) {
    requireThat(matches(credential, room.bridgeHash), 'TTS authentication failed.', 401);
    this.clearBridge(room); room.bridgeSession = token(); return room.bridgeSession;
  }
  asset(value) {
    if (value === undefined || value === null || value === '') return null;
    requireThat(typeof value === 'string' && value.length <= 2048, 'Invalid card image.');
    let url; try { url = new URL(value); } catch { throw new Fault(400, 'Invalid card image URL.'); }
    requireThat(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443'), 'Card images must use HTTPS.');
    const host = url.hostname.toLowerCase();
    requireThat(this.assetHosts.some(allowed => allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) && host !== allowed.slice(2) : host === allowed), `Card image host is not allowed: ${host}`);
    return url.href;
  }
  sync(room, credential, body) {
    requireThat(matches(credential, room.bridgeHash), 'TTS authentication failed.', 401);
    requireThat(body.session === room.bridgeSession && room.bridgeSession !== null, 'Reconnect the TTS object.', 409);
    requireThat(Number.isSafeInteger(body.sequence) && body.sequence > room.sequence, 'Outdated TTS update.', 409);
    if (Array.isArray(body.hands) && body.hands.length === 0) body.hands = {};
    body.decks = luaList(body.decks); body.acks = luaList(body.acks);
    requireThat(record(body.hands) && Object.keys(body.hands).length <= 10 && list(body.decks, 100) && list(body.acks, 100), 'Invalid TTS snapshot.');
    const hands = {}, guids = new Set();
    for (const [color, zones] of Object.entries(body.hands)) {
      const zoneList = luaList(zones);
      requireThat(COLORS.includes(color) && list(zoneList, 8), 'Invalid hand zones.');
      const indexes = new Set();
      hands[color] = zoneList.map(zone => {
        if (record(zone)) zone.cards = luaList(zone.cards);
        requireThat(record(zone) && Number.isInteger(zone.index) && zone.index >= 1 && zone.index <= 8 && !indexes.has(zone.index) && list(zone.cards, 300), 'Invalid hand zone.');
        indexes.add(zone.index);
        return { index: zone.index, cards: zone.cards.map(card => {
          requireThat(record(card) && typeof card.guid === 'string' && guidPattern.test(card.guid) && !guids.has(card.guid), 'Invalid or duplicate card.');
          guids.add(card.guid);
          const columns = card.columns ?? 1, rows = card.rows ?? 1, offset = card.offset ?? 0;
          requireThat(Number.isInteger(columns) && columns >= 1 && columns <= 100 && Number.isInteger(rows) && rows >= 1 && rows <= 100 && Number.isInteger(offset) && offset >= 0 && offset < columns * rows, 'Invalid card sheet.');
          return { guid: card.guid, name: cleanName(card.name || 'Card', 120), face: this.asset(card.face), columns, rows, offset };
        }) };
      });
    }
    const deckIds = new Set();
    const decks = body.decks.map(deck => {
      requireThat(record(deck) && typeof deck.guid === 'string' && guidPattern.test(deck.guid) && !guids.has(deck.guid) && !deckIds.has(deck.guid), 'Invalid or duplicate deck.');
      deckIds.add(deck.guid); return { guid: deck.guid, name: cleanName(deck.name || 'Deck', 120) };
    });
    requireThat(body.acks.every(id => typeof id === 'string' && id.length <= 64), 'Invalid acknowledgements.');
    room.hands = hands; room.decks = decks; room.sequence = body.sequence; room.bridgeSeenAt = Date.now();
    const acks = new Set(body.acks);
    room.commands = room.commands.filter(command => !acks.has(command.id) && Date.now() - command.createdAt < 15_000 && this.commandAllowed(room, command));
    return { commands: room.commands.map(({ playerId, createdAt, ...command }) => command), seats: room.players.filter(p => p.color).map(p => p.color), zones: room.zones, enabledDecks: room.enabledDecks };
  }
  card(room, color, zone, guid) { return room.hands[color]?.find(z => z.index === zone)?.cards.find(card => card.guid === guid); }
  commandAllowed(room, command) {
    if (!room.players.some(p => p.id === command.playerId && p.color === command.color)) return false;
    if (command.kind === 'draw') return room.enabledDecks[command.guid] === command.zone && room.decks.some(d => d.guid === command.guid) && room.hands[command.color]?.some(z => z.index === command.zone);
    return !!this.card(room, command.color, command.zone, command.guid) && (command.kind !== 'play' || room.zones[command.zone]?.play === true);
  }
  action(room, identity, body) {
    requireThat(identity.role === 'player' && identity.player.color, 'Ask the host to approve your seat first.', 403);
    requireThat(Date.now() - room.bridgeSeenAt < 10_000 && room.bridgeSession, 'TTS is disconnected. Try again once it reconnects.', 409);
    requireThat(body.kind !== 'highlight', 'Private cards cannot be highlighted on the shared screen.', 403);
    requireThat(['play', 'draw'].includes(body.kind) && typeof body.guid === 'string' && guidPattern.test(body.guid) && Number.isInteger(body.zone) && body.zone >= 1 && body.zone <= 8, 'Invalid card action.');
    requireThat(!own(body, 'color') && !own(body, 'gameCode') && !own(body, 'playerId'), 'The server chooses your seat.', 403);
    const command = { id: randomUUID(), playerId: identity.player.id, color: identity.player.color, kind: body.kind, guid: body.guid, zone: body.zone, createdAt: Date.now() };
    requireThat(this.commandAllowed(room, command), 'That action is not permitted for your hand.', 403);
    requireThat(room.commands.length < 100, 'Too many pending actions.', 429);
    requireThat(!room.commands.some(c => c.playerId === command.playerId && c.guid === command.guid && c.kind === command.kind), 'That action is already pending.', 409);
    room.commands.push(command); return command.id;
  }
  configure(room, identity, body) {
    this.host(identity);
    requireThat(record(body.zones) && Object.keys(body.zones).length <= 8 && record(body.enabledDecks) && Object.keys(body.enabledDecks).length <= 100, 'Invalid settings.');
    const zones = {}, enabledDecks = {};
    for (const [index, zone] of Object.entries(body.zones)) {
      requireThat(/^[1-8]$/.test(index) && record(zone) && typeof zone.play === 'boolean', 'Invalid zone settings.');
      zones[index] = { label: cleanName(zone.label), play: zone.play };
    }
    for (const [guid, zone] of Object.entries(body.enabledDecks)) {
      requireThat(guidPattern.test(guid) && Number.isInteger(zone) && own(zones, zone) && room.decks.some(d => d.guid === guid), 'Invalid draw deck.');
      enabledDecks[guid] = zone;
    }
    room.zones = zones; room.enabledDecks = enabledDecks;
    room.commands = room.commands.filter(command => this.commandAllowed(room, command));
  }
  view(room, identity) {
    const state = {
      code: room.code, role: identity.role, locked: room.locked, expiresAt: room.expiresAt,
      connected: !!room.bridgeSession && Date.now() - room.bridgeSeenAt < 10_000,
      players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, ...(identity.role === 'host' ? { requestedColor: p.requestedColor } : {}) })),
      seats: Object.keys(room.hands), zones: room.zones
    };
    if (identity.role === 'host') {
      state.handZones = Object.fromEntries(Object.entries(room.hands).map(([color, zones]) => [color, zones.map(z => ({ index: z.index, count: z.cards.length }))]));
      state.decks = room.decks; state.enabledDecks = room.enabledDecks;
    } else {
      state.me = { id: identity.player.id, name: identity.player.name, color: identity.player.color, requestedColor: identity.player.requestedColor };
      state.hands = identity.player.color ? room.hands[identity.player.color] || [] : [];
      state.decks = room.decks.filter(d => own(room.enabledDecks, d.guid)).map(d => ({ ...d, zone: room.enabledDecks[d.guid] }));
      state.pending = room.commands.filter(c => c.playerId === identity.player.id).map(c => ({ id: c.id, guid: c.guid, kind: c.kind }));
    }
    return state;
  }
}
