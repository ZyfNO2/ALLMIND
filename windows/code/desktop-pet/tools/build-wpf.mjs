import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.platform!=='win32')throw Error('WPF requires Windows x64 and Windows PowerShell 5.1.');
const script=fileURLToPath(new URL('../desktop/wpf/shell/runtime/build-allmind-host.ps1',import.meta.url));
const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;if(result.status!==0)throw Error('WPF build failed: '+result.status);
