# Общие функции киоск-скриптов Signage. Подключается через dot-sourcing:  . "$PSScriptRoot\common.ps1"

$SignageRoot     = 'C:\Signage'
$ProfileDir      = Join-Path $SignageRoot 'EdgeProfile'
$ConfigFile      = Join-Path $SignageRoot 'kiosk.json'
$BackupFile      = Join-Path $SignageRoot 'install-backup.json'
$LogDir          = Join-Path $SignageRoot 'logs'
$MaintenanceFlag = Join-Path $SignageRoot 'maintenance.flag'
$TaskName        = 'Signage Kiosk'

if (-not $script:LogName) { $script:LogName = 'kiosk' }

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    if ($Level -eq 'WARN') { Write-Warning $Message }
    elseif ($Level -eq 'ERROR') { Write-Host $line -ForegroundColor Red }
    else { Write-Host $line }
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
        $log = Join-Path $LogDir ($script:LogName + '.log')
        # Ротация: не больше ~1 МБ на файл.
        if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) { Move-Item $log "$log.1" -Force }
        Add-Content -Path $log -Value $line -Encoding UTF8
    } catch { }
}

function Find-Browser {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

function Get-KioskArguments {
    param([string]$ServerUrl, [string]$BrowserPath)
    $url = $ServerUrl.TrimEnd('/')
    $list = @('--kiosk', "$url/player/")
    if ($BrowserPath -like '*msedge.exe') { $list += '--edge-kiosk-type=fullscreen' }
    $list += @(
        "--user-data-dir=$ProfileDir",
        '--no-first-run',
        '--noerrdialogs',
        '--disable-session-crashed-bubble',
        '--disable-features=Translate',
        '--autoplay-policy=no-user-gesture-required',
        "--unsafely-treat-insecure-origin-as-secure=$url",
        '--disable-pinch',
        '--overscroll-history-navigation=0'
    )
    return $list
}

function Get-OurBrowserProcesses {
    # Только процессы с нашим профилем — обычный браузер пользователя не трогаем.
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ProfileDir*" }
}

function Get-WindowsEdition {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
    [pscustomobject]@{
        EditionId   = $cv.EditionID
        ProductName = $cv.ProductName
        Build       = $cv.CurrentBuild
        # Core / CoreSingleLanguage / CoreN — Home: часть политик HKLM\SOFTWARE\Policies игнорируется.
        IsHome      = ($cv.EditionID -like 'Core*')
    }
}
