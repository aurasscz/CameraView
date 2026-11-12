# Starts the CameraView gateway (go2rtc) on Windows.
# Usage: powershell -ExecutionPolicy Bypass -File gateway\start.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$binDir = Join-Path $PSScriptRoot 'bin'
$exe = Join-Path $binDir 'go2rtc.exe'

if (-not (Test-Path $exe)) {
    $asset = switch ($env:PROCESSOR_ARCHITECTURE) {
        'ARM64' { 'go2rtc_win_arm64.zip' }
        'x86'   { 'go2rtc_win32.zip' }
        default { 'go2rtc_win64.zip' }
    }
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $zip = Join-Path $env:TEMP 'go2rtc.zip'
    Write-Host "Downloading $asset ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://github.com/AlexxIT/go2rtc/releases/latest/download/$asset" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $binDir -Force
    Remove-Item $zip
}

Write-Host ''
Write-Host 'CameraView gateway starting...'
Write-Host '  On this computer:   http://localhost:1984/'
Write-Host '  Hosted app:         https://aurasscz.github.io/CameraView/  (gateway: http://localhost:1984)'
Write-Host 'Windows may ask to allow go2rtc through the firewall - allow it on private networks.'
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''
& $exe -config go2rtc.yaml
