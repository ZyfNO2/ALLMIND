import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, openSync, fstatSync, closeSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

/** relative() can return a drive-qualified path when Windows volumes differ. */
export function isOutside(parent: string, target: string): boolean {
  const part = relative(resolve(parent), resolve(target));
  return part === '..' || part.startsWith('..' + sep) || isAbsolute(part);
}

// Shared SID policy for synchronous key reads and asynchronous metadata checks.
const aclPolicy = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = $PSHOME + '\\Modules'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
function Test-PrivateAcl($acl) {
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
# Elevated tokens can create files owned by their Administrators token owner.
# Admit that exact case, not arbitrary group owners or unelevated membership.
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$adminOwner = $owner -eq 'S-1-5-32-544' -and $owner -eq $identity.Owner.Value -and $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($owner -ne $sid.Value -and -not $adminOwner) { return 2 }
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { return 3 }
}
return 0
}
`;
// Pass paths as environment data, never PowerShell source or shell interpolation.
const aclScript = aclPolicy + `
$p = $env:AIKA_ACL_PATH
$acl = Get-Acl -LiteralPath $p
# Restriction can repair broad grants but must still verify the owner first.
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$adminOwner = $owner -eq 'S-1-5-32-544' -and $owner -eq $identity.Owner.Value -and $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($owner -ne $sid.Value -and -not $adminOwner) { exit 2 }
if ($env:AIKA_ACL_ACTION -eq 'restrict') {
  $item = Get-Item -LiteralPath $p -Force
  $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($id in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $ruleIdentity = [Security.Principal.SecurityIdentifier]::new($id)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($ruleIdentity, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($p, $acl) } else { [IO.File]::SetAccessControl($p, $acl) }
  $acl = Get-Acl -LiteralPath $p
}
exit (Test-PrivateAcl $acl)
`;
function windowsAcl(filename: string, action: 'check' | 'restrict'): void {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  try { execFileSync(win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10000, stdio: 'pipe', env: { ...process.env, AIKA_ACL_PATH: resolve(filename), AIKA_ACL_ACTION: action } }); }
  catch (error) {
    // Expose only fixed failure categories, never subprocess output, paths or file contents.
    const failure = error as { status?: number; code?: string };
    const reason = failure.status === 2 ? 'owner_mismatch'
      : failure.status === 3 ? 'broad_access'
      : failure.code === 'ETIMEDOUT' ? 'timeout' : 'powershell_failure';
    throw Error(`Windows could not verify or restrict this owned file (${reason}). Check its owner and access permissions.`);
  }
}
export function clearAclCache(): void {
  // Maintained for backward compatibility; both paths always verify live ACLs.
}

function privateFileMetadata(filename: string, opened?: Stats): Stats {
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Invalid private file');
    if (opened) {
      // Some Windows Node/libuv versions report dev=0 for path-based stat,
      // but a volume serial for fstat. Compare two handles on that platform;
      // never drop the device check or read credential contents.
      let identity = info;
      if (process.platform === 'win32' && info.dev !== opened.dev) {
        const fd = openSync(filename, 'r');
        try { identity = fstatSync(fd); } finally { closeSync(fd); }
      }
      if (identity.dev !== opened.dev || identity.ino !== opened.ino) throw Error('Private file identity changed');
    }
    return info;
}
/** Metadata only. No credential contents are read. Windows checks SID-based DACLs. */
export function isPrivateFileSync(filename: string, opened?: Stats): boolean {
  try {
    const info = privateFileMetadata(filename, opened);
    if (process.platform === 'win32') windowsAcl(filename, 'check');
    else if ((info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) return false;
    return true;
  } catch { return false; }
}

const aclBatchScript = aclPolicy + `
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$paths = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$results = @(foreach ($p in $paths) {
  try { (Test-PrivateAcl (Get-Acl -LiteralPath $p)) -eq 0 } catch { $false }
})
ConvertTo-Json -InputObject $results -Compress
`;
/** One asynchronous PowerShell process per batch; no permission cache or key reads. */
export async function isPrivateFiles(files: readonly { filename: string; opened?: Stats }[]): Promise<boolean[]> {
  const before = files.map(({filename, opened}) => {
    try { return privateFileMetadata(filename, opened); } catch { return undefined; }
  });
  const indexes = before.flatMap((info, i) => info ? [i] : []);
  const result = files.map(() => false);
  if (!indexes.length) return result;
  if (process.platform !== 'win32') return before.map(info => !!info && (info.mode & 0o077) === 0 && (!process.getuid || info.uid === process.getuid()));
  const paths = indexes.map(i => resolve(files[i]!.filename));
  let checked: boolean[];
  try {
    checked = await new Promise<boolean[]>((done, reject) => {
      const child = execFile(win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclBatchScript, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000, encoding: 'utf8' }, (error, stdout) => {
          if (error) { reject(Error('Windows private-file metadata verification failed')); return; }
          try {
            const value: unknown = JSON.parse(stdout);
            if (!Array.isArray(value) || value.length !== paths.length || value.some(v => typeof v !== 'boolean')) throw Error();
            done(value);
          } catch { reject(Error('Windows private-file metadata verification returned invalid results')); }
        });
      child.stdin!.on('error', () => reject(Error('Windows private-file metadata verification input failed')));
      child.stdin!.end(JSON.stringify(paths));
    });
  } catch { return result; } // Same fail-closed policy as isPrivateFileSync.
  indexes.forEach((i, n) => {
    try {
      // The await permits file replacement: recheck identity and metadata before admitting it.
      const after = privateFileMetadata(files[i]!.filename, files[i]!.opened), first = before[i]!;
      result[i] = checked[n]! && after.dev === first.dev && after.ino === first.ino
        && after.size === first.size && after.mtimeMs === first.mtimeMs && after.ctimeMs === first.ctimeMs;
    } catch { result[i] = false; }
  });
  return result;
}
/** Use only for files/directories created by this application or explicitly selected by the user. */
export function restrictPrivatePathSync(filename: string): void {
  const info = lstatSync(filename);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw Error('Expected an ordinary owned path');
  if (process.platform === 'win32') windowsAcl(filename, 'restrict');
  else chmodSync(filename, info.isDirectory() ? 0o700 : 0o600);
}
