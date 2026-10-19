// A separate native process: never move, resize or minimize the user's application windows.
import {app,BrowserWindow} from 'electron';
import {createInterface} from 'node:readline';
void app.whenReady().then(async()=>{
const win=new BrowserWindow({x:500,y:500,width:420,height:200,show:false,title:'AIKI isolated surface fixture',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
await win.loadURL('data:text/html,<p>AIKI isolated window geometry test</p>');win.setAlwaysOnTop(true);win.showInactive();
const output=()=>process.stdout.write(JSON.stringify({pid:process.pid,bounds:win.getBounds()})+'\n');output();
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const command=JSON.parse(line);if(command.action==='move')win.setBounds(command.bounds);else if(command.action==='minimize')win.minimize();else if(command.action==='restore')win.restore();else if(command.action==='close'){app.quit();return;}output();});
lines.once('close',()=>app.quit());
app.on('window-all-closed',()=>app.quit());
});
