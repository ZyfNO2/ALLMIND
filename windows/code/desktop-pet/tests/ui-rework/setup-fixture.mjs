/**
 * LUI-01 first-run fixture: the REAL production setup server.
 *
 * `startFirstRunSetup` is the same entry point the packaged app uses, so the page under test talks to
 * a real `createSelfSetup` over real loopback HTTP with a temporary restricted credential directory.
 * Only the cloud provider is a fixture: `options.fetch` answers the DashScope/MiniMax wire calls with
 * synthetic bytes and records every address it was asked to reach, which is what lets a test prove
 * "zero cloud calls" instead of assuming it.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFirstRunSetup } from '../../dist/app/self-setup.js'
import { pcm16Wav } from '../../dist/media/wav.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const codeRoot = resolve(here, '../..')

export function syntheticFetcher() {
  const calls = []
  let refusal = false
  const fetcher = async (url, init = {}) => {
    const address = String(url)
    calls.push(address)
    if (address.includes('/uploads?')) return Response.json({ data: { upload_host: 'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com/', upload_dir: 'dashscope-instant/fixture', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true', expire_in_seconds: 3600, policy: 'synthetic-policy', signature: 'synthetic-signature', oss_access_key_id: 'synthetic-oss' } })
    if (address.includes('dashscope-file-mgr')) return new Response('')
    if (address.includes('demo.mp3')) return new Response('ID3synthetic')
    if (refusal) return new Response('', { status: 403 })
    const body = JSON.parse(String(init.body))
    return body.input.action === 'voice_clone'
      ? Response.json({ output: { base_resp: { status_code: 0 }, input_sensitive: false, input_sensitive_type: 0, demo_audio: 'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/demo.mp3?Signature=synthetic-private' }, usage: { characters: 3 } })
      : Response.json({ output: { base_resp: { status_code: 0 }, data: { status: 2, audio: Buffer.from(pcm16Wav(new Float32Array(2400), 24000)).toString('hex') } }, usage: { characters: 3 } })
  }
  return {
    calls,
    fetcher: fetcher,
    setRefusal: value => { refusal = value },
  }
}

/**
 * The SPA artifact is a separate build (`npm run build:character-ui`). `uiRoot` points at the
 * management directory that CONTAINS `character-app/`, so `/setup` is served by the same static
 * router production uses.
 */
export async function setupFixture(t, { uiRoot = resolve(codeRoot, 'management') } = {}) {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'lui01-setup-')))
  const root = resolve(directory, 'project')
  await mkdir(root)
  const cloud = syntheticFetcher()
  const options = { credentialDirectory: resolve(directory, 'keys'), fetch: cloud.fetcher, uiRoot }
  let service = await startFirstRunSetup(root, options)
  t.after(async () => {
    await service.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  const request = async (path = '', body, method) => {
    const response = await fetch(service.origin + '/api/self-setup' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { Authorization: 'Bearer ' + service.token, ...(body ? { Origin: service.origin, 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, value: await response.json() }
  }
  return {
    directory, root, options, request, cloud,
    get service() { return service },
    origin: () => service.origin,
    token: () => service.token,
    snapshot: async () => (await request()).value,
    // 24 kHz mono: `durationMs` milliseconds need `durationMs * 24` samples at 24 000 samples/second.
    // 24 kHz mono: `durationMs` milliseconds need `durationMs * 24` samples at 24 000 samples/second.
    referenceBytes: durationMs => Buffer.from(pcm16Wav(new Float32Array(Math.round(durationMs * 24)), 24000)),
  }
}
