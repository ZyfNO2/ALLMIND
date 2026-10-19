const key = 'pet-management-session-v1'
let pending: Promise<string> | undefined

/** Recover this instance's session through its HttpOnly, navigation-issued cookie. */
export function managementSession(): Promise<string> {
  if (!pending) pending = fetch('/api/management-session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' }).then(async response => {
    if (!response.ok) throw Error('请在地址栏直接打开本机管理页面后重试。')
    const result = await response.json()
    if (typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token)) throw Error('本机管理会话无效。')
    sessionStorage.setItem(key, result.token)
    return result.token as string
  }).finally(() => { pending = undefined })
  return pending
}
