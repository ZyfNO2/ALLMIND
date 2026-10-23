$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try{
 Add-Type -AssemblyName System.Runtime.WindowsRuntime
 [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null
 $profile=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
 if(!$profile){throw 'ocr_language_unavailable'}
 $request=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($request.action-eq 'probe'){
  @{available=$true;engine='windows-media-ocr';transport='powershell-winrt';language=$profile.RecognizerLanguage.LanguageTag;maxDimension=[Windows.Media.Ocr.OcrEngine]::MaxImageDimension}|ConvertTo-Json -Compress
 }elseif($request.action-eq 'recognize'){
  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null
  [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null
  $asTask=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object {$_.Name-eq 'AsTask'-and $_.IsGenericMethodDefinition-and $_.GetParameters().Count-eq 1-and $_.GetParameters()[0].ParameterType.Name-eq 'IAsyncOperation`1'}|Select-Object -First 1
  function Await($operation,[Type]$type){$task=$asTask.MakeGenericMethod($type).Invoke($null,@($operation));$task.GetAwaiter().GetResult()}
  $bytes=[Convert]::FromBase64String($request.imageBase64)
  if(!$bytes.Length-or $bytes.Length-gt 1500000){throw 'image_bytes_invalid'}
  $stream=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  $writer=[Windows.Storage.Streams.DataWriter]::new($stream)
  $bitmap=$null
  try{
   $writer.WriteBytes($bytes);Await ($writer.StoreAsync()) ([uint32])|Out-Null;$writer.DetachStream()|Out-Null;$stream.Seek(0)
   $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
   $width=$decoder.PixelWidth;$height=$decoder.PixelHeight
   if(!$width-or !$height-or [long]$width*$height-gt 40000000-or $width-gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension-or $height-gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension){throw 'image_dimensions_invalid'}
   $bitmap=Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
   $engines=[Collections.Generic.List[object]]::new();$engines.Add($profile)
   foreach($language in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages){if($language.LanguageTag-in @('en-US','zh-Hans-CN')-and $language.LanguageTag-ne $profile.RecognizerLanguage.LanguageTag){$engines.Add([Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language))}}
   $best=$null
   foreach($engine in $engines){
    $result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $blocks=[Collections.Generic.List[object]]::new();$cjk=0;$chars=0
    foreach($line in $result.Lines){
     $text=$line.Text
     if(!$text){continue}
     if($blocks.Count-ge 256-or [Text.Encoding]::UTF8.GetByteCount($text)-gt 4096){throw 'ocr_output_limit'}
     $count=[regex]::Matches($text,'[\p{IsCJKUnifiedIdeographs}\p{IsHiragana}\p{IsKatakana}\p{IsHangulSyllables}]').Count
     if($count-gt 0){$text=[regex]::Replace($text,'(?<=[\p{IsCJKUnifiedIdeographs}\p{IsHiragana}\p{IsKatakana}\p{IsHangulSyllables}])\s+(?=[\p{IsCJKUnifiedIdeographs}\p{IsHiragana}\p{IsKatakana}\p{IsHangulSyllables}])','')}
     $cjk+=$count;$chars+=$text.Length
     $rects=@($line.Words|ForEach-Object {$_.BoundingRect});if(!$rects.Count){continue}
     $x=($rects|Measure-Object X -Minimum).Minimum;$y=($rects|Measure-Object Y -Minimum).Minimum
     $right=($rects|ForEach-Object {$_.X+$_.Width}|Measure-Object -Maximum).Maximum;$bottom=($rects|ForEach-Object {$_.Y+$_.Height}|Measure-Object -Maximum).Maximum
     $blocks.Add(@{text=$text;confidence=$null;bounds=@{x=$x;y=$y;width=$right-$x;height=$bottom-$y}})
    }
    $candidate=@{language=$engine.RecognizerLanguage.LanguageTag;cjk=$cjk;chars=$chars;blocks=@($blocks.ToArray())}
    if(!$best-or ($cjk-gt 0-and $best.cjk-eq 0)-or ($cjk-gt 0-and $best.cjk-gt 0-and ($cjk-gt $best.cjk-or ($cjk-eq $best.cjk-and $chars-gt $best.chars)))-or ($cjk-eq 0-and $best.cjk-eq 0-and $candidate.language-eq 'en-US'-and $best.language-ne 'en-US')){$best=$candidate}
   }
   @{status='ok';engine='windows-media-ocr';language=$best.language;width=$width;height=$height;blocks=@($best.blocks)}|ConvertTo-Json -Depth 7 -Compress
  }finally{[Array]::Clear($bytes,0,$bytes.Length);if($bitmap){$bitmap.Dispose()};$writer.Dispose();$stream.Dispose()}
 }else{throw 'unknown_ocr_operation'}
}catch{[Console]::Error.WriteLine('Windows local OCR failed: '+$_.Exception.Message);exit 1}
