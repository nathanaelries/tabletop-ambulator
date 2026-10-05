import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server/index.mjs';
import { HOST_KEY, snapshot } from './fixtures.mjs';

const directory = await mkdtemp(join(tmpdir(), 'ambulator-browser-'));
const app = await createApp({ dataDir: directory, hostKey: HOST_KEY });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
let browser, interval;
try {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const errors = [], frames = [];
  async function screen(width, height) {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route('https://i.imgur.com/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="200" height="300" fill="#bc5a42"/><rect x="200" width="200" height="300" fill="#749486"/><rect y="300" width="200" height="300" fill="#d4b567"/><rect x="200" y="300" width="200" height="300" fill="#8091a7"/><g fill="#f4efe4" font-size="25" font-family="serif" text-anchor="middle"><text x="100" y="150">TRAIN 01</text><text x="300" y="150">TICKET 02</text><text x="100" y="450">TRAIN 03</text><text x="300" y="450">TICKET 04</text></g></svg>' }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    return { context, page };
  }
  await mkdir('test-results', { recursive: true });
  const host = await screen(1440, 1000);
  await host.page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
  await host.page.locator('#host-details summary').click();
  await host.page.locator('#host-key').fill(HOST_KEY);
  await host.page.locator('#host-form button').click();
  await host.page.locator('#download-object').waitFor();
  const code = new URL(host.page.url()).searchParams.get('room'); assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  const downloadPromise = host.page.waitForEvent('download'); await host.page.locator('#download-object').click();
  const download = await downloadPromise, object = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(object.ObjectStates.length, 1);
  const credential = /local credential = '([^']+)'/.exec(object.ObjectStates[0].LuaScript)[1];
  const bridgeHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` };
  const connect = await fetch(`${base}/api/rooms/${code}/bridge/connect`, { method: 'POST', headers: bridgeHeaders, body: '{}' });
  const session = (await connect.json()).session; let sequence = 0, current = snapshot(), pendingAcks = [];
  async function sync() {
    const response = await fetch(`${base}/api/rooms/${code}/bridge/sync`, { method: 'POST', headers: bridgeHeaders, body: JSON.stringify({ ...current, acks: pendingAcks, session, sequence: ++sequence }) });
    assert.equal(response.status, 200); const data = await response.json();
    pendingAcks = data.commands.map(c => c.id);
    for (const command of data.commands) if (command.kind === 'play') current.hands[command.color].find(z => z.index === command.zone).cards = current.hands[command.color].find(z => z.index === command.zone).cards.filter(c => c.guid !== command.guid);
    return data;
  }
  await sync(); interval = setInterval(() => { sync().catch(error => errors.push(error.message)); }, 600);
  await host.page.getByText('Table connected', { exact: true }).waitFor();
  await host.page.locator('[data-zone-play="1"]').check();
  await host.page.locator('#settings-form button').click();
  await host.page.getByText('Hand settings saved.', { exact: true }).waitFor();
  async function player(name, color, width) {
    const phone = await screen(width, 844); phone.page.on('websocket', ws => ws.on('framereceived', event => frames.push(String(event.payload))));
    await phone.page.goto(`${base}/?room=${code}`); await phone.page.locator('#player-name').fill(name); await phone.page.locator('#join-form button').click();
    await phone.page.locator('#seat-color').selectOption(color); await phone.page.locator('#seat-form button').click();
    await phone.page.getByText('Waiting for your host', { exact: true }).waitFor();
    assert.equal(await phone.page.locator('.card').count(), 0);
    const row = host.page.locator('.player-row').filter({ hasText: name }); await row.getByRole('button', { name: 'Assign seat' }).click();
    await phone.page.locator('.card').first().waitFor(); return phone;
  }
  const red = await player('Ada', 'Red', 390), blue = await player('<b>Bo</b>', 'Blue', 360);
  assert.equal(await host.page.locator('.player-row b').count(), 0);
  await red.page.getByRole('button', { name: 'Destination tickets (1)' }).click();
  await red.page.locator('[data-guid="a00002"]').click(); await red.page.locator('#card-dialog').waitFor({ state: 'visible' });
  assert.equal(await red.page.locator('#play-card').isVisible(), false);
  await red.page.screenshot({ path: 'test-results/private-ticket-phone.png', fullPage: true });
  await red.page.locator('#highlight-card').click(); await red.page.getByText('Highlighted on the table.', { exact: true }).waitFor();
  await red.page.locator('#close-card').click(); await red.page.getByRole('button', { name: 'Train cards (1)' }).click();
  await red.page.locator('[data-guid="a00001"]').click(); await red.page.locator('#play-card:not([disabled])').click();
  await red.page.getByText('Train cards (0)', { exact: true }).waitFor();
  // Collect this player's frames independently for the actual private-delivery assertion.
  const redFrames = []; red.page.on('websocket', ws => ws.on('framereceived', event => redFrames.push(String(event.payload))));
  await red.page.reload(); await red.page.getByRole('button', { name: 'Destination tickets (1)' }).waitFor();
  assert.ok(redFrames.some(frame => frame.includes('a00002'))); assert.ok(redFrames.every(frame => !frame.includes('b00001') && !frame.includes('b00002') && !frame.includes('Blue destination')));
  await red.page.getByRole('button', { name: 'Destination tickets (1)' }).click();
  // A lost phone connection must recover its existing approved seat.
  await red.context.setOffline(true);
  await red.page.evaluate(() => socket.close());
  await red.page.getByText('Reconnecting…', { exact: true }).waitFor();
  await red.context.setOffline(false);
  await red.page.getByText('Table connected', { exact: true }).waitFor();
  await red.page.locator('[data-guid="a00002"]').waitFor();
  await red.page.screenshot({ path: 'test-results/hand-phone.png', fullPage: true });
  await host.page.screenshot({ path: 'test-results/host-desktop.png', fullPage: true });
  for (const screen of [host, red, blue]) assert.ok(await screen.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow.');
  // Draw settings must survive incoming snapshots while being edited.
  await host.page.locator('[data-deck="d00002"]').selectOption('2'); await host.page.waitForTimeout(800);
  assert.equal(await host.page.locator('[data-deck="d00002"]').inputValue(), '2');
  await host.page.locator('#settings-form button').click(); await red.page.getByRole('button', { name: 'Draw Destination deck → Destination tickets' }).waitFor();
  await host.page.locator('#lock-room').click(); await host.page.getByRole('button', { name: 'Open room to new players' }).waitFor();
  const late = await screen(390, 844); await late.page.goto(`${base}/?room=${code}`); await late.page.locator('#player-name').fill('Late'); await late.page.locator('#join-form button').click(); await late.page.getByText('This room is locked. Ask the host to open it.', { exact: true }).waitFor();
  const boRow = host.page.locator('.player-row').filter({ hasText: '<b>Bo</b>' }); await boRow.getByRole('button', { name: 'Remove' }).click(); await host.page.locator('#accept-confirm').click();
  await blue.page.getByText('Your session ended. Join again or ask the host.', { exact: true }).waitFor(); assert.equal(await blue.page.locator('#room').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: desktop, 390/360px phones, host approval, private WebSocket delivery, separate hands, card actions, draw settings, refresh, offline reconnect, locking, removal, and escaped names.');
} finally {
  clearInterval(interval); if (browser) await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true });
}
