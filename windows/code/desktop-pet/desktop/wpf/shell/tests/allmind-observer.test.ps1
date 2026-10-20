param([string]$TestRoot=$PSScriptRoot)
$ErrorActionPreference='Stop';$appDir=Split-Path $TestRoot -Parent
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
Add-Type -Path @((Join-Path $appDir 'runtime/allmind-visibility.cs'),(Join-Path $appDir 'runtime/allmind-window-observer.cs'))
$sources=@();$observers=@();$checks=0
function Check([bool]$Value,[string]$Message){if(!$Value){throw $Message};$script:checks++}
try{
 for($i=0;$i-lt 2;$i++){
  $parameters=[Windows.Interop.HwndSourceParameters]::new('ALLMIND observer component test '+$i);$parameters.ParentWindow=[IntPtr](-3);$parameters.WindowStyle=0
  $source=[Windows.Interop.HwndSource]::new($parameters);$sources+=,$source;$observers+=,[AllmindWindowObserver]::new($source.Handle)
 }
 $firstKey=0
 foreach($key in @(135,134,133,132)){if($observers[0].ConfigureHotkey(0x4003,$key)){$firstKey=$key;break}}
 Check ($firstKey-ne 0) 'BLOCKED: test hotkey range unavailable'
 Check (!$observers[1].ConfigureHotkey(0x4003,$firstKey)) 'Hotkey conflict was reported as success'
 Check ($observers[1].RegistrationError.StartsWith('hotkey-conflict:')) 'Conflict reason missing'
 $secondKey=0
 foreach($key in @(131,130,129,128)){if($observers[1].ConfigureHotkey(0x4003,$key)){$secondKey=$key;break}}
 Check ($secondKey-ne 0) 'BLOCKED: alternate hotkey range unavailable'
 Check (!$observers[1].RegistrationError -or !$observers[1].RegistrationError.StartsWith('hotkey-conflict:')) 'Successful rebind retained stale conflict'
 $observers[0].Dispose()
 Check ($observers[1].ConfigureHotkey(0x4003,$firstKey)) 'Disposed observer retained its hotkey'
 $sample=$observers[1].Sample(0,0)
 Check ($sample.PetMonitor-ne 0) 'Native point-to-monitor mapping unavailable'
 Check ($observers[1].Message(0x312,0x414D)-eq 1) 'Registered hotkey not routed to reveal'
 Check ($observers[1].Message(0x218,4)-eq 3 -and $observers[1].PowerSuspended) 'Suspend did not invalidate observation'
 Check ($observers[1].Message(0x218,18)-eq 3 -and !$observers[1].PowerSuspended) 'Resume retained suspended state'
 Write-Output "PASS: $checks Win32 observer component assertions; real hotkey conflict/rebind/release, no native input."
}finally{foreach($observer in $observers){$observer.Dispose()};foreach($source in $sources){$source.Dispose()}}
