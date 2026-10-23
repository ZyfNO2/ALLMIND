import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const RELEASE_GATES=['blank-install','upgrade','real-service','restore','security','file-integrity'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function regular(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Not a regular evidence/package file: '+path.basename(file));return stat;}
export function sourceInventory(root,paths){
 const files=[...new Set(paths)].filter(name=>!['validation/source-manifest.json','validation/release-status.json'].includes(name)).sort().flatMap(name=>{
  const full=path.resolve(root,name),relative=path.relative(path.resolve(root),full);if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw Error('Source inventory outside root');
  if(!fs.existsSync(full))return [];const stat=regular(full);return [{path:name.replaceAll('\\','/'),bytes:stat.size,sha256:sha(fs.readFileSync(full))}];
 });return {schemaVersion:'allmind-source-inventory/v1',sourceHash:sha(JSON.stringify(files)),files};
}
export function verifyPackage(root){
 const manifestFile=path.join(root,'package-manifest.json');regular(manifestFile);const raw=fs.readFileSync(manifestFile),manifest=JSON.parse(raw.toString('utf8'));
 if(!Array.isArray(manifest.files)||new Set(manifest.files.map(row=>row.path)).size!==manifest.files.length)throw Error('Invalid package inventory');
 const actual=new Set();function walk(base){for(const entry of fs.readdirSync(base)){const full=path.join(base,entry),stat=fs.lstatSync(full);if(stat.isSymbolicLink())throw Error('Linked package member');if(stat.isDirectory())walk(full);else if(stat.isFile())actual.add(path.relative(root,full).replaceAll('\\','/'));else throw Error('Unsupported package member');}}walk(root);
 for(const row of manifest.files){if(typeof row.path!=='string'||row.path.includes('\\')||row.path.startsWith('/')||row.path.split('/').some(part=>!part||part==='.'||part==='..')||!Number.isSafeInteger(row.bytes)||row.bytes<0||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('Unsafe package member');const target=path.resolve(root,row.path),relative=path.relative(root,target);if(path.isAbsolute(relative)||relative.startsWith('..'+path.sep))throw Error('Package member outside root');const stat=regular(target);if(stat.size!==row.bytes||sha(fs.readFileSync(target))!==row.sha256)throw Error('Package integrity mismatch: '+row.path);actual.delete(row.path);}
 actual.delete('package-manifest.json');if(actual.size)throw Error('Unlisted package files; data or generated artifacts may have entered the candidate');return {manifestSha256:sha(raw),files:manifest.files.length,sourceHash:manifest.sourceHash??null};
}
export function evaluateReleaseGate({evidence,currentSourceHash,packageRoot,evidenceRoot}){
 if(evidence?.schemaVersion!=='allmind-release-evidence/v1'||!evidence.gates||typeof evidence.gates!=='object'||Object.keys(evidence.gates).some(key=>!RELEASE_GATES.includes(key)))throw Error('Invalid release evidence index');
 const results=[];let inventory;try{inventory=verifyPackage(packageRoot);}catch(error){results.push({id:'package-inventory',status:'FAIL',reason:error.message});}
 const sourceValid=/^[a-f0-9]{64}$/.test(currentSourceHash)&&evidence.sourceHash===currentSourceHash&&inventory?.sourceHash===currentSourceHash;
 results.push({id:'source-binding',status:sourceValid?'PASS':'FAIL',reason:sourceValid?'Current source, package and evidence identify the same inventory.':'Source/package/evidence mismatch or missing source binding; historical tests cannot certify this candidate.'});
 for(const gate of RELEASE_GATES){const selected=evidence.gates[gate];
  if(!selected){results.push({id:gate,status:'NOT_RUN',reason:'No evidence selected.'});continue;}
  try{if(typeof selected.path!=='string'||!/^[a-f0-9]{64}$/.test(selected.sha256))throw Error('Missing evidence path/hash');const file=path.resolve(evidenceRoot,selected.path),relative=path.relative(path.resolve(evidenceRoot),file);if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw Error('Evidence outside declared evidence directory');if(regular(file).size>8*1024*1024)throw Error('Evidence record too large');const raw=fs.readFileSync(file);if(sha(raw)!==selected.sha256)throw Error('Evidence record changed');const record=JSON.parse(raw.toString('utf8'));
   if(record.gate!==gate||record.sourceHash!==currentSourceHash||!['PASS','FAIL','BLOCKED','NOT_RUN','DEFERRED'].includes(record.status))throw Error('Evidence gate/source/status mismatch');
   if(record.status==='PASS'){
    if(!Number.isSafeInteger(record.checks)||record.checks<1||!Array.isArray(record.artifacts)||!record.artifacts.length)throw Error('PASS requires checks and preserved subordinate evidence');
    for(const artifact of record.artifacts){if(typeof artifact.path!=='string'||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw Error('Invalid subordinate evidence');const target=path.resolve(evidenceRoot,artifact.path),part=path.relative(path.resolve(evidenceRoot),target);if(path.isAbsolute(part)||part==='..'||part.startsWith('..'+path.sep))throw Error('Subordinate evidence outside directory');regular(target);if(sha(fs.readFileSync(target))!==artifact.sha256)throw Error('Subordinate evidence changed');}
    if(gate==='real-service'&&(record.realService!==true||record.fixture!==false||!Number.isSafeInteger(record.modelSubmissions)||record.modelSubmissions<1))throw Error('A fixture/readiness-only check is not real-service acceptance');
   }results.push({id:gate,status:record.status,reason:record.scope??'Scope not described in the record.'});
  }catch(error){results.push({id:gate,status:'FAIL',reason:error.message});}
 }
 const mandatoryPassed=results.every(row=>row.status==='PASS'),manual=evidence.manual??{},native=manual.native?.status??'NOT_RUN',signing=manual.signing?.status??'NOT_RUN';
 return {schemaVersion:'allmind-release-gate/v1',at:new Date().toISOString(),sourceHash:currentSourceHash,package:inventory??null,checks:results,manual,candidateStatus:mandatoryPassed?'PASS':results.some(row=>row.status==='FAIL')?'FAIL':'BLOCKED',eligibleForLocalBeta:mandatoryPassed,publicDistributionReady:mandatoryPassed&&native==='PASS'&&signing==='PASS',note:'Local automated/real-service gates do not replace physical device/native acceptance or publisher signing/SmartScreen reputation. No publication is performed.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const flag=name=>{const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1]??null;},root=path.resolve(flag('--source')??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..')),output=flag('--output');if(!output)throw Error('Specify --output <new evidence file>; modes: snapshot or verify');if(fs.existsSync(output))throw Error('Output exists; preserve it and select a new filename.');
 const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root}).toString().split('\0').filter(Boolean),source=sourceInventory(root,paths);
 if(process.argv[2]==='snapshot'){fs.writeFileSync(output,JSON.stringify(source,null,2)+'\n');console.log(JSON.stringify({sourceHash:source.sourceHash,files:source.files.length}));}
 else if(process.argv[2]==='verify'){const file=flag('--evidence'),pkg=flag('--package');if(!file||!pkg)throw Error('verify requires --evidence and --package');const report=evaluateReleaseGate({evidence:JSON.parse(fs.readFileSync(file,'utf8')),currentSourceHash:source.sourceHash,packageRoot:path.resolve(pkg),evidenceRoot:path.dirname(path.resolve(file))});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({candidateStatus:report.candidateStatus,eligibleForLocalBeta:report.eligibleForLocalBeta,publicDistributionReady:report.publicDistributionReady}));if(!report.eligibleForLocalBeta)process.exitCode=1;}
 else throw Error('Unknown mode: use snapshot or verify');
}
