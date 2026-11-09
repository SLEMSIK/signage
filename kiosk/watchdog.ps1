<#
.SYNOPSIS
  Watchdog киоска Signage: запускает браузер в режиме киоска и перезапускает
  его, если процесс завершился (проверка каждые 10 секунд).

  Запускается задачей планировщика «Signage Kiosk» при входе пользователя.
  Обслуживание: создайте файл C:\Signage\maintenance.flag (watchdog перестанет
  перезапускать браузер) или остановите задачу, затем закройте браузер Alt+F4.
#>
$ErrorActionPreference = 'Continue'
$script:LogName = 'watchdog'
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Path $ConfigFile)) {
    Write-Log "Нет файла настроек $ConfigFile — запустите install.ps1" 'ERROR'
    exit 1
}
$config = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
$browser = if ($config.browser -and (Test-Path $config.browser)) { $config.browser } else { Find-Browser }
if (-not $browser) {
    Write-Log 'Браузер не найден' 'ERROR'
    exit 1
}

# ---------------------------------------------------------------------------
# Настройки текущего пользователя: работают и на Windows Home, прав админа не требуют
# ---------------------------------------------------------------------------
function Set-UserReg {
    param([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord')
    try {
        if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
        New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
    } catch {
        Write-Log "Не удалось записать ${Path}\${Name}: $($_.Exception.Message)" 'WARN'
    }
}
$cdm = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'
Set-UserReg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' 'ToastEnabled' 0
Set-UserReg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings' 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' 0
Set-UserReg $cdm 'SoftLandingEnabled' 0
Set-UserReg $cdm 'SubscribedContent-338389Enabled' 0
Set-UserReg $cdm 'SubscribedContent-310093Enabled' 0
Set-UserReg $cdm 'SystemPaneSuggestionsEnabled' 0
Set-UserReg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement' 'ScoobeSystemSettingEnabled' 0
Set-UserReg 'HKCU:\Control Panel\Desktop' 'ScreenSaveActive' '0' 'String'

# ---------------------------------------------------------------------------
# Основной цикл
# ---------------------------------------------------------------------------
$arguments = Get-KioskArguments -ServerUrl $config.serverUrl -BrowserPath $browser
Write-Log "Watchdog запущен. Браузер: $browser; сервер: $($config.serverUrl)"

$restarts = 0
$windowStart = Get-Date
while ($true) {
    if (Test-Path $MaintenanceFlag) {
        Start-Sleep -Seconds 10
        continue
    }

    $running = @(Get-OurBrowserProcesses)
    if ($running.Count -eq 0) {
        # Защита от бесконечного цикла падений: не чаще 10 запусков за 5 минут.
        if (((Get-Date) - $windowStart).TotalMinutes -gt 5) { $restarts = 0; $windowStart = Get-Date }
        if ($restarts -ge 10) {
            Write-Log 'Браузер падает слишком часто — пауза 60 с' 'WARN'
            Start-Sleep -Seconds 60
            $restarts = 0
            $windowStart = Get-Date
        }
        Write-Log 'Запуск браузера'
        try {
            Start-Process -FilePath $browser -ArgumentList $arguments | Out-Null
            $restarts++
        } catch {
            Write-Log "Не удалось запустить браузер: $($_.Exception.Message)" 'ERROR'
        }
        Start-Sleep -Seconds 15
        continue
    }
    Start-Sleep -Seconds 10
}
