# Makes sure the Jarvis server is running, then opens the Jarvis window or brings
# it to the front. Runs at every login and unlock, so it must be safe to repeat.

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force $data | Out-Null

$port = 3000
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    $match = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
}
$url = "http://localhost:$port"

function Test-Jarvis {
    try {
        $page = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 2
        return $page.Content -match '<title>Jarvis</title>'
    } catch {
        return $false
    }
}

if (-not (Test-Jarvis)) {
    $node = (Get-Command node).Source
    Start-Process -FilePath $node -ArgumentList 'server/index.js' -WorkingDirectory $root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $data 'jarvis.log') -RedirectStandardError (Join-Path $data 'jarvis-error.log')
    $ready = $false
    for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
        Start-Sleep -Milliseconds 500
        $ready = Test-Jarvis
    }
    if (-not $ready) { throw "The Jarvis server didn't start. See $data\jarvis-error.log" }
}

# Chrome and Edge are the browsers with speech recognition.
$browser = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Jarvis needs Chrome or Edge installed.' }

$browserName = Split-Path $browser -Leaf
$window = Get-CimInstance Win32_Process -Filter "Name='$browserName'" |
    Where-Object { $_.CommandLine -like "*--app=$url*" -and $_.CommandLine -notlike '*--type=*' } |
    Select-Object -First 1

if ($window) {
    Add-Type -Namespace Jarvis -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@
    $handle = (Get-Process -Id $window.ProcessId).MainWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
        [Jarvis.Win32]::ShowWindow($handle, 9) | Out-Null  # 9 = restore if minimized
        [Jarvis.Win32]::SetForegroundWindow($handle) | Out-Null
    }
} else {
    # Its own profile keeps it separate from normal browsing and remembers the mic permission.
    Start-Process -FilePath $browser -ArgumentList @(
        "--app=$url",
        "--user-data-dir=`"$(Join-Path $data 'browser-profile')`"",
        '--window-size=480,840',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        # Stop Chrome slowing the page down while it's in the background.
        '--disable-features=CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'
    )
}
