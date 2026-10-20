param([string]$TestRoot=$PSScriptRoot)
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path $TestRoot -Parent) 'runtime/allmind-host.ps1')
function Update-AllmindVisibility {}
function Show-Quote {$script:shown++}
function Fit-QuoteText {}
$script:allmindNotificationAllowed=$true;$script:allmindVisibility=[pscustomobject]@{ReplyReminder=$true};$script:allmindVisibleSince=100
$script:ui=@{QuoteText=[pscustomobject]@{Text=''}};$script:shown=0
Show-AllmindReply 'arrived while hidden' 99
if($script:shown-ne 0){throw 'A queued hidden reply replayed after reveal'}
Show-AllmindReply 'same timestamp, conservative suppression' 100
if($script:shown-ne 0){throw 'Ambiguous boundary replayed'}
Show-AllmindReply 'fresh visible reply' 101
if($script:shown-ne 1 -or $script:ui.QuoteText.Text-ne 'fresh visible reply'){throw 'Fresh visible reply was lost'}
$script:allmindNotificationAllowed=$false;Show-AllmindReply 'DND or hidden reply' 102
if($script:shown-ne 1){throw 'Suppressed reply displayed'}
$script:allmindNotificationAllowed=$true;$script:allmindVisibility.ReplyReminder=$false;Show-AllmindReply 'reminders disabled' 103
if($script:shown-ne 1){throw 'Disabled reminder displayed'}
Write-Output 'PASS: 5 notification gating assertions; late queued replies do not replay after reveal.'
