# Fetches Chord Buddy's own Python (the small "embeddable" build) so install_windows_dependencies.py has something to run on.
# Used only by InstallWindowsDependencies.cmd, and only when runtime\python.exe is missing.
# Uses plain .NET calls (not cmdlets) so it also works when PowerShell's module path is unusual.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pins = [IO.File]::ReadAllText((Join-Path $root 'installer-pins.json')) | ConvertFrom-Json
$downloads = Join-Path $root '.models\downloads'
[IO.Directory]::CreateDirectory($downloads) | Out-Null
$zip = Join-Path $downloads 'python-embed.zip'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host "Downloading Python $($pins.python.version) (about 11 MB)..."
(New-Object Net.WebClient).DownloadFile($pins.python.url, $zip)
$sha = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($zip)
try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLower() } finally { $stream.Dispose() }
if ($hash -ne $pins.python.sha256) {
    [IO.File]::Delete($zip)
    throw "The Python download did not match its expected fingerprint and was discarded."
}
$runtime = Join-Path $root 'runtime'
[IO.Directory]::CreateDirectory($runtime) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName.EndsWith('/')) { continue }
        $target = Join-Path $runtime $entry.FullName
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
} finally { $archive.Dispose() }
$pth = (@('python311.zip', '.', 'app-packages', 'engine-packages', '..', 'import site') -join "`r`n") + "`r`n"
[IO.File]::WriteAllText((Join-Path $runtime 'python311._pth'), $pth)
[IO.Directory]::CreateDirectory((Join-Path $runtime 'app-packages')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $runtime 'engine-packages')) | Out-Null
Write-Host 'Python is ready.'
