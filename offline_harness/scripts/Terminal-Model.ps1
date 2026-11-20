param(
 [Parameter(Mandatory=$true,ParameterSetName='Start')][string]$Config,
 [Parameter(Mandatory=$true,ParameterSetName='Stop')][switch]$Stop,
 [Parameter(Mandatory=$true,ParameterSetName='Stop')][string]$RuntimeRoot,
 [Parameter(Mandatory=$true,ParameterSetName='Stop')][string]$ExpectedExe
)
$ErrorActionPreference='Stop'
if($Stop){
 $root=[IO.Path]::GetFullPath($RuntimeRoot)
 $exe=[IO.Path]::GetFullPath($ExpectedExe)
}else{
 $c=Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
 $root=[IO.Path]::GetFullPath([string]$c.root)
 $exe=[IO.Path]::GetFullPath([string]$c.exe)
}
if(![IO.Path]::IsPathRooted($root)){throw 'Model runtime needs an absolute path'}
$ownerFile=Join-Path $root 'owner.json'
$selectionFile=Join-Path $root 'selection.json'
$mutex=[Threading.Mutex]::new($false,'Local\OfflineHarnessInteractiveModelGPU0')
$locked=$false
function Lock-Transition {
 try{return $mutex.WaitOne(30000)}catch [Threading.AbandonedMutexException]{return $true}
}
function Selected-Request {
 if(!(Test-Path -LiteralPath $selectionFile)){return $false}
 return (Get-Content -LiteralPath $selectionFile -Raw|ConvertFrom-Json).requestId -eq $c.requestId
}
function Still-Owned($record){
 if(!(Test-Path -LiteralPath $ownerFile)){return $false}
 $current=Get-Content -LiteralPath $ownerFile -Raw|ConvertFrom-Json
 return $current.pid -eq $record.pid -and $current.start_time -eq $record.start_time -and $current.requestId -eq $record.requestId
}
function Write-JsonAtomic([string]$File,$Value){
 $tmp=$File+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 [IO.File]::WriteAllText($tmp,($Value|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
 if(Test-Path -LiteralPath $File){[IO.File]::Replace($tmp,$File,[NullString]::Value)}else{[IO.File]::Move($tmp,$File)}
}
function Owned-Process($record){
 $p=Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
 if(!$p){return $null}
 $recordedExe=[string]$record.exe
 # Older starts could record a null Process.Path before Windows exposed it.
 if(!$recordedExe){$recordedExe=$exe}
 if($p.Path -ne $recordedExe -or $p.StartTime.ToUniversalTime().ToString('o') -ne [string]$record.start_time){throw 'Model PID identity changed; process was not stopped'}
 return $p
}
function Quote-Argument([string]$value){
 if($value -notmatch '[\s"]' -and $value.Length){return $value}
 return '"'+[regex]::Replace([regex]::Replace($value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'
}
try{
 $locked=Lock-Transition
 if(!$locked){throw 'Another interactive model transition is in progress'}
 if($Stop){
  # Invalidate detached launchers that have not acquired the mutex yet.
  if(Test-Path -LiteralPath $selectionFile){Remove-Item -LiteralPath $selectionFile}
 }elseif(!(Selected-Request)){exit 0}
 $reuse=$false
 if(Test-Path -LiteralPath $ownerFile){
  $owned=Get-Content -LiteralPath $ownerFile -Raw|ConvertFrom-Json
  $p=Owned-Process $owned
  if(!$Stop -and $p -and $owned.key -eq $c.key){
   $owned|Add-Member -NotePropertyName selectionId -NotePropertyValue $c.requestId -Force
   Write-JsonAtomic $ownerFile $owned
   $record=$owned;$run=$owned.run;$reuse=$true
  }
  if($p -and !$reuse){
   Stop-Process -InputObject $p
   $p.WaitForExit(30000)|Out-Null;$p.Refresh()
   if(!$p.HasExited){throw 'Owned model has not exited'}
  }
 }
 if($Stop){
  if(Test-Path -LiteralPath $ownerFile){Remove-Item -LiteralPath $ownerFile}
  Write-Output 'Managed model stopped'
  exit 0
 }
 if(!$reuse){
  if(Test-Path -LiteralPath $ownerFile){Remove-Item -LiteralPath $ownerFile}
  $other=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -like 'llama-server*'})
  if($other.Count){throw 'A model server outside this frontend is running; it was left untouched'}
  $port=([Uri]$c.baseUrl).Port
  if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw 'Selected model port is occupied'}
  if(!(Test-Path -LiteralPath $c.exe)){throw 'Model runtime executable is missing'}
  $free=[double](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024
  if($free -lt 2560){throw "Insufficient free RAM before model loading: $free MiB"}
  $used=$null;$lastGpuError=''
  for($sample=0;$sample -lt 30;$sample++){
   $values=@(& nvidia-smi.exe --query-gpu=memory.used --format=csv,noheader,nounits 2>&1);$gpuExit=$LASTEXITCODE
   $line=([string]($values|Select-Object -First 1)).Trim()
   if($gpuExit -eq 0 -and $line -match '^\d+$'){$used=[int]$line;if($used -le 2048){break}}
   $lastGpuError=($values|Out-String).Trim();Start-Sleep -Milliseconds 500
  }
  if($null -eq $used){throw ('GPU resource query failed: '+$lastGpuError)}
  if($used -gt 2048){throw "GPU is occupied: $used MiB"}
  if(!(Selected-Request)){exit 0}
  $run=Join-Path $root ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Force -Path $run|Out-Null
  $env:TEMP=Join-Path $run 'temp';$env:TMP=$env:TEMP
  $env:CUDA_CACHE_PATH=Join-Path $run 'cuda-cache'
  New-Item -ItemType Directory -Force -Path $env:TEMP,$env:CUDA_CACHE_PATH|Out-Null
  $env:CUDA_VISIBLE_DEVICES='0';$env:CUDA_MODULE_LOADING='EAGER'
  $env:QWEN_VISION_CACHE_DIR=Join-Path $run 'vision-cache'
  $quoted=(@($c.args)|ForEach-Object {Quote-Argument ([string]$_)}) -join ' '
  $p=Start-Process -FilePath $c.exe -ArgumentList $quoted -WorkingDirectory (Split-Path $c.exe) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $run 'stdout.log') -RedirectStandardError (Join-Path $run 'stderr.log')
  $record=@{requestId=$c.requestId;selectionId=$c.requestId;pid=$p.Id;exe=$exe;start_time=$p.StartTime.ToUniversalTime().ToString('o');key=$c.key;model=$c.model;run=$run;args=@($c.args);contextTokens=$c.contextTokens;baseUrl=$c.baseUrl}
  # Publish ownership immediately, so a cancelled startup can be recovered by the next selection.
  Write-JsonAtomic (Join-Path $run 'process.json') $record
  Write-JsonAtomic $ownerFile $record
 }
 # Readiness polling must not block closing or replacing a loading model.
 $mutex.ReleaseMutex();$locked=$false
 $ready=$false
 for($i=0;$i -lt 900;$i++){
  if(!(Selected-Request) -or !(Still-Owned $record)){exit 0}
  $p.Refresh();if($p.HasExited){throw "Selected model exited; logs: $run"}
  try{$health=Invoke-RestMethod ($c.baseUrl+'/health') -TimeoutSec 1;if($health.status -eq 'ok'){$ready=$true;break}}catch{}
  Start-Sleep -Milliseconds 500
 }
 if(!$ready){throw "Selected model startup timed out; logs: $run"}
 Write-Output ('Ready: '+$c.model+' '+$c.baseUrl)
}catch{
 $failure=$_
 if(!$Stop){
  if(!$locked){$locked=Lock-Transition}
  if($locked -and (Selected-Request)){
   Write-JsonAtomic (Join-Path $root 'launch-failed.json') @{requestId=$c.requestId;error=$failure.Exception.Message}
  }
 }
 throw $failure
}finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
