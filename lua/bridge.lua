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
    local hands, decks, inHand = {}, {}, {}
    for _, color in ipairs(Player.getColors()) do
        local player = Player[color]
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
        if (object.tag == 'Deck' or object.tag == 'DeckCustom') and not inHand[object.getGUID()] then
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
            local owner = Player[color]
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
    if command.kind == 'highlight' then
        object.highlightOn({ 0.25, 0.85, 0.7 }, 4)
    elseif command.kind == 'play' then
        local zone = permissions.zones[tostring(command.zone)] or permissions.zones[command.zone]
        if not zone or zone.play ~= true then return end
        local hand = Player[command.color].getHandTransform(command.zone)
        local rotation = hand.rotation.y * math.pi / 180
        object.setPositionSmooth({
            x = hand.position.x + math.sin(rotation) * 6,
            y = hand.position.y + 1,
            z = hand.position.z + math.cos(rotation) * 6
        }, false, true)
        if object.is_face_down then object.flip() end
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
                if not ok then print('Ambulator: a card action could not be applied; ask the host.') end
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
        end
    end
    self.setName('Ambulator ' .. room)
    print('Ambulator room ' .. room .. ': join at ' .. target .. '/?room=' .. room)
    connect()
end

function onSave() return JSON.encode({ completed = completedOrder }) end
function onDestroy() stopped = true end
