$ErrorActionPreference='Stop'
$appDir=Split-Path $PSScriptRoot -Parent
Add-Type -Path (Join-Path $appDir 'runtime/allmind-visibility.cs')
$checks=0
function Check([bool]$Value,[string]$Message){$script:checks++;if(!$Value){throw $Message}}
function Sample {
 $value=[AllmindWindowObservation]::new();$value.SessionKnown=$true;$value.SessionAvailable=$true;$value.GeometryKnown=$true;$value.Foreground=100;$value.Monitor=1;$value.PetMonitor=1;$value.WindowLeft=100;$value.WindowRight=1200;$value.WindowTop=500;$value.WindowBottom=900;$value.WorkLeft=0;$value.WorkRight=1920;$value.WorkTop=40;$value.WorkBottom=1040;return $value
}
$o=Sample;$point=[AllmindPerchPolicy]::Position($o,350,350,$false)
Check ($point[0]-eq 850 -and $point[1]-eq 150) 'Perch must put the body above the selected window without focus changes'
Check ($null-eq [AllmindPerchPolicy]::Position($o,350,350,$true)) 'Busy/drag/quiet must prevent movement'
foreach($field in @('SessionKnown','SessionAvailable','GeometryKnown')){$o=Sample;$o.$field=$false;Check ($null-eq [AllmindPerchPolicy]::Position($o,350,350,$false)) "Unknown $field must not move"}
foreach($field in @('Fullscreen','Presentation')){$o=Sample;$o.$field=$true;Check ($null-eq [AllmindPerchPolicy]::Position($o,350,350,$false)) "$field must not perch"}
$o=Sample;$o.WindowTop=100;Check ($null-eq [AllmindPerchPolicy]::Position($o,350,350,$false)) 'Insufficient upper edge room must not push content off screen'
$o=Sample;$o.PetMonitor=2;Check ($null-eq [AllmindPerchPolicy]::Position($o,350,350,$false)) 'Do not silently move across monitors'
$o=Sample;Check ($null-eq [AllmindPerchPolicy]::Position($o,0,350,$false)) 'Invalid pet geometry'
$o=Sample;$o.WindowRight=2000;$point=[AllmindPerchPolicy]::Position($o,350,350,$false);Check ($point[0]-eq 1570) 'Perch must clamp to the working area'
foreach($state in @('idle','walking','resting')){
 $motion=[AllmindPerchPolicy]::Motion($state,$true,$false);Check ($motion[2]-ge 350 -and [Math]::Abs($motion[0])-le 2 -and [Math]::Abs($motion[1])-le 2) 'Motion must remain small and not move windows'
 $motion=[AllmindPerchPolicy]::Motion($state,$false,$false);Check ($motion[0]-eq 0 -and $motion[1]-eq 0) 'Disabled autonomous motion must stop'
 $motion=[AllmindPerchPolicy]::Motion($state,$true,$true);Check ($motion[0]-eq 0 -and $motion[1]-eq 0) 'Hidden/quiet/drag/quick chat/reduced motion must stop animation'
}
$motion=[AllmindPerchPolicy]::Motion('unknown',$true,$false);Check ($motion[0]-eq 0 -and $motion[1]-eq 0) 'Unknown activity must not invent a pose'
Write-Output "PASS: $checks opt-in perch/motion policy assertions; no native pointer or keyboard input."
