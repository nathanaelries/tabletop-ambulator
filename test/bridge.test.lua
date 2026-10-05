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

-- Own cards are played relative to that specific hand, and flipped only face-down.
local play = fixture(); play.respond(permissions({ { id = 'own-play', kind = 'play', color = 'Red', zone = 1, guid = 'a00001' } }))
equal(#play.calls, 2); equal(play.calls[1].kind, 'play'); equal(play.calls[1].position.x, 35, 'Play must clear large hand zones'); equal(play.calls[2].kind, 'flip')
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
