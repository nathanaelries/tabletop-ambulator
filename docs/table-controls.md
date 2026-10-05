# Batch actions and approved table controls

These controls are implemented and covered by server, browser, and mocked Lua tests. Native TTS validation of the new batch, return, and button flows is still pending. The earlier live Workshop checks in [compatibility notes](workshop-compatibility.md) cover the previous single-card companion. Keep a new configuration off the shared TV until you have checked its behavior with your table.

Upgrade the service, generate an updated companion, delete the old companion, and import the new object. Updating Docker does not update an object already loaded in TTS. Generating the object rotates its room credential; do not publish it or the save containing it.

## Batch cards

On a phone, choose a hand and tap **Select cards**. Tap up to 30 cards, then choose **Play … face up to table** or an enabled destination. Selection, clearing, and inspection send no public action. Changing hands clears the selection. **Inspect selected** opens the usual private preview when one card is selected.

The server and Lua check every selected card belongs to that player and hand before any card moves. If one card is stale, the whole batch is rejected. Cards with pending actions cannot be selected again. Authorization is checked before movement; this is not a transactional rollback of TTS physics or arbitrary mod scripts. A movement failure keeps the affected card hidden.

Generic play places cards outside the chosen hand, spread along its edge, and rotates them face up. Enable it only for appropriate hands. It does not pay for a route or invoke a mod's discard function.

## Named destinations

The companion discovers global and public-object snap points with a tag named **`AmbulatorDrop:<label>`**. For example, `AmbulatorDrop:Ticket returns` provides a destination named “Ticket returns.” Optional `AmbulatorFor:Red`, `AmbulatorFor:Blue`, etc. tags restrict that point to those colors. Without color tags, the point permits any approved color when enabled by the host. Private objects cannot contribute destinations.

Create a snap point through your table's setup script or snap-point tooling. This example appends a global point while retaining existing points; its coordinates are illustrative and must be adjusted to your board:

```lua
local points = Global.getSnapPoints() or {}
table.insert(points, {
    position = {0, 1, 30}, rotation = {0, 0, 0}, rotation_snap = true,
    tags = {'AmbulatorDrop:Ticket returns', 'AmbulatorFor:Red'}
})
Global.setSnapPoints(points)
```

For object snap points, positions are local to the object; the companion resolves them to world coordinates. Destinations are limited to 100 per snapshot. A change to the point's position, yaw, label, color restrictions, or index invalidates its approval. The host must review and enable the changed target again. Avoid targets on objects that move during ordinary play.

On the host desk under **Hands & table controls → Card destinations**, choose the originating hand and either **Play face up** or **Return face down · face stays hidden**, then save. A target may be enabled for tickets while generic ticket play remains disabled. Phones cannot supply coordinates or change the host's orientation setting.

Cards stay invisible while moving and until they leave every hand. A face-up placement reveals the card. A face-down return shows its back, keeps its face hidden with the companion's hider, suppresses hover text, and blocks native player manipulation. That concealment survives reload and follows cards into a return deck; entering a hand restores complete invisibility. A returned deck can be enabled separately as a draw source. If a placement overlaps a hand, it stays hidden.

A destination moves cards; it does not enforce the ticket keep minimum, insert them at the bottom of a deck, shuffle, or run a mod callback. Verify deck-merging behavior in the intended mod before using returns in a game. Approved callbacks may implement those operations in a future tested game profile.

## Approved classic mod buttons

The host desk discovers visible classic `createButton` controls on public objects. It skips buttons on private objects, buttons with zero width/height, and objects tagged **`AmbulatorHideButtons`**. Optional **`AmbulatorFor:<color>`** object tags restrict eligible player colors. XML UI elements are not supported in this milestone.

TTS's `Object.call` passes one parameter table, while a classic button callback expects `(object, player_color, alt_click)`. To bridge these signatures, append the contents of [lua/button-adapter.lua](../lua/button-adapter.lua) to the button's **function owner** script, retaining all existing code. The owner may be Global or another object; it is not necessarily the object displaying the button. Make script changes privately before sharing the board, using TTS's scripting editor and Save & Play as appropriate. Back up your own table first, and retain the adapter when replacing/updating the owner script.

The companion does not automatically edit Workshop scripts. Buttons without the adapter are listed for the host but cannot be enabled. The adapter runs inside the callback owner's sandbox and invokes the existing callback with the button object, the server-approved player color, and `alt_click=false`. It requires no external-editor listener, local Python process, or additional public port.

After discovery, set the button's name on phones and select permitted player colors on the host desk, then save. Only those approved seats receive that control. Phones send a button ID; they cannot choose the callback, player color, script, or arguments. The companion rechecks the button's current owner, callback name, index, label, color tags, adapter presence, and nonzero size before calling it. Changed or removed controls invalidate queued actions. Retried command IDs do not press the button twice.

The mod callback remains trusted code. Approve only callbacks whose behavior you understand: a reveal/search button may intentionally expose cards, and callbacks that depend on seated TTS players may not work with every viewer held in Grey. Test each button with the intended phone seat and check the TV's privacy before allowing players to use it. Right-click/alternate callbacks and complete game-rule automation remain future work.

## Validation record

On October 5, 2026: 22 HTTP/WebSocket tests pass, browser flows pass at desktop and 390/360px phone sizes, and Lua 5.2 regression checks execute the actual bridge and adapter against a mocked TTS host. Coverage includes batch rejection before movement, stale permissions, private payload filtering, target orientation, face-hidden returns through merges/reloads, and the three-argument callback signature. TTS was not running for final native verification, so these results do not establish live compatibility of the new features with either Workshop table. The hosted service subsequently passed [Hetzner HTTPS/WSS checks](hosting-validation.md) using a simulated bridge; native TTS-to-Hetzner integration and physical phones remain acceptance work.
