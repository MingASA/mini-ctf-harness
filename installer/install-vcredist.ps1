param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$env:TEMP=Join-Path (Split-Path $Path) 'vc-temp';$env:TMP=$env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP|Out-Null
$p=Start-Process -FilePath $Path -ArgumentList '/install /quiet /norestart' -Verb RunAs -Wait -PassThru
if($p.ExitCode -notin @(0,1638,3010)){throw "VC runtime installation failed: $($p.ExitCode)"}
