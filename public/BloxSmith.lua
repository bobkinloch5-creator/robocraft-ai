-- BloxSmith Roblox Studio Plugin
-- Full game-building agent: syncs scripts AND executes build actions
-- (parts, models, terrain, lighting, services) sent from bloxsmith.pro.
-- Also reports full workspace context back to the AI so it has awareness.
--
-- Save as a Local Plugin: File > Advanced > Save as Local Plugin

local HttpService           = game:GetService("HttpService")
local ChangeHistoryService  = game:GetService("ChangeHistoryService")
local Selection             = game:GetService("Selection")
local Lighting              = game:GetService("Lighting")
local Workspace             = game:GetService("Workspace")
local ServerScriptService   = game:GetService("ServerScriptService")
local ServerStorage         = game:GetService("ServerStorage")
local ReplicatedStorage     = game:GetService("ReplicatedStorage")
local ReplicatedFirst       = game:GetService("ReplicatedFirst")
local StarterPlayer         = game:GetService("StarterPlayer")
local StarterGui            = game:GetService("StarterGui")
local StarterPack           = game:GetService("StarterPack")
local SoundService          = game:GetService("SoundService")
local Teams                 = game:GetService("Teams")
local Terrain               = Workspace.Terrain

-- API base is user-configurable so the plugin works against bloxsmith.pro
-- (production) AND any Lovable preview / staging URL the user is testing.
local DEFAULT_API   = "https://bloxsmith.pro/api/public/plugin"
local POLL_SECONDS  = 0.5
local CTX_SECONDS   = 15  -- how often we re-send workspace context to the AI
local SCAN_TIMEOUT_SECONDS = 15
local pushSnapshot
local showScriptPromptDialog
local instancePath
local scanInProgress = false
local scanCancelRequested = false
local connected = false
local shouldBeConnected = false
local activeProjectId = nil
local activeProjectName = nil
local lastFingerprint = nil
local lastContextSentAt = 0

local function getApiBase()
	local v = plugin:GetSetting("bs_api_base")
	if type(v) == "string" and v ~= "" then return v end
	return DEFAULT_API
end
local function setApiBase(v) plugin:SetSetting("bs_api_base", v) end

----------------------------------------------------------------
-- Toolbar / widget
----------------------------------------------------------------
local toolbar = plugin:CreateToolbar("BloxSmith")
local button  = toolbar:CreateButton("BloxSmith", "Connect BloxSmith AI",
	"rbxasset://textures/StudioToolbox/Search.png")

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right, false, false, 320, 460, 300, 420)
local widget = plugin:CreateDockWidgetPluginGui("BloxSmith", widgetInfo)
widget.Title = "BloxSmith AI"

local function getToken()    return plugin:GetSetting("bs_token")    or "" end
local function setToken(v)   plugin:SetSetting("bs_token", v) end
local function getConsent()  return plugin:GetSetting("bs_consent_v1") == true end
local function setConsent(v) plugin:SetSetting("bs_consent_v1", v) end
local function getPaused()   return plugin:GetSetting("bs_paused") == true end
local function setPaused(v)  plugin:SetSetting("bs_paused", v) end
local function getPreview()  return plugin:GetSetting("bs_preview") == true end
local function setPreview(v) plugin:SetSetting("bs_preview", v) end
-- Clear Mode: when ON, the plugin ONLY applies incoming actions. It will
-- never scan/push your project files, never re-materialize file lists,
-- and never auto-send workspace context. Useful when the sync is noisy
-- or you only want the AI to push changes you've explicitly asked for.
local function getClearMode()  return plugin:GetSetting("bs_clear_mode") == true end
local function setClearMode(v) plugin:SetSetting("bs_clear_mode", v) end

local function postJSON(path, body)
	local apiBase = getApiBase()
	local url = apiBase .. path
	if string.sub(path, 1, 12) == "/api/studio/" then
		local hostBase = string.gsub(apiBase, "/api/public/plugin", "")
		url = hostBase .. path
	end

	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = url, Method = "POST",
			Headers = {
				["Content-Type"]  = "application/json",
				["x-plugin-token"] = getToken(),
			},
			Body = HttpService:JSONEncode(body or {}),
		})
	end)
	if not ok then return nil, tostring(res) end
	if not res.Success then return nil, "HTTP " .. tostring(res.StatusCode) end
	local okDecode, decoded = pcall(function() return HttpService:JSONDecode(res.Body) end)
	if not okDecode then return nil, "Bad JSON" end
	return decoded
end

----------------------------------------------------------------
-- UI (polished)
----------------------------------------------------------------
local C = {
	bg        = Color3.fromRGB(13, 13, 24),
	panel     = Color3.fromRGB(22, 22, 38),
	stroke    = Color3.fromRGB(45, 45, 70),
	primary   = Color3.fromRGB(99, 91, 255),
	primaryHi = Color3.fromRGB(124, 116, 255),
	disconnect= Color3.fromRGB(60, 60, 90),
	text      = Color3.fromRGB(235, 235, 245),
	textDim   = Color3.fromRGB(150, 150, 175),
	textMute  = Color3.fromRGB(105, 105, 130),
	accent    = Color3.fromRGB(160, 150, 255),
	success   = Color3.fromRGB(80, 220, 160),
	idle      = Color3.fromRGB(120, 120, 150),
}

local UI_Elements = {
	bg = {},
	panel = {},
	text = {},
	textDim = {},
	textMute = {},
	stroke = {},
}

local function register(element, category)
	if not UI_Elements[category] then UI_Elements[category] = {} end
	table.insert(UI_Elements[category], element)
end

local function corner(p, r) local c = Instance.new("UICorner", p); c.CornerRadius = UDim.new(0, r or 8); return c end
local function stroke(p, col, t)
	local s = Instance.new("UIStroke", p)
	s.Color = col or C.stroke
	s.Thickness = t or 1
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	register(s, "stroke")
	return s
end
local function padAll(p, n) local u = Instance.new("UIPadding", p); u.PaddingTop = UDim.new(0,n); u.PaddingBottom = UDim.new(0,n); u.PaddingLeft = UDim.new(0,n); u.PaddingRight = UDim.new(0,n); return u end

-- Premium helpers ------------------------------------------------
-- Diagonal gradient fill (used on logo + primary button for depth).
local function gradient(p, c1, c2, rot)
	local g = Instance.new("UIGradient", p)
	g.Color = ColorSequence.new(c1, c2)
	g.Rotation = rot or 115
	return g
end

-- Soft drop shadow behind a frame, via a sliced shadow image.
local function shadow(p, transparency, spread)
	local s = Instance.new("ImageLabel")
	s.Name = "Shadow"
	s.BackgroundTransparency = 1
	s.Image = "rbxasset://textures/ui/Controls/DropShadow.png"
	s.ScaleType = Enum.ScaleType.Slice
	s.SliceCenter = Rect.new(12, 12, 13, 13)
	s.ImageColor3 = Color3.new(0, 0, 0)
	s.ImageTransparency = transparency or 0.62
	s.ZIndex = 0
	local sp = spread or 11
	s.Size = UDim2.new(1, sp * 2, 1, sp * 2)
	s.Position = UDim2.new(0, -sp, 0, -sp + 3)
	s.Parent = p
	return s
end

-- Vertical sheen on a panel — lighter at top, reads as a lit surface.
-- Pure UIGradient (not a GuiObject), so it never disturbs UIListLayout.
local function sheen(p)
	local g = Instance.new("UIGradient", p)
	g.Rotation = 90
	g.Color = ColorSequence.new({
		ColorSequenceKeypoint.new(0, Color3.fromRGB(255, 255, 255)),
		ColorSequenceKeypoint.new(1, Color3.fromRGB(225, 225, 235)),
	})
	g.Transparency = NumberSequence.new(0)
	return g
end

local scroll = Instance.new("ScrollingFrame", widget)
scroll.Size = UDim2.fromScale(1,1)
scroll.BackgroundTransparency = 1
scroll.BorderSizePixel = 0
scroll.ScrollBarThickness = 4
scroll.CanvasSize = UDim2.fromScale(0,0)
scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
padAll(scroll, 12)

local root = Instance.new("Frame", scroll)
root.Size = UDim2.new(1,0,0,0)
root.AutomaticSize = Enum.AutomaticSize.Y
root.BackgroundTransparency = 1
root.BorderSizePixel = 0

local list = Instance.new("UIListLayout", root)
list.Padding = UDim.new(0,10)
list.SortOrder = Enum.SortOrder.LayoutOrder

-- Header: logo + title + status pill
local header = Instance.new("Frame", root)
header.LayoutOrder = 1
header.BackgroundTransparency = 1
header.Size = UDim2.new(1,0,0,28)

local logo = Instance.new("Frame", header)
logo.Size = UDim2.fromOffset(26, 26)
logo.Position = UDim2.new(0,0,0.5,-13)
logo.BackgroundColor3 = C.primary
logo.BorderSizePixel = 0
corner(logo, 8)
gradient(logo, Color3.fromRGB(140, 120, 255), Color3.fromRGB(88, 70, 230), 125)
local logoGlow = Instance.new("UIStroke", logo)
logoGlow.Color = Color3.fromRGB(150, 135, 255)
logoGlow.Thickness = 1
logoGlow.Transparency = 0.45
local logoText = Instance.new("TextLabel", logo)
logoText.BackgroundTransparency = 1; logoText.Size = UDim2.fromScale(1,1)
logoText.Font = Enum.Font.GothamBold; logoText.TextSize = 14
logoText.TextColor3 = Color3.new(1,1,1); logoText.Text = "B"

local title = Instance.new("TextLabel", header)
title.BackgroundTransparency = 1
title.Position = UDim2.new(0,32,0,0)
title.Size = UDim2.new(1,-130,1,0)
title.Font = Enum.Font.GothamBold; title.TextSize = 14
title.TextColor3 = C.text
register(title, "text")
title.Text = "BloxSmith AI"
title.TextXAlignment = Enum.TextXAlignment.Left
title.TextYAlignment = Enum.TextYAlignment.Center

local pill = Instance.new("Frame", header)
pill.AnchorPoint = Vector2.new(1, 0.5)
pill.Position = UDim2.new(1, 0, 0.5, 0)
pill.Size = UDim2.fromOffset(94, 22)
pill.BackgroundColor3 = C.panel
register(pill, "panel")
pill.BorderSizePixel = 0
corner(pill, 11)
stroke(pill, C.stroke, 1)

local pillDot = Instance.new("Frame", pill)
pillDot.Size = UDim2.fromOffset(6,6)
pillDot.Position = UDim2.new(0, 11, 0.5, -3)
pillDot.BackgroundColor3 = C.idle
pillDot.BorderSizePixel = 0
corner(pillDot, 3)
local pillDotGlow = Instance.new("UIStroke", pillDot)
pillDotGlow.Color = C.idle
pillDotGlow.Thickness = 3
pillDotGlow.Transparency = 0.6

local pillText = Instance.new("TextLabel", pill)
pillText.BackgroundTransparency = 1
pillText.Position = UDim2.new(0, 22, 0, 0)
pillText.Size = UDim2.new(1, -28, 1, 0)
pillText.Font = Enum.Font.GothamMedium; pillText.TextSize = 10
pillText.TextColor3 = C.textDim
pillText.Text = "Offline"
pillText.TextXAlignment = Enum.TextXAlignment.Left

local subtitle = Instance.new("TextLabel", root)
subtitle.LayoutOrder = 2
subtitle.BackgroundTransparency = 1
subtitle.Size = UDim2.new(1,0,0,14)
subtitle.Font = Enum.Font.Gotham; subtitle.TextSize = 11
subtitle.TextColor3 = C.textMute
register(subtitle, "textMute")
subtitle.Text = "Build Roblox games with AI"
subtitle.TextXAlignment = Enum.TextXAlignment.Left

-- Token label + input
local tokenLabel = Instance.new("TextLabel", root)
tokenLabel.LayoutOrder = 3
tokenLabel.BackgroundTransparency = 1
tokenLabel.Size = UDim2.new(1,0,0,14)
tokenLabel.Font = Enum.Font.GothamMedium; tokenLabel.TextSize = 10
tokenLabel.TextColor3 = C.textDim
register(tokenLabel, "textDim")
tokenLabel.Text = "PLUGIN TOKEN"
tokenLabel.TextXAlignment = Enum.TextXAlignment.Left

local tokenWrap = Instance.new("Frame", root)
tokenWrap.LayoutOrder = 4
tokenWrap.Size = UDim2.new(1,0,0,34)
tokenWrap.BackgroundColor3 = C.panel
register(tokenWrap, "panel")
tokenWrap.BorderSizePixel = 0
corner(tokenWrap, 8)
local tokenStroke = stroke(tokenWrap, C.stroke, 1)

local tokenBox = Instance.new("TextBox", tokenWrap)
tokenBox.Size = UDim2.new(1,-20,1,0)
tokenBox.Position = UDim2.new(0,10,0,0)
tokenBox.BackgroundTransparency = 1
tokenBox.TextColor3 = C.text
register(tokenBox, "text")
tokenBox.Text = getToken()
tokenBox.PlaceholderText = "Paste your plugin token"
tokenBox.PlaceholderColor3 = C.textMute
tokenBox.Font = Enum.Font.Code; tokenBox.TextSize = 12
tokenBox.ClearTextOnFocus = false
tokenBox.TextXAlignment = Enum.TextXAlignment.Left
tokenBox.Focused:Connect(function() tokenStroke.Color = C.primary; tokenStroke.Thickness = 1.5 end)
tokenBox.FocusLost:Connect(function() tokenStroke.Color = C.stroke; tokenStroke.Thickness = 1 end)

-- Primary button
local connectBtn = Instance.new("TextButton", root)
connectBtn.LayoutOrder = 5
connectBtn.Size = UDim2.new(1,0,0,38)
connectBtn.BackgroundColor3 = C.primary
connectBtn.TextColor3 = Color3.new(1,1,1)
connectBtn.Text = "Connect"
connectBtn.Font = Enum.Font.GothamBold; connectBtn.TextSize = 13
connectBtn.BorderSizePixel = 0
connectBtn.AutoButtonColor = false
corner(connectBtn, 9)
shadow(connectBtn, 0.7, 9)
local connectGrad = gradient(connectBtn,
	Color3.fromRGB(132, 118, 255), Color3.fromRGB(92, 78, 232), 115)
connectBtn:SetAttribute("Base", "primary")
connectBtn.MouseEnter:Connect(function()
	if connectBtn:GetAttribute("Base") == "primary" then
		connectGrad.Color = ColorSequence.new(
			Color3.fromRGB(150, 138, 255), Color3.fromRGB(108, 94, 248))
	else
		connectBtn.BackgroundColor3 = C.disconnect
	end
end)
connectBtn.MouseLeave:Connect(function()
	if connectBtn:GetAttribute("Base") == "primary" then
		connectGrad.Color = ColorSequence.new(
			Color3.fromRGB(132, 118, 255), Color3.fromRGB(92, 78, 232))
	else
		connectBtn.BackgroundColor3 = C.disconnect
	end
end)

-- Info card
local card = Instance.new("Frame", root)
card.LayoutOrder = 6
card.Size = UDim2.new(1,0,0,118)
card.BackgroundColor3 = C.panel
register(card, "panel")
card.BorderSizePixel = 0
corner(card, 10)
stroke(card, C.stroke, 1)
sheen(card)
padAll(card, 12)
local cardList = Instance.new("UIListLayout", card); cardList.Padding = UDim.new(0,6)

local function infoRow(order, labelText)
	local row = Instance.new("Frame", card)
	row.LayoutOrder = order
	row.BackgroundTransparency = 1
	row.Size = UDim2.new(1,0,0,16)
	local lbl = Instance.new("TextLabel", row)
	lbl.BackgroundTransparency = 1
	lbl.Size = UDim2.new(0,62,1,0)
	lbl.Font = Enum.Font.GothamMedium; lbl.TextSize = 10
	lbl.TextColor3 = C.textMute
	register(lbl, "textMute")
	lbl.Text = labelText
	lbl.TextXAlignment = Enum.TextXAlignment.Left
	local val = Instance.new("TextLabel", row)
	val.BackgroundTransparency = 1
	val.Position = UDim2.new(0,66,0,0)
	val.Size = UDim2.new(1,-66,1,0)
	val.Font = Enum.Font.Gotham; val.TextSize = 11
	val.TextColor3 = C.textDim
	register(val, "textDim")
	val.Text = "—"
	val.TextXAlignment = Enum.TextXAlignment.Left
	val.TextTruncate = Enum.TextTruncate.AtEnd
	return val
end

local status   = infoRow(1, "STATUS")
local syncInfo = infoRow(2, "BUILDS")
local ctxInfo  = infoRow(3, "CONTEXT")
local logInfo  = infoRow(4, "LOG")
status.Text = "Not connected"
local recentLogs = {}

local function appendLog(message)
	local text = os.date("%H:%M:%S") .. " " .. tostring(message)
	table.insert(recentLogs, 1, text)
	while #recentLogs > 4 do table.remove(recentLogs) end
	logInfo.Text = recentLogs[1] or "—"
	print("[BloxSmith] " .. tostring(message))
end

local footer = Instance.new("TextLabel", root)
footer.LayoutOrder = 7
footer.BackgroundTransparency = 1
footer.Size = UDim2.new(1,0,0,28)
footer.Font = Enum.Font.Gotham; footer.TextSize = 10
footer.TextColor3 = C.textMute
register(footer, "textMute")
footer.Text = "bloxsmith.pro · sends script source + workspace snapshot to BloxSmith's AI. You can pause or disconnect at any time. All changes are undoable (Ctrl+Z)."
footer.TextWrapped = true
footer.TextXAlignment = Enum.TextXAlignment.Left
footer.TextYAlignment = Enum.TextYAlignment.Top

-- Custom API URL (for self-hosted / staging users; default = bloxsmith.pro)
local apiLabel = Instance.new("TextLabel", root)
apiLabel.LayoutOrder = 8
apiLabel.BackgroundTransparency = 1
apiLabel.Size = UDim2.new(1,0,0,14)
apiLabel.Font = Enum.Font.GothamMedium; apiLabel.TextSize = 10
apiLabel.TextColor3 = C.textDim
register(apiLabel, "textDim")
apiLabel.Text = "API URL (advanced — leave default)"
apiLabel.TextXAlignment = Enum.TextXAlignment.Left

local apiWrap = Instance.new("Frame", root)
apiWrap.LayoutOrder = 9
apiWrap.Size = UDim2.new(1,0,0,28)
apiWrap.BackgroundColor3 = C.panel
register(apiWrap, "panel")
apiWrap.BorderSizePixel = 0
corner(apiWrap, 6)
stroke(apiWrap, C.stroke, 1)
local apiBox = Instance.new("TextBox", apiWrap)
apiBox.Size = UDim2.new(1,-20,1,0); apiBox.Position = UDim2.new(0,10,0,0)
apiBox.BackgroundTransparency = 1
apiBox.TextColor3 = C.textDim
register(apiBox, "textDim")
apiBox.Text = getApiBase()
apiBox.PlaceholderText = DEFAULT_API
apiBox.PlaceholderColor3 = C.textMute
apiBox.Font = Enum.Font.Code; apiBox.TextSize = 10
apiBox.ClearTextOnFocus = false
apiBox.TextXAlignment = Enum.TextXAlignment.Left
apiBox.FocusLost:Connect(function() setApiBase(apiBox.Text or "") end)

-- Pause/resume toggle (lets the user stop incoming actions without losing the token)
local pauseBtn = Instance.new("TextButton", root)
pauseBtn.LayoutOrder = 10
pauseBtn.Size = UDim2.new(1,0,0,26)
pauseBtn.BackgroundColor3 = C.panel
register(pauseBtn, "panel")
pauseBtn.TextColor3 = C.textDim
register(pauseBtn, "textDim")
pauseBtn.Text = getPaused() and "▶  Resume sync" or "⏸  Pause sync"
pauseBtn.Font = Enum.Font.GothamMedium; pauseBtn.TextSize = 11
pauseBtn.BorderSizePixel = 0
pauseBtn.AutoButtonColor = false
corner(pauseBtn, 6)
stroke(pauseBtn, C.stroke, 1)
pauseBtn.MouseButton1Click:Connect(function()
	setPaused(not getPaused())
	pauseBtn.Text = getPaused() and "▶  Resume sync" or "⏸  Pause sync"
end)

local utilityRow = Instance.new("Frame", root)
utilityRow.LayoutOrder = 11
utilityRow.BackgroundTransparency = 1
utilityRow.Size = UDim2.new(1,0,0,28)
local utilityList = Instance.new("UIListLayout", utilityRow)
utilityList.FillDirection = Enum.FillDirection.Horizontal
utilityList.Padding = UDim.new(0,6)
utilityList.SortOrder = Enum.SortOrder.LayoutOrder

local function utilityButton(parent, text, widthScale, order)
	local b = Instance.new("TextButton", parent)
	b.LayoutOrder = order
	b.Size = UDim2.new(widthScale, -4, 1, 0)
	b.BackgroundColor3 = C.panel
	register(b, "panel")
	b.TextColor3 = C.textDim
	register(b, "textDim")
	b.Text = text
	b.Font = Enum.Font.GothamMedium
	b.TextSize = 10
	b.BorderSizePixel = 0
	b.AutoButtonColor = false
	corner(b, 6)
	stroke(b, C.stroke, 1)
	return b
end

local syncNowBtn      = utilityButton(utilityRow, "Sync Now",     0.25, 1)
local reconnectBtn    = utilityButton(utilityRow, "Reconnect",    0.25, 2)
local cancelScanBtn   = utilityButton(utilityRow, "Cancel Scan",  0.25, 3)
local cleanSyncedBtn  = utilityButton(utilityRow, "Clean Synced", 0.25, 4)

-- Preview mode row: when ON, incoming AI actions are stashed locally so you
-- can review every script + change before it touches your place. Stays in
-- Studio edit mode (never enters Play).
local previewRow = Instance.new("Frame", root)
previewRow.LayoutOrder = 12
previewRow.BackgroundTransparency = 1
previewRow.Size = UDim2.new(1,0,0,28)
local previewList = Instance.new("UIListLayout", previewRow)
previewList.FillDirection = Enum.FillDirection.Horizontal
previewList.Padding = UDim.new(0,6)
previewList.SortOrder = Enum.SortOrder.LayoutOrder

local previewToggleBtn = utilityButton(previewRow, "", 0.5, 1)
local reviewBtn        = utilityButton(previewRow, "Review Pending (0)", 0.5, 2)

local function refreshPreviewToggleLabel()
	previewToggleBtn.Text = getPreview() and "👁  Preview Mode: ON" or "👁  Preview Mode: OFF"
	if getPreview() then
		previewToggleBtn.TextColor3 = C.accent
	else
		previewToggleBtn.TextColor3 = C.textDim
	end
end
refreshPreviewToggleLabel()

local function setPill(state)
	local dotColor, label, textColor
	if state == "connected" or state == "idle" then
		dotColor, label, textColor = C.success, "Connected", C.success
	elseif state == "connecting" then
		dotColor, label, textColor = C.accent, "Connecting", C.accent
	elseif state == "scanning" then
		dotColor, label, textColor = C.accent, "Scanning", C.accent
	elseif state == "executing" then
		dotColor, label, textColor = C.accent, "Executing", C.accent
	elseif state == "complete" then
		dotColor, label, textColor = C.success, "Complete", C.success
	elseif state == "error" then
		dotColor = Color3.fromRGB(240, 80, 80)
		label, textColor = "Error", Color3.fromRGB(240, 80, 80)
	else
		dotColor, label, textColor = C.idle, "Offline", C.textDim
	end
	pillDot.BackgroundColor3 = dotColor
	pillDotGlow.Color = dotColor
	pillText.Text = label
	pillText.TextColor3 = textColor
end

-- Automatic Studio theme sync
local function applyTheme()
	local isLight = false
	pcall(function()
		local theme = settings().Studio.Theme
		isLight = (theme:GetColor(Enum.StudioStyleGuideColor.MainBackground).R > 0.5)
	end)

	if isLight then
		C.bg         = Color3.fromRGB(245, 245, 250)
		C.panel      = Color3.fromRGB(255, 255, 255)
		C.stroke     = Color3.fromRGB(210, 210, 222)
		C.primary    = Color3.fromRGB(99, 91, 255)
		C.primaryHi  = Color3.fromRGB(124, 116, 255)
		C.disconnect = Color3.fromRGB(110, 110, 130)
		C.text       = Color3.fromRGB(30, 30, 45)
		C.textDim    = Color3.fromRGB(80, 80, 100)
		C.textMute   = Color3.fromRGB(140, 140, 160)
		C.accent     = Color3.fromRGB(110, 100, 220)
	else
		C.bg         = Color3.fromRGB(13, 13, 24)
		C.panel      = Color3.fromRGB(22, 22, 38)
		C.stroke     = Color3.fromRGB(45, 45, 70)
		C.primary    = Color3.fromRGB(99, 91, 255)
		C.primaryHi  = Color3.fromRGB(124, 116, 255)
		C.disconnect = Color3.fromRGB(60, 60, 90)
		C.text       = Color3.fromRGB(235, 235, 245)
		C.textDim    = Color3.fromRGB(150, 150, 175)
		C.textMute   = Color3.fromRGB(105, 105, 130)
		C.accent     = Color3.fromRGB(160, 150, 255)
	end

	scroll.BackgroundColor3 = C.bg
	for _, el in ipairs(UI_Elements.bg or {}) do el.BackgroundColor3 = C.bg end
	for _, el in ipairs(UI_Elements.panel or {}) do el.BackgroundColor3 = C.panel end
	for _, el in ipairs(UI_Elements.text or {}) do el.TextColor3 = C.text end
	for _, el in ipairs(UI_Elements.textDim or {}) do el.TextColor3 = C.textDim end
	for _, el in ipairs(UI_Elements.textMute or {}) do el.TextColor3 = C.textMute end
	for _, el in ipairs(UI_Elements.stroke or {}) do el.Color = C.stroke end
end

pcall(function()
	settings().Studio.ThemeChanged:Connect(applyTheme)
end)
applyTheme()
----------------------------------------------------------------
-- Helpers: services, path resolution, value coercion
----------------------------------------------------------------
local SERVICE_MAP = {
	Workspace = Workspace, ServerScriptService = ServerScriptService,
	ServerStorage = ServerStorage, ReplicatedStorage = ReplicatedStorage,
	ReplicatedFirst = ReplicatedFirst, StarterPlayer = StarterPlayer,
	StarterPlayerScripts = StarterPlayer:FindFirstChild("StarterPlayerScripts"),
	StarterCharacterScripts = StarterPlayer:FindFirstChild("StarterCharacterScripts"),
	StarterGui = StarterGui, StarterPack = StarterPack,
	Lighting = Lighting, SoundService = SoundService, Teams = Teams, Terrain = Terrain,
}

local function getService(name)
	if not name or name == "" then return ServerScriptService end
	local s = SERVICE_MAP[name]
	if s then return s end
	local ok, svc = pcall(function() return game:GetService(name) end)
	if ok and svc then return svc end
	return game:FindFirstChild(name)
end

-- Resolve "ServerScriptService.Folder.Sub" or {"ServerScriptService","Folder"} or "ServerScriptService/Folder/Sub"
local function resolvePath(pathStr, createFolders)
	if typeof(pathStr) == "table" then pathStr = table.concat(pathStr, ".") end
	if not pathStr or pathStr == "" or pathStr == "Workspace" then
		pathStr = "Workspace.BloxSmithBuilds"
	end
	pathStr = string.gsub(pathStr, "/", ".")
	pathStr = string.gsub(pathStr, "^game%.", "")
	local parts = string.split(pathStr, ".")
	local parent = getService(parts[1])
	if not parent then return nil end
	for i = 2, #parts do
		local child = parent:FindFirstChild(parts[i])
		if not child then
			if createFolders then
				child = Instance.new("Folder"); child.Name = parts[i]; child.Parent = parent
			else
				return nil
			end
		end
		parent = child
	end
	return parent
end

local function coerceValue(v)
	if typeof(v) ~= "table" then return v end
	local t = v.__t or v.type
	if t == "Vector3" then return Vector3.new(v.x or 0, v.y or 0, v.z or 0) end
	if t == "Vector2" then return Vector2.new(v.x or 0, v.y or 0) end
	if t == "Color3"  then return Color3.fromRGB(v.r or 255, v.g or 255, v.b or 255) end
	if t == "CFrame"  then
		if v.lookAt then
			return CFrame.new(Vector3.new(v.x or 0, v.y or 0, v.z or 0),
				Vector3.new(v.lookAt.x or 0, v.lookAt.y or 0, v.lookAt.z or 0))
		end
		return CFrame.new(v.x or 0, v.y or 0, v.z or 0)
			* CFrame.Angles(math.rad(v.rx or 0), math.rad(v.ry or 0), math.rad(v.rz or 0))
	end
	if t == "UDim2"   then return UDim2.new(v.xs or 0, v.xo or 0, v.ys or 0, v.yo or 0) end
	if t == "UDim"    then return UDim.new(v.s or 0, v.o or 0) end
	if t == "Enum" and v.enum and v.value then
		local ok, e = pcall(function() return Enum[v.enum][v.value] end)
		if ok then return e end
	end
	if t == "BrickColor" then return BrickColor.new(v.name or "Medium stone grey") end
	return v
end

local function applyProps(inst, props)
	if not props then return end
	for k, raw in pairs(props) do
		if k == "Parent" and type(raw) == "string" then
			local parentInst = resolvePath(raw, true)
			if parentInst then
				pcall(function() inst.Parent = parentInst end)
			end
		else
			local ok, val = pcall(coerceValue, raw)
			if ok then pcall(function() inst[k] = val end) end
		end
	end
end

local function showDeleteConfirmDialog(pathText, callback)
	pcall(function() widget.Enabled = true end)
	local overlay = Instance.new("Frame", widget)
	overlay.Size = UDim2.fromScale(1,1)
	overlay.BackgroundColor3 = Color3.new(0,0,0)
	overlay.BackgroundTransparency = 0.35
	overlay.BorderSizePixel = 0
	overlay.ZIndex = 80

	local box = Instance.new("Frame", overlay)
	box.Size = UDim2.new(1,-24,0,154)
	box.Position = UDim2.new(0,12,0.5,-77)
	box.BackgroundColor3 = C.panel
	box.BorderSizePixel = 0
	box.ZIndex = 81
	corner(box, 10); stroke(box, C.stroke, 1); padAll(box, 14)

	local boxList = Instance.new("UIListLayout", box)
	boxList.Padding = UDim.new(0,10)
	boxList.SortOrder = Enum.SortOrder.LayoutOrder

	local h = Instance.new("TextLabel", box)
	h.LayoutOrder = 1
	h.BackgroundTransparency = 1
	h.Size = UDim2.new(1,0,0,20)
	h.Font = Enum.Font.GothamBold
	h.TextSize = 13
	h.TextColor3 = C.text
	h.Text = "Confirm Delete"
	h.TextXAlignment = Enum.TextXAlignment.Left
	h.ZIndex = 82

	local body = Instance.new("TextLabel", box)
	body.LayoutOrder = 2
	body.BackgroundTransparency = 1
	body.Size = UDim2.new(1,0,0,46)
	body.Font = Enum.Font.Gotham
	body.TextSize = 11
	body.TextColor3 = C.textDim
	body.TextWrapped = true
	body.TextXAlignment = Enum.TextXAlignment.Left
	body.TextYAlignment = Enum.TextYAlignment.Top
	body.ZIndex = 82
	body.Text = "BloxSmith wants to delete this object from your Studio place:\n" .. tostring(pathText)

	local row = Instance.new("Frame", box)
	row.LayoutOrder = 3
	row.BackgroundTransparency = 1
	row.Size = UDim2.new(1,0,0,32)
	row.ZIndex = 82

	local keep = Instance.new("TextButton", row)
	keep.Size = UDim2.new(0.5,-4,1,0)
	keep.BackgroundColor3 = C.disconnect
	keep.TextColor3 = C.text
	keep.Font = Enum.Font.GothamMedium
	keep.TextSize = 11
	keep.Text = "Cancel"
	keep.BorderSizePixel = 0
	keep.ZIndex = 83
	corner(keep, 6)

	local del = Instance.new("TextButton", row)
	del.Size = UDim2.new(0.5,-4,1,0)
	del.Position = UDim2.new(0.5,8,0,0)
	del.BackgroundColor3 = Color3.fromRGB(205, 72, 82)
	del.TextColor3 = Color3.new(1,1,1)
	del.Font = Enum.Font.GothamBold
	del.TextSize = 11
	del.Text = "Delete"
	del.BorderSizePixel = 0
	del.ZIndex = 83
	corner(del, 6)

	keep.MouseButton1Click:Connect(function()
		overlay:Destroy()
		callback(false)
	end)
	del.MouseButton1Click:Connect(function()
		overlay:Destroy()
		callback(true)
	end)
end

----------------------------------------------------------------
-- Action handlers — this is what makes the AI actually BUILD
----------------------------------------------------------------
local Actions = {}

-- Create or overwrite a script (legacy file sync)
function Actions.script(a)
	local parent = resolvePath(a.parent or a.service_location or "ServerScriptService", true)
	if not parent then return false, "bad parent" end
	local className = a.className or a.file_type or "Script"
	local name = a.name or "Script"
	local existing = parent:FindFirstChild(name)
	if existing and not existing:IsA(className) then existing:Destroy(); existing = nil end
	if not existing then
		existing = Instance.new(className); existing.Name = name; existing.Parent = parent
	end
	existing.Source = a.source or a.content or ""
	return true
end

-- Create any Instance (Part, Model, Folder, Sound, ParticleEmitter, etc.)
function Actions.create(a)
	local parent = resolvePath(a.parent or "Workspace", true)
	if not parent then return false, "bad parent" end
	local inst = Instance.new(a.className or "Part")
	inst.Name = a.name or (a.className or "Part")
	applyProps(inst, a.properties)
	inst.Parent = parent
	if a.children then
		for _, c in ipairs(a.children) do
			c.parent = (a.parent or "Workspace") .. "." .. inst.Name
			Actions.create(c)
		end
	end
	return true
end

-- Create a part with helper mapping for size, position, color, material, anchored properties
function Actions.create_part(a)
	local parent = resolvePath(a.parent or "Workspace", true)
	if not parent then return false, "bad parent" end
	local part = Instance.new("Part")
	part.Name = a.name or "Part"
	
	if a.size then
		part.Size = Vector3.new(a.size[1] or 4, a.size[2] or 4, a.size[3] or 4)
	end
	if a.position then
		part.Position = Vector3.new(a.position[1] or 0, a.position[2] or 0, a.position[3] or 0)
	end
	if a.color then
		part.Color = Color3.fromRGB(a.color[1] or 255, a.color[2] or 255, a.color[3] or 255)
	end
	if a.material then
		pcall(function() part.Material = Enum.Material[a.material] or Enum.Material.SmoothPlastic end)
	end
	if a.anchored ~= nil then
		part.Anchored = a.anchored
	end
	
	applyProps(part, a.properties)
	part.Parent = parent
	return true
end

-- Update an existing instance's properties
function Actions.set(a)
	local inst = resolvePath(a.path, false)
	if not inst then return false, "not found: " .. tostring(a.path) end
	applyProps(inst, a.properties)
	return true
end

-- Delete an instance
function Actions.delete(a)
	local inst = resolvePath(a.path, false)
	if not inst then return false, "not found: " .. tostring(a.path) end
	if a.confirmed ~= true and a.force ~= true then
		local decided = false
		local approved = false
		task.spawn(function()
			showDeleteConfirmDialog(a.path or instancePath(inst), function(choice)
				approved = choice
				decided = true
			end)
		end)
		while not decided do task.wait(0.1) end
		if not approved then return false, "delete cancelled by user" end
	end
	inst:Destroy()
	return true
end

instancePath = function(inst)
	local parts = {}
	local cur = inst
	while cur and cur ~= game do
		table.insert(parts, 1, cur.Name)
		cur = cur.Parent
	end
	return "game." .. table.concat(parts, ".")
end

local function instanceId(inst)
	local ok, id = pcall(function() return inst:GetDebugId(0) end)
	if ok and id then return id end
	return instancePath(inst)
end

-- Move an existing instance into a Folder/Model/service, creating folders as needed.
function Actions.move(a)
	local inst = resolvePath(a.path, false)
	if not inst then return false, "not found: " .. tostring(a.path) end
	local parent = resolvePath(a.newParent or a.parent or "Workspace", true)
	if not parent then return false, "bad newParent" end
	inst.Parent = parent
	task.defer(pushSnapshot)
	return true
end

-- Rename an existing instance.
function Actions.rename(a)
	local inst = resolvePath(a.path, false)
	if not inst then return false, "not found: " .. tostring(a.path) end
	local newName = a.newName or a.name
	if not newName or tostring(newName) == "" then return false, "missing newName" end
	inst.Name = tostring(newName)
	task.defer(pushSnapshot)
	return true
end

-- Create a Folder/Model and bulk-move listed instances into it.
function Actions.organize(a)
	local parent = resolvePath(a.parent or "Workspace", true)
	if not parent then return false, "bad parent" end
	local containerClass = a.container or a.className or "Folder"
	if containerClass ~= "Folder" and containerClass ~= "Model" then containerClass = "Folder" end
	local name = a.name or a.folderName or "OrganizedFolder"
	local container = parent:FindFirstChild(name)
	if container and not container:IsA(containerClass) then
		return false, "existing container has wrong class: " .. tostring(name)
	end
	if not container then
		container = Instance.new(containerClass)
		container.Name = name
		container.Parent = parent
	end
	for _, path in ipairs(a.items or a.objects or {}) do
		local inst = resolvePath(path, false)
		if inst and inst ~= container and not container:IsAncestorOf(inst) then
			inst.Parent = container
		end
	end
	task.defer(pushSnapshot)
	return true
end

-- Set service-level properties (Lighting, Workspace gravity, etc.)
function Actions.service(a)
	local svc = getService(a.service)
	if not svc then return false, "no service" end
	applyProps(svc, a.properties)
	return true
end

-- Terrain: fill a region with a material
function Actions.terrainFill(a)
	local mat = Enum.Material[a.material or "Grass"] or Enum.Material.Grass
	local cf  = coerceValue(a.cframe or { __t="CFrame", x=0, y=0, z=0 })
	local size = coerceValue(a.size or { __t="Vector3", x=512, y=8, z=512 })
	Terrain:FillBlock(cf, size, mat)
	return true
end

-- Terrain: clear everything
function Actions.terrainClear()
	Terrain:Clear()
	return true
end

-- Generate a procedural terrain region (used for "build me an island/forest" prompts)
function Actions.terrainGenerate(a)
	local size = coerceValue(a.size or { __t="Vector3", x=1024, y=256, z=1024 })
	local origin = coerceValue(a.origin or { __t="Vector3", x=0, y=0, z=0 })
	local biome = a.biome or "Plains"
	local biomeEnum = Enum.Biome[biome] or Enum.Biome.Plains
	local region = Region3.new(origin - size/2, origin + size/2):ExpandToGrid(4)
	Terrain:GenerateAsync(region, a.seed or math.random(1, 1e9), { biomeEnum })
	return true
end

-- Lighting preset
function Actions.lighting(a)
	applyProps(Lighting, a.properties or {})
	return true
end

-- Spawn point helper
function Actions.spawn(a)
	local pos = coerceValue(a.position or { __t="Vector3", x=0, y=10, z=0 })
	local sp = Instance.new("SpawnLocation")
	sp.Anchored = true; sp.CanCollide = true
	sp.Size = Vector3.new(12, 1, 12)
	sp.CFrame = CFrame.new(pos)
	sp.TopSurface = Enum.SurfaceType.Smooth
	sp.Material = Enum.Material.Neon
	sp.BrickColor = BrickColor.new("Electric blue")
	sp.Name = a.name or "SpawnLocation"
	sp.Parent = Workspace
	return true
end

-- Select an instance in Studio (so the user sees what AI just built)
function Actions.select(a)
	local inst = resolvePath(a.path, false)
	if inst then Selection:Set({ inst }) end
	return true
end

-- Insert a Roblox free model / mesh / decal / animation from the toolbox by assetId.
function Actions.insertAsset(a)
	local parent = resolvePath(a.parent or "Workspace", true)
	if not parent then return false, "bad parent" end
	local assetId = tonumber(a.assetId)
	if not assetId then return false, "missing assetId" end
	local InsertService = game:GetService("InsertService")
	local ok, model = pcall(function() return InsertService:LoadAsset(assetId) end)
	if not ok or not model then return false, "LoadAsset failed: " .. tostring(model) end
	local moved = {}
	for _, child in ipairs(model:GetChildren()) do
		if a.name and #model:GetChildren() == 1 then child.Name = a.name end
		child.Parent = parent
		table.insert(moved, child)
	end
	model:Destroy()
	if a.position and moved[1] and moved[1]:IsA("Model") and moved[1].PrimaryPart then
		local pos = coerceValue(a.position)
		moved[1]:PivotTo(CFrame.new(pos))
	elseif a.position and moved[1] and moved[1]:IsA("BasePart") then
		moved[1].CFrame = CFrame.new(coerceValue(a.position))
	end
	return true
end

-- Insert a safe free toolbox model by ID with safety scan & consent flow
function Actions.insert_toolbox_asset(a)
	local parent = resolvePath(a.parent or "Workspace", true)
	if not parent then return false, "bad parent" end
	local assetId = tonumber(a.assetId)
	if not assetId then return false, "missing assetId" end
	
	local InsertService = game:GetService("InsertService")
	local ok, model = pcall(function() return InsertService:LoadAsset(assetId) end)
	if not ok or not model then return false, "LoadAsset failed: " .. tostring(model) end
	
	-- Scan for scripts
	local scriptsFound = {}
	for _, desc in ipairs(model:GetDescendants()) do
		if desc:IsA("LuaSourceContainer") then
			table.insert(scriptsFound, desc)
		end
	end

	local decision = "keep"
	
	if #scriptsFound > 0 then
		if a.removeScriptsFromDecorativeAssets == true or (a.removeUnsafeScripts == true and not a.requiresApprovalIfScriptsFound) then
			decision = "remove"
		else
			local responseReceived = false
			local userChoice = nil
			
			task.spawn(function()
				showScriptPromptDialog(model.Name, #scriptsFound, function(choice)
					userChoice = choice
					responseReceived = true
				end)
			end)
			
			while not responseReceived do
				task.wait(0.1)
			end
			
			decision = userChoice
		end
	end

	if decision == "cancel" then
		model:Destroy()
		return false, "User cancelled insertion due to unsafe scripts"
	end

	if decision == "remove" then
		for _, scr in ipairs(scriptsFound) do
			pcall(function() scr:Destroy() end)
		end
	end

	local moved = {}
	for _, child in ipairs(model:GetChildren()) do
		if a.name and #model:GetChildren() == 1 then child.Name = a.name end
		child.Parent = parent
		table.insert(moved, child)
	end
	model:Destroy()

	if a.position and moved[1] then
		local pos = coerceValue(a.position)
		if moved[1]:IsA("Model") then
			moved[1]:PivotTo(CFrame.new(pos))
		elseif moved[1]:IsA("BasePart") then
			moved[1].CFrame = CFrame.new(pos)
		end
	end

	task.defer(pushSnapshot)
	return true
end

-- Update source code of an existing script
function Actions.update_script(a)
	local path = a.path or a.file_path
	if not path then return false, "missing path" end
	local inst = resolvePath(path, false)
	if not inst then return false, "script not found: " .. tostring(path) end
	if not inst:IsA("LuaSourceContainer") then return false, "target is not a script" end
	inst.Source = a.source or a.content or ""
	task.defer(pushSnapshot)
	return true
end

-- Scan the project and push the snapshot
function Actions.scan_project()
	task.defer(pushSnapshot)
	return true
end

function Actions.cancel_scan()
	scanCancelRequested = true
	appendLog("Scan cancel requested")
	return true
end

-- Apply a Roblox image assetId as a Decal on a target Part.
function Actions.decal(a)
	local target = resolvePath(a.path, false)
	if not target then return false, "decal target not found" end
	if not target:IsA("BasePart") then return false, "decal target not a BasePart" end
	local face = (a.face and Enum.NormalId[a.face]) or Enum.NormalId.Front
	local decal = target:FindFirstChild(a.name or "Decal")
	if not decal or not decal:IsA("Decal") then
		decal = Instance.new("Decal")
		decal.Name = a.name or "Decal"
		decal.Parent = target
	end
	decal.Face = face
	decal.Texture = "rbxassetid://" .. tostring(a.assetId)
	return true
end

-- Insert a Sound under a parent with a Roblox audio assetId.
function Actions.sound(a)
	local parent = resolvePath(a.parent or "Workspace", true)
	if not parent then return false, "bad parent" end
	local s = parent:FindFirstChild(a.name or "Sound")
	if not s or not s:IsA("Sound") then
		s = Instance.new("Sound")
		s.Name = a.name or "Sound"
		s.Parent = parent
	end
	s.SoundId = "rbxassetid://" .. tostring(a.assetId)
	s.Volume = a.volume or 0.5
	s.Looped = a.looped == true
	s.PlaybackSpeed = a.playbackSpeed or 1
	if a.play then pcall(function() s:Play() end) end
	return true
end

-- Set the Image property on an ImageLabel/ImageButton/Decal/Texture by path.
function Actions.image(a)
	local inst = resolvePath(a.path, false)
	if not inst then return false, "image target not found" end
	local uri = "rbxassetid://" .. tostring(a.assetId)
	if inst:IsA("ImageLabel") or inst:IsA("ImageButton") then
		inst.Image = uri
	elseif inst:IsA("Decal") or inst:IsA("Texture") then
		inst.Texture = uri
	else
		return false, "instance does not accept an image"
	end
	return true
end

----------------------------------------------------------------
-- Workspace context reporter — gives the AI full awareness
----------------------------------------------------------------
local MAX_INSTANCES = 800
local MAX_DEPTH     = 6

local function snapshotInstance(inst, depth)
	local node = {
		id = instanceId(inst),
		name = inst.Name,
		className = inst.ClassName,
		path = instancePath(inst),
		parentPath = inst.Parent and instancePath(inst.Parent) or nil,
	}
	if inst:IsA("BasePart") then
		node.size = { x = inst.Size.X, y = inst.Size.Y, z = inst.Size.Z }
		node.position = { x = inst.Position.X, y = inst.Position.Y, z = inst.Position.Z }
		node.material = inst.Material.Name
		node.color = { r = math.floor(inst.Color.R*255), g = math.floor(inst.Color.G*255), b = math.floor(inst.Color.B*255) }
		node.anchored = inst.Anchored
		if inst:IsA("MeshPart") then
			node.assetId = inst.MeshId
			node.textureId = inst.TextureID
		end
	elseif inst:IsA("LuaSourceContainer") then
		local src = inst.Source or ""
		node.sourcePreview = string.sub(src, 1, 4000)
		node.sourceLength  = #src
	elseif inst:IsA("Decal") or inst:IsA("Texture") then
		node.assetId = inst.Texture
	elseif inst:IsA("Sound") then
		node.assetId = inst.SoundId
	elseif inst:IsA("Animation") then
		node.assetId = inst.AnimationId
	end
	return node
end

local function snapshotChildren(parent, depth, counter)
	local out = {}
	if depth > MAX_DEPTH then return out end
	for _, child in ipairs(parent:GetChildren()) do
		if counter[1] >= MAX_INSTANCES then break end
		counter[1] = counter[1] + 1
		local node = snapshotInstance(child, depth)
		local kids = snapshotChildren(child, depth + 1, counter)
		if #kids > 0 then node.children = kids end
		table.insert(out, node)
	end
	return out
end

local function buildContext()
	local counter = { 0 }
	local roots = {}
	for _, svcName in ipairs({
		"Workspace","ServerScriptService","ServerStorage","ReplicatedStorage",
		"StarterPlayer","StarterPlayerScripts","StarterCharacterScripts",
		"StarterGui","StarterPack","Lighting","SoundService","Teams",
	}) do
		local svc = getService(svcName)
		if svc then
			local rootNode = snapshotInstance(svc, 0)
			rootNode.name = svcName
			rootNode.children = snapshotChildren(svc, 1, counter)
			table.insert(roots, {
				id = rootNode.id,
				name = rootNode.name,
				className = rootNode.className,
				path = rootNode.path,
				parentPath = rootNode.parentPath,
				children = rootNode.children,
			})
		end
	end
	return {
		projectName = game.Name,
		placeId  = game.PlaceId,
		scannedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
		placeName= game.Name,
		gravity  = Workspace.Gravity,
		lighting = {
			ambient        = tostring(Lighting.Ambient),
			clockTime      = Lighting.ClockTime,
			fogEnd         = Lighting.FogEnd,
			environmentDiffuseScale = Lighting.EnvironmentDiffuseScale,
		},
		instanceCount = counter[1],
		truncated     = counter[1] >= MAX_INSTANCES,
		tree          = roots,
	}
end

function showScriptPromptDialog(assetName, scriptCount, callback)
	pcall(function() widget.Enabled = true end)
	local overlay = Instance.new("Frame", widget)
	overlay.Size = UDim2.fromScale(1,1)
	overlay.BackgroundColor3 = Color3.new(0,0,0)
	overlay.BackgroundTransparency = 0.4
	overlay.BorderSizePixel = 0
	overlay.ZIndex = 100

	local box = Instance.new("Frame", overlay)
	box.Size = UDim2.new(1,-24,0,180)
	box.Position = UDim2.new(0,12,0.5,-90)
	box.BackgroundColor3 = C.panel
	box.BorderSizePixel = 0
	box.ZIndex = 101
	corner(box, 10); stroke(box, C.stroke, 1); padAll(box, 14)

	local boxList = Instance.new("UIListLayout", box)
	boxList.Padding = UDim.new(0,10); boxList.SortOrder = Enum.SortOrder.LayoutOrder

	local h = Instance.new("TextLabel", box)
	h.LayoutOrder = 1; h.BackgroundTransparency = 1
	h.Size = UDim2.new(1,0,0,20)
	h.Font = Enum.Font.GothamBold; h.TextSize = 13
	h.TextColor3 = C.text; h.Text = "Security Warning"
	h.TextXAlignment = Enum.TextXAlignment.Left; h.ZIndex = 102

	local body = Instance.new("TextLabel", box)
	body.LayoutOrder = 2; body.BackgroundTransparency = 1
	body.Size = UDim2.new(1,0,0,50)
	body.Font = Enum.Font.Gotham; body.TextSize = 11
	body.TextColor3 = C.textDim; body.TextWrapped = true
	body.TextXAlignment = Enum.TextXAlignment.Left
	body.TextYAlignment = Enum.TextYAlignment.Top
	body.ZIndex = 102
	body.Text = ("The model '%s' contains %d script(s). Free models from the Toolbox can contain malicious code. How would you like to proceed?"):format(assetName, scriptCount)

	local btnRow = Instance.new("Frame", box)
	btnRow.LayoutOrder = 3; btnRow.BackgroundTransparency = 1
	btnRow.Size = UDim2.new(1,0,0,32); btnRow.ZIndex = 102

	local btnList = Instance.new("UIListLayout", btnRow)
	btnList.FillDirection = Enum.FillDirection.Horizontal
	btnList.Padding = UDim.new(0,6)

	local function makeBtn(name, bg, col, widthScale)
		local b = Instance.new("TextButton", btnRow)
		b.Size = UDim2.new(widthScale, -4, 1, 0)
		b.BackgroundColor3 = bg; b.TextColor3 = col
		b.Font = Enum.Font.GothamMedium; b.TextSize = 11
		b.Text = name; b.BorderSizePixel = 0; b.ZIndex = 102
		corner(b, 6)
		return b
	end

	local btnKeep = makeBtn("Keep Scripts", C.accent, Color3.new(1,1,1), 0.33)
	local btnStrip = makeBtn("Remove Scripts", C.primary, Color3.new(1,1,1), 0.33)
	local btnCancel = makeBtn("Cancel", C.disconnect, C.text, 0.33)

	btnKeep.MouseButton1Click:Connect(function()
		overlay:Destroy()
		callback("keep")
	end)

	btnStrip.MouseButton1Click:Connect(function()
		overlay:Destroy()
		callback("remove")
	end)

	btnCancel.MouseButton1Click:Connect(function()
		overlay:Destroy()
		callback("cancel")
	end)
end

local function computeHash(str)
	local hash = 5381
	for i = 1, #str do
		hash = ((hash * 33) + string.byte(str, i)) % 2147483648
	end
	return string.format("%08x", hash)
end

local function getInstanceProperties(inst)
	local props = {}
	if inst:IsA("BasePart") then
		props.position = { inst.Position.X, inst.Position.Y, inst.Position.Z }
		props.size = { inst.Size.X, inst.Size.Y, inst.Size.Z }
		props.color = { math.floor(inst.Color.R * 255), math.floor(inst.Color.G * 255), math.floor(inst.Color.B * 255) }
		props.material = inst.Material.Name
		props.anchored = inst.Anchored
	elseif inst:IsA("Light") then
		props.color = { math.floor(inst.Color.R * 255), math.floor(inst.Color.G * 255), math.floor(inst.Color.B * 255) }
		props.brightness = inst.Brightness
		props.range = inst.Range
		props.enabled = inst.Enabled
	elseif inst:IsA("Decal") or inst:IsA("Texture") then
		props.texture = inst.Texture
	elseif inst:IsA("Sound") then
		props.soundId = inst.SoundId
		props.volume = inst.Volume
		props.playbackSpeed = inst.PlaybackSpeed
		props.looped = inst.Looped
	elseif inst:IsA("GuiObject") then
		props.size = { inst.Size.X.Scale, inst.Size.X.Offset, inst.Size.Y.Scale, inst.Size.Y.Offset }
		props.position = { inst.Position.X.Scale, inst.Position.X.Offset, inst.Position.Y.Scale, inst.Position.Y.Offset }
		props.backgroundColor = { math.floor(inst.BackgroundColor3.R * 255), math.floor(inst.BackgroundColor3.G * 255), math.floor(inst.BackgroundColor3.B * 255) }
		props.visible = inst.Visible
		if inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox") then
			props.text = inst.Text
		end
	end
	return props
end

local function scanProject(timeoutSeconds)
	local scanServices = {
		"Workspace",
		"ServerScriptService",
		"ServerStorage",
		"ReplicatedStorage",
		"ReplicatedFirst",
		"StarterGui",
		"StarterPack",
		"StarterPlayer",
		"StarterPlayerScripts",
		"StarterCharacterScripts",
		"SoundService",
		"Lighting",
		"Teams",
	}

	local files = {}
	local deadline = os.clock() + (timeoutSeconds or SCAN_TIMEOUT_SECONDS)
	local scanned = 0
	local timedOut = false
	local cancelled = false

	local function shouldStop()
		if scanCancelRequested then
			cancelled = true
			return true
		end
		if os.clock() > deadline then
			timedOut = true
			return true
		end
		return false
	end

	local function traverse(inst, parentPath)
		if shouldStop() then return end
		scanned += 1
		local currentPath = parentPath == "" and inst.Name or (parentPath .. "/" .. inst.Name)
		local isScript = inst:IsA("LuaSourceContainer")
		local includeObj = false
		
		if isScript or inst:IsA("Folder") or inst:IsA("Model") or inst:IsA("BasePart") or inst:IsA("Light") or inst:IsA("Decal") or inst:IsA("Texture") or inst:IsA("Sound") or inst:IsA("Animation") or inst:IsA("Tool") or inst:IsA("GuiBase") or inst:IsA("GuiObject") or inst:IsA("RemoteEvent") or inst:IsA("RemoteFunction") or inst:IsA("BindableEvent") or inst:IsA("BindableFunction") or inst:IsA("Team") or inst:IsA("SpawnLocation") or inst:IsA("Lighting") or inst:IsA("Teams") then
			includeObj = true
		end

		if includeObj then
			local fileNode = {
				id = instanceId(inst),
				name = inst.Name,
				className = inst.ClassName,
				path = currentPath,
				parent = parentPath ~= "" and string.split(parentPath, "/")[1] or inst.Parent.Name,
				parentPath = parentPath,
				studioPath = instancePath(inst),
			}
			if isScript then
				fileNode.source = inst.Source or ""
				fileNode.hash = computeHash(fileNode.source)
			else
				fileNode.properties = getInstanceProperties(inst)
			end
			table.insert(files, fileNode)
		end

		for _, child in ipairs(inst:GetChildren()) do
			traverse(child, currentPath)
			if timedOut or cancelled then break end
		end
	end

	for _, svcName in ipairs(scanServices) do
		if shouldStop() then break end
		local svc = getService(svcName)
		if svc then
			for _, child in ipairs(svc:GetChildren()) do
				traverse(child, svcName)
				if timedOut or cancelled then break end
			end
		end
	end

	return files, {
		count = scanned,
		timedOut = timedOut,
		cancelled = cancelled,
	}
end

function pushSnapshot()
	if not activeProjectId then return end
	if scanInProgress then
		syncInfo.Text = "Scan already running"
		return
	end
	scanInProgress = true
	scanCancelRequested = false
	setPill("scanning")
	status.Text = "Scanning project..."
	syncInfo.Text = "Scanning Studio project..."
	appendLog("Project scan started")
	local started = os.clock()
	local files, scan = scanProject(SCAN_TIMEOUT_SECONDS)
	if scan.cancelled then
		scanInProgress = false
		status.Text = "Connected"
		syncInfo.Text = "Scan cancelled"
		setPill("connected")
		appendLog("Project scan cancelled")
		return
	end
	if scan.timedOut then
		scanInProgress = false
		status.Text = "Connected"
		syncInfo.Text = ("Scan timed out at %d object(s)"):format(scan.count)
		setPill("error")
		appendLog("Project scan timed out")
		return
	end
	local data, err = postJSON("/api/studio/snapshot", {
		projectId = activeProjectId,
		files = files,
	})
	scanInProgress = false
	if err then
		status.Text = "Connected"
		syncInfo.Text = "Snapshot error: " .. tostring(err)
		setPill("error")
		appendLog("Snapshot push error: " .. tostring(err))
	else
		status.Text = "Connected"
		syncInfo.Text = ("Loaded %d object(s) in %.1fs"):format(#files, os.clock() - started)
		setPill("connected")
		lastContextSentAt = 0
		appendLog("Project scan finished: " .. tostring(#files) .. " object(s)")
	end
end

----------------------------------------------------------------
-- Sync engine
----------------------------------------------------------------
local function fingerprintActions(actions)
	local s = ""
	for _, a in ipairs(actions or {}) do
		s ..= (a.id or a.type or "") .. ":" .. tostring(a.rev or "") .. ";"
	end
	return s
end

local function dispatch(action)
	local fn = Actions[action.type]
	if not fn then return false, "unknown action: " .. tostring(action.type) end
	return fn(action)
end

-- ============================================================
-- Preview mode queue + apply pipeline
-- ============================================================
local pendingPreview = {}        -- queued actions awaiting user approval
local previewSeenIds = {}        -- de-dup so the same action isn't re-queued

local function refreshReviewBtnLabel()
	reviewBtn.Text = ("Review Pending (%d)"):format(#pendingPreview)
end
refreshReviewBtnLabel()

-- Runs the actual Studio mutations + reports status back to the website.
-- Used by both immediate sync and "Apply" inside the preview overlay.
local function applyActions(actions, sourceLabel)
	if #actions == 0 then return end

	local RunService = game:GetService("RunService")
	if not RunService:IsEdit() then
		syncInfo.Text = "Stop Play mode first to apply changes!"
		setPill("error")
		warn("[BloxSmith] Stop Play mode first so I can apply this permanently in Studio edit mode.")
		local reports = {}
		for _, a in ipairs(actions) do
			if a.id then
				table.insert(reports, {
					id = a.id, status = "failed",
					error = "Stop Play mode first so I can apply this permanently in Studio edit mode.",
				})
			end
		end
		if #reports > 0 then
			pcall(function() postJSON("/report", { reports = reports }) end)
		end
		return
	end

	setPill("executing")
	local recordingId = nil
	if ChangeHistoryService.TryBeginRecording then
		recordingId = ChangeHistoryService:TryBeginRecording(
			"BloxSmith " .. (sourceLabel or "build"),
			"BloxSmith AI generation"
		)
	else
		ChangeHistoryService:SetWaypoint("BloxSmith pre-build")
	end

	local ok, fail = 0, 0
	local reports = {}
	for _, a in ipairs(actions) do
		local success, e = pcall(dispatch, a)
		local executed = success and e ~= false
		if executed then
			ok = ok + 1
			if a.id then table.insert(reports, { id = a.id, status = "executed" }) end
		else
			fail = fail + 1
			local errMsg = tostring(e)
			if a.id then table.insert(reports, { id = a.id, status = "failed", error = errMsg }) end
			pcall(function()
				postJSON("/errors", { errors = {{
					projectId = activeProjectId,
					action_type = a.type,
					action_id   = a.id,
					error_message = errMsg,
				}}})
			end)
		end
	end

	if #reports > 0 then
		pcall(function() postJSON("/report", { reports = reports }) end)
	end

	if recordingId then
		pcall(function() ChangeHistoryService:FinishRecording(recordingId, Enum.FinishRecordingOperation.Commit) end)
	else
		ChangeHistoryService:SetWaypoint(("BloxSmith built %d (%d failed)"):format(ok, fail))
	end

	if fail > 0 then setPill("error") else setPill("complete") end
	appendLog(("Command executed: %d ok, %d failed"):format(ok, fail))

	task.defer(pushSnapshot)
	task.delay(3, function()
		if connected then setPill("connected") end
	end)

	syncInfo.Text = ("Built %d action(s)%s · %s · undoable"):format(
		ok, (fail > 0 and (" · " .. fail .. " failed") or ""), os.date("%H:%M:%S"))
end

-- Tells the website "these actions were rejected" so the build status doesn't
-- hang forever in the dashboard.
local function reportDiscarded(actions)
	local reports = {}
	for _, a in ipairs(actions) do
		if a.id then
			table.insert(reports, { id = a.id, status = "failed", error = "Discarded in Preview Mode" })
		end
	end
	if #reports > 0 then
		pcall(function() postJSON("/report", { reports = reports }) end)
	end
end

-- ============================================================
-- Preview overlay — lists each queued action and lets the user
-- Apply All / Discard All without ever entering Play mode.
-- ============================================================
local previewOverlay = nil
local function closePreviewOverlay()
	if previewOverlay then
		previewOverlay:Destroy()
		previewOverlay = nil
	end
end

local function openPreviewOverlay()
	closePreviewOverlay()
	if #pendingPreview == 0 then
		syncInfo.Text = "Nothing pending. Ask the AI to build something first."
		return
	end

	previewOverlay = Instance.new("Frame", widget)
	previewOverlay.Size = UDim2.fromScale(1, 1)
	previewOverlay.BackgroundColor3 = Color3.new(0, 0, 0)
	previewOverlay.BackgroundTransparency = 0.25
	previewOverlay.BorderSizePixel = 0
	previewOverlay.ZIndex = 60

	local box = Instance.new("Frame", previewOverlay)
	box.Size = UDim2.new(1, -24, 1, -24)
	box.Position = UDim2.new(0, 12, 0, 12)
	box.BackgroundColor3 = C.panel
	box.BorderSizePixel = 0
	box.ZIndex = 61
	corner(box, 10)
	stroke(box, C.stroke, 1)

	local pad = Instance.new("UIPadding", box)
	pad.PaddingTop = UDim.new(0, 12)
	pad.PaddingBottom = UDim.new(0, 12)
	pad.PaddingLeft = UDim.new(0, 12)
	pad.PaddingRight = UDim.new(0, 12)

	local title = Instance.new("TextLabel", box)
	title.BackgroundTransparency = 1
	title.Size = UDim2.new(1, 0, 0, 22)
	title.Text = ("🔍  Preview — %d pending action(s)"):format(#pendingPreview)
	title.Font = Enum.Font.GothamBold
	title.TextSize = 14
	title.TextColor3 = C.text
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.ZIndex = 62

	local subtitle = Instance.new("TextLabel", box)
	subtitle.BackgroundTransparency = 1
	subtitle.Position = UDim2.new(0, 0, 0, 24)
	subtitle.Size = UDim2.new(1, 0, 0, 16)
	subtitle.Text = "Review what the AI generated. Apply All inserts into Studio (edit mode, undoable)."
	subtitle.Font = Enum.Font.Gotham
	subtitle.TextSize = 11
	subtitle.TextColor3 = C.textDim
	subtitle.TextXAlignment = Enum.TextXAlignment.Left
	subtitle.ZIndex = 62

	local scroll = Instance.new("ScrollingFrame", box)
	scroll.Position = UDim2.new(0, 0, 0, 46)
	scroll.Size = UDim2.new(1, 0, 1, -88)
	scroll.BackgroundColor3 = C.bg
	scroll.BorderSizePixel = 0
	scroll.CanvasSize = UDim2.new(0, 0, 0, 0)
	scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
	scroll.ScrollBarThickness = 6
	scroll.ZIndex = 62
	corner(scroll, 6)

	local listLayout = Instance.new("UIListLayout", scroll)
	listLayout.Padding = UDim.new(0, 6)
	listLayout.SortOrder = Enum.SortOrder.LayoutOrder
	local scrollPad = Instance.new("UIPadding", scroll)
	scrollPad.PaddingTop = UDim.new(0, 6)
	scrollPad.PaddingBottom = UDim.new(0, 6)
	scrollPad.PaddingLeft = UDim.new(0, 8)
	scrollPad.PaddingRight = UDim.new(0, 8)

	for i, a in ipairs(pendingPreview) do
		local row = Instance.new("Frame", scroll)
		row.LayoutOrder = i
		row.BackgroundColor3 = C.panel
		row.BorderSizePixel = 0
		row.AutomaticSize = Enum.AutomaticSize.Y
		row.Size = UDim2.new(1, -4, 0, 0)
		row.ZIndex = 63
		corner(row, 6)
		stroke(row, C.stroke, 1)
		local rp = Instance.new("UIPadding", row)
		rp.PaddingTop = UDim.new(0, 6); rp.PaddingBottom = UDim.new(0, 6)
		rp.PaddingLeft = UDim.new(0, 8); rp.PaddingRight = UDim.new(0, 8)
		local rl = Instance.new("UIListLayout", row)
		rl.Padding = UDim.new(0, 4); rl.SortOrder = Enum.SortOrder.LayoutOrder

		local header = Instance.new("TextLabel", row)
		header.LayoutOrder = 1
		header.BackgroundTransparency = 1
		header.AutomaticSize = Enum.AutomaticSize.Y
		header.Size = UDim2.new(1, 0, 0, 0)
		header.Font = Enum.Font.GothamMedium
		header.TextSize = 12
		header.TextColor3 = C.text
		header.TextXAlignment = Enum.TextXAlignment.Left
		header.TextYAlignment = Enum.TextYAlignment.Top
		header.TextWrapped = true
		local headerText = ("%s — %s"):format(tostring(a.type or "?"), tostring(a.name or a.className or a.parent or ""))
		if a.parent then headerText = headerText .. ("   ·  in %s"):format(tostring(a.parent)) end
		header.Text = headerText
		header.ZIndex = 64

		if a.source and #a.source > 0 then
			local snippet = a.source
			if #snippet > 1200 then snippet = snippet:sub(1, 1200) .. "\n... (truncated)" end
			local code = Instance.new("TextLabel", row)
			code.LayoutOrder = 2
			code.BackgroundColor3 = C.bg
			code.BorderSizePixel = 0
			code.AutomaticSize = Enum.AutomaticSize.Y
			code.Size = UDim2.new(1, 0, 0, 0)
			code.Font = Enum.Font.Code
			code.TextSize = 10
			code.TextColor3 = C.textDim
			code.TextXAlignment = Enum.TextXAlignment.Left
			code.TextYAlignment = Enum.TextYAlignment.Top
			code.TextWrapped = true
			code.Text = snippet
			code.ZIndex = 64
			corner(code, 4)
			local cp = Instance.new("UIPadding", code)
			cp.PaddingTop = UDim.new(0, 4); cp.PaddingBottom = UDim.new(0, 4)
			cp.PaddingLeft = UDim.new(0, 6); cp.PaddingRight = UDim.new(0, 6)
		end
	end

	-- Bottom button row
	local btnRow = Instance.new("Frame", box)
	btnRow.AnchorPoint = Vector2.new(0, 1)
	btnRow.Position = UDim2.new(0, 0, 1, 0)
	btnRow.Size = UDim2.new(1, 0, 0, 32)
	btnRow.BackgroundTransparency = 1
	btnRow.ZIndex = 62
	local bl = Instance.new("UIListLayout", btnRow)
	bl.FillDirection = Enum.FillDirection.Horizontal
	bl.HorizontalAlignment = Enum.HorizontalAlignment.Right
	bl.Padding = UDim.new(0, 8)

	local function bigBtn(text, color, textColor, order)
		local b = Instance.new("TextButton", btnRow)
		b.LayoutOrder = order
		b.Size = UDim2.new(0, 130, 1, 0)
		b.BackgroundColor3 = color
		b.TextColor3 = textColor
		b.Font = Enum.Font.GothamBold
		b.TextSize = 12
		b.BorderSizePixel = 0
		b.AutoButtonColor = true
		b.Text = text
		b.ZIndex = 63
		corner(b, 6)
		return b
	end

	local cancel  = bigBtn("Close",       C.panel,   C.textDim, 1)
	local discard = bigBtn("Discard All", C.panel,   Color3.fromRGB(240,80,80), 2)
	local apply   = bigBtn("Apply All",   C.primary, Color3.new(1,1,1), 3)
	stroke(cancel, C.stroke, 1); stroke(discard, C.stroke, 1)

	cancel.MouseButton1Click:Connect(closePreviewOverlay)
	discard.MouseButton1Click:Connect(function()
		local batch = pendingPreview
		pendingPreview = {}
		previewSeenIds = {}
		refreshReviewBtnLabel()
		closePreviewOverlay()
		reportDiscarded(batch)
		syncInfo.Text = ("Discarded %d pending action(s)"):format(#batch)
	end)
	apply.MouseButton1Click:Connect(function()
		local batch = pendingPreview
		pendingPreview = {}
		previewSeenIds = {}
		refreshReviewBtnLabel()
		closePreviewOverlay()
		applyActions(batch, "preview apply")
	end)
end

reviewBtn.MouseButton1Click:Connect(openPreviewOverlay)
previewToggleBtn.MouseButton1Click:Connect(function()
	setPreview(not getPreview())
	refreshPreviewToggleLabel()
	if not getPreview() and #pendingPreview > 0 then
		-- Turning preview OFF with pending items: apply them now.
		local batch = pendingPreview
		pendingPreview = {}
		previewSeenIds = {}
		refreshReviewBtnLabel()
		applyActions(batch, "preview off")
	end
end)

local function pull(manual)
	if not activeProjectId then return end
	if getPaused() then syncInfo.Text = "Paused — incoming actions are ignored"; return end
	local data, err = postJSON("/sync", { projectId = activeProjectId, manual = manual == true })
	if not data then syncInfo.Text = "Sync error: " .. tostring(err); return end

	local actions = data.actions or {}
	if #actions == 0 then return end
	appendLog("Command received: " .. tostring(#actions) .. " action(s)")

	-- Preview mode: stash actions for user review, do NOT touch the place.
	if getPreview() then
		local added = 0
		for _, a in ipairs(actions) do
			local key = a.id or (tostring(a.type) .. ":" .. tostring(a.name) .. ":" .. tostring(a.parent))
			if not previewSeenIds[key] then
				previewSeenIds[key] = true
				table.insert(pendingPreview, a)
				added = added + 1
			end
		end
		refreshReviewBtnLabel()
		if added > 0 then
			syncInfo.Text = ("Preview mode: %d new action(s) queued · click Review Pending"):format(added)
			setPill("idle")
		end
		return
	end

	local fp = fingerprintActions(actions)
	if fp == lastFingerprint then return end
	lastFingerprint = fp

	applyActions(actions, "build")
end


local function pushContext(force)
	if not activeProjectId then return end
	local now = os.time()
	if not force and (now - lastContextSentAt) < CTX_SECONDS then return end
	lastContextSentAt = now
	local ctx = buildContext()
	local _, err = postJSON("/context", { projectId = activeProjectId, context = ctx })
	if err then
		ctxInfo.Text = "Context error: " .. tostring(err)
	else
		ctxInfo.Text = ("Context: %d instances%s"):format(
			ctx.instanceCount, ctx.truncated and " (truncated)" or "")
	end
end

-- One-time consent dialog. Discloses exactly what data leaves Studio and
-- where it goes, in line with Roblox's plugin Community Standards (transparency
-- about HTTP requests + remote code/asset insertion).
local function showConsentDialog(onAccept)
	pcall(function() widget.Enabled = true end)
	local overlay = Instance.new("Frame", widget)
	overlay.Size = UDim2.fromScale(1,1)
	overlay.BackgroundColor3 = Color3.new(0,0,0)
	overlay.BackgroundTransparency = 0.3
	overlay.BorderSizePixel = 0
	overlay.ZIndex = 50

	local box = Instance.new("Frame", overlay)
	box.Size = UDim2.new(1,-24,1,-24)
	box.Position = UDim2.new(0,12,0,12)
	box.BackgroundColor3 = C.panel
	box.BorderSizePixel = 0
	box.ZIndex = 51
	corner(box, 10); stroke(box, C.stroke, 1); padAll(box, 14)

	local boxList = Instance.new("UIListLayout", box)
	boxList.Padding = UDim.new(0,8); boxList.SortOrder = Enum.SortOrder.LayoutOrder

	local h = Instance.new("TextLabel", box)
	h.LayoutOrder = 1; h.BackgroundTransparency = 1
	h.Size = UDim2.new(1,0,0,20)
	h.Font = Enum.Font.GothamBold; h.TextSize = 14
	h.TextColor3 = C.text; h.Text = "Before you connect"
	h.TextXAlignment = Enum.TextXAlignment.Left; h.ZIndex = 52

	local body = Instance.new("TextLabel", box)
	body.LayoutOrder = 2; body.BackgroundTransparency = 1
	body.Size = UDim2.new(1,0,0,180); body.AutomaticSize = Enum.AutomaticSize.Y
	body.Font = Enum.Font.Gotham; body.TextSize = 11
	body.TextColor3 = C.textDim; body.TextWrapped = true
	body.TextXAlignment = Enum.TextXAlignment.Left
	body.TextYAlignment = Enum.TextYAlignment.Top
	body.ZIndex = 52
	body.Text =
		"BloxSmith communicates with bloxsmith.pro to let an AI generate Roblox code for you. " ..
		"By connecting you agree that this plugin will:\n\n" ..
		"  • Send your scripts' source and a snapshot of your workspace tree (instance names, " ..
		"classes, properties — no players or PII) to bloxsmith.pro.\n" ..
		"  • Apply the scripts, parts, GUIs, RemoteEvents and free-model assets the AI returns " ..
		"into your open place. Every batch is recorded as one undoable step (Ctrl+Z).\n" ..
		"  • Use Roblox's InsertService to load only public Toolbox / free-model assets by ID.\n\n" ..
		"You can pause sync or disconnect at any time. BloxSmith does not modify games you do " ..
		"not own, does not collect player data, and follows Roblox's Plugin Community Standards."

	local btnRow = Instance.new("Frame", box)
	btnRow.LayoutOrder = 3; btnRow.BackgroundTransparency = 1
	btnRow.Size = UDim2.new(1,0,0,34); btnRow.ZIndex = 52

	local cancel = Instance.new("TextButton", btnRow)
	cancel.Size = UDim2.new(0.45,-4,1,0); cancel.Position = UDim2.new(0,0,0,0)
	cancel.BackgroundColor3 = C.disconnect; cancel.TextColor3 = C.text
	cancel.Font = Enum.Font.GothamMedium; cancel.TextSize = 12
	cancel.Text = "Cancel"; cancel.BorderSizePixel = 0; cancel.ZIndex = 52
	corner(cancel, 6)

	local accept = Instance.new("TextButton", btnRow)
	accept.Size = UDim2.new(0.55,-4,1,0); accept.Position = UDim2.new(0.45,8,0,0)
	accept.BackgroundColor3 = C.primary; accept.TextColor3 = Color3.new(1,1,1)
	accept.Font = Enum.Font.GothamBold; accept.TextSize = 12
	accept.Text = "I agree — Connect"; accept.BorderSizePixel = 0; accept.ZIndex = 52
	corner(accept, 6)

	cancel.MouseButton1Click:Connect(function() overlay:Destroy() end)
	accept.MouseButton1Click:Connect(function()
		setConsent(true)
		overlay:Destroy()
		onAccept()
	end)
end

local function doConnect()
	setToken(tokenBox.Text)
	status.Text = "Connecting..."
	setPill("connecting")
	local data, err = postJSON("/auth", {})
	if not data then
		status.Text = "Failed: " .. tostring(err)
		setPill("offline")
		appendLog("Connection error: " .. tostring(err))
		-- If it's a permanent authentication error (401 or 403), stop auto-retrying
		if err and (string.find(err, "401") or string.find(err, "403")) then
			shouldBeConnected = false
			status.Text = "Auth Failed (check token)"
		end
		return false
	end
	connected = true
	status.Text = "Connected as " .. (data.user.display_name or data.user.email)
	status.TextColor3 = C.text
	connectBtn.Text = "Disconnect"
	connectBtn:SetAttribute("Base", "disconnect")
	connectBtn.BackgroundColor3 = C.disconnect
	connectGrad.Enabled = false
	setPill("connected")
	appendLog("Plugin connected")

	local first = (data.projects or {})[1]
	if first then
		activeProjectId = first.id; activeProjectName = first.name
		syncInfo.Text = "Auto-building: " .. first.name
		syncInfo.TextColor3 = C.text
		pushContext(true)
		pull()
		task.defer(pushSnapshot)
	else
		syncInfo.Text = "No projects yet — create one on the website"
	end
	return true
end

local function connect()
	shouldBeConnected = true
	if not getConsent() then
		showConsentDialog(doConnect)
		return
	end
	doConnect()
end

local function disconnect()
	shouldBeConnected = false
	connected = false; activeProjectId = nil
	lastFingerprint = nil; lastContextSentAt = 0
	scanInProgress = false; scanCancelRequested = false
	status.Text = "Not connected"; status.TextColor3 = C.textDim
	syncInfo.Text = "—"; syncInfo.TextColor3 = C.textDim
	ctxInfo.Text = "—"; ctxInfo.TextColor3 = C.textDim
	connectBtn.Text = "Connect"
	connectBtn:SetAttribute("Base", "primary")
	connectBtn.BackgroundColor3 = C.primary
	connectGrad.Enabled = true
	setPill("offline")
	appendLog("Plugin disconnected")
end

connectBtn.MouseButton1Click:Connect(function()
	if connected or shouldBeConnected then disconnect() else connect() end
end)
syncNowBtn.MouseButton1Click:Connect(function()
	if not connected then
		syncInfo.Text = "Connect before syncing"
		appendLog("Sync requested while offline")
		return
	end
	task.spawn(function()
		pushContext(true)
		pull(true) -- user-initiated: bypass "Manual sync only" gating server-side
		pushSnapshot()
	end)
end)
reconnectBtn.MouseButton1Click:Connect(function()
	disconnect()
	shouldBeConnected = true
	task.defer(connect)
end)
cancelScanBtn.MouseButton1Click:Connect(function()
	scanCancelRequested = true
	appendLog("Scan cancel requested")
end)
cleanSyncedBtn.MouseButton1Click:Connect(function()
	-- Remove the artifacts the old buggy sync left behind:
	--   1) ServerStorage/__BloxSmithPreloadToken
	--   2) Duplicate / recursively-nested StarterPlayerScripts folders inside StarterPlayer
	--   3) Stray loose script copies directly under StarterPlayer (they belong in StarterPlayerScripts)
	local removed = 0
	local recId
	if ChangeHistoryService.TryBeginRecording then
		recId = ChangeHistoryService:TryBeginRecording("BloxSmith clean synced", "Remove auto-sync artifacts")
	end

	local tok = ServerStorage:FindFirstChild("__BloxSmithPreloadToken")
	if tok then tok:Destroy(); removed = removed + 1 end

	local sps = StarterPlayer:FindFirstChild("StarterPlayerScripts")
	if sps then
		-- Kill any nested StarterPlayerScripts inside StarterPlayerScripts
		local function killNested(parent, depth)
			if depth > 8 then return end
			for _, child in ipairs(parent:GetChildren()) do
				if child.Name == "StarterPlayerScripts" then
					child:Destroy(); removed = removed + 1
				else
					killNested(child, depth + 1)
				end
			end
		end
		killNested(sps, 0)
	end

	-- Remove any loose script (Script/LocalScript/ModuleScript) directly under StarterPlayer
	for _, child in ipairs(StarterPlayer:GetChildren()) do
		if child:IsA("LuaSourceContainer") then
			child:Destroy(); removed = removed + 1
		end
	end

	if recId and ChangeHistoryService.FinishRecording then
		ChangeHistoryService:FinishRecording(recId, Enum.FinishRecordingOperation.Commit)
	end

	syncInfo.Text = ("Cleaned %d auto-synced artifact(s)"):format(removed)
	appendLog("Clean Synced: removed " .. tostring(removed) .. " object(s)")
	task.defer(pushSnapshot)
end)
button.Click:Connect(function() widget.Enabled = not widget.Enabled end)

-- Background loop: pull actions + push context + auto-reconnect retries
task.spawn(function()
	local lastRetryTime = 0
	while true do
		task.wait(POLL_SECONDS)
		
		-- Auto-reconnect/retry connection if shouldBeConnected is true but we are offline
		if shouldBeConnected and not connected then
			local now = os.time()
			if now - lastRetryTime >= 5 then
				lastRetryTime = now
				pcall(doConnect)
			end
		end
		
		if connected then
			pcall(pull)
			pcall(pushContext, false)
		end
	end
end)

-- React to user-side changes so AI stays in sync
Workspace.DescendantAdded:Connect(function()
	if connected then lastContextSentAt = 0 end
end)
Workspace.DescendantRemoving:Connect(function()
	if connected then lastContextSentAt = 0 end
end)

-- Auto-connect only if a token is saved AND the user has previously granted
-- consent. First-run users always see the disclosure dialog.
if getToken() ~= "" and getConsent() then
	shouldBeConnected = true
	task.defer(doConnect)
end
