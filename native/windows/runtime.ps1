$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$PSModuleAutoLoadingPreference = "None"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# Import only the inbox signing module by its absolute PSHOME path. Autoloading
# remains disabled so PSModulePath cannot redirect security-sensitive commands.
$securityModule = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
if (-not (Test-Path -LiteralPath $securityModule -PathType Leaf)) {
    throw "provider_unavailable: inbox PowerShell signing module is missing"
}
[void](Import-Module -LiteralPath $securityModule -Force -PassThru)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CrossHandsDesktopWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint flags);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool GetUserObjectInformation(IntPtr handle, int index, System.Text.StringBuilder info, int length, out int needed);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int returnLength);

    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    public static int GetProcessIntegrityRid(int processId) {
        IntPtr process = OpenProcess(0x1000, false, processId);
        if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        IntPtr token = IntPtr.Zero;
        IntPtr buffer = IntPtr.Zero;
        try {
            if (!OpenProcessToken(process, 0x0008, out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            int needed;
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed);
            buffer = Marshal.AllocHGlobal(needed);
            if (!GetTokenInformation(token, 25, buffer, needed, out needed)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            IntPtr sid = Marshal.ReadIntPtr(buffer);
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        } finally {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }
}
"@

# PER_MONITOR_AWARE_V2 keeps UIA screen coordinates, screenshots and Win32
# input in the same physical coordinate system on mixed-DPI displays.
try { [void][CrossHandsDesktopWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}

$MaxNodes = 1200
$MaxDepth = 64
$TextLimit = 500
$MaxScreenshotPngBytes = 900000
$MaxScreenshotEdge = 1280
$MinScreenshotScale = 0.25
$ScreenshotScaleStep = 0.85
$BlockedAppFragments = @(
    "1password",
    "bitwarden",
    "dashlane",
    "lastpass",
    "nordpass",
    "proton pass"
)

$WindowsMessages = @{
    Char = 0x0102
    KeyDown = 0x0100
    KeyUp = 0x0101
    MouseMove = 0x0200
    LeftDown = 0x0201
    LeftUp = 0x0202
    RightDown = 0x0204
    RightUp = 0x0205
    MiddleDown = 0x0207
    MiddleUp = 0x0208
    Wheel = 0x020A
}

$MouseEvents = @{
    LeftDown = 0x0002
    LeftUp = 0x0004
    RightDown = 0x0008
    RightUp = 0x0010
    MiddleDown = 0x0020
    MiddleUp = 0x0040
    Wheel = 0x0800
}

function Write-CrossHandsJson($Payload) {
    $Payload | ConvertTo-Json -Depth 100 -Compress
}

function New-CrossHandsFrame([double]$X, [double]$Y, [double]$Width, [double]$Height) {
    if ($Width -le 0 -or $Height -le 0) { return $null }
    [pscustomobject]@{ x = $X; y = $Y; width = $Width; height = $Height }
}

function ConvertTo-CrossHandsLParam([int]$X, [int]$Y) {
    [IntPtr]((($Y -band 0xffff) -shl 16) -bor ($X -band 0xffff))
}

function ConvertTo-CrossHandsWheelParam([int]$Delta) {
    [IntPtr](($Delta -band 0xffff) -shl 16)
}

function Get-CrossHandsWindowProcesses {
    @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object ProcessName, Id)
}

function Get-CrossHandsInputDesktopName {
    $desktop = [CrossHandsDesktopWin32]::OpenInputDesktop(0, $false, 0x0040)
    if ($desktop -eq [IntPtr]::Zero) { return $null }
    try {
        $needed = 0
        [void][CrossHandsDesktopWin32]::GetUserObjectInformation($desktop, 2, $null, 0, [ref]$needed)
        $name = New-Object System.Text.StringBuilder ([Math]::Max(256, $needed))
        if (-not [CrossHandsDesktopWin32]::GetUserObjectInformation($desktop, 2, $name, $name.Capacity, [ref]$needed)) { return $null }
        $name.ToString()
    } finally {
        [void][CrossHandsDesktopWin32]::CloseDesktop($desktop)
    }
}

function Assert-CrossHandsInteractiveSession {
    if ([CrossHandsDesktopWin32]::GetSystemMetrics(0x1000) -ne 0) {
        throw "session_unavailable: remote desktop sessions are outside the CrossHands v1 trust boundary"
    }
    $desktop = Get-CrossHandsInputDesktopName
    if ([string]::IsNullOrWhiteSpace($desktop)) {
        throw "session_unavailable: the interactive desktop is locked or unavailable"
    }
    if ($desktop -ine "Default") {
        throw "unsupported_capability: secure or non-default desktops are not supported"
    }
}

function Get-CrossHandsSha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Get-CrossHandsProcessIdentity($Process) {
    $path = [string]$Process.Path
    $publisher = "unavailable"
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        if ($null -ne $signature.SignerCertificate) { $publisher = [string]$signature.SignerCertificate.Subject }
        elseif ($signature.Status -eq "NotSigned") { $publisher = "unsigned" }
    } catch {}
    [pscustomobject]@{
        pid = [int]$Process.Id
        startedAt = $Process.StartTime.ToUniversalTime().ToString("o")
        sessionId = [int]$Process.SessionId
        desktop = Get-CrossHandsInputDesktopName
        executablePath = [System.IO.Path]::GetFullPath($path)
        integrityRid = [CrossHandsDesktopWin32]::GetProcessIntegrityRid([int]$Process.Id)
        publisher = $publisher
        sha256 = Get-CrossHandsSha256 $path
    }
}

function Assert-CrossHandsProcessIdentity($Process, $Expected) {
    Assert-CrossHandsInteractiveSession
    try { $actual = Get-CrossHandsProcessIdentity $Process }
    catch { throw "unsupported_capability: target identity or token cannot be inspected at equal integrity" }
    $selfIntegrity = [CrossHandsDesktopWin32]::GetProcessIntegrityRid($PID)
    if ($actual.sessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) {
        throw "session_unavailable: target belongs to another logon session"
    }
    if ($actual.integrityRid -ne $selfIntegrity) {
        throw "unsupported_capability: target integrity differs from the CrossHands provider"
    }
    if ($null -ne $Expected) {
        foreach ($property in @("pid", "startedAt", "sessionId", "desktop", "executablePath", "integrityRid", "publisher", "sha256")) {
            if ([string]$actual.$property -cne [string]$Expected.$property) {
                throw "stale_target: target process identity changed ($property)"
            }
        }
    }
    $actual
}

function Find-CrossHandsProcess([string]$Query) {
    $needle = ""
    if ($null -ne $Query) { $needle = $Query.Trim() }
    if ([string]::IsNullOrWhiteSpace($needle)) { throw 'appNotFound("")' }
    if ($needle.StartsWith("pid:", [System.StringComparison]::OrdinalIgnoreCase)) {
        $needle = $needle.Substring(4)
    }

    $parsedProcessId = 0
    $processes = Get-CrossHandsWindowProcesses
    if ([int]::TryParse($needle, [ref]$parsedProcessId)) {
        $match = $processes | Where-Object { $_.Id -eq $parsedProcessId } | Select-Object -First 1
        if ($null -ne $match) {
            Assert-CrossHandsProcessAllowed $match
            return $match
        }
    }

    $processNeedle = $needle
    if ($processNeedle.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        $processNeedle = $processNeedle.Substring(0, $processNeedle.Length - 4)
    }

    $match = $processes | Where-Object {
        $_.ProcessName -ieq $processNeedle -or
        "$($_.ProcessName).exe" -ieq $needle -or
        $_.MainWindowTitle -ieq $needle -or
        $_.MainWindowTitle -ilike "*$needle*"
    } | Select-Object -First 1
    if ($null -ne $match) {
        Assert-CrossHandsProcessAllowed $match
        return $match
    }

    throw "appNotFound(`"$Query`")"
}

function Assert-CrossHandsProcessAllowed($Process) {
    $values = @($Process.ProcessName, $Process.MainWindowTitle) | ForEach-Object { ([string]$_).ToLowerInvariant() }
    foreach ($fragment in $BlockedAppFragments) {
        foreach ($value in $values) {
            if ($value.Contains($fragment)) {
                throw "appBlocked(`"$($Process.ProcessName)`")"
            }
        }
    }
}

function Test-CrossHandsBrowserProcess($Process) {
    $name = ([string]$Process.ProcessName).ToLowerInvariant()
    $browserProcesses = @(
        "arc",
        "brave",
        "chrome",
        "chromium",
        "firefox",
        "librewolf",
        "msedge",
        "opera",
        "vivaldi",
        "zen"
    )
    $browserProcesses -contains $name
}

function Get-CrossHandsRootElement($Process) {
    if ($Process.MainWindowHandle -eq 0) {
        throw "No top-level UI Automation window is available for $($Process.ProcessName)."
    }
    [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Process.MainWindowHandle)
}

function Get-CrossHandsWindowFrame($Process, $RootElement) {
    $rect = New-Object CrossHandsDesktopWin32+RECT
    if ([CrossHandsDesktopWin32]::GetWindowRect([IntPtr]$Process.MainWindowHandle, [ref]$rect)) {
        return New-CrossHandsFrame $rect.Left $rect.Top ($rect.Right - $rect.Left) ($rect.Bottom - $rect.Top)
    }

    try {
        $bounds = $RootElement.Current.BoundingRectangle
        if (-not $bounds.IsEmpty) {
            return New-CrossHandsFrame $bounds.X $bounds.Y $bounds.Width $bounds.Height
        }
    } catch {}
    $null
}

function Get-CrossHandsWindowId($Process) {
    [int64]$Process.MainWindowHandle
}

function Get-CrossHandsAppName($Process) {
    if ($Process.ProcessName -eq "ApplicationFrameHost" -and -not [string]::IsNullOrWhiteSpace($Process.MainWindowTitle)) {
        return [string]$Process.MainWindowTitle
    }
    [string]$Process.ProcessName
}

function New-CrossHandsAppRecord($Process) {
    [pscustomobject]@{
        name = Get-CrossHandsAppName $Process
        bundleIdentifier = $Process.ProcessName
        bundleId = $Process.ProcessName
        pid = [int]$Process.Id
    }
}

function Assert-CrossHandsWindowTarget($Process, $WindowId, $WindowIndex) {
    if ($null -ne $WindowIndex -and [int]$WindowIndex -ne 0) {
        throw "windowNotFound(`"$WindowIndex`")"
    }
    if ($null -ne $WindowId -and [int64]$WindowId -ne (Get-CrossHandsWindowId $Process)) {
        throw "windowNotFound(`"$WindowId`")"
    }
}

function Restore-CrossHandsWindow($Process) {
    if ($Process.MainWindowHandle -eq 0) { return }
    [void][CrossHandsDesktopWin32]::ShowWindow([IntPtr]$Process.MainWindowHandle, 9)
    [void][CrossHandsDesktopWin32]::SetForegroundWindow([IntPtr]$Process.MainWindowHandle)
}

function Test-CrossHandsWindowFocused([IntPtr]$WindowHandle) {
    [CrossHandsDesktopWin32]::GetForegroundWindow() -eq $WindowHandle
}

function Wait-CrossHandsWindowFocused([IntPtr]$WindowHandle, [int]$TimeoutMilliseconds) {
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        if (Test-CrossHandsWindowFocused $WindowHandle) { return $true }
        Start-Sleep -Milliseconds 50
    }
    Test-CrossHandsWindowFocused $WindowHandle
}

function Assert-CrossHandsKeyboardFocus([IntPtr]$WindowHandle, $Operation) {
    if (Test-CrossHandsWindowFocused $WindowHandle) { return }
    if ([bool]$Operation.restoreWindow) {
        if (Wait-CrossHandsWindowFocused $WindowHandle 500) { return }
        throw "window_not_focused: keyboard input requires the target window to be focused; restoreWindow was requested but the target window is still not focused; bring it forward manually or check desktop permissions"
    }
    throw "window_not_focused: keyboard input requires the target window to be focused; retry with --restore-window"
}

function Get-CrossHandsElementFrame($Element, $WindowFrame) {
    try {
        $bounds = $Element.Current.BoundingRectangle
        if ($bounds.IsEmpty) { return $null }
        if ($null -eq $WindowFrame) {
            return New-CrossHandsFrame $bounds.X $bounds.Y $bounds.Width $bounds.Height
        }
        New-CrossHandsFrame ($bounds.X - $WindowFrame.x) ($bounds.Y - $WindowFrame.y) $bounds.Width $bounds.Height
    } catch {
        $null
    }
}

function Get-CrossHandsProperty($Element, [string]$Name) {
    try { [string]$Element.Current.$Name } catch { "" }
}

function Get-CrossHandsRuntimeId($Element) {
    try { @($Element.GetRuntimeId()) } catch { @() }
}

function Test-CrossHandsSensitiveElement($Element) {
    try {
        if ($Element.Current.IsPassword) { return $true }
    } catch {}
    $controlType = try { [string]$Element.Current.ControlType.ProgrammaticName } catch { "" }
    $parts = @(
        (Get-CrossHandsProperty $Element "LocalizedControlType"),
        $controlType,
        (Get-CrossHandsProperty $Element "Name"),
        (Get-CrossHandsProperty $Element "AutomationId"),
        (Get-CrossHandsProperty $Element "ClassName")
    )
    $haystack = (($parts -join " ") -replace "\s+", " ").ToLowerInvariant()
    foreach ($term in @("password", "passcode", "secret", "one-time code", "verification code")) {
        if ($haystack.Contains($term)) { return $true }
    }
    $haystack -match "(^|[^a-z0-9])pin([^a-z0-9]|$)"
}

function Get-CrossHandsValueText($Element) {
    try {
        if (Test-CrossHandsSensitiveElement $Element) { return "[redacted]" }
        $pattern = $Element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        $rawValue = $pattern.Current.Value
        $text = if ($null -eq $rawValue) { "" } else { [string]$rawValue }
        if ($text.Length -gt $TextLimit) { return $text.Substring(0, $TextLimit) + "..." }
        $text
    } catch {
        ""
    }
}

function Get-CrossHandsActions($Element) {
    $actions = New-Object System.Collections.Generic.List[string]
    foreach ($pattern in $Element.GetSupportedPatterns()) {
        $name = [string]$pattern.ProgrammaticName
        if ($name -like "InvokePatternIdentifiers.Pattern") { $actions.Add("Invoke") }
        elseif ($name -like "TogglePatternIdentifiers.Pattern") { $actions.Add("Toggle") }
        elseif ($name -like "SelectionItemPatternIdentifiers.Pattern") { $actions.Add("Select") }
        elseif ($name -like "ScrollPatternIdentifiers.Pattern") { $actions.Add("Scroll") }
        elseif ($name -like "ValuePatternIdentifiers.Pattern") { $actions.Add("SetValue") }
    }
    @($actions | Select-Object -Unique)
}

function Get-CrossHandsMeaningfulActions($Actions) {
    $noisy = @("Invoke", "ScrollToVisible", "ShowMenu")
    @($Actions | Where-Object { $noisy -notcontains $_ })
}

function Format-CrossHandsSnapshotText([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
    (($Text -replace "\s+", " ").Trim())
}

function Format-CrossHandsValueSegment([string]$RoleKey, [string]$Title, [string]$Value) {
    $clean = Format-CrossHandsSnapshotText $Value
    if ([string]::IsNullOrWhiteSpace($clean) -or $clean -eq $Title) { return "" }
    if ($RoleKey -eq "heading" -and $clean -match "^\d+$") { return "" }
    if ($RoleKey -in @("text", "edit", "document", "scroll bar", "progress bar")) {
        return " $clean"
    }
    ", Value: $clean"
}

function Test-CrossHandsSuppressChildren([string]$RoleKey, [string]$Title, [string]$Value, [string]$Summary) {
    $hasCompactLabel = -not [string]::IsNullOrWhiteSpace($Title) -or -not [string]::IsNullOrWhiteSpace((Format-CrossHandsSnapshotText $Value)) -or -not [string]::IsNullOrWhiteSpace((Format-CrossHandsSnapshotText $Summary))
    $hasCompactLabel -and $RoleKey -in @(
        "button",
        "check box",
        "combo box",
        "heading",
        "hyperlink",
        "link",
        "menu item",
        "radio button",
        "tab item"
    )
}

function Get-CrossHandsTextSnippets($Element, [int]$Limit = 6, [int]$MaxDepth = 3) {
    $values = New-Object System.Collections.Generic.List[string]
    $seen = New-Object System.Collections.Generic.HashSet[string]

    function Visit-CrossHandsText($Node, [int]$Depth) {
        if ($values.Count -ge $Limit -or $Depth -gt $MaxDepth) { return }
        $role = try { [string]$Node.Current.LocalizedControlType } catch { "" }
        if ($role -match "text|link|label") {
            foreach ($raw in @((Get-CrossHandsProperty $Node "Name"), (Get-CrossHandsValueText $Node))) {
                $value = (($raw -replace "\s+", " ").Trim())
                if (-not [string]::IsNullOrWhiteSpace($value) -and $seen.Add($value)) {
                    if ($value.Length -gt 80) { $value = $value.Substring(0, 80) + "..." }
                    $values.Add($value)
                    if ($values.Count -ge $Limit) { return }
                }
            }
        }
        try {
            $children = $Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $children.Count; $i++) {
                Visit-CrossHandsText $children.Item($i) ($Depth + 1)
                if ($values.Count -ge $Limit) { return }
            }
        } catch {}
    }

    Visit-CrossHandsText $Element 0
    @($values.ToArray())
}

function Test-CrossHandsPlainTextSubtree($Element, [int]$MaxDepth = 4) {
    $script:sawCrossHandsText = $false
    $allowed = @("pane", "group", "custom", "unknown", "text", "link", "image")

    function Visit-CrossHandsPlainText($Node, [int]$Depth) {
        if ($Depth -gt $MaxDepth) { return $false }
        $role = try { [string]$Node.Current.LocalizedControlType } catch { "" }
        $roleKey = $role.ToLowerInvariant()
        if ($allowed -notcontains $roleKey) { return $false }
        if ($roleKey -match "text|link") { $script:sawCrossHandsText = $true }
        if (@(Get-CrossHandsMeaningfulActions @(Get-CrossHandsActions $Node)).Count -gt 0) { return $false }
        try {
            $children = $Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $children.Count; $i++) {
                if (-not (Visit-CrossHandsPlainText $children.Item($i) ($Depth + 1))) { return $false }
            }
        } catch {}
        return $true
    }

    (Visit-CrossHandsPlainText $Element 0) -and $script:sawCrossHandsText
}

function New-CrossHandsElementRecord($Element, [int]$Index, $WindowFrame) {
    $controlType = try { [string]$Element.Current.ControlType.ProgrammaticName } catch { "" }
    $nativeWindowHandle = try { [int64]$Element.Current.NativeWindowHandle } catch { 0 }
    [pscustomobject]@{
        index = $Index
        runtimeId = @(Get-CrossHandsRuntimeId $Element)
        automationId = Get-CrossHandsProperty $Element "AutomationId"
        name = Get-CrossHandsProperty $Element "Name"
        controlType = $controlType
        localizedControlType = Get-CrossHandsProperty $Element "LocalizedControlType"
        className = Get-CrossHandsProperty $Element "ClassName"
        value = Get-CrossHandsValueText $Element
        isSelected = Test-CrossHandsElementSelected $Element
        nativeWindowHandle = $nativeWindowHandle
        frame = Get-CrossHandsElementFrame $Element $WindowFrame
        actions = @(Get-CrossHandsActions $Element)
    }
}

function Test-CrossHandsElementSelected($Element) {
    try {
        $pattern = $Element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
        return [bool]$pattern.Current.IsSelected
    } catch {
        return $false
    }
}

function Render-CrossHandsTree($RootElement, $WindowFrame, [bool]$CompactBrowserTabs = $false) {
    $records = New-Object System.Collections.Generic.List[object]
    $lines = New-Object System.Collections.Generic.List[string]
    $seen = New-Object System.Collections.Generic.HashSet[string]
    $truncation = [pscustomobject]@{
        truncated = $false
        maxNodes = $MaxNodes
        maxDepth = $MaxDepth
        maxDepthReached = $false
    }

    function Visit-CrossHandsNode($Node, [int]$Depth) {
        if ($records.Count -ge $MaxNodes -or $Depth -gt $MaxDepth) {
            $truncation.truncated = $true
            if ($Depth -gt $MaxDepth) { $truncation.maxDepthReached = $true }
            return
        }
        $identity = try { (@($Node.GetRuntimeId()) -join ".") } catch { [Guid]::NewGuid().ToString() }
        if (-not $seen.Add($identity)) { return }

        $record = New-CrossHandsElementRecord $Node $records.Count $WindowFrame
        $children = @()
        try {
            $children = @($Node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition))
        } catch {}
        $meaningfulActions = @(Get-CrossHandsMeaningfulActions $record.actions)
        $title = if ([string]::IsNullOrWhiteSpace($record.name)) { $record.automationId } else { $record.name }
        $role = if ([string]::IsNullOrWhiteSpace($record.localizedControlType)) { $record.controlType } else { $record.localizedControlType }
        $roleKey = $role.ToLowerInvariant()
        $snippets = @(Get-CrossHandsTextSnippets $Node 8 4)
        $genericSummary = $null
        if (($roleKey -in @("pane", "group", "custom", "unknown")) -and [string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($record.value) -and $snippets.Count -ge 2 -and (Test-CrossHandsPlainTextSubtree $Node)) {
            $genericSummary = ($snippets -join " ")
        }
        if (($roleKey -in @("pane", "group", "custom", "unknown")) -and [string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($record.value) -and $meaningfulActions.Count -eq 0 -and $null -eq $genericSummary -and $children.Count -le 1) {
            for ($i = 0; $i -lt $children.Count; $i++) {
                Visit-CrossHandsNode $children.Item($i) $Depth
            }
            return
        }

        $records.Add($record)

        $line = "$($record.index) $role $(Format-CrossHandsSnapshotText $title)".TrimEnd()
        $line += Format-CrossHandsValueSegment $roleKey $title $record.value
        if (-not [string]::IsNullOrWhiteSpace($genericSummary) -and $genericSummary -ne $title) {
            $line += ", Text: " + (Format-CrossHandsSnapshotText $genericSummary)
        } elseif ($roleKey -in @("row", "data item", "list item")) {
            $rowSummary = @((Get-CrossHandsTextSnippets $Node 6 3)) -join " "
            if (-not [string]::IsNullOrWhiteSpace($rowSummary) -and $rowSummary -ne $title) {
                $line += ", Text: " + (Format-CrossHandsSnapshotText $rowSummary)
            }
        }
        if ($meaningfulActions.Count -gt 0) {
            $line += ", Secondary Actions: " + ($meaningfulActions -join ", ")
        }
        $lines.Add(("`t" * $Depth) + $line)

        if (-not [string]::IsNullOrWhiteSpace($genericSummary) -or (Test-CrossHandsSuppressChildren $roleKey $title $record.value $genericSummary)) { return }
        $childLineStart = $lines.Count
        for ($i = 0; $i -lt $children.Count; $i++) {
            Visit-CrossHandsNode $children.Item($i) ($Depth + 1)
        }
        if ($CompactBrowserTabs) {
            Compress-CrossHandsRenderedBrowserTabs $records $lines $childLineStart ($Depth + 1)
        }
    }

    Visit-CrossHandsNode $RootElement 0
    [pscustomobject]@{ elements = @($records.ToArray()); lines = @($lines.ToArray()); truncation = $truncation }
}

function Compress-CrossHandsRenderedBrowserTabs($Records, $Lines, [int]$StartLine, [int]$Depth) {
    $tabLineIndexes = New-Object System.Collections.Generic.List[int]
    for ($lineIndex = $StartLine; $lineIndex -lt $Lines.Count; $lineIndex++) {
        if (Test-CrossHandsDirectRenderedBrowserTabLine ([string]$Lines[$lineIndex]) $Depth) {
            $tabLineIndexes.Add($lineIndex)
        }
    }
    if ($tabLineIndexes.Count -lt 10) { return }

    $recordsByIndex = @{}
    foreach ($record in @($Records.ToArray())) {
        $recordsByIndex[[int]$record.index] = $record
    }
    $activeLineIndexes = New-Object System.Collections.Generic.HashSet[int]
    foreach ($lineIndex in $tabLineIndexes) {
        if (Test-CrossHandsActiveRenderedBrowserTabLine ([string]$Lines[$lineIndex]) $Depth $recordsByIndex) {
            [void]$activeLineIndexes.Add($lineIndex)
        }
    }
    if ($activeLineIndexes.Count -eq 0) { return }

    $omittedRecordIndexes = New-Object System.Collections.Generic.HashSet[int]
    $omittedCount = 0
    $insertionIndex = $tabLineIndexes[0]
    for ($i = $tabLineIndexes.Count - 1; $i -ge 0; $i--) {
        $lineIndex = $tabLineIndexes[$i]
        if ($activeLineIndexes.Contains($lineIndex)) { continue }
        $recordIndex = Get-CrossHandsRenderedElementIndex ([string]$Lines[$lineIndex]) $Depth
        if ($null -ne $recordIndex) {
            [void]$omittedRecordIndexes.Add([int]$recordIndex)
        }
        $Lines.RemoveAt($lineIndex)
        $omittedCount++
    }
    if ($omittedCount -le 0) { return }
    for ($recordIndex = $Records.Count - 1; $recordIndex -ge 0; $recordIndex--) {
        if ($omittedRecordIndexes.Contains([int]$Records[$recordIndex].index)) {
            $Records.RemoveAt($recordIndex)
        }
    }
    $Lines.Insert($insertionIndex, (("`t" * $Depth) + "... $omittedCount inactive browser tabs omitted"))
}

function Test-CrossHandsDirectRenderedBrowserTabLine([string]$Line, [int]$Depth) {
    $indent = "`t" * $Depth
    if (-not $Line.StartsWith($indent)) { return $false }
    $text = $Line.Substring($indent.Length)
    if ($text.StartsWith("`t")) { return $false }
    $text -match "^\d+ (page tab|tab item|tab)($|[ \(,])"
}

function Test-CrossHandsActiveRenderedBrowserTabLine([string]$Line, [int]$Depth, $RecordsByIndex) {
    if ($Line.Contains("(selected")) { return $true }
    $recordIndex = Get-CrossHandsRenderedElementIndex $Line $Depth
    if ($null -eq $recordIndex -or -not $RecordsByIndex.ContainsKey([int]$recordIndex)) { return $false }
    $record = $RecordsByIndex[[int]$recordIndex]
    [bool]$record.isSelected -or (Format-CrossHandsSnapshotText $record.value) -eq "1"
}

function Get-CrossHandsRenderedElementIndex([string]$Line, [int]$Depth) {
    $text = $Line.Substring(("`t" * $Depth).Length)
    if ($text -match "^(\d+)") { return [int]$Matches[1] }
    $null
}

function ConvertTo-CrossHandsPngBytes([System.Drawing.Image]$Image) {
    $stream = $null
    try {
        $stream = New-Object System.IO.MemoryStream
        $Image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function New-CrossHandsScreenshotPayload([byte[]]$Bytes, [int]$Width, [int]$Height, [double]$Scale) {
    [pscustomobject]@{
        base64 = [Convert]::ToBase64String($Bytes)
        width = $Width
        height = $Height
        scale = $Scale
    }
}

function Resize-CrossHandsBitmap([System.Drawing.Bitmap]$Source, [int]$Width, [int]$Height) {
    $resized = $null
    $graphics = $null
    try {
        $resized = New-Object System.Drawing.Bitmap $Width, $Height
        $graphics = [System.Drawing.Graphics]::FromImage($resized)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
        $graphics.DrawImage($Source, 0, 0, $Width, $Height)
        $result = $resized
        $resized = $null
        return $result
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $resized) { $resized.Dispose() }
    }
}

function Get-CrossHandsBoundedScreenshotPayload([System.Drawing.Bitmap]$Bitmap) {
    $originalWidth = [int][Math]::Max(1, $Bitmap.Width)
    $originalHeight = [int][Math]::Max(1, $Bitmap.Height)
    $pngBytes = ConvertTo-CrossHandsPngBytes $Bitmap
    if ($pngBytes.Length -le $MaxScreenshotPngBytes) {
        return New-CrossHandsScreenshotPayload $pngBytes $originalWidth $originalHeight 1.0
    }

    # Why: screenshots cross process boundaries as PNG base64 in JSON; cap noisy
    # large-window payloads to match the macOS provider's memory bounds.
    $scale = [Math]::Min(1.0, $MaxScreenshotEdge / [double][Math]::Max($originalWidth, $originalHeight))
    while ($scale -ge $MinScreenshotScale) {
        $width = [int][Math]::Max(1, [Math]::Round($originalWidth * $scale))
        $height = [int][Math]::Max(1, [Math]::Round($originalHeight * $scale))
        if ($width -eq $originalWidth -and $height -eq $originalHeight) {
            $scale *= $ScreenshotScaleStep
            continue
        }

        $resized = $null
        try {
            $resized = Resize-CrossHandsBitmap $Bitmap $width $height
            $candidateBytes = ConvertTo-CrossHandsPngBytes $resized
            if ($candidateBytes.Length -le $MaxScreenshotPngBytes) {
                return New-CrossHandsScreenshotPayload $candidateBytes $width $height ($width / [double]$originalWidth)
            }
        } finally {
            if ($null -ne $resized) { $resized.Dispose() }
        }

        $scale *= $ScreenshotScaleStep
    }

    [pscustomobject]@{
        error = [pscustomobject]@{
            code = "screenshot_failed"
            message = "screenshot exceeded the computer-use payload cap after downscaling; retry with --no-screenshot or target a smaller window"
        }
    }
}

function Get-CrossHandsScreenshot([bool]$IncludeScreenshot, [IntPtr]$WindowHandle, $WindowFrame) {
    if (-not $IncludeScreenshot -or $WindowHandle -eq [IntPtr]::Zero -or $null -eq $WindowFrame) { return $null }
    $bitmap = $null
    $graphics = $null
    $hdc = [IntPtr]::Zero
    try {
        $width = [int][Math]::Max(1, [Math]::Round($WindowFrame.width))
        $height = [int][Math]::Max(1, [Math]::Round($WindowFrame.height))
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $hdc = $graphics.GetHdc()
        # PrintWindow captures only the selected HWND. Desktop overlays and
        # unrelated windows must never be sampled into an agent observation.
        if (-not [CrossHandsDesktopWin32]::PrintWindow($WindowHandle, $hdc, 2)) {
            throw "screenshot_failed: target-window capture failed"
        }
        $graphics.ReleaseHdc($hdc)
        $hdc = [IntPtr]::Zero
        Get-CrossHandsBoundedScreenshotPayload $bitmap
    } catch {
        [pscustomobject]@{
            error = [pscustomobject]@{
                code = "screenshot_failed"
                message = "target-window screenshot capture failed; retry with --no-screenshot or verify the target supports PrintWindow"
            }
        }
    } finally {
        if ($hdc -ne [IntPtr]::Zero -and $null -ne $graphics) { $graphics.ReleaseHdc($hdc) }
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
}

function New-CrossHandsSnapshot([string]$Query, [bool]$IncludeScreenshot, $WindowId = $null, $WindowIndex = $null, [bool]$RestoreWindow = $false) {
    Assert-CrossHandsInteractiveSession
    $process = Find-CrossHandsProcess $Query
    if ($RestoreWindow) { Restore-CrossHandsWindow $process }
    Assert-CrossHandsWindowTarget $process $WindowId $WindowIndex
    $root = Get-CrossHandsRootElement $process
    $windowFrame = Get-CrossHandsWindowFrame $process $root
    $tree = Render-CrossHandsTree $root $windowFrame (Test-CrossHandsBrowserProcess $process)
    $screenshot = Get-CrossHandsScreenshot $IncludeScreenshot $process.MainWindowHandle $windowFrame

    [pscustomobject]@{
        snapshotId = [guid]::NewGuid().ToString()
        processIdentity = Get-CrossHandsProcessIdentity $process
        app = New-CrossHandsAppRecord $process
        windowTitle = $process.MainWindowTitle
        windowId = Get-CrossHandsWindowId $process
        windowBounds = $windowFrame
        screenshotPngBase64 = if ($null -ne $screenshot) { $screenshot.base64 } else { $null }
        screenshotWidth = if ($null -ne $screenshot) { $screenshot.width } else { $null }
        screenshotHeight = if ($null -ne $screenshot) { $screenshot.height } else { $null }
        screenshotScale = if ($null -ne $screenshot) { $screenshot.scale } else { $null }
        screenshotError = if ($null -ne $screenshot) { $screenshot.error } else { $null }
        coordinateSpace = "window"
        truncation = $tree.truncation
        treeLines = @($tree.lines)
        focusedSummary = $null
        focusedElementId = $null
        selectedText = $null
        elements = @($tree.elements)
    }
}

function Get-CrossHandsAppList {
    Assert-CrossHandsInteractiveSession
    @(Get-CrossHandsWindowProcesses | ForEach-Object {
        New-CrossHandsAppRecord $_
    })
}

function Get-CrossHandsWindowList([string]$Query) {
    Assert-CrossHandsInteractiveSession
    $process = Find-CrossHandsProcess $Query
    $root = Get-CrossHandsRootElement $process
    $windowFrame = Get-CrossHandsWindowFrame $process $root
    $x = $null
    $y = $null
    $width = 0
    $height = 0
    if ($null -ne $windowFrame) {
        $x = [int][Math]::Round($windowFrame.x)
        $y = [int][Math]::Round($windowFrame.y)
        $width = [int][Math]::Max(0, [Math]::Round($windowFrame.width))
        $height = [int][Math]::Max(0, [Math]::Round($windowFrame.height))
    }
    $app = New-CrossHandsAppRecord $process
    [pscustomobject]@{
        app = $app
        windows = @([pscustomobject]@{
            index = 0
            app = $app
            id = Get-CrossHandsWindowId $process
            title = $process.MainWindowTitle
            x = $x
            y = $y
            width = $width
            height = $height
            isMinimized = $false
            isOffscreen = $false
            screenIndex = $null
            platform = [pscustomobject]@{ backend = "uia"; nativeWindowHandle = Get-CrossHandsWindowId $process }
        })
    }
}

function Get-CrossHandsHandshake {
    [pscustomobject]@{
        platform = "win32"
        provider = "crosshands-platform-windows"
        providerVersion = "1.0.0"
        protocolVersion = 1
        graphicalSessionId = "win32:$([Diagnostics.Process]::GetCurrentProcess().SessionId):Default"
        supports = [pscustomobject]@{
            apps = [pscustomobject]@{ list = $true; bundleIds = $false; pids = $true }
            windows = [pscustomobject]@{ list = $true; targetById = $true; targetByIndex = $true; focus = $false; moveResize = $false }
            observation = [pscustomobject]@{ screenshot = $true; annotatedScreenshot = $false; elementFrames = $true; ocr = $false }
            actions = [pscustomobject]@{
                click = $true
                typeText = $true
                pressKey = $true
                hotkey = $true
                pasteText = $true
                scroll = $true
                drag = $true
                setValue = $true
                performAction = $true
            }
            surfaces = [pscustomobject]@{ menus = $false; dialogs = $false; dock = $false; menubar = $false }
        }
    }
}

function Test-CrossHandsSameRuntimeId($Left, $Right) {
    if ($null -eq $Left -or $null -eq $Right -or $Left.Count -ne $Right.Count) { return $false }
    for ($i = 0; $i -lt $Left.Count; $i++) {
        if ([int]$Left[$i] -ne [int]$Right[$i]) { return $false }
    }
    $true
}

function Find-CrossHandsElement($RootElement, $Record) {
    if ($null -eq $Record) { return $null }
    if ($Record.index -eq 0) { return $RootElement }

    try {
        $descendants = $RootElement.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        for ($i = 0; $i -lt $descendants.Count; $i++) {
            $candidate = $descendants.Item($i)
            if (Test-CrossHandsSameRuntimeId @($candidate.GetRuntimeId()) @($Record.runtimeId)) {
                return $candidate
            }
        }
    } catch {}
    $null
}

function Invoke-CrossHandsPrimaryAction($Element) {
    foreach ($pattern in @(
        [Windows.Automation.InvokePattern]::Pattern,
        [Windows.Automation.SelectionItemPattern]::Pattern,
        [Windows.Automation.TogglePattern]::Pattern
    )) {
        try {
            $instance = $Element.GetCurrentPattern($pattern)
            if ($pattern -eq [Windows.Automation.InvokePattern]::Pattern) { $instance.Invoke(); return $true }
            if ($pattern -eq [Windows.Automation.SelectionItemPattern]::Pattern) { $instance.Select(); return $true }
            if ($pattern -eq [Windows.Automation.TogglePattern]::Pattern) { $instance.Toggle(); return $true }
        } catch {}
    }
    $false
}

function Invoke-CrossHandsNamedAction($Element, [string]$Action) {
    $wanted = ""
    if ($null -ne $Action) { $wanted = $Action.Trim().ToLowerInvariant() }
    switch ($wanted) {
        "invoke" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
            $pattern.Invoke()
            return $true
        }
        "select" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
            $pattern.Select()
            return $true
        }
        "toggle" {
            $pattern = $Element.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
            $pattern.Toggle()
            return $true
        }
        default {
            return $false
        }
    }
}

function Set-CrossHandsElementValue($Element, [string]$Value) {
    try {
        $pattern = $Element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        if (-not $pattern.Current.IsReadOnly) {
            $pattern.SetValue($Value)
            return ([string]$pattern.Current.Value -ceq $Value)
        }
    } catch {}
    $false
}

function Get-CrossHandsRequiredNumber($Value, [string]$Name) {
    if ($null -eq $Value) { throw "$Name is required" }
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) {
        throw "$Name must be a finite number"
    }
    $number
}

function Get-CrossHandsPositiveInteger($Value, [string]$Name) {
    if ($null -eq $Value) { $Value = 1 }
    $number = [int]$Value
    if ($number -le 0) { throw "$Name must be a positive integer" }
    $number
}

function Get-CrossHandsPositiveNumber($Value, [string]$Name) {
    if ($null -eq $Value) { $Value = 1 }
    $number = Get-CrossHandsRequiredNumber $Value $Name
    if ($number -le 0) { throw "$Name must be a positive number" }
    $number
}

function Get-CrossHandsRequiredString($Value, [string]$Name) {
    if ($null -eq $Value) { throw "$Name is required" }
    $text = [string]$Value
    if ($text.Length -eq 0) { throw "$Name is required" }
    $text
}

function Get-CrossHandsScreenPoint($Operation, $WindowFrame) {
    if ($null -ne $Operation.element) {
        throw "stale element frame; run get-app-state again and use a fresh element index"
    }
    $x = Get-CrossHandsRequiredNumber $Operation.x "x"
    $y = Get-CrossHandsRequiredNumber $Operation.y "y"
    @{
        x = [int][Math]::Round($WindowFrame.x + $x)
        y = [int][Math]::Round($WindowFrame.y + $y)
    }
}

function Get-CrossHandsElementScreenPoint($Element) {
    if ($null -eq $Element) { return $null }
    try {
        $rect = $Element.Current.BoundingRectangle
        if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
            return @{
                x = [int][Math]::Round($rect.X + ($rect.Width / 2))
                y = [int][Math]::Round($rect.Y + ($rect.Height / 2))
            }
        }
    } catch {}
    $null
}

function Send-CrossHandsMouseClick([IntPtr]$WindowHandle, [int]$ScreenX, [int]$ScreenY, [string]$Button, [int]$Count) {
    [void][CrossHandsDesktopWin32]::SetForegroundWindow($WindowHandle)
    if (-not (Wait-CrossHandsWindowFocused $WindowHandle 500)) {
        throw "window_not_focused: foreground activation could not be verified before mouse input"
    }
    [void][CrossHandsDesktopWin32]::SetCursorPos($ScreenX, $ScreenY)
    $buttonName = if ([string]::IsNullOrWhiteSpace($Button)) { "left" } else { $Button.ToLowerInvariant() }
    switch ($buttonName) {
        "left" { $down = $MouseEvents.LeftDown; $up = $MouseEvents.LeftUp }
        "right" { $down = $MouseEvents.RightDown; $up = $MouseEvents.RightUp }
        "middle" { $down = $MouseEvents.MiddleDown; $up = $MouseEvents.MiddleUp }
        default { throw "unsupported mouse button: $Button" }
    }

    for ($i = 0; $i -lt (Get-CrossHandsPositiveInteger $Count "click_count"); $i++) {
        [CrossHandsDesktopWin32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 35
        [CrossHandsDesktopWin32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    }
}

function Send-CrossHandsDrag([IntPtr]$WindowHandle, $From, $To, [double]$DurationMs) {
    [void][CrossHandsDesktopWin32]::SetForegroundWindow($WindowHandle)
    if (-not (Wait-CrossHandsWindowFocused $WindowHandle 500)) {
        throw "window_not_focused: foreground activation could not be verified before drag input"
    }
    $startX = [int]$From.x
    $startY = [int]$From.y
    $endX = [int]$To.x
    $endY = [int]$To.y
    [void][CrossHandsDesktopWin32]::SetCursorPos($startX, $startY)
    [CrossHandsDesktopWin32]::mouse_event($MouseEvents.LeftDown, 0, 0, 0, [UIntPtr]::Zero)
    for ($step = 1; $step -le 12; $step++) {
        $x = [int][Math]::Round($startX + (($endX - $startX) * $step / 12))
        $y = [int][Math]::Round($startY + (($endY - $startY) * $step / 12))
        [void][CrossHandsDesktopWin32]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Round($DurationMs / 12)))
    }
    [CrossHandsDesktopWin32]::mouse_event($MouseEvents.LeftUp, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-CrossHandsText([IntPtr]$WindowHandle, [string]$Text) {
    [void][CrossHandsDesktopWin32]::SetForegroundWindow($WindowHandle)
    $hasNonAscii = $false
    foreach ($character in $Text.ToCharArray()) {
        if ([int][char]$character -gt 0x7F) { $hasNonAscii = $true; break }
    }
    if ($hasNonAscii) {
        foreach ($character in $Text.ToCharArray()) {
            [void][CrossHandsDesktopWin32]::PostMessage($WindowHandle, $WindowsMessages.Char, [IntPtr][int][char]$character, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 8
        }
        return
    }
    [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-CrossHandsSendKeysText $Text))
}

function Get-CrossHandsVirtualKey([string]$Key) {
    $normalized = $Key.ToLowerInvariant()
    $map = @{
        "return" = 0x0D; "enter" = 0x0D; "tab" = 0x09; "escape" = 0x1B; "esc" = 0x1B
        "backspace" = 0x08; "delete" = 0x2E; "space" = 0x20; "left" = 0x25
        "up" = 0x26; "right" = 0x27; "down" = 0x28; "home" = 0x24; "end" = 0x23
    }
    if ($map.ContainsKey($normalized)) { return $map[$normalized] }
    if ($normalized.Length -eq 1) { return [int][char]$normalized.ToUpperInvariant()[0] }
    throw "Unsupported key: $Key"
}

function Send-CrossHandsKey([IntPtr]$WindowHandle, [string]$Key) {
    [void][CrossHandsDesktopWin32]::SetForegroundWindow($WindowHandle)
    [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-CrossHandsSendKeysKey $Key))
}

function Get-CrossHandsModifierVirtualKey([string]$Modifier) {
    switch ($Modifier.ToLowerInvariant()) {
        { $_ -in @("ctrl", "control", "cmdorctrl", "commandorcontrol") } { return 0x11 }
        { $_ -in @("shift") } { return 0x10 }
        { $_ -in @("alt", "option") } { return 0x12 }
        { $_ -in @("meta", "super", "win", "cmd", "command") } { return 0x5B }
        default { throw "Unsupported modifier: $Modifier" }
    }
}

function Send-CrossHandsHotkey([IntPtr]$WindowHandle, [string]$KeySpec) {
    $parts = @($KeySpec.Split("+") | ForEach-Object { $_.Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($parts.Count -eq 0) { throw "Unsupported key: $KeySpec" }
    $key = $parts[$parts.Count - 1]
    $prefix = ""
    if ($parts.Count -gt 1) {
        foreach ($modifier in $parts[0..($parts.Count - 2)]) {
            $prefix += ConvertTo-CrossHandsSendKeysModifier $modifier
        }
    }
    [void][CrossHandsDesktopWin32]::SetForegroundWindow($WindowHandle)
    [System.Windows.Forms.SendKeys]::SendWait($prefix + (ConvertTo-CrossHandsSendKeysKey $key))
}

function ConvertTo-CrossHandsSendKeysText([string]$Text) {
    $builder = New-Object System.Text.StringBuilder
    foreach ($character in $Text.ToCharArray()) {
        $value = [string]$character
        if ($value -eq "`r") { continue }
        if ($value -eq "`n") { [void]$builder.Append("{ENTER}"); continue }
        if ("+^%~(){}[]".Contains($value)) {
            [void]$builder.Append("{").Append($value).Append("}")
        } else {
            [void]$builder.Append($value)
        }
    }
    $builder.ToString()
}

function ConvertTo-CrossHandsSendKeysKey([string]$Key) {
    switch ($Key.ToLowerInvariant()) {
        { $_ -in @("return", "enter") } { return "{ENTER}" }
        "tab" { return "{TAB}" }
        { $_ -in @("escape", "esc") } { return "{ESC}" }
        "backspace" { return "{BACKSPACE}" }
        "delete" { return "{DELETE}" }
        "space" { return " " }
        "left" { return "{LEFT}" }
        "up" { return "{UP}" }
        "right" { return "{RIGHT}" }
        "down" { return "{DOWN}" }
        "home" { return "{HOME}" }
        "end" { return "{END}" }
        { $_ -in @("pageup", "page_up") } { return "{PGUP}" }
        { $_ -in @("pagedown", "page_down") } { return "{PGDN}" }
        "insert" { return "{INSERT}" }
        default {
            if ($Key.Length -eq 1) { return (ConvertTo-CrossHandsSendKeysText $Key) }
            throw "Unsupported key: $Key"
        }
    }
}

function ConvertTo-CrossHandsSendKeysModifier([string]$Modifier) {
    switch ($Modifier.ToLowerInvariant()) {
        { $_ -in @("ctrl", "control", "cmdorctrl", "commandorcontrol") } { return "^" }
        "shift" { return "+" }
        { $_ -in @("alt", "option") } { return "%" }
        default { throw "Unsupported modifier: $Modifier" }
    }
}

function Send-CrossHandsPasteText([IntPtr]$WindowHandle, [string]$Text) {
    $previous = $null
    $hadPrevious = $false
    try { $previous = [System.Windows.Forms.Clipboard]::GetDataObject() } catch {}
    $hadPrevious = $null -ne $previous
    try {
        Set-Clipboard -Value $Text
        Send-CrossHandsHotkey $WindowHandle "Ctrl+v"
    } finally {
        if ($hadPrevious) {
            try { [System.Windows.Forms.Clipboard]::SetDataObject($previous, $true) } catch {}
        } else {
            try { [System.Windows.Forms.Clipboard]::Clear() } catch {}
        }
    }
}

function Invoke-CrossHandsOperation($Operation) {
    Assert-CrossHandsInteractiveSession
    $includeScreenshot = -not [bool]$Operation.noScreenshot
    if ($Operation.tool -eq "handshake") {
        return [pscustomobject]@{ ok = $true; capabilities = Get-CrossHandsHandshake }
    }
    if ($Operation.tool -eq "list_apps") {
        return [pscustomobject]@{ ok = $true; apps = @(Get-CrossHandsAppList) }
    }
    if ($Operation.tool -eq "list_windows") {
        $list = Get-CrossHandsWindowList $Operation.app
        return [pscustomobject]@{ ok = $true; app = $list.app; windows = @($list.windows) }
    }
    if ($Operation.tool -eq "get_app_state") {
        return [pscustomobject]@{ ok = $true; snapshot = New-CrossHandsSnapshot $Operation.app $includeScreenshot $Operation.windowId $Operation.windowIndex ([bool]$Operation.restoreWindow) }
    }
    if ($Operation.tool -eq "inspect_target") {
        $inspected = Find-CrossHandsProcess $Operation.app
        $identity = Assert-CrossHandsProcessIdentity $inspected $null
        return [pscustomobject]@{
            ok = $true
            identity = $identity
            appId = [string]$inspected.ProcessName
            windowId = Get-CrossHandsWindowId $inspected
            windowTitle = [string]$inspected.MainWindowTitle
        }
    }

    $process = Find-CrossHandsProcess $Operation.app
    $verifiedIdentity = Assert-CrossHandsProcessIdentity $process $Operation.expectedIdentity
    if ([bool]$Operation.restoreWindow) { Restore-CrossHandsWindow $process }
    Assert-CrossHandsWindowTarget $process $Operation.windowId $Operation.windowIndex
    $root = Get-CrossHandsRootElement $process
    $windowFrame = if ($null -ne $Operation.windowBounds) { $Operation.windowBounds } else { Get-CrossHandsWindowFrame $process $root }
    $element = Find-CrossHandsElement $root $Operation.element
    $fromElement = Find-CrossHandsElement $root $Operation.fromElement
    $toElement = Find-CrossHandsElement $root $Operation.toElement
    $handle = [IntPtr]$process.MainWindowHandle
    if ($Operation.tool -in @("type_text", "press_key", "hotkey", "paste_text")) {
        Assert-CrossHandsKeyboardFocus $handle $Operation
    }
    $action = $null

    switch ($Operation.tool) {
        "click" {
            # Why: agents expect a click into a target app to make the next
            # keyboard action safe, even when UI Automation handles the click.
            Restore-CrossHandsWindow $process
            $handledByPattern = $false
            $clickCount = Get-CrossHandsPositiveInteger $Operation.click_count "click_count"
            if ($null -ne $element -and $Operation.mouse_button -ne "right" -and $Operation.mouse_button -ne "middle" -and $clickCount -le 1) {
                $handledByPattern = Invoke-CrossHandsPrimaryAction $element
            }
            if (-not $handledByPattern) {
                $point = Get-CrossHandsElementScreenPoint $element
                if ($null -eq $point) { $point = Get-CrossHandsScreenPoint $Operation $windowFrame }
                Send-CrossHandsMouseClick $handle $point.x $point.y $Operation.mouse_button $clickCount
                $action = [pscustomobject]@{ path = "synthetic"; actionName = $null; fallbackReason = "actionUnsupported" }
            } else {
                $action = [pscustomobject]@{ path = "accessibility"; actionName = "primaryAction"; fallbackReason = $null }
            }
        }
        "perform_secondary_action" {
            if ($null -eq $element) { throw "unknown element_index" }
            if (-not (Invoke-CrossHandsNamedAction $element $Operation.action)) {
                throw "$($Operation.action) is not a valid secondary action"
            }
            $action = [pscustomobject]@{ path = "accessibility"; actionName = $Operation.action; fallbackReason = $null }
        }
        "scroll" {
            $delta = 120 * [int][Math]::Ceiling((Get-CrossHandsPositiveNumber $Operation.pages "pages"))
            if ($Operation.direction -eq "down" -or $Operation.direction -eq "right") {
                $delta = -1 * $delta
            } elseif ($Operation.direction -ne "up" -and $Operation.direction -ne "left") {
                throw "unsupported scroll direction: $($Operation.direction)"
            }
            $point = Get-CrossHandsElementScreenPoint $element
            if ($null -eq $point) { $point = Get-CrossHandsScreenPoint $Operation $windowFrame }
            [void][CrossHandsDesktopWin32]::SetForegroundWindow($handle)
            [void][CrossHandsDesktopWin32]::SetCursorPos([int]$point.x, [int]$point.y)
            [CrossHandsDesktopWin32]::mouse_event($MouseEvents.Wheel, 0, 0, $delta, [UIntPtr]::Zero)
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "scroll"; fallbackReason = $null }
        }
        "drag" {
            $from = Get-CrossHandsElementScreenPoint $fromElement
            if ($null -eq $from -and $null -ne $Operation.fromElement) { throw "stale element frame; run get-app-state again and use a fresh element index" }
            if ($null -eq $from) {
                $from = @{
                    x = $windowFrame.x + (Get-CrossHandsRequiredNumber $Operation.from_x "from_x")
                    y = $windowFrame.y + (Get-CrossHandsRequiredNumber $Operation.from_y "from_y")
                }
            }
            $to = Get-CrossHandsElementScreenPoint $toElement
            if ($null -eq $to -and $null -ne $Operation.toElement) { throw "stale element frame; run get-app-state again and use a fresh element index" }
            if ($null -eq $to) {
                $to = @{
                    x = $windowFrame.x + (Get-CrossHandsRequiredNumber $Operation.to_x "to_x")
                    y = $windowFrame.y + (Get-CrossHandsRequiredNumber $Operation.to_y "to_y")
                }
            }
            $durationMs = if ($null -eq $Operation.duration_ms) { 240 } else { [Math]::Min(30000, (Get-CrossHandsPositiveNumber $Operation.duration_ms "duration_ms")) }
            Send-CrossHandsDrag $handle $from $to $durationMs
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "drag"; fallbackReason = $null }
        }
        "type_text" {
            Send-CrossHandsText $handle (Get-CrossHandsRequiredString $Operation.text "text")
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "typeText"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "press_key" {
            Send-CrossHandsKey $handle (Get-CrossHandsRequiredString $Operation.key "key")
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "pressKey"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "hotkey" {
            Send-CrossHandsHotkey $handle (Get-CrossHandsRequiredString $Operation.key "key")
            $action = [pscustomobject]@{ path = "synthetic"; actionName = "hotkey"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "synthetic_input" } }
        }
        "paste_text" {
            Send-CrossHandsPasteText $handle (Get-CrossHandsRequiredString $Operation.text "text")
            $action = [pscustomobject]@{ path = "clipboard"; actionName = "paste"; fallbackReason = $null; verification = [pscustomobject]@{ state = "unverified"; reason = "clipboard_paste" } }
        }
        "set_value" {
            if ($null -eq $element -or -not (Set-CrossHandsElementValue $element ([string]$Operation.value))) {
                throw "element value is not settable"
            }
            $action = [pscustomobject]@{ path = "accessibility"; actionName = "setValue"; fallbackReason = $null; verification = [pscustomobject]@{ state = "verified"; reason = "value_pattern_readback" } }
        }
        default {
            throw "unsupported tool: $($Operation.tool)"
        }
    }

    try {
        $snapshot = New-CrossHandsSnapshot $Operation.app $includeScreenshot $Operation.windowId $Operation.windowIndex
    } catch {
        if ($null -eq $Operation.windowId -and $null -eq $Operation.windowIndex) { throw }
        if ($null -eq $action.verification) {
            $action | Add-Member -NotePropertyName verification -NotePropertyValue ([pscustomobject]@{ state = "unverified"; reason = "window_changed" })
        }
        $snapshot = New-CrossHandsSnapshot $Operation.app $includeScreenshot $null $null
    }
    [pscustomobject]@{ ok = $true; action = $action; snapshot = $snapshot; processIdentity = $verifiedIdentity }
}

Write-CrossHandsJson ([pscustomobject]@{ ok = $true; ready = $true; capabilities = Get-CrossHandsHandshake })
while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
        $operation = $line | ConvertFrom-Json
        Write-CrossHandsJson (Invoke-CrossHandsOperation $operation)
    } catch {
        Write-CrossHandsJson ([pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message })
    }
}
