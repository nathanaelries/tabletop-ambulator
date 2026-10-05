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

These checks exercise the hosted application with a simulated TTS bridge. They do not establish a native TTS-to-Hetzner connection, physical-phone compatibility, a complete game, or native correctness of the new batch/return/button controls. Those remain separate acceptance work. Backups, disaster recovery, and replacement of the companion during upgrades also remain to be checked.
