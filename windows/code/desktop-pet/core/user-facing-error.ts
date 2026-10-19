import { ProviderHttpError, ProviderRequestFailure } from '../providers/transport.js';
/** Keep provider/engineering diagnostics out of the user's error bubble. */
export function userFacingError(error:unknown):string {
  if(error instanceof ProviderHttpError && error.operation==='tts') {
    if(error.status===401||error.status===403)return '回复文字已保留，语音服务未接受当前凭据，请检查语音设置。';
    if(error.status===404)return '回复文字已保留，语音服务找不到这个模型或地址，请检查语音设置中的模型名与端点。';
    if(error.status===429)return '回复文字已保留，语音服务暂时繁忙，这次没有生成声音。';
    return '回复文字已保留，但语音生成失败，这次没有播放声音。';
  }
  const message=error instanceof Error?error.message:String(error);
  if(/MiniMax|audio hex/.test(message))return '回复文字已保留，但生成的语音未通过检查，这次没有播放声音。';
  if(/[\u3400-\u9fff]/.test(message))return message;
  if(/budget exhausted|budget cannot cover|reservation_exceeded|Budget is blocked/.test(message))return '剩余总预算不足以支付这次请求，请先查看费用记录。';
  if(/call limit|generation limit/.test(message))return '这次请求被旧试用配置拦住，请更新本地服务后再试。';
  // RUX-03: typed HTTP failures first. `ProviderHttpError.status` is the real supplier answer, so each
  // status can carry its own actionable hint without exposing the supplier response body.
  if(error instanceof ProviderHttpError){
    if(error.status===401)return '服务没有接受当前凭据（认证未通过，HTTP 401）。请确认 API Key 已保存、未过期，并且属于这个服务地址。';
    if(error.status===402)return '服务返回余额/额度不足（HTTP 402）。请到供应商控制台确认账户余额后重试。';
    if(error.status===403)return '服务拒绝了这次请求（权限不足，HTTP 403）。Key 可能无权访问这个模型或区域，请检查账号权限。';
    if(error.status===404)return '服务找不到这个模型或地址（HTTP 404）。请核对模型名拼写与端点地址，然后重新保存配置。';
    if(error.status===413)return '这次发送的内容超出服务允许的大小（HTTP 413）。请缩短输入后重试。';
    if(error.status===422||error.status===400)return '服务拒绝了请求参数（HTTP ' + error.status + '）。常见原因是模型名或参数不被该端点支持，请核对后重新保存。';
    // 429 needs evidence discipline: the transport only exposes the status, so the hint must NOT claim
    // quota vs rate-limit without proof. Name both and keep the uncertainty visible (Plan RUX-03).
    if(error.status===429)return '请求被限流或额度暂时用尽（HTTP 429）。请稍后再试；若持续出现，请到供应商控制台确认限流策略与剩余额度。';
    if(error.status>=500)return '模型服务暂时出错（HTTP ' + error.status + '），请稍后再试。';
  }
  if(/HTTP 401|HTTP 403/.test(message))return '模型服务没有接受当前凭据，请检查服务配置。';
  if(/HTTP 404/.test(message))return '服务找不到这个模型或地址（HTTP 404）。请核对模型名拼写与端点地址，然后重新保存配置。';
  if(/HTTP 429/.test(message))return '请求被限流或额度暂时用尽（HTTP 429）。请稍后再试；若持续出现，请到供应商控制台确认限流策略与剩余额度。';
  if(/HTTP 5[0-9][0-9]/.test(message))return '模型服务暂时出错，请稍后再试。';
  // RUX-03: request-stage failures (DNS refusal, TLS, socket reset) come through ProviderRequestFailure
  // with a preserved cause; distinguish the common families instead of one vague fallback.
  if(error instanceof ProviderRequestFailure){
    // The cause chain can be wrapped (fetch failure → underlying socket error), so walk it and test
    // every level's message and code against the known families.
    let cursor=error.cause as {code?:unknown;message?:string;cause?:unknown}|undefined;
    const texts:string[]=[error.message];
    for(let depth=0;cursor&&depth<4;depth++){
      if(typeof cursor.code==='string')texts.push(cursor.code);
      if(cursor.message)texts.push(cursor.message);
      cursor=cursor.cause as typeof cursor;
    }
    const chain=texts.join(' | ');
    if(/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(chain))return '无法解析服务地址（DNS 失败）。请确认网络可用、端点地址拼写正确，且不是仅限内网的地址。';
    if(/ECONNREFUSED/.test(chain))return '服务地址拒绝了连接（连接被拒）。如果这是本机服务，请确认它已经启动、端口正确。';
    if(/CERT|TLS|SSL|self-signed/i.test(chain))return '服务证书校验失败（TLS 错误）。自签名证书或代理拦截都会导致这个问题，请检查服务地址与网络环境。';
    if(/ETIMEDOUT|ECONNRESET|EPIPE|network/i.test(chain))return '连接服务时网络中断或超时。请检查网络后重试。';
    if(/Model did not return valid structured data/.test(error.message))return '模型返回了无法解析的内容。请重试；若持续出现，说明当前模型不适合这个任务，请换一个模型。';
  }
  if(/Provider API key is not configured/.test(message))return '还没有配置 API Key。请在模型页填写并保存 Key，然后重启使配置生效。';
  // RUX-03 (chain-loss follow-up, 2026-10-10): an internal provider/config invariant break is NOT
  // transient — retrying cannot fix it, so the honest message names the actionable repair instead
  // of the "try again later" fallback that misdirected the round-2 desktop-chat diagnosis.
  if(/Trial transport provider mismatch/.test(message))return '模型服务与登记的配置不一致。请到控制台重新保存模型设置，然后重启桌宠后再试。';
  if(/Explicit HTTPS provider endpoint/.test(message))return '服务地址无效：需要 HTTPS 端点（本机服务允许 http://127.0.0.1），并且必须填写模型名。';
  if(/fetch failed|NetworkError|Failed to fetch/i.test(message))return '无法连接服务地址。请检查网络与服务地址后重试。';
  if(/Model did not return valid structured data|Invalid provider response/.test(message))return '模型返回了无法解析的内容。请重试；若持续出现，说明当前模型不适合这个任务，请换一个模型。';
  if(/Incomplete provider completion|output was truncated|stream error/.test(message))return '模型回复中途被截断或流式传输失败。请重试；若持续出现，请检查该模型的输出限制。';
  if(/ASR|transcript/.test(message))return '这次语音转写没有完成，请重新说一次。';
  if(/scope|cancelled|Abort|stale/i.test(message))return '这次操作已取消。';
  if(/timeout|timed out/i.test(message))return '模型服务响应超时，请稍后再试。';
  if(/unknown.cost|Trial is stopped|not active/.test(message))return '服务暂时无法继续，请查看当前运行状态。';
  // RUX-03: the last resort keeps a stable, quotable phrase (regression tests pin this) and stays
  // honest — it does not guess a cause it cannot see.
  return '这一轮没有完成，请稍后再试。';
}
