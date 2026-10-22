$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Xaml,System.Windows.Forms,System.Drawing
$source=Join-Path $PSScriptRoot '../../desktop/wpf/shell/runtime/allmind-quick-chat.cs'
Add-Type -Path $source -ReferencedAssemblies @('PresentationFramework','PresentationCore','WindowsBase','System.Xaml','System.Windows.Forms','System.Drawing')
# Compile the production component and call its pure timer policy. No Window is
# constructed, no input is injected, and no native Computer Use is resumed.
$now=[DateTime]::UtcNow;$past=$now.AddSeconds(-1);$future=$now.AddSeconds(1);$checks=0
function Check([bool]$value,[string]$name){if(!$value){throw $name};$script:checks++}
Check (![AllmindQuickChat]::ShouldHide($now,$past,$false,$true,$false,$true)) 'active IME preedit survives expiry before text is committed'
Check (![AllmindQuickChat]::ShouldHide($now,$past,$false,$true,$true,$false)) 'focused committed draft survives expiry'
Check ([AllmindQuickChat]::ShouldHide($now,$past,$false,$false,$false,$true)) 'stale composition flag without focus cannot keep bubble forever'
Check ([AllmindQuickChat]::ShouldHide($now,$past,$false,$true,$false,$false)) 'empty idle editor keeps existing timeout behavior'
Check (![AllmindQuickChat]::ShouldHide($now,$past,$true,$false,$false,$false)) 'pending reply remains visible'
Check (![AllmindQuickChat]::ShouldHide($now,$future,$false,$false,$false,$false)) 'no hiding before deadline'
Check ([AllmindQuickChat]::ShouldHide($now,$past,$false,$false,$false)) 'legacy five-argument idle policy remains available'
Check (![AllmindQuickChat]::ShouldHide($now,$past,$false,$true,$true)) 'legacy five-argument draft policy remains available'
@{status='PASS';checks=$checks;nativeInput='NOT_RUN';windowsCreated=0}|ConvertTo-Json -Compress
