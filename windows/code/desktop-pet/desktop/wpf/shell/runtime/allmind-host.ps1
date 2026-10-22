# GPT-Niang WPF adapter. Models and persona data remain in the ALLMIND backend.
function Send-AllmindCommand([string]$Method,$Parameters=@{}) {
  if(!$script:allmindPipe -or !$script:allmindPipe.Connected){throw 'ALLMIND 后台连接尚未就绪。'}
  $request=@{version=1;id=[Guid]::NewGuid().ToString('N');method=$Method;params=$Parameters}
  $script:allmindPipe.Send(($request|ConvertTo-Json -Depth 8 -Compress))
}
function Update-AllmindLifeMotion {
 if(!$script:ui.LifeMotion -or !('AllmindPerchPolicy' -as [type])){return}
 $blocked=[bool]($script:allmindHidden -or $script:allmindQuiet -or $script:allmindFocus -or $script:drag -or $script:context.IsOpen -or ($script:allmindQuickChat -and $script:allmindQuickChat.Visible) -or ![Windows.SystemParameters]::ClientAreaAnimation)
 $key="$($script:allmindLifeActivity):$($script:allmindEnabled):$blocked";if($script:allmindLifeMotionKey-eq $key){return};$script:allmindLifeMotionKey=$key
 $values=[AllmindPerchPolicy]::Motion([string]$script:allmindLifeActivity,[bool]$script:allmindEnabled,$blocked)
 foreach($row in @(@{property=[Windows.Media.TranslateTransform]::XProperty;value=$values[0]},@{property=[Windows.Media.TranslateTransform]::YProperty;value=$values[1]})){
  $script:ui.LifeMotion.BeginAnimation($row.property,$null);$script:ui.LifeMotion.SetValue($row.property,[double]0)
  if($row.value-ne 0){$animation=[Windows.Media.Animation.DoubleAnimation]::new();$animation.From=0;$animation.To=$row.value;$animation.Duration=[Windows.Duration]::new([TimeSpan]::FromMilliseconds($values[2]));$animation.AutoReverse=$true;$animation.RepeatBehavior=[Windows.Media.Animation.RepeatBehavior]::Forever;$script:ui.LifeMotion.BeginAnimation($row.property,$animation)}
 }
}
function Invoke-AllmindMenu([string]$Method,$Parameters=@{}) {
  if($Method-eq 'visible'){try{Set-AllmindVisible ([bool]$Parameters.visible)}catch{Write-AllmindWindowError $_};return}
  if($Method-eq 'exit' -and $script:allmindVisibility){$script:allmindVisibility.Exiting=$true;Update-AllmindVisibility;Tick-Widget}
  try{Send-AllmindCommand $Method $Parameters}catch{$script:allmindStatus=$_.Exception.Message;if($script:allmindStatusItem){$script:allmindStatusItem.Header=$script:allmindStatus};if($Method-eq 'exit'){$script:allmindExiting=$true;$script:window.Close()}}
}
function Set-AllmindVisible([bool]$Visible){
 Update-AllmindVisibility -Force
 if($Visible){$script:allmindVisibility.ClickThrough=$false;if($script:allmindClickThroughItem){$script:allmindClickThroughItem.IsChecked=$false};$script:allmindVisibility.Show([AllmindVisibilityPolicy]::Now)}else{$script:allmindVisibility.Hide()}
 Save-AllmindVisibilityPreferences;$script:lastPosition=$null;Update-AllmindVisibility -Force;Tick-Widget
}
function Set-AllmindPortrait($Message){
 if($Message.characterId-ne $script:allmindRole){return}
 try{
  $image=Read-WidgetCharacterImage ([string]$Message.path)
  $alpha=[Windows.Media.Imaging.FormatConvertedBitmap]::new($image,[Windows.Media.PixelFormats]::Bgra32,$null,0);$alpha.Freeze()
  $stride=$image.PixelWidth*4;$pixels=New-Object byte[] ($stride*$image.PixelHeight);$alpha.CopyPixels($pixels,$stride,0)
  $script:allmindBodyFraction=[AllmindVisibilityPolicy]::AlphaCenter($pixels,$image.PixelWidth,$image.PixelHeight,$stride)
  $script:bitmap=$image;$script:alphaBitmap=$alpha;$script:alphaStride=$stride;$script:alphaPixels=$pixels;$script:ui.Girl.Source=$image
  $script:activeCharacter=[pscustomobject]@{id=$Message.characterId;name=$script:allmindLabel;path=$Message.path;kind='allmind'};$script:characterId=$Message.characterId
  if($script:widgetColors){foreach($overlay in @($script:widgetColors.halo,$script:widgetColors.tint)){if($overlay -and $overlay.OpacityMask){$overlay.OpacityMask.ImageSource=$image}}}
  $script:allmindSkin=$Message.skinId;Set-Appearance;Save-Settings
  Send-AllmindCommand 'appearance-result' @{requestId=$Message.requestId;characterId=$Message.characterId;ok=$true}
 }catch{
  $script:allmindStatus='形象载入失败：'+$_.Exception.Message
  [IO.File]::AppendAllText((Join-Path $script:dataDir 'appearance-error.log'),($_.Exception.ToString()+[Environment]::NewLine+$_.ScriptStackTrace+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
  Send-AllmindCommand 'appearance-result' @{requestId=$Message.requestId;characterId=$Message.characterId;ok=$false}
 }
}
function Show-AllmindReply([string]$Text,[long]$ReceivedAt){
 if($script:allmindQuickChat){$script:allmindQuickChat.RememberReply($script:allmindRole,$script:allmindQuickSession,$Text);if($script:allmindQuickChat.Visible){return}}
 Update-AllmindVisibility
 if(!$script:allmindNotificationAllowed -or !$script:allmindVisibility.ReplyReminder -or $ReceivedAt-le $script:allmindVisibleSince){return}
 Show-Quote
 $script:ui.QuoteText.Text=if($Text.Length-gt 180){$Text.Substring(0,180)+'…'}else{$Text};Fit-QuoteText
}
function Read-AllmindEvents {
 $line=$null;$count=0
 while($count-lt 64 -and $script:allmindPipe.TryRead([ref]$line)){
  $count++
  try{
   $value=$line|ConvertFrom-Json -ErrorAction Stop
   if($value.error){$script:allmindStatus=$value.error;if($script:allmindQuickChat -and $script:allmindQuickChat.Pending -and $value.id -and $value.id-eq $script:allmindQuickPipeId){$script:allmindQuickChat.Receive($script:allmindQuickChat.RequestId,$script:allmindQuickChat.CharacterId,$script:allmindQuickChat.SessionId,$false,[string]$value.error)};if(!$value.id){$script:allmindBackendReady=$false};continue}
   $message=$value.event;if(!$message){continue}
   switch($message.channel){
    'wpf_state' {
     if($script:allmindQuickChat -and ($script:allmindRole-ne $message.state.characterId -or $message.state.backend-ne 'ready')){$script:allmindQuickChat.Hide()}
     $script:allmindRole=$message.state.characterId;$script:allmindLabel=$message.state.characterLabel
     $script:allmindQuickSession=$message.state.sessionId
     $script:allmindBackendReady=$message.state.backend-eq 'ready'
     $script:allmindStatus=switch($message.state.backend){'ready'{'后台已连接'};'starting'{'后台启动中…'};default{[string]$message.state.error}}
     $script:window.Title='ALLMIND · '+$script:allmindLabel
     if($script:allmindRoleItem){$script:allmindRoleItem.Header=$script:allmindLabel}
    }
    'wpf_appearance' {Set-AllmindPortrait $message}
    'wpf_visible' {Set-AllmindVisible ([bool]$message.visible)}
    'wpf_shutdown' {$script:allmindExiting=$true;$script:allmindVisibility.Exiting=$true;Update-AllmindVisibility;$script:window.Close()}
    'wpf_error' {$script:allmindStatus=$message.message}
    'wpf_quick_chat' {
     if($script:allmindQuickChat -and $message.phase-ne 'pending'){$ok=$message.phase-eq 'completed';$text=if($ok){[string]$message.text}else{[string]$message.message};$script:allmindQuickChat.Receive([string]$message.turnId,[string]$message.characterId,[string]$message.sessionId,$ok,$text)}
    }
    'book_chat_notice' {
     if($message.scope.characterId-eq $script:allmindRole -and !$message.incognito){
      if($message.state-eq 'completed'){Show-AllmindReply ([string]$message.text) ([long]$message.hostReceivedAt)}
      $script:allmindStatus=switch($message.state){'pending'{'正在回复…'};'failed'{'本轮未完成，请在聊天页核对。'};default{'后台已连接'}}
     }
    }
    'companion_state' {if($message.state.characterId-eq $script:allmindRole){$script:allmindQuiet=[bool]$message.state.quiet;$script:allmindFocus=[bool]$message.focus;$script:allmindEnabled=[bool]$message.state.enabled;$script:allmindLifeActivity=[string]$message.state.activity;Update-AllmindLifeMotion}}
    'companion_offer' {Update-AllmindVisibility;if($message.characterId-eq $script:allmindRole -and $script:allmindNotificationAllowed){Send-AllmindCommand 'claim' @{id=$message.id;characterId=$message.characterId;sessionId=$message.sessionId}}}
    'companion_message' {if($message.characterId-eq $script:allmindRole){Show-AllmindReply ([string]$message.delivery.text) ([long]$message.hostReceivedAt)}}
   }
  }catch{$script:allmindStatus='宿主同步失败：'+$_.Exception.Message;[IO.File]::AppendAllText((Join-Path $script:dataDir 'host-sync-error.log'),($_.Exception.ToString()+[Environment]::NewLine+$_.ScriptStackTrace+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))}
 }
 if($script:allmindStatusItem){$script:allmindStatusItem.Header=$script:allmindStatus;if($script:allmindObserver.RegistrationError){$script:allmindStatusItem.Header+=if($script:allmindObserver.RegistrationError.StartsWith('hotkey-conflict')){' · 唤出热键被占用，可在“悬浮与显示”中更换'}else{' · 系统事件监听受限，正在低频检测'}}}
 if($script:allmindDndItem){$script:allmindDndItem.IsChecked=$script:allmindQuiet;$script:allmindActivityItem.IsChecked=$script:allmindEnabled}
 if($script:allmindTray){$label='ALLMIND · '+$script:allmindLabel;$script:allmindTray.Text=$label.Substring(0,[Math]::Min(63,$label.Length))}
 Update-AllmindVisibility;Publish-AllmindVisibility
}
function Initialize-AllmindHost {
 Add-Type -TypeDefinition @'
using System;using System.IO;using System.IO.Pipes;using System.Text;using System.Collections.Concurrent;using System.Threading.Tasks;
public sealed class AllmindPipe:IDisposable {
 readonly NamedPipeClientStream pipe;readonly ConcurrentQueue<string> messages=new ConcurrentQueue<string>();readonly object gate=new object();StreamWriter writer;volatile bool connected;volatile bool stopping;
 public bool Connected{get{return connected;}}
 public AllmindPipe(string name,string hello){pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous);Task.Run(()=>{try{pipe.Connect(10000);writer=new StreamWriter(pipe,new UTF8Encoding(false)){AutoFlush=true};var reader=new StreamReader(pipe,Encoding.UTF8);connected=true;Send(hello);while(!stopping){var line=reader.ReadLine();if(line==null)throw new IOException("Host EOF");if(line.Length>524288)throw new IOException("Host response too large");if(messages.Count>=512)throw new IOException("Host event queue overflow; pending events require reconciliation");messages.Enqueue(line);}}catch(Exception error){if(!stopping)messages.Enqueue("{\"error\":\"ALLMIND host disconnected ("+error.GetType().Name+"); check runtime log.\"}");}finally{connected=false;}});}
 public void Send(string line){lock(gate){if(!connected||stopping)throw new IOException("Host disconnected");writer.WriteLine(line);}}
 public bool TryRead(out string line){return messages.TryDequeue(out line);}
 public void Dispose(){stopping=true;connected=false;pipe.Dispose();}
}
'@
 $script:allmindRole=$null;$script:allmindLabel='ALLMIND';$script:allmindStatus='后台启动中…';$script:allmindHidden=$true;$script:allmindExiting=$false;$script:allmindQuiet=$false;$script:allmindEnabled=$false;$script:allmindBackendReady=$false
 $script:allmindFocus=$false;$script:allmindVisibleSince=[long]::MaxValue
 $hello=@{version=1;id=[Guid]::NewGuid().ToString('N');method='hello';client='widget';token=$script:config.token}|ConvertTo-Json -Compress
 $script:allmindPipe=[AllmindPipe]::new($script:config.pipeName,$hello)
 Add-Type -Path (Join-Path $script:appDir 'runtime/allmind-quick-chat.cs') -ReferencedAssemblies @('PresentationFramework','PresentationCore','WindowsBase','System.Xaml','System.Windows.Forms','System.Drawing')
 $script:allmindQuickSession='desktop'
 $script:allmindQuickChat=[AllmindQuickChat]::new($script:window,$script:ui.SceneText)
 $script:ui.Girl.ToolTip='点角色看回复；点气泡输入；拖动调整位置；右键打开管理'
 $script:allmindQuickChat.Add_DisplayChanged({
  $script:sceneDeadline=0
  if($script:sceneTimer){$script:sceneTimer.Stop()}
  if($script:closeTimer){$script:closeTimer.Stop()}
  if($script:resetPhaseTimer){$script:resetPhaseTimer.Stop()}
  $script:collapsed=!$script:allmindQuickChat.Visible
  if(!$script:collapsed){
   $script:bubbleMode='chat'
   $script:ui.QuotaText.Visibility=[Windows.Visibility]::Collapsed;$script:ui.QuoteText.Visibility=[Windows.Visibility]::Collapsed
   $script:ui.LiveDot.Visibility=[Windows.Visibility]::Collapsed
   $script:ui.Bubble.ToolTip=$null
  }
  $script:allmindQuickChat.ApplyLayout($script:ui.BubbleShape,$script:ui.Bubble)
  Set-BubbleState
 })
 $script:allmindQuickChat.Add_SendRequested({
  $chat=$script:allmindQuickChat
  try{
   $script:allmindQuickPipeId=[Guid]::NewGuid().ToString('N')
   $request=@{version=1;id=$script:allmindQuickPipeId;method='quick-chat';params=@{characterId=$chat.CharacterId;sessionId=$chat.SessionId;turnId=$chat.RequestId;text=$chat.RequestText}}
   $script:allmindPipe.Send(($request|ConvertTo-Json -Depth 6 -Compress))
  }catch{$chat.Receive($chat.RequestId,$chat.CharacterId,$chat.SessionId,$false,$_.Exception.Message)}
 })
 $script:allmindQuickChat.Add_OpenRequested({Invoke-AllmindMenu 'open' @{target='chat'}})
 $script:window.Add_IsVisibleChanged({if(!$script:window.IsVisible -and $script:allmindQuickChat){$script:allmindQuickChat.Hide()}})
 $keepAppearance=$script:settingsMenuUi.Appearance;$keepAudio=$script:settingsMenuUi.Audio;$keepMusic=$script:settingsMenuUi.MusicEnabled
 $script:context.Items.Clear()
 function Add-AllmindItem([string]$Label,[scriptblock]$Click,[switch]$Check){$item=[Windows.Controls.MenuItem]::new();$item.Header=$Label;$item.IsCheckable=[bool]$Check;$item.Add_Click($Click);$null=$script:context.Items.Add($item);return $item}
 $script:allmindRoleItem=Add-AllmindItem 'ALLMIND' {};$script:allmindRoleItem.IsEnabled=$false
 $script:allmindStatusItem=Add-AllmindItem '后台启动中…' {};$script:allmindStatusItem.IsEnabled=$false
 $null=Add-AllmindItem '聊天' {Invoke-AllmindMenu 'open' @{target='chat'}}
 $null=Add-AllmindItem '角色与外观' {Invoke-AllmindMenu 'open' @{target='character'}}
 $null=Add-AllmindItem '我们的回忆' {Invoke-AllmindMenu 'open' @{target='memory'}}
 $null=Add-AllmindItem '设置' {Invoke-AllmindMenu 'open' @{target='settings'}}
 $script:allmindDndItem=Add-AllmindItem '免打扰' {param($sender,$event)Invoke-AllmindMenu 'companion-action' @{characterId=$script:allmindRole;action='set_quiet';enabled=[bool]$sender.IsChecked}} -Check
 $script:allmindActivityItem=Add-AllmindItem '自主活动' {param($sender,$event)Invoke-AllmindMenu 'companion-action' @{characterId=$script:allmindRole;action='set_enabled';enabled=[bool]$sender.IsChecked}} -Check
 foreach($item in @($keepAppearance,$keepAudio,$keepMusic)){$null=$script:context.Items.Add($item)}
 $modeMenu=Add-AllmindItem '悬浮与显示' {};$script:allmindModeItems=@()
 $script:allmindPerchItem=Add-AllmindItem '坐到当前窗口上沿（只观察几何）' {param($sender,$event)$script:allmindPerchEnabled=[bool]$sender.IsChecked;Save-Settings;$script:lastPosition=$null;Update-AllmindVisibility -Force;Tick-Widget} -Check;$script:allmindPerchItem.IsChecked=[bool]$script:allmindPerchEnabled
 foreach($row in @(@{mode='smart';label='智能悬浮（全屏自动收起）'},@{mode='resident';label='常驻悬浮'},@{mode='normal';label='普通窗口层级'})){
  $item=[Windows.Controls.MenuItem]::new();$item.Header=$row.label;$item.Tag=$row.mode;$item.IsCheckable=$true;$item.Add_Click({param($sender,$event)Set-AllmindWindowMode $sender.Tag});$null=$modeMenu.Items.Add($item);$script:allmindModeItems+=$item
 }
 $clickThrough=[Windows.Controls.MenuItem]::new();$clickThrough.Header='鼠标完全穿透（从托盘恢复）';$clickThrough.IsCheckable=$true;$clickThrough.Add_Click({param($sender,$event)$script:allmindVisibility.ClickThrough=[bool]$sender.IsChecked;Save-AllmindVisibilityPreferences;Update-AllmindVisibility -Force;Tick-Widget});$null=$modeMenu.Items.Add($clickThrough)
 $script:allmindClickThroughItem=$clickThrough
 foreach($row in @(@{label='唤出热键：Ctrl+Alt+P';modifiers=0x4003;key=0x50},@{label='唤出热键：Ctrl+Alt+Shift+P';modifiers=0x4007;key=0x50},@{label='关闭唤出热键';modifiers=0;key=0})){
  $item=[Windows.Controls.MenuItem]::new();$item.Header=$row.label;$item.Tag=$row;$item.Add_Click({param($sender,$event)Set-AllmindHotkey $sender.Tag.modifiers $sender.Tag.key});$null=$modeMenu.Items.Add($item)
 }
 $reminder=Add-AllmindItem '回复完成提醒' {param($sender,$event)$script:allmindVisibility.ReplyReminder=[bool]$sender.IsChecked;Save-AllmindVisibilityPreferences} -Check
 $null=Add-AllmindItem '重新启动后台' {Invoke-AllmindMenu 'restart-backend'}
 $null=Add-AllmindItem '隐藏桌宠' {Invoke-AllmindMenu 'visible' @{visible=$false}}
 $null=Add-AllmindItem '退出 ALLMIND' {Invoke-AllmindMenu 'exit'}
 $tray=[Windows.Forms.NotifyIcon]::new();$tray.Icon=[Drawing.SystemIcons]::Application;$tray.Text='ALLMIND';$tray.Visible=$true;$script:allmindTray=$tray
 $menu=[Windows.Forms.ContextMenuStrip]::new()
 foreach($row in @(@{name='显示桌宠';method='visible';params=@{visible=$true}},@{name='聊天';method='open';params=@{target='chat'}},@{name='设置';method='open';params=@{target='settings'}},@{name='退出 ALLMIND';method='exit';params=@{}})){
  $item=$menu.Items.Add($row.name);$item.Tag=$row;$item.Add_Click({param($sender,$event)Invoke-AllmindMenu $sender.Tag.method $sender.Tag.params})
 }
 $tray.ContextMenuStrip=$menu;$tray.Add_DoubleClick({Invoke-AllmindMenu 'visible' @{visible=$true}})
 $script:allmindTimer=[Windows.Threading.DispatcherTimer]::new();$script:allmindTimer.Interval=[TimeSpan]::FromMilliseconds(100);$script:allmindTimer.Add_Tick({Read-AllmindEvents});$script:allmindTimer.Start()
 $script:window.Add_Closing({param($sender,$event)if(!$script:allmindExiting){$event.Cancel=$true;Set-AllmindVisible $false}})
 Initialize-AllmindVisibility $settings
 Set-MenuVisible $false
 [Windows.Automation.AutomationProperties]::SetHelpText($script:ui.Girl,'单击打开头顶聊天框；Enter 发送，Shift+Enter 换行；拖动调整位置；右键打开角色与设置。')
 foreach($item in $script:allmindModeItems){$item.IsChecked=$item.Tag-eq $script:allmindVisibility.Mode};$clickThrough.IsChecked=$script:allmindVisibility.ClickThrough;$reminder.IsChecked=$script:allmindVisibility.ReplyReminder
}
function Stop-AllmindHost {
 if($script:allmindQuickChat){$script:allmindQuickChat.Dispose()}
 if($script:allmindPolicyTimer){$script:allmindPolicyTimer.Stop()}
 if($script:allmindObserver){$script:allmindObserver.Dispose()}
 if($script:allmindTimer){$script:allmindTimer.Stop()}
 if($script:allmindTray){$script:allmindTray.Visible=$false;$script:allmindTray.Dispose()}
 if($script:allmindPipe){$script:allmindPipe.Dispose()}
}

