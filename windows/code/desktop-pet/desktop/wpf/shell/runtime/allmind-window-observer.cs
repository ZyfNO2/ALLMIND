using System;
using System.Runtime.InteropServices;
using System.Text;

// Owns only local Win32 observations. No titles, process paths, input content
// or DLL injection. Hooks just mark Dirty; PowerShell runs on its dispatcher.
public sealed class AllmindWindowObserver : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int L,T,R,B; public int[] Values { get { return new[]{L,T,R,B}; } } }
 [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor,Work; public uint Flags; }
 delegate void WinEvent(IntPtr hook,uint ev,IntPtr hwnd,int obj,int child,uint thread,uint time);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsZoomed(IntPtr h);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")]static extern bool ClientToScreen(IntPtr h,ref Point p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder name,int size);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]static extern IntPtr GetWindowLong(IntPtr h,int index);
 [DllImport("user32.dll")]static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll")]static extern IntPtr MonitorFromPoint(Point point,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool GetMonitorInfo(IntPtr h,ref MonitorInfo info);
 [DllImport("dwmapi.dll")]static extern int DwmGetWindowAttribute(IntPtr h,int attribute,out Rect r,int size);
 [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")]static extern int DwmCloak(IntPtr h,int attribute,out uint value,int size);
 [DllImport("user32.dll")]static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,WinEvent callback,uint pid,uint thread,uint flags);
 [DllImport("user32.dll")]static extern bool UnhookWinEvent(IntPtr hook);
 [DllImport("wtsapi32.dll",SetLastError=true)]static extern bool WTSRegisterSessionNotification(IntPtr h,uint flags);
 [DllImport("wtsapi32.dll")]static extern bool WTSUnRegisterSessionNotification(IntPtr h);
 [DllImport("wtsapi32.dll",SetLastError=true)]static extern bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr buffer,out int size);
 [DllImport("wtsapi32.dll")]static extern void WTSFreeMemory(IntPtr value);
 [DllImport("user32.dll",SetLastError=true)]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder text,int length,out int needed);
 [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr h);
 [DllImport("shell32.dll")]static extern int SHQueryUserNotificationState(out int state);
 [DllImport("user32.dll",SetLastError=true)]static extern bool RegisterHotKey(IntPtr h,int id,uint modifiers,uint key);
 [DllImport("user32.dll")]static extern bool UnregisterHotKey(IntPtr h,int id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern uint RegisterWindowMessage(string name);
 const int HotkeyId=0x414D;
 readonly IntPtr widget; readonly uint ownPid; readonly WinEvent callback;
 readonly string systemRegistrationError;
 IntPtr foregroundHook,locationHook; AllmindWindowObservation lastExternal;
 bool disposed,wtsRegistered,hotkeyRegistered,powerSuspended,locked;
 public volatile bool Dirty=true;
 public bool PowerSuspended { get { return powerSuspended; } }
 public string RegistrationError { get;private set; }
 public uint TaskbarCreated { get;private set; }
 public bool HotkeyRegistered { get { return hotkeyRegistered; } }
 public AllmindWindowObserver(IntPtr handle) {
  widget=handle;ownPid=(uint)System.Diagnostics.Process.GetCurrentProcess().Id;
  callback=delegate(IntPtr hook,uint ev,IntPtr hwnd,int obj,int child,uint thread,uint time){if(ev==3||(obj==0&&child==0&&hwnd==GetForegroundWindow()))Dirty=true;};
  foregroundHook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);
  locationHook=SetWinEventHook(0x800B,0x800B,IntPtr.Zero,callback,0,0,0);
  if(foregroundHook==IntPtr.Zero||locationHook==IntPtr.Zero)RegistrationError="foreground-hook-unavailable";
  wtsRegistered=WTSRegisterSessionNotification(widget,0);
  if(!wtsRegistered)RegistrationError="session-notification-error:"+Marshal.GetLastWin32Error();
  TaskbarCreated=RegisterWindowMessage("TaskbarCreated");
  systemRegistrationError=RegistrationError;
 }
 public bool ConfigureHotkey(int modifiers,int key) {
  if(hotkeyRegistered){UnregisterHotKey(widget,HotkeyId);hotkeyRegistered=false;}
  RegistrationError=systemRegistrationError;
  if(key==0)return true;
  hotkeyRegistered=RegisterHotKey(widget,HotkeyId,(uint)modifiers|0x4000,(uint)key);
  if(!hotkeyRegistered)RegistrationError="hotkey-conflict:"+Marshal.GetLastWin32Error();
  return hotkeyRegistered;
 }
 // 1 = reveal, 2 = tray recreation, 3 = invalidate transient observations.
 public int Message(int msg,long w) {
  if(msg==0x312&&w==HotkeyId)return 1;
  if(TaskbarCreated!=0&&(uint)msg==TaskbarCreated)return 2;
  if(msg==0x2B1){if(w==7)locked=true;if(w==8)locked=false;Dirty=true;lastExternal=null;return 3;}
  if(msg==0x218){if(w==4)powerSuspended=true;if(w==7||w==18)powerSuspended=false;Dirty=true;lastExternal=null;return 3;}
  if(msg==0x2E0||msg==0x7E||msg==0x1A){Dirty=true;lastExternal=null;return 3;}
  return 0;
 }
 public long MonitorAt(int x,int y){return MonitorFromPoint(new Point{X=x,Y=y},2).ToInt64();}
 void SampleSession(AllmindWindowObservation o) {
  o.PowerSuspended=powerSuspended;
  IntPtr buffer;int size;
  if(!WTSQuerySessionInformation(IntPtr.Zero,-1,8,out buffer,out size)){o.Error="session-query:"+Marshal.GetLastWin32Error();return;}
  try{if(size<4){o.Error="session-query-size";return;}if(Marshal.ReadInt32(buffer)!=0){o.SessionKnown=true;return;}}finally{WTSFreeMemory(buffer);}
  if(locked){o.SessionKnown=true;return;}
  var desktop=OpenInputDesktop(0,false,1);
  if(desktop==IntPtr.Zero){int code=Marshal.GetLastWin32Error();o.SessionKnown=code==5;o.Error="input-desktop:"+code;return;}
  try{int needed;var text=new StringBuilder(256);if(!GetUserObjectInformation(desktop,2,text,512,out needed)){o.Error="input-desktop-name:"+Marshal.GetLastWin32Error();return;}o.SessionKnown=true;o.SessionAvailable=String.Equals(text.ToString(),"Default",StringComparison.OrdinalIgnoreCase);}finally{CloseDesktop(desktop);}
 }
 public AllmindWindowObservation Sample(int petX,int petY) {
  Dirty=false;var o=new AllmindWindowObservation();SampleSession(o);
  o.PetMonitor=MonitorAt(petX,petY);
  int shell;int hr=SHQueryUserNotificationState(out shell);o.ShellAllowsNotifications=hr==0&&shell==5;o.Presentation=hr==0&&shell==4;
  if(hr!=0)o.Error="shell-state:"+hr;
  IntPtr foreground=GetForegroundWindow();uint pid;GetWindowThreadProcessId(foreground,out pid);
  if(pid==ownPid&&lastExternal!=null){o.Foreground=lastExternal.Foreground;o.Monitor=lastExternal.Monitor;o.Fullscreen=lastExternal.Fullscreen;o.GeometryKnown=lastExternal.GeometryKnown;return o;}
  o.Foreground=foreground.ToInt64();
  if(foreground==IntPtr.Zero){o.Error="foreground-unavailable";return o;}
  var className=new StringBuilder(256);GetClassName(foreground,className,className.Capacity);
  uint cloak;bool cloaked=DwmCloak(foreground,14,out cloak,4)==0&&cloak!=0;
  string kind=className.ToString();
  // The shell tray is a transient recovery surface, not a new fullscreen
  // owner. Preserve the last external app while the user opens our tray menu.
  if((kind=="Shell_TrayWnd"||kind=="Shell_SecondaryTrayWnd")&&lastExternal!=null){o.Foreground=lastExternal.Foreground;o.Monitor=lastExternal.Monitor;o.Fullscreen=lastExternal.Fullscreen;o.GeometryKnown=lastExternal.GeometryKnown;return o;}
  if(pid==ownPid||kind=="Progman"||kind=="WorkerW"||kind=="Shell_TrayWnd"||kind=="Shell_SecondaryTrayWnd"||IsIconic(foreground)||!IsWindowVisible(foreground)||cloaked){o.GeometryKnown=true;lastExternal=o;return o;}
  var monitor=MonitorFromWindow(foreground,2);o.Monitor=monitor.ToInt64();
  var info=new MonitorInfo{Size=Marshal.SizeOf(typeof(MonitorInfo))};Rect frame,client;
  int dwm=DwmGetWindowAttribute(foreground,9,out frame,Marshal.SizeOf(typeof(Rect)));
  if(dwm!=0&&!GetWindowRect(foreground,out frame)){o.Error="window-rect-unavailable";return o;}
  if(!GetMonitorInfo(monitor,ref info)||!GetClientRect(foreground,out client)){o.Error="geometry-unavailable";return o;}
  var tl=new Point{X=client.L,Y=client.T};var br=new Point{X=client.R,Y=client.B};
  if(!ClientToScreen(foreground,ref tl)||!ClientToScreen(foreground,ref br)){o.Error="client-screen-unavailable";return o;}
  bool caption=(GetWindowLong(foreground,-16).ToInt64()&0x00C00000)!=0;
  o.Fullscreen=AllmindVisibilityPolicy.FullscreenGeometry(frame.Values,new[]{tl.X,tl.Y,br.X,br.Y},info.Monitor.Values,caption,IsZoomed(foreground));o.GeometryKnown=true;
  if(dwm!=0){o.GeometryKnown=false;o.Error="dwm-frame:"+dwm;} // Do not call fallback geometry a trusted sample.
  lastExternal=o;return o;
 }
 public void Dispose(){if(disposed)return;disposed=true;if(foregroundHook!=IntPtr.Zero)UnhookWinEvent(foregroundHook);if(locationHook!=IntPtr.Zero)UnhookWinEvent(locationHook);if(wtsRegistered)WTSUnRegisterSessionNotification(widget);if(hotkeyRegistered)UnregisterHotKey(widget,HotkeyId);hotkeyRegistered=false;}
}
