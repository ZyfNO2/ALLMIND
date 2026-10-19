/** Explicit static-only build capability; it never pretends to draw a Live2D model. */
export class JellyfishRenderer {
  constructor(){throw new Error('本构建未安装 Cubism SDK，支持静态立绘。使用 Live2D 请安装有权使用的 SDK 后重新构建。');}
}
