import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installAllmind,rollbackAllmind,uninstallAllmind,verifyInstallPackage,previewPruneAllmind,pruneAllmind} from '../../tools/install-allmind.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'allmind-install-'));
 const options={installRoot:join(directory,'program'),dataRoot:join(directory,'personal-data')};mkdirSync(options.dataRoot);
 writeFileSync(join(options.dataRoot,'private.json'),'user config and chats must survive');
 function pack(name,version='0.1.0-beta.1'){
  const root=join(directory,name),values={'package.json':JSON.stringify({name:'allmind-portable',version}),'runtime/node.exe':'synthetic runtime, never executed','desktop/wpf/main.mjs':'synthetic app '+name,'Start-ALLMIND.vbs':'synthetic portable launcher'};
  const files=Object.entries(values).map(([path,text])=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),text);return {path,bytes:Buffer.byteLength(text),sha256:hash(text)};});
  const manifest={schemaVersion:1,platform:'win32-x64',files};writeFileSync(join(root,'package-manifest.json'),JSON.stringify(manifest));
  return {root,digest:hash(readFileSync(join(root,'package-manifest.json')))};
 }
 return {directory,options,pack};
}
test('install, verified update, rollback and uninstall preserve user data and prior version bytes',()=>{
 const {options,pack}=fixture(),a=pack('a'),b=pack('b','0.1.0-beta.2');
 const initial=installAllmind({...options,packageRoot:a.root});assert.equal(initial.version,'0.1.0-beta.1');
 const old=readFileSync(join(options.installRoot,'current.txt'),'utf8');
 assert.throws(()=>installAllmind({...options,packageRoot:b.root}),/Updates require/);assert.equal(readFileSync(join(options.installRoot,'current.txt'),'utf8'),old);
 assert.throws(()=>installAllmind({...options,packageRoot:b.root,expectedManifest:'0'.repeat(64)}),/SHA-256/);
 installAllmind({...options,packageRoot:b.root,expectedManifest:b.digest});
 assert.notEqual(readFileSync(join(options.installRoot,'current.txt'),'utf8'),old);
 assert.equal(rollbackAllmind(options).version,'0.1.0-beta.1');assert.equal(readFileSync(join(options.installRoot,'current.txt'),'utf8'),old);
 verifyInstallPackage(join(options.installRoot,'versions',old.trim()),a.digest);
 assert.equal(rollbackAllmind(options).version,'0.1.0-beta.2');
 assert.equal(uninstallAllmind(options).status,'uninstalled');assert.equal(existsSync(options.installRoot),false);
 assert.equal(readFileSync(join(options.dataRoot,'private.json'),'utf8'),'user config and chats must survive');
});
test('same release installation is idempotent and retains rollback target',()=>{
 const {options,pack}=fixture(),a=pack('a'),b=pack('b');installAllmind({...options,packageRoot:a.root});installAllmind({...options,packageRoot:b.root,expectedManifest:b.digest});
 const before=JSON.parse(readFileSync(join(options.installRoot,'install.json'),'utf8'));
 installAllmind({...options,packageRoot:b.root});const after=JSON.parse(readFileSync(join(options.installRoot,'install.json'),'utf8'));assert.deepEqual(after,before);
});
test('version cleanup requires a current explicit plan and protects active, rollback and private data',()=>{
 const {options,pack}=fixture(),a=pack('prune-a','0.1.0-beta.1'),b=pack('prune-b','0.1.0-beta.2'),c=pack('prune-c','0.1.0-beta.3');
 installAllmind({...options,packageRoot:a.root});installAllmind({...options,packageRoot:b.root,expectedManifest:b.digest});installAllmind({...options,packageRoot:c.root,expectedManifest:c.digest});
 const plan=previewPruneAllmind(options);assert.equal(plan.candidates.length,1);
 assert.throws(()=>pruneAllmind({...options,expectedPlan:'0'.repeat(64),slots:[plan.candidates[0].slot]}),/plan changed/);
 assert.throws(()=>pruneAllmind({...options,expectedPlan:plan.planHash,slots:[plan.current]}),/plan changed/);
 assert.throws(()=>pruneAllmind({...options,expectedPlan:plan.planHash,slots:[plan.previous]}),/plan changed/);
 const result=pruneAllmind({...options,expectedPlan:plan.planHash,slots:[plan.candidates[0].slot]});assert.equal(result.status,'pruned');assert.equal(previewPruneAllmind(options).candidates.length,0);
 assert.equal(rollbackAllmind(options).version,'0.1.0-beta.2');assert.equal(readFileSync(join(options.dataRoot,'private.json'),'utf8'),'user config and chats must survive');
});

test('custom data directory is persisted and cannot be changed during maintenance',()=>{
 const {options,pack}=fixture(),a=pack('a'),b=pack('b');installAllmind({...options,packageRoot:a.root});
 const record=JSON.parse(readFileSync(join(options.installRoot,'install.json'),'utf8'));
 assert.equal(record.dataRoot,options.dataRoot);
 assert.equal(readFileSync(join(options.installRoot,'data-root.txt'),'utf16le'),'\ufeff'+options.dataRoot);
 const wrong={...options,dataRoot:join(options.dataRoot,'other')};
 const before=readFileSync(join(options.installRoot,'current.txt'),'utf8');
 assert.throws(()=>installAllmind({...wrong,packageRoot:b.root,expectedManifest:b.digest}),/data directory/);
 assert.throws(()=>rollbackAllmind(wrong),/data directory/);assert.throws(()=>uninstallAllmind(wrong),/data directory/);
 assert.equal(readFileSync(join(options.installRoot,'current.txt'),'utf8'),before);
 assert.equal(readFileSync(join(options.dataRoot,'private.json'),'utf8'),'user config and chats must survive');
});

test('installed VBScript passes the bound Unicode data directory on a normal launch',{skip:process.platform!=='win32'},()=>{
 const {directory,options,pack}=fixture(),a=pack('a');options.dataRoot=join(directory,'个人数据');installAllmind({...options,packageRoot:a.root});
 const launcher=readFileSync(join(options.installRoot,'Start-ALLMIND.vbs'),'utf8'),validator=join(options.installRoot,'check-command.vbs');
 // Read through an actual Unicode file: cscript //U emits no stdout to Node pipes on some Windows hosts.
 writeFileSync(validator,launcher.slice(0,launcher.indexOf('shell.Run command'))+'Set stream=fso.CreateTextFile(root & "\\command-output.txt",True,True)\r\nstream.Write command\r\nstream.Close\r\n');
 const run=spawnSync('cscript.exe',['//nologo',validator],{encoding:'utf8',windowsHide:true});
 assert.equal(run.status,0,run.stderr);assert.ok(readFileSync(join(options.installRoot,'command-output.txt'),'utf16le').includes(' --data "'+options.dataRoot+'"'));
});

test('modified data pointer prevents launch-pointer update and destructive maintenance',()=>{
 const {options,pack}=fixture(),a=pack('a'),b=pack('b');installAllmind({...options,packageRoot:a.root});installAllmind({...options,packageRoot:b.root,expectedManifest:b.digest});
 const before=readFileSync(join(options.installRoot,'current.txt'),'utf8');writeFileSync(join(options.installRoot,'data-root.txt'),'\ufeffdifferent data directory','utf16le');
 assert.throws(()=>installAllmind({...options,packageRoot:b.root}),/pointer was modified/);assert.throws(()=>rollbackAllmind(options),/pointer was modified/);assert.throws(()=>uninstallAllmind(options),/pointer was modified/);
 assert.equal(readFileSync(join(options.installRoot,'current.txt'),'utf8'),before);
});

test('legacy installation upgrades to a bound data directory while retaining its rollback slot',()=>{
 const {options,pack}=fixture(),a=pack('a'),b=pack('b');installAllmind({...options,packageRoot:a.root});
 const recordFile=join(options.installRoot,'install.json'),record=JSON.parse(readFileSync(recordFile,'utf8'));delete record.dataRoot;writeFileSync(recordFile,JSON.stringify(record));unlinkSync(join(options.installRoot,'data-root.txt'));
 const launcherFile=join(options.installRoot,'Start-ALLMIND.vbs'),launcher=readFileSync(launcherFile,'utf8');
 writeFileSync(launcherFile,launcher.replace(/Set stream=fso.OpenTextFile\(root & "\\data-root.txt",1,False,-1\)\r\ncurrent=stream.ReadAll\r\nstream.Close\r\ncommand=command & " --data " & Chr\(34\) & current & Chr\(34\)/,'If WScript.Arguments.Count > 0 Then command=command & " --data " & Chr(34) & WScript.Arguments(0) & Chr(34)'));
 installAllmind({...options,packageRoot:b.root,expectedManifest:b.digest});
 assert.equal(JSON.parse(readFileSync(recordFile,'utf8')).dataRoot,options.dataRoot);assert.equal(rollbackAllmind(options).version,'0.1.0-beta.1');assert.equal(uninstallAllmind(options).status,'uninstalled');assert.equal(existsSync(join(options.dataRoot,'private.json')),true);
});

test('CLI maintenance uses the saved custom data directory when the flag is omitted',{skip:process.platform!=='win32'},()=>{
 const {options,pack}=fixture(),a=pack('a'),b=pack('b');installAllmind({...options,packageRoot:a.root});installAllmind({...options,packageRoot:b.root,expectedManifest:b.digest});
 const script=fileURLToPath(new URL('../../tools/install-allmind.mjs',import.meta.url));
 const run=operation=>spawnSync(process.execPath,[script,operation,'--install-root',options.installRoot],{encoding:'utf8',windowsHide:true});
 let result=run('rollback');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).dataRoot,options.dataRoot);
 result=run('uninstall');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).dataPreserved,options.dataRoot);assert.equal(existsSync(join(options.dataRoot,'private.json')),true);
});
test('corrupt or unlisted package files are rejected before creating installation',()=>{
 const {options,pack}=fixture(),a=pack('a');writeFileSync(join(a.root,'runtime/node.exe'),'corrupt');assert.throws(()=>installAllmind({...options,packageRoot:a.root}),/integrity/);assert.equal(existsSync(options.installRoot),false);
 const b=pack('b');writeFileSync(join(b.root,'unexpected.txt'),'unlisted');assert.throws(()=>installAllmind({...options,packageRoot:b.root}),/unlisted/);assert.equal(existsSync(options.installRoot),false);
});
test('manifest path escape, Windows aliases and case collisions fail closed',()=>{
 for(const path of ['../escape','C:/escape','runtime/CON','runtime/name.','runtime\\node.exe','RUNTIME/NODE.EXE']){
  const {pack}=fixture(),a=pack('a'),file=join(a.root,'package-manifest.json'),manifest=JSON.parse(readFileSync(file,'utf8'));
  manifest.files.push({...manifest.files[1],path});writeFileSync(file,JSON.stringify(manifest));assert.throws(()=>verifyInstallPackage(a.root),/inventory|Duplicate/);
 }
});
test('overlap, unmanaged directories and occupied installer locks are never adopted or deleted',()=>{
 const {options,pack}=fixture(),a=pack('a');
 assert.throws(()=>installAllmind({...options,installRoot:options.dataRoot,packageRoot:a.root}),/separate/);
 mkdirSync(options.installRoot);writeFileSync(join(options.installRoot,'important.txt'),'keep');assert.throws(()=>installAllmind({...options,packageRoot:a.root}),/not empty/);assert.equal(readFileSync(join(options.installRoot,'important.txt'),'utf8'),'keep');
 const {options:other,pack:otherPack}=fixture(),b=otherPack('b');mkdirSync(other.installRoot);writeFileSync(join(other.installRoot,'.install.lock'),'someone else');assert.throws(()=>installAllmind({...other,packageRoot:b.root}),{code:'EEXIST'});assert.equal(readFileSync(join(other.installRoot,'.install.lock'),'utf8'),'someone else');
});
test('modified managed code or unknown staging data prevents destructive uninstall',()=>{
 const {options,pack}=fixture(),a=pack('a');installAllmind({...options,packageRoot:a.root});
 const slot=readFileSync(join(options.installRoot,'current.txt'),'utf8').trim(),code=join(options.installRoot,'versions',slot,'runtime/node.exe');writeFileSync(code,'user modified');
 assert.throws(()=>uninstallAllmind(options),/integrity/);assert.equal(readFileSync(code,'utf8'),'user modified');
 const {options:other,pack:otherPack}=fixture(),b=otherPack('b');installAllmind({...other,packageRoot:b.root});mkdirSync(join(other.installRoot,'versions','.staging-leftover'));assert.throws(()=>uninstallAllmind(other),/Unmanaged/);assert.equal(existsSync(join(other.installRoot,'Start-ALLMIND.vbs')),true);
});
test('live user-data owner prevents rollback and uninstall without touching code or data',()=>{
 const {options,pack}=fixture(),a=pack('a'),b=pack('b');installAllmind({...options,packageRoot:a.root});installAllmind({...options,packageRoot:b.root,expectedManifest:b.digest});
 mkdirSync(join(options.dataRoot,'host'));writeFileSync(join(options.dataRoot,'host/controller.json'),JSON.stringify({pid:process.pid}));
 assert.throws(()=>rollbackAllmind(options),/Exit ALLMIND/);assert.throws(()=>uninstallAllmind(options),/Exit ALLMIND/);assert.equal(existsSync(join(options.installRoot,'Start-ALLMIND.vbs')),true);
});
test('directory junction package members are rejected',()=>{
 const {directory,pack}=fixture(),a=pack('a');const outside=join(directory,'outside');mkdirSync(outside);symlinkSync(outside,join(a.root,'linked'),'junction');assert.throws(()=>verifyInstallPackage(a.root),/Linked/);
});
test('actual VBScript pointer reader accepts generated newline and rejects unsafe slots',{skip:process.platform!=='win32'},()=>{
 const {options,pack}=fixture(),a=pack('a');installAllmind({...options,packageRoot:a.root});
 const launcher=readFileSync(join(options.installRoot,'Start-ALLMIND.vbs'),'utf8');
 // Run the real pointer-reading prefix, stopping before any executable is launched.
 const validator=join(options.installRoot,'check-pointer.vbs');writeFileSync(validator,launcher.slice(0,launcher.indexOf('command=Chr(34)'))+'WScript.Echo slot\r\n');
 const run=()=>spawnSync('cscript.exe',['//nologo',validator],{encoding:'utf8',windowsHide:true});
 const valid=run();assert.equal(valid.status,0);assert.equal(valid.stdout.trim(),readFileSync(join(options.installRoot,'current.txt'),'utf8').trim());
 writeFileSync(join(options.installRoot,'current.txt'),'../not-a-version\n');const invalid=run();assert.match(invalid.stdout+invalid.stderr,/Invalid ALLMIND install pointer/);assert.equal(invalid.stdout.includes('not-a-version'),false);
});
test('CLI validates options before writing and emits Unicode result files',{skip:process.platform!=='win32'},()=>{
 const {directory,options,pack}=fixture(),a=pack('a'),script=fileURLToPath(new URL('../../tools/install-allmind.mjs',import.meta.url)),resultFile=join(directory,'结果.txt');
 const cli=(extra=[])=>spawnSync(process.execPath,[script,'install','--package',a.root,'--install-root',options.installRoot,'--data-root',options.dataRoot,...extra],{encoding:'utf8',windowsHide:true});
 for(const extra of [['--unknown','x'],['--install-root'],['--package',a.root]]){assert.notEqual(cli(extra).status,0);assert.equal(existsSync(options.installRoot),false);}
 writeFileSync(resultFile,'existing');assert.notEqual(cli(['--result-file',resultFile]).status,0);assert.equal(existsSync(options.installRoot),false);assert.equal(readFileSync(resultFile,'utf8'),'existing');
 const output=join(directory,'新的结果.txt'),ok=cli(['--result-file',output]);assert.equal(ok.status,0,ok.stderr);const bytes=readFileSync(output);assert.equal(bytes.subarray(0,2).toString('hex'),'fffe');assert.equal(JSON.parse(bytes.toString('utf16le').slice(1)).status,'installed');
});
