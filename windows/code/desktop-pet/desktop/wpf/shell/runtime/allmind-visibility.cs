using System;
using System.Collections.Generic;
using System.Diagnostics;

// Pure policy: no windows, file IO, wall clock or model calls. Native samples
// and monotonic timestamps are supplied by the host and by deterministic tests.
public sealed class AllmindWindowObservation {
 public bool SessionKnown,SessionAvailable,PowerSuspended,GeometryKnown,Fullscreen,Presentation,ShellAllowsNotifications;
 public long Foreground,Monitor,PetMonitor;
 public int WindowLeft,WindowTop,WindowRight,WindowBottom,WorkLeft,WorkTop,WorkRight,WorkBottom;
 public string Error;
 public string OwnerKey { get { return Foreground+":"+Monitor+":"+PetMonitor; } }
 public bool SameScreenFullscreen { get { return Fullscreen && Monitor==PetMonitor && Monitor!=0; } }
}
// Opt-in placement and motion calculations. No focus changes or input simulation.
public static class AllmindPerchPolicy {
 public static int[] Position(AllmindWindowObservation o,int width,int height,bool blocked) {
  if(blocked||o==null||!o.SessionKnown||!o.SessionAvailable||!o.GeometryKnown||o.Fullscreen||o.Presentation||o.Foreground==0||o.Monitor!=o.PetMonitor||width<=0||height<=0||width>32768||height>32768||o.WindowRight<=o.WindowLeft||o.WindowBottom<=o.WindowTop||o.WorkRight-o.WorkLeft<width||o.WindowTop-o.WorkTop<height)return null;
  return new[]{Math.Max(o.WorkLeft,Math.Min(o.WorkRight-width,o.WindowRight-width)),o.WindowTop-height};
 }
 public static double[] Motion(string activity,bool enabled,bool blocked) {
  if(!enabled||blocked)return new[]{0.0,0.0,1000.0};
  if(activity=="walking")return new[]{2.0,-2.0,350.0};
  if(activity=="resting")return new[]{0.0,1.0,1800.0};
  if(activity=="idle")return new[]{0.0,-1.0,2200.0};
  return new[]{0.0,0.0,1000.0};
 }
}
public sealed class AllmindVisibilityDecision {
 public string State,Mode;
 public string[] Reasons;
 public bool Visible,Topmost,NotificationAllowed,ManualHidden,ClickThrough;
 public long Revision;
}
public sealed class AllmindVisibilityPolicy {
 public string Mode="smart";
 public bool ManualHidden,ClickThrough,Exiting;
 public int HotkeyModifiers=0x4003,HotkeyKey=0x50;
 public bool ReplyReminder=true;
 public AllmindWindowObservation Observation;
 public AllmindVisibilityDecision Current;
 bool stableFull,pendingFull;
 string pendingKey,leaseKey;
 long pendingAt,lastGood=-1,leaseUntil;
 string signature;
 long revision;
 static readonly Stopwatch Clock=Stopwatch.StartNew();
 public static long Now { get { return Clock.ElapsedMilliseconds; } }
 public long DelayUntilTransition(long now) {
  long delay=1000;
  if(pendingKey!=null && pendingFull!=stableFull)delay=Math.Min(delay,Math.Max(1,pendingAt+(pendingFull?400:800)-now));
  if(leaseKey!=null)delay=Math.Min(delay,Math.Max(1,leaseUntil-now));
  if(lastGood>=0 && now<=lastGood+2000 && Observation!=null && !Observation.GeometryKnown)delay=Math.Min(delay,Math.Max(1,lastGood+2001-now));
  return delay;
 }
 public void Show(long now) {
  if(Exiting)return;
  ManualHidden=false;
  if(Observation!=null && Observation.GeometryKnown && Observation.SameScreenFullscreen) { leaseKey=Observation.OwnerKey;leaseUntil=now+10000; }
 }
 public void Hide() { ManualHidden=true;leaseKey=null; }
 public void ResetTransient() { stableFull=false;pendingKey=null;leaseKey=null;lastGood=-1; }
 public AllmindVisibilityDecision Evaluate(AllmindWindowObservation sample,long now,bool interactionBusy,bool quiet,bool connected) {
  if(sample==null)throw new ArgumentNullException("sample");
  Observation=sample;
  bool suspended=!sample.SessionKnown||!sample.SessionAvailable||sample.PowerSuspended;
  if(suspended)ResetTransient();
  else if(sample.GeometryKnown) {
   lastGood=now;
   string key=sample.OwnerKey+":"+sample.SameScreenFullscreen;
   if(!interactionBusy) {
    if(key!=pendingKey){pendingKey=key;pendingFull=sample.SameScreenFullscreen;pendingAt=now;}
    if(now-pendingAt>=(pendingFull?400:800))stableFull=pendingFull;
   } else { pendingKey=null; }
  }
  bool degraded=!sample.GeometryKnown&&(lastGood<0||now-lastGood>2000);
  if(leaseKey!=null&&(now>=leaseUntil||leaseKey!=sample.OwnerKey))leaseKey=null;
  bool autoHidden=Mode=="smart"&&stableFull&&!degraded&&leaseKey==null;
  var reasons=new List<string>();
  if(Exiting)reasons.Add("exiting");
  if(!sample.SessionKnown)reasons.Add("session-unknown");
  else if(!sample.SessionAvailable)reasons.Add("session-unavailable");
  if(sample.PowerSuspended)reasons.Add("power-suspended");
  if(ManualHidden)reasons.Add("manual");
  if(sample.Presentation)reasons.Add("presentation");
  if(autoHidden)reasons.Add("fullscreen");
  bool visible=!Exiting&&!suspended&&!ManualHidden&&!sample.Presentation&&!autoHidden;
  if(degraded)reasons.Add("detector-degraded");
  bool notify=visible&&!quiet&&!interactionBusy&&connected&&sample.ShellAllowsNotifications&&!degraded;
  string state=Exiting?"EXITING":suspended?"SUSPENDED":visible?"VISIBLE":"HIDDEN";
  bool topmost=Mode!="normal"&&!degraded;
  string next=state+":"+Mode+":"+ManualHidden+":"+ClickThrough+":"+topmost+":"+notify+":"+String.Join(",",reasons);
  if(signature!=next){signature=next;revision++;}
  return Current=new AllmindVisibilityDecision {State=state,Mode=Mode,Reasons=reasons.ToArray(),Visible=visible,Topmost=topmost,NotificationAllowed=notify,ManualHidden=ManualHidden,ClickThrough=ClickThrough,Revision=revision};
 }
 public static bool FullscreenGeometry(int[] frame,int[] client,int[] monitor,bool caption,bool zoomed) {
  if(frame==null||client==null||monitor==null||frame.Length!=4||client.Length!=4||monitor.Length!=4)return false;
  if(monitor[2]<=monitor[0]||monitor[3]<=monitor[1]||frame[2]<=frame[0]||frame[3]<=frame[1]||client[2]<=client[0]||client[3]<=client[1])return false;
  // Client coverage excludes normal maximized windows even with auto-hidden taskbars.
  for(int i=0;i<4;i++)if(Math.Abs((long)frame[i]-monitor[i])>2||Math.Abs((long)client[i]-monitor[i])>2)return false;
  return !caption; // IsZoomed alone is deliberately not a fullscreen test.
 }
 public static double[] AlphaCenter(byte[] pixels,int width,int height,int stride) {
  if(pixels==null||width<=0||height<=0||stride<(long)width*4||pixels.LongLength<(long)stride*height)throw new ArgumentException("Invalid portrait pixel buffer");
  int l=width,r=-1,t=height,b=-1;
  for(int y=0;y<height;y++)for(int x=0;x<width;x++)if(pixels[y*stride+x*4+3]>10){l=Math.Min(l,x);r=Math.Max(r,x);t=Math.Min(t,y);b=Math.Max(b,y);}
  if(r<l)throw new ArgumentException("Portrait contains no visible pixels");
  return new[]{(l+r)/2.0/width,(t+b)/2.0/height};
 }
}
