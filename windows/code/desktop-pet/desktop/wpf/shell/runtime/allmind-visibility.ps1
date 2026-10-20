# Window policy integration. Only loaded by the independent ALLMIND host.
function Save-AllmindVisibilityPreferences {
 $p=$script:allmindVisibility
 Write-WidgetJson $script:allmindVisibilityFile @{version=1;mode=$p.Mode;manualHidden=$p.ManualHidden;clickThrough=$p.ClickThrough;hotkeyModifiers=$p.HotkeyModifiers;hotkeyKey=$p.HotkeyKey;replyReminder=$p.ReplyReminder}
}
function Read-AllmindVisibilityPreferences([string]$Path,$LegacySettings) {
 $p=[AllmindVisibilityPolicy]::new()
 if(Test-Path -LiteralPath $Path){
  $saved=Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  $keyInteger=$saved.hotkeyKey-is [int] -or $saved.hotkeyKey-is [long];$modifierInteger=$saved.hotkeyModifiers-is [int] -or $saved.hotkeyModifiers-is [long]
  if($saved.version-ne 1 -or @('smart','resident','normal')-notcontains $saved.mode -or $saved.manualHidden-isnot [bool] -or $saved.clickThrough-isnot [bool] -or $saved.replyReminder-isnot [bool] -or !$keyInteger -or !$modifierInteger -or $saved.hotkeyKey-lt 0 -or $saved.hotkeyKey-gt 254 -or ($saved.hotkeyModifiers-band (-bnot 0x400F))-ne 0){throw 'ALLMIND 窗口偏好无效；已保留原文件，请核对 visibility.json。'}
  $p.Mode=$saved.mode;$p.ManualHidden=$saved.manualHidden;$p.ClickThrough=$saved.clickThrough;$p.HotkeyKey=$saved.hotkeyKey;$p.HotkeyModifiers=$saved.hotkeyModifiers;$p.ReplyReminder=$saved.replyReminder
 }elseif($LegacySettings.desktopTopmost-is [bool]){$p.Mode=if($LegacySettings.desktopTopmost){'resident'}else{'normal'}}
 return $p
}
function Initialize-AllmindVisibility($LegacySettings) {
 if(!('AllmindVisibilityPolicy' -as [type])){Add-Type -Path @((Join-Path $script:appDir 'runtime/allmind-visibility.cs'),(Join-Path $script:appDir 'runtime/allmind-window-observer.cs'))}
 $script:allmindVisibilityFile=Join-Path $script:dataDir 'visibility.json'
 $script:allmindVisibility=Read-AllmindVisibilityPreferences $script:allmindVisibilityFile $LegacySettings
 Save-AllmindVisibilityPreferences
 $script:allmindObserver=[AllmindWindowObserver]::new($script:widgetHandle)
 $null=$script:allmindObserver.ConfigureHotkey($script:allmindVisibility.HotkeyModifiers,$script:allmindVisibility.HotkeyKey)
 $script:allmindLastSample=-1000;$script:allmindLastRevision=-1;$script:allmindLastPresence=$null;$script:allmindLastCenter=$null;$script:allmindAppliedVisible=$null
 $script:allmindPolicyTimer=[Windows.Threading.DispatcherTimer]::new();$script:allmindPolicyTimer.Interval=[TimeSpan]::FromMilliseconds(100)
 $script:allmindPolicyTimer.Add_Tick({try{$before=$script:allmindLastRevision;Update-AllmindVisibility;if($before-ne $script:allmindLastRevision){Tick-Widget}}catch{Write-AllmindWindowError $_}})
 $script:allmindPolicyTimer.Start()
}
function Write-AllmindWindowError($Failure) {
 $script:allmindStatus='窗口策略失败：'+$Failure.Exception.Message
 [IO.File]::AppendAllText((Join-Path $script:dataDir 'visibility-error.log'),($Failure.Exception.ToString()+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
 # Never leave an unobserved overlay on top after a policy failure.
 $script:allmindHidden=$true;$script:allmindNotificationAllowed=$false
 if($script:window.IsVisible){Hide-Quota;Stop-WidgetAudio;$script:window.Hide()}
}
function Get-AllmindBodyCenter {
 if($script:window.IsVisible -and $script:ui.Girl.ActualWidth-gt 0){
  $fraction=if($script:allmindBodyFraction){$script:allmindBodyFraction}else{@(0.5,0.5)}
  $fit=[Math]::Min($script:ui.Girl.ActualWidth/$script:bitmap.PixelWidth,$script:ui.Girl.ActualHeight/$script:bitmap.PixelHeight)
  $point=[Windows.Point]::new(($script:ui.Girl.ActualWidth-$script:bitmap.PixelWidth*$fit)/2+$fraction[0]*$script:bitmap.PixelWidth*$fit,($script:ui.Girl.ActualHeight-$script:bitmap.PixelHeight*$fit)/2+$fraction[1]*$script:bitmap.PixelHeight*$fit)
  $pixel=$script:ui.Girl.PointToScreen($point);return @([int]$pixel.X,[int]$pixel.Y)
 }
 if($script:allmindBodyCenter){return $script:allmindBodyCenter}
 $frame=Get-WidgetPlacementFrame
 if($null-ne $script:desktopLeft){return @([int]($script:desktopLeft+$script:designWidth*$script:displayScale/2),[int]($script:desktopTop+$script:designHeight*$script:displayScale/2))}
 return @([int]($frame.Right-100),[int]($frame.Bottom-100))
}
function Update-AllmindVisibility([switch]$Force) {
 if(!$script:allmindObserver){return}
 $now=[AllmindVisibilityPolicy]::Now;$center=Get-AllmindBodyCenter;$script:allmindBodyCenter=$center;$centerKey="$($center[0]):$($center[1])"
 if($Force -or $script:allmindObserver.Dirty -or $now-$script:allmindLastSample-ge 1000 -or $script:allmindLastCenter-ne $centerKey){
  $script:allmindObservation=$script:allmindObserver.Sample($center[0],$center[1]);$script:allmindLastSample=$now;$script:allmindLastCenter=$centerKey
 }
 $busy=[bool](($script:allmindQuickChat -and $script:allmindQuickChat.Visible) -or $script:drag -or $script:context.IsOpen -or $script:settingsSizePreview -or ($script:characterGallery -and $script:characterGallery.IsVisible))
 $connected=[bool]($script:allmindPipe -and $script:allmindPipe.Connected -and $script:allmindBackendReady)
 $decision=$script:allmindVisibility.Evaluate($script:allmindObservation,$now,$busy,($script:allmindQuiet -or $script:allmindFocus),$connected)
 $script:allmindDecision=$decision;$script:allmindHidden=!$decision.Visible;$script:allmindNotificationAllowed=$decision.NotificationAllowed;$script:desktopTopmost=$decision.Topmost
 $script:allmindPolicyTimer.Interval=[TimeSpan]::FromMilliseconds([Math]::Min(100,$script:allmindVisibility.DelayUntilTransition($now)))
 if($decision.Revision-ne $script:allmindLastRevision){
  $script:allmindLastRevision=$decision.Revision
  if($decision.ClickThrough -and $script:allmindQuickChat){$script:allmindQuickChat.Hide()}
  if(!$decision.NotificationAllowed){if(!$script:allmindQuickChat -or !$script:allmindQuickChat.Visible){Hide-Quota};Stop-WidgetAudio}
  if(!$decision.Visible){
   if($script:drag){$control=$script:drag.control;$script:drag=$null;if($control){$control.ReleaseMouseCapture()};Animate-Press $false}
   $script:context.IsOpen=$false;Suspend-AllmindMusic
   foreach($timer in @($script:sceneTimer,$script:resetPhaseTimer,$script:closeTimer,$script:menuTimer)){if($timer){$timer.Stop()}}
   $script:ui.PressScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty,$null);$script:ui.PressScale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty,$null);$script:ui.PressScale.ScaleX=1;$script:ui.PressScale.ScaleY=1
  }
  $ex=[GptWidgetNative]::GetWindowLongPtr($script:widgetHandle,-20).ToInt64()
  $newEx=if($decision.ClickThrough){$ex-bor 0x20}else{$ex-band (-bnot 0x20)}
  if($newEx-ne $ex){[GptWidgetNative]::SetWindowLongPtr($script:widgetHandle,-20,[IntPtr]$newEx)|Out-Null}
 }
}
function Publish-AllmindVisibility {
 if(!$script:allmindDecision){return}
 $d=$script:allmindDecision;$effective=[bool]($d.Visible -and $script:window.IsVisible)
 $actualTopmost=[GptWidgetZOrderNative]::Topmost($script:widgetHandle)
 $snapshot=@{revision=$d.Revision;state=$d.State;mode=$d.Mode;manualHidden=$d.ManualHidden;visible=$effective;reasons=@($d.Reasons);topmost=$actualTopmost;notificationAllowed=($effective -and $d.NotificationAllowed);detectorError=$script:allmindObservation.Error;registrationError=$script:allmindObserver.RegistrationError;hotkeyRegistered=$script:allmindObserver.HotkeyRegistered;musicRequested=[bool]$script:allmindMusicRequested;musicRunning=[bool]$script:widgetMusic}
 $key=($snapshot|ConvertTo-Json -Compress)
 if($script:allmindPipe.Connected -and $key-ne $script:allmindLastPresence){
  Send-AllmindCommand 'presence' @{hidden=!$effective;dnd=(!$d.NotificationAllowed -or $script:allmindQuiet);visibility=$snapshot}
  $script:allmindLastPresence=$key
 }
 if($key-ne $script:allmindLastDiagnostic){Write-WidgetJson (Join-Path $script:dataDir 'visibility-state.json') $snapshot;$script:allmindLastDiagnostic=$key}
 $script:allmindTimer.Interval=[TimeSpan]::FromMilliseconds($(if($effective){100}else{300}))
}
function Set-AllmindWindowMode([string]$Mode) {
 if(@('smart','resident','normal')-notcontains $Mode){throw '无效的悬浮模式。'}
 $script:allmindVisibility.Mode=$Mode;Save-AllmindVisibilityPreferences;Update-AllmindVisibility -Force;Tick-Widget
 foreach($item in $script:allmindModeItems){$item.IsChecked=$item.Tag-eq $Mode}
}
function Set-AllmindHotkey([int]$Modifiers,[int]$Key) {
 $p=$script:allmindVisibility;$p.HotkeyModifiers=$Modifiers;$p.HotkeyKey=$Key;Save-AllmindVisibilityPreferences
 if(!$script:allmindObserver.ConfigureHotkey($Modifiers,$Key)){$script:allmindStatus='唤出热键已被占用，请换一个组合；托盘仍可显示桌宠。'}
 Publish-AllmindVisibility
}
function Suspend-AllmindMusic {
 if($script:widgetMusic){$requested=$script:allmindMusicRequested;Stop-WidgetMusic;$script:allmindMusicRequested=$requested}
}
function Resume-AllmindMusic {
 if($script:allmindMusicRequested -and !$script:widgetMusic -and !$script:allmindMusicResuming -and $script:allmindDecision.Visible){
  $script:allmindMusicResuming=$true
  try{Set-WidgetMusicEnabled $true}finally{$script:allmindMusicResuming=$false}
 }
}
