/**
 * CK-11 host implementation of the closed `screen-target.capture` route.
 *
 * The caller supplies target identity and a byte ceiling only. The host resolves that identity from
 * the revision ledger populated by its own chooser, then asks Electron for that exact display.
 * This module does not accept caller-provided pixels, paths, HWNDs, or source names.
 *
 * Frozen contract: continuous frames above 1.5 MiB are refused. This module never resizes or
 * recompresses an oversized frame to make it appear compliant; dimensions and byte length describe
 * the exact image returned by Electron.
 */
const DISPLAY_PREFIX = 'display-';
const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

const reject = (code, message) => Object.assign(new Error(message), { code });
const fingerprint = display => JSON.stringify([
  display.bounds.x,
  display.bounds.y,
  display.bounds.width,
  display.bounds.height,
  Number(display.scaleFactor) || 1,
]);

export function dispatchScreenTargetCaptureRequest(value, { captureScreenTarget, hostReply, hostRefuse }) {
  if (!value || typeof value !== 'object' || value.method !== 'screen-target.capture') return false;
  const requestId = typeof value.requestId === 'string' ? value.requestId : '';
  if (!requestId) return true;
  const params = value.params && typeof value.params === 'object' ? value.params : {};
  void captureScreenTarget(params).then(
    result => hostReply(requestId, result),
    error => hostRefuse(requestId, error?.code ?? 'unavailable', error?.message ?? '屏幕捕获未完成。'),
  );
  return true;
}

export function createScreenTargetCapture({ screen, desktopCapturer, targets, now = () => new Date().toISOString() }) {
  if (!screen || typeof screen.getAllDisplays !== 'function'
      || !desktopCapturer || typeof desktopCapturer.getSources !== 'function'
      || !targets || typeof targets.get !== 'function') {
    throw new TypeError('screen capture host dependencies are required');
  }

  return async function captureScreenTarget(params) {
    const operationId = typeof params?.operationId === 'string' ? params.operationId.trim() : '';
    const targetId = typeof params?.targetId === 'string' ? params.targetId.trim() : '';
    const targetRevision = params?.targetRevision;
    const targetKind = params?.targetKind;
    const maxBytes = params?.maxBytes;

    if (!operationId || operationId.length > 200 || !targetId
        || !Number.isSafeInteger(targetRevision) || targetRevision < 1
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REQUEST_BYTES
        || !['image/png', 'image/bmp'].includes(params?.mimeType)) {
      throw reject('invalid_request', '捕获请求无效。');
    }
    if (!['screen', 'window', 'region'].includes(targetKind)) {
      throw reject('invalid_request', '不支持的捕获目标类型。');
    }
    // The current native chooser issues only display targets. Refuse other kinds; never coerce a
    // window/region request into a full-screen capture.
    if (targetKind !== 'screen') {
      throw reject('unsupported', '该宿主尚未实现窗口或区域捕获。');
    }
    if (params.mimeType !== 'image/png') {
      throw reject('unsupported', '该宿主只支持 PNG 捕获。');
    }

    const issued = targets.get(targetId);
    if (!issued) throw reject('invalid_request', '捕获目标不是本宿主签发的。');
    if (issued.revision !== targetRevision) {
      throw reject('stale_revision', '捕获目标版本已变化，请重新选择。');
    }

    const displayId = targetId.startsWith(DISPLAY_PREFIX) ? targetId.slice(DISPLAY_PREFIX.length) : '';
    const display = screen.getAllDisplays().find(candidate => String(candidate.id) === displayId);
    if (!display) throw reject('unavailable', '捕获目标对应的显示器已不存在。');
    if (issued.fingerprint !== fingerprint(display)) {
      throw reject('stale_revision', '显示器几何或 DPI 已变化，请重新选择。');
    }

    const pixelWidth = Math.max(1, Math.round(display.bounds.width * (Number(display.scaleFactor) || 1)));
    const pixelHeight = Math.max(1, Math.round(display.bounds.height * (Number(display.scaleFactor) || 1)));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: pixelWidth, height: pixelHeight },
      fetchWindowIcons: false,
    });
    const source = sources.find(candidate => String(candidate.display_id ?? '') === displayId);
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
      throw reject('unavailable', '宿主没有取得所选显示器的屏幕画面。');
    }

    const size = source.thumbnail.getSize();
    if (!Number.isSafeInteger(size.width) || size.width <= 0
        || !Number.isSafeInteger(size.height) || size.height <= 0) {
      throw reject('unavailable', '捕获画面尺寸无效。');
    }

    const bytes = source.thumbnail.toPNG();
    if (!bytes || bytes.length === 0) throw reject('unavailable', '宿主没有取得屏幕画面。');
    if (bytes.length > maxBytes) {
      const actualBytes = bytes.length;
      bytes.fill(0);
      throw reject('unavailable', `捕获画面 ${actualBytes} 字节超过 ${maxBytes} 字节上限。`);
    }

    const bytesBase64 = bytes.toString('base64');
    bytes.fill(0);
    return {
      outcome: 'captured',
      targetId,
      targetRevision,
      capturedAt: now(),
      mimeType: 'image/png',
      dimensions: { width: size.width, height: size.height },
      bytesBase64,
    };
  };
}
