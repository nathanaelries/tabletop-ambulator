-- Exercise the actual bridge with a mocked TTS host, not a second implementation.
local function equal(actual, expected, message)
    assert(actual == expected, (message or 'Unexpected value') .. ': ' .. tostring(actual) .. ' ~= ' .. tostring(expected))
end
local function fixture(saved, detached)
    local requests, timers, objects, calls, errors, frames, conditions = {}, {}, {}, {}, {}, {}, {}
    local hands = { Red = { {}, {} }, Blue = { {}, {} } }
    local function card(guid, label, tag)
        local object = {
            tag = tag or 'Card', is_face_down = true, resting = true,
            tooltip = true, interactable = true, invisible = {}, hidden = {},
            getGUID = function() return guid end,
            getName = function() return label end,
            getJSON = function() return { CardID = 101, CustomDeck = { ['1'] = { FaceURL = 'http://i.imgur.com/sheet.png', NumWidth = 2, NumHeight = 2 } } } end,
            highlightOn = function() calls[#calls + 1] = { kind = 'highlight', guid = guid } end,
            setPosition = function(position) calls[#calls + 1] = { kind = 'play', guid = guid, position = position } end,
            flip = function() calls[#calls + 1] = { kind = 'flip', guid = guid } end,
            deal = function(count, color, index) calls[#calls + 1] = { kind = 'draw', count = count, color = color, zone = index } end
        }
        object.attachInvisibleHider = function(id, hidden) object.invisible[id] = hidden end
        object.attachHider = function(id, hidden) object.hidden[id] = hidden end
        object.isDestroyed = function() return object.destroyed or false end
        object.isSmoothMoving = function() return false end
        object.setRotation = function(rotation) calls[#calls + 1] = { kind = 'rotation', guid = guid, rotation = rotation }; object.is_face_down = rotation.x == 180 end
        object.getSnapPoints = function() return object.snaps or {} end
        object.getButtons = function() return object.buttons or {} end
        object.getTags = function() return object.tags or {} end
        object.hasTag = function(tag) for _, value in ipairs(object.tags or {}) do if value == tag then return true end end; return false end
        object.getRotation = function() return { y = 0 } end
        object.positionToWorld = function(position) return position end
        object.getVar = function(key) if key == 'ambulatorPressButton' and object.adapter then return function() end end end
        object.call = function(key, args) assert(key == 'ambulatorPressButton'); calls[#calls + 1] = { kind = 'button', owner = guid, args = args } end
        objects[guid] = object; return object
    end
    hands.Red[1][1] = card('a00001', 'Train'); hands.Red[2][1] = card('a00002', 'Ticket'); hands.Blue[1][1] = card('b00001', 'Other train');
    card('d00001', 'Train deck', 'Deck'); card('d00002', 'Ticket deck', 'Deck');
    if detached then card(detached, 'Detached private card') end
    local client = { color = 'Black' }
    local Player = { getColors = function() return { 'Red', 'Blue', 'Grey', 'Black' } end, getPlayers = function() return { client } end }
    for color, zones in pairs(hands) do
        local playerColor = color
        Player[color] = {
            getHandCount = function() return #zones end,
            getHandObjects = function(index) assert(index, 'The hand index must be explicit.'); return hands[playerColor][index] end,
            getHandTransform = function(index) return { position = { x = 20 + index, y = 1, z = 10 }, rotation = { y = 90 }, scale = { z = 12 } } end
        }
    end
    setmetatable(Player, { __index = function(_, color)
        if color == 'Grey' then error('TTS does not expose Player.Grey') end
    end })
    local env = setmetatable({
        Player = Player, Time = { time = 100 }, Hands = { enable = false, disable_unused = true, hiding = 3 },
        Global = { getSnapPoints = function() return {} end },
        JSON = { encode = function(data) return data end, decode = function(data) assert(type(data) == 'table'); return data end },
        self = { setName = function() end, setLock = function() end, getGUID = function() return 'c00001' end },
        print = function(message) errors[#errors + 1] = message end,
        WebRequest = { custom = function(url, method, download, data, headers, callback)
            requests[#requests + 1] = { url = url, method = method, data = data, headers = headers, callback = callback }
        end },
        Wait = {
            time = function(fn, seconds) timers[#timers + 1] = { fn = fn, seconds = seconds } end,
            frames = function(fn) frames[#frames + 1] = fn end,
            condition = function(fn, predicate, timeout, expired) conditions[#conditions + 1] = { fn = fn, predicate = predicate, expired = expired } end
        },
        getObjectFromGUID = function(guid) return objects[guid] end,
        getAllObjects = function() local result = {}; for _, object in pairs(objects) do result[#result + 1] = object end; return result end
    }, { __index = _G })
    client.changeColor = function(color) client.color = color; env.onPlayerChangeColor(color) end
    assert(loadfile('lua/bridge.lua', 't', env))(); env.onLoad(saved or '')
    local function respond(data, status, error)
        local request = requests[#requests]; request.callback({ is_error = error or false, response_code = status or 200, text = data })
    end
    respond({ session = 'session' });
    local function advance() local timer = table.remove(timers, 1); assert(timer); timer.fn() end
    return { env = env, requests = requests, timers = timers, hands = hands, objects = objects, calls = calls, respond = respond, advance = advance,
        frames = frames, conditions = conditions, client = client, card = card, errors = errors,
        frame = function() local fn = table.remove(frames, 1); assert(fn); fn() end,
        settle = function() local condition = conditions[1]; assert(condition); if condition.predicate() then table.remove(conditions, 1); condition.fn(); return true end; return false end }
end
local function permissions(commands)
    return { commands = commands or {}, seats = { 'Red' }, zones = { ['1'] = { play = true }, ['2'] = { play = false } }, enabledDecks = { d00002 = 2 } }
end

-- Normal native object scripts can expose fewer optional APIs than editor
-- executeScript commands. Missing control methods must not stop private sync.
local limited = fixture()
limited.env.Global.getSnapPoints = nil
local unsupported = limited.card('e00009', 'Unsupported public object', 'BlockSquare')
unsupported.getSnapPoints = nil; unsupported.getButtons = nil
unsupported.hasTag = nil; unsupported.getTags = nil
limited.respond(permissions()); limited.advance()
local limitedSnapshot = limited.requests[#limited.requests].data
equal(#limitedSnapshot.hands.Red[1].cards, 1)
equal(#limitedSnapshot.hands.Red[2].cards, 1)
equal(#limitedSnapshot.targets, 0)
equal(#limitedSnapshot.buttons, 0)

local mixedSnaps = fixture()
mixedSnaps.env.Global.getSnapPoints = function() return {
    { position = { x = 0, y = 1, z = 30 }, tags = { 'AmbulatorDrop:Return tickets' } },
    { position = { x = 5, y = 1, z = 30 }, tags = {} },
    { position = { x = 10, y = 1, z = 30 } }
} end
mixedSnaps.respond(permissions()); mixedSnaps.advance()
local mixedTargets = mixedSnaps.requests[#mixedSnaps.requests].data.targets
equal(#mixedTargets, 1, 'Unlabelled snap points cannot inherit a previous label')
equal(mixedTargets[1].id, 'global:1')

local f = fixture()
equal(#f.requests, 2)
equal(f.requests[1].headers.Authorization, 'Bearer __TOKEN__')
assert(not f.requests[1].url:find('__TOKEN__', 1, true), 'The credential must not be in a URL.')
local snapshot = f.requests[2].data
equal(#snapshot.hands.Red, 2); equal(snapshot.hands.Red[1].cards[1].guid, 'a00001'); equal(snapshot.hands.Red[2].cards[1].guid, 'a00002')
equal(snapshot.hands.Red[2].cards[1].face, 'https://i.imgur.com/sheet.png'); equal(snapshot.hands.Red[2].cards[1].offset, 1)
equal(#snapshot.decks, 2)

-- Recheck real ownership, approval, and zone policy immediately before execution.
f.respond(permissions({
    { id = 'foreign', kind = 'play', color = 'Red', zone = 1, guid = 'b00001' },
    { id = 'wrong-zone', kind = 'play', color = 'Red', zone = 2, guid = 'a00001' },
    { id = 'ticket-play', kind = 'play', color = 'Red', zone = 2, guid = 'a00002' },
    { id = 'unapproved', kind = 'highlight', color = 'Blue', zone = 1, guid = 'b00001' },
    { id = 'ticket-highlight', kind = 'highlight', color = 'Red', zone = 2, guid = 'a00002' }
}))
equal(#f.calls, 0, 'Legacy highlighting must never expose a private card')
f.advance(); equal(#f.requests[3].data.acks, 5)

-- A stale snapshot must not permit playing a card moved to another player's hand.
f.hands.Red[1] = {}; f.hands.Blue[1][2] = f.objects.a00001
f.respond(permissions({ { id = 'moved', kind = 'play', color = 'Red', zone = 1, guid = 'a00001' } }))
equal(#f.calls, 0); f.advance()

-- Drawing targets the configured secondary hand. Retried command IDs deal once.
local draw = { id = 'draw-ticket', kind = 'draw', color = 'Red', zone = 2, guid = 'd00002' }
f.respond(permissions({ draw })); equal(#f.calls, 1); equal(f.calls[1].zone, 2); equal(f.calls[1].color, 'Red')
f.advance(); f.respond({ error = 'Lost response' }, 503, true); f.advance(); f.respond(permissions({ draw })); equal(#f.calls, 1)
f.advance()

-- Decks moved into a private hand cannot be drawn remotely.
f.hands.Blue[2][1] = f.objects.d00002
f.respond(permissions({ { id = 'private-deck', kind = 'draw', color = 'Red', zone = 2, guid = 'd00002' } })); equal(#f.calls, 1)
f.advance();
equal(#f.requests[#f.requests].data.decks, 1)

-- Revoked credentials stop the loop; server restarts initiate a new connection.
f.respond({ error = 'Revoked' }, 401); equal(#f.timers, 0)
local restart = fixture(); restart.respond({ error = 'Reconnect' }, 409); restart.advance(); assert(restart.requests[#restart.requests].url:match('/connect$'))

-- Save/load preserves applied IDs, preventing a duplicated deal after script reload.
local restored = fixture(f.env.onSave()); restored.respond(permissions({ draw })); equal(#restored.calls, 0)

-- Own cards are played relative to that specific hand and rotated face-up.
local play = fixture(); play.respond(permissions({ { id = 'own-play', kind = 'play', color = 'Red', zone = 1, guid = 'a00001' } }))
equal(#play.calls, 2); equal(play.calls[1].kind, 'play'); equal(play.calls[1].position.x, 35, 'Play must clear large hand zones'); equal(play.calls[2].kind, 'rotation'); equal(play.calls[2].rotation.x, 0)
print('Lua bridge checks passed: two hands, local ownership checks, private decks, draw destination, command deduplication, save/load, revocation, reconnect, and own-card play.')

local privacyId = 'ambulator-private-hands'
local function hidden(object)
    equal(object.invisible[privacyId], true); equal(object.hidden[privacyId], true)
    equal(object.interactable, true, 'Masking must preserve native hand membership'); equal(object.tooltip, false)
end
equal(f.client.color, 'Grey', 'Black must be removed before the first snapshot')
equal(f.env.Hands.enable, true); equal(f.env.Hands.disable_unused, false); equal(f.env.Hands.hiding, 1)
hidden(f.objects.a00001); hidden(f.objects.a00002); hidden(f.objects.b00001)
equal(f.env.onPlayerAction(nil, nil, { f.objects.a00001 }), false, 'Native actions on private cards must be vetoed')
equal(f.env.onPlayerAction(nil, nil, { f.objects.d00001 }), nil, 'Public decks remain usable')
equal(f.env.onPlayerAction(nil, nil, { f.env.self }), nil, 'Host must be able to replace the companion')
-- Privacy remains active after bridge revocation, even for new cards and seats.
f.client.changeColor('Red'); equal(f.client.color, 'Grey')
f.client.color = 'Black'; f.env.Hands.enable = false; f.env.Hands.hiding = 3
f.env.onUpdate(); equal(f.client.color, 'Grey'); equal(f.env.Hands.enable, true); equal(f.env.Hands.hiding, 1)
local fresh = f.card('a00003', 'Fresh ticket')
f.env.onObjectSpawn(fresh); hidden(fresh)
f.env.onObjectLeaveContainer(f.objects.d00001, fresh); equal(#f.frames, 1)
f.hands.Red[2][2] = fresh; f.env.onObjectEnterZone({ tag = 'Hand' }, fresh)
f.frame(); assert(f.settle()); hidden(fresh)
-- Taking a card out manually cannot reveal it. Only approved phone play can.
f.hands.Red[2][2] = nil; hidden(fresh)
local saved = f.env.onSave(); equal(saved.private.a00003.tooltip, true)
local load = fixture(saved, 'a00003'); hidden(load.objects.a00003)

-- Newly spawned public cards are hidden during motion and released once settled.
local market = f.card('e00001', 'Public market'); market.tooltip = false; market.resting = false
f.env.onObjectSpawn(market); hidden(market); f.frame(); equal(f.settle(), false); hidden(market)
market.resting = true; assert(f.settle())
equal(f.env.onPlayerAction(nil, nil, { market }), nil)
equal(market.invisible[privacyId], false); equal(market.hidden[privacyId], false)
equal(market.tooltip, false, 'Do not enable a tooltip disabled by the mod'); equal(market.interactable, true)

-- A played card remains hidden until it clears every hand, including another seat.
hidden(play.objects.a00001); play.frame()
equal(play.settle(), false); hidden(play.objects.a00001)
play.hands.Red[1] = {}; play.hands.Blue[1][2] = play.objects.a00001
equal(play.settle(), false); hidden(play.objects.a00001)
play.hands.Blue[1][2] = nil; assert(play.settle())
equal(play.objects.a00001.invisible[privacyId], false); equal(play.objects.a00001.interactable, true)
equal(play.objects.a00001.tooltip, true); equal(play.env.onSave().private.a00001, nil)
local timeout = fixture(); timeout.respond(permissions({ { id = 'overlap', kind = 'play', color = 'Red', zone = 1, guid = 'a00001' } }))
timeout.frame(); timeout.conditions[1].expired(); hidden(timeout.objects.a00001)
local merge = fixture()
merge.env.onObjectEnterContainer(merge.objects.d00001, merge.objects.a00002)
hidden(merge.objects.d00001)
local discard = fixture(); discard.respond(permissions({ { id = 'discard-play', kind = 'play', color = 'Red', zone = 1, guid = 'a00001' } }))
discard.env.onObjectEnterContainer(discard.objects.d00001, discard.objects.a00001)
equal(discard.objects.d00001.invisible[privacyId], nil, 'Approved plays may enter a public discard')
discard.objects.a00001.destroyed = true; discard.env.onObjectDestroy(discard.objects.a00001)
discard.frame(); assert(discard.settle()); equal(discard.env.onSave().private.a00001, nil, 'Discard merges must clear stale private IDs')
print('Privacy checks passed: spectator guard, invisible hands, no hover/highlight, spawn/deal quarantine, sticky privacy, reload, offline protection, and explicit play only.')

-- One stale card cancels the entire batch before any position/rotation changes.
local batch = fixture(); local second = batch.card('a00003', 'Second train'); batch.hands.Red[1][2] = second
batch.respond(permissions({ { id = 'invalid-batch', kind = 'play', color = 'Red', zone = 1, guids = { 'a00001', 'b00001' } } })); equal(#batch.calls, 0)
batch.advance()
batch.respond(permissions({ { id = 'batch', kind = 'play', color = 'Red', zone = 1, guids = { 'a00001', 'a00003' } } })); equal(#batch.calls, 4)
assert(batch.calls[1].position.z ~= batch.calls[3].position.z, 'Batch cards should be spread along the destination')
hidden(batch.objects.a00001); hidden(second)
batch.hands.Red[1] = {}; batch.frame(); batch.frame(); assert(batch.settle()); assert(batch.settle())
equal(second.invisible[privacyId], false); equal(second.hidden[privacyId], false)

local function withTarget()
    local t = fixture()
    t.env.Global.getSnapPoints = function() return { { position = { x = 0, y = 1, z = 30 }, rotation = { y = 90 }, tags = { 'AmbulatorDrop:Ticket returns', 'AmbulatorFor:Red' } } } end
    t.respond(permissions()); t.advance()
    local metadata = t.requests[#t.requests].data.targets[1]
    local policy = permissions()
    policy.enabledTargets = { ['global:1'] = { zone = 2, faceDown = true, signature = metadata.signature } }
    return t, policy, metadata
end
local returned, returnPolicy, targetMetadata = withTarget()
local returnCommand = { id = 'return-ticket', kind = 'place', color = 'Red', zone = 2, guids = { 'a00002' }, targetId = 'global:1', faceDown = true, signature = targetMetadata.signature }
returnPolicy.commands = { returnCommand }; returned.respond(returnPolicy)
equal(#returned.calls, 2); equal(returned.calls[2].rotation.x, 180); hidden(returned.objects.a00002)
returned.hands.Red[2] = {}; returned.frame(); assert(returned.settle())
equal(returned.objects.a00002.invisible[privacyId], false, 'Returned backs may be visible'); equal(returned.objects.a00002.hidden[privacyId], true, 'Returned faces must stay hidden'); equal(returned.objects.a00002.tooltip, false)
equal(returned.env.onSave().private.a00002.returned, true)
returned.env.onObjectEnterContainer(returned.objects.d00002, returned.objects.a00002)
equal(returned.objects.d00002.hidden[privacyId], true); equal(returned.objects.d00002.tooltip, false)
returned.advance(); local deckFound = false
for _, deck in ipairs(returned.requests[#returned.requests].data.decks) do if deck.guid == 'd00002' then deckFound = true end end
assert(deckFound, 'A face-hidden return deck remains available for approved draws')
local child = returned.card('e00001', 'Returned ticket')
returned.env.onObjectLeaveContainer(returned.objects.d00002, child); hidden(child)
returned.frame(); assert(returned.settle()); equal(child.hidden[privacyId], true); equal(child.invisible[privacyId], false)
local reloadReturn = fixture(returned.env.onSave(), 'e00001')
equal(reloadReturn.objects.e00001.invisible[privacyId], false); equal(reloadReturn.objects.e00001.hidden[privacyId], true); equal(reloadReturn.objects.e00001.tooltip, false)
returned.hands.Red[2][1] = child; returned.env.onObjectEnterZone({ tag = 'Hand' }, child); hidden(child)
equal(returned.env.onSave().private.e00001.returned, nil, 'Reentering a hand restores full privacy')

-- A moved snap point or a changed orientation invalidates the command locally.
local stale, stalePolicy, staleMetadata = withTarget()
stalePolicy.commands = { { id = 'stale-target', kind = 'place', color = 'Red', zone = 2, guid = 'a00002', targetId = 'global:1', faceDown = true, signature = staleMetadata.signature } }
stale.env.Global.getSnapPoints = function() return { { position = { x = 50, y = 1, z = 30 }, tags = { 'AmbulatorDrop:Ticket returns', 'AmbulatorFor:Red' } } } end
stale.respond(stalePolicy); equal(#stale.calls, 0)
local orientation, orientationPolicy, orientationMetadata = withTarget()
orientationPolicy.commands = { { id = 'spoofed-orientation', kind = 'place', color = 'Red', zone = 2, guid = 'a00002', targetId = 'global:1', faceDown = false, signature = orientationMetadata.signature } }
orientation.respond(orientationPolicy); equal(#orientation.calls, 0)
local restricted, restrictedPolicy, restrictedMetadata = withTarget()
restrictedPolicy.seats = { 'Blue' }; restricted.hands.Blue[2][1] = restricted.card('b00002', 'Blue ticket')
restrictedPolicy.commands = { { id = 'wrong-target-color', kind = 'place', color = 'Blue', zone = 2, guid = 'b00002', targetId = 'global:1', faceDown = true, signature = restrictedMetadata.signature } }
restricted.respond(restrictedPolicy); equal(#restricted.calls, 0)

-- A deck that became private outside a hand cannot execute a stale draw.
local stickyDeck = fixture(); stickyDeck.env.onObjectEnterContainer(stickyDeck.objects.d00002, stickyDeck.objects.a00002)
stickyDeck.respond(permissions({ { id = 'sticky-deck', kind = 'draw', color = 'Red', zone = 2, guid = 'd00002' } })); equal(#stickyDeck.calls, 0)

-- Discover only public controls and execute the host-approved native owner.
local buttons = fixture(); local public = buttons.card('e00002', 'Public button', 'BlockSquare'); public.adapter = true; public.tags = { 'AmbulatorFor:Red' }
public.buttons = { { index = 0, label = 'Draw tickets', click_function = 'drawTickets', function_owner = public, width = 600, height = 300 } }
buttons.objects.a00002.buttons = public.buttons -- Private objects must not expose controls.
buttons.respond(permissions()); buttons.advance(); local catalog = buttons.requests[#buttons.requests].data.buttons
equal(#catalog, 1); equal(catalog[1].id, 'e00002:0'); equal(catalog[1].ready, true)
local buttonPolicy = permissions(); buttonPolicy.enabledButtons = { ['e00002:0'] = { signature = catalog[1].signature, colors = { 'Red' } } }
local buttonCommand = { id = 'press', kind = 'button', color = 'Red', buttonId = 'e00002:0', signature = catalog[1].signature }
buttonPolicy.commands = { buttonCommand }; buttons.respond(buttonPolicy); equal(#buttons.calls, 1); equal(buttons.calls[1].args.color, 'Red'); equal(buttons.calls[1].args.index, 0); equal(buttons.calls[1].args.objectGuid, 'e00002')
buttons.advance(); public.buttons[1].click_function = 'changedCallback'; buttonCommand.id = 'changed'; buttons.respond(buttonPolicy); equal(#buttons.calls, 1)
buttons.advance(); public.buttons[1].click_function = 'drawTickets'; public.adapter = false; buttonCommand.id = 'removed-adapter'; buttons.respond(buttonPolicy); equal(#buttons.calls, 1)

-- Run the actual adapter inside the owner sandbox with a classic three-argument callback.
local adapterOwner, adapterObject = {}, {}
adapterObject.getButtons = function() return { { index = 0, function_owner = adapterOwner, click_function = 'originalCallback' } } end
local adapterCalls = 0
local adapterEnv = { self = adapterOwner, Global = {}, getObjectFromGUID = function(guid) if guid == 'e00002' then return adapterObject end end }
adapterEnv.originalCallback = function(object, color, alt) equal(object, adapterObject); equal(color, 'Red'); equal(alt, false); adapterCalls = adapterCalls + 1; return 'ok' end
adapterEnv._G = adapterEnv; setmetatable(adapterEnv, { __index = _G })
assert(loadfile('lua/button-adapter.lua', 't', adapterEnv))()
equal(adapterEnv.ambulatorPressButton({ objectGuid = 'e00002', index = 0, color = 'Red' }), 'ok'); equal(adapterCalls, 1)
assert(not pcall(adapterEnv.ambulatorPressButton, { objectGuid = 'e00002', index = 1, color = 'Red' }))
adapterObject.getButtons = function() return { { index = 0, function_owner = {}, click_function = 'originalCallback' } } end
assert(not pcall(adapterEnv.ambulatorPressButton, { objectGuid = 'e00002', index = 0, color = 'Red' })); equal(adapterCalls, 1)
-- Global-owned classic buttons work even when Global has no self variable.
adapterEnv.self = nil; adapterEnv.Global = adapterOwner
adapterObject.getButtons = function() return { { index = 0, click_function = 'originalCallback' } } end
equal(adapterEnv.ambulatorPressButton({ objectGuid = 'e00002', index = 0, color = 'Red' }), 'ok'); equal(adapterCalls, 2)
print('Milestone checks passed: whole-batch validation, spreading, approved targets, face-hidden returns/merges/reloads, stale controls, private control filtering, and native callback adapter signature.')
