[Console]::InputEncoding = [Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$archive = [IO.Compression.ZipFile]::OpenRead($request.source)
try {
  if ($archive.Entries.Count -gt 512) { throw 'ZIP 文件数量超出 512 上限。' }
  $total = 0L
  $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName
    if (!$name -or $name -match '[\\:%\x00]' -or $name.StartsWith('/') -or ($name.Split('/') -contains '..') -or ($name.Split('/') -contains '.')) { throw 'ZIP 内包含不安全的路径。' }
    if (!$names.Add($name)) { throw 'ZIP 内包含重名文件。' }
    if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'ZIP 内不允许符号链接。' }
    $total += $entry.Length
    if ($total -gt 536870912) { throw 'ZIP 解压体积超出 512 MiB 上限。' }
  }
  if ($request.mode -eq 'list') {
    $entries = @($archive.Entries | Where-Object { $_.FullName -match '\.model3\.json$' } | ForEach-Object { @{entry=$_.FullName; label=$_.FullName} })
    ConvertTo-Json -InputObject $entries -Compress
  } elseif ($request.mode -eq 'extract') {
    $base = [IO.Path]::GetFullPath($request.destination) + [IO.Path]::DirectorySeparatorChar
    foreach ($entry in $archive.Entries) {
      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($base, $entry.FullName))
      if (!$target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP 解压路径超出目标目录。' }
      if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
    '[]'
  } else { throw 'ZIP 操作无效。' }
} finally { $archive.Dispose() }
