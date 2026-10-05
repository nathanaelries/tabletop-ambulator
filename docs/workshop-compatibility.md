# Tested TTS Workshop tables

Live checks completed on October 5, 2026 using the installed Linux version of Tabletop Simulator 14.2.2, the real Lua companion object, and independent browser sessions with a 390 × 844 phone viewport. Browser card images loaded from the mod's actual Steam-hosted sheets. No Workshop assets or generated objects containing credentials are included in this repository.

| TTS Workshop table | Hand layout | Verified behavior |
| --- | --- | --- |
| [Ticket to Ride — Laudani, 2076749278](https://steamcommunity.com/sharedfiles/filedetails/?id=2076749278) | One hand per color, mixing train cards and destination tickets | Two approved seats, actual card images, private HTTP and WebSocket views, rejection of another player's card action, native draws, and native plays onto the table |
| [Ticket to Ride - Scripted + Expansions — ZeekMaster, 2754116876](https://steamcommunity.com/sharedfiles/filedetails/?id=2754116876) | Hand 1: trains. Hand 2: destination tickets. White, Red, Blue, Green, Yellow. | Two approved seats, separate tabs, actual card images, phone UI highlight/play/draw controls, drawing into each configured hand, ticket play disabled, private WebSocket views, and approved seat retained after refresh |

The scripted table also reconnected after restarting the companion service: approved seats persisted, and the live Lua object repopulated both private hands from TTS without replaying earlier actions.

Laudani's table was the highest matching Ticket to Ride result in TTS's Workshop when sorted by total unique subscribers during this check. It does **not** have separate destination hands. Name its first hand “Cards (trains + tickets)”; enabling play on that hand also permits playing its tickets.

## Scripted table setup for a shared TV

1. Load the scripted table and spawn the generated companion object separately. Keep the mod's Global and object scripts intact.
2. Set the mod's **Players** button to **2–3** or **4–5**, matching the group, and leave **Turns** off. Phone players are companion sessions; they do not count as seated TTS clients. The mod's **Auto** player setting can therefore refuse to start a game with only one TTS client.
3. Start the game and wait for its setup to finish. On the host web page, enable **Train Deck → hand 1** and **Ticket Deck → hand 2**. Keep destination-ticket play disabled. Enable train play only after checking that cards land in a suitable public position for your table.
4. Join each phone, request a color, and approve it on the host desk. The mod initially deals only to seated TTS clients; manually deal the initial cards into the phone players' colors, or have them use the allowed draw controls the correct number of times. Initial ticket selection/return is coordinated by the host.
5. Set the TV's TTS client to **Grey spectator**. In the live check, Grey saw the board and card backs while each companion session could inspect only its own cards. A player-colored TV client exposes that color's hand; Black exposes all hands.

These checks cover companion integration, not a complete game. Route claiming, scoring, turn rules, face-up market selection, returning tickets, expansion-specific actions, and the mod's colored discard/score buttons still need host coordination in TTS. A generic phone **Play** moves a card out of its hand onto the table; it does not invoke the mod's discard or route-claim functions.

Deck GUIDs can change when a deck is rebuilt or merged. Recheck the discovered deck names after setup and re-enable the current deck if necessary. Both tested tables contain sideways artwork in their source card sheets; the browser preserves that artwork's orientation.

## Fixes found by the live checks

- TTS includes Grey in `Player.getColors()`, but looking up `Player.Grey` throws. The companion now skips that lookup while collecting hands and checking private decks before a draw.
- A fixed six-unit play offset remained inside Laudani's large hand volume, so TTS put the card back in the hand. Play now uses the hand's depth plus clearance and a direct position change. Live checks confirmed the played card leaves the hand; the scripted table's destination hand remains unchanged.

The test service used local HTTP on the gaming PC. Physical phones, HTTPS/WSS through the Hetzner proxy, additional expansions, and full-game automation were not tested in this session.
