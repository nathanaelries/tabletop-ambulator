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
const controlPattern = /^(?:global|[a-f0-9]{6}):[0-9]{1,3}$/;
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
      this.rooms.set(saved.code, { ...saved, enabledTargets: saved.enabledTargets || {}, enabledButtons: saved.enabledButtons || {}, hands: {}, decks: [], targets: [], buttons: [], commands: [], bridgeSession: null, sequence: 0, bridgeSeenAt: 0 });
    }
  }
  persist() {
    // Never persist hands, deck contents, command queues, or plaintext credentials.
    const rooms = [...this.rooms.values()].map(({ hands, decks, targets, buttons, commands, bridgeSession, sequence, bridgeSeenAt, ...saved }) => saved);
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
    const room = { code, createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs, hostHash: hash(credential), bridgeHash: null, locked: false, players: [], zones: defaultZones(), enabledDecks: {}, enabledTargets: {}, enabledButtons: {}, hands: {}, decks: [], targets: [], buttons: [], commands: [], bridgeSession: null, sequence: 0, bridgeSeenAt: 0 };
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
  clearBridge(room) { room.hands = {}; room.decks = []; room.targets = []; room.buttons = []; room.commands = []; room.bridgeSession = null; room.sequence = 0; room.bridgeSeenAt = 0; }
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
  controls(value, buttons = false) {
    const items = luaList(value ?? []), ids = new Set();
    requireThat(list(items, 100), 'Invalid table controls.');
    return items.map(item => {
      requireThat(record(item) && typeof item.id === 'string' && controlPattern.test(item.id) && !ids.has(item.id) && typeof item.signature === 'string' && item.signature.length > 0 && item.signature.length <= 512, 'Invalid table control.');
      ids.add(item.id);
      const colors = luaList(item.colors ?? []);
      requireThat(list(colors, 10) && new Set(colors).size === colors.length && colors.every(c => COLORS.includes(c)), 'Invalid control colors.');
      return { id: item.id, label: cleanName(item.label, 120), signature: item.signature, colors, ...(buttons ? { ready: item.ready === true } : {}) };
    });
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
    const targets = this.controls(body.targets), buttons = this.controls(body.buttons, true);
    requireThat(body.acks.every(id => typeof id === 'string' && id.length <= 64), 'Invalid acknowledgements.');
    room.hands = hands; room.decks = decks; room.targets = targets; room.buttons = buttons; room.sequence = body.sequence; room.bridgeSeenAt = Date.now();
    const acks = new Set(body.acks);
    room.commands = room.commands.filter(command => !acks.has(command.id) && Date.now() - command.createdAt < 15_000 && this.commandAllowed(room, command));
    return { commands: room.commands.map(({ playerId, createdAt, ...command }) => command), seats: room.players.filter(p => p.color).map(p => p.color), zones: room.zones, enabledDecks: room.enabledDecks, enabledTargets: room.enabledTargets, enabledButtons: room.enabledButtons };
  }
  card(room, color, zone, guid) { return room.hands[color]?.find(z => z.index === zone)?.cards.find(card => card.guid === guid); }
  commandAllowed(room, command) {
    if (!room.players.some(p => p.id === command.playerId && p.color === command.color)) return false;
    if (command.kind === 'draw') return room.enabledDecks[command.guid] === command.zone && room.decks.some(d => d.guid === command.guid) && room.hands[command.color]?.some(z => z.index === command.zone);
    if (command.kind === 'button') {
      const button = room.buttons.find(b => b.id === command.buttonId), permission = room.enabledButtons[command.buttonId];
      return !!button?.ready && permission?.signature === button.signature && command.signature === button.signature && permission.colors.includes(command.color) && (!button.colors.length || button.colors.includes(command.color));
    }
    if (!command.guids?.every(guid => this.card(room, command.color, command.zone, guid))) return false;
    if (command.kind === 'play') return room.zones[command.zone]?.play === true;
    if (command.kind === 'place') {
      const target = room.targets.find(d => d.id === command.targetId), permission = room.enabledTargets[command.targetId];
      return !!target && permission?.zone === command.zone && permission.signature === target.signature && command.signature === target.signature && permission.faceDown === command.faceDown && (!target.colors.length || target.colors.includes(command.color));
    }
    return false;
  }
  action(room, identity, body) {
    requireThat(identity.role === 'player' && identity.player.color, 'Ask the host to approve your seat first.', 403);
    requireThat(Date.now() - room.bridgeSeenAt < 10_000 && room.bridgeSession, 'TTS is disconnected. Try again once it reconnects.', 409);
    requireThat(body.kind !== 'highlight', 'Private cards cannot be highlighted on the shared screen.', 403);
    requireThat(['play', 'draw', 'place', 'button'].includes(body.kind), 'Invalid card action.');
    requireThat(!['color', 'gameCode', 'playerId', 'position', 'rotation', 'faceDown', 'signature', 'callback', 'script'].some(key => own(body, key)), 'The host and server choose action permissions.', 403);
    const command = { id: randomUUID(), playerId: identity.player.id, color: identity.player.color, kind: body.kind, createdAt: Date.now() };
    if (body.kind === 'button') {
      requireThat(typeof body.buttonId === 'string' && controlPattern.test(body.buttonId), 'Invalid button.');
      command.buttonId = body.buttonId; command.signature = room.buttons.find(b => b.id === body.buttonId)?.signature;
    } else {
      requireThat(Number.isInteger(body.zone) && body.zone >= 1 && body.zone <= 8, 'Invalid hand.');
      command.zone = body.zone;
      if (body.kind === 'draw') {
        requireThat(typeof body.guid === 'string' && guidPattern.test(body.guid) && !own(body, 'guids'), 'Invalid draw.'); command.guid = body.guid;
      } else {
        requireThat(!(own(body, 'guid') && own(body, 'guids')), 'Send one card or a batch.');
        const guids = own(body, 'guids') ? body.guids : [body.guid];
        requireThat(list(guids, 30) && guids.length > 0 && guids.every(guid => typeof guid === 'string' && guidPattern.test(guid)) && new Set(guids).size === guids.length, 'Select 1–30 different cards.');
        command.guids = guids; if (guids.length === 1) command.guid = guids[0];
        if (body.kind === 'place') {
          requireThat(typeof body.targetId === 'string' && controlPattern.test(body.targetId), 'Invalid destination.');
          command.targetId = body.targetId; command.signature = room.targets.find(d => d.id === body.targetId)?.signature;
          command.faceDown = room.enabledTargets[body.targetId]?.faceDown;
        }
      }
    }
    requireThat(this.commandAllowed(room, command), 'That action is not permitted for your hand.', 403);
    requireThat(room.commands.length < 100, 'Too many pending actions.', 429);
    requireThat(!room.commands.some(c => c.playerId === command.playerId && (
      command.guids ? c.guids?.some(guid => command.guids.includes(guid)) :
      command.kind === 'button' ? c.buttonId === command.buttonId : c.kind === 'draw' && c.guid === command.guid
    )), 'That action is already pending.', 409);
    room.commands.push(command); return command.id;
  }
  configure(room, identity, body) {
    this.host(identity);
    requireThat(record(body.zones) && Object.keys(body.zones).length <= 8 && record(body.enabledDecks) && Object.keys(body.enabledDecks).length <= 100, 'Invalid settings.');
    const zones = {}, enabledDecks = {}, enabledTargets = {}, enabledButtons = {};
    requireThat(record(body.enabledTargets ?? {}) && Object.keys(body.enabledTargets ?? {}).length <= 100 && record(body.enabledButtons ?? {}) && Object.keys(body.enabledButtons ?? {}).length <= 100, 'Invalid control settings.');
    for (const [index, zone] of Object.entries(body.zones)) {
      requireThat(/^[1-8]$/.test(index) && record(zone) && typeof zone.play === 'boolean', 'Invalid zone settings.');
      zones[index] = { label: cleanName(zone.label), play: zone.play };
    }
    for (const [guid, zone] of Object.entries(body.enabledDecks)) {
      requireThat(guidPattern.test(guid) && Number.isInteger(zone) && own(zones, zone) && room.decks.some(d => d.guid === guid), 'Invalid draw deck.');
      enabledDecks[guid] = zone;
    }
    for (const [id, setting] of Object.entries(body.enabledTargets ?? {})) {
      const target = room.targets.find(d => d.id === id);
      requireThat(controlPattern.test(id) && target && record(setting) && Number.isInteger(setting.zone) && own(zones, setting.zone) && typeof setting.faceDown === 'boolean', 'Invalid destination settings.');
      enabledTargets[id] = { zone: setting.zone, faceDown: setting.faceDown, signature: target.signature };
    }
    for (const [id, setting] of Object.entries(body.enabledButtons ?? {})) {
      const button = room.buttons.find(b => b.id === id), colors = setting?.colors;
      requireThat(controlPattern.test(id) && button?.ready && record(setting) && list(colors, 10) && colors.length > 0 && new Set(colors).size === colors.length && colors.every(c => COLORS.includes(c) && (!button.colors.length || button.colors.includes(c))), 'Invalid button settings; install its callback adapter first.');
      enabledButtons[id] = { colors, label: cleanName(setting.label || button.label, 120), signature: button.signature };
    }
    room.zones = zones; room.enabledDecks = enabledDecks; room.enabledTargets = enabledTargets; room.enabledButtons = enabledButtons;
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
      state.targets = room.targets; state.buttons = room.buttons; state.enabledTargets = room.enabledTargets; state.enabledButtons = room.enabledButtons;
    } else {
      state.me = { id: identity.player.id, name: identity.player.name, color: identity.player.color, requestedColor: identity.player.requestedColor };
      state.hands = identity.player.color ? room.hands[identity.player.color] || [] : [];
      state.decks = room.decks.filter(d => own(room.enabledDecks, d.guid)).map(d => ({ ...d, zone: room.enabledDecks[d.guid] }));
      state.targets = room.targets.filter(d => room.enabledTargets[d.id]?.signature === d.signature && (!d.colors.length || d.colors.includes(identity.player.color))).map(d => ({ id: d.id, label: d.label, zone: room.enabledTargets[d.id].zone, faceDown: room.enabledTargets[d.id].faceDown }));
      state.buttons = room.buttons.filter(b => b.ready && room.enabledButtons[b.id]?.signature === b.signature && room.enabledButtons[b.id].colors.includes(identity.player.color) && (!b.colors.length || b.colors.includes(identity.player.color))).map(b => ({ id: b.id, label: room.enabledButtons[b.id].label || b.label }));
      state.pending = room.commands.filter(c => c.playerId === identity.player.id).map(c => ({ id: c.id, guid: c.guid, guids: c.guids, buttonId: c.buttonId, kind: c.kind }));
    }
    return state;
  }
}
