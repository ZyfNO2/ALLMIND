$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try{
 Add-Type -AssemblyName System.Speech
 $request=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($request.action-eq 'probe'){
  $speaker=[System.Speech.Synthesis.SpeechSynthesizer]::new()
  try{$voices=@($speaker.GetInstalledVoices()|Where-Object Enabled|ForEach-Object {@{name=$_.VoiceInfo.Name;culture=$_.VoiceInfo.Culture.Name}})}finally{$speaker.Dispose()}
  $recognizers=@([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()|ForEach-Object {@{id=$_.Id;culture=$_.Culture.Name}})
  @{available=$true;voices=$voices;recognizers=$recognizers}|ConvertTo-Json -Depth 5 -Compress
 }elseif($request.action-eq 'recognize'){
  $installed=@([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()|Where-Object {$_.Culture.Name-eq $request.language})
  if(!$installed.Count){throw 'Selected recognition language is not installed.'}
  Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @"
using System;
using System.IO;
using System.Collections.Generic;
using System.Speech.Recognition;
using System.Threading;
public sealed class LocalSpeechPart { public string text; public float confidence; }
public static class AllmindLocalDictation {
 public static LocalSpeechPart[] Run(RecognizerInfo info, byte[] bytes) {
  using(var recognizer=new SpeechRecognitionEngine(info))
  using(var stream=new MemoryStream(bytes,false))
  using(var completed=new ManualResetEvent(false)) {
   var parts=new List<LocalSpeechPart>();Exception failure=null;
   recognizer.LoadGrammar(new DictationGrammar());
   recognizer.InitialSilenceTimeout=TimeSpan.FromSeconds(30);
   recognizer.BabbleTimeout=TimeSpan.FromSeconds(3);
   recognizer.EndSilenceTimeout=TimeSpan.FromMilliseconds(300);
   recognizer.SpeechRecognized+=(sender,args)=>{lock(parts){parts.Add(new LocalSpeechPart{text=args.Result.Text,confidence=args.Result.Confidence});}};
   recognizer.RecognizeCompleted+=(sender,args)=>{failure=args.Error;completed.Set();};
   recognizer.SetInputToWaveStream(stream);
   recognizer.RecognizeAsync(RecognizeMode.Multiple);
   if(!completed.WaitOne(TimeSpan.FromSeconds(55))){recognizer.RecognizeAsyncCancel();completed.WaitOne(TimeSpan.FromSeconds(2));throw new TimeoutException("Local recognition timed out.");}
   if(failure!=null)throw failure;
   lock(parts){return parts.ToArray();}
  }
 }
}
"@
  $parts=@([AllmindLocalDictation]::Run($installed[0],[Convert]::FromBase64String($request.audioBase64)))
  @{text=([string]::Join(' ',@($parts|ForEach-Object {$_.text})));segments=@($parts|ForEach-Object {@{text=$_.text;confidence=[Math]::Round($_.confidence,4)}})}|ConvertTo-Json -Depth 5 -Compress
 }else{throw 'Unknown speech operation.'}
}catch{[Console]::Error.WriteLine('Windows speech operation failed: '+$_.Exception.Message);exit 1}
