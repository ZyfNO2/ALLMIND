/** One rectangle in image or canvas pixels. */
export interface PortraitBox { x: number; y: number; width: number; height: number }
export type PortraitFraming = 'full' | 'bust';

export interface PortraitPlacement {
  /** Source rectangle drawn from the original image. Bust crops a viewport; it does not edit the file. */
  source: PortraitBox;
  /** Where that source is painted. Full framing may extend past the canvas so transparent margins stay outside. */
  dest: PortraitBox;
  /** Opaque-content box in canvas pixels. Hit testing uses this, matching the fitted artwork. */
  contentDest: PortraitBox;
}

/**
 * Contain the opaque content, center it horizontally and pin it to the bottom.
 * Bust framing fits the upper 62% of that content and clips the rest in the viewport only.
 */
export function portraitPlacement(canvas: { width: number; height: number }, image: { width: number; height: number }, bounds: PortraitBox | undefined, framing: PortraitFraming = 'full'): PortraitPlacement {
  if (!(canvas.width > 0) || !(canvas.height > 0) || !(image.width > 0) || !(image.height > 0)) throw new Error('立绘画布或图片尺寸无效。');
  const content = bounds && bounds.width > 0 && bounds.height > 0 ? bounds : { x: 0, y: 0, width: image.width, height: image.height };
  if (content.x < 0 || content.y < 0 || content.x + content.width > image.width + 0.001 || content.y + content.height > image.height + 0.001) throw new Error('立绘内容范围超出原图。');
  const crop: PortraitBox = framing === 'bust'
    ? { x: content.x, y: content.y, width: content.width, height: Math.max(1, content.height * 0.62) }
    : { x: 0, y: 0, width: image.width, height: image.height };
  const fit = framing === 'bust' ? crop : content;
  const scale = Math.min(canvas.width / fit.width, canvas.height / fit.height);
  const fitWidth = fit.width * scale, fitHeight = fit.height * scale;
  const fitX = (canvas.width - fitWidth) / 2, fitY = canvas.height - fitHeight;
  const dest = framing === 'bust'
    ? { x: fitX, y: fitY, width: fitWidth, height: fitHeight }
    : { x: fitX - content.x * scale, y: fitY - content.y * scale, width: image.width * scale, height: image.height * scale };
  const contentDest = framing === 'bust' ? dest : { x: fitX, y: fitY, width: fitWidth, height: fitHeight };
  return { source: crop, dest, contentDest };
}

export function portraitHits(pointer: { x: number; y: number }, placement: PortraitPlacement): boolean {
  const box = placement.contentDest;
  return pointer.x >= box.x && pointer.x < box.x + box.width && pointer.y >= box.y && pointer.y < box.y + box.height;
}
