# Hosted service validation

The first Hetzner edge deployment was verified on October 5, 2026 using application revision `db54785` behind the server's existing nginx-proxy and certificate companion. The application uses its own Compose project, an external proxy network, a persistent room-data volume, and a privately generated host key. Only the proxy publishes HTTP/HTTPS ports; the application container exposes port 3001 internally.

Checks completed:

- Docker reports the container healthy. The image runs as the nonroot Node user with a read-only filesystem, dropped capabilities, memory/process limits, and a writable data volume.
- HTTPS certificate validation and `/healthz` succeeded over the edge server's IPv4 and IPv6 addresses.
- Real HTTPS API calls created an isolated room, generated its authenticated companion, joined two players, approved separate seats, and returned separate hands without another player's identities. The host view contained hand counts rather than card identities.
- The real proxy passed an authenticated WSS connection and delivered only the approved player's private state. Cross-player actions and disallowed-origin writes were rejected.
- Chromium browser checks passed through the hosted HTTPS service at desktop and 390/360px phone sizes: joining/approval, private WebSocket delivery, separate hands, batch selection/play, face-down return controls, approved buttons, stale-control removal, settings, refresh, offline reconnect, room locking, player removal, and escaped names. Artwork and the TTS bridge were simulated for these checks.
- Temporary acceptance rooms were closed after testing; test credentials and generated companion objects are not included in the repository.

The domain's authoritative DNS and fresh public resolvers returned the edge addresses. The workstation's upstream resolver retained an earlier negative result during verification, so acceptance clients used fresh public DNS or the confirmed edge addresses while retaining normal hostname/certificate checks. This did not disable TLS verification or change system DNS settings.

Native TTS acceptance was also completed on October 5, 2026 with TTS 14.2.2 on Linux and the Ticket to Ride – Scripted + Expansions workshop table (2754116876):

- The native companion connected over authenticated HTTPS to the edge deployment and discovered separate train/ticket hands and the two live decks. The workstation resolver had refreshed; no hosts-file entry was needed.
- Two headless phone browsers at 390/360px joined and requested Red/Blue seats. Neither received cards before host approval. Native phone actions then dealt four train cards into hand 1 and three tickets into hand 2 for each seat. Actual mod artwork loaded in each private phone view; ticket face-up play stayed disabled.
- Real HTTP and WSS views included each player's own card identities and excluded the other player's identities. The host desk received counts only. Temporary players were removed after testing, leaving the prepared hands available for real players.
- Native clients remained Grey. All 14 dealt cards were recorded under the companion's privacy guard with hover previews disabled, and visual inspection of the shared board showed no private hands.
- The test exposed a MoonSharp runtime issue with an uninitialized loop-local label during snap discovery. Explicitly resetting it to nil and checking its type restored syncing. Optional control APIs are also guarded; regression checks cover unavailable APIs and mixed labelled/unlabelled snaps.

Physical-phone compatibility, a complete game, and native correctness of the new batch/return/button controls remain separate acceptance work. Backups and disaster recovery also remain to be checked. Private room objects and table saves are kept locally and are not included in the repository.
