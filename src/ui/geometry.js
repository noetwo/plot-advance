import { getSettings, save } from '../core/settings.js';
import { sharedState } from '../core/state.js';
import { autoGrowInput } from '../modes/chat/history.js';

/* ------------------------------------------------------------------ *
 * Window dragging + resize persistence
 * ------------------------------------------------------------------ */
// Clamp the window into the viewport on first open, sized so it always fits the
// screen (so phones never get a window wider/taller than the display). On a small
// screen with no saved position, drop it near the top, horizontally centered.
export function applyInitialGeometry(s) {
    const margin = 8;
    const w = Math.max(300, Math.min(s.winWidth || 380, window.innerWidth - margin * 2));
    const h = Math.max(320, Math.min(s.winHeight || 540, window.innerHeight - margin * 2));
    sharedState.win.style.width = `${w}px`;
    sharedState.win.style.height = `${h}px`;
    if (s.winLeft != null && s.winTop != null) {
        // 与拖动共用 clampDragPos：存档里若是旧版拖出去的坏坐标（只保 60×40），这里一并纠回「至少留 140×48」。
        const p = clampDragPos({ left: s.winLeft, top: s.winTop, width: w, height: h },
            { w: window.innerWidth, h: window.innerHeight });
        sharedState.win.style.left = `${p.left}px`;
        sharedState.win.style.top = `${p.top}px`;
        sharedState.win.style.right = 'auto';
    } else if (window.innerWidth < 600) {
        // 手机首次开窗（无存档几何）：居中（含纵向），标题栏不再贴顶被状态栏 / 刘海挡住
        //（用户反馈：手机版按钮挤在最顶上、不好戳）。仅无存档几何时；用户拖过就尊重其位置。
        const c = centeredWindowBox(currentView(), { width: w, height: h });
        sharedState.win.style.left = `${c.left}px`;
        sharedState.win.style.top = `${c.top}px`;
        sharedState.win.style.width = `${c.width}px`;
        sharedState.win.style.height = `${c.height}px`;
        sharedState.win.style.right = 'auto';
    } // else: desktop keeps the CSS default (top:70px right:20px)
}

// 把一个窗口盒子夹进【可见】视口（visualViewport），保证整窗——尤其顶部带 ✕ 关闭 / 拖动把手的
// 标题栏——始终在屏内。纯函数、可单测：box={left,top,width,height}（CSS 像素），view={w,h,offX,offY}
//（offX/offY 是手机键盘弹出时 visualViewport 的偏移，桌面为 0）。先按可见区给宽高封顶，再夹 left/top。
function clampWindowBox(box, view) {
    const margin = 8, minW = 300, minH = 320;
    const offX = view.offX || 0, offY = view.offY || 0;
    const width = Math.max(minW, Math.min(box.width, view.w - margin * 2));
    const height = Math.max(minH, Math.min(box.height, view.h - margin * 2));
    const left = Math.max(offX + margin, Math.min(box.left, offX + view.w - width - margin));
    const top = Math.max(offY + margin, Math.min(box.top, offY + view.h - height - margin));
    return { left, top, width, height };
}

// 纯函数：把一个盒子【居中】进【可见】视口并把尺寸夹进视口，返回 {left,top,width,height}（CSS 像素）。
// clampWindowBox 的姊妹（同 margin/minW/minH），但这里是【主动居中到默认几何】而非就地夹取：用于手机
// 首次开窗居中（applyInitialGeometry）与魔棒菜单「窗口归位」一键复位（recenterWindow）。view={w,h,offX,offY}
//（offX/offY = 软键盘弹出时 visualViewport 偏移，缺省 0）；opts.width/height 缺省 380×540（与初始默认一致）。
// 单测 window-recenter.test.mjs。
export function centeredWindowBox(view, opts) {
    const margin = 8, minW = 300, minH = 320;
    const v = view || {};
    const vw = v.w || 0, vh = v.h || 0, offX = v.offX || 0, offY = v.offY || 0;
    const width = Math.max(minW, Math.min((opts && opts.width) || 380, vw - margin * 2));
    const height = Math.max(minH, Math.min((opts && opts.height) || 540, vh - margin * 2));
    const left = offX + Math.max(margin, Math.round((vw - width) / 2));
    const top = offY + Math.max(margin, Math.round((vh - height) / 2));
    return { left, top, width, height };
}

// 全屏阅读模式（1.51.0，用户功能请求·手机）。纯几何：把【可见】视口原样变成一个铺满盒子
// （left/top 跟随 visualViewport 的可见原点，故软键盘弹出时也贴着可见区）。缺字段按 0。
// 与 clampWindowBox / centeredWindowBox 同族的纯函数，单测 fullscreen.test.mjs。
function fullscreenBox(view) {
    const v = view || {};
    return { left: v.offX || 0, top: v.offY || 0, width: v.w || 0, height: v.h || 0 };
}

// ESC 分层的纯判定：全屏时按 ESC 该不该退出。仅当【全屏】且没有更近的可关 UI（⋯ 工具菜单 /
// ✂️ 选段卡 / 聚焦中的编辑框）抢走这次 ESC 时才退出。薄 DOM 处理器读这些布尔再调本函数。
function fullscreenEscShouldExit(state) {
    return !!(state && state.fullscreen && !state.toolsMenuOpen && !state.fixselOpen && !state.editorFocused);
}

// 把当前窗口重新夹回可见视口（开窗 / 旋屏 / 键盘弹收时调用）。宽高基准取「用户存的几何」或与
// applyInitialGeometry 一致的默认（380×540），这样键盘压扁后收起还能长回原尺寸。【不 save()】——
// 这只是临时贴合显示，不覆盖用户拖 / 拽存下来的几何。
export function ensureWindowInView() {
    if (!sharedState.win || sharedState.win.style.display === 'none') return;
    if (sharedState.win.classList.contains('so-fullscreen')) { fitFullscreen(); autoGrowInput(); return; }   // 全屏：铺满可见视口，跳过夹取
    autoGrowInput();                                        // #4 窗口尺寸变化时重算输入框高度上限（上限=窗口高度一半）
    const s = getSettings();
    const view = currentView();
    const r = sharedState.win.getBoundingClientRect();
    const box = {
        left: (s.winLeft != null) ? s.winLeft : r.left,
        top: (s.winTop != null) ? s.winTop : r.top,
        width: s.winWidth || 380,
        height: s.winHeight || 540,
    };
    const c = clampWindowBox(box, view);
    sharedState.win.style.width = `${c.width}px`;
    sharedState.win.style.height = `${c.height}px`;
    sharedState.win.style.left = `${c.left}px`;
    sharedState.win.style.top = `${c.top}px`;
    sharedState.win.style.right = 'auto';
}

// 全屏阅读模式的尺寸器：把 #so-window 铺满【可见】视口（visualViewport-aware，故手机软键盘弹出时
// 是缩小而非把输入框藏到键盘后面）。只写内联几何、【绝不 save()】——用户拖/拽存下的悬浮窗几何
// （winLeft/winTop/winWidth/winHeight）原样保留，退出全屏即复原。经 ensureWindowInView 的全屏分支
// 触达，故 resize/旋屏/键盘等视口变化都会自动保持铺满。单测 fullscreen.test.mjs。
function fitFullscreen() {
    const el = sharedState.win || document.getElementById('so-window');
    if (!el) return;
    const vv = window.visualViewport;
    const box = fullscreenBox({
        w: (vv && vv.width) || window.innerWidth,
        h: (vv && vv.height) || window.innerHeight,
        offX: (vv && vv.offsetLeft) || 0,
        offY: (vv && vv.offsetTop) || 0,
    });
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.right = 'auto';
}

// 变形标题栏的全屏按钮：展开 ⇄ 收缩图标 + 中文标签 + aria-pressed。按 id 直取（id 唯一）。
function updateFullscreenBtn(on) {
    const btn = document.getElementById('so-fullscreen-btn');
    if (!btn) return;
    const icon = btn.querySelector('i');
    if (icon) icon.className = on
        ? 'fa-solid fa-down-left-and-up-right-to-center'   // 收缩（退出全屏）
        : 'fa-solid fa-up-right-and-down-left-from-center'; // 展开（进入全屏）
    const label = on ? '退出全屏' : '全屏';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// 进入全屏前的内联几何快照（仅内存 module 变量、【绝不落盘】）：退出时逐字还原它才能复原【从未拖过】的窗口
// —— 那种窗口 winLeft/winTop=null、靠 CSS `top:70px right:20px` 定位，若走 ensureWindowInView 的
// `s.winLeft ?? r.left` 复原路径，退出时 r.left 还是全屏的 0 → 窗口被算到左上角(8,8)而非原位（真机 smoke 逮到）。
sharedState._soPreFsGeom = null;

// 全屏阅读模式的唯一写入口。on 省略=切换。显示级切换、会话内瞬态、【绝不落盘】。
export function setFullscreen(on) {
    const el = sharedState.win || document.getElementById('so-window');
    if (!el) return;
    const cur = el.classList.contains('so-fullscreen');
    const next = (on === undefined) ? !cur : !!on;
    if (next === cur) { updateFullscreenBtn(next); return; }   // 已是该态：别重复快照（否则会把全屏几何存成"悬浮"快照）
    if (next) {
        sharedState._soPreFsGeom = { left: el.style.left, top: el.style.top, right: el.style.right, width: el.style.width, height: el.style.height };
        el.classList.add('so-fullscreen');
        updateFullscreenBtn(true);
        fitFullscreen();                                       // 铺满可见视口
    } else {
        el.classList.remove('so-fullscreen');
        updateFullscreenBtn(false);
        if (sharedState._soPreFsGeom) {                                    // 逐字还原进入前的内联样式（含"无 left/top、纯 CSS 定位"的默认态）
            el.style.left = sharedState._soPreFsGeom.left;
            el.style.top = sharedState._soPreFsGeom.top;
            el.style.right = sharedState._soPreFsGeom.right;
            el.style.width = sharedState._soPreFsGeom.width;
            el.style.height = sharedState._soPreFsGeom.height;
            sharedState._soPreFsGeom = null;
        }
        ensureWindowInView();   // 还原后再夹一次：旋屏/键盘期间几何若变把窗口收回可见区（此刻 r 已是还原后的原位）；仍不 save
    }
}

// 全屏时按 ESC 退出——【零改动】设计：捕获阶段注册 + gated on so-fullscreen，故在每一条【非全屏】流里
// 立即 return，对既有 ESC 行为零影响；且捕获阶段能在冒泡处理器清掉 .open 之前【读到】更近 UI 的开合状态。
// 让位于本文件仅有的三个 ESC 消费者（grep 确认无他）：⋯ 工具菜单、✂️ 选段卡、聚焦中的编辑框。
// 绝不 preventDefault/stopPropagation——ST 自己的 ESC 照常收到。#so-input 主输入框不算编辑框（在里面按 ESC 也退出）。
export function onFullscreenEscKeydown(e) {
    if (e.key !== 'Escape') return;
    if (!sharedState.win || sharedState.win.style.display === 'none') return;
    if (!sharedState.win.classList.contains('so-fullscreen')) return;   // 非全屏流：立即 no-op（零回归的结构性保证）
    const ae = document.activeElement;
    const editorFocused = !!(ae && ae !== sharedState.win && sharedState.win.contains(ae) && ae.id !== 'so-input'
        && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable));
    if (fullscreenEscShouldExit({
        fullscreen: true,
        toolsMenuOpen: !!sharedState.win.querySelector('#so-tools-menu.open'),
        fixselOpen: !!sharedState.win.querySelector('#so-fixsel.open'),
        editorFocused,
    })) setFullscreen(false);
}

// 视口变化会连发很多次（键盘动画 / 旋屏过渡）——合并到下一帧只夹一次，避免抖动。
sharedState._ensureInViewPending = false;
export function scheduleEnsureInView() {
    if (sharedState._ensureInViewPending) return;
    sharedState._ensureInViewPending = true;
    requestAnimationFrame(() => { sharedState._ensureInViewPending = false; ensureWindowInView(); });
}

// Drag the window by its header. Pointer events cover mouse + touch + pen in one
// path; pointer capture keeps tracking even when the finger leaves the header.
// 拖动 vs 轻点判定（纯函数，单测钉 plan-float-drag.test.mjs）：
// dragShouldBegin —— 一次 pointerdown 该不该开始拖动。落在按钮 / .so-iconbtn 上时默认不拖（让它响应点击）；
//   但折叠态的「指南针小药丸」整张可点面就是那颗罗盘按钮（#so-plan-float-collapse），靠 dragFromButtons=true
//   放行「在按钮上也能起拖」，再用下面的位移阈值区分轻点（展开）/拖动（移动）。真机 bug 修复点（Discord 白鳥三津枝）。
// dragExceededThreshold —— 指针自按下点的位移是否已超过「这是拖动而非轻点」的阈值（按 hypot 距离，避免手指微抖被当拖动）。
//
// 阈值按【起手落在哪】分档（用户报告的手机 bug：一点「🧭 剧情参谋」窗口就不见了，Discord 用户 Lu）。
// 手机上整条标题栏（含 8 颗图标按钮）都放行了 dragFromButtons（见 buildWindow 里 innerWidth < 600），
// 于是任何一次手指多滑 6px 的轻点都被判成拖动：按钮的 click 被 suppressNextClick 吞掉（模式压根没切），
// 窗口却跟着手指跑掉 —— 看起来就是「一点就没了、还唤不回来」。手指按在 33px 的小图标上，落笔到抬笔
// 漂十几 px 是常态，6px 根本区分不出轻点与拖动；标题栏空白处起拖没有这个歧义，仍用 6px 保持手感不变。
const DRAG_THRESHOLD = 6;       // 像素：在标题栏【空白处】按下时，超过它才从「轻点」升级为「拖动」
const DRAG_BTN_THRESHOLD = 14;  // 像素：在【按钮上】按下时的阈值 —— 要明显划一段才算拖，别把轻点吃掉
function dragShouldBegin({ onButton, secondaryButton, dragFromButtons }) {
    if (secondaryButton) return false;               // 鼠标右键 / 中键不拖
    if (onButton && !dragFromButtons) return false;  // 普通：让按钮自己响应点击
    return true;
}
function dragThresholdFor(fromButton) {
    return fromButton ? DRAG_BTN_THRESHOLD : DRAG_THRESHOLD;
}
function dragExceededThreshold(dx, dy, fromButton) {
    const t = dragThresholdFor(fromButton);
    return (dx * dx + dy * dy) > (t * t);
}

// 拖动时至少要留在屏内的一块（宽 × 高）。旧值 60×40 太小：手机上随手一划就能把窗口甩成屏角一条几乎
// 看不见的细边（:8001 实测 390 屏上只剩 60×94），用户只会觉得「窗口没了」。留够一块 = 既看得见它还在、
// 也够手指抓住标题栏拖回来。上限取面板自身尺寸（keepFor）：同一套 clamp 也管着折叠成小药丸的引导浮窗，
// 它整颗才 40 来 px —— 按 140 强留会让它贴不到屏幕边缘，按自身尺寸留则是「整颗都得在屏内」。
// boxIsReachable 用同一组阈值判「它现在还够得着吗」（toggleWindow 的无参切换靠它区分「真的关着」
// 与「开着但被拖出了可见区」）。三者皆纯函数，单测 header-tap-drag.test.mjs。
const DRAG_KEEP_W = 140, DRAG_KEEP_H = 48;
function keepFor(box) {
    return {
        w: Math.min(DRAG_KEEP_W, box.width || DRAG_KEEP_W),
        h: Math.min(DRAG_KEEP_H, box.height || DRAG_KEEP_H),
    };
}
function clampDragPos(box, view) {
    const keep = keepFor(box);
    return {
        left: Math.max(0, Math.min(view.w - keep.w, box.left)),
        top: Math.max(0, Math.min(view.h - keep.h, box.top)),
    };
}
function boxIsReachable(box, view) {
    const keep = keepFor(box);
    const offX = view.offX || 0, offY = view.offY || 0;
    const vw = Math.min(box.left + box.width, offX + view.w) - Math.max(box.left, offX);
    const vh = Math.min(box.top + box.height, offY + view.h) - Math.max(box.top, offY);
    return vw >= keep.w && vh >= keep.h;
}
// 当前【可见】视口（手机软键盘弹出 / 捏合缩放时，visualViewport 才是真正看得见的那块）。
// 同一段兜底此前在 recenterWindow / applyInitialGeometry / ensureWindowInView 各手抄一份，收敛到这里。
export function currentView() {
    const vv = window.visualViewport;
    return {
        w: (vv && vv.width) || window.innerWidth,
        h: (vv && vv.height) || window.innerHeight,
        offX: (vv && vv.offsetLeft) || 0,
        offY: (vv && vv.offsetTop) || 0,
    };
}
// 窗口现在是否还有够得着的一块留在可见视口里。
export function windowIsReachable() {
    if (!sharedState.win) return false;
    const r = sharedState.win.getBoundingClientRect();
    return boxIsReachable({ left: r.left, top: r.top, width: r.width, height: r.height }, currentView());
}
// 一次性吞掉「拖动后浏览器仍会补发的那一下 click」—— 否则在按钮上拖完会顺带触发它
// （如把折叠药丸拖一下，松手又被那颗罗盘的 click 展开）。捕获阶段挂在把手（按钮的祖先）上抢先拦下；
// 300ms 后自动撤除，绝不误吞之后一次正经的轻点。
function suppressNextClick(el) {
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    el.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 300);
}

export function makeDraggable(panel, handle, keys = { left: 'winLeft', top: 'winTop' }, opts = {}) {
    // opts.dragFromButtons: () => boolean —— pointerdown 时若为 true，落在按钮上也可起拖（折叠药丸专用，
    //   它整张面就是那颗按钮）；配合位移阈值，没动够阈值仍算轻点，按钮自己的 click 照常触发。
    let sx, sy, sl, st, sw, sh, pid = null, moved = false, fromButton = false;
    handle.style.touchAction = 'none';   // stop the page scrolling under a drag
    handle.addEventListener('pointerdown', (e) => {
        if (panel.classList.contains('so-fullscreen')) return;   // 全屏时不拖动（否则移动窗口并存下坏几何）
        const onButton = !!(e.target.closest('button') || e.target.closest('.so-iconbtn'));
        const dragFromButtons = typeof opts.dragFromButtons === 'function' && opts.dragFromButtons();
        if (!dragShouldBegin({ onButton, secondaryButton: e.button != null && e.button > 0, dragFromButtons })) return;
        pid = e.pointerId;
        moved = false;
        fromButton = onButton;            // 起手就在按钮上 → 真拖完要吞那下补发的 click
        const r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        sw = r.width; sh = r.height;      // 起拖时的面板尺寸 → 决定「至少留多少在屏内」（见 keepFor）
        panel.style.right = 'auto';
        document.body.style.userSelect = 'none';
        // 指针捕获【推迟】到真正起拖那一刻（见 pointermove）。若在此处 pointerdown 就捕获，桌面鼠标
        // 会把补发的 click 重定向到被捕获的 handle、绕过折叠药丸下方的展开按钮 → 「🧭 小罗盘点了不展开」
        // （只影响鼠标，触屏的 click 不被重定向、一直正常）。纯轻点永不捕获 = click 照常落到按钮上。
    });
    handle.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid) return;
        if (!moved && !dragExceededThreshold(e.clientX - sx, e.clientY - sy, fromButton)) return; // 阈值内仍算轻点，先不动
        if (!moved) {                     // 头一次越过阈值 = 真起拖：此刻才捕获指针（纯轻点走不到这里）
            moved = true;
            try { handle.setPointerCapture(pid); } catch (_) { /* ignore */ }
        }
        const p = clampDragPos(
            { left: sl + e.clientX - sx, top: st + e.clientY - sy, width: sw, height: sh },
            { w: window.innerWidth, h: window.innerHeight },
        );
        panel.style.left = `${p.left}px`;
        panel.style.top = `${p.top}px`;
    });
    const end = (e) => {
        if (pid == null || (e && e.pointerId !== pid)) return;
        try { handle.releasePointerCapture(pid); } catch (_) { /* ignore */ }
        pid = null;
        document.body.style.userSelect = '';
        if (!moved) { fromButton = false; return; }  // 只是轻点：放行 click（如展开），位置没变就不保存
        if (fromButton) { suppressNextClick(handle); fromButton = false; } // 拖动起于按钮 → 吞掉补发的 click
        const s = getSettings();
        s[keys.left] = parseInt(panel.style.left, 10);
        s[keys.top] = parseInt(panel.style.top, 10);
        save();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
}

// Resize the window by dragging the bottom-right grip — same pointer-capture
// approach, so it works with a finger. Clamped to the viewport so the size we
// store never exceeds the screen.
export function makeResizable(panel, grip) {
    if (!grip) return;
    let sx, sy, sw, sh, left, top, pid = null;
    grip.addEventListener('pointerdown', (e) => {
        if (panel.classList.contains('so-fullscreen')) return;   // 全屏时不缩放
        if (e.button != null && e.button > 0) return;
        pid = e.pointerId;
        const r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; left = r.left; top = r.top;
        document.body.style.userSelect = 'none';
        try { grip.setPointerCapture(pid); } catch (_) { /* ignore */ }
        e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid) return;
        const minW = 300, minH = 320;
        const maxW = Math.max(minW, window.innerWidth - left - 6);
        const maxH = Math.max(minH, window.innerHeight - top - 6);
        panel.style.width = `${Math.max(minW, Math.min(maxW, sw + e.clientX - sx))}px`;
        panel.style.height = `${Math.max(minH, Math.min(maxH, sh + e.clientY - sy))}px`;
    });
    const end = (e) => {
        if (pid == null || (e && e.pointerId !== pid)) return;
        try { grip.releasePointerCapture(pid); } catch (_) { /* ignore */ }
        pid = null;
        document.body.style.userSelect = '';
        const s = getSettings();
        s.winWidth = panel.offsetWidth;
        s.winHeight = panel.offsetHeight;
        save();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
}
