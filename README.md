# Ambulator, a private Tabletop Simulator companion

A local fork of [64bits/tabletop-ambulator](https://github.com/64bits/tabletop-ambulator), based on commit `860da5dd69b93a20a8825f00f85ab513310dfbe4`. TTS runs on the gaming PC and displays the board on the TV. Phones join a room and receive only their approved player’s hands. The companion service runs in Docker on Hetzner behind your existing HTTPS proxy.

Run the commands below from the repository root. In the original Right Of Way workspace, this repository lives in the `ambulator/` directory alongside the earlier lobby prototype.

## What works

- Host-key-protected room creation, room-code joining, host approval of player colors, room locking, removal, and closing.
- HttpOnly player sessions that reconnect after refresh. Server-side filtering over both HTTP and WebSockets; other players’ card identities and images are never included in your payload.
- All of a color’s hand zones, with separate tabs, configurable names, and optional play controls. Hands 1 and 2 initially have the labels “Train cards” and “Destination tickets”; **verify the index order against your mod**. All play/draw controls start disabled; enable train play after checking the layout.
- Private card inspection on phones, selection of up to 30 cards from one hand, explicit **Play face up to table**, and optional one-card draws from host-enabled decks into the configured hand. Public highlighting of private cards is disabled.
- Host-configured destinations discovered from tagged snap points, with face-up placement or face-hidden returns. Host-approved classic mod buttons for selected player colors, using an optional callback adapter. See [control setup and validation limits](docs/table-controls.md); these new flows await native TTS verification.
- Shared-display privacy: hand objects are invisible, including their backs, and have no hover tooltip. All TTS clients are kept in Grey spectator mode. Native actions on private cards are blocked; approved phone actions release visibility after cards leave every hand. Face-down returns retain face hiding and tooltip suppression.
- A generated TTS companion object with its own revocable credential, authenticated snapshots, replay checks, command acknowledgements, and local ownership checks immediately before executing a command.
- Room expiry, hashed stored credentials, persistent seat assignments, and reconnect after service restart. Card snapshots and pending commands are held only in memory.
- Nonroot Docker image, read-only filesystem, persistent data volume, health check, request limits, origin checks, and HTTPS/WSS behind an existing proxy.

This is a general hand companion. It does not implement Ticket to Ride rules, route claiming, scoring, turns, or ticket-selection rules. The host coordinates these in TTS or configures compatible mod buttons. Enabling draws allows individual draws; it does not enforce the board game's draw limits. Earlier single-card integration was checked with two TTS Workshop tables; see [tested Workshop compatibility and setup](docs/workshop-compatibility.md). The [full roadmap](docs/roadmap.md) covers joining, hand usability, private interactions, game profiles, and hosting acceptance.

## Run locally

Install Node.js 24 or newer.

```sh
npm ci
npm run setup
npm start
```

Open `http://127.0.0.1:3001`. Expand **Host a room** and enter the contents of `secrets/host_key.txt`. The key is generated once, is ignored by Git, and is never printed by setup or the server. On Linux you can view it locally with:

```sh
cat secrets/host_key.txt
```

Local HTTP mode is for development on the gaming PC. Public origins must use HTTPS. For phones and TTS to connect to a hosted instance, configure an actual public domain and proxy as below.

## Docker on Hetzner

Copy this directory to the server, excluding `.git`, `node_modules`, `data`, `secrets`, `.env`, and `test-results` from any public publication. Create the host key privately on the server:

```sh
install -d -m 700 secrets
(umask 077; openssl rand -base64 32 > secrets/host_key.txt)
cp .env.example .env
```

Set `PUBLIC_ORIGIN=https://your-domain.example` in `.env`. It must contain only scheme, hostname, and optional port: no path or trailing slash. The application deliberately ignores forwarded headers when choosing its origin and cookie security. Configure the proxy with the same domain.

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 ambulator
```

Compose publishes `127.0.0.1:3001`, for a proxy on the host. [Caddy](deploy/Caddyfile.example) and [nginx](deploy/nginx.conf.example) examples are included. Nginx needs the shown WebSocket upgrade headers; Caddy and Traefik handle upgrades automatically.

For a reverse proxy in Docker, attach to its existing network:

```sh
docker compose -f compose.yaml -f deploy/compose.proxy.yaml up -d --build
```

For Traefik, also configure `GAME_DOMAIN`, `PROXY_NETWORK`, and the existing entrypoint/certificate resolver in `.env`:

```sh
docker compose -f compose.yaml -f deploy/compose.proxy.yaml -f deploy/compose.traefik.yaml up -d --build
```

For an existing [nginx-proxy](https://github.com/nginx-proxy/nginx-proxy) with [acme-companion](https://github.com/nginx-proxy/acme-companion), set `GAME_DOMAIN` and `PROXY_NETWORK` in `.env`, point the hostname's DNS at your server, then run:

```sh
docker compose -f compose.yaml -f deploy/compose.proxy.yaml -f deploy/compose.nginx-proxy.yaml up -d --build
```

This overlay supplies the proxy hostname and certificate hostname for both current and older acme-companion versions. It uses your existing certificate service; it does not install another proxy. Set `IMAGE_TAG` to an application revision if you want a versioned image for this deployment.

The proxy overlay requires Compose 2.24.4 or newer. The network must already exist. Keep PostgreSQL and other unrelated services out of this stack; the fork uses an atomic JSON snapshot in the `room_data` named volume.

The container uses UID 1000. File-backed Compose secrets inherit host ownership and permissions; make the private host-key file readable by that UID. A root-owned file can use a group readable by the container, without making it world-readable. Rootless Podman uses different UID mapping; when testing with Podman secrets, set `uid=1000,mode=0400` on the secret mount. Compose secrets are file mounts, not automatic encryption at rest.

`PUBLIC_ORIGIN` is required in production. `APP_PORT` defaults to `3001`; `ROOM_TTL_HOURS` defaults to `48`; `MAX_ROOMS` defaults to `100`. Single-instance hosting is supported. There is no shared state or socket routing for multiple replicas.

## Connect your TTS game

1. Load your chosen Workshop game privately, before displaying it on the TV. Configure its player/hand zones, and import the companion before dealing private cards or sharing the display.
2. Open the web app on the host computer, create a room, and choose **Download TTS object**.
3. Put the downloaded `Ambulator-CODE.json` in TTS’s `Saves/Saved Objects` folder under your configured save-data directory. Use **Objects → Saved Objects** to spawn it on the current table. If it does not appear immediately, reopen the menu or restart TTS. A missing thumbnail is expected.
4. Alternatively, generate the object, expand **Or copy the object’s Lua script**, copy it, and paste it into the script of a separate object such as a spare figurine. Use TTS’s **Save & Play**. Keep it on a separate object so the game mod’s Global and object scripts are preserved.
5. The host page will say **Table connected** and list colors with hand zones. Give players the invite link or room code. Each requests a color; use **Assign seat** to approve it.
6. Check the hand indices shown under **Hands & table controls**, rename them if necessary, and enable only the decks/actions you want phones to control. Save the settings. Optional destinations and mod buttons have [additional setup instructions](docs/table-controls.md).
7. Verify the companion is active: the TTS viewer must be **Grey spectator**, and hand cards must be invisible. Then put that TTS board on the TV. The companion automatically returns clients to Grey if they try a player or Black seat. Keep private phone/browser views on their owners' devices; the host web page is a control desk, not the board renderer.

This mode requires every player to use a phone/browser session for private hands; all connected TTS clients serve as shared board viewers. Mods that count seated TTS players need an explicit player count. Cards remain hidden if moved out of a hand manually. Newly spawned cards/decks are hidden while moving and become visible only after settling outside hands; cards entering a hand keep their hiding until an approved action. Explicit face-down returns keep faces hidden even outside hands. These protections continue locally during service outages or credential revocation, and private object IDs survive a TTS save/reload. The companion also keeps hand zones enabled with normal hand hiding.

Existing installations must generate and import an updated companion object to enable this guard. Updating the service alone does not replace Lua already loaded in TTS.

TTS sends requests directly to the HTTPS service using [WebRequest.custom](https://api.tabletopsimulator.com/webrequest/manager/#custom). There is no external-editor listener or additional local bridge process. Its [hand API](https://api.tabletopsimulator.com/player/instance/#gethandobjects) is called with each explicit index, including empty hands. See the official [saved-object guide](https://kb.tabletopsimulator.com/host-guides/spawning-objects/) and [save-data locations](https://kb.tabletopsimulator.com/getting-started/technical-info/) if your folder is elsewhere.

Generating another companion object rotates the room’s TTS credential, clears cached hands and pending actions, and disconnects the old object. Delete the old object and import the new one. **Disconnect TTS** revokes the credential without generating a replacement. Service restarts retain the room and approved seats; the object reconnects automatically and sends a fresh snapshot. Pending commands do not survive restart.

If a phone loses its cookie, it must rejoin and receive approval again. Remove the old player to release that seat. The host cookie is also private: keep the host page on the original browser. If it is lost, create a new room; the old room will expire.

## Card images and mod compatibility

Custom cards are extracted from TTS’s card-sheet metadata. The browser displays the correct cell directly from the sheet, preserving its aspect ratio. Native cards and objects without custom image metadata show their name as a fallback. Unnamed native cards do not expose a readable rank/suit in this version; use custom-card mods for card faces.

Image hosts are an explicit allowlist. Defaults include Steam’s common asset hosts, `i.imgur.com`, and `raw.githubusercontent.com`. Add any additional HTTPS hosts used by your trusted mod through `ASSET_HOSTS` in `.env`, then recreate the service. `*.steamusercontent.com` permits subdomains; wildcard `*` is not supported. The Lua adapter upgrades legacy `http://` image links to `https://`; if that asset host does not serve HTTPS, replace the asset URL in the mod or use a supported host.

The server never downloads those images. Phones contact the allowed image host and therefore reveal their IP to that host. Deck-sheet artwork may contain faces of other possible cards; the server sends only the indices identifying the cards actually in your hand. That distinction is necessary for games using public shared deck artwork.

No Ticket to Ride assets are included. Use a game/mod you already have access to. Card/deck GUIDs can change when decks collapse or are recreated; re-enable a newly discovered deck if needed. Hidden decks in player hand zones are excluded. Up to 10 colors, 8 hand zones per color, 300 cards per zone, 100 public decks, and 512 KiB per TTS snapshot are accepted. A malformed or disallowed snapshot is rejected as a whole; TTS prints the validation error without printing the credential.

## Security and trust

The room code identifies a lobby; it does not authenticate a player or TTS. Seat ownership is approved by the host and stored on the server. Commands derive their color from that ownership and are checked again against the live hand by Lua. The server does not trust colors or room identifiers supplied in action messages. Browser sessions use same-origin requests, HttpOnly/SameSite cookies, and Secure cookies when the configured origin uses HTTPS. WebSocket handshakes require the exact allowed origin and a valid session, and every action is authorized separately. Removal and expiry invalidate sockets as well as HTTP access.

The server stores SHA-256 digests of high-entropy credentials, not plaintext tokens. It serves no legacy `/hands`, `/create`, `/highlights`, or `/card` endpoints. Upstream’s unrestricted image-fetching proxy is absent. Source files, private credentials, and `upstream/` are not public routes. No full hand payloads or credentials are logged. Failed storage writes stop game access until the storage problem is corrected and the process restarted.

**TTS and the Hetzner service remain trusted.** The generated object and any TTS save containing it include the room’s TTS credential. Do not publish those objects/saves or share them with untrusted TTS clients. Revoke it after accidental sharing. Players using phones receive only their own hands; connected TTS clients may have broader access to game scripts and assets. This version does not use end-to-end encryption to hide cards from Hetzner or the TTS host.

The display guard operates while the companion's Lua script is active. A TTS administrator can override/delete that script or load an unprotected save; TTS cannot provide an absolute privacy boundary against its own administrator. Import and verify the companion before showing the TV, and keep it active throughout play. The guard uses independent [TTS object hiders](https://api.tabletopsimulator.com/object/#attachinvisiblehider) and [player event handlers](https://api.tabletopsimulator.com/events/#onplayerchangecolor). The companion stays on its own object; optional button support requires appending the adapter to a mod's existing callback-owner script. Approve trusted mod callbacks only after checking their behavior.

The default proxy sees all requests coming from one IP; coarse IP limits are intentionally generous. Additional internet-facing limits can be applied at your existing proxy. The application never trusts client-provided `X-Forwarded-For` headers. Protect the host key, `.env`, data volume, and backups. Rotating the server host key affects room creation; close existing rooms separately to revoke their sessions.

## Verify and develop

```sh
npm run check
npm test
npx playwright install chromium
npm run test:browser
npm run test:lua
```

The Lua checks require a `lua` interpreter compatible with Lua 5.2. On distributions with separately named executables, use `lua5.2 test/bridge.test.lua`. Browser tests use synthetic artwork and a simulated TTS endpoint; they do not download a Workshop mod or launch TTS.

Server tests cover private state over HTTP and WebSockets, denied cross-player/zone/highlight actions, seat approval, protected host routes, draw policies, batch validation, destination/button permissions, stale/replayed snapshots, bridge credential rotation, origin restrictions, cookies, player removal, restart persistence, and legacy route removal. Lua tests execute the real bridge and button adapter with a mocked TTS host, including face-hidden returns through merges/reloads and native callback argument conversion. Browser checks cover selection, separate hands, approved controls, and private delivery. Live TTS integration and its limits are recorded in [Workshop compatibility](docs/workshop-compatibility.md); [new control validation](docs/table-controls.md) is tracked separately.

The original application is preserved in `upstream/` for comparison and excluded from Docker builds. The original MIT license is retained in `LICENSE.md`; provenance is recorded in `ATTRIBUTION.md`. The maintained companion lives on the `secure-companion` branch. Hosting on Hetzner is a separate deployment step.
