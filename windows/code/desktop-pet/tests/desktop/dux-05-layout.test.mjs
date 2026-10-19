/**
 * DUX-05 · 桌面对话框位置、滚动与最小样式。
 *
 * 截图 5 的失败证据：任务卡（#work-card）是蓝灰配色（#f4f7fa/#d4dee9/#384656），与对话抽屉的
 * 淡紫体系（#FBF8FF/#E3D9F2/#9266AA）不统一。
 *
 * 目标（[DUX-05 SPEC](../../docs/next/ui-rework/specs/DUX-05.md)）：
 *   1. 任务卡与工程记录 dialog 采用同一淡紫体系（紧凑卡片，长文可折叠——折叠交互已存在）；
 *   2. fitDisplay 的几何约束在全 DPI/边缘/负坐标/窄 workArea 场景保持成立（既有级联结构不动）；
 *   3. 透明区域与 interactive regions：隐藏/未打开节点不拦桌面（既有机制回归保持）。
 *
 * 样式断言为源码级钉桩（桌面 renderer 无独立 DOM 测试环境——ui-harness.mjs 缺失是既有无关故障）；
 * 几何矩阵为纯函数级（真实 fitDisplay）；Electron 实机命中/截图 NOT RUN 转 DUX-07。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fitDisplay } from '../../desktop/electron/layout.mjs';

const css = () => readFileSync(resolve(import.meta.dirname, '../../desktop/style.css'), 'utf8');

test('DUX-05 任务卡与工程记录采用淡紫体系，不再使用蓝灰底色', () => {
  const style = css();
  // 抽屉的淡紫基准（既有）。
  assert.match(style, /#drawer\{[^}]*background:#FBF8FF/, '对话抽屉保持淡紫底');
  // 任务卡：底色/边框/正文色必须离开蓝灰体系（#f4f7fa/#d4dee9/#384656）。
  const card = style.match(/#work-card \{[^}]*\}/)?.[0] ?? '';
  assert.ok(card, '#work-card 规则必须存在');
  assert.doesNotMatch(card, /#f4f7fa|#d4dee9|#384656/i, `任务卡不得再用蓝灰体系：${card}`);
  assert.match(card, /#FBF8FF|#F5F0FB|#F0EAF9/i, '任务卡底色必须落在淡紫体系');
  // 工程记录 dialog 同步淡紫。
  const dialog = style.match(/#work-records-dialog\{[^}]*\}/)?.[0] ?? '';
  assert.ok(dialog, '#work-records-dialog 规则必须存在');
  assert.doesNotMatch(dialog, /#f6f9fe|#c3d3e9|#29476a|#334968/i, `工程记录不得再用蓝灰体系：${dialog}`);
  assert.match(dialog, /#FBF8FF|#F5F0FB|#F0EAF9/i, '工程记录底色必须落在淡紫体系');
  // 记录内条目底色同步（白/淡紫可读层次）。
  const content = style.match(/#work-records-content \.work-record[^{]*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(content, '记录条目规则必须存在');
});

test('DUX-05 几何矩阵：多 DPI/边缘/负坐标/窄 workArea 下 bounds 全部落在屏幕内且锚点不漂移', () => {
  // DPI 缩放对宿主是 workArea 的物理→逻辑换算结果；这里以不同逻辑尺寸+负坐标覆盖 100/125/150%
  // 的典型产物与四边/角锚定场景。
  const screens = [
    { x: 0, y: 0, width: 1920, height: 1040 },   // 100% 主屏
    { x: 0, y: 0, width: 1536, height: 832 },    // 125% 主屏（1920/1.25）
    { x: 0, y: 0, width: 1280, height: 693 },    // 150% 主屏（1920/1.5）
    { x: -1280, y: 0, width: 1280, height: 680 },// 负坐标副屏
    { x: 0, y: 0, width: 800, height: 560 },     // 窄 workArea
    { x: -640, y: -400, width: 640, height: 400 },// 负坐标双轴窄屏
  ];
  for (const screen of screens) {
    for (const [ax, ay] of [['left', 'top'], ['right', 'top'], ['left', 'bottom'], ['right', 'bottom'], ['center', 'center']]) {
      const anchor = {
        x: ax === 'left' ? screen.x + 60 : ax === 'right' ? screen.x + screen.width - 60 : screen.x + screen.width / 2,
        y: ay === 'top' ? screen.y + 60 : ay === 'bottom' ? screen.y + screen.height - 60 : screen.y + screen.height / 2,
      };
      for (const width of [280, 360, 420]) for (const open of [false, true]) {
        const fitted = fitDisplay(width, open, screen, anchor, width > 360 ? 'half' : 'full');
        assert.ok(fitted.bounds.x >= screen.x - 1, `bounds.x ${fitted.bounds.x} 越界（screen=${JSON.stringify(screen)} anchor=${ax}/${ay} w=${width} open=${open}）`);
        assert.ok(fitted.bounds.y >= screen.y - 1, `bounds.y ${fitted.bounds.y} 越界`);
        assert.ok(fitted.bounds.x + fitted.bounds.width <= screen.x + screen.width + 1, `bounds 右缘越界：${fitted.bounds.x + fitted.bounds.width}`);
        assert.ok(fitted.bounds.y + fitted.bounds.height <= screen.y + screen.height + 1, `bounds 下缘越界：${fitted.bounds.y + fitted.bounds.height}`);
        // 打开抽屉不改变锚点（模型位置保持）。
        const closed = fitDisplay(width, false, screen, anchor);
        const opened = fitDisplay(width, true, screen, closed.anchor);
        assert.deepEqual(opened.anchor, closed.anchor, `打开抽屉不得漂移锚点（anchor=${ax}/${ay}）`);
        // 透明窗口的布局配置里模型/抽屉矩形也必须落在 bounds 内（命中区域不越界）。
        const c = opened.config;
        for (const rect of [[c.petLeft, c.petTop, c.petWidth, c.modelHeight], [c.drawerLeft, c.drawerTop, c.drawerWidth, c.drawerHeight]]) {
          if (!rect[2]) continue;
          assert.ok(rect[0] >= -1 && rect[0] + rect[2] <= opened.bounds.width + 1, `布局矩形超出窗口：${JSON.stringify(rect)}`);
        }
      }
    }
  }
});

test('DUX-05 紧凑任务卡：长文折叠样式保留，可折叠交互不被样式重排破坏', () => {
  const style = css();
  // 既有折叠机制：正文预览 3 行截断 + 显式展开按钮。
  assert.match(style, /\.work-body-preview\{[^}]*-webkit-line-clamp:3/, '长文 3 行预览截断保留');
  assert.match(style, /\.work-full-toggle\{/, '展开全文按钮样式保留');
  // 卡片在 conversation 内不再二次滚动（外层单一滚动容器）。
  assert.match(style, /#conversation #work-card\{[^}]*overflow:visible/, '卡片随外层滚动，不内部滚动');
});
