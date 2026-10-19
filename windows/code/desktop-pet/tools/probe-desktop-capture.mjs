#!/usr/bin/env node
/**
 * tools/probe-desktop-capture.mjs
 *
 * CK-11 real-environment probe: does this machine's Electron host actually expose capturable
 * screen sources, and at what real resolution?
 *
 * This is measurement, not a test. It exists because CK-11's capture route was never implemented
 * host-side, and the design of that route depends on facts that cannot be assumed:
 *   - whether `desktopCapturer.getSources` works in the main process on this Electron version;
 *   - whether a thumbnail can be requested at the display's REAL pixel size (a downscaled
 *     thumbnail would silently make OCR evidence meaningless);
 *   - what `toPNG()` actually returns for size and byte count against the frozen 1.5 MiB ceiling.
 *
 * Writes one JSON line to stdout and exits. It captures only if `--allow-capture` is passed, and
 * it never writes any image to disk: the pixels are measured and then dropped.
 */
// Electron's ESM named exports are only wired up for its own loader; a directly-run .mjs entry gets
// the CommonJS module object instead. createRequire works in both cases.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScreenTargetCapture, dispatchScreenTargetCaptureRequest } from '../desktop/electron/screen-capture.mjs';
import { DesktopHostBridge } from '../dist/app/desktop-host-bridge.js';
import { WindowsScreenCapture } from '../dist/core/windows-screen-capture.js';
const { app, desktopCapturer, screen } = createRequire(import.meta.url)('electron');

const allowCapture = process.argv.includes('--allow-capture');
const report = {
  probe: 'desktop-capture',
  electron: process.versions.electron,
  targetIssuance: 'isolated probe seeds the host target-revision ledger from real display metadata; native chooser UI is not exercised',
  ok: false, displays: [], sources: [], error: null,
};

app.whenReady().then(async () => {
  try {
    report.displays = screen.getAllDisplays().map(display => ({
      id: String(display.id),
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      // The real pixel size, which is what a full-fidelity capture must reproduce.
      pixelWidth: Math.round(display.bounds.width * display.scaleFactor),
      pixelHeight: Math.round(display.bounds.height * display.scaleFactor),
    }));

    // Enumerate metadata with a 1x1 thumbnail only. The real-size pixel request, if explicitly
    // authorized, is made once through the production host route below.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });

    report.sources = sources.map(source => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id ?? null,
      metadataThumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.getSize() : 'empty',
    }));
    if (allowCapture && report.displays.length > 0) {
      const display = screen.getAllDisplays()[0];
      const targetId = `display-${String(display.id)}`;
      const scaleFactor = Number(display.scaleFactor) || 1;
      const bounds = { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height };
      const targetFingerprint = JSON.stringify([bounds.x, bounds.y, bounds.width, bounds.height, scaleFactor]);
      const targets = new Map([[targetId, { fingerprint: targetFingerprint, revision: 1 }]]);
      const captureScreenTarget = createScreenTargetCapture({ screen, desktopCapturer, targets });
      let bridge;
      bridge = new DesktopHostBridge({ send: message => {
        const handled = dispatchScreenTargetCaptureRequest(message, {
          captureScreenTarget,
          hostReply: (requestId, value) => bridge.receive({ channel: 'host_reply', requestId, ok: true, result: value }),
          hostRefuse: (requestId, code, detail) => bridge.receive({
            channel: 'host_reply', requestId, ok: false, error: { code, message: detail },
          }),
        });
        if (!handled) throw new Error('production host did not recognize screen-target.capture');
      } });
      const captureAdapter = new WindowsScreenCapture({ bridge });
      try {
        const frame = await captureAdapter.capture({
          targetId, targetRevision: 1, kind: 'screen', displayName: 'CK-11 isolated probe', bounds, isValid: true,
        });
        report.productionRoute = {
          outcome: 'captured',
          targetId: frame.targetId,
          targetRevision: frame.targetRevision,
          capturedAt: frame.capturedAt,
          dimensions: frame.dimensions,
          byteLength: frame.bytes.length,
          pngMagic: Buffer.from(frame.bytes.subarray(0, 4)).toString('hex'),
        };
        frame.bytes.fill(0);
      } catch (error) {
        report.productionRoute = {
          outcome: 'refused',
          code: error?.code ?? null,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      report.productionBridge = { hostAnswered: bridge.hostAnswered, inFlight: bridge.inFlight };
      bridge.close();
    }
    report.ok = report.sources.length > 0 && (!allowCapture || !!report.productionRoute);
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  if (allowCapture && report.ok) {
    // Evidence is metadata only. Never serialize frame bytes or the screen image itself.
    const evidencePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/next/companion-knowledge/evidence/ck11-electron-capture-real.json');
    report.evidencePath = 'docs/next/companion-knowledge/evidence/ck11-electron-capture-real.json';
    writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'w' });
  }
  process.stdout.write(JSON.stringify(report) + '\n');
  app.exit(report.ok ? 0 : 1);
}).catch(error => {
  process.stdout.write(JSON.stringify({ ...report, error: String(error) }) + '\n');
  app.exit(1);
});