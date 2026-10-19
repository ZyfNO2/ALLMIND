import { managementSession } from './management-session'
export const tokenKey = 'pet-management-session-v1'
const hashToken = new URLSearchParams(location.hash.slice(1)).get('token')
if (hashToken) {
  sessionStorage.setItem(tokenKey, hashToken)
  history.replaceState(null, '', location.pathname + location.search)
}
export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message) }
}
export async function api<T>(route: string, options: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  let token = sessionStorage.getItem(tokenKey) || await managementSession()
  const binding = (options.body as { binding?: { kind?: string } } | undefined)?.binding
  const timeout = options.timeoutMs ?? (route === '/appearance/select' ? 310000 : route === '/models/test' ? binding?.kind === 'chatgpt-web' ? 165000 : 35000 : route.endsWith('/resume') ? 135000 : 80000)
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
  const send = (credential:string) => fetch('/api/memory-book/v1' + route, {
    method: options.method ?? 'GET', signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  let response = await send(token)
  // A 401 is rejected before route/body handling. Renew only the local navigation cookie;
  // never replay an accepted model request or relax origin/authentication checks.
  if(response.status===401&&!signal.aborted){sessionStorage.removeItem(tokenKey);token=await managementSession();response=await send(token)}
  const data = await response.json()
  if (!response.ok) throw new ApiError(data.error?.message ?? `请求失败 ${response.status}`, data.error?.code ?? 'request_failed', response.status)
  return data
}

/** Page shutdown releases volatile server context; only scope identifiers leave the page. */
export function releaseIncognito(characterId:string,sessionId:string):void {
  const token=sessionStorage.getItem(tokenKey);if(!token)return
  void fetch('/api/memory-book/v1/chat/incognito',{method:'DELETE',keepalive:true,credentials:'omit',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({characterId,sessionId})}).catch(error=>console.error('无痕上下文释放失败',error instanceof Error?error.name:'network_error'))
}
