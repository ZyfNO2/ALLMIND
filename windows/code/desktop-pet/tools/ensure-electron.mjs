import {createRequire} from 'node:module';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Electron 44 ships an explicit installer instead of a package postinstall lifecycle.
// Build setup must work from npm ci, not just from a developer's previously populated dist.
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(new URL('../package.json',import.meta.url));
let packageFile;try{packageFile=require.resolve('electron/package.json')}catch(cause){throw Error('Electron dependency is missing. Run npm ci in the desktop-pet directory first.',{cause})}
const directory=dirname(realpathSync(packageFile)),rel=relative(join(root,'node_modules'),directory);
if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Error('Electron must be installed inside this project, not inherited from a parent workspace.');
const metadata=JSON.parse(readFileSync(packageFile,'utf8')),executable=process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron';
const binary=join(directory,'dist',executable),versionFile=join(directory,'dist/version'),pathFile=join(directory,'path.txt');
const installed=()=>existsSync(binary)&&existsSync(versionFile)&&readFileSync(versionFile,'utf8').trim().replace(/^v/,'')===metadata.version&&existsSync(pathFile)&&readFileSync(pathFile,'utf8').trim()===executable;
if(!installed()){
 if(process.env.ELECTRON_SKIP_BINARY_DOWNLOAD)throw Error('Electron binary missing while ELECTRON_SKIP_BINARY_DOWNLOAD is set. Remove that setting or install the locked local binary explicitly.');
 if(process.env.ELECTRON_OVERRIDE_DIST_PATH)throw Error('The desktop build requires its own Electron dist; ELECTRON_OVERRIDE_DIST_PATH cannot replace it.');
 if(process.env.electron_use_remote_checksums||process.env.npm_config_electron_use_remote_checksums)throw Error('The desktop build requires Electron checksums bundled with the locked dependency. Remote checksum override is not supported.');
 process.stdout.write('Installing locked Electron '+metadata.version+' with the dependency installer and bundled checksums.\n');
 const result=spawnSync(process.execPath,[join(directory,'install.js')],{cwd:root,windowsHide:true,stdio:'inherit'});
 if(result.error)throw result.error;if(result.status!==0)throw Error('Electron installation failed (exit '+result.status+'). No existing workspace binary was substituted.');
 if(!installed())throw Error('Electron installer completed without a matching project-local executable/version/path.');
}
process.stdout.write('Project-local Electron '+metadata.version+' ready.\n');
