param([string]$TestRoot=$PSScriptRoot)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationCore,WindowsBase,System
. ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path (Split-Path $TestRoot -Parent) 'runtime/audio.ps1'),[Text.Encoding]::UTF8)))
Add-Type -TypeDefinition @'
using System;using System.Media;using System.Threading;using System.Collections.Concurrent;
public static class ClickSequenceProbe {
 public static SoundPlayer Press;
 public static bool FailPress;
 public static readonly ManualResetEvent PressStarted=new ManualResetEvent(false),ReleaseStarted=new ManualResetEvent(false),AllowPress=new ManualResetEvent(false),AllowRelease=new ManualResetEvent(false);
 public static readonly ConcurrentQueue<string> Trace=new ConcurrentQueue<string>();
 public static void Reset(){string ignored;while(Trace.TryDequeue(out ignored)){}PressStarted.Reset();ReleaseStarted.Reset();AllowPress.Reset();AllowRelease.Reset();FailPress=false;}
 public static void Play(SoundPlayer player){
  bool press=Object.ReferenceEquals(player,Press);Trace.Enqueue(press?"press-start":"release-start");
  if(press&&FailPress)throw new InvalidOperationException("test playback failure");
  (press?PressStarted:ReleaseStarted).Set();
  if(!(press?AllowPress:AllowRelease).WaitOne(3000))throw new TimeoutException("test gate not released");
  Trace.Enqueue(press?"press-end":"release-end");
 }
 public static void Stop(SoundPlayer player){AllowPress.Set();AllowRelease.Set();}
}
'@
$script:checks=0
function Check([bool]$value,[string]$label){if(!$value){throw $label};$script:checks++}
function Wait-Idle($Queue){$clock=[Diagnostics.Stopwatch]::StartNew();while($Queue.Busy -and $clock.ElapsedMilliseconds-lt 2000){[Threading.Thread]::Sleep(1)};Check (!$Queue.Busy) 'audio sequence did not finish'}
$play=[Delegate]::CreateDelegate([Action[System.Media.SoundPlayer]],[ClickSequenceProbe].GetMethod('Play'))
$stop=[Delegate]::CreateDelegate([Action[System.Media.SoundPlayer]],[ClickSequenceProbe].GetMethod('Stop'))
$press=[Media.SoundPlayer]::new();$release=[Media.SoundPlayer]::new();$queue=$null
try{
 $script:allmindMode=$true;$script:allmindBackendReady=$true;$script:allmindHidden=$false;$script:allmindQuiet=$false;$script:allmindFocus=$false;$script:allmindDecision=[pscustomobject]@{ClickThrough=$false};$script:allmindNotificationAllowed=$false
 Check (Test-WidgetClickAudioAllowed) 'interaction notification suppression muted explicit click audio'
 $script:allmindQuiet=$true;Check (!(Test-WidgetClickAudioAllowed)) 'DND did not suppress click audio';$script:allmindQuiet=$false
 $script:allmindFocus=$true;Check (!(Test-WidgetClickAudioAllowed)) 'focus mode did not suppress click audio';$script:allmindFocus=$false
 $script:allmindHidden=$true;Check (!(Test-WidgetClickAudioAllowed)) 'hidden pet allowed audio';$script:allmindHidden=$false
 $script:allmindDecision.ClickThrough=$true;Check (!(Test-WidgetClickAudioAllowed)) 'click-through pet allowed audio';$script:allmindDecision.ClickThrough=$false
 $script:allmindBackendReady=$false;Check (!(Test-WidgetClickAudioAllowed)) 'disconnected host allowed audio';$script:allmindMode=$false
 [ClickSequenceProbe]::Press=$press;[ClickSequenceProbe]::Reset()
 $queue=[GptClickAudioQueue]::new($play,$stop)
 Check ($queue.Press($press,$release)) 'first press rejected';$queue.Release($press,$release)
 Check ([ClickSequenceProbe]::PressStarted.WaitOne(1000)) 'press did not start'
 Check (![ClickSequenceProbe]::ReleaseStarted.WaitOne(30)) 'release interrupted delayed press'
 for($i=0;$i-lt 120;$i++){Check (!$queue.Press($press,$release)) 'rapid press interrupted active sequence'}
 [ClickSequenceProbe]::AllowPress.Set()|Out-Null
 Check ([ClickSequenceProbe]::ReleaseStarted.WaitOne(1000)) 'release did not follow completed press'
 Check (!$queue.Press($press,$release)) 'new press interrupted release'
 [ClickSequenceProbe]::AllowRelease.Set()|Out-Null;Wait-Idle $queue
 Check (([ClickSequenceProbe]::Trace.ToArray()-join ',')-eq 'press-start,press-end,release-start,release-end') 'clips were truncated, duplicated or reordered'
 Check ($queue.Press($press,$release)) 'ordinary click after rapid burst rejected';$queue.Release($press,$release);Wait-Idle $queue
 Check ([ClickSequenceProbe]::Trace.Count-eq 8) 'rapid burst accumulated stale sounds'
 $queue.Dispose();$queue.Wait(1000);[ClickSequenceProbe]::Reset()
 $queue=[GptClickAudioQueue]::new($play,$stop);Check ($queue.Press($press,$release)) 'cancel setup rejected';$queue.Release($press,$release)
 Check ([ClickSequenceProbe]::PressStarted.WaitOne(1000)) 'cancel setup did not play'
 $clock=[Diagnostics.Stopwatch]::StartNew();$queue.Stop($press,$release);Check ($clock.ElapsedMilliseconds-lt 100) 'stop blocked caller'
 Wait-Idle $queue;$queue.Dispose();$queue.Wait(1000)
 Check (![ClickSequenceProbe]::ReleaseStarted.WaitOne(0)) 'cancelled release still played'
 [ClickSequenceProbe]::Reset();[ClickSequenceProbe]::FailPress=$true
 $queue=[GptClickAudioQueue]::new($play,$stop);Check ($queue.Press($press,$release)) 'error setup rejected';$queue.Release($press,$release);Wait-Idle $queue
 Check ($queue.LastError-match 'test playback failure') 'worker swallowed playback error'
 $queue.Dispose();$queue.Wait(1000);Check (![ClickSequenceProbe]::ReleaseStarted.WaitOne(0)) 'release played after failed press'
 [ClickSequenceProbe]::Reset();[ClickSequenceProbe]::AllowRelease.Set()|Out-Null
 $queue=[GptClickAudioQueue]::new($play,$stop);Check ($queue.Press($null,$release)) 'release-only gesture rejected';$queue.Release($null,$release);Wait-Idle $queue
 Check (([ClickSequenceProbe]::Trace.ToArray()-join ',')-eq 'release-start,release-end') 'release-only clip failed'
 Write-Output "PASS: $script:checks sound sequence assertions; controlled delayed playback, no audible user input."
}finally{[ClickSequenceProbe]::AllowPress.Set()|Out-Null;[ClickSequenceProbe]::AllowRelease.Set()|Out-Null;if($queue){$queue.Dispose();$queue.Wait(1000)};$press.Dispose();$release.Dispose()}
