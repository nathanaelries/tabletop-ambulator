-- Optional classic-button adapter. Append to the button's function_owner
-- script (Global or an object); retain all existing mod code.
-- The companion verifies host approval and button identity before calling it.
function ambulatorPressButton(request)
    assert(type(request) == 'table' and type(request.objectGuid) == 'string')
    local object = getObjectFromGUID(request.objectGuid)
    assert(object, 'Button object no longer exists.')
    for _, button in ipairs(object.getButtons() or {}) do
        if button.index == request.index then
            assert((button.function_owner or Global) == (self or Global), 'Button owner changed.')
            local callback = _G[button.click_function]
            assert(type(callback) == 'function', 'Button callback is unavailable.')
            return callback(object, request.color, false)
        end
    end
    error('Button no longer exists.')
end
