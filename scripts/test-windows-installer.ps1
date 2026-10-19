$ErrorActionPreference = 'Stop'
if (-not $env:RELEASE_VERSION) { throw 'RELEASE_VERSION is required' }
$installer = Join-Path $PWD "release/Trident-$env:RELEASE_VERSION-windows-x64-setup.exe"
if (-not (Test-Path $installer)) { throw "Installer not found: $installer" }
$installDirectory = Join-Path $env:RUNNER_TEMP "Trident Installer Smoke"
$process = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDirectory" -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
try {
    $exe = Join-Path $installDirectory 'Trident.exe'
    if (-not (Test-Path $exe)) { throw 'Installation did not produce Trident.exe' }
    node scripts/smoke-windows.cjs $exe $env:RELEASE_VERSION
    if ($LASTEXITCODE -ne 0) { throw 'Installed application smoke test failed' }
} finally {
    $uninstaller = Join-Path $installDirectory 'Uninstall Trident.exe'
    if (Test-Path $uninstaller) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
        for ($i = 0; $i -lt 30 -and (Test-Path (Join-Path $installDirectory 'Trident.exe')); $i++) {
            Start-Sleep -Seconds 1
        }
        if (Test-Path (Join-Path $installDirectory 'Trident.exe')) { throw 'Uninstaller did not remove the application' }
    }
}
