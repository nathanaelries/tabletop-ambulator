-- Ambulator fork, derived from 64bits/tabletop-ambulator (MIT).
-- Generated for one room. This object contains a credential: do not publish it.
local target = '__ORIGIN__'
local room = '__ROOM__'
local credential = '__TOKEN__'
local session = nil
local sequence = 0
local completed = {}
local completedOrder = {}
local pendingAcks = {}
local stopped = false
local retrySeconds = 1
local lastErrorAt = -100
local privacyId = 'ambulator-private-hands'
local privateObjects = {}
local transientObjects = {}
local publishing = {}
local privacyReady = false
local changingSeats = false

-- Every TTS client is a shared board viewer. Private views live on phones.
-- Black bypasses TTS hiders, so prevent entering any player/GM seat.
local function spectatorsOnly()
    if changingSeats then return end
    changingSeats = true
    for _, player in ipairs(Player.getPlayers()) do
        if player.color ~= 'Grey' then player.changeColor('Grey') end
    end
    changingSeats = false
end

local function handObjects(visitor)
    for _, color in ipairs(Player.getColors()) do
        if color ~= 'Grey' then
            local player = Player[color]
            if player then
                for index = 1, player.getHandCount() do
                    for _, object in ipairs(player.getHandObjects(index)) do visitor(object) end
                end
            end
        end
    end
end

local function inAnyHand(guid)
    local found = false
    handObjects(function(object) if object.getGUID() == guid then found = true end end)
    return found
end

local function originalFlags(object)
    return { tooltip = object.tooltip, interactable = object.interactable }
end

local function mask(object)
    -- Independent IDs preserve the mod's own hiding effects.
    object.attachInvisibleHider(privacyId, true)
    object.attachHider(privacyId, true)
    object.tooltip = false
    -- interactable=false removes cards from TTS's hand API. Veto native
    -- player actions below instead, preserving the game's hand membership.
end

local function makePrivate(object)
    local guid = object.getGUID()
    privateObjects[guid] = privateObjects[guid] or transientObjects[guid] or originalFlags(object)
    transientObjects[guid] = nil
    mask(object)
end

local function reveal(object, flags)
    object.attachInvisibleHider(privacyId, false)
    object.attachHider(privacyId, false)
    object.tooltip = flags.tooltip
    object.interactable = flags.interactable
end

local function protectHands()
    Hands.enable = true
    Hands.disable_unused = false
    Hands.hiding = 1
    handObjects(makePrivate)
end

local function quarantine(object)
    if not privacyReady or (object.tag ~= 'Card' and object.tag ~= 'CardCustom' and
        object.tag ~= 'Deck' and object.tag ~= 'DeckCustom') then return end
    local guid = object.getGUID()
    if privateObjects[guid] then makePrivate(object); return end
    if transientObjects[guid] then return end
    local pending = originalFlags(object)
    transientObjects[guid] = pending
    mask(object)
    -- Hide new cards before deal animations. Only settled public objects are
    -- released; a card that enters a hand becomes permanently private.
    Wait.frames(function()
        Wait.condition(function()
            if transientObjects[guid] ~= pending then return end
            if object.isDestroyed() then transientObjects[guid] = nil; return end
            if privateObjects[guid] or inAnyHand(guid) then makePrivate(object); return end
            local flags = transientObjects[guid]
            if flags then transientObjects[guid] = nil; reveal(object, flags) end
        end, function()
            return object.isDestroyed() or (object.resting and not object.isSmoothMoving())
        end)
    end, 2)
end

local function request(path, data, callback)
    WebRequest.custom(target .. '/api/rooms/' .. room .. '/bridge/' .. path,
        'POST', true, JSON.encode(data), {
            Authorization = 'Bearer ' .. credential,
            ['Content-Type'] = 'application/json', Accept = 'application/json'
        }, callback)
end

local function decode(response)
    if response.is_error or response.response_code ~= 200 then return nil end
    local ok, result = pcall(JSON.decode, response.text)
    if ok and type(result) == 'table' then return result end
    return nil
end

local function errorMessage(response)
    if Time.time - lastErrorAt < 30 then return end
    lastErrorAt = Time.time
    local ok, result = pcall(JSON.decode, response.text or '')
    local detail = ok and type(result) == 'table' and result.error or 'Connection unavailable.'
    print('Ambulator: ' .. detail)
end

local function name(object, fallback)
    local value = (object.getName() or ''):gsub('[%c]', ' '):sub(1, 120)
    if value:match('^%s*$') then return fallback end
    return value
end

local function snapshot()
    protectHands()
    local hands, decks, inHand = {}, {}, {}
    for _, color in ipairs(Player.getColors()) do
        -- Grey is a spectator color, but TTS does not expose Player.Grey.
        local player = color ~= 'Grey' and Player[color] or nil
        if color ~= 'Grey' and color ~= 'Black' and player and player.getHandCount() > 0 then
            hands[color] = {}
            for index = 1, math.min(player.getHandCount(), 8) do
                local cards = {}
                for _, object in ipairs(player.getHandObjects(index)) do
                    inHand[object.getGUID()] = true
                    if object.tag == 'Card' or object.tag == 'CardCustom' then
                        local card = { guid = object.getGUID(), name = name(object, 'Card') }
                        local ok, parsed = pcall(JSON.decode, object.getJSON())
                        if ok and parsed.CardID and parsed.CustomDeck then
                            local id = math.floor(parsed.CardID / 100)
                            local custom = parsed.CustomDeck[tostring(id)] or parsed.CustomDeck[id]
                            if custom and custom.FaceURL and custom.FaceURL ~= '' then
                                card.face = custom.FaceURL:gsub('^http://', 'https://')
                                card.columns = custom.NumWidth or 1
                                card.rows = custom.NumHeight or 1
                                card.offset = parsed.CardID % 100
                            end
                        end
                        table.insert(cards, card)
                    end
                end
                table.insert(hands[color], { index = index, cards = cards })
            end
        end
    end
    for _, object in ipairs(getAllObjects()) do
        if (object.tag == 'Deck' or object.tag == 'DeckCustom') and not inHand[object.getGUID()] and not privateObjects[object.getGUID()] then
            table.insert(decks, { guid = object.getGUID(), name = name(object, 'Deck ' .. object.getGUID()) })
        end
    end
    return hands, decks
end

local function ownsCard(color, index, guid)
    local player = Player[color]
    if not player or index < 1 or index > player.getHandCount() then return false end
    for _, object in ipairs(player.getHandObjects(index)) do
        if object.getGUID() == guid and (object.tag == 'Card' or object.tag == 'CardCustom') then return true end
    end
    return false
end

local function approved(color, seats)
    for _, seat in ipairs(seats or {}) do if seat == color then return true end end
    return false
end

local function execute(command, permissions)
    if not approved(command.color, permissions.seats) then return end
    local object = getObjectFromGUID(command.guid)
    if not object then return end
    if command.kind == 'draw' then
        local player = Player[command.color]
        if permissions.enabledDecks[command.guid] ~= command.zone or not player or
            command.zone > player.getHandCount() or command.zone < 1 then return end
        if object.tag ~= 'Deck' and object.tag ~= 'DeckCustom' then return end
        -- A deck may have been moved into someone's hand since the last snapshot.
        for _, color in ipairs(Player.getColors()) do
            local owner = color ~= 'Grey' and Player[color] or nil
            if owner then
                for index = 1, owner.getHandCount() do
                    for _, held in ipairs(owner.getHandObjects(index)) do
                        if held.getGUID() == command.guid then return end
                    end
                end
            end
        end
        object.deal(1, command.color, command.zone)
        return
    end
    if not ownsCard(command.color, command.zone, command.guid) then return end
    if command.kind == 'play' then
        local zone = permissions.zones[tostring(command.zone)] or permissions.zones[command.zone]
        if not zone or zone.play ~= true then return end
        local hand = Player[command.color].getHandTransform(command.zone)
        local rotation = hand.rotation.y * math.pi / 180
        -- Some mods have large hand volumes. A fixed offset can land back in
        -- the hand; use its depth plus clearance and move out directly.
        local distance = math.max(6, hand.scale.z + 2)
        makePrivate(object)
        publishing[command.guid] = true
        object.setPosition({
            x = hand.position.x + math.sin(rotation) * distance,
            y = hand.position.y + 1,
            z = hand.position.z + math.cos(rotation) * distance
        })
        if object.is_face_down then object.flip() end
        Wait.frames(function()
            Wait.condition(function()
                if object.isDestroyed() then
                    privateObjects[command.guid] = nil
                    publishing[command.guid] = nil
                    return
                end
                local flags = privateObjects[command.guid]
                if flags then
                    privateObjects[command.guid] = nil
                    publishing[command.guid] = nil
                    reveal(object, flags)
                end
            end, function()
                return object.isDestroyed() or not inAnyHand(command.guid)
            end, 5, function()
                publishing[command.guid] = nil
                print('Ambulator: play position overlaps a hand; the card stays private.')
            end)
        end, 2)
    end
end

local function remember(id)
    completed[id] = true
    table.insert(completedOrder, id)
    while #completedOrder > 200 do completed[table.remove(completedOrder, 1)] = nil end
end

local sync
local connect
local function later(fn, seconds)
    if not stopped then Wait.time(function() if not stopped then fn() end end, seconds) end
end

sync = function()
    if stopped or not session then return end
    local hands, decks = snapshot()
    sequence = sequence + 1
    local sentAcks = pendingAcks
    request('sync', { session = session, sequence = sequence, hands = hands, decks = decks, acks = sentAcks }, function(response)
        if stopped then return end
        local result = decode(response)
        if not result then
            errorMessage(response)
            if response.response_code == 401 or response.response_code == 404 then stopped = true; return end
            if response.response_code == 409 then session = nil; later(connect, retrySeconds)
            else later(sync, retrySeconds) end
            retrySeconds = math.min(retrySeconds * 2, 30)
            return
        end
        retrySeconds = 1
        pendingAcks = {}
        for _, command in ipairs(result.commands or {}) do
            if not completed[command.id] then
                -- Mark before execution: an exception must never cause a repeated deal.
                remember(command.id)
                local ok = pcall(execute, command, result)
                if not ok then
                    publishing[command.guid] = nil
                    print('Ambulator: a card action could not be applied; ask the host.')
                end
            end
            table.insert(pendingAcks, command.id)
        end
        later(sync, 1)
    end)
end

connect = function()
    if stopped then return end
    request('connect', { connect = true }, function(response)
        if stopped then return end
        local result = decode(response)
        if not result or not result.session then
            errorMessage(response)
            if response.response_code == 401 or response.response_code == 404 then stopped = true; return end
            later(connect, retrySeconds); retrySeconds = math.min(retrySeconds * 2, 30); return
        end
        session = result.session; sequence = 0; pendingAcks = {}; retrySeconds = 1
        sync()
    end)
end

function onLoad(saved)
    stopped = false
    if saved and saved ~= '' then
        local ok, state = pcall(JSON.decode, saved)
        if ok and type(state) == 'table' then
            for _, id in ipairs(state.completed or {}) do remember(id) end
            for guid, flags in pairs(state.private or {}) do
                if type(guid) == 'string' and guid:match('^%x%x%x%x%x%x$') and
                    type(flags) == 'table' and type(flags.tooltip) == 'boolean' and
                    type(flags.interactable) == 'boolean' then privateObjects[guid] = flags end
            end
        end
    end
    spectatorsOnly()
    privacyReady = true
    protectHands()
    for guid in pairs(privateObjects) do
        local object = getObjectFromGUID(guid)
        if object then mask(object) end
    end
    self.setLock(true)
    self.setName('Ambulator ' .. room)
    print('Ambulator room ' .. room .. ': join at ' .. target .. '/?room=' .. room)
    connect()
end

-- Privacy continues when the network is disconnected or the room is revoked.
function onUpdate()
    spectatorsOnly()
    Hands.enable = true
    Hands.disable_unused = false
    Hands.hiding = 1
end
function onPlayerChangeColor() spectatorsOnly() end
function onPlayerConnect() spectatorsOnly() end
function onPlayerAction(_, _, targets)
    for _, object in ipairs(targets or {}) do
        local guid = object.getGUID()
        if privateObjects[guid] or transientObjects[guid] then return false end
    end
end
function onObjectEnterZone(zone, object)
    if privacyReady and zone.tag == 'Hand' then makePrivate(object) end
end
function onObjectSpawn(object) quarantine(object) end
function onObjectLeaveContainer(_, object) quarantine(object) end
function onObjectEnterContainer(container, object)
    local guid = object.getGUID()
    -- A private card merged by a mod must not become a public deck. Explicit
    -- plays may merge into the public discard pile without retaining stale IDs.
    if privateObjects[guid] and not publishing[guid] then makePrivate(container) end
end
function onObjectDestroy(object)
    local guid = object.getGUID()
    if publishing[guid] then privateObjects[guid] = nil; publishing[guid] = nil end
end
function onSave() return JSON.encode({ completed = completedOrder, private = privateObjects }) end
function onDestroy() stopped = true end
