import { confirmModeSwitch } from '../core/chat-metadata.js';
import { closeQpMenu, getCtx, getSettings, renderModelBar, save, uiConfirm } from '../core/settings.js';

import { addSystemNote, modeEntryNote, renderEmptyState, syncConvoStream } from '../modes/advisor/cards.js';
import { activeDraftContent, draftCardLabel, getBuilderState, setBuilderState } from '../modes/advisor/metadata.js';
import { checkPlanReminder } from '../modes/advisor/story-path.js';
import { placePlanBar } from '../modes/advisor/ui.js';
import { populateBuilderBooks } from '../modes/builder/books-ui.js';
import { applyBuilderDraft, runCondense, runCondenseDepth, runForge } from '../modes/builder/ui.js';
import { soApplyConvoIoVisual } from '../modes/chat/history.js';
import { maybeRunSaveHealth } from '../modes/diagnose/diagnostics.js';
import { getEffectiveFixCfg, getFixCfg } from '../modes/fix/templates.js';
import { refreshDiagPickerUI } from '../modes/fix/ui.js';
import { populateLorebookBooks } from '../modes/lorebook/ui.js';
import { ENABLE_AUTO_DIAGNOSE, ENABLE_CHAR_BUILDER, ENABLE_DIAG_WI_PICKER, ENABLE_DRAFT_CONDENSE, ENABLE_FIX_CUSTOM_TASK, ENABLE_LIGHT_CONDENSE, ENABLE_REPLY_FIX, ENABLE_SCHEMA_DIAG } from '../prompts/builtins.js';
import { ensureWindowInView, windowIsReachable } from './geometry.js';
import { applySysPromptPresetUiState, buildCurationRows, getActiveMainPresetName, snapshotFromRows, updateBadge } from './settings.js';
import { convo } from '../core/conversation-store.js';
import { activateOracleMode, advisorMode, builderMode, diagnoseMode, fixMode, lorebookMode, priorOracleMode, rememberPriorOracleMode, resetPriorOracleMode } from '../core/oracle-modes.js';
import { inputEl, messagesEl, win } from './refs.js';

let curationState = null;

/* ------------------------------------------------------------------ *
 * Curation modal — the user is the sole curator (no LLM step).
 * Lists the preset's enabled blocks + context-slot markers in preset order,
 * pre-checked by a name/role/structure classifier, draggable to reorder.
 * Saving freezes the kept rows (in their final order) into curatedPresets.
 * ------------------------------------------------------------------ */


const CUR_TAG_LABEL = {
    marker: '插槽', story: '故事', machinery: '变量机制', wrapper: '包裹',
    output: '输出/COT', prefill: '起手', 'user-echo': '回显输入',
    inert: '注释/空', review: '待确认',
};

export function openCuration(name, seedRows) {
    const rows = seedRows || buildCurationRows(name);
    if (!rows.length) {
        addSystemNote(`预设「${name}」没有可挑选的已启用块。请检查它在 ST 里是否配置正确。`);
        return;
    }
    curationState = { name, rows, dragFrom: -1 };

    let modal = win.querySelector('#pad-curate');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'pad-curate';
        win.appendChild(modal);
    }
    modal.innerHTML = `
        <div id="pad-cur-card">
            <div id="pad-cur-head">
                <div id="pad-cur-title"><i class="fa-solid fa-list-check"></i> 挑选要保留的块</div>
                <div class="pad-iconbtn" id="pad-cur-x" title="取消"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div id="pad-cur-sub"></div>
            <div id="pad-cur-list"></div>
            <div id="pad-cur-foot">
                <div id="pad-cur-count"></div>
                <div id="pad-cur-foot-btns">
                    <button class="pad-cur-btn" id="pad-cur-reset">重置默认</button>
                    <button class="pad-cur-btn" id="pad-cur-cancel">取消</button>
                    <button class="pad-cur-btn pad-cur-save" id="pad-cur-save">保存并使用</button>
                </div>
            </div>
        </div>`;
    modal.querySelector('#pad-cur-sub').textContent =
        `预设「${name}」 — 列出预设里的全部块（含预设已停用的，标「预设已停用」、默认不勾选）。勾选的块会按下方顺序忠实组装；插槽（角色卡 / 世界书 / 用户人设 / 上下文）会就地填入剧情推进的上下文。拖动可调整顺序。`;

    // One-time heads-up about the output-regex / preset-mismatch caveat.
    maybeShowCurationWarning(modal, name);

    // Critical layout applied inline so the modal is contained, opaque, and
    // scrollable even if the stylesheet is stale/cached (the .pad-cur-* theme
    // rules still enhance it once style.css refreshes).
    applyCurationChrome(modal);

    modal.querySelector('#pad-cur-x').addEventListener('click', closeCuration);
    modal.querySelector('#pad-cur-cancel').addEventListener('click', closeCuration);
    modal.querySelector('#pad-cur-reset').addEventListener('click', () => {
        curationState.rows = buildCurationRows(name); // re-seed from classifier
        renderCurationRows();
    });
    modal.querySelector('#pad-cur-save').addEventListener('click', saveCuration);

    modal.classList.add('open');
    modal.style.display = 'flex';
    renderCurationRows();
}

// Guarantee the modal's structure inline, independent of the external stylesheet.
function applyCurationChrome(modal) {
    const set = (sel, css) => { const el = modal.querySelector(sel); if (el) el.style.cssText += ';' + css; };
    modal.style.cssText +=
        ';position:absolute;inset:0;top:0;left:0;right:0;bottom:0;z-index:50;' +
        'align-items:center;justify-content:center;padding:12px;box-sizing:border-box;' +
        'background:rgba(8,9,12,0.84);';
    set('#pad-cur-card',
        'position:relative;top:auto;left:auto;right:auto;bottom:auto;transform:none;' +
        'display:flex;flex-direction:column;width:100%;max-width:560px;' +
        'height:100%;max-height:100%;min-height:0;box-sizing:border-box;overflow:hidden;' +
        'border-radius:12px;background:#1b1d23;border:1px solid rgba(255,255,255,0.18);' +
        'box-shadow:0 20px 50px -12px rgba(0,0,0,0.7);');
    set('#pad-cur-head',
        'flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;' +
        'padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.12);');
    set('#pad-cur-sub', 'flex:0 0 auto;padding:10px 14px 4px;font-size:0.8em;opacity:0.65;line-height:1.5;');
    set('#pad-cur-list', 'flex:1 1 0;min-height:0;overflow-y:auto;padding:6px;');
    set('#pad-cur-foot',
        'flex:0 0 auto;display:flex;align-items:center;gap:10px;' +
        'padding:10px 14px;border-top:1px solid rgba(255,255,255,0.12);');
    set('#pad-cur-count', 'flex:1 1 auto;font-size:0.8em;opacity:0.8;');
    set('#pad-cur-foot-btns', 'display:flex;gap:6px;flex:0 0 auto;');
}

// One-time warning: the Oracle assembles from (and regex-cleans for) the preset
// curated HERE; if that differs from the main-chat preset the enabled regex is
// tuned to, the cleanup may not match the Oracle's output.
function maybeShowCurationWarning(modal, name) {
    const s = getSettings();
    if (s.curationWarned) return;
    const card = modal.querySelector('#pad-cur-card');
    const list = modal.querySelector('#pad-cur-list');
    if (!card || !list) return;

    const mainName = getActiveMainPresetName();
    let tail = '';
    if (mainName && mainName === name) tail = '（当前与主聊天预设一致 ✓）';
    else if (mainName) tail = `（主聊天当前预设：「${escapeHtml(mainName)}」，与此不同 —— 正则很可能对不上）`;

    const warn = document.createElement('div');
    warn.id = 'pad-cur-warn';
    warn.style.cssText =
        'flex:0 0 auto;margin:8px 14px 2px;padding:9px 11px;border-radius:8px;' +
        'font-size:0.78em;line-height:1.55;color:#f0d28a;' +
        'background:rgba(242,201,76,0.12);border:1px solid rgba(242,201,76,0.35);';
    warn.innerHTML =
        '⚠️ 选用预设时，剧情推进会用<b>你在这里挑选的这个预设</b>来组装提示词，并用你启用的正则清理它的回复。' +
        '这些正则是按<b>主聊天的输出格式</b>写的——如果这里挑选的预设和主聊天当前启用的预设不一样，' +
        `正则可能匹配不上剧情推进的输出、清理不会生效。${tail}`;
    card.insertBefore(warn, list);

    s.curationWarned = true;
    save();
}

function closeCuration() {
    const modal = win.querySelector('#pad-curate');
    if (modal) { modal.classList.remove('open'); modal.style.display = 'none'; }
    curationState = null;
}

function renderCurationRows() {
    const list = win.querySelector('#pad-cur-list');
    if (!list || !curationState) return;
    list.innerHTML = '';
    curationState.rows.forEach((r, idx) => {
        const row = document.createElement('div');
        row.className = 'pad-cur-row' + (r.keep ? '' : ' pad-cur-off') + (r.kind === 'marker' ? ' pad-cur-marker' : '');
        row.draggable = true;
        row.dataset.idx = String(idx);

        const handle = `<span class="pad-cur-handle" title="拖动排序"><i class="fa-solid fa-grip-vertical"></i></span>`;
        const cb = `<input type="checkbox" class="pad-cur-cb" ${r.keep ? 'checked' : ''}>`;
        const roleBadge = (r.role && r.role !== 'system')
            ? `<span class="pad-cur-role">${r.role}</span>` : '';
        // 【不要】把样式再内联回来（1.45.0）：这一串曾与 .pad-cur-disabled 逐条重复，而内联优先级
        // 压过任何类规则 —— 浅色皮肤给它写的 color 覆盖会被静默吃掉、徽章浅粉压浅底约 1.7:1。
        const disabledBadge = r.disabled
            ? `<span class="pad-cur-disabled">预设已停用</span>`
            : '';
        const tag = `<span class="pad-cur-tag pad-cur-tag-${r.category}">${CUR_TAG_LABEL[r.category] || r.category}</span>`;
        const chars = r.kind === 'marker' ? '插槽' : `${r.chars} 字`;
        row.innerHTML =
            `${handle}${cb}<span class="pad-cur-name" title="${escapeAttr(r.name)}">${escapeHtml(r.name)}</span>` +
            `${disabledBadge}${roleBadge}${tag}<span class="pad-cur-chars">${chars}</span>`;

        // Inline layout so rows stay readable even if the stylesheet is stale.
        row.style.cssText +=
            ';display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;' +
            'border:1px solid transparent;' + (r.keep ? '' : 'opacity:0.5;');
        const nameEl = row.querySelector('.pad-cur-name');
        if (nameEl) nameEl.style.cssText += ';flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const charsEl = row.querySelector('.pad-cur-chars');
        if (charsEl) charsEl.style.cssText += ';flex:0 0 auto;font-size:0.78em;opacity:0.5;';
        const cbEl0 = row.querySelector('.pad-cur-cb');
        if (cbEl0) cbEl0.style.cssText += ';flex:0 0 auto;width:15px;height:15px;cursor:pointer;';
        row.querySelector('.pad-cur-cb').addEventListener('change', (e) => {
            curationState.rows[idx].keep = e.target.checked;
            row.classList.toggle('pad-cur-off', !e.target.checked);
            row.style.opacity = e.target.checked ? '' : '0.5';
            updateCurationCount();
        });
        row.addEventListener('dragstart', () => { curationState.dragFrom = idx; row.classList.add('pad-cur-drag'); });
        row.addEventListener('dragend', () => { row.classList.remove('pad-cur-drag'); });
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('pad-cur-over'); });
        row.addEventListener('dragleave', () => row.classList.remove('pad-cur-over'));
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('pad-cur-over');
            const from = curationState.dragFrom;
            const to = idx;
            if (from < 0 || from === to) return;
            const arr = curationState.rows;
            const [moved] = arr.splice(from, 1);
            arr.splice(to, 0, moved);
            curationState.dragFrom = -1;
            renderCurationRows();
        });

        list.appendChild(row);
    });
    updateCurationCount();
}

function updateCurationCount() {
    const el = win.querySelector('#pad-cur-count');
    if (!el || !curationState) return;
    const kept = curationState.rows.filter((r) => r.keep);
    const texts = kept.filter((r) => r.kind === 'text');
    const slots = kept.filter((r) => r.kind === 'marker');
    const chars = texts.reduce((n, r) => n + (r.chars || 0), 0);
    el.innerHTML = `保留 <b>${texts.length}</b> 块 + <b>${slots.length}</b> 插槽 · 约 <b>${chars.toLocaleString()}</b> 字`;
}

function saveCuration() {
    if (!curationState) return;
    const { name, rows } = curationState;
    const snap = snapshotFromRows(rows);
    if (!snap.items.length) {
        addSystemNote('至少要保留一个块。请勾选后再保存。');
        return;
    }
    const s = getSettings();
    if (!s.curatedPresets || typeof s.curatedPresets !== 'object') s.curatedPresets = {};
    s.curatedPresets[name] = snap;
    s.sysPromptPresetName = name;
    save();
    closeCuration();
    const sel = win.querySelector('#pad-sysprompt-preset');
    if (sel) sel.value = name;
    applySysPromptPresetUiState();
    updateBadge();
}

export function escapeHtml(str) {
    return String(str || '').replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
}
function escapeAttr(str) { return escapeHtml(str); }

/* ------------------------------------------------------------------ *
 * 输入框「Enter 发送」（1.85.1）
 * 报障：手机键盘没有 Shift+Enter，神谕输入框里按 Enter 永远是发送、换不了行。
 * 修法（Prince 裁：不加新设置、不加新文案）：跟随酒馆自己的「用户设置 → 按 Enter 发送」
 * （power_user.send_on_enter：-1 禁用 / 0 自动〔默认：电脑 Enter 发送、手机 Enter 换行〕/ 1 启用）。
 * 判据逐条对齐 ST 主输入框（对着真源码钉，public/scripts/RossAscends-mods.js）：
 *   · shouldSendOnEnter()：DISABLED → 不发；AUTO → !isMobile()；ENABLED → 发。
 *   · processHotkeys()：!event.isComposing && !shiftKey && !ctrlKey && !altKey && key == 'Enter'。
 * 在它之上只多挡一条 keyCode 229（输入法正在处理的按键；Safari 提交候选那一下 isComposing 可能已是 false）
 * ——只会让中文输入法「回车上屏」少发一次，永远不会多发。读不到设置 / 非法值一律按 0 自动（ST 默认）。
 * ------------------------------------------------------------------ */
export function soEnterShouldSend(e, sendOnEnter, mobile) {
    if (!e || e.key !== 'Enter') return false;
    if (e.isComposing || e.keyCode === 229) return false;   // 输入法选词 / 上屏的回车绝不发送
    if (e.shiftKey || e.ctrlKey || e.altKey) return false;  // 同 ST：带修饰键的 Enter 不算「发送」
    const v = Number(sendOnEnter);
    if (v === -1) return false;   // 禁用：Enter 永远换行，只能点发送按钮
    if (v === 1) return true;     // 启用：手机上也 Enter 发送
    return !mobile;               // 0 自动（及读不到 / 非法值）：电脑发送、手机换行
}

// 按键当时读酒馆设置（不缓存）；getContext 不可用时退回 0 自动。
export function soReadSendOnEnter() {
    try {
        const pu = getCtx()?.powerUserSettings;
        const v = pu ? pu.send_on_enter : undefined;
        return (v === undefined || v === null) ? 0 : v;
    } catch (e) { return 0; }
}

// 「是不是手机」用 ST 自己的 isMobile()（UA 判 mobile / tablet，与主输入框同一口径）；
// 老版本 ST 的 getContext 没暴露它时，退回本文件 focusOracleInput 同款的粗指针判据。
export function soIsMobileForEnter() {
    try {
        const ctx = getCtx();
        if (ctx && typeof ctx.isMobile === 'function') return !!ctx.isMobile();
    } catch (e) { /* 落到下方兜底 */ }
    try {
        return typeof window.matchMedia === 'function' && !!window.matchMedia('(pointer: coarse)').matches;
    } catch (e) { return false; }
}

/* ------------------------------------------------------------------ *
 * Show / hide
 * ------------------------------------------------------------------ */
// 触屏（主指针为粗指针）上聚焦输入框会弹出软键盘：压缩可见视口、打断操作（用户报「一切换就弹」）。
// 唯一咽喉：所有「切模式 / 开窗后把光标放回输入框」的礼貌性聚焦都走这里——桌面照旧聚焦，触屏不聚焦，
// 用户点输入框时系统自然弹键盘。判据用主指针粗细而非视口宽度：横屏手机 / 平板宽度可超 600 也不该弹。
// 明确要打字的场景（概要编辑器、消息编辑框）不走这里——那些聚焦是功能本体，不是礼貌。
export function focusOracleInput() {
    if (!inputEl) return;
    const coarse = window.matchMedia
        ? window.matchMedia('(pointer: coarse)').matches
        : (window.innerWidth < 600);   // matchMedia 缺席的古董环境退回旧宽度判据
    if (coarse) return;
    inputEl.focus();
}

export function toggleWindow(show) {
    if (!win) return;
    const visible = win.style.display !== 'none';
    // 无参切换（🌙 聊天栏快捷钮）：窗口「开着」但已被拖出可见区时，按字面切换只会把它关掉——屏幕上
    // 什么都没变，用户会觉得这颗钮坏了（得再点一下才靠 ensureWindowInView 拉回来）。这种情况按
    // 【显示并拉回可见区】处理，下面 next=true 分支里的 ensureWindowInView 会把它夹回屏内。
    const next = (show === undefined) ? (!visible || !windowIsReachable()) : show;
    win.style.display = next ? 'flex' : 'none';
    if (next) {
        // Re-trigger the open animation each time the window is shown.
        win.classList.remove('pad-opening');
        void win.offsetWidth; // force reflow so the animation restarts
        win.classList.add('pad-opening');
        ensureWindowInView();   // 每次开窗都把窗口夹回可见区——卡在屏外的窗口下次打开即自愈
        // 触屏不自动聚焦（见 focusOracleInput）：弹软键盘会压缩视口、把标题栏挤出屏外；桌面保留自动聚焦。
        focusOracleInput();
        checkPlanReminder(); // natural opportunity for the 20-message staleness ping
    }
    placePlanBar(); // strip moves home (window) or out (float) with visibility
}

// 纯判定：这次点击是否落在「不该触发收起」的 UI 上。pad- 前缀带连字符全匹配（sod-/sot- 孪生
// 不在排除面——孪生并装是开发场景，误收起无害且可再开）。
// #toast-container 单列：我们自己的提示是 toastr 的元素，挂在酒馆的 toast 容器里、不带 pad- 前缀
// ——不排除就会「点提示顺手把窗口收了」。
function isOracleUiEvent(target) {
    if (!target || typeof target.closest !== 'function') return false;
    const hit = target.closest(
        '#pad-window, #pad-plan-float, #extensionsMenu, #extensionsMenuButton,'
        + ' #toast-container, dialog, .popup, [id^="pad-"], [class^="pad-"], [class*=" pad-"]',
    );
    // 1.48.1：命中 body/html 不算数——1.45.0 皮肤把 pad-skin-* 类挂在 <body> 上（applyWindowSkin），
    // closest 会一路走到 body；不排掉的话 dark/light 皮肤下【页面上任何点击】都被当成自家 UI，
    // 收起永远不触发（theme 皮肤不挂类，所以单测和 smoke 全绿着漏过了它）。
    return !!(hit && hit !== document.body && hit !== document.documentElement);
}
export function onDocClickOutside(e) {
    if (!getSettings().clickOutsideClose) return;
    if (!win || win.style.display === 'none') return;
    if (isOracleUiEvent(e.target)) return;
    try {
        const sel = window.getSelection();
        if (sel && String(sel).length) return;   // 正在选字（含选段校正划选）→ 不收
    } catch (err) { /* ignore */ }
    toggleWindow(false);
}

/* ------------------------------------------------------------------ *
 * 模式切换。互斥模式：chat / diagnose / lorebook / advisor / fix / builder。
 * setOracleMode 是唯一的写入口（booleans、CSS 类、按钮高亮、输入框占位符
 * 都在这里统一处理）——各 toggle 只负责自己的进入/退出提示。
 * ------------------------------------------------------------------ */
const MODE_PLACEHOLDERS = {
    chat: '就当前剧情提问…（Enter 发送，Shift+Enter 换行）',
    diagnose: '描述哪里看起来不对，或让我检查最新一次更新 / 审计当前状态…',
    lorebook: '问问这本世界书，或让我改写 / 新增 / 删除某个条目…',
    advisor: '聊聊剧情接下来可以怎么走…（出方案后可一键开始引导）',
    fix: '想怎么改最新这条回复都行——重写、删改、换语气、调节奏、改设定…说出来，我来改一版…',
    builder: '告诉我你想打造谁——完善你自己的角色，还是创造 / 充实一个 NPC…',
};

// 各模式的空状态：模式图标 + 引导语 +（可选）副标题 + 示例 chip。点一下 chip 把问题填进输入框
// 并聚焦，回车即发，由该模式的发送管线处理。与 MODE_PLACEHOLDERS 并列维护。用户选择方案 A：
// 侧聊为空时它取代进入提示（modeEntryNote 此时跳过那段说明，避免与引导语 + chip 叠加重复）。
export const MODE_EMPTY = {
    chat: {
        icon: 'fa-moon',
        lead: '关于当前剧情，尽管问吧。',
        sub: '此窗口与主聊天相互独立。',
        chips: ['接下来可能会发生什么？', '这个角色现在的处境如何？', '帮我理一下当前的剧情线。'],
    },
    diagnose: {
        icon: 'fa-stethoscope',
        lead: '检查并修复 MVU 变量状态。',
        chips: ['检查最新一条回复有没有问题。', '审计一下当前的整个状态。'],
    },
    lorebook: {
        icon: 'fa-book',
        lead: '聊聊或修改这本世界书。',
        chips: ['这本世界书都写了些什么？', '帮我新增一个条目。', '找找条目之间有没有矛盾。'],
    },
    advisor: {
        icon: 'fa-compass',
        lead: '一起构思剧情接下来怎么走。',
        chips: ['接下来剧情可以怎么走？给我几个方向。', '基于现在的局势，提一个值得推进的转折。'],
    },
    // icon 是 Font Awesome 类名（renderEmptyState 拼成 `fa-solid ${icon}`），与上面各模式一致——
    // 用与校正按钮同款的 fa-wand-magic-sparkles（不是 emoji，emoji 拼进 class 会渲染空白）。
    fix: {
        icon: 'fa-wand-magic-sparkles',
        lead: '手动：在下方输入框直接说要改哪里，只改这一条回复（快、单稿）。<br>自动：每条新回复后台自动清 AI 味——「校正设置」切到「去 AI 味」、开「每条新回复自动去 AI 味」。',
        sub: '校正只去 AI 腔 / 收紧读感——不翻译、不改设定、不算数值、不修卡片本身的问题。',
        chips: ['这个角色不该知道这件事，重写他的对话', '这个事件的日期不对，回看上下文改正', '这个角色的台词太机械，重写得更像真人', '扩写这一段，补充更多剧情细节'],
    },
    builder: { icon: 'fa-masks-theater', lead: '一起打造一个立得住的角色。',
        sub: '先聊清楚是谁、什么样，再一键锻造成稿；写入前都只是草稿。',
        chips: ['帮我完善我当前的角色。', '我想造一个全新的 NPC。', '把剧情里出现过的那个角色写成世界书条目。'] },
};

export function currentOracleMode() {
    return diagnoseMode ? 'diagnose' : (lorebookMode ? 'lorebook' : (advisorMode ? 'advisor' : (fixMode ? 'fix' : (builderMode ? 'builder' : 'chat'))));
}

export function modeReturnNote(mode) {
    if (mode === 'diagnose') return '已返回诊断模式。';
    if (mode === 'advisor') return '已返回剧情参谋模式。';
    if (mode === 'fix') return '已返回校正模式。';
    if (mode === 'lorebook') return '已返回世界书模式。';
    if (mode === 'builder') return '已返回角色工坊模式。';
    return '已返回普通聊天模式。';
}

export function setOracleMode(target) {
    activateOracleMode(target);
    win.classList.toggle('pad-diag-on', diagnoseMode);
    win.classList.toggle('pad-lb-on', lorebookMode);
    win.classList.toggle('pad-adv-on', advisorMode);
    win.classList.toggle('pad-fix-on', fixMode);
    win.classList.toggle('pad-bld-on', builderMode);
    win.querySelector('#pad-diagnose-btn').classList.toggle('pad-diag-active', diagnoseMode);
    win.querySelector('#pad-lorebook-btn').classList.toggle('pad-lb-active', lorebookMode);
    win.querySelector('#pad-advisor-btn').classList.toggle('pad-adv-active', advisorMode);
    win.querySelector('#pad-fix-btn').classList.toggle('pad-fix-active', fixMode);
    win.querySelector('#pad-builder-btn')?.classList.toggle('pad-bld-active', builderMode);
    inputEl.placeholder = MODE_PLACEHOLDERS[target] || MODE_PLACEHOLDERS.chat;
    if (ENABLE_DIAG_WI_PICKER) refreshDiagPickerUI();   // 诊断「精选条目」栏随模式刷新（用户功能请求）
    updateDiagButtonVisual();   // 诊断按钮（含红色 AUTO）状态随模式切换始终对齐（含从子模式回到诊断时）
    updateFixButtonVisual();    // ✨ 校正按钮：自动校正开启时图标染金（随模式切换对齐）
    // A3：切换模式时自动收起设置面板——腾出纵向空间、别让设置盖住新模式的栏（二创 settings-panel 行为原生化）。
    const _setPanel = win.querySelector('#pad-settings');
    if (_setPanel && _setPanel.classList.contains('open')) {
        _setPanel.classList.remove('open');
        win.classList.remove('pad-settings-open');
    }
    // 📥📤 气泡行 / 空态的导出导入入口随模式刷新（只在 chat / advisor 出现）。
    soApplyConvoIoVisual(null);
    // 每模式独立房间：切模式即把可见侧聊换到该模式的房间（先落盘现流、再重载）。换房时 loadConvoForChat 已重画
    // （含空态）；没换房（同房间 / 开关关）才手动刷新空态——每模式自带引导语 + 示例 chip。
    closeQpMenu();
    renderModelBar();   // ⚡ 快捷指令按模式显示
    const swapped = syncConvoStream();
    if (!swapped && messagesEl && !convo.length) { messagesEl.innerHTML = ''; renderEmptyState(); }
}

// 诊断按钮 = 纯粹的【视图】两态开关（关 ↔ 诊断），1.65.0 起不再承担自动诊断的开关职责。
// 旧设计是三态循环（关 → 诊断 → AUTO → 关）：进 AUTO 要在按钮上连点两下，退出诊断视图又会顺手把
// 自动关掉，于是「视图在哪」和「后台跑不跑」这两件互不相干的事被焊在同一颗按钮上——用户报告的
// 「普通聊天=死胡同」（离开诊断视图后自动仍武装、却没有返回入口）正是这个耦合的产物。现在职责分开：
//   · 按钮 = 我现在要不要看诊断这一房（随时可切，不影响后台）
//   · 诊断设置里的「自动诊断每条新回复」勾选框 = 后台跑不跑（唯一开关，持久化在 autoDiagnoseEnabled）
// 于是死胡同不复存在（按钮永远能把你带回诊断视图），diagButtonState / nextDiagState / diagShouldReveal
// 三个纯函数随三态循环一并退役。
export async function toggleDiagnose() {
    const entering = !diagnoseMode;
    if (!(await confirmModeSwitch(entering ? 'diagnose' : 'chat'))) return;   // 1.36.0 中断确认
    setOracleMode(entering ? 'diagnose' : 'chat');
    if (entering && ENABLE_SCHEMA_DIAG) maybeRunSaveHealth('first');   // 🩺 1.89.0：本聊天首次进诊断 → 查一次存档
    // 退出时若自动仍武装，明说它还在跑 —— 按钮变红是同一件事的视觉信号，但文字得跟上（旧设计里
    // 退出＝顺手关掉自动，用户会带着旧预期点这颗按钮）。
    const autoOn = ENABLE_AUTO_DIAGNOSE && !!getSettings().autoDiagnoseEnabled;
    modeEntryNote(entering
        ? '诊断模式已开启。我会把最新一条 AI 回复中的变量更新，对照本角色卡的 MVU 规则与当前状态进行检查，然后给出一份你可以一键应用的纠正补丁。可以让我检查它、指出哪里看起来不对，或者直接说“审计整个状态”。要让它每条回复都自动跑，在下方「诊断设置」里勾上「自动诊断每条新回复」。'
        : (autoOn
            ? '已返回普通聊天模式。⚠ 自动诊断仍在后台运行（诊断按钮保持红色）——要停掉它，回到诊断模式取消勾选「自动诊断每条新回复」。'
            : '已返回普通聊天模式。'));
    updateDiagButtonVisual();
    focusOracleInput();
}

// 自动诊断的唯一落地口（勾选框 + 警告弹窗确认后都走这里）：持久化 + 视觉 + 勾选框回显 + 一条说明。
// 勾选框只在诊断视图里可见（#pad-diag-bar 随 .pad-diag-on 显示），所以关掉它的路径是「回诊断模式取消勾选」——
// 按钮的 title 与退出提示都这么写。
export function setAutoDiagnose(on) {
    const s = getSettings();
    s.autoDiagnoseEnabled = !!on;
    save();
    reflectAutoDiagCheckbox();
    updateDiagButtonVisual();
    modeEntryNote(on
        ? '🔴 自动诊断已开启。此后每当主聊天收到新的 AI 回复，我都会在后台自动检查其中的 MVU 变量更新，发现问题就【自动应用修复】，并在这里留一条可撤销的记录。窗口关着也照常工作。'
        : '自动诊断已关闭。手动诊断不受影响——你仍可以随时在这里让我检查最新一条回复。');
}

// 勾选框回显（唯一写者）：设置面板重开 / 换聊天 / 警告弹窗确认后都靠它把 UI 拉回与 autoDiagnoseEnabled 一致。
export function reflectAutoDiagCheckbox() {
    if (!win || !ENABLE_AUTO_DIAGNOSE) return;
    const chk = win.querySelector('#pad-diag-auto');
    if (chk) chk.checked = !!getSettings().autoDiagnoseEnabled;
}

// 诊断按钮视觉：自动开启时图标变红 + 显示 AUTO 标签（覆盖普通诊断的蓝色高亮）。init 与每次切换后调用。
export function updateDiagButtonVisual() {
    if (!win) return;
    const btn = win.querySelector('#pad-diagnose-btn');
    if (!btn) return;
    const auto = ENABLE_AUTO_DIAGNOSE && !!getSettings().autoDiagnoseEnabled;
    btn.classList.toggle('pad-diag-auto', auto);
    win.classList.toggle('pad-diag-auto-on', auto);
    btn.title = auto
        ? '诊断模式（点一下开 / 关这一房）—— 🔴 自动诊断正在后台运行：要停掉它，在诊断设置里取消勾选'
        : '诊断模式 —— 修复 MVU 状态变量（自动诊断在诊断设置里勾选开启）';
}

// 纯函数：✨ 按钮三态视觉。off = 无自动校正；on = 自动开、正常跑；pending = 自动开着、但这张卡的
// 「正文形态」还没确认一次（问过 fixA_pieceAsked、还没落 fixA_pieceMode）。pending 态下 runAutoFix 每条
// 回复都走 pending 分支跳过——若无视觉信号就成了「自动校正静默什么都不做」（prince-09 中村 bare 卡漏抓的
// 病灶）。读【本聊天生效】配置（getEffectiveFixCfg，与 maybePostReply 同源），故指示永远跟「实际会不会
// 自动校正」一致。可单测（fix-button-visual.test.mjs）。
function fixButtonVisualState(cfg) {
    if (!ENABLE_REPLY_FIX || !cfg || !cfg.autoFixEnabled) return 'off';
    // 📋 自定义模板任务：整条模式（沿用识别关）没有确认阶梯——恒 on，绝不显示 pending（否则一个永不出现的确认在催用户）。
    if (cfg.fixA_pieceAsked && !cfg.fixA_pieceMode && !(ENABLE_FIX_CUSTOM_TASK && cfg.fixA_task === 'custom' && cfg.fixC_useMechanic === false)) return 'pending';
    return 'on';
}

// 校正按钮视觉（用户功能请求）：自动校正开启时把 ✨ 图标染金，作为「小指示」。Option B（kill the silence，
// 2026-07-07）追加 pending 态（琥珀 + 轻脉冲）：自动开着但这张卡还没「确认一次」时也得看得见，否则每条
// 回复被 runAutoFix 的 pending 分支静默跳过（用户以为坏了）。init / 切模式 / 改开关 / 换聊天 / 问过（ask）/
// 确认（confirm）后调用对齐（与 updateDiagButtonVisual 同款 win 守卫）。
export function updateFixButtonVisual() {
    if (!win) return;
    const btn = win.querySelector('#pad-fix-btn');
    if (!btn) return;
    const state = fixButtonVisualState(getEffectiveFixCfg(getSettings(), getFixCfg()));
    btn.classList.toggle('pad-fix-auto', state === 'on');
    btn.classList.toggle('pad-fix-pending', state === 'pending');
    btn.title = state === 'pending'
        ? '校正模式 · 自动校正已开，但这张卡的正文形态还需你确认一次 —— 点下一条回复弹出的确认提示（或「校正设置」判定行的「确认」），之后每条回复才会自动校正'
        : state === 'on'
            ? '校正模式 · 自动校正已开启（金色）—— 每条新回复都会自动校正（在校正模式设置里关闭）'
            : '校正模式 —— 修一修最新这条回复（AI 味 / 对话 / 设定 / 详略…），应用后可一键撤销';
}

// 首次开启自动模式前的一次性警告弹窗（含「不再提示」+ 与 MVU「额外模型解析」并用时的兼容开关提醒）。
export function openAutoDiagWarn() {
    if (!win) return;
    const never = win.querySelector('#pad-autowarn-never');
    if (never) never.checked = false;
    const modal = win.querySelector('#pad-autowarn');
    if (modal) modal.classList.add('open');
}

// ✨ 校正：首次切到「自动校正」时弹的一次性提醒（标签块 <sceneinfo>/<details> 的留存要靠排除区·保留——写起始标记即可）。
// 与 openAutoDiagWarn 同款：纯展示弹窗，「知道了」关闭、勾「不再提示」则置 autoFixWarned。仅在 !autoFixWarned 时由切到自动的处理器调起。
export function openAutoFixWarn() {
    if (!win) return;
    const never = win.querySelector('#pad-fixwarn-never');
    if (never) never.checked = false;
    const modal = win.querySelector('#pad-fixwarn');
    if (modal) modal.classList.add('open');
}

export async function toggleLorebook() {
    if (lorebookMode) {
        const back = priorOracleMode || 'chat';
        if (!(await confirmModeSwitch(back))) return;   // 1.36.0 中断确认：有在途回复会被切换中止 → 先问
        resetPriorOracleMode();
        setOracleMode(back);
        modeEntryNote(modeReturnNote(back));
        focusOracleInput();
        return;
    }
    if (!(await confirmModeSwitch('lorebook'))) return;   // 1.36.0 中断确认
    rememberPriorOracleMode(currentOracleMode());
    setOracleMode('lorebook');
    populateLorebookBooks();
    modeEntryNote('世界书模式已开启。我已读取选定世界书的全部条目——你可以问里面写了什么、找矛盾、聊扩写思路；也可以让我改写、新增或删除条目，我会给出一份你能一键应用（并可撤销）的改动。上方可切换要处理哪一本。');
    focusOracleInput();
}

// 校正模式按钮：进入 / 退出（普通两态，无 AUTO）。杀死开关关闭时 no-op（不可进入）。
export async function toggleFix() {
    if (!ENABLE_REPLY_FIX) return;
    if (fixMode) {
        const back = priorOracleMode || 'chat';
        if (!(await confirmModeSwitch(back))) return;   // 1.36.0 中断确认
        resetPriorOracleMode();
        setOracleMode(back);
        modeEntryNote(modeReturnNote(back));
        focusOracleInput();
        return;
    }
    if (!(await confirmModeSwitch('fix'))) return;   // 1.36.0 中断确认
    enterFixMode();
}

// 进入校正模式的【无门】本体（1.42.0 抽出）：toggleFix = 确认门 + 本体。主聊天 ✂️ 入口的门放在【开窗之前】
//（spec 决定 6「拒绝零足迹」），过门后直接调本体——不复用 toggleFix 是为了不弹第二次确认。行为与抽出前逐字节同。
export function enterFixMode() {
    rememberPriorOracleMode(currentOracleMode());
    setOracleMode('fix');
    modeEntryNote('校正模式已开启。我会读取最新一条 AI 回复，按你说的把它改一版——你想怎么改都行：重写某段、改语气、调节奏、删减、改掉某个设定或不合适的描写……任何要求都可以。直接说你想改什么，我给出一份可一键应用的校正稿；应用会直接替换当前回复，结果卡可随时撤销或重新应用。');
    focusOracleInput();
}

// 角色工坊按钮：进入 / 退出。总开关关闭时 no-op。
export async function toggleBuilder() {
    if (!ENABLE_CHAR_BUILDER) return;
    if (builderMode) {
        const back = priorOracleMode || 'chat';
        if (!(await confirmModeSwitch(back))) return;   // 1.36.0 中断确认（锻造/深度精简保活不触发——它们切走不中断）
        resetPriorOracleMode();
        setOracleMode(back);   // 内部已 syncConvoStream → 切回该模式的房间
        modeEntryNote(modeReturnNote(back));
        focusOracleInput();
        return;
    }
    if (!(await confirmModeSwitch('builder'))) return;   // 1.36.0 中断确认
    rememberPriorOracleMode(currentOracleMode());
    setOracleMode('builder');   // 内部已 syncConvoStream → 切到当前打造目标的独立房间
    populateBuilderBooks();   // Task 4：填充选书 / 选条目器 + chips（定义在 populateLorebookBooks 附近）
    refreshDraftCard();       // Task 6 provides this; stub `function refreshDraftCard() {}` this task
    modeEntryNote('角色工坊已开启。先在下方设置里选好打造目标（用户角色·抢话 / 用户角色·不抢话 / NPC 条目），告诉我你想打造谁——我会先问清楚，再一键锻造成稿。');
    focusOracleInput();
}
// 草稿常驻卡：唯一事实源是 chat metadata；每次刷新整卡重建（含重载后恢复）。
export function refreshDraftCard() {
    const card = win?.querySelector('#pad-bld-card');
    if (!card) return;
    const st = getBuilderState();
    // 复审修复 2：中间态——已有访谈汇总但草稿还没生成（重载后可从这里直接锻造，让 brief-only 会话可恢复）。
    if (st && st.brief && !st.draft) {
        card.style.display = 'flex';
        card.innerHTML = '';
        const bhead = document.createElement('div');
        bhead.textContent = '📋 已有访谈汇总（草稿还未生成）';
        const bbody = document.createElement('div');
        bbody.className = 'pad-bld-card-body';
        const bdesc = String(st.brief.desc || '');
        bbody.textContent = bdesc.length > 200 ? bdesc.slice(0, 200) + '…' : bdesc;
        const bbtns = document.createElement('div');
        bbtns.className = 'pad-bld-card-btns';
        const gen = document.createElement('button');
        gen.type = 'button'; gen.className = 'pad-apply-btn'; gen.textContent = '🔨 生成';
        gen.addEventListener('click', () => runForge());
        bbtns.appendChild(gen);
        card.append(bhead, bbody, bbtns);
        return;
    }
    if (!st || !st.draft) { card.style.display = 'none'; card.innerHTML = ''; return; }
    card.style.display = 'flex';
    card.innerHTML = '';
    const head = document.createElement('div');
    head.textContent = '📝 ' + draftCardLabel(st.draft)
        + (ENABLE_DRAFT_CONDENSE && st.draft.activeVariant === 'condensed' && typeof st.draft.condensed === 'string' ? '（精简稿）' : '');
    const body = document.createElement('div');
    body.className = 'pad-bld-card-body';
    body.textContent = activeDraftContent(st.draft);   // ✂️ 卡体显示激活变体（无精简稿 = 原稿，字节不变）
    const btns = document.createElement('div');
    btns.className = 'pad-bld-card-btns';
    const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pad-apply-btn'; b.textContent = label; b.addEventListener('click', fn); btns.appendChild(b); return b; };
    mk('🔨 重新锻造', () => runForge());                       // Task 7
    // ✂️ 精简（1.30.0，读点 1/3）：npc-* 草稿出精简按钮；已有精简稿则出「原稿⇄精简稿」切换钮
    //（●标当前激活侧；写入/修订都以激活侧为准）。persona 目标 v1 不出按钮（spec §4.4）。
    if (ENABLE_DRAFT_CONDENSE && String(st.draft.target || '').startsWith('npc')) {
        if (typeof st.draft.condensed === 'string') {
            const isCond = st.draft.activeVariant === 'condensed';
            const rawN = String(st.draft.content || '').replace(/\s/g, '').length;
            const condN = st.draft.condensed.replace(/\s/g, '').length;
            mk(isCond ? `原稿 ${rawN}字 ⇄ ●精简稿 ${condN}字` : `●原稿 ${rawN}字 ⇄ 精简稿 ${condN}字`, () => {
                const cur = getBuilderState();
                if (!cur?.draft) return;
                setBuilderState({ ...cur, draft: { ...cur.draft, activeVariant: cur.draft.activeVariant === 'condensed' ? 'raw' : 'condensed' } });
                refreshDraftCard();
            });
            if (!isCond) {
                // 原稿侧也保留两个精简按钮（Prince 2026-07-12）：换一档重跑的路要在——精简恒从原稿
                // 起跑（幂等），重跑成功即覆盖旧精简稿；精简稿侧不出按钮（看结果的视角，切回原稿再跑）。
                if (ENABLE_LIGHT_CONDENSE) mk('✂️ 精简全稿', () => runCondense());   // 轻精简 2026-07-19 起全员关闭
                mk('✂️✂️ 深度精简', () => runCondenseDepth());
            }
        } else {
            if (ENABLE_LIGHT_CONDENSE) mk('✂️ 精简全稿', () => runCondense());   // 轻精简 2026-07-19 起全员关闭
            mk('✂️✂️ 深度精简', () => runCondenseDepth());
        }
    }
    mk('写入', (e) => applyBuilderDraft(e.currentTarget));      // Task 8
    mk('放弃草稿', async () => {
        if (!(await uiConfirm('确定放弃当前草稿吗？'))) return;
        const cur = getBuilderState();
        setBuilderState(cur && cur.brief ? { brief: cur.brief, draft: null, forgedAt: null } : null);
        refreshDraftCard();
    });
    card.append(head, body, btns);
}