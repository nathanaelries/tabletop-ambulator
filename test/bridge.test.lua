-- Exercise the actual bridge with a mocked TTS host, not a second implementation.
local function equal(actual, expected, message)
    assert(actual == expected, (message or 'Unexpected value') .. ': ' .. tostring(actual) .. ' ~= ' .. tostring(expected))
end
local function fixture(saved)
    local requests, timers, objects, calls, errors = {}, {}, {}, {}, {}
    local hands = { Red = { {}, {} }, Blue = { {}, {} } }
    local function card(guid, label, tag)
        local object = {
            tag = tag or 'Card', is_face_down = true,
            getGUID = function() return guid end,
            getName = function() return label end,
            getJSON = function() return { CardID = 101, CustomDeck = { ['1'] = { FaceURL = 'http://i.imgur.com/sheet.png', NumWidth = 2, NumHeight = 2 } } } end,
            highlightOn = function() calls[#calls + 1] = { kind = 'highlight', guid = guid } end,
            setPosition = function(position) calls[#calls + 1] = { kind = 'play', guid = guid, position = position } end,
            flip = function() calls[#calls + 1] = { kind = 'flip', guid = guid } end,
            deal = function(count, color, index) calls[#calls + 1] = { kind = 'draw', count = count, color = color, zone = index } end
        }
        objects[guid] = object; return object
    end
    hands.Red[1][1] = card('a00001', 'Train'); hands.Red[2][1] = card('a00002', 'Ticket'); hands.Blue[1][1] = card('b00001', 'Other train');
    card('d00001', 'Train deck', 'Deck'); card('d00002', 'Ticket deck', 'Deck');
    local Player = { getColors = function() return { 'Red', 'Blue', 'Grey', 'Black' } end }
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
        Player = Player, Time = { time = 100 },
        JSON = { encode = function(data) return data end, decode = function(data) assert(type(data) == 'table'); return data end },
        self = { setName = function() end },
        print = function(message) errors[#errors + 1] = message end,
        WebRequest = { custom = function(url, method, download, data, headers, callback)
            requests[#requests + 1] = { url = url, method = method, data = data, headers = headers, callback = callback }
        end },
        Wait = { time = function(fn, seconds) timers[#timers + 1] = { fn = fn, seconds = seconds } end },
        getObjectFromGUID = function(guid) return objects[guid] end,
        getAllObjects = function() local result = {}; for _, object in pairs(objects) do result[#result + 1] = object end; return result end
    }, { __index = _G })
    assert(loadfile('lua/bridge.lua', 't', env))(); env.onLoad(saved or '')
    local function respond(data, status, error)
        local request = requests[#requests]; request.callback({ is_error = error or false, response_code = status or 200, text = data })
    end
    respond({ session = 'session' });
    local function advance() local timer = table.remove(timers, 1); assert(timer); timer.fn() end
    return { env = env, requests = requests, timers = timers, hands = hands, objects = objects, calls = calls, respond = respond, advance = advance }
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
equal(#f.calls, 1); equal(f.calls[1].guid, 'a00002'); equal(f.calls[1].kind, 'highlight')
f.advance(); equal(#f.requests[3].data.acks, 5)

-- A stale snapshot must not permit playing a card moved to another player's hand.
f.hands.Red[1] = {}; f.hands.Blue[1][2] = f.objects.a00001
f.respond(permissions({ { id = 'moved', kind = 'play', color = 'Red', zone = 1, guid = 'a00001' } }))
equal(#f.calls, 1); f.advance()

-- Drawing targets the configured secondary hand. Retried command IDs deal once.
local draw = { id = 'draw-ticket', kind = 'draw', color = 'Red', zone = 2, guid = 'd00002' }
f.respond(permissions({ draw })); equal(#f.calls, 2); equal(f.calls[2].zone, 2); equal(f.calls[2].color, 'Red')
f.advance(); f.respond({ error = 'Lost response' }, 503, true); f.advance(); f.respond(permissions({ draw })); equal(#f.calls, 2)
f.advance()

-- Decks moved into a private hand cannot be drawn remotely.
f.hands.Blue[2][1] = f.objects.d00002
f.respond(permissions({ { id = 'private-deck', kind = 'draw', color = 'Red', zone = 2, guid = 'd00002' } })); equal(#f.calls, 2)
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
