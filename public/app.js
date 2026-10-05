const $ = id => document.getElementById(id);
let code = new URL(location.href).searchParams.get('room') || '', state = null, socket = null, retry = 500, retryTimer, noticeTimer;
let activeZone = 1, selectedCard = null, lastPlayers = '', lastSettings = '', generatedScript = '', live = false;
let selecting = false, selection = new Set(), selectionColor = null;
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
function notify(message) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000); }
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) { const error = new Error(result.error || 'Something went wrong.'); error.status = response.status; throw error; } return result;
}
const route = (action, data) => api(`/api/rooms/${code}/${action}`, data);
async function run(action) { try { await action(); } catch (error) { notify(error.message); } }
function confirmAction(title, text) {
  $('confirm-title').textContent = title; $('confirm-text').textContent = text; $('confirm-dialog').showModal();
  return new Promise(resolve => {
    const finish = result => { $('confirm-dialog').close(); $('accept-confirm').onclick = null; $('cancel-confirm').onclick = null; $('confirm-dialog').onclose = null; resolve(result); };
    $('accept-confirm').onclick = () => finish(true); $('cancel-confirm').onclick = () => finish(false); $('confirm-dialog').onclose = () => finish(false);
  });
}
function home() {
  code = ''; state = null; live = false; clearTimeout(retryTimer); if (socket) { socket.onclose = null; socket.close(); socket = null; }
  $('room').hidden = true; $('home').hidden = false; $('card-dialog').close(); generatedScript = ''; $('copy-script').disabled = true;
  history.replaceState({}, '', '/'); lastPlayers = ''; lastSettings = ''; settingsDirty = false; selectedCard = null; selection.clear(); selecting = false;
}
function connect() {
  if (!code) return;
  const roomCode = code;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?room=${code}`);
  socket.onopen = () => { retry = 500; };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') { state = message.state; live = true; render(); }
    else if (message.type === 'error') notify(message.error);
  };
  socket.onclose = event => {
    if (code !== roomCode) return;
    live = false; if (state) render();
    if (event.code === 4001) { home(); notify('Your session ended. Join again or ask the host.'); return; }
    retryTimer = setTimeout(async () => {
      try { await api(`/api/rooms/${roomCode}`); if (code === roomCode) connect(); }
      catch (error) { if (error.status === 401 || error.status === 404) { home(); notify(error.message); } else if (code === roomCode) connect(); }
    }, retry); retry = Math.min(retry * 2, 10_000);
  };
  socket.onerror = () => {};
}
async function enter(roomCode) {
  code = roomCode; history.replaceState({}, '', `/?room=${code}`); state = await api(`/api/rooms/${code}`);
  lastPlayers = ''; lastSettings = ''; settingsDirty = false; activeZone = 1; selection.clear(); selecting = false; generatedScript = ''; $('copy-script').disabled = true; live = false; render(); connect();
}
function option(value, text, selected = false) { const node = element('option', text); node.value = value; node.selected = selected; return node; }
function render() {
  if (!state) return;
  $('home').hidden = true; $('room').hidden = false; $('code-display').textContent = code;
  const host = state.role === 'host'; $('host-view').hidden = !host; $('player-view').hidden = host;
  $('room-subtitle').textContent = host ? 'HOST DESK' : 'YOUR TABLE'; $('room-title').textContent = host ? 'Gather your crew.' : `Hi, ${state.me.name}.`;
  $('connection-dot').className = live && state.connected ? 'live' : '';
  $('connection-text').textContent = !live ? 'Reconnecting…' : state.connected ? 'Table connected' : 'Waiting for Tabletop Simulator';
  $('seat-status').textContent = host ? `${state.players.length} player${state.players.length === 1 ? '' : 's'} · ${state.locked ? 'Room locked' : 'Room open'}` : state.me.color ? `${state.me.color} seat` : 'Waiting for a seat';
  if (host) renderHost(); else renderPlayer();
  if (selectedCard && $('card-dialog').open) renderCardDialog();
}
function renderHost() {
  $('lock-room').textContent = state.locked ? 'Open room to new players' : 'Lock room'; $('lock-room').disabled = !live;
  const key = JSON.stringify([state.players, state.seats, live]);
  if (key !== lastPlayers) {
    lastPlayers = key; $('players').replaceChildren();
    if (!state.players.length) $('players').append(element('p', 'No players yet. Share the invite link to get started.', 'muted'));
    for (const player of state.players) {
      const row = element('div', undefined, 'player-row'); row.append(element('strong', player.name));
      const remove = element('button', 'Remove', 'text-button danger'); remove.disabled = !live;
      remove.onclick = () => run(async () => { if (await confirmAction('Remove player?', `${player.name} will lose access to their hand.`)) await route('remove', { id: player.id }); }); row.append(remove);
      row.append(element('span', player.color ? `${player.color} · approved` : player.requestedColor ? `Requested ${player.requestedColor}` : 'Waiting to choose a color', 'muted'));
      const select = element('select'); select.setAttribute('aria-label', `Seat for ${player.name}`); select.append(option('', 'No seat', !player.color && !player.requestedColor));
      for (const color of state.seats) { if (!state.players.some(p => p.id !== player.id && p.color === color)) select.append(option(color, color, (player.requestedColor || player.color) === color)); }
      const approve = element('button', 'Assign seat', 'secondary'); approve.disabled = !live;
      approve.onclick = () => run(() => route('assign', { id: player.id, color: select.value || null })); row.append(select, approve); $('players').append(row);
    }
  }
  const settingsKey = JSON.stringify([state.zones, state.enabledDecks, state.decks, state.handZones, state.targets, state.buttons, state.enabledTargets, state.enabledButtons]);
  if (settingsKey !== lastSettings && !$('settings-form').contains(document.activeElement) && !settingsDirty) {
    lastSettings = settingsKey; const fields = $('settings-fields'); fields.replaceChildren();
    const grid = element('div', undefined, 'settings-grid'), zones = element('div'), decks = element('div');
    zones.append(element('h3', 'Hand zones')); decks.append(element('h3', 'Draw decks'));
    const indexes = new Set([...Object.keys(state.zones), ...Object.values(state.handZones).flatMap(items => items.map(z => String(z.index)))]);
    for (const index of [...indexes].sort()) {
      const row = element('div', undefined, 'setting-row'), label = element('label', `Hand ${index}`), input = element('input');
      input.value = state.zones[index]?.label || `Hand ${index}`; input.maxLength = 48; input.required = true; input.dataset.zoneLabel = index;
      label.append(input); const check = element('label', undefined, 'check-label'), toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = state.zones[index]?.play === true; toggle.dataset.zonePlay = index;
      check.append(toggle, document.createTextNode('Allow play to table')); row.append(label, check); zones.append(row);
    }
    if (!state.decks.length) decks.append(element('p', 'Connect TTS to discover decks.', 'muted'));
    for (const deck of state.decks) {
      const label = element('label', `${deck.name} (${deck.guid})`), select = element('select'); select.dataset.deck = deck.guid; select.append(option('', 'Draw disabled', !state.enabledDecks[deck.guid]));
      for (const index of [...indexes].sort()) select.append(option(index, `Draw into hand ${index}`, state.enabledDecks[deck.guid] === Number(index))); label.append(select); decks.append(label);
    }
    grid.append(zones, decks); fields.append(grid);
    const targets = element('div', undefined, 'control-settings'); targets.append(element('h3', 'Card destinations'));
    if (!state.targets.length) targets.append(element('p', 'Add a named Ambulator drop point in TTS to discover a destination.', 'muted'));
    for (const target of state.targets) {
      const enabled = state.enabledTargets[target.id]?.signature === target.signature ? state.enabledTargets[target.id] : null;
      const row = element('div', undefined, 'control-setting'), label = element('label', `${target.label}${target.colors.length ? ` · ${target.colors.join(', ')}` : ''}`), select = element('select');
      select.dataset.target = target.id; select.setAttribute('aria-label', `Hand for ${target.label}`); select.append(option('', 'Destination disabled', !enabled));
      for (const index of [...indexes].sort()) select.append(option(index, `From hand ${index}`, enabled?.zone === Number(index)));
      label.append(select); const orientation = element('select'); orientation.dataset.targetFace = target.id; orientation.setAttribute('aria-label', `Visibility for ${target.label}`);
      orientation.append(option('up', 'Play face up', enabled?.faceDown !== true), option('down', 'Return face down · face stays hidden', enabled?.faceDown === true)); row.append(label, orientation); targets.append(row);
    }
    const buttons = element('div', undefined, 'control-settings'); buttons.append(element('h3', 'Approved mod buttons'));
    if (!state.buttons.length) buttons.append(element('p', 'Connect a table with scripted object buttons to discover them.', 'muted'));
    for (const button of state.buttons) {
      const enabled = state.enabledButtons[button.id]?.signature === button.signature ? state.enabledButtons[button.id] : null;
      const row = element('div', undefined, 'control-setting'); row.append(element('strong', `${button.label} (${button.id})`));
      if (!button.ready) { row.append(element('p', 'Add the button adapter to its owner script before enabling this control.', 'muted')); buttons.append(row); continue; }
      const label = element('label', 'Name on phones'), input = element('input'); input.dataset.buttonLabel = button.id; input.maxLength = 120; input.required = true; input.value = enabled?.label || button.label; label.append(input); row.append(label);
      const colors = element('div', undefined, 'control-colors');
      for (const color of state.seats.filter(color => !button.colors.length || button.colors.includes(color))) {
        const check = element('label', undefined, 'check-label'), toggle = element('input'); toggle.type = 'checkbox'; toggle.dataset.button = button.id; toggle.dataset.color = color; toggle.checked = enabled?.colors.includes(color) || false;
        check.append(toggle, document.createTextNode(color)); colors.append(check);
      }
      row.append(colors); buttons.append(row);
    }
    fields.append(targets, buttons);
  }
  $('zone-summary').textContent = Object.entries(state.handZones).map(([color, zones]) => `${color}: ${zones.map(z => `hand ${z.index} (${z.count} cards)`).join(', ')}`).join(' · ');
}
let settingsDirty = false;
$('settings-form').oninput = () => { settingsDirty = true; };
function renderPlayer() {
  $('seat-panel').hidden = !!state.me.color;
  $('seat-heading').textContent = state.me.requestedColor ? 'Waiting for your host' : 'Choose a seat';
  $('seat-instructions').textContent = state.me.requestedColor ? `You requested ${state.me.requestedColor}. Your host will approve your seat.` : 'Your host will approve the seat before your cards appear.';
  const selected = $('seat-color').value; $('seat-color').replaceChildren();
  for (const color of state.seats) if (!state.players.some(p => p.color === color && p.id !== state.me.id)) $('seat-color').append(option(color, color, color === (state.me.requestedColor || selected)));
  $('seat-form').querySelector('button').disabled = !live || !state.connected || !$('seat-color').options.length;
  $('hand-tabs').replaceChildren(); $('hand-content').replaceChildren(); $('draw-controls').replaceChildren(); $('mod-controls').replaceChildren(); $('selection-controls').replaceChildren(); $('selection-actions').replaceChildren();
  if (selectionColor !== state.me.color) { selection.clear(); selecting = false; selectionColor = state.me.color; }
  if (!state.me.color) return;
  if (!state.hands.some(z => z.index === activeZone)) { activeZone = state.hands[0]?.index || 1; selection.clear(); }
  for (const zone of state.hands) {
    const tab = element('button', `${state.zones[zone.index]?.label || `Hand ${zone.index}`} (${zone.cards.length})`, zone.index === activeZone ? 'active' : '');
    tab.setAttribute('aria-pressed', String(zone.index === activeZone)); tab.onclick = () => { activeZone = zone.index; selection.clear(); selecting = false; renderPlayer(); }; $('hand-tabs').append(tab);
  }
  const zone = state.hands.find(z => z.index === activeZone);
  selection = new Set([...selection].filter(guid => zone?.cards.some(card => card.guid === guid) && !cardPending(guid)));
  if (zone?.cards.length) {
    const toggle = element('button', selecting ? 'Done selecting' : 'Select cards', 'secondary'); toggle.id = 'select-cards'; toggle.setAttribute('aria-pressed', String(selecting));
    toggle.onclick = () => { selecting = !selecting; selection.clear(); renderPlayer(); }; $('selection-controls').append(toggle);
    if (selecting) {
      const count = element('span', `${selection.size} selected · maximum 30`, 'muted'); count.setAttribute('role', 'status'); $('selection-controls').append(count);
      const clear = element('button', 'Clear selection', 'text-button'); clear.onclick = () => { selection.clear(); renderPlayer(); }; $('selection-controls').append(clear);
      const inspect = element('button', 'Inspect selected', 'secondary'); inspect.disabled = selection.size !== 1;
      inspect.onclick = () => { selectedCard = { guid: [...selection][0], zone: activeZone }; renderCardDialog(); $('card-dialog').showModal(); }; $('selection-controls').append(inspect);
      if (state.zones[activeZone]?.play) {
        const play = element('button', `Play ${selection.size} face up to table`); play.id = 'batch-play'; play.disabled = !live || !state.connected || !selection.size;
        play.onclick = () => run(() => submitSelection('play')); $('selection-actions').append(play);
      }
      for (const target of state.targets.filter(t => t.zone === activeZone)) {
        const button = element('button', `${target.faceDown ? 'Return face down' : 'Play face up'} → ${target.label}`, 'secondary'); button.dataset.batchTarget = target.id; button.disabled = !live || !state.connected || !selection.size;
        button.onclick = () => run(() => submitSelection('place', target.id)); $('selection-actions').append(button);
      }
      $('selection-actions').append(element('p', 'Selecting and inspecting stay private. Face-up play reveals the selected cards; face-down returns keep their faces hidden.', 'muted'));
    }
  }
  if (!zone || !zone.cards.length) {
    const empty = element('div', undefined, 'empty'); empty.append(element('h2', 'Your hand is ready.'), element('p', state.connected ? 'Cards dealt into this hand will appear here.' : 'Waiting for your table to reconnect.')); $('hand-content').append(empty);
  } else {
    const caption = element('div', undefined, 'hand-caption'); caption.append(element('span', selecting ? 'Tap cards to select them.' : 'Tap a card to take a closer look.'), element('span', `${zone.cards.length} cards`));
    const grid = element('div', undefined, 'card-grid');
    for (const card of zone.cards) {
      const button = element('button', undefined, 'card'); button.setAttribute('aria-label', `View ${card.name}`); button.dataset.guid = card.guid;
      if (selecting) { button.setAttribute('aria-pressed', String(selection.has(card.guid))); button.classList.toggle('selected', selection.has(card.guid)); button.disabled = cardPending(card.guid); }
      button.append(sprite(card), element('span', card.name, 'card-label')); button.onclick = () => {
        if (selecting) { if (selection.has(card.guid)) selection.delete(card.guid); else if (selection.size < 30) selection.add(card.guid); else notify('Select up to 30 cards.'); renderPlayer(); }
        else { selectedCard = { guid: card.guid, zone: zone.index }; renderCardDialog(); $('card-dialog').showModal(); }
      }; grid.append(button);
    }
    $('hand-content').append(caption, grid);
  }
  for (const deck of state.decks) {
    const button = element('button', `Draw ${deck.name} → ${state.zones[deck.zone]?.label || `Hand ${deck.zone}`}`, 'secondary draw-button');
    button.disabled = !live || !state.connected || state.pending.some(p => p.guid === deck.guid && p.kind === 'draw');
    button.onclick = () => run(async () => { await route('action', { kind: 'draw', guid: deck.guid, zone: deck.zone }); notify('Draw requested.'); }); $('draw-controls').append(button);
  }
  if (state.buttons.length) $('mod-controls').append(element('h3', 'Table actions'));
  for (const control of state.buttons) {
    const button = element('button', control.label, 'secondary'); button.dataset.modButton = control.id; button.disabled = !live || !state.connected || state.pending.some(p => p.buttonId === control.id);
    button.onclick = () => run(async () => { await route('action', { kind: 'button', buttonId: control.id }); notify('Table action requested.'); }); $('mod-controls').append(button);
  }
}
function cardPending(guid) { return state.pending.some(p => p.guid === guid || p.guids?.includes(guid)); }
async function submitSelection(kind, targetId) {
  if (!selection.size) return;
  await route('action', { kind, guids: [...selection], zone: activeZone, ...(targetId ? { targetId } : {}) }); selection.clear(); renderPlayer(); notify('Card action requested.');
}
const sheetSizes = new Map();
function sprite(card) {
  const node = element('div', undefined, 'sprite');
  if (card.face) {
    node.style.backgroundImage = `url(${JSON.stringify(card.face)})`;
    node.style.backgroundSize = `${card.columns * 100}% ${card.rows * 100}%`;
    const x = card.offset % card.columns, y = Math.floor(card.offset / card.columns);
    node.style.backgroundPosition = `${card.columns === 1 ? 0 : x / (card.columns - 1) * 100}% ${card.rows === 1 ? 0 : y / (card.rows - 1) * 100}%`;
    if (!sheetSizes.has(card.face)) {
      if (sheetSizes.size > 100) sheetSizes.clear();
      sheetSizes.set(card.face, new Promise(resolve => {
        const image = new Image(); image.referrerPolicy = 'no-referrer';
        image.onload = () => resolve([image.naturalWidth, image.naturalHeight]); image.onerror = () => resolve(null); image.src = card.face;
      }));
    }
    sheetSizes.get(card.face).then(size => { if (size) node.style.aspectRatio = `${size[0] / card.columns} / ${size[1] / card.rows}`; });
  } else node.textContent = card.name;
  return node;
}
function renderCardDialog() {
  const card = state.hands?.find(z => z.index === selectedCard.zone)?.cards.find(c => c.guid === selectedCard.guid);
  if (!card) { $('card-dialog').close(); selectedCard = null; return; }
  $('card-preview').replaceChildren(sprite(card)); $('card-name').textContent = card.name; $('card-zone').textContent = state.zones[selectedCard.zone]?.label || `Hand ${selectedCard.zone}`;
  const pending = cardPending(card.guid);
  $('play-card').hidden = state.zones[selectedCard.zone]?.play !== true; $('play-card').disabled = !live || !state.connected || pending;
  const faceUpAllowed = !$('play-card').hidden || state.targets.some(t => t.zone === selectedCard.zone && !t.faceDown);
  $('card-privacy').textContent = faceUpAllowed ? 'Only you can see this card. Playing it face up reveals it on the table.' : 'Only you can see this card.';
  $('card-pending').textContent = pending ? 'Waiting for the table…' : '';
  $('card-targets').replaceChildren();
  for (const target of state.targets.filter(t => t.zone === selectedCard.zone)) {
    const button = element('button', `${target.faceDown ? 'Return face down' : 'Play face up'} → ${target.label}`, 'secondary'); button.dataset.cardTarget = target.id; button.disabled = !live || !state.connected || pending;
    button.onclick = () => run(async () => { if (!selectedCard) return; await route('action', { kind: 'place', guid: selectedCard.guid, zone: selectedCard.zone, targetId: target.id }); $('card-dialog').close(); selectedCard = null; notify('Card action requested.'); }); $('card-targets').append(button);
  }
}
$('join-form').onsubmit = event => { event.preventDefault(); run(async () => {
  const roomCode = $('room-code').value.trim().toUpperCase(); await api(`/api/rooms/${roomCode}/join`, { name: $('player-name').value.trim() }); await enter(roomCode);
}); };
$('host-form').onsubmit = event => { event.preventDefault(); run(async () => {
  const key = $('host-key').value; $('host-key').value = ''; const result = await api('/api/rooms', { hostKey: key }); await enter(result.code);
}); };
$('seat-form').onsubmit = event => { event.preventDefault(); run(() => route('seat', { color: $('seat-color').value })); };
$('settings-form').onsubmit = event => { event.preventDefault(); run(async () => {
  const zones = {}, enabledDecks = {}, enabledTargets = {}, enabledButtons = {};
  for (const input of document.querySelectorAll('[data-zone-label]')) zones[input.dataset.zoneLabel] = { label: input.value.trim(), play: document.querySelector(`[data-zone-play="${input.dataset.zoneLabel}"]`).checked };
  for (const select of document.querySelectorAll('[data-deck]')) if (select.value) enabledDecks[select.dataset.deck] = Number(select.value);
  for (const select of document.querySelectorAll('[data-target]')) if (select.value) enabledTargets[select.dataset.target] = { zone: Number(select.value), faceDown: document.querySelector(`[data-target-face="${select.dataset.target}"]`).value === 'down' };
  for (const check of document.querySelectorAll('[data-button]:checked')) { const id = check.dataset.button; enabledButtons[id] ||= { colors: [], label: document.querySelector(`[data-button-label="${id}"]`).value.trim() }; enabledButtons[id].colors.push(check.dataset.color); }
  await route('configure', { zones, enabledDecks, enabledTargets, enabledButtons }); settingsDirty = false; lastSettings = ''; document.activeElement?.blur(); notify('Hand settings saved.'); renderHost();
}); };
$('copy-link').onclick = () => run(async () => { await navigator.clipboard.writeText(`${location.origin}/?room=${code}`); notify('Invite link copied.'); });
$('download-object').onclick = () => run(async () => {
  if (state.connected && !await confirmAction('Replace the TTS connection?', 'The current object will be disconnected. Import the new object to reconnect.')) return;
  const result = await route('object', {}); generatedScript = result.script; $('copy-script').disabled = false;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result.object, null, 2)], { type: 'application/json' })), anchor = element('a');
  anchor.href = url; anchor.download = `Ambulator-${code}.json`; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Object downloaded. Import it into your TTS table.');
});
$('copy-script').onclick = () => run(async () => { await navigator.clipboard.writeText(generatedScript); notify('Object script copied.'); });
$('lock-room').onclick = () => run(() => route('lock', { locked: !state.locked }));
$('revoke-bridge').onclick = () => run(async () => { if (await confirmAction('Disconnect the table?', 'Phone hands will clear until you generate and import a new companion object.')) { await route('revoke-bridge', {}); generatedScript = ''; $('copy-script').disabled = true; } });
$('close-room').onclick = () => run(async () => { if (await confirmAction('Close this room?', 'All player sessions and the TTS connection will end.')) { await route('close', {}); home(); notify('Room closed.'); } });
$('leave-room').onclick = () => run(async () => { if (await confirmAction('Leave the room?', 'Your seat will be released. Rejoining will require host approval.')) { await route('logout', {}); home(); } });
$('close-card').onclick = () => { $('card-dialog').close(); selectedCard = null; };
$('play-card').onclick = () => run(async () => { if (!selectedCard) return; await route('action', { kind: 'play', ...selectedCard }); $('card-dialog').close(); selectedCard = null; notify('Play requested.'); });
// API field is guid; do not send UI-only fields or user-selectable ownership.
if (code) {
  $('room-code').value = code;
  run(async () => { try { await enter(code); } catch (error) { if (error.status === 401) { state = null; $('player-name').focus(); } else throw error; } });
}
