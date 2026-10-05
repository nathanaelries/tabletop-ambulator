# Ambulator roadmap

The goal is a Jackbox-style companion: TTS renders the shared board, a Docker service on Hetzner manages rooms, and each player's browser receives only their approved hands. This roadmap borrows feature ideas from [TTS Mobile Helper's documentation](https://github.com/Serpens66/TTS_Mobile_Helper) and source; implementation stays in this fork's authenticated room/command system.

## Requirements for every milestone

- Private hands remain invisible on the shared display, including during selection, movement, service outages, and companion reloads. Sorting and private transfers must never reveal card faces publicly.
- The host desk receives counts and public controls, not private card identities or images. TTS administrators and the hosted service remain trusted.
- Phones send action IDs, not executable Lua, callback names, coordinates, or player colors. The server determines ownership; Lua rechecks live ownership, permissions, and discovered controls before execution.
- Actions start disabled and require host configuration. Changes to seats, controls, or targets cancel stale commands. Retried commands do not repeat a draw, play, or button press.
- Retain separate hand indices. Do not assume every mod puts trains and destinations in the same hand or in a particular index order.

## Milestone 1 — reduce operation of the gaming PC

| Feature | Delivery and acceptance | Status |
| --- | --- | --- |
| Batch card selection and play | Select up to 30 cards from one hand; clear selection or inspect without publishing. Queue one command and validate the entire batch on the server and in live Lua before moving any card. Reject mixed ownership, duplicates, overlapping pending actions, and stale cards. | Implemented; native verification pending |
| Configured discard/return destinations | Discover tagged table/object snap points. Host enables each target for a specific hand and chooses face-up play or face-down return. Respect color restrictions and recheck target identity/location before execution. Keep cards hidden until outside every hand; face-down returns must not expose their faces or hover descriptions. | Implemented; native verification pending |
| Approved mod buttons | Discover classic TTS object buttons on public objects. Host approves each button for specific player colors. Recheck its callback owner/name/index and visibility before invoking the native callback with the approved color. Keep arbitrary Lua and callback selection out of browser requests. | Implemented; native verification pending |

This milestone provides generic controls, not board-game rule enforcement. A face-down ticket return does not automatically implement ticket-selection minimums, deck insertion, or shuffling. A named train discard does not claim a route or calculate its cost. Each mod needs explicit target/button configuration and a live compatibility check.

[Setup and validation notes](table-controls.md) describe the implemented controls. Classic buttons require the optional callback adapter appended to their existing owner script; unsupported/unadapted buttons remain disabled. No additional local bridge process is required. Automated checks pass, but final live verification of these new features remains open because TTS was no longer running.

## Milestone 2 — quicker joining and better private hands

| Feature | Delivery and acceptance | Status |
| --- | --- | --- |
| QR invitations | Display a QR code for the public room invite, alongside manual code entry. Scanning joins as an unapproved player; it must not confer a seat or host access. | Planned |
| Hand rearrangement | Drag or use accessible controls to reorder a chosen hand. Persist the player's order without moving cards through public positions; add optional physical TTS reordering only after mod compatibility checks. | Planned |
| Display options | Grid/overlapping layouts, portrait/landscape support, fullscreen where supported, readable sizes, artwork rotation, and remembered preferences. Keep separate hand tabs and avoid hiding essential controls on small screens. | Planned |
| Rich card inspection | Show the owner's card description and improve native-card fallbacks. Render mod text safely and keep descriptions out of other players' and host payloads. | Planned |
| Favorite actions | Pin enabled draw, destination, and mod-button actions. A shortcut loses access immediately when its permission or target changes. | Planned |
| Localization | Extract interface strings, add a language selector and browser-language detection, and translate player and host flows. Names supplied by a mod stay as supplied. | Planned |

## Milestone 3 — private interactions for other games

| Feature | Delivery and acceptance | Status |
| --- | --- | --- |
| Private card transfers | Send selected cards to another approved seat and chosen hand. Recheck both seats at execution; keep the transfer invisible on the board and reveal identities only to the current owner. | Planned |
| Consent-based requests | Request cards from another player, with accept/decline/cancel, expiration, and clear pending status. Approval may allow a blind selection without sending faces; revealing a selection requires a distinct explicit permission. | Planned |
| Optional face-down play/flip controls | Support games that need hidden public cards and private orientation changes. Distinguish revealing a card from moving or flipping it; preserve hiding until a permitted reveal. | Planned |

These features are lower priority for Ticket to Ride, where ordinary player-to-player card transfers are not part of the game.

## Milestone 4 — tested game profiles and automation

| Feature | Delivery and acceptance | Status |
| --- | --- | --- |
| Ticket to Ride mod profiles | Save hand labels, destination/button mappings, and supported setup notes for tested Workshop tables. Rediscover and verify controls after setup or deck rebuild; never rely solely on a previously saved GUID. | Planned |
| Ticket selection and return | Privately choose tickets, enforce the chosen ruleset's keep minimum, return unwanted tickets face down through the mod's intended mechanism, and preserve secrecy during deck merges. | Planned |
| Public train market selection | Select an available public card from a phone, update/refill through the mod, and handle locomotive restrictions for the chosen ruleset. | Planned |
| Turns and action budgets | Show whose turn it is and enforce configured draw/play limits. Integrate with the mod's turn model without seating the TV viewer as a player. | Planned |
| Route claiming and scoring | Choose a route, validate payment and train pieces, invoke compatible mod operations, and handle tunnels/ferries/expansions only within a tested profile. | Planned |
| Mod compatibility coverage | Expand live checks across both tested tables, deck collapse/merging, player setup, reloads, and complete games. Document unsupported callbacks and changed mod versions. | Ongoing |

## Hosting and operations

Docker and reverse-proxy templates already exist. Remaining acceptance work is a real Hetzner HTTPS/WSS deployment, physical phone testing, restart/backup recovery, and an upgrade guide that includes replacing the TTS companion. Local/offline deployment can remain an optional alternative using the same application; offline card artwork would require deliberate asset caching. Syncthing-style pairing, Secret Service integration, and a TTS-free board renderer are outside the current scope.

## Release order

Finish and verify milestone 1 first, then QR joining and private-hand usability. Follow with broader game interactions and tested mod profiles. Mark a feature complete only with server authorization checks, meaningful Lua regressions, browser coverage where applicable, and an honest record of what was checked live in TTS.
