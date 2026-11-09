param([string]$Magpie = 'magpie')
$ErrorActionPreference = 'Stop'
$command = Get-Command $Magpie -CommandType Application -ErrorAction SilentlyContinue
if (-not $command) { throw 'Magpie was not found. Add it to PATH or pass -Magpie with its executable path.' }
$process = Start-Process -FilePath $command.Source -ArgumentList @('plugin', 'add', ('"' + $PSScriptRoot + '"')) -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'Magpie could not install the plugin.' }
Write-Output 'Installed. Open Plugins > Review & model rules in Magpie to configure it.'
