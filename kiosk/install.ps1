<#
.SYNOPSIS
  Устанавливает киоск Signage на Windows-плеер (OPS).

.DESCRIPTION
  - копирует скрипты в C:\Signage и сохраняет адрес сервера;
  - создаёт отдельный профиль Edge (C:\Signage\EdgeProfile);
  - создаёт задачу планировщика «при входе пользователя», которая запускает watchdog.ps1;
  - отключает сон и гашение экрана;
  - отключает уведомления и подсказки Windows, где это позволяет редакция;
  - выставляет активные часы Windows Update, чтобы перезагрузки шли ночью;
  - запоминает прежние значения, чтобы uninstall.ps1 мог всё вернуть.

  Запускать от администратора:
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -ServerUrl http://10.33.44.20:8080

.PARAMETER ServerUrl
  Адрес сервера Signage (как server.publicUrl в конфиге сервера).

.PARAMETER KioskUser
  Локальный пользователь, под которым работает киоск. Если не задан — задача
  срабатывает при входе любого пользователя.

.PARAMETER ActiveHoursStart / ActiveHoursEnd
  Активные часы Windows Update (в это время Windows не перезагружается сама).
  По умолчанию 6–23: перезагрузки возможны ночью с 23 до 6.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [string]$KioskUser = '',
    [ValidateRange(0, 23)][int]$ActiveHoursStart = 6,
    [ValidateRange(0, 23)][int]$ActiveHoursEnd = 23
)

$ErrorActionPreference = 'Stop'
$script:LogName = 'install'
. (Join-Path $PSScriptRoot 'common.ps1')

# ---------------------------------------------------------------------------
# Проверки
# ---------------------------------------------------------------------------

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'Запустите скрипт от имени администратора (PowerShell → «Запуск от имени администратора»).'
    exit 1
}

if ($ServerUrl -notmatch '^https?://[^/\s]+') {
    Write-Error "Неверный адрес сервера: $ServerUrl (пример: http://10.33.44.20:8080)"
    exit 1
}
$ServerUrl = $ServerUrl.TrimEnd('/')

$browser = Find-Browser
if (-not $browser) {
    Write-Error 'Не найден Microsoft Edge (или Chrome). Установите Edge и повторите.'
    exit 1
}

$edition = Get-WindowsEdition
Write-Log "Windows: $($edition.ProductName) ($($edition.EditionId)), сборка $($edition.Build)"
Write-Log "Браузер: $browser"
if ($edition.IsHome) {
    Write-Log 'Редакция Home: групповые политики (HKLM\SOFTWARE\Policies) частично игнорируются. Сон, автозапуск и перезапуск браузера работают; уведомления отключаются настройками пользователя.' 'WARN'
}

if ($KioskUser) {
    if (-not (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
        Write-Error "Локальный пользователь '$KioskUser' не найден. Создайте его (см. README.md) или запустите без -KioskUser."
        exit 1
    }
}

try {
    $health = Invoke-WebRequest -Uri "$ServerUrl/health" -UseBasicParsing -TimeoutSec 5
    Write-Log "Сервер отвечает: HTTP $($health.StatusCode)"
} catch {
    Write-Log "Сервер $ServerUrl сейчас не отвечает ($($_.Exception.Message)). Установка продолжится — плеер подключится, когда сервер станет доступен." 'WARN'
}

# ---------------------------------------------------------------------------
# Резервная копия изменяемых настроек
# ---------------------------------------------------------------------------

$backup = @{ registry = @(); power = @{}; createdAt = (Get-Date).ToString('o') }
if (Test-Path $BackupFile) {
    # Повторная установка: исходные значения уже сохранены, не перезаписываем их текущими.
    $prev = Get-Content $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $backup.registry = if ($prev.registry) { @($prev.registry) } else { @() }
    $backup.power = @{}
    if ($prev.power) { $prev.power.PSObject.Properties | ForEach-Object { $backup.power[$_.Name] = $_.Value } }
}
$known = @{}
foreach ($r in $backup.registry) { $known["$($r.Path)|$($r.Name)"] = $true }

function Set-Reg {
    param([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord')
    $key = "$Path|$Name"
    if (-not $known.ContainsKey($key)) {
        $existed = $false; $old = $null; $oldType = $null
        if (Test-Path $Path) {
            $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue
            if ($null -ne $item) {
                $existed = $true
                $old = $item.$Name
                $oldType = (Get-Item $Path).GetValueKind($Name).ToString()
            }
        }
        $script:backup.registry += [pscustomobject]@{ Path = $Path; Name = $Name; Existed = $existed; Value = $old; Type = $oldType }
        $known[$key] = $true
    }
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

function Get-PowerIndex {
    param([string]$SubGroup, [string]$Setting)
    $out = powercfg /query SCHEME_CURRENT $SubGroup $Setting 2>$null
    $line = $out | Where-Object { $_ -match '(AC|переменного тока).*0x([0-9a-fA-F]+)' } | Select-Object -First 1
    if ($line -and $line -match '0x([0-9a-fA-F]+)') { return [Convert]::ToInt32($Matches[1], 16) }
    return $null
}

# ---------------------------------------------------------------------------
# Файлы
# ---------------------------------------------------------------------------

New-Item -ItemType Directory -Path $SignageRoot, $ProfileDir, $LogDir -Force | Out-Null
foreach ($f in 'common.ps1', 'watchdog.ps1', 'uninstall.ps1') {
    Copy-Item -Path (Join-Path $PSScriptRoot $f) -Destination (Join-Path $SignageRoot $f) -Force
}
@{ serverUrl = $ServerUrl; browser = $browser; installedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8

# Пользователь киоска должен писать в профиль и логи.
$aclTarget = if ($KioskUser) { $KioskUser } else { 'BUILTIN\Users' }
& icacls $SignageRoot /grant "${aclTarget}:(OI)(CI)M" /T /Q | Out-Null
Write-Log "Файлы скопированы в $SignageRoot"

# ---------------------------------------------------------------------------
# Питание: экран не гаснет, компьютер не засыпает
# ---------------------------------------------------------------------------

if (-not $backup.power.ContainsKey('monitor')) {
    $backup.power['monitor'] = Get-PowerIndex 'SUB_VIDEO' 'VIDEOIDLE'
    $backup.power['standby'] = Get-PowerIndex 'SUB_SLEEP' 'STANDBYIDLE'
    $backup.power['hibernate'] = Get-PowerIndex 'SUB_SLEEP' 'HIBERNATEIDLE'
}
powercfg /change monitor-timeout-ac 0 | Out-Null
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
Write-Log 'Сон и отключение экрана выключены'

# ---------------------------------------------------------------------------
# Edge: политики киоска
# ---------------------------------------------------------------------------

$edge = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
Set-Reg $edge 'HideFirstRunExperience' 1
Set-Reg $edge 'AutoplayAllowed' 1
Set-Reg $edge 'TranslateEnabled' 0
Set-Reg $edge 'BrowserSignin' 0
Set-Reg $edge 'SyncDisabled' 1
Set-Reg $edge 'PasswordManagerEnabled' 0
Set-Reg $edge 'StartupBoostEnabled' 0
Set-Reg $edge 'BackgroundModeEnabled' 0
Set-Reg $edge 'ShowRecommendationsEnabled' 0
Set-Reg $edge 'PromotionalTabsEnabled' 0
Set-Reg $edge 'UserFeedbackAllowed' 0
Set-Reg $edge 'DefaultNotificationsSetting' 2
Set-Reg $edge 'RestoreOnStartup' 5
# То же, что флаг --unsafely-treat-insecure-origin-as-secure: Service Worker по http.
Set-Reg "$edge\OverrideSecurityRestrictionsOnInsecureOrigin" '1' $ServerUrl 'String'
Write-Log 'Политики Edge применены'

# ---------------------------------------------------------------------------
# Уведомления и подсказки Windows (политики; на Home частично не действуют)
# ---------------------------------------------------------------------------

Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Explorer' 'DisableNotificationCenter' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' 'DisableWindowsConsumerFeatures' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' 'DisableSoftLanding' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' 'DisableCloudOptimizedContent' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Error Reporting' 'DontShowUI' 1
Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting' 'DontShowUI' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE' 'DisablePrivacyExperience' 1
Write-Log 'Уведомления и подсказки Windows отключены (насколько позволяет редакция)'

# ---------------------------------------------------------------------------
# Windows Update: перезагрузки только вне активных часов
# ---------------------------------------------------------------------------

Set-Reg 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' 'ActiveHoursStart' $ActiveHoursStart
Set-Reg 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' 'ActiveHoursEnd' $ActiveHoursEnd
Set-Reg 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' 'SmartActiveHoursState' 0
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' 'SetActiveHours' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' 'ActiveHoursStart' $ActiveHoursStart
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' 'ActiveHoursEnd' $ActiveHoursEnd
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' 'NoAutoRebootWithLoggedOnUsers' 1
Write-Log "Активные часы Windows Update: ${ActiveHoursStart}:00–${ActiveHoursEnd}:00"

$backup | ConvertTo-Json -Depth 5 | Set-Content -Path $BackupFile -Encoding UTF8

# ---------------------------------------------------------------------------
# Задача планировщика: watchdog при входе пользователя
# ---------------------------------------------------------------------------

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $psExe `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$SignageRoot\watchdog.ps1`""
if ($KioskUser) {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $KioskUser
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $KioskUser -LogonType Interactive -RunLevel Limited
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $taskPrincipal = New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users' -RunLevel Limited
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings `
    -Description 'Signage: запуск браузера в режиме киоска и перезапуск при закрытии' | Out-Null
Write-Log "Задача планировщика «$TaskName» создана"

Write-Host ''
Write-Host 'Готово.' -ForegroundColor Green
Write-Host "  Плеер: $ServerUrl/player/"
Write-Host '  Дальше: настройте автоматический вход пользователя (README.md, Autologon) и перезагрузите компьютер.'
Write-Host '  При первом запуске на экране появится 6-значный код — введите его в админке: Экраны и группы → Добавить экран.'
Write-Host "  Запустить сейчас без перезагрузки: Start-ScheduledTask -TaskName '$TaskName' (под пользователем киоска)."
