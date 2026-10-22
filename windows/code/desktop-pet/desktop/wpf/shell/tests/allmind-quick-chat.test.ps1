param([string]$TestRoot=$PSScriptRoot)
$ErrorActionPreference='Stop'
$OutputDirectory=$env:ALLMIND_BUBBLE_RENDER_OUTPUT
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Xaml,System.Windows.Forms,System.Drawing
Add-Type -Path (Join-Path (Split-Path $TestRoot -Parent) 'runtime/allmind-quick-chat.cs') -ReferencedAssemblies @('PresentationFramework','PresentationCore','WindowsBase','System.Xaml','System.Windows.Forms','System.Drawing')
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class QuickChatNativeTest {
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Get(IntPtr h,int i);
 [DllImport("user32.dll",EntryPoint="SetWindowLongPtrW")] public static extern IntPtr Set(IntPtr h,int i,IntPtr v);
}
'@
$script:checks=0;function Check([bool]$value,[string]$label){if(!$value){throw $label};$script:checks++}
$owner=[Windows.Window]::new();$owner.ShowInTaskbar=$false;$owner.Width=200;$owner.Height=200;$owner.Left=50;$owner.Top=400;$owner.ShowActivated=$false
$chat=$null
try{
 $scene=[Windows.Controls.Grid]::new();$scene.Width=184;$scene.Height=112;$owner.Content=$scene;$owner.Show();$chat=[AllmindQuickChat]::new($owner,$scene);$script:sends=0;$chat.Add_SendRequested({$script:sends++})
 $chat.Show('role-a','测试角色','desktop');Check $chat.Visible 'click entry must show embedded reply bubble';Check ($chat.CharacterId-eq 'role-a') 'scope character';Check ($chat.SessionId-eq 'desktop') 'scope session'
 Check (!$chat.Editing) 'first click shows reply, not input';Check ($chat.Window-eq $owner) 'reuses pet HWND';Check ($scene.Children.Count-eq 1) 'content embedded in bubble'
 $hwnd=[Windows.Interop.WindowInteropHelper]::new($owner).Handle;$style=[QuickChatNativeTest]::Get($hwnd,-20).ToInt64();[QuickChatNativeTest]::Set($hwnd,-20,[IntPtr]($style-bor 0x08000000))|Out-Null
 $chat.Edit();Check $chat.Editing 'bubble click switches to input';Check (([QuickChatNativeTest]::Get($hwnd,-20).ToInt64()-band 0x08000000)-eq 0) 'input clears pet no-activate style';Check $chat.Input.IsKeyboardFocusWithin 'embedded input receives keyboard focus'
 $chat.Input.Text='hello';$chat.Submit();$id=$chat.RequestId;Check $chat.Pending 'pending state';Check (!$chat.Editing) 'pending returns to reply bubble';Check (([QuickChatNativeTest]::Get($hwnd,-20).ToInt64()-band 0x08000000)-ne 0) 'reply restores passive pet style';Check (!$chat.SendButton.IsEnabled) 'disable double send';$chat.Submit();Check ($script:sends-eq 1) 'double submit ignored'
 $chat.Receive($id,'other-role','desktop',$true,'wrong');Check $chat.Pending 'reject late reply for other role'
 $chat.Receive($id,'role-a','desktop',$false,'explicit failure');Check (!$chat.Pending) 'failure ends busy';Check ($chat.Input.Text-eq 'hello') 'failure preserves input';$chat.Submit();Check ($chat.RequestId-eq $id) 'same text retry reuses turn id'
 $chat.Hide();$chat.Receive($id,'role-a','desktop',$true,'reply');Check (!$chat.Visible) 'late result must not reveal hidden window';Check ($chat.Reply.Text-eq 'reply') 'reply stored for next reveal';Check ($chat.Input.Text-eq '') 'clear only successfully sent input'
 $chat.Show('role-a','测试角色','desktop');Check $chat.Visible 'can reveal again';Check (!$chat.Editing) 'reopen shows reply';Check ($chat.Reply.Text-eq 'reply') 'reopen retains response';$chat.Edit();$chat.ShowReply();Check (!$chat.Editing) 'escape returns to reply';$chat.Input.Text='draft-a';$chat.Show('role-b','另一角色','desktop');Check ($chat.Input.Text-eq '') 'no cross-role draft';Check ($chat.Reply.Text-eq '我在，想聊点什么？') 'new role shows greeting without previous reply';$chat.Show('role-a','测试角色','desktop');Check ($chat.Input.Text-eq 'draft-a') 'restore per-role draft'
 $now=[DateTime]::UtcNow;Check ([AllmindQuickChat]::ShouldHide($now,$now.AddSeconds(-1),$false,$false,$false)) 'idle closes';Check (![AllmindQuickChat]::ShouldHide($now,$now.AddSeconds(-1),$true,$false,$false)) 'pending stays';Check (![AllmindQuickChat]::ShouldHide($now,$now.AddSeconds(-1),$false,$true,$true)) 'focused draft stays';Check (![AllmindQuickChat]::ShouldHide($now,$now.AddSeconds(1),$false,$false,$false)) 'does not close before deadline'
 $chat.RememberReply('role-a','desktop','latest reply');Check ($chat.Reply.Text-eq 'latest reply') 'management reply updates bubble';$chat.Hide();Check $owner.IsVisible 'closing bubble keeps pet visible'
 $chat.SetReply('短回复');$smallWidth=$chat.ContentWidth;$smallHeight=$chat.ContentHeight
 $chat.SetReply(('自然聊天内容，'*7));Check ($chat.ContentWidth-gt $smallWidth) 'medium text widens bubble';Check ($chat.ContentHeight-gt $smallHeight) 'medium text grows bubble'
 $full=('这是一条保留完整语义的较长回复。'*60);$chat.SetReply($full);Check $chat.HasMore 'long text exposes full-chat action';Check ($chat.FullReply-eq $full) 'full long reply preserved';Check ($chat.Reply.Text.Length-lt $full.Length) 'bubble only displays preview';Check ($chat.ExpandButton.Visibility-eq [Windows.Visibility]::Visible) 'full reply action visible';Check ($chat.ContentWidth-le 232 -and $chat.ContentHeight-le 132) 'growth bounded by original pet canvas'
 $chat.SetReply(('😀'*200));Check $chat.HasMore 'emoji overflow has expand';Check (!$chat.Reply.Text.Contains([char]0xFFFD)) 'no broken Unicode preview'
 $chat.SetReply('恢复短回复');Check (!$chat.HasMore) 'short reply clears overflow';Check ($chat.ContentWidth-eq $smallWidth) 'short reply returns compact size';Check ($chat.ExpandButton.Visibility-eq [Windows.Visibility]::Collapsed) 'short reply hides expand action'
 $visual=$null;$visualChat=$null
 try{
  $visual=[Windows.Markup.XamlReader]::Parse([IO.File]::ReadAllText((Join-Path (Split-Path $TestRoot -Parent) 'widget.xaml')))
  $bubble=$visual.FindName('Bubble');$shape=$visual.FindName('BubbleShape');$visualScene=$visual.FindName('SceneText');$original=$shape.Data.ToString([Globalization.CultureInfo]::InvariantCulture)
  foreach($name in @('QuotaText','QuoteText','LiveDot')){$visual.FindName($name).Visibility=[Windows.Visibility]::Collapsed}
  $visualChat=[AllmindQuickChat]::new($visual,$visualScene)
  $visualChat.Add_DisplayChanged({$visualChat.ApplyLayout($shape,$bubble)})
  $visualChat.Show('role-render','合成排版','desktop')
  $culture=[Threading.Thread]::CurrentThread.CurrentCulture
  try{[Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo('fr-FR');$visualChat.SetReply(('需要先确认事情的来龙去脉，再给出简单建议。'*12))}finally{[Threading.Thread]::CurrentThread.CurrentCulture=$culture}
  Check ($visualScene.Width-eq 232 -and $visualScene.Height-eq 132) 'production layout applies large content size'
  Check ([Windows.Controls.Canvas]::GetTop($bubble)-eq -16) 'large bubble moves within existing canvas'
  Check ($shape.Data.Bounds.Width-gt 280) 'production outline grows with content'
  $script:opens=0;$visualChat.Add_OpenRequested({$script:opens++})
  $visualChat.ExpandButton.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
  Check ($script:opens-eq 1) 'expand dispatches full chat action'
  if($OutputDirectory){
   $null=[IO.Directory]::CreateDirectory($OutputDirectory)
   $visual.Width=378;$visual.Height=378;$visual.ShowInTaskbar=$false;$visual.ShowActivated=$false;$visual.Left=50;$visual.Top=400;$visual.Show()
   foreach($mode in @('overflow','input','short')){
    if($mode-eq 'input'){$visualChat.Edit();$visualChat.Input.Text='今天有点累，陪我说几句。'}
    if($mode-eq 'short'){$visualChat.SetReply('忙了一天，先休息一会儿。我在这里。');$visualChat.ShowReply()}
    $visual.Measure([Windows.Size]::new(378,378));$visual.Arrange([Windows.Rect]::new(0,0,378,378));$visual.UpdateLayout()
    $bitmap=[Windows.Media.Imaging.RenderTargetBitmap]::new(378,378,96,96,[Windows.Media.PixelFormats]::Pbgra32);$bitmap.Render($visual.Content)
    $encoder=[Windows.Media.Imaging.PngBitmapEncoder]::new();$encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream=[IO.File]::Create((Join-Path $OutputDirectory ($mode+'.png')));try{$encoder.Save($stream)}finally{$stream.Dispose()}
   }
  }
  $visualChat.Hide();Check ($shape.Data.ToString([Globalization.CultureInfo]::InvariantCulture)-eq $original) 'hide restores quota outline'
  Check ($visualScene.Width-eq 184 -and $visualScene.Height-eq 115) 'hide restores quota content layout'
 }finally{if($visualChat){$visualChat.Dispose()};if($visual){$visual.Close()}}
 Write-Output "PASS: $script:checks native WPF quick-chat component assertions; no real mouse/keyboard input."
}finally{if($chat){$chat.Dispose()};$owner.Close()}
