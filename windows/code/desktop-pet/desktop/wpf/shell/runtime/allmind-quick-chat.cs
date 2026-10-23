using System;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using System.Windows.Automation;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Interop;

// Reuses the portrait's existing bubble and counter-mirrored SceneText. No second window.
public sealed class AllmindQuickChat : IDisposable {
 public readonly Window Window;
 public readonly TextBox Input;
 public readonly Button SendButton;
 public readonly TextBlock Reply;
 public readonly Button ExpandButton;
 public string FullReply {get;private set;}
 public double ContentWidth {get;private set;}
 public double ContentHeight {get;private set;}
 public bool HasMore {get;private set;}
 readonly TextBlock status, hint;
 readonly Grid scene, panel, composer;
 readonly ScrollViewer replyScroll;
 readonly DispatcherTimer timer;
 DateTime deadline;
 string characterId, sessionId, requestText, requestRole, requestSession, requestId;
 bool pending, composing, disposed, editing, restoreNoActivate;
 readonly Dictionary<string,string> drafts=new Dictionary<string,string>();
 readonly Dictionary<string,string> replies=new Dictionary<string,string>();
 Geometry originalBubble;
 public event EventHandler SendRequested, OpenRequested, DisplayChanged;
 public string CharacterId {get{return characterId;}}
 public string SessionId {get{return sessionId;}}
 public string RequestId {get{return requestId;}}
 public string RequestText {get{return requestText;}}
 public bool Pending {get{return pending;}}
 public bool Editing {get{return editing;}}
 public bool Visible {get{return panel.Visibility==Visibility.Visible;}}
 static SolidColorBrush Brush(byte r,byte g,byte b){return new SolidColorBrush(Color.FromRgb(r,g,b));}
 public AllmindQuickChat(Window parent,Grid bubbleScene) {
  Window=parent;scene=bubbleScene;
  var purple=Brush(116,90,152);
  panel=new Grid {Visibility=Visibility.Collapsed,Background=Brushes.Transparent};
  panel.RowDefinitions.Add(new RowDefinition {Height=new GridLength(17)});
  panel.RowDefinitions.Add(new RowDefinition {Height=new GridLength(1,GridUnitType.Star)});
  panel.RowDefinitions.Add(new RowDefinition {Height=new GridLength(18)});
  scene.Children.Add(panel);
  var header=new DockPanel {Margin=new Thickness(32,0,32,0)};
  var close=new Button {Content="×",Width=20,Height=17,FontSize=14,ToolTip="收起（Esc）",Foreground=purple,Focusable=true};
  AutomationProperties.SetName(close,"收起聊天气泡");DockPanel.SetDock(close,Dock.Right);header.Children.Add(close);
  var open=new Button {Content="↗",Width=20,Height=17,ToolTip="打开完整聊天",Foreground=purple,Focusable=true};
  AutomationProperties.SetName(open,"打开完整聊天");DockPanel.SetDock(open,Dock.Left);header.Children.Add(open);panel.Children.Add(header);
  Reply=new TextBlock {TextWrapping=TextWrapping.Wrap,Foreground=purple,FontSize=14,LineHeight=20,TextAlignment=TextAlignment.Center,VerticalAlignment=VerticalAlignment.Center};
  replyScroll=new ScrollViewer {Content=Reply,VerticalScrollBarVisibility=ScrollBarVisibility.Disabled,HorizontalScrollBarVisibility=ScrollBarVisibility.Disabled,Padding=new Thickness(2,1,2,1)};
  Grid.SetRow(replyScroll,1);panel.Children.Add(replyScroll);
  hint=new TextBlock {Text="点气泡，和我聊聊",FontSize=10,Foreground=Brush(144,123,172),HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center};
  Grid.SetRow(hint,2);panel.Children.Add(hint);
  ExpandButton=new Button {Content="展开完整回复 ↗",FontSize=10,Foreground=purple,Focusable=true,HorizontalAlignment=HorizontalAlignment.Center,Visibility=Visibility.Collapsed};
  AutomationProperties.SetName(ExpandButton,"展开完整回复");Grid.SetRow(ExpandButton,2);panel.Children.Add(ExpandButton);
  ExpandButton.Click+=(s,e)=>{if(OpenRequested!=null)OpenRequested(this,EventArgs.Empty);e.Handled=true;};
  composer=new Grid {Visibility=Visibility.Collapsed};Grid.SetRow(composer,1);panel.Children.Add(composer);
  Input=new TextBox {MaxLength=4000,TextWrapping=TextWrapping.Wrap,AcceptsReturn=true,VerticalContentAlignment=VerticalAlignment.Center,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,Background=Brushes.Transparent,Foreground=purple,CaretBrush=purple,BorderThickness=new Thickness(0),Padding=new Thickness(7,3,7,3),FontSize=13,SelectionBrush=Brush(220,208,237)};
  AutomationProperties.SetName(Input,"桌宠聊天消息");
  var field=new Border {Background=Brush(249,246,253),BorderBrush=Brush(202,184,224),BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(10),Margin=new Thickness(0,1,0,2),Child=Input};composer.Children.Add(field);
  Input.GotKeyboardFocus+=(s,e)=>field.BorderBrush=purple;
  Input.LostKeyboardFocus+=(s,e)=>field.BorderBrush=Brush(202,184,224);
  var footer=new DockPanel {Visibility=Visibility.Collapsed};Grid.SetRow(footer,2);panel.Children.Add(footer);
  SendButton=new Button {Content="发送 ↑",Padding=new Thickness(4,0,4,0),Foreground=purple,FontWeight=FontWeights.SemiBold,FontSize=11,Focusable=true};DockPanel.SetDock(SendButton,Dock.Right);footer.Children.Add(SendButton);
  status=new TextBlock {Text="Enter 发送",FontSize=10,Foreground=Brush(144,123,172),VerticalAlignment=VerticalAlignment.Center,TextTrimming=TextTrimming.CharacterEllipsis};footer.Children.Add(status);
  close.Click+=(s,e)=>Hide();open.Click+=(s,e)=>{if(OpenRequested!=null)OpenRequested(this,EventArgs.Empty);};SendButton.Click+=(s,e)=>Submit();
  panel.MouseLeftButtonUp+=(s,e)=>{if(!editing&&!pending){Edit();e.Handled=true;}};
  Input.PreviewKeyDown+=(s,e)=>{Touch();if(e.Key==Key.Escape){ShowReply();e.Handled=true;}else if(e.Key==Key.Enter&&!composing&&(Keyboard.Modifiers&ModifierKeys.Shift)==0){e.Handled=true;Submit();}};
  TextCompositionManager.AddPreviewTextInputStartHandler(Input,(s,e)=>{composing=true;Touch();});
  TextCompositionManager.AddPreviewTextInputHandler(Input,(s,e)=>{composing=false;Touch();});
  Input.TextChanged+=(s,e)=>Touch();panel.MouseMove+=(s,e)=>Touch();
  timer=new DispatcherTimer {Interval=TimeSpan.FromMilliseconds(250)};
  timer.Tick+=(s,e)=>{if(Visible&&ShouldHide(DateTime.UtcNow,deadline,pending,Input.IsKeyboardFocusWithin,Input.Text.Length>0,composing))Hide();};
  ModeChanged=()=>{composer.Visibility=editing?Visibility.Visible:Visibility.Collapsed;footer.Visibility=composer.Visibility;replyScroll.Visibility=editing?Visibility.Collapsed:Visibility.Visible;hint.Visibility=editing||HasMore?Visibility.Collapsed:Visibility.Visible;ExpandButton.Visibility=!editing&&HasMore?Visibility.Visible:Visibility.Collapsed;hint.Text=pending?"正在回复…":"点气泡，和我聊聊";};
 }
 readonly Action ModeChanged;
 void Notify(){if(DisplayChanged!=null)DisplayChanged(this,EventArgs.Empty);}
 public void ApplyLayout(System.Windows.Shapes.Path shape,Canvas bubble){
  if(originalBubble==null)originalBubble=shape.Data.Clone();
  if(!Visible){
   shape.Data=originalBubble.Clone();Canvas.SetTop(bubble,0);
   Canvas.SetLeft(scene,63);Canvas.SetTop(scene,22);scene.Width=184;scene.Height=115;return;
  }
  double width=Editing?232:Math.Max(184,ContentWidth),height=Editing?132:Math.Max(104,ContentHeight);
  double rx=(width+72)/2,ry=(height+46)/2,cy=ry+6,left=155-rx,right=155+rx,bottom=6+2*ry;
  shape.Data=Geometry.Parse(String.Format(CultureInfo.InvariantCulture,"M {0},{1} A {2},{3} 0 1 1 {4},{1} A {2},{3} 0 0 1 196,{5} A 20,10 0 0 1 161,{6} A {2},{3} 0 0 1 {0},{1} Z",left,cy,rx,ry,right,bottom-4,bottom));
  Canvas.SetTop(bubble,-Math.Min(16,Math.Max(0,height-112)));
  Canvas.SetLeft(scene,155-width/2);Canvas.SetTop(scene,22);scene.Width=width;scene.Height=height;
 }
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetStyle(IntPtr hwnd,int index);
 [DllImport("user32.dll",EntryPoint="SetWindowLongPtrW")] static extern IntPtr SetStyle(IntPtr hwnd,int index,IntPtr value);
 void InputActivation(bool active){
  var hwnd=new WindowInteropHelper(Window).Handle;if(hwnd==IntPtr.Zero)return;
  long style=GetStyle(hwnd,-20).ToInt64();
  if(active){restoreNoActivate=(style&0x08000000)!=0;if(restoreNoActivate)SetStyle(hwnd,-20,new IntPtr(style&~0x08000000));}
  else if(restoreNoActivate){SetStyle(hwnd,-20,new IntPtr(style|0x08000000));restoreNoActivate=false;}
 }
 public void ShowReply(){InputActivation(false);editing=false;composing=false;ModeChanged();Touch();Keyboard.ClearFocus();Notify();}
 public void Edit(){if(!Visible||pending||editing)return;InputActivation(true);editing=true;ModeChanged();Touch();Notify();Window.Activate();Input.Focus();}
 public static bool ShouldHide(DateTime now,DateTime until,bool busy,bool focused,bool draft){return ShouldHide(now,until,busy,focused,draft,false);}
 public static bool ShouldHide(DateTime now,DateTime until,bool busy,bool focused,bool draft,bool composition){return now>=until&&!busy&&!(focused&&(draft||composition));}
 public void Touch(){deadline=DateTime.UtcNow.AddSeconds(15);}
 public void Show(string role,string label,string session){
  if(String.IsNullOrEmpty(role))return;
  if(characterId!=role||sessionId!=session){
   if(characterId!=null)drafts[characterId+":"+sessionId]=Input.Text;
   string saved;Input.Text=drafts.TryGetValue(role+":"+session,out saved)?saved:"";
   SetReply(replies.TryGetValue(role+":"+session,out saved)?saved:"我在，想聊点什么？");
   pending=false;SendButton.IsEnabled=true;requestId=null;status.Text="Enter 发送";
  }
  characterId=role;sessionId=session;panel.Visibility=Visibility.Visible;ShowReply();Notify();timer.Start();
 }
 public void RememberReply(string role,string session,string text){
  if(String.IsNullOrWhiteSpace(text))return;replies[role+":"+session]=text;
  if(role==characterId&&session==sessionId&&!pending)SetReply(text);
 }
 public void SetReply(string text){
  FullReply=text??"";
  string display=Regex.Replace(FullReply,@"\s+"," ").Trim();
  var positions=StringInfo.ParseCombiningCharacters(display);int count=positions.Length;
  ContentWidth=count<=32?184:count<=64?208:232;
  ContentHeight=count<=32?104:count<=64?116:132;
  Reply.MaxHeight=Double.PositiveInfinity;
  int take=Math.Min(count,100);
  while(true){
   Reply.Text=(take<count?display.Substring(0,positions[take])+"…":display);
   Reply.Measure(new Size(ContentWidth-6,Double.PositiveInfinity));
   if(Reply.DesiredSize.Height<=ContentHeight-38||take==0)break;
   take--;
  }
  HasMore=take<count;
  Reply.MaxHeight=ContentHeight-36;
  ModeChanged();if(Visible)Notify();
 }
 public void Submit(){
  if(pending||composing||String.IsNullOrWhiteSpace(Input.Text))return;
  if(requestText!=Input.Text||requestRole!=characterId||requestSession!=sessionId||requestId==null)requestId=Guid.NewGuid().ToString("N");
  requestText=Input.Text;requestRole=characterId;requestSession=sessionId;pending=true;SendButton.IsEnabled=false;status.Text="正在回复…";SetReply("正在回复…");ShowReply();Touch();
  if(SendRequested!=null)SendRequested(this,EventArgs.Empty);
 }
 public void Receive(string id,string role,string session,bool ok,string text){
  if(!pending||String.IsNullOrEmpty(id)||id!=requestId||role!=characterId||session!=sessionId)return;
  pending=false;SendButton.IsEnabled=true;SetReply(text);status.Text="Enter 发送";ShowReply();hint.Text=ok?"点气泡，继续聊":"未重发 · ↗ 打开聊天核对";
  if(ok){replies[role+":"+session]=text;if(Input.Text==requestText)Input.Text="";requestId=null;}
  deadline=DateTime.UtcNow.AddSeconds(30);
 }
 public void Hide(){if(!Visible)return;InputActivation(false);panel.Visibility=Visibility.Collapsed;timer.Stop();composing=false;Keyboard.ClearFocus();Notify();}
 public void Dispose(){if(disposed)return;Hide();disposed=true;timer.Stop();scene.Children.Remove(panel);}
}
