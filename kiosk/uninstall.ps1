<#
.SYNOPSIS
  Удаляет киоск Signage и возвращает настройки Windows, изменённые install.ps1.

  Запускать от администратора:
    powershell -ExecutionPolicy Bypass -File C:\Signage\uninstall.ps1
  -KeepProfile — оставить C:\Signage (профиль Edge с кэшем медиа и логи).
#>
[CmdletBinding()]
param([switch]$KeepProfile)

$ErrorActionPreference = 'Continue'
$script:LogName = 'uninstall'
. (Join-Path $PSScriptRoot 'common.ps1')

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'Запустите скрипт от имени администратора.'
    exit 1
}

# 1. Задача и процессы
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*Signage\watchdog.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-OurBrowserProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Log 'Задача удалена, браузер киоска остановлен'

# 2. Реестр и питание из резервной копии
if (Test-Path $BackupFile) {
    $backup = Get-Content $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($r in @($backup.registry)) {
        try {
            if ($r.Existed) {
                $type = if ($r.Type) { $r.Type } else { 'DWord' }
                if (-not (Test-Path $r.Path)) { New-Item -Path $r.Path -Force | Out-Null }
                New-ItemProperty -Path $r.Path -Name $r.Name -Value $r.Value -PropertyType $type -Force | Out-Null
            } elseif (Test-Path $r.Path) {
                Remove-ItemProperty -Path $r.Path -Name $r.Name -ErrorAction SilentlyContinue
                # Пустые ключи политик, созданные установкой, тоже убираем.
                $key = Get-Item $r.Path -ErrorAction SilentlyContinue
                if ($key -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0) { Remove-Item $r.Path -ErrorAction SilentlyContinue }
            }
        } catch {
            Write-Log "Не удалось восстановить $($r.Path)\$($r.Name): $($_.Exception.Message)" 'WARN'
        }
    }
    $p = $backup.power
    # powercfg принимает минуты, в резервной копии — секунды.
    if ($null -ne $p.monitor) { powercfg /change monitor-timeout-ac ([int]($p.monitor / 60)) | Out-Null }
    if ($null -ne $p.standby) { powercfg /change standby-timeout-ac ([int]($p.standby / 60)) | Out-Null }
    if ($null -ne $p.hibernate) { powercfg /change hibernate-timeout-ac ([int]($p.hibernate / 60)) | Out-Null }
    Write-Log 'Настройки реестра и питания восстановлены'
} else {
    Write-Log "Нет резервной копии $BackupFile — настройки Windows не восстанавливались" 'WARN'
}

# 3. Файлы
if (-not $KeepProfile) {
    Set-Location $env:SystemRoot
    Remove-Item -Path $SignageRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Log "Каталог $SignageRoot удалён"
}

Write-Host ''
Write-Host 'Киоск Signage удалён.' -ForegroundColor Green
Write-Host 'Не забудьте отключить автоматический вход (Autologon → Disable), если он больше не нужен.'
Write-Host 'Настройки уведомлений пользователя киоска (HKCU) не меняются — при необходимости включите их в «Параметрах».'
