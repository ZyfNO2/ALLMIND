$ErrorActionPreference='Stop'
$appDir=Split-Path $PSScriptRoot -Parent
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$assembly=Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\System.Management.Automation\v4.0_3.0.0.0__31bf3856ad364e35\System.Management.Automation.dll'
if(!(Test-Path -LiteralPath $compiler) -or !(Test-Path -LiteralPath $assembly)){throw 'Windows .NET Framework compiler and Windows PowerShell 5.1 runtime are required.'}
$bin=Join-Path $appDir 'bin'
$null=New-Item -ItemType Directory -Path $bin -Force
& $compiler /nologo /target:winexe /platform:x64 /optimize+ (('/reference:')+$assembly) (('/out:')+(Join-Path $bin 'ALLMIND.Widget.exe')) (Join-Path $PSScriptRoot 'allmind-entry.cs')
if($LASTEXITCODE-ne 0){throw 'ALLMIND native WPF host build failed.'}
Write-Output 'ALLMIND.Widget.exe built.'
