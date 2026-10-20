param([string]$TestRoot=$PSScriptRoot)
$ErrorActionPreference='Stop'
$appDir=Split-Path $TestRoot -Parent
Add-Type -Path @((Join-Path $appDir 'runtime/allmind-visibility.cs'),(Join-Path $appDir 'runtime/allmind-window-observer.cs'))
$script:checks=0
function Check([bool]$Value,[string]$Message){$script:checks++;if(!$Value){throw $Message}}
function Observation([bool]$Full=$false,[long]$Monitor=1,[long]$PetMonitor=1){
 $o=[AllmindWindowObservation]::new();$o.SessionKnown=$true;$o.SessionAvailable=$true;$o.GeometryKnown=$true;$o.ShellAllowsNotifications=$true;$o.Foreground=100;$o.Monitor=$Monitor;$o.PetMonitor=$PetMonitor;$o.Fullscreen=$Full;return $o
}
$p=[AllmindVisibilityPolicy]::new();$o=Observation $true
Check ($p.Evaluate($o,0,$false,$false,$true).Visible) 'Fullscreen hid before confirmation'
Check ($p.Evaluate($o,399,$false,$false,$true).Visible) '399 ms entry boundary'
Check (!$p.Evaluate($o,400,$false,$false,$true).Visible) '400 ms entry boundary'
$revision=$p.Current.Revision
Check ($p.Evaluate($o,500,$false,$false,$true).Revision-eq $revision) 'Identical observation caused state churn'
$p.Hide();$d=$p.Evaluate($o,501,$false,$false,$true)
Check ($d.Reasons-contains 'manual' -and $d.Reasons-contains 'fullscreen') 'Hidden causes were merged destructively'
$o.Fullscreen=$false;$null=$p.Evaluate($o,502,$false,$false,$true);$d=$p.Evaluate($o,1302,$false,$false,$true)
Check (!$d.Visible -and $d.Reasons-contains 'manual' -and $d.Reasons-notcontains 'fullscreen') 'Exit fullscreen cleared manual intent'
$p.Show(1303);Check ($p.Evaluate($o,1303,$false,$false,$true).Visible) 'Explicit reveal did not restore'
$o.SessionAvailable=$false;$d=$p.Evaluate($o,1400,$false,$false,$true);Check ($d.State-eq 'SUSPENDED' -and !$d.NotificationAllowed) 'Session unavailable not suspended'
$p.Show(1401);Check (!$p.Evaluate($o,1401,$false,$false,$true).Visible) 'Reveal bypassed session guard'
$o.SessionAvailable=$true;$p.Hide();$o.PowerSuspended=$true;$null=$p.Evaluate($o,1500,$false,$false,$true);$o.PowerSuspended=$false
Check (!$p.Evaluate($o,1600,$false,$false,$true).Visible) 'Resume cleared manual intent'
$p.Show(1601);$o.SessionKnown=$false;Check ($p.Evaluate($o,1601,$false,$false,$true).State-eq 'SUSPENDED') 'Unknown session exposed overlay'
$o=Observation $true;$p=[AllmindVisibilityPolicy]::new();$null=$p.Evaluate($o,0,$false,$false,$true);$null=$p.Evaluate($o,400,$false,$false,$true);$p.Show(401)
Check ($p.Evaluate($o,401,$false,$false,$true).Visible) 'Explicit fullscreen reveal missing'
Check ($p.Evaluate($o,10400,$false,$false,$true).Visible) 'Lease expired too soon'
Check (!$p.Evaluate($o,10401,$false,$false,$true).Visible) 'Lease did not expire'
$p.Show(10402);$o.Foreground=101;Check (!$p.Evaluate($o,10403,$false,$false,$true).Visible) 'Lease leaked to another foreground window'
$p.Show(10404);$o.Presentation=$true;Check (!$p.Evaluate($o,10404,$false,$false,$true).Visible) 'Reveal bypassed Windows presentation mode'
$p=[AllmindVisibilityPolicy]::new();$o=Observation $true 2 1;$d=$p.Evaluate($o,0,$false,$false,$true);$d=$p.Evaluate($o,400,$false,$false,$true)
Check ($d.Visible) 'Secondary screen hid main-screen pet'
$o.PetMonitor=2;$null=$p.Evaluate($o,401,$false,$false,$true);Check (!$p.Evaluate($o,801,$false,$false,$true).Visible) 'Cross-screen drag did not update fullscreen scope'
$o.Fullscreen=$false;$null=$p.Evaluate($o,802,$false,$false,$true);Check (!$p.Evaluate($o,1601,$false,$false,$true).Visible) '799 ms exit boundary'
Check ($p.Evaluate($o,1602,$false,$false,$true).Visible) '800 ms exit boundary'
$p=[AllmindVisibilityPolicy]::new();$o=Observation $true;$null=$p.Evaluate($o,0,$true,$false,$true)
Check ($p.Evaluate($o,800,$true,$false,$true).Visible) 'Menu/drag lost its overlay'
$null=$p.Evaluate($o,801,$false,$false,$true);Check ($p.Evaluate($o,1200,$false,$false,$true).Visible) 'Busy release skipped confirmation'
Check (!$p.Evaluate($o,1201,$false,$false,$true).Visible) 'Busy release never completed confirmation'
$o.GeometryKnown=$false;Check (!$p.Evaluate($o,3201,$false,$false,$true).Visible) 'Valid observation not retained for 2 seconds'
$d=$p.Evaluate($o,3202,$false,$false,$true);Check ($d.Visible -and !$d.Topmost -and !$d.NotificationAllowed -and $d.Reasons-contains 'detector-degraded') 'Unknown detector did not degrade explicitly'
Check ($p.DelayUntilTransition(3202)-gt 100) 'Degraded detector entered a 1 ms timer loop'
foreach($mode in @('resident','normal')){
 $p=[AllmindVisibilityPolicy]::new();$p.Mode=$mode;$o=Observation $true;$null=$p.Evaluate($o,0,$false,$false,$true);$d=$p.Evaluate($o,400,$false,$false,$true)
 Check ($d.Visible) "$mode auto-hid fullscreen"
 Check ($d.Topmost-eq ($mode-eq 'resident')) "$mode z-order mismatch"
 $o.ShellAllowsNotifications=$false;Check (!$p.Evaluate($o,500,$false,$false,$true).NotificationAllowed) 'Shell busy did not suppress notification'
 $o.Presentation=$true;Check (!$p.Evaluate($o,600,$false,$false,$true).Visible) "$mode ignored presentation mode"
}
$p=[AllmindVisibilityPolicy]::new();$o=Observation
Check (!$p.Evaluate($o,0,$false,$true,$true).NotificationAllowed) 'User DND was cleared'
Check (!$p.Evaluate($o,1,$false,$false,$false).NotificationAllowed) 'Disconnected backend allowed notifications'
Check ($p.Evaluate($o,2,$false,$false,$true).NotificationAllowed) 'Normal connected notifications suppressed'
$p.Exiting=$true;$p.Show(3);Check ($p.Evaluate($o,3,$false,$false,$true).State-eq 'EXITING') 'Shutdown resurrected'
$screen=[int[]]@(-1920,0,0,1080)
Check ([AllmindVisibilityPolicy]::FullscreenGeometry($screen,$screen,$screen,$false,$true)) 'Borderless fullscreen on negative screen rejected'
Check (![AllmindVisibilityPolicy]::FullscreenGeometry(@(-1800,0,120,1080),@(-1800,0,120,1080),$screen,$false,$false)) 'Equal dimensions at wrong coordinates accepted'
Check (![AllmindVisibilityPolicy]::FullscreenGeometry($screen,@(-1920,31,0,1080),$screen,$true,$true)) 'Normal maximized titlebar accepted'
Check (![AllmindVisibilityPolicy]::FullscreenGeometry($screen,$screen,$screen,$true,$true)) 'Auto-hide taskbar maximized caption accepted'
Check (![AllmindVisibilityPolicy]::FullscreenGeometry(@(-1920,0,-20,1080),$screen,$screen,$false,$false)) 'Smaller borderless window accepted'
Check ([AllmindVisibilityPolicy]::FullscreenGeometry(@(-1918,2,-2,1078),$screen,$screen,$false,$false)) 'Physical-pixel tolerance rejected'
. (Join-Path $appDir 'runtime/allmind-visibility.ps1')
$preferencesPath=Join-Path ([IO.Path]::GetTempPath()) ('allmind-visibility-test-'+[Guid]::NewGuid().ToString('N')+'.json')
Check ((Read-AllmindVisibilityPreferences $preferencesPath $null).Mode-eq 'smart') 'Clean install did not default smart'
Check ((Read-AllmindVisibilityPreferences $preferencesPath @{desktopTopmost=$false}).Mode-eq 'normal') 'Upgrade changed normal-layer intent'
Check ((Read-AllmindVisibilityPreferences $preferencesPath @{desktopTopmost=$true}).Mode-eq 'resident') 'Upgrade changed topmost intent'
try{
 $saved=@{version=1;mode='smart';manualHidden=$true;clickThrough=$false;replyReminder=$false;hotkeyKey=80;hotkeyModifiers=16387};$bytes=$saved|ConvertTo-Json
 [IO.File]::WriteAllText($preferencesPath,$bytes,[Text.UTF8Encoding]::new($false));$p=Read-AllmindVisibilityPreferences $preferencesPath $null
 Check ($p.ManualHidden -and !$p.ReplyReminder) 'Manual hide/reminder preference lost'
 $saved.hotkeyKey='80';[IO.File]::WriteAllText($preferencesPath,($saved|ConvertTo-Json),[Text.UTF8Encoding]::new($false));$before=[IO.File]::ReadAllText($preferencesPath);$rejected=$false
 try{$null=Read-AllmindVisibilityPreferences $preferencesPath $null}catch{$rejected=$true}
 Check $rejected 'Malformed hotkey silently converted to a default'
 Check ([IO.File]::ReadAllText($preferencesPath)-eq $before) 'Invalid preferences were overwritten'
}finally{if(Test-Path -LiteralPath $preferencesPath){Remove-Item -LiteralPath $preferencesPath}}
$pixels=New-Object byte[] 64;$pixels[(1*4+3)*4+3]=255;$pixels[(2*4+3)*4+3]=255
$fraction=[AllmindVisibilityPolicy]::AlphaCenter($pixels,4,4,16)
Check ($fraction[0]-eq 0.75 -and $fraction[1]-eq 0.375) 'Transparent canvas shifted the pet monitor center'
. (Join-Path $appDir 'runtime/allmind-host.ps1')
function Update-AllmindVisibility {}
function Save-AllmindVisibilityPreferences {}
function Tick-Widget {}
$script:allmindVisibility=[AllmindVisibilityPolicy]::new();$script:allmindVisibility.ManualHidden=$true;$script:allmindVisibility.ClickThrough=$true
Set-AllmindVisible $true
Check (!$script:allmindVisibility.ManualHidden) 'Explicit host reveal retained manual hide'
Check (!$script:allmindVisibility.ClickThrough) 'Tray/hotkey reveal stranded the user in complete click-through'
Write-Output "PASS: $script:checks ALLMIND visibility/notification/geometry policy assertions; no native UI input simulated."
