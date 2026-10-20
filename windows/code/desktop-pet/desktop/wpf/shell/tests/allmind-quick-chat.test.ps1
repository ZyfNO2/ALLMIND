param([string]$TestRoot=$PSScriptRoot)
$ErrorActionPreference='Stop'
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
 Write-Output "PASS: $script:checks native WPF quick-chat component assertions; no real mouse/keyboard input."
}finally{if($chat){$chat.Dispose()};$owner.Close()}
