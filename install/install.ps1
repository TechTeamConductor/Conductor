# Conductor installer for Windows (EXPERIMENTAL).
#
#   irm https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.ps1 | iex
#
# Then start the dashboard:  conductor start
#
# Windows support is experimental: the installer and the dashboard work, but registering repositories, running gates and launching the
# claude / agent CLIs are not ported yet. For the full product use WSL2 (run the macOS/Linux installer inside it) or a Mac.
#
# What it does: finds the latest release, downloads conductor.tgz + SHA256SUMS.txt over HTTPS, verifies the checksum, unpacks the app
# into %LOCALAPPDATA%\Conductor\app (not inside node_modules: Node cannot run TypeScript from there), writes
# %LOCALAPPDATA%\Conductor\bin\conductor.cmd and adds that folder to YOUR user PATH. No admin rights, never touches the machine PATH, never
# touches your data folder (%USERPROFILE%\.conductor-v2).
#
# Options are environment variables (so they work with `irm | iex`), e.g.   $env:CONDUCTOR_UNINSTALL = '1'; irm <url> | iex
#   CONDUCTOR_INSTALL_VERSION=X.Y.Z   install that release instead of the latest
#   CONDUCTOR_UNINSTALL=1             remove the app and launcher (your data folder stays)
#   CONDUCTOR_NO_PATH_UPDATE=1        do not edit the user PATH
#   CONDUCTOR_LOCAL_DIR=<dir>         use <dir>\conductor.tgz and <dir>\SHA256SUMS.txt instead of downloading (still verified)
#   CONDUCTOR_INSTALL_DIR, CONDUCTOR_BIN_DIR   where the app / launcher go
#
# The whole script is one function called on the last line, so a truncated download runs nothing. It never calls `exit`.

function Install-Conductor {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    $repo = 'TechTeamConductor/Conductor'
    $shimMarker = 'rem conductor-installer-shim v1'
    $appMarker = '.conductor-installer'
    $pathRe = '\A[A-Za-z]:\\[^"%!^&|<>;\r\n]+\z' # a drive path; characters that could break the .cmd launcher or the PATH list are refused

    function Fail([string]$message) { throw "Conductor installer: $message" }

    # tell running programs (Explorer, new terminals launched from it) that the user environment changed, so `conductor` is found without signing out
    function Send-EnvironmentChange {
        try {
            if (-not ('ConductorNative.Win32' -as [type])) {
                Add-Type -Namespace ConductorNative -Name Win32 -ErrorAction Stop -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
            }
            $result = [UIntPtr]::Zero
            [void][ConductorNative.Win32]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
        } catch { }
    }

    Write-Host 'Conductor for Windows is EXPERIMENTAL: the dashboard runs, but registering repos, running gates and launching the claude/agent CLIs are not ported yet. Use WSL2 or a Mac for the full product.' -ForegroundColor Yellow

    $localRoot = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Conductor' } else { Fail 'LOCALAPPDATA is not set' }
    $app = if ($env:CONDUCTOR_INSTALL_DIR) { $env:CONDUCTOR_INSTALL_DIR } else { Join-Path $localRoot 'app' }
    $bin = if ($env:CONDUCTOR_BIN_DIR) { $env:CONDUCTOR_BIN_DIR } else { Join-Path $localRoot 'bin' }
    $app = $app.TrimEnd('\')
    $bin = $bin.TrimEnd('\')
    if ($app -cnotmatch $pathRe) { Fail "the install folder has unsupported characters (no quotes, % ! ^ & | < > ; or line breaks): $app" }
    if ($bin -cnotmatch $pathRe) { Fail "the launcher folder has unsupported characters: $bin" }
    $shim = Join-Path $bin 'conductor.cmd'

    # ---- uninstall -------------------------------------------------------------------------------------------------------------
    if ($env:CONDUCTOR_UNINSTALL -eq '1') {
        $removed = $false
        if ((Test-Path -LiteralPath $shim) -and ((Get-Content -LiteralPath $shim -Raw) -match [regex]::Escape($shimMarker))) {
            Remove-Item -LiteralPath $shim -Force
            Write-Host "Removed the launcher $shim"
            $removed = $true
        }
        if ((Test-Path -LiteralPath $app) -and ((Get-Item -LiteralPath $app -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Write-Host "Left $app alone: it is a link."
        } elseif ((Test-Path -LiteralPath $app) -and (Test-Path -LiteralPath (Join-Path $app $appMarker))) {
            Remove-Item -LiteralPath $app -Recurse -Force
            Write-Host "Removed the app $app"
            $removed = $true
        } elseif (Test-Path -LiteralPath $app) {
            Write-Host "Left $app alone: it was not created by this installer."
        }
        if ($removed -and (Test-Path -LiteralPath $bin) -and -not (Get-ChildItem -LiteralPath $bin -Force)) {
            Remove-Item -LiteralPath $bin -Force
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
            if ($key) {
                $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                $all = @($raw -split ';' | Where-Object { $_ -ne '' })
                $kept = @($all | Where-Object { $_.TrimEnd('\') -ine $bin })
                if ($kept.Count -ne $all.Count) {
                    $key.SetValue('Path', ($kept -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
                    Send-EnvironmentChange
                }
                $key.Close()
            }
        }
        if (-not $removed) { Write-Host 'Nothing to remove.' }
        Write-Host "Your data folder ($env:USERPROFILE\.conductor-v2) was not touched. Delete it yourself if you also want your boards and settings gone."
        return
    }

    # ---- the requested version is validated first ------------------------------------------------------------------------------
    $want = $null
    if ($null -ne $env:CONDUCTOR_INSTALL_VERSION) {
        if ($env:CONDUCTOR_INSTALL_VERSION -cnotmatch '\A[0-9]+\.[0-9]+\.[0-9]+\z') { Fail 'CONDUCTOR_INSTALL_VERSION must look like 1.2.3' }
        $want = $env:CONDUCTOR_INSTALL_VERSION
    }

    # ---- Node 22.18+ -----------------------------------------------------------------------------------------------------------
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Fail "Node.js 22.18 or newer is required but 'node' was not found. Install it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), open a new terminal, then run this again."
    }
    $nodeVersion = (& node -p 'process.versions.node' 2>$null | Out-String).Trim()
    if ($nodeVersion -cmatch '\A([0-9]+)\.([0-9]+)\.') {
        $nodeMajor = [int]$Matches[1]
        $nodeMinor = [int]$Matches[2]
    } else {
        Fail 'could not read the Node.js version'
    }
    if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 18)) {
        Fail "Node.js 22.18 or newer is required (you have $nodeVersion). Install a newer Node from https://nodejs.org, open a new terminal, then run this again."
    }

    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) { Fail 'tar.exe was not found (Windows 10 version 1803 or newer is required).' }

    # never overwrite something this installer did not create
    if ((Test-Path -LiteralPath $app) -and ((Get-Item -LiteralPath $app -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail "$app is a link, refusing to touch it" }
    if ((Test-Path -LiteralPath $shim) -and -not ((Get-Content -LiteralPath $shim -Raw) -match [regex]::Escape($shimMarker))) {
        Fail "another 'conductor.cmd' already exists at $shim and was not created by this installer. Move it away and run this again."
    }
    if ((Test-Path -LiteralPath $app) -and -not (Test-Path -LiteralPath (Join-Path $app $appMarker))) {
        Fail "$app already exists and was not created by this installer. Move it away (or set CONDUCTOR_INSTALL_DIR) and run this again."
    }

    $parent = Split-Path -Parent $app
    New-Item -ItemType Directory -Force -Path $parent, $bin | Out-Null
    $lockFile = Join-Path $parent '.conductor-install.lock'
    $lock = $null
    try { $lock = [System.IO.File]::Open($lockFile, 'CreateNew', 'Write', 'None') } catch { Fail "another install seems to be running (or crashed). If not, delete $lockFile and run this again." }
    $work = Join-Path $parent ('.conductor-install.' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null

    try {
        # ---- get the release -------------------------------------------------------------------------------------------------
        $tag = $null
        if ($env:CONDUCTOR_LOCAL_DIR) {
            $tgzSrc = Join-Path $env:CONDUCTOR_LOCAL_DIR 'conductor.tgz'
            $sumsSrc = Join-Path $env:CONDUCTOR_LOCAL_DIR 'SHA256SUMS.txt'
            if (-not (Test-Path -LiteralPath $tgzSrc) -or -not (Test-Path -LiteralPath $sumsSrc)) { Fail 'CONDUCTOR_LOCAL_DIR must hold conductor.tgz and SHA256SUMS.txt' }
            Write-Host "Installing from the local folder $($env:CONDUCTOR_LOCAL_DIR): its SHA256SUMS.txt only catches corruption, it does not prove where the files came from." -ForegroundColor Yellow
            Copy-Item -LiteralPath $tgzSrc -Destination (Join-Path $work 'conductor.tgz')
            Copy-Item -LiteralPath $sumsSrc -Destination (Join-Path $work 'SHA256SUMS.txt')
            if ($want) { $tag = "v$want" }
        } else {
            if ($want) {
                $tag = "v$want"
            } else {
                # resolve "latest" ONCE to a tag, then download both files from that tag (they cannot come from two different releases)
                $location = $null
                try {
                    $req = [System.Net.HttpWebRequest]::Create("https://github.com/$repo/releases/latest")
                    $req.Method = 'HEAD'
                    $req.AllowAutoRedirect = $false
                    $resp = $req.GetResponse()
                    $location = $resp.Headers['Location']
                    $resp.Close()
                } catch [System.Net.WebException] {
                    if ($_.Exception.Response) { $location = $_.Exception.Response.Headers['Location']; $_.Exception.Response.Close() }
                }
                $prefix = "https://github.com/$repo/releases/tag/"
                if (-not $location -or -not $location.StartsWith($prefix) -or ($location.Substring($prefix.Length) -cnotmatch '\Av[0-9]+\.[0-9]+\.[0-9]+\z')) {
                    Fail 'could not find the latest release (is there a published release yet?)'
                }
                $tag = $location.Substring($prefix.Length)
            }
            Write-Host "Installing Conductor $tag ..."
            Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/releases/download/$tag/conductor.tgz" -OutFile (Join-Path $work 'conductor.tgz')
            Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/releases/download/$tag/SHA256SUMS.txt" -OutFile (Join-Path $work 'SHA256SUMS.txt')
        }

        # ---- verify BEFORE unpacking -----------------------------------------------------------------------------------------
        $lines = @((Get-Content -LiteralPath (Join-Path $work 'SHA256SUMS.txt') -Raw) -split "`r?`n" | Where-Object { $_ -cmatch '\A[0-9a-f]{64}  conductor\.tgz\z' })
        if ($lines.Count -ne 1) { Fail 'SHA256SUMS.txt has no single valid line for conductor.tgz, refusing to install' }
        $expect = $lines[0].Substring(0, 64)
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $work 'conductor.tgz')).Hash.ToLowerInvariant()
        if ($expect -cne $actual) { Fail "checksum mismatch for conductor.tgz (expected $expect, got $actual). Nothing was installed." }

        # ---- unpack safely ---------------------------------------------------------------------------------------------------
        $tgz = Join-Path $work 'conductor.tgz'
        foreach ($name in @(& $tar -tzf $tgz)) {
            if ($name -match '\A(/|\\)' -or $name.Contains(':') -or $name -match '\.\.' -or $name.Contains('\')) { Fail "unsafe path in the archive: $name" }
            if ($name -cne 'package' -and -not $name.StartsWith('package/')) { Fail "unexpected entry in the archive: $name" }
        }
        foreach ($line in @(& $tar -tvzf $tgz)) {
            if ($line -cnotmatch '\A[-d]') { Fail 'the archive contains links or special files, refusing to unpack it' }
        }
        $extract = Join-Path $work 'extract'
        New-Item -ItemType Directory -Path $extract | Out-Null
        & $tar -xzf $tgz -C $extract --strip-components=1
        if ($LASTEXITCODE -ne 0) { Fail 'could not unpack the archive' }
        if (Get-ChildItem -LiteralPath $extract -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { Fail 'the archive contained links, refusing to install' }

        $pkg = Get-Content -LiteralPath (Join-Path $extract 'package.json') -Raw | ConvertFrom-Json
        if ($pkg.name -cne 'conductor') { Fail 'the archive is not a Conductor package' }
        $version = [string]$pkg.version
        if ($version -cnotmatch '\A[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]*[0-9A-Za-z])?\z') { Fail "the archive has an invalid version: $version" }
        if ($tag -and "v$version" -cne $tag) { Fail "the archive is version $version but release $tag was requested" }
        if (-not (Test-Path -LiteralPath (Join-Path $extract 'bin\conductor.mjs'))) { Fail 'the archive is missing bin\conductor.mjs' }
        New-Item -ItemType File -Path (Join-Path $extract $appMarker) | Out-Null

        # ---- swap with rollback ----------------------------------------------------------------------------------------------
        $old = "$app.old"
        if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
        $hadOld = Test-Path -LiteralPath $app
        try {
            if ($hadOld) { Move-Item -LiteralPath $app -Destination $old }
            Move-Item -LiteralPath $extract -Destination $app
        } catch {
            if ($hadOld -and -not (Test-Path -LiteralPath $app) -and (Test-Path -LiteralPath $old)) { Move-Item -LiteralPath $old -Destination $app }
            Fail 'could not replace the installed app (is Conductor still running? quit it with Ctrl+C and run this again)'
        }
        $got = (& node (Join-Path $app 'bin\conductor.mjs') version 2>$null | Out-String).Trim()
        if ($got -cne $version) {
            Remove-Item -LiteralPath $app -Recurse -Force
            if ($hadOld) { Move-Item -LiteralPath $old -Destination $app }
            Fail "the new version failed its self-check (got '$got', expected '$version'); the previous install was restored"
        }

        # ---- the launcher ----------------------------------------------------------------------------------------------------
        $appRef = if ((Split-Path -Parent $bin) -ieq (Split-Path -Parent $app) -and (Split-Path -Leaf $bin) -eq 'bin' -and (Split-Path -Leaf $app) -eq 'app') { '%~dp0..\app\bin\conductor.mjs' } else { Join-Path $app 'bin\conductor.mjs' }
        if ($appRef -notlike '%~dp0*' -and $appRef -cmatch '[^\x00-\x7F]') { Fail 'a custom install folder must use ASCII characters only (the default layout has no such limit)' }
        $cmd = @(
            '@echo off',
            $shimMarker,
            'where node >nul 2>nul || (echo Conductor needs Node.js 22.18 or newer on your PATH. https://nodejs.org 1>&2 & exit /b 1)',
            "node `"$appRef`" %*"
        ) -join "`r`n"
        [System.IO.File]::WriteAllText($shim, $cmd + "`r`n", (New-Object System.Text.ASCIIEncoding))
        if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }

        # ---- PATH (user only, raw registry value so %VARS% are kept) ---------------------------------------------------------
        $pathNote = ''
        if ($env:CONDUCTOR_NO_PATH_UPDATE -eq '1') {
            $pathNote = "Not added to PATH (CONDUCTOR_NO_PATH_UPDATE=1). Run it by full path: $shim start"
        } else {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
            $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $parts = @($raw -split ';' | Where-Object { $_ -ne '' })
            if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $bin })) {
                $key.SetValue('Path', (($parts + $bin) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
                Send-EnvironmentChange
                $pathNote = 'Added to your user PATH: open a NEW terminal for `conductor` to be found.'
            }
            $key.Close()
            if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $bin })) { $env:Path = "$env:Path;$bin" }
        }

        Write-Host ''
        Write-Host "Conductor $version is installed."
        Write-Host "  app:       $app"
        Write-Host "  launcher:  $shim"
        if ($pathNote) { Write-Host $pathNote }
        Write-Host ''
        Write-Host 'Start it:                      conductor start'
        Write-Host 'Try it without any keys first: conductor demo'
        Write-Host 'Check your setup:              conductor doctor'
        Write-Host 'Stop / update:                  conductor stop | conductor update (on Windows: Ctrl+C to stop, then run the install command again)'
        Write-Host 'Remember: Windows support is experimental (see the note above).' -ForegroundColor Yellow
    } finally {
        if ($lock) { $lock.Close() }
        Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Install-Conductor
