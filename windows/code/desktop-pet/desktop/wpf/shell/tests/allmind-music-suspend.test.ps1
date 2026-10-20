param([string]$TestRoot=$PSScriptRoot)
$ErrorActionPreference='Stop';$script:appDir=Split-Path $TestRoot -Parent
. (Join-Path $script:appDir 'runtime/music.ps1')
. (Join-Path $script:appDir 'runtime/allmind-visibility.ps1')
Initialize-WidgetMusicTypes
Add-Type -TypeDefinition 'public static class AllmindMusicTest {public static void NoMove(int x,int y){}}'
$script:allmindMode=$true;$script:allmindMusicRequested=$true
$script:window=[Windows.Markup.XamlReader]::Parse([IO.File]::ReadAllText((Join-Path $script:appDir 'widget.xaml')))
$script:window.ShowActivated=$false;$script:window.ShowInTaskbar=$false;$script:window.Left=-5000;$script:window.Top=-5000
$girl=$script:window.FindName('Girl');$girl.Source=[Windows.Media.Imaging.BitmapImage]::new([Uri](Join-Path $script:appDir 'assets/gpt-dragon-niang-bust.png'))
$checks=0
function Check([bool]$Value,[string]$Label){if(!$Value){throw $Label};$script:checks++}
try{
 $script:window.Show();$script:window.UpdateLayout()
 $colors=[Windows.Media.Color[]]@([Windows.Media.Colors]::Cyan,[Windows.Media.Colors]::Green)
 $method=[AllmindMusicTest].GetMethod('NoMove');$move=[Delegate]::CreateDelegate([Action[int,int]],$method)
 $music=[GptMusicVisual]::new($script:window,$girl,$script:window.FindName('Bubble'),$move,$colors,$false);$script:widgetMusic=$music
 $binding=[Reflection.BindingFlags]'Instance,NonPublic'
 $wake=$music.GetType().GetField('wake',$binding).GetValue($music)
 $capture=$music.GetType().GetField('capture',$binding).GetValue($music)
 $worker=$capture.GetType().GetField('worker',$binding).GetValue($capture)
 Check ($wake.IsEnabled -and $music.Enabled) 'Real music runtime did not start'
 $script:window.Hide();Suspend-AllmindMusic
 Check ($null-eq $script:widgetMusic -and !$music.Enabled) 'Hide retained a live music visual'
 Check (!$wake.IsEnabled) 'Hide retained 16 ms wake timer'
 Check ($worker.Join(2000)) 'Hide retained audio analysis worker'
 Check ($script:allmindMusicRequested) 'Suspend lost user enabled intent'
 $status=Get-WidgetMusicStatus;Check ($status.enabled -and $status.suspended -and !$status.running) 'Suspended status misreported running'
 Set-WidgetMusicEnabled $false
 Check (!$script:allmindMusicRequested -and !(Get-WidgetMusicStatus).enabled) 'Explicit off lost to suspend intent'
 $script:allmindDecision=[pscustomobject]@{Visible=$true};Resume-AllmindMusic
 Check ($null-eq $script:widgetMusic) 'Resume reopened music after explicit off'
 Write-Output "PASS: $checks real WPF music suspend assertions; capture thread ended, wake stopped; no native input."
}finally{if($script:widgetMusic){Stop-WidgetMusic};$script:window.Close()}
