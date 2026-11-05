# npm run autostart      : open Jarvis at every login and unlock
# npm run autostart:off  : undo that, and close Jarvis

param([switch]$Off)

$ErrorActionPreference = 'Stop'
$taskName = 'Jarvis'
$root = Split-Path $PSScriptRoot -Parent

if ($Off) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

    $port = 3000
    $envFile = Join-Path $root '.env'
    if (Test-Path $envFile) {
        $match = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
        if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
    }
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
        Where-Object { $_.CommandLine -like "*--app=http://localhost:$port*" -and $_.CommandLine -notlike '*--type=*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*server/index.js*' } |
        Where-Object { (Get-NetTCPConnection -OwningProcess $_.ProcessId -LocalPort $port -State Listen -ErrorAction SilentlyContinue) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    Write-Output 'Jarvis is off and will no longer start by itself.'
    exit 0
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$launcher = Join-Path $PSScriptRoot 'launch-hidden.vbs'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`"" -WorkingDirectory $root

$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user

# 8 = TASK_SESSION_UNLOCK: fires when you open the laptop and unlock it.
$unlockClass = Get-CimClass -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskSessionStateChangeTrigger'
$atUnlock = New-CimInstance -CimClass $unlockClass -ClientOnly
$atUnlock.StateChange = 8
$atUnlock.UserId = $user
$atUnlock.Enabled = $true

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($atLogon, $atUnlock) -Settings $settings -Principal $principal -Description 'Opens Jarvis at login and unlock. Remove with: npm run autostart:off' -Force | Out-Null

Write-Output 'Jarvis will now open at every login and unlock. Starting it now...'
Start-ScheduledTask -TaskName $taskName
