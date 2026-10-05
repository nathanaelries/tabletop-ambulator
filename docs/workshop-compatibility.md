# Tested TTS Workshop tables

Live checks completed on October 5, 2026 using the installed Linux version of Tabletop Simulator 14.2.2, the real Lua companion object, and independent browser sessions with a 390 × 844 phone viewport. Browser card images loaded from the mod's actual Steam-hosted sheets. No Workshop assets or generated objects containing credentials are included in this repository.

| TTS Workshop table | Hand layout | Verified behavior |
| --- | --- | --- |
| [Ticket to Ride — Laudani, 2076749278](https://steamcommunity.com/sharedfiles/filedetails/?id=2076749278) | One hand per color, mixing train cards and destination tickets | Two approved seats, actual card images, private HTTP and WebSocket views, rejection of another player's card action, native draws, and native plays onto the table |
| [Ticket to Ride - Scripted + Expansions — ZeekMaster, 2754116876](https://steamcommunity.com/sharedfiles/filedetails/?id=2754116876) | Hand 1: trains. Hand 2: destination tickets. White, Red, Blue, Green, Yellow. | Two approved seats, separate tabs, actual card images, phone play/draw controls, drawing into each configured hand, ticket play disabled, private WebSocket views, and approved seat retained after refresh. Shared-display guard tested live as described below. |

The scripted table also reconnected after restarting the companion service: approved seats persisted, and the live Lua object repopulated both private hands from TTS without replaying earlier actions.

Laudani's table was the highest matching Ticket to Ride result in TTS's Workshop when sorted by total unique subscribers during this check. It does **not** have separate destination hands. Name its first hand “Cards (trains + tickets)”; enabling play on that hand also permits playing its tickets.

## Scripted table setup for a shared TV

1. Load the scripted table privately and spawn the generated companion object separately, before dealing or displaying the TV. Keep the mod's Global and object scripts intact.
2. Set the mod's **Players** button to **2–3** or **4–5**, matching the group, and leave **Turns** off. Phone players are companion sessions; they do not count as seated TTS clients. The mod's **Auto** player setting can therefore refuse to start a game with only one TTS client.
3. Start the game and wait for its setup to finish. On the host web page, enable **Train Deck → hand 1** and **Ticket Deck → hand 2**. Keep destination-ticket play disabled. Enable train play only after checking that cards land in a suitable public position for your table.
4. Join each phone, request a color, and approve it on the host desk. The mod initially deals only to seated TTS clients; manually deal the initial cards into the phone players' colors, or have them use the allowed draw controls the correct number of times. Initial ticket selection/return is coordinated by the host.
5. Verify the companion keeps the TV's TTS client in **Grey spectator** and makes hand cards entirely invisible, including their backs. Only show the TV after this check. Each companion session can inspect its own cards; keep these private views off the shared display. All TTS clients must remain board viewers; players use phone sessions.

These checks cover companion integration, not a complete game. Route claiming, scoring, turn rules, face-up market selection, returning tickets, expansion-specific actions, and the mod's colored discard/score buttons still need host coordination in TTS. A generic phone **Play** moves a card out of its hand onto the table; it does not invoke the mod's discard or route-claim functions.

Deck GUIDs can change when a deck is rebuilt or merged. Recheck the discovered deck names after setup and re-enable the current deck if necessary. Both tested tables contain sideways artwork in their source card sheets; the browser preserves that artwork's orientation.

## Fixes found by the live checks

- TTS includes Grey in `Player.getColors()`, but looking up `Player.Grey` throws. The companion now skips that lookup while collecting hands and checking private decks before a draw.
- A fixed six-unit play offset remained inside Laudani's large hand volume, so TTS put the card back in the hand. Play now uses the hand's depth plus clearance and a direct position change. Live checks confirmed the played card leaves the hand; the scripted table's destination hand remains unchanged.
- TTS's Black seat bypasses object hiding. The companion now returns clients to Grey in the color-change event and every update. Live attempts to enter Red or Black returned to Grey immediately.
- Disabling object interaction removes cards from the native hand API. The guard preserves native hand membership and instead vetoes player actions on private/transient cards. Tooltips and both visibility/face hiders remain suppressed.

## Shared-display privacy check

The updated guard was checked live on the scripted table with both hand zones populated. The shared TTS display showed the board, public market, and played cards while every hand was invisible. The independent Red and Blue phone sessions retained their own hands. A train drawn from a phone was hidden on spawn and on hand entry, appeared only in the owner's phone hand, and became public when explicitly played. Private-card highlighting is removed from the UI and rejected by the server.

With the companion service stopped, the viewer still returned from Black to Grey, and a native deal increased Blue's destination hand from three cards to four while its tooltips remained suppressed. Disabling hands/hiding locally was reset by the guard. Restarting the service repopulated the private phone views. A destination ticket moved manually onto the board remained invisible; reloading the companion retained that private ID. An approved train play merging into the public discard cleared its private ID. Lua regression checks additionally cover a play overlapping another hand staying hidden and unapproved private merges hiding their container.

This is a display safeguard while the companion is active, not protection against a TTS administrator overriding Lua or opening an unprotected save. The stricter display guard has been live-tested on the scripted table; Laudani's entry above records the earlier bridge integration checks. Other mods' scripts, deck merging, unusual card spawning, and full-game actions still need their own compatibility checks.

The test service used local HTTP on the gaming PC. Physical phones, HTTPS/WSS through the Hetzner proxy, additional expansions, and full-game automation were not tested in this session.
