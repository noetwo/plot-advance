import { getSettings, save } from '../../core/settings.js';

import { getPath, setPath } from './metadata.js';
import { guidePaused, nodeDetailWriting, pathSkipNodeUi, setPathSpeed, wantAutoDetail, writePathNodeDetail } from './story-path.js';
import { chatIdentityKey } from '../chat/send.js';
import { applyPlanInjection, nodeTargetText, pathActiveNode, pathInjectionText, pathIsMulti, pathNodeNeedsDetail, pathProgressLabel, pathSpeedKey } from '../fix/templates.js';
import { ADVISOR_SPEEDS } from '../../prompts/builtins.js';
import { makeDraggable } from '../../ui/geometry.js';
import { toggleWindow } from '../../ui/mode-shell.js';
import { pathEditDraft, planBarEl, planFloat, planFloatSlot, setPathEditDraft, setPlanFloat, setPlanFloatSlot } from './state.js';
import { win } from '../../ui/state.js';

/* ------------------------------------------------------------------ *
 * 方案条（active plan strip）。只要当前聊天存在已采用的方案就显示——
 * 不论神谕处于哪个模式，因为引导作用的是主聊天，必须显眼到没法被遗忘。
 *
 * v1.14.3：同一个方案条元素在两个家之间【搬家】（reparent），绝不复制——
 * 神谕窗口打开时住在窗口顶部；窗口关闭而方案仍在引导时，搬进一个独立的
 * 可拖动悬浮容器，常驻在 ST 界面上。单一 DOM 节点 = 单一真相：强度按钮、
 * 展开器、完成/放弃在两处都是同一批监听器，无需任何同步。
 * ------------------------------------------------------------------ */
export function renderPlanBar() {
    if (!planBarEl) return;
    const path = getPath();
    if (win) win.classList.toggle('so-plan-on', !!path);
    const pre = planBarEl.querySelector('#so-plan-directive');
    if (!path) {
        setPathEditDraft(null);
        pre.classList.remove('open');
        planBarEl.querySelector('#so-plan-show').textContent = '▸ 查看注入内容';
        planBarEl.querySelector('#so-seq-list').innerHTML = '';
        placePlanBar();
        return;
    }
    const multi = pathIsMulti(path);
    const node = pathActiveNode(path);
    const label = planBarEl.querySelector('#so-plan-label');
    label.textContent = multi ? `剧情脉络 · ${pathProgressLabel(path)}` : '方案';
    planBarEl.querySelector('#so-plan-goal').textContent = multi ? (node ? node.name : '') : (path.title || nodeTargetText(path.nodes[0]));
    const speed = pathSpeedKey(path);
    renderIntensitySegments(speed, setPathSpeed);
    planBarEl.querySelector('#so-plan-caption').textContent = ADVISOR_SPEEDS[speed].caption;
    const doneBtn = planBarEl.querySelector('#so-plan-done');
    doneBtn.textContent = multi ? '完成这个节点' : '完成';
    doneBtn.title = multi ? '当前节点走完了，进入下一个' : '目标已达成，停止引导';
    renderPathList(path);
    // 暂停引导：条头补「已暂停」、目标变淡、按钮换成「继续」
    const paused = guidePaused(path);
    planBarEl.classList.toggle('so-plan-paused', paused);
    if (paused) label.textContent += ' · 已暂停';
    const pauseBtn = planBarEl.querySelector('#so-plan-pause');
    pauseBtn.innerHTML = paused ? '<i class="fa-solid fa-play"></i> 继续' : '<i class="fa-solid fa-pause"></i> 暂停';
    pauseBtn.title = paused ? '继续引导：从现在起重新往主聊天注入' : '暂停引导：主聊天先不注入，进度都保留，随时继续';
    if (pre.classList.contains('open')) pre.textContent = currentInjectionPreview();
    syncPlanBarCollapsed();
    placePlanBar();
}

// 引导条收起态同步：切 .so-plan-collapsed 类 + 箭头方向（收起 = ▾ 可展开 / 展开 = ▴ 可收起）。
// 停靠在窗口内时靠 CSS 只留标题行省纵向空间；renderPlanBar 与收起箭头点击共用本函数（DRY）。
export function syncPlanBarCollapsed() {
    if (!planBarEl) return;
    const collapsed = !!getSettings().planBarCollapsed;
    planBarEl.classList.toggle('so-plan-collapsed', collapsed);
    const i = planBarEl.querySelector('#so-plan-collapse i');
    if (i) i.className = collapsed ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';
}

// 推进速度三档按钮，点哪档调 onPick(key)。
function renderIntensitySegments(current, onPick) {
    const seg = planBarEl.querySelector('#so-plan-intensity');
    seg.innerHTML = '';
    for (const [key, I] of Object.entries(ADVISOR_SPEEDS)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'so-plan-int' + (current === key ? ' active' : '');
        b.textContent = I.label;
        b.addEventListener('click', () => onPick(key));
        seg.appendChild(b);
    }
}

/* 方案条的列表（2.5.0）：多节点先列整体目标，再逐个节点（✓ 已完成 / ▶ 当前 / ○ 未开始 / ⤫ 已跳过）；单节点只有
 * 一行「目标」。当前和未开始的节点可以 ✏️ 改关键词和详细，未开始的可以跳过；当前节点还没有详细时可以「让参谋写」。
 * 正在改的那一项存在 pathEditDraft（只认同一聊天、同一条脉络），方案条重画也不会冲掉。 */
function pathDraftFor(path) {
    const d = pathEditDraft;
    return (d && path && d.chatKey === chatIdentityKey() && d.adoptedAt === path.adoptedAt) ? d : null;
}
export function startPathEdit(target) {
    const path = getPath();
    if (!path) return;
    let detail;
    let keywords = null;
    if (target === 'overall') {
        detail = path.overall || '';
    } else {
        const n = path.nodes.find((x) => x.id === target);
        if (!n || (n.status !== 'active' && n.status !== 'pending')) return;
        detail = n.detail || '';
        if (pathIsMulti(path)) keywords = n.keywords || '';
    }
    setPathEditDraft({ chatKey: chatIdentityKey(), adoptedAt: path.adoptedAt, target, detail, keywords });
    renderPathList(path);
    const box = planBarEl.querySelector('#so-seq-list textarea');
    if (box) { box.focus(); box.setSelectionRange(0, 0); box.scrollTop = 0; }
}
function savePathEdit() {
    const path = getPath();
    const d = pathDraftFor(path);
    setPathEditDraft(null);
    if (!d) { renderPlanBar(); return; }
    if (d.target === 'overall') {
        path.overall = String(d.detail || '').trim();
    } else {
        const n = path.nodes.find((x) => x.id === d.target);
        if (n && (n.status === 'active' || n.status === 'pending')) {
            n.detail = String(d.detail || '').trim();
            if (d.keywords !== null) n.keywords = String(d.keywords || '').trim();
        }
    }
    setPath(path);
    applyPlanInjection();
    renderPlanBar();
}
function renderPathList(path) {
    const list = planBarEl.querySelector('#so-seq-list');
    if (!list) return;
    list.innerHTML = '';
    const draft = pathDraftFor(path);
    const rowBtn = (text, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'so-seq-row-btn';
        b.title = title;
        if (text === '✏️') b.innerHTML = '<i class="fa-solid fa-pencil"></i>';
        else b.textContent = text;
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
        return b;
    };
    const addRow = ({ cls, label, kw, body, open, buttons, target }) => {
        const editing = !!(draft && draft.target === target);
        const row = document.createElement('details');
        row.className = 'so-seq-row ' + cls;
        row.open = open || editing;
        const sum = document.createElement('summary');
        const lab = document.createElement('span');
        lab.className = 'so-seq-row-label';
        lab.textContent = label;
        if (kw) {
            const k = document.createElement('span');
            k.className = 'so-path-kw';
            k.textContent = ' · ' + kw;
            lab.appendChild(k);
        }
        sum.appendChild(lab);
        if (!editing) for (const b of buttons) sum.appendChild(b);
        row.appendChild(sum);
        const bodyEl = document.createElement('div');
        bodyEl.className = 'so-seq-row-body';
        if (!editing) {
            bodyEl.textContent = body;
        } else {
            bodyEl.style.whiteSpace = 'normal';
            if (draft.keywords !== null) {
                const kwBox = document.createElement('input');
                kwBox.type = 'text';
                kwBox.className = 'so-path-kw-box';
                kwBox.placeholder = '关键词，用顿号隔开（一直给主聊天看，防止跑偏）';
                kwBox.value = draft.keywords;
                kwBox.addEventListener('input', () => { draft.keywords = kwBox.value; });
                bodyEl.appendChild(kwBox);
            }
            const box = document.createElement('textarea');
            box.className = 'so-seq-canon-box';
            box.rows = 5;
            box.spellcheck = false;
            box.value = draft.detail;
            box.placeholder = target === 'overall'
                ? '整条脉络最终走到哪里（一句话）'
                : '这一段要发生什么、走到什么结果（轮到这个节点时才给主聊天看）';
            box.addEventListener('input', () => { draft.detail = box.value; });
            bodyEl.appendChild(box);
            const actions = document.createElement('div');
            actions.className = 'so-seq-canon-actions';
            const mk = (text, cls2, fn) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'so-plan-mini' + (cls2 ? ' ' + cls2 : '');
                b.textContent = text;
                b.addEventListener('click', fn);
                actions.appendChild(b);
            };
            mk('保存', 'so-plan-done', savePathEdit);
            mk('取消', '', () => { setPathEditDraft(null); renderPathList(path); });
            bodyEl.appendChild(actions);
        }
        row.appendChild(bodyEl);
        list.appendChild(row);
    };
    if (!pathIsMulti(path)) {
        const n = path.nodes[0];
        addRow({ cls: 'so-seq-row-active', label: '🎯 目标', kw: '', body: nodeTargetText(n), open: true,
            buttons: [rowBtn('✏️', '修改目标', () => startPathEdit(n.id))], target: n.id });
        return;
    }
    addRow({ cls: 'so-seq-canon', label: '🎯 整体目标', kw: '', body: path.overall || '（没写）', open: false,
        buttons: [rowBtn('✏️', '修改整体目标', () => startPathEdit('overall'))], target: 'overall' });
    const mark = { done: '✓', active: '▶', pending: '○', skipped: '⤫' };
    path.nodes.forEach((n, i) => {
        const buttons = [];
        let body;
        if (n.status === 'done') {
            body = '已完成';
        } else if (n.status === 'skipped') {
            body = '已跳过';
        } else if (n.status === 'active') {
            buttons.push(rowBtn('✏️', '修改这个节点', () => startPathEdit(n.id)));
            if (nodeDetailWriting(path, n)) {
                body = `⏳ 参谋正在看着刚演完的剧情写这个节点的详细……\n写好之前先按关键词引导：${n.keywords || n.name}`;
            } else if (pathNodeNeedsDetail(n)) {
                buttons.push(rowBtn('让参谋写', '请参谋按已经演出来的剧情写这个节点的详细（一次调用）', () => { void writePathNodeDetail(); }));
                body = `还没有详细，先按关键词引导：${n.keywords || n.name}`;
            } else {
                body = n.detail;
            }
        } else {
            buttons.push(rowBtn('✏️', '修改这个节点', () => startPathEdit(n.id)));
            buttons.push(rowBtn('跳过', '跳过这个节点（不会引导它）', () => pathSkipNodeUi(n.id)));
            body = n.detail || (wantAutoDetail() ? '轮到它时，参谋再按演出来的剧情写详细。' : '还没有详细：轮到它时先按关键词引导。');
        }
        const live = n.status === 'active' || n.status === 'pending';
        addRow({ cls: `so-seq-row-${n.status}`, label: `${mark[n.status] || '?'} ${i + 1}. ${n.name}`, kw: live ? n.keywords : '',
            body, open: n.status === 'active', buttons, target: n.id });
    });
}

// 方案条「查看注入内容」：主聊天此刻实际收到的那一段。
export function currentInjectionPreview() {
    const path = getPath();
    if (!path) return '';
    if (path.paused) return '（引导已暂停：主聊天当前不注入任何内容）';
    return pathInjectionText(path);
}

// One-line label for the active construct (collapsed-float tooltip).
function activeConstructLabel() {
    const path = getPath();
    if (!path) return '';
    const tail = path.paused ? '（已暂停）' : '';
    if (pathIsMulti(path)) return `${path.title || '剧情脉络'} · ${pathProgressLabel(path)}${tail}`;
    return `${path.title || nodeTargetText(path.nodes[0])}${tail}`;
}


// Lazy-build the floating home for the strip.
function ensurePlanFloat() {
    if (planFloat) return;
    setPlanFloat(document.createElement('div'));
    planFloat.id = 'so-plan-float';
    planFloat.innerHTML = `
        <div id="so-plan-float-head">
            <i class="fa-solid fa-compass"></i>
            <span class="so-plan-float-title">剧情引导</span>
            <span class="so-plan-spacer"></span>
            <div class="so-iconbtn" id="so-plan-float-collapse" title="收起成小标签 / 展开"><i class="fa-solid fa-chevron-up"></i></div>
            <div class="so-iconbtn" id="so-plan-float-open" title="打开剧情推进"><i class="fa-solid fa-moon"></i></div>
        </div>
        <div id="so-plan-float-slot"></div>`;
    document.body.appendChild(planFloat);
    setPlanFloatSlot(planFloat.querySelector('#so-plan-float-slot'));
    planFloat.querySelector('#so-plan-float-open').addEventListener('click', () => toggleWindow(true));
    planFloat.querySelector('#so-plan-float-collapse').addEventListener('click', () => {
        const s2 = getSettings();
        s2.planFloatCollapsed = !s2.planFloatCollapsed;
        save();
        applyPlanFloatCollapsed();
    });
    // 折叠成罗盘药丸后，整张可点面就是那颗按钮 —— 放行「从按钮起拖」，否则手机上只剩 3px 外圈可拖（拖不动）。
    makeDraggable(planFloat, planFloat.querySelector('#so-plan-float-head'),
        { left: 'planFloatLeft', top: 'planFloatTop' },
        { dragFromButtons: () => planFloat.classList.contains('so-collapsed') });
    // Restore the saved position, clamped to the current viewport.
    const s = getSettings();
    if (Number.isFinite(s.planFloatLeft) && Number.isFinite(s.planFloatTop)) {
        planFloat.style.left = Math.max(0, Math.min(window.innerWidth - 60, s.planFloatLeft)) + 'px';
        planFloat.style.top = Math.max(0, Math.min(window.innerHeight - 40, s.planFloatTop)) + 'px';
        planFloat.style.right = 'auto';
    }
    applyPlanFloatCollapsed(); // restore persisted collapsed state
}

// Collapsed = a single 🧭 compass button, no words: tiniest footprint (mobile —
// nothing blocks the screen) while still an unmissable signal that steering is
// active. The collapse toggle itself carries the compass icon when folded; the
// decorative compass + title + open(moon) are hidden via CSS. Strip stays parented
// in the hidden slot, so expanding is pure CSS — no re-render, no listener churn.
function applyPlanFloatCollapsed() {
    if (!planFloat) return;
    const collapsed = !!getSettings().planFloatCollapsed;
    planFloat.classList.toggle('so-collapsed', collapsed);
    const btn = planFloat.querySelector('#so-plan-float-collapse');
    btn.querySelector('i').className = collapsed ? 'fa-solid fa-compass' : 'fa-solid fa-chevron-up';
    planFloat.querySelector('.so-plan-float-title').textContent = collapsed ? (guidePaused() ? '已暂停' : '引导中') : '剧情引导';
    // 标签只挂在 compass 按钮上（activeConstructLabel），可 hover 的 head 上不挂任何内容
    // （原版为盲盒防剧透定的规矩，精简版沿用）。
    const label = activeConstructLabel();
    btn.title = collapsed ? (label ? `展开 · ${label}` : '展开剧情引导') : '收起成指南针（不挡屏）';
    planFloat.querySelector('#so-plan-float-head').title = '';
}

// Decide where the strip lives right now. Rules: no plan -> hidden (and parked
// back in the window); plan + window visible -> inside the window (the float
// hides); plan + window closed -> inside the float, always on screen.
export function placePlanBar() {
    if (!planBarEl || !win) return;
    const active = getPath();
    const winVisible = win.style.display !== 'none';
    if (active && !winVisible) {
        ensurePlanFloat();
        if (planBarEl.parentElement !== planFloatSlot) planFloatSlot.appendChild(planBarEl);
        planFloat.style.display = 'flex';
        applyPlanFloatCollapsed(); // refresh pill tooltip (plan may have changed)
    } else {
        if (planFloat) planFloat.style.display = 'none';
        if (planBarEl.parentElement !== win) {
            win.insertBefore(planBarEl, win.querySelector('#so-messages'));
        }
    }
}