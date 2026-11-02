/**
 * 手机上的追踪栏：从底部拉起的面板。
 * 桌面上它是普通的侧栏；收起 / 展开、遮罩和 inert 只在窄屏生效。
 *
 * - 点把手开关，也可以按住把手上下拖；
 * - 展开时背后有一层浅遮罩（只变暗、不挡点击），点面板外的空白处或按 Esc 收起；
 * - 收起时面板内容设为 inert，Tab 不会跳进屏幕外看不见的表单。
 */
import { $ } from './dom';

const MOBILE = '(max-width: 720px)';
/** 拖动超过这个距离才算要开 / 关；不到就弹回原状 */
const OPEN_PULL = 40;
const CLOSE_PULL = 70;

export class BottomSheet {
  private readonly root = $('tracker');
  private readonly handle = $<HTMLButtonElement>('sheetHandle');
  private readonly body = $('trackerBody');
  private readonly back = $('sheetBack');
  private readonly mq: MediaQueryList | undefined = window.matchMedia?.(MOBILE);
  private drag: { id: number; y: number; dy: number; moved: boolean; wasOpen: boolean } | null = null;
  /** 窄屏上展开时整块盖住地图：地图可以暂停动画 */
  onCoverChange?: (covering: boolean) => void;
  /** 拖动结束后浏览器还会补发一次 click（触屏上可能晚一些），这段时间内的 click 不再切换 */
  private skipClickUntil = 0;

  constructor() {
    this.handle.addEventListener('click', () => {
      if (performance.now() < this.skipClickUntil) {
        this.skipClickUntil = 0;
        return;
      }
      this.toggle();
    });
    // 遮罩只负责变暗、不拦截点击：顶栏的「新建」「晚间结算」等按钮在面板展开时照常可用；
    // 点在面板外的空白处（不是按钮、输入框、地图这类本身可操作的东西）才收起面板。
    document.addEventListener('click', (e) => {
      if (!this.mobile() || !this.isOpen()) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || this.root.contains(target)) return;
      if (target.closest('button, a, input, select, textarea, label, summary, canvas, [role="menu"], #toast, .dlg-back, .settle, .ceremony')) return;
      this.close();
    });
    this.handle.addEventListener('pointerdown', (e) => this.onDown(e));
    this.handle.addEventListener('pointermove', (e) => this.onMove(e));
    this.handle.addEventListener('pointerup', (e) => this.onUp(e));
    this.handle.addEventListener('pointercancel', () => this.endDrag());
    this.mq?.addEventListener?.('change', () => this.sync());
    document.addEventListener('keydown', (e) => {
      // 有对话框等遮罩层时 Esc 归它们；这里只处理面板本身。
      if (e.key !== 'Escape' || !this.mobile() || !this.isOpen() || document.documentElement.classList.contains('layer-open')) return;
      this.close();
      this.handle.focus({ preventScroll: true });
    });
    this.sync();
  }

  private mobile(): boolean {
    return this.mq?.matches ?? false;
  }

  isOpen(): boolean {
    return this.root.classList.contains('open');
  }

  open() {
    this.root.classList.add('open');
    this.sync();
  }

  close() {
    this.root.classList.remove('open');
    this.sync();
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }

  private sync() {
    const mobile = this.mobile();
    const open = this.isOpen();
    this.handle.setAttribute('aria-expanded', String(!mobile || open));
    this.body.inert = mobile && !open;
    this.back.hidden = !(mobile && open);
    this.onCoverChange?.(mobile && open);
  }

  /* ---------------- 拖动 ---------------- */

  private onDown(e: PointerEvent) {
    if (!this.mobile() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    this.drag = { id: e.pointerId, y: e.clientY, dy: 0, moved: false, wasOpen: this.isOpen() };
  }

  private onMove(e: PointerEvent) {
    const g = this.drag;
    if (!g || e.pointerId !== g.id) return;
    g.dy = e.clientY - g.y;
    if (!g.moved) {
      if (Math.abs(g.dy) < 6) return;
      g.moved = true;
      this.root.classList.add('dragging');
      try {
        this.handle.setPointerCapture(e.pointerId);
      } catch {
        /* 指针已经离开：照常按位移结算 */
      }
    }
    // 只跟随朝「另一种状态」的方向：展开时往下拖，收起时往上拖。
    this.root.style.transform = g.wasOpen
      ? `translateY(${Math.max(0, g.dy)}px)`
      : `translateY(calc(100% - var(--sheet-peek) + ${Math.min(0, g.dy)}px))`;
  }

  private onUp(e: PointerEvent) {
    const g = this.drag;
    if (!g || e.pointerId !== g.id) return;
    const moved = g.moved;
    const dy = g.dy;
    this.endDrag();
    if (!moved) return;
    // 只吞掉紧跟着的那次 click；之后真正的点击照常切换。
    this.skipClickUntil = performance.now() + 450;
    if (g.wasOpen && dy > CLOSE_PULL) this.close();
    else if (!g.wasOpen && dy < -OPEN_PULL) this.open();
  }

  private endDrag() {
    this.drag = null;
    this.root.classList.remove('dragging');
    this.root.style.transform = '';
  }
}
