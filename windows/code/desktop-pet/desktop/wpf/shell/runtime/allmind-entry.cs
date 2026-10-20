using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Management.Automation;
using System.Management.Automation.Runspaces;

// A console-free host for the upstream WPF PowerShell implementation.
internal static class Program {
 [STAThread]
 private static int Main(string[] args) {
  if(args.Length!=1) return 2;
  string config=Path.GetFullPath(args[0]);
  string app=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,".."));
  string log=Path.Combine(Path.GetDirectoryName(config),"widget-error.log");
  try {
   var initial=InitialSessionState.CreateDefault();
   using(var runspace=RunspaceFactory.CreateRunspace(initial)) {
    runspace.ApartmentState=ApartmentState.STA;
    runspace.ThreadOptions=PSThreadOptions.UseCurrentThread;
    runspace.Open();
    using(var ps=PowerShell.Create()) {
     ps.Runspace=runspace;
     ps.Streams.Error.DataAdded+=(sender,eventArgs)=>{
      var errors=(PSDataCollection<ErrorRecord>)sender;
      var error=errors[eventArgs.Index];
      File.AppendAllText(log,error.Exception.ToString()+Environment.NewLine+error.ScriptStackTrace+Environment.NewLine,Encoding.UTF8);
     };
     ps.AddCommand(Path.Combine(app,"widget.ps1")).AddParameter("AllmindConfig",config).AddParameter("AppDir",app);
     ps.Invoke();
     return ps.HadErrors?1:0;
    }
   }
  } catch(Exception error) {
   File.AppendAllText(log,error.ToString()+Environment.NewLine,Encoding.UTF8);
   return 1;
  }
 }
}

