import {renameSync} from 'node:fs';

/** Windows readers/antivirus can briefly deny replace. Never delete the old file or claim success. */
export function replaceResourceFile(temporary: string, target: string): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt=0;;attempt++) {
    try { renameSync(temporary,target); return; }
    catch (error) {
      const code=(error as NodeJS.ErrnoException).code;
      if (process.platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(code??'')||attempt>=4) throw error;
      process.stderr.write(`Resource replace temporarily denied (${code}); retry ${attempt+1}/4\n`);
      Atomics.wait(pause,0,0,25*(attempt+1));
    }
  }
}
