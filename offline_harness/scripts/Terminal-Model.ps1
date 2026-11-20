param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference='Stop'
$c=Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$root=[IO.Path]::GetFullPath([string]$c.root)
if(![IO.Path]::IsPathRooted($root)){throw 'Model runtime needs an absolute path'}
$ownerFile=Join-Path $root 'owner.json'
$mutex=[Threading.Mutex]::new($false,'Local\OfflineHarnessInteractiveModelGPU0')
$locked=$false
function Write-JsonAtomic([string]$File,$Value){
 $tmp=$File+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
 [IO.File]::WriteAllText($tmp,($Value|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
 if(Test-Path -LiteralPath $File){[IO.File]::Replace($tmp,$File,[NullString]::Value)}else{[IO.File]::Move($tmp,$File)}
}
function Owned-Process($record){
 $p=Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
 if(!$p){return $null}
 if($p.Path -ne [string]$record.exe -or $p.StartTime.ToUniversalTime().ToString('o') -ne [string]$record.start_time){throw 'Model PID identity changed; process was not stopped'}
 return $p
}
function Quote-Argument([string]$value){
 if($value -notmatch '[\s"]' -and $value.Length){return $value}
 return '"'+[regex]::Replace([regex]::Replace($value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'
}
try{
 try{$locked=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$locked=$true}
 if(!$locked){throw 'Another interactive model transition is in progress'}
 if(Test-Path -LiteralPath $ownerFile){
  $owned=Get-Content -LiteralPath $ownerFile -Raw|ConvertFrom-Json
  $p=Owned-Process $owned
  if($p -and $owned.key -eq $c.key){Write-Output 'Owned model is already resident';exit 0}
  if($p){
   Stop-Process -Id $p.Id
   $p.WaitForExit(30000)|Out-Null;$p.Refresh()
   if(!$p.HasExited){throw 'Owned model has not exited'}
  }
 }
 $other=@(Get-CimInstance Win32_Process|Where-Object {$_.Name -like 'llama-server*'})
 if($other.Count){throw 'A model server outside this frontend is running; it was left untouched'}
 $port=([Uri]$c.baseUrl).Port
 if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){throw 'Selected model port is occupied'}
 if(!(Test-Path -LiteralPath $c.exe)){throw 'Model runtime executable is missing'}
 $run=Join-Path $root ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
 New-Item -ItemType Directory -Force -Path $run|Out-Null
 $env:TEMP=Join-Path $run 'temp';$env:TMP=$env:TEMP
 $env:CUDA_CACHE_PATH=Join-Path $run 'cuda-cache'
 New-Item -ItemType Directory -Force -Path $env:TEMP,$env:CUDA_CACHE_PATH|Out-Null
 $env:CUDA_VISIBLE_DEVICES='0';$env:CUDA_MODULE_LOADING='EAGER'
 $env:QWEN_VISION_CACHE_DIR=Join-Path $run 'vision-cache'
 $quoted=(@($c.args)|ForEach-Object {Quote-Argument ([string]$_)}) -join ' '
 $p=Start-Process -FilePath $c.exe -ArgumentList $quoted -WorkingDirectory (Split-Path $c.exe) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $run 'stdout.log') -RedirectStandardError (Join-Path $run 'stderr.log')
 $record=@{requestId=$c.requestId;pid=$p.Id;exe=$p.Path;start_time=$p.StartTime.ToUniversalTime().ToString('o');key=$c.key;model=$c.model;run=$run;args=@($c.args);contextTokens=$c.contextTokens;baseUrl=$c.baseUrl}
 # Publish ownership immediately, so a cancelled startup can be recovered by the next selection.
 Write-JsonAtomic (Join-Path $run 'process.json') $record
 Write-JsonAtomic $ownerFile $record
 $ready=$false
 for($i=0;$i -lt 900;$i++){
  $p.Refresh();if($p.HasExited){throw "Selected model exited; logs: $run"}
  try{$health=Invoke-RestMethod ($c.baseUrl+'/health') -TimeoutSec 1;if($health.status -eq 'ok'){$ready=$true;break}}catch{}
  Start-Sleep -Milliseconds 500
 }
 if(!$ready){throw "Selected model startup timed out; logs: $run"}
 Write-Output ('Ready: '+$c.model+' '+$c.baseUrl)
}catch{Write-JsonAtomic (Join-Path $root 'launch-failed.json') @{requestId=$c.requestId;error=$_.Exception.Message};throw}finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
