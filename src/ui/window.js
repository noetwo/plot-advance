import { applyToolsInHeader, setSettingsTab, toggleSettings } from '../bootstrap.js';
import { confirmConvoSwap, confirmModeSwitch, convoStreamKeyForMode, getWiCustomMeta, setSummary, setWiCustomMeta } from '../core/chat-metadata.js';
import { diagRetryMax } from '../core/post-reply.js';
import { QP_DEFAULTS, closeConnPicker, closeModelMenu, closeQpMenu, connPresetSnapshot, connPresetUpsert, getSettings, managedQuickPromptMode, qpNewId, renderConnPresets, renderModelBar, renderQpManager, save, uiConfirm, uiPrompt } from '../core/settings.js';

import { addSystemNote, clearConversation, modeEntryNote, renderEmptyState, syncConvoStream } from '../modes/advisor/cards.js';
import { getPath } from '../modes/advisor/metadata.js';
import { maybeWritePathDetail, pathAbandon, pathComplete, pathSendBack, syncNodeDetailSeg, toggleGuidePause } from '../modes/advisor/story-path.js';
import { currentInjectionPreview, renderPlanBar, startPathEdit, syncPlanBarCollapsed } from '../modes/advisor/ui.js';
import { toggleAdvisor } from '../modes/builder/ui.js';
import { autoGrowInput, nearBottom, openSummary, soApplyConvoIoVisual, updateSummaryIndicator } from '../modes/chat/history.js';
import { onSend } from '../modes/chat/send.js';
import { openMvuEditor } from '../modes/diagnose/editor.js';
import { filterWiCustomBooks, onDiagHybridToggle, onDiagTargetChange, onDiagUseSelToggle, populateDiagWiBooks, populateWiCustomBooks, reflectDiagRetryVisible, selectFilteredDiagEntries, selectFilteredWiCustomEntries, setAllDiagEntries, setAllWiCustomBooks, setAllWiCustomEntries, setDiagEntriesByType, setWiCustomEntriesByType, updateDiagFilteredBtn, updateWiCustomFilteredBtn } from '../modes/diagnose/pickers.js';
import { maybeRunSaveHealth } from '../modes/diagnose/diagnostics.js';
import { clampFixAutoMinChars, normalizeScopeInput } from '../modes/fix/algorithms.js';
import { openFixSelectCard, refreshFixChatEntry, runFixByTargets } from '../modes/fix/selection.js';
import { fixEnvNote, runCustomTaskNow } from '../modes/fix/staging.js';
import { applyPlanInjection, deleteFixBundle, deleteFixTemplate, findFixTemplate, getEffectiveFixCfg, getFixCfg, loadFixBundle, normalizeFixTemplates, openFixHub, openFixShare, pathActiveNode, saveFixBundle, saveFixTemplate, setFixCfg } from '../modes/fix/templates.js';
import { applyFixFlavorView, applyFixModeView, applyFixPresetLock, openDebug, populateFixBundles, populateFixTemplates, renderFixConfigWarnings, resetFixCfg, scanFixScope, seedFixControls, updateFixTplDirtyMarker, updateFixVerdict } from '../modes/fix/ui.js';
import { normalizeBldTarget } from '../modes/builder/model.js';
import { filterBldBooks, onBldBookSelectionChange, populateBuilderBooks, renderBuilderChips, selectFilteredBldEntries, setAllBldEntries, setBldEntriesByType, toggleBuilderChipsLegend, updateBldFilteredBtn } from '../modes/builder/books-ui.js';
import { filterBookEntries } from '../modes/lorebook/selection.js';
import { filterLbBooks, onLbBookSelectionChange, openSmartSelect, populateLorebookBooks, reflectLbPreview, selectFilteredLbEntries, setAllLbEntries, setLbEntriesByType, toggleLbPreview, updateLbFilteredBtn } from '../modes/lorebook/ui.js';
import { BUILDER_NPC_ONLY, ENABLE_AUTO_DIAGNOSE, ENABLE_BBS_BRIDGE, ENABLE_BUILDER_PERSONA_STYLES, ENABLE_DIAG_BODY_INJECT, ENABLE_DIAG_WI_PICKER, ENABLE_DRAFT_CONDENSE, ENABLE_FIX_CUSTOM_TASK, ENABLE_FIX_TEMPLATE_HUB, ENABLE_LB_SMART_SELECT, ENABLE_LIGHT_CONDENSE, ENABLE_LWB_BRIDGE, ENABLE_MVU_EDITOR, ENABLE_SCHEMA_DIAG, ENABLE_WI_CUSTOM_PICK, ENABLE_WI_EJS_RENDER } from '../prompts/builtins.js';
import { fixSampleCopyName, fixTemplateIsBuiltin } from '../prompts/helpers.js';
import { promptDef, promptReset, promptSet } from '../prompts/registry.js';
import { wiEffectiveMode } from '../st/adapters.js';
import { onFetchModels, openExtraParams, updateExtraParamsHint } from '../transport/direct.js';
import { applyWindowSkin, syncChatBarButton, syncFixSelBarButton, syncQrButton } from './chat-entry.js';
import { applyInitialGeometry, makeDraggable, makeResizable, onFullscreenEscKeydown, scheduleEnsureInView, setFullscreen } from './geometry.js';
import { copyTextRobust, trackStreamFollow } from './messages.js';
import { currentOracleMode, onDocClickOutside, openAutoDiagWarn, openAutoFixWarn, openCuration, reflectAutoDiagCheckbox, setAutoDiagnose, setOracleMode, soEnterShouldSend, soIsMobileForEnter, soReadSendOnEnter, toggleBuilder, toggleDiagnose, toggleFix, toggleLorebook, toggleWindow, updateDiagButtonVisual, updateFixButtonVisual } from './mode-shell.js';
import { bindPersonaEditor, populatePersonas } from './persona-editor.js';
import { applyModeVisibility, applyPromptEditorUiState, buildCurationRows, curationRowsFromSnapshot, getCuratedSnapshot, loadPromptEditor, onPresetSelected, populateSysPromptPresets, presetCurationActive, promptEditId, refreshProfiles, refreshPromptBadges, updateBadge, updateWiHint } from './settings.js';
import { resetPriorOracleMode } from '../core/oracle-modes.js';
import { bindPlanBar, planBarEl } from '../modes/advisor/ui.js';
import { clearFixTemplateDirty, fixTplDirty, fixTplDirtyFor, markFixTemplateDirty } from '../modes/fix/templates.js';
import { inputEl, messagesEl, registerWindowControls, registerWindowRoot, sendBtn, win } from './refs.js';
import { applyWindowMarkup } from './window-template.js';

/* ------------------------------------------------------------------ *
 * The floating window
 * ------------------------------------------------------------------ */


export function buildWindow() {
    if (document.getElementById('pad-window')) return;
    const s = getSettings();

    registerWindowRoot(document.createElement('div'));
    win.id = 'pad-window';
    win.style.display = 'none';
    applyInitialGeometry(s);
    // 视口变化时把窗口重新夹回可见区——旋屏 / 手机软键盘弹收 / 浏览器地址栏伸缩都会改变【可见】视口，
    // 否则 position:fixed 的窗口标题栏（唯一带 ✕ 关闭 + 拖动把手的地方）可能被挤出屏外、再也够不到
    //（手机「常驻、无法关闭」bug）。ensureWindowInView 只贴合显示、不 save，键盘收起后会自己长回原尺寸。
    window.addEventListener('resize', scheduleEnsureInView);
    window.addEventListener('orientationchange', scheduleEnsureInView);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleEnsureInView);

    applyWindowMarkup(win);
    document.body.appendChild(win);

    registerWindowControls();

    bindControls();
    enhanceIconButtonA11y();
    loadSettingsIntoForm();
    bindPlanBar(win.querySelector('#pad-plan-bar'));
    // 手机：整条标题栏（含 8 个按钮）都能起拖——按钮太多、留给拖动的空隙太少（用户反馈「手机拖不动」）。
    // 复用折叠药丸那套（1.17.5）：dragFromButtons 放行「在按钮上起拖」，再用 6px 位移阈值区分轻点/拖动，
    // suppressNextClick 吞掉拖完补发的一下 click，所以轻点按钮照常触发、拖动才移动窗口。桌面（≥600）不传、行为不变。
    makeDraggable(win, win.querySelector('#pad-header'), { left: 'winLeft', top: 'winTop' },
        { dragFromButtons: () => window.innerWidth < 600 });
    makeResizable(win, win.querySelector('#pad-resize-grip'));
    renderEmptyState();
    renderPlanBar();
}

// 无障碍：图标按钮本是 <div>（为了样式自由），这里补上原生 <button> 该有的语义与键盘操作——
// role=button + 可聚焦（tabindex）+ Enter/空格触发，并把每个按钮已有的 title 复用为屏幕阅读器
// 的可读名（aria-label）。这样整套图标工具栏对键盘 / 读屏用户也完全可用，且无需改动任何模板标记。
function enhanceIconButtonA11y() {
    win.querySelectorAll('.pad-iconbtn').forEach(enhanceIconBtnNode);
    // 委托键盘事件：聚焦某个图标按钮时按 Enter / 空格即等同点击（原生 <button> 的默认行为）。
    // 输入框 / 文本域里的按键不会命中（closest 找不到 .pad-iconbtn），故不影响打字与「Enter 发送」。
    win.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const btn = e.target.closest && e.target.closest('.pad-iconbtn');
        if (!btn || !win.contains(btn)) return;
        e.preventDefault();
        btn.click();
    });
}

// 单个图标按钮的语义补齐（幂等）。抽成独立函数是因为【动态建卡】的图标按钮
// 赶不上 buildWindow 那一趟批量增强，而 enhanceIconButtonA11y 整体【不可】重复调用——
// 它每次还会往 win 上再挂一只委托 keydown，重复挂 = 按一下 Enter 触发两次 click。
// 委托本身挂在 win 上、动态卡片又都追加在 win 内部 → 单独补上 tabindex 就能被聚焦，Enter/空格照常生效。
export function enhanceIconBtnNode(b) {
    if (!b) return;
    b.setAttribute('role', 'button');
    if (!b.hasAttribute('tabindex')) b.setAttribute('tabindex', '0');
    if (!b.getAttribute('aria-label') && b.title) b.setAttribute('aria-label', b.title);
}

function bindControls() {
    const s = getSettings();

    win.querySelector('#pad-close-btn').addEventListener('click', () => toggleWindow(false));
    win.querySelector('#pad-fullscreen-btn').addEventListener('click', () => setFullscreen());   // 全屏阅读切换（1.51.0）
    document.addEventListener('keydown', onFullscreenEscKeydown, true);   // 全屏时 ESC 退出（捕获阶段，gated on 全屏）
    win.querySelector('#pad-clear-btn').addEventListener('click', clearConversation);
    win.querySelector('#pad-diagnose-btn').addEventListener('click', toggleDiagnose);
    win.querySelector('#pad-lorebook-btn').addEventListener('click', toggleLorebook);
    win.querySelector('#pad-advisor-btn').addEventListener('click', toggleAdvisor);
    win.querySelector('#pad-fix-btn').addEventListener('click', toggleFix);
    win.querySelector('#pad-adv-preset').addEventListener('change', (e) => {
        const s2 = getSettings();
        s2.advisorUsePreset = e.target.checked;
        save();
        if (e.target.checked) {
            addSystemNote(presetCurationActive(s2)
                ? '已开启「套用补全预设」：剧情参谋指令会叠加在你的补全预设之上。注意预设可能分散模型注意力——仅在需要越狱时使用。'
                : '已勾选「套用补全预设」，但目前还没有整理好的补全预设。请先到设置（齿轮）里选定并整理一个补全预设；在此之前，参谋模式仍用内置提示词。');
        }
    });
    // Live depth change re-registers the active injection — wired AFTER the
    // generic bind() below so the new value is already persisted when it runs.
    win.querySelector('#pad-plan-show').addEventListener('click', () => {
        // Query through planBarEl, not win — the strip may have been reparented
        // into the floating container by the time this fires.
        const pre = planBarEl.querySelector('#pad-plan-directive');
        const open = pre.classList.toggle('open');
        planBarEl.querySelector('#pad-plan-show').textContent = open ? '▾ 收起注入内容' : '▸ 查看注入内容';
        if (open) pre.textContent = currentInjectionPreview();   // type-aware (sequence beat OR single plan)
    });
    // 引导条收起 / 展开箭头（用户反馈：停靠时默认收起、别挡聊天视图）。状态持久化；renderPlanBar 也同步。
    win.querySelector('#pad-plan-collapse').addEventListener('click', () => {
        const s = getSettings();
        s.planBarCollapsed = !s.planBarCollapsed;
        save();
        syncPlanBarCollapsed();
    });
    // ✏️ 修改当前目标（2.5.0）：在方案条的列表里就地编辑当前节点。
    win.querySelector('#pad-plan-edit').addEventListener('click', () => {
        const path = getPath();
        const node = pathActiveNode(path);
        if (node) startPathEdit(node.id);
    });
    /* 点击窗外自动收起（1.48.0，opt-in clickOutsideClose）。监听 click 而非 pointerdown：
     * 滚屏滑动、长按选字都不产生 click；再加
     * 「有选区不收」保险。capture 阶段注册：别人 stopPropagation 也拦不住我们看见这次点击。
     * 排除面 = 一切 pad- 前缀元素（本扩展全部选择器按约定带 pad- 前缀，含浮条/toast/🌙）
     * + ST 弹窗 + 魔杖菜单（不排除会出现「点菜单先关窗、点菜单项又开窗」的双开关打架）。 */
    document.addEventListener('click', onDocClickOutside, true);
    win.querySelector('#pad-plan-done').addEventListener('click', () => pathComplete());
    win.querySelector('#pad-plan-pause').addEventListener('click', () => toggleGuidePause());
    win.querySelector('#pad-plan-drop').addEventListener('click', () => { void pathAbandon(); });
    // 「找参谋改改」：开参谋房继续讨论（当前目标照常引导着）。
    win.querySelector('#pad-seq-sendback').addEventListener('click', () => pathSendBack());
    win.querySelector('#pad-lb-refresh').addEventListener('click', () => populateLorebookBooks(true));
    win.querySelector('#pad-lb-book-list').addEventListener('change', (e) => {
        if (e.target && e.target.matches('input[type="checkbox"]')) onLbBookSelectionChange();
    });
    win.querySelector('#pad-lb-book-all').addEventListener('click', () => {
        win.querySelectorAll('#pad-lb-book-list input[type="checkbox"]').forEach((b) => { b.checked = true; });
        onLbBookSelectionChange();
    });
    win.querySelector('#pad-lb-book-none').addEventListener('click', () => {
        win.querySelectorAll('#pad-lb-book-list input[type="checkbox"]').forEach((b) => { b.checked = false; });
        onLbBookSelectionChange();
    });
    win.querySelector('#pad-lb-story').addEventListener('change', (e) => {
        getSettings().lorebookIncludeStory = e.target.checked;
        save();
    });
    win.querySelector('#pad-lb-preset').addEventListener('change', (e) => {
        const s2 = getSettings();
        s2.lorebookUsePreset = e.target.checked;
        save();
        if (e.target.checked) {
            addSystemNote(presetCurationActive(s2)
                ? '已开启「套用补全预设」：世界书管家指令会叠加在你的补全预设之上。注意预设可能分散模型注意力、影响编辑精度——仅在需要越狱时使用。'
                : '已勾选「套用补全预设」，但目前还没有整理好的补全预设。请先到设置（齿轮）里选定并整理一个补全预设；在此之前，世界书模式仍用内置管家提示词。');
        }
    });
    win.querySelector('#pad-lb-entries-toggle').addEventListener('click', () => {
        win.querySelector('#pad-lb-entries').classList.toggle('open');
    });
    // 手机上把模式工具栏（各模式的配置栏）默认折叠，先把聊天区露出来；桌面保持展开。用户随后可自行开合。
    // 参谋 / 工坊此前漏在名单外：#pad-messages 是 flex:1 1 0（basis 0 → 负剩余空间时收缩权重为 0），
    // 配置栏一旦比可用高度还高，被压没的就是聊天区。工坊锻造成功后仍会主动展开该面板（见 runForge）。
    if (window.matchMedia && window.matchMedia('(max-width: 600px)').matches) {
        win.querySelectorAll('#pad-lb-collapse, #pad-diag-collapse, #pad-fix-collapse, #pad-adv-collapse, #pad-bld-collapse')
            .forEach((d) => { d.open = false; });
    }
    win.querySelector('#pad-lb-all').addEventListener('click', () => setAllLbEntries(true));
    win.querySelector('#pad-lb-none').addEventListener('click', () => setAllLbEntries(false));
    win.querySelector('#pad-lb-filtered').addEventListener('click', () => selectFilteredLbEntries());
    win.querySelector('#pad-lb-blue').addEventListener('click', () => setLbEntriesByType('blue'));
    win.querySelector('#pad-lb-green').addEventListener('click', () => setLbEntriesByType('green'));
    win.querySelector('#pad-lb-disabled').addEventListener('click', () => setLbEntriesByType('off'));
    win.querySelector('#pad-lb-preview-toggle').addEventListener('click', () => toggleLbPreview());
    win.querySelector('#pad-lb-entries-filter').addEventListener('input', (e) => filterBookEntries('#pad-lb-entries-list', e.target.value, updateLbFilteredBtn, win));
    win.querySelector('#pad-lb-book-filter').addEventListener('input', (e) => filterLbBooks(e.target.value));
    // 世界书「智能选条」🪄 入口（ENABLE_LB_SMART_SELECT）：创建门——关时按钮从不创建、字节级零变化。
    // 弹出输入框走懒建 overlay（openSmartSelect），不占选择器常驻空间（1.49.0 搜索框教训：picker 已很挤）。
    if (ENABLE_LB_SMART_SELECT) {
        const tools = win.querySelector('#pad-lb-entries .pad-lb-entries-tools');   // 📖 那条工具栏（class 有三处：诊断/工坊/世界书）
        if (tools && !tools.querySelector('#pad-lb-smart')) {
            const b = document.createElement('button');
            b.type = 'button';
            b.id = 'pad-lb-smart';
            b.className = 'pad-lb-mini pad-lb-mini-magic';
            b.title = '智能选条：用一句话让 AI 帮你勾选 / 取消条目（只动勾选、可一键还原）';
            b.textContent = '🪄 智能选条';
            b.addEventListener('click', () => openSmartSelect());
            tools.insertBefore(b, tools.firstChild);
        }
    }
    // 🎛 变量编辑器入口（ENABLE_MVU_EDITOR）。关时模板里就没有这个按钮 → querySelector 为 null，
    // 布线守卫与模板守卫同源，两处一起 no-op = 字节级零变化（同 ENABLE_DIAG_BODY_INJECT 的 bind 写法）。
    if (ENABLE_MVU_EDITOR) {
        const mvuedBtn = win.querySelector('#pad-mvued-btn');
        if (mvuedBtn) mvuedBtn.addEventListener('click', () => { openMvuEditor(); });
    }
    // 🩺 1.89.0：存档检查按钮（按一次就查一次，结果进诊断记录）。
    if (ENABLE_SCHEMA_DIAG) {
        const hb = win.querySelector('#pad-diag-health-btn');
        if (hb) hb.addEventListener('click', () => { maybeRunSaveHealth('button'); });
    }
    // 诊断经自定义补全预设（1.43.0，opt-in）——全局开关，同 advisorUsePreset 写法（写 getSettings + save）。
    win.querySelector('#pad-diag-preset').addEventListener('change', (e) => {
        const s2 = getSettings();
        s2.diagnoseUsePreset = e.target.checked;
        save();
        if (e.target.checked) {
            addSystemNote(presetCurationActive(s2)
                ? '已开启「套用补全预设」：诊断指令会叠加在你的补全预设之上（手动诊断与自动诊断都生效）。注意预设可能分散模型注意力、影响诊断精度——仅在诊断被模型拒绝时使用。'
                : '已勾选「套用补全预设」，但目前还没有整理好的补全预设。请先到设置（齿轮）里选定并整理一个补全预设；在此之前，诊断仍用内置提示词。');
        }
    });
    // 🩺 1.89.0：「被拒时让模型自动重写一次」（全局开关，写 getSettings + save）。
    if (ENABLE_SCHEMA_DIAG) {
        const sr = win.querySelector('#pad-diag-schema-retry');
        if (sr) sr.addEventListener('change', (e) => { getSettings().diagSchemaRetry = e.target.checked; save(); });
    }
    // 诊断「精选世界书条目」绑定（用户功能请求；ENABLE_DIAG_WI_PICKER）。关掉时隐藏那一段、不挂任何处理器。
    if (ENABLE_DIAG_WI_PICKER) {
        win.querySelector('#pad-diag-usesel').addEventListener('change', (e) => onDiagUseSelToggle(e.target.checked));
        win.querySelector('#pad-diag-hybrid').addEventListener('change', (e) => onDiagHybridToggle(e.target.checked));
        win.querySelector('#pad-diag-refresh').addEventListener('click', () => populateDiagWiBooks(true));
        win.querySelector('#pad-diag-book').addEventListener('change', (e) => onDiagTargetChange(e.target.value));
        win.querySelector('#pad-diag-entries-toggle').addEventListener('click', () => {
            win.querySelector('#pad-diag-entries').classList.toggle('open');
        });
        win.querySelector('#pad-diag-all').addEventListener('click', () => setAllDiagEntries(true));
        win.querySelector('#pad-diag-none').addEventListener('click', () => setAllDiagEntries(false));
        win.querySelector('#pad-diag-filtered').addEventListener('click', () => selectFilteredDiagEntries());
        win.querySelector('#pad-diag-blue').addEventListener('click', () => setDiagEntriesByType('blue'));
        win.querySelector('#pad-diag-green').addEventListener('click', () => setDiagEntriesByType('green'));
        win.querySelector('#pad-diag-disabled').addEventListener('click', () => setDiagEntriesByType('off'));
        win.querySelector('#pad-diag-entries-filter').addEventListener('input', (e) => filterBookEntries('#pad-diag-entries-list', e.target.value, updateDiagFilteredBtn, win));
    } else {
        // 只隐藏精选条目那一段 —— 预设行与它无关，不该被这个杀开关带走（1.43.0）
        const wisel = win.querySelector('#pad-diag-wisel');
        if (wisel) wisel.style.display = 'none';
    }
    // 🌐 世界书范围「自定义」绑定（1.81.0；旗关时 markup 不存在、整块不执行）。
    if (ENABLE_WI_CUSTOM_PICK) {
        win.querySelector('#pad-wic-hybrid').addEventListener('change', (e) => {
            const meta = getWiCustomMeta();
            if (!meta) { e.target.checked = false; return; }
            setWiCustomMeta({ books: meta.books, hybrid: e.target.checked, sel: meta.sel });
        });
        win.querySelector('#pad-wic-refresh').addEventListener('click', () => populateWiCustomBooks(true));
        win.querySelector('#pad-wic-book-all').addEventListener('click', () => setAllWiCustomBooks(true));
        win.querySelector('#pad-wic-book-none').addEventListener('click', () => setAllWiCustomBooks(false));
        win.querySelector('#pad-wic-book-filter').addEventListener('input', (e) => filterWiCustomBooks(e.target.value));
        win.querySelector('#pad-wic-entries-toggle').addEventListener('click', () => win.querySelector('#pad-wic-entries').classList.toggle('open'));
        win.querySelector('#pad-wic-all').addEventListener('click', () => setAllWiCustomEntries(true));
        win.querySelector('#pad-wic-none').addEventListener('click', () => setAllWiCustomEntries(false));
        win.querySelector('#pad-wic-filtered').addEventListener('click', () => selectFilteredWiCustomEntries());
        win.querySelector('#pad-wic-blue').addEventListener('click', () => setWiCustomEntriesByType('blue'));
        win.querySelector('#pad-wic-green').addEventListener('click', () => setWiCustomEntriesByType('green'));
        win.querySelector('#pad-wic-disabled').addEventListener('click', () => setWiCustomEntriesByType('off'));
        win.querySelector('#pad-wic-entries-filter').addEventListener('input', (e) => filterBookEntries('#pad-wic-entries-list', e.target.value, updateWiCustomFilteredBtn, win));
    }
    // 标题栏「⋯」工具下拉：把 剧情概要 / 调试 / 设置 三个次级按钮收进一个下拉里。它们的 id 与各自
    // 的点击处理保持不变（只是被挪进菜单内），所以下面 openDebug / 设置开关 / openSummary 的绑定照旧生效。
    const toolsBtn = win.querySelector('#pad-tools-btn');
    const toolsMenu = win.querySelector('#pad-tools-menu');
    const closeToolsMenu = () => {
        if (!toolsMenu) return;
        toolsMenu.classList.remove('open');
        if (toolsBtn) toolsBtn.setAttribute('aria-expanded', 'false');
    };
    if (toolsBtn && toolsMenu) {
        toolsBtn.addEventListener('click', () => {
            const open = toolsMenu.classList.toggle('open');
            toolsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        // 点菜单里的任意一项后收起（该项自己的处理仍会照常触发，打开对应面板 / 设置）。
        toolsMenu.addEventListener('click', (e) => {
            if (e.target.closest('.pad-tools-item')) closeToolsMenu();
        });
        // 点别处或按 Esc 收起。
        document.addEventListener('click', (e) => {
            if (toolsMenu.classList.contains('open') && !e.target.closest('.pad-tools-wrap')) closeToolsMenu();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && toolsMenu.classList.contains('open')) closeToolsMenu();
        });
    }
    // 「普通聊天」菜单项：从任何模式一键回普通聊天（仅切换视图——自动诊断如开启会继续在后台跑，
    // 诊断按钮仍红；要停自动诊断请点诊断按钮）。菜单收起由上面的 .pad-tools-item 监听统一处理。
    win.querySelector('#pad-normalchat-btn')?.addEventListener('click', async () => {
        // 已在普通聊天 → 无事可做。
        if (currentOracleMode() === 'chat') return;
        if (!(await confirmModeSwitch('chat'))) return;   // 1.36.0 中断确认
        resetPriorOracleMode();
        setOracleMode('chat');
        modeEntryNote('已返回普通聊天模式。');
    });
    win.querySelector('#pad-debug-btn').addEventListener('click', openDebug);
    win.querySelector('#pad-debug-close').addEventListener('click', () => win.querySelector('#pad-debug').classList.remove('open'));
    win.querySelector('#pad-debug-copy').addEventListener('click', async () => {
        const btn = win.querySelector('#pad-debug-copy');
        const ok = await copyTextRobust(win.querySelector('#pad-debug-body').textContent || '');
        if (ok) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
            setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1200);
        } else {
            btn.title = '复制失败 —— 请手动选择文本';
        }
    });
    win.querySelector('#pad-builder-btn')?.addEventListener('click', toggleBuilder);
    win.querySelector('#pad-settings-btn').addEventListener('click', () => toggleSettings());
    // 用户功能请求：剧情概要编辑器（本聊天，自动保存到元数据）。
    win.querySelector('#pad-summary-btn').addEventListener('click', openSummary);
    // 📥📤 导出 / 导入对话（1.60.0 / 1.61.0）：⋯ 工具菜单【不】设入口（Prince 2026-08-09 定案）。
    // 唯二的入口是 AI 气泡行上那对小按钮（见 addMessage）＋ 空页时的空态入口（见 renderEmptyState）。
    win.querySelector('#pad-summary-close').addEventListener('click', () => win.querySelector('#pad-summary').classList.remove('open'));
    win.querySelector('#pad-summary-text').addEventListener('input', (e) => {
        setSummary(e.target.value);
        updateSummaryIndicator(e.target.value);
    });
    win.querySelector('#pad-summary-clear').addEventListener('click', async () => {
        const ta = win.querySelector('#pad-summary-text');
        if (ta.value.trim() && !(await uiConfirm('确定清空本聊天的剧情概要吗？'))) return;
        ta.value = '';
        setSummary('');
        updateSummaryIndicator('');
        ta.focus();
    });
    // 用户功能请求：自动诊断首次开启前的一次性警告弹窗。
    const autoWarnOverlay = win.querySelector('#pad-autowarn');
    const closeAutoWarn = () => autoWarnOverlay.classList.remove('open');
    win.querySelector('#pad-autowarn-cancel').addEventListener('click', closeAutoWarn);
    win.querySelector('#pad-autowarn-ok').addEventListener('click', () => {
        if (win.querySelector('#pad-autowarn-never').checked) { getSettings().autoDiagnoseWarned = true; save(); }
        closeAutoWarn();
        setAutoDiagnose(true);   // 1.65.0：确认后才真开（勾选框在弹窗打开那一刻已被拨回未勾选）
    });
    // 🩺 自动诊断勾选框（1.65.0，取代按钮三态循环的第二下点击）。勾上时若还没看过一次性警告，
    // 先把勾拨回去再弹窗——「确认」走 setAutoDiagnose(true) 才真开，「取消 / ✕ / 点遮罩」什么都不做，
    // 于是取消后 UI 与设置天然一致，不需要在三处关闭路径上各写一遍回滚。
    const autoDiagChk = win.querySelector('#pad-diag-auto');
    if (autoDiagChk) autoDiagChk.addEventListener('change', () => {
        if (!autoDiagChk.checked) { setAutoDiagnose(false); return; }
        if (!getSettings().autoDiagnoseWarned) { autoDiagChk.checked = false; openAutoDiagWarn(); return; }
        setAutoDiagnose(true);
    });
    // 手机逃生阀：警告叠层 z60 盖住了标题栏 ✕（顶）和缩放把手 z6（角），底部按钮又可能被压出屏——
    // 于是顶部再给一个始终在屏内的 ✕，点遮罩空白处也能关，保证任何视口下都逃得出去（见 style.css 弹窗注释）。
    autoWarnOverlay.querySelector('.pad-warn-x').addEventListener('click', closeAutoWarn);
    autoWarnOverlay.addEventListener('click', (e) => { if (e.target === autoWarnOverlay) closeAutoWarn(); });
    // ✨ 校正：切到「自动校正」时的一次性标签块提醒（信息性，无需取消——已经切过去了，只是提醒）。
    const fixWarnOverlay = win.querySelector('#pad-fixwarn');
    const closeFixWarn = () => fixWarnOverlay.classList.remove('open');
    const fixWarnOk = win.querySelector('#pad-fixwarn-ok');
    if (fixWarnOk) fixWarnOk.addEventListener('click', () => {
        if (win.querySelector('#pad-fixwarn-never').checked) { getSettings().autoFixWarned = true; save(); }
        closeFixWarn();
    });
    // 同款手机逃生阀（顶部 ✕ + 点遮罩关闭）。
    fixWarnOverlay.querySelector('.pad-warn-x').addEventListener('click', closeFixWarn);
    fixWarnOverlay.addEventListener('click', (e) => { if (e.target === fixWarnOverlay) closeFixWarn(); });
    win.querySelector('#pad-profile-refresh').addEventListener('click', refreshProfiles);
    win.querySelector('#pad-extraparams-btn').addEventListener('click', openExtraParams); // 附加参数（1.70.0）
    updateExtraParamsHint(); // 开窗即反映「设了没设」，不用点开弹窗才知道

    // settings inputs -> persist
    const bind = (id, key, parse = (v) => v) => {
        const el = win.querySelector(id);
        const evt = (el.type === 'checkbox') ? 'change' : 'input';
        el.addEventListener(evt, () => {
            s[key] = el.type === 'checkbox' ? el.checked : parse(el.value);
            if (key === 'mode') {
                applyModeVisibility();
                if (s.mode === 'profile') refreshProfiles();
            }
            updateBadge();
            save();
        });
    };
    bind('#pad-mode', 'mode');
    bind('#pad-endpoint', 'endpoint', (v) => v.trim());
    bind('#pad-apikey', 'apiKey', (v) => v.trim());
    bind('#pad-model', 'model', (v) => v.trim());
    bind('#pad-stream', 'stream');
    bind('#pad-direct-backend', 'directViaBackend'); // 1.17.23：经酒馆后端转发（避免直连 CORS）
    bind('#pad-raw-url', 'directRawUrl');            // 1.22.0：地址原样使用（不自动补 /v1，原生化自二创「最终模式」）
    // A6：连接存档（端点 + 密钥 + 模型 + 地址原样开关 + 高级选项与生成参数的命名快照）。列表行上有「使用」「删除」，这里只管存新档。
    win.querySelector('#pad-conn-preset-save').addEventListener('click', async () => {
        const name = win.querySelector('#pad-conn-preset-name').value.trim();
        if (!name) { if (window.toastr) window.toastr.info('先给存档起个名字', '剧情推进'); return; }
        // 同名会覆盖：先问一句（改了当前存档想存回去，用存档栏下面的「保存到此存档」更顺手）
        const exists = (getSettings().connPresets || []).some((p) => p.name === name);
        if (exists && !(await uiConfirm(`已经有叫「${name}」的存档了，用现在的连接覆盖它吗？`))) return;
        getSettings().connPresets = connPresetUpsert(getSettings().connPresets, {
            ...connPresetSnapshot(getSettings()),
            name,
            endpoint: win.querySelector('#pad-endpoint').value.trim(),
            apiKey: win.querySelector('#pad-apikey').value.trim(),
            model: win.querySelector('#pad-model').value.trim(),
            rawUrl: win.querySelector('#pad-raw-url').checked,   // 1.22.0：地址原样开关随存档保存
        });
        getSettings().connPresetActive = name;
        save();
        win.querySelector('#pad-conn-preset-name').value = '';
        renderConnPresets();
        renderModelBar();
    });
    // 连接方式：两段式按钮代替原来的下拉（下拉还在、只是藏起来，走既有 bind 落盘）。
    for (const b of win.querySelectorAll('#pad-mode-seg [data-mode]')) {
        b.addEventListener('click', () => {
            const sel = win.querySelector('#pad-mode');
            if (sel.value === b.dataset.mode) return;
            sel.value = b.dataset.mode;
            sel.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    // 设置分页 + 右上角关闭
    for (const b of win.querySelectorAll('.pad-set-tab')) b.addEventListener('click', () => setSettingsTab(b.dataset.tab));
    win.querySelector('#pad-settings-close').addEventListener('click', () => toggleSettings(false));
    // ⚡ 设置「快捷指令」页：新建 / 补回预置的。
    win.querySelector('#pad-qp-add').addEventListener('click', () => {
        const mode = managedQuickPromptMode(currentOracleMode());
        getSettings().quickPrompts.push({ id: qpNewId(), mode, label: '新指令', text: '' });
        save();
        renderQpManager();
        const names = win.querySelectorAll('#pad-qp-list .pad-qp-name');
        const last = names[names.length - 1];
        if (last) { last.focus(); last.select(); }
    });
    win.querySelector('#pad-qp-restore').addEventListener('click', () => {
        const list = getSettings().quickPrompts;
        const missing = QP_DEFAULTS.filter((d) => !list.some((q) => q && q.id === d.id));
        for (const d of missing) list.push({ ...d });
        if (missing.length) { save(); renderQpManager(); renderModelBar(); }
        try { toastr.info(missing.length ? `补回了 ${missing.length} 条预置的快捷指令。` : '预置的快捷指令都还在。', '快捷指令'); } catch (e) { /* ignore */ }
    });
    // 切换栏的菜单、快捷指令列表、设置里的存档弹出框：点别处或按 Esc 收起。
    document.addEventListener('click', (e) => {
        const inside = (sel) => !!(e.target && e.target.closest && e.target.closest(sel));
        if (!inside('#pad-model-bar')) closeModelMenu();
        if (!inside('#pad-model-bar')) closeQpMenu();
        // 删存档时弹出的确认框（酒馆的 dialog.popup）也算「里面」：确认完弹出框还开着，可以接着删
        if (!inside('#pad-conn-preset-list, .popup, dialog')) closeConnPicker();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        closeModelMenu();
        closeQpMenu();
        closeConnPicker();
    });
    // A5：工具移到标题栏开关——开时立刻搬（幂等）；关时提示刷新恢复（⋯ 包裹已删，重建靠 buildWindow）。
    win.querySelector('#pad-tools-header-toggle').addEventListener('change', (e) => {
        getSettings().toolsInHeader = e.target.checked;
        save();
        if (e.target.checked) applyToolsInHeader();
        else if (window.toastr) window.toastr.info('已关闭——刷新页面后恢复 ⋯ 工具菜单', '剧情推进');
    });
    // 精简版 1.2：快捷回复栏按钮开关——同样立刻放 / 撤。
    win.querySelector('#pad-qr-toggle').addEventListener('change', (e) => {
        getSettings().showQrButton = e.target.checked;
        save();
        syncQrButton();
    });
    // 用户功能请求：聊天栏快捷按钮开关——改设置后立刻放 / 撤按钮（不只是存）。
    win.querySelector('#pad-chatbar-toggle').addEventListener('change', (e) => {
        getSettings().showChatBarButton = e.target.checked;
        save();
        syncChatBarButton();
    });
    // 点击窗外自动收起（1.48.0）：只是存设置——监听器常驻，由 onDocClickOutside 每次读设置决定收不收。
    win.querySelector('#pad-clickout-toggle').addEventListener('change', (e) => {
        getSettings().clickOutsideClose = e.target.checked;
        save();
    });
    // 1.45.0 窗口配色：改完立刻生效，不用刷新（同 #pad-chatbar-toggle 的手感）。
    // 不走 bind()：bind 只存值，这里还要 applyWindowSkin 真去换类。
    win.querySelector('#pad-window-skin').addEventListener('change', (e) => {
        getSettings().windowSkin = e.target.value;
        save();
        applyWindowSkin(getSettings());
    });
    bind('#pad-profile', 'profileId');
    bind('#pad-temp', 'temperature', (v) => parseFloat(v));
    bind('#pad-maxtok', 'maxTokens', (v) => parseInt(v, 10));
    bind('#pad-depth', 'contextDepth', (v) => parseInt(v, 10));
    bind('#pad-adv-depth', 'advisorDepth', (v) => parseInt(v, 10));
    // After bind() has written the new depth, re-register the active injection —
    // otherwise the setting silently applies only on the next chat switch.
    win.querySelector('#pad-adv-depth').addEventListener('input', () => applyPlanInjection());
    // 剧情脉络：后面节点的详细什么时候写（一次写全 / 到了再写）。改成「到了再写」时，当前节点还没详细就顺手请参谋写。
    win.querySelectorAll('#pad-adv-detail-seg [data-v]').forEach((b) => b.addEventListener('click', () => {
        getSettings().advisorNodeDetail = b.dataset.v;
        save();
        syncNodeDetailSeg();
        const path = getPath();
        if (path) { maybeWritePathDetail(path); renderPlanBar(); }
    }));
    bind('#pad-card', 'includeCard');
    bind('#pad-stat', 'chatIncludeStat');
    bind('#pad-world', 'chatIncludeWorld');
    if (ENABLE_BBS_BRIDGE) bind('#pad-bbs', 'chatIncludeBbs');   // 柏宝书记忆桥（行仅在开关开时渲染）
    if (ENABLE_LWB_BRIDGE) bind('#pad-lwb', 'chatIncludeLwb');   // 小白X 记忆桥（行仅在开关开时渲染）
    if (ENABLE_AUTO_DIAGNOSE) bind('#pad-diag-mvu-compat', 'autoDiagnoseMvuCompat');   // MVU external-analysis compatibility (opt-in)
    if (ENABLE_AUTO_DIAGNOSE) bind('#pad-diag-cowrite', 'autoDiagnoseCoWrite');         // 🧩 允许与其他脚本并写 MVU（1.83.0，opt-in）
    if (ENABLE_AUTO_DIAGNOSE) {   // 🔁 失败自动重试（2026-08-28）：主开关 + 次数 + 三枚分类
        bind('#pad-diag-retry', 'autoDiagnoseRetry');
        win.querySelector('#pad-diag-retry').addEventListener('change', () => reflectDiagRetryVisible());
        bind('#pad-diag-retry-count', 'autoDiagnoseRetryMax', (v) => parseInt(v, 10));
        bind('#pad-diag-retry-empty', 'autoDiagnoseRetryOnEmpty');
        bind('#pad-diag-retry-format', 'autoDiagnoseRetryOnFormat');
        bind('#pad-diag-retry-error', 'autoDiagnoseRetryOnError');
    }
    if (ENABLE_DIAG_BODY_INJECT) bind('#pad-diag-inject', 'diagInjectBody');   // 🩺 诊断修正写进正文（1.65.0 起在「诊断设置」里，行同上）
    bind('#pad-hidden', 'includeHiddenFloors');
    // —— 角色工坊设置 —— 全局设置（不是 per-chat）。
    const bldTargetSel = win.querySelector('#pad-bld-target');
    if (bldTargetSel && BUILDER_NPC_ONLY) {
        // 只保留 NPC：目标恒 npc，选择器整行藏起来（只有一个选项的下拉没意义）。
        getSettings().bldTarget = 'npc';
        const row = bldTargetSel.closest('label');
        if (row) row.style.display = 'none';
    } else if (bldTargetSel) {
        // 选项随分家开关：开 → 三态（默认不抢话）；关 → 旧两态（= 字节级现状行为）。
        const opts = ENABLE_BUILDER_PERSONA_STYLES
            ? [['persona-nosteal', '用户角色·不抢话（AI 只回应你）'], ['persona-steal', '用户角色·抢话（AI 也扮演你）'], ['npc', 'NPC 世界书条目']]
            : [['persona', '角色（Persona）'], ['npc', 'NPC 世界书条目']];
        for (const [val, label] of opts) {
            const o = document.createElement('option');
            o.value = val; o.textContent = label;
            bldTargetSel.appendChild(o);
        }
        bldTargetSel.value = ENABLE_BUILDER_PERSONA_STYLES ? normalizeBldTarget(getSettings().bldTarget) : (getSettings().bldTarget === 'npc' ? 'npc' : 'persona');
        bldTargetSel.addEventListener('change', async () => {
            const s = getSettings();
            const prevVal = s.bldTarget;
            const nextVal = ENABLE_BUILDER_PERSONA_STYLES ? normalizeBldTarget(bldTargetSel.value) : (bldTargetSel.value === 'npc' ? 'npc' : 'persona');
            // 1.36.0 中断确认：预演新目标会落到的房间（临时代入、算完还原，不落盘）——只有当前正是工坊模式
            // 且房间真会换时才会问（syncConvoStream 按当前模式算房，非工坊模式下换目标不换房）。取消把选择器拨回。
            s.bldTarget = nextVal;
            const targetKey = convoStreamKeyForMode(currentOracleMode(), s);
            s.bldTarget = prevVal;
            if (!(await confirmConvoSwap(targetKey))) {
                bldTargetSel.value = ENABLE_BUILDER_PERSONA_STYLES ? normalizeBldTarget(prevVal) : (prevVal === 'npc' ? 'npc' : 'persona');
                return;
            }
            s.bldTarget = nextVal;
            save();
            renderBuilderChips();   // chip 集随目标切换
            syncConvoStream();      // 切到该目标的独立访谈房间
        });
    }
    renderBuilderChips();
    win.querySelector('#pad-bld-chips-help')?.addEventListener('click', toggleBuilderChipsLegend);
    const bldDepth = win.querySelector('#pad-bld-depth');
    const bldDepthAll = win.querySelector('#pad-bld-depth-all');
    const reflectBldDepth = () => {
        const d = getSettings().bldDepth;
        if (bldDepthAll) bldDepthAll.checked = d === -1;
        if (bldDepth) { bldDepth.value = d === -1 ? '' : d; bldDepth.disabled = d === -1; }
    };
    bldDepth?.addEventListener('change', () => { getSettings().bldDepth = Math.max(0, parseInt(bldDepth.value, 10) || 0); save(); reflectBldDepth(); });
    bldDepthAll?.addEventListener('change', () => { getSettings().bldDepth = bldDepthAll.checked ? -1 : 60; save(); reflectBldDepth(); });
    reflectBldDepth();
    bind('#pad-bld-summary', 'bldIncludeSummary');
    bind('#pad-bld-stat', 'bldIncludeStat');
    bind('#pad-bld-scanwi', 'bldScanWi');
    bind('#pad-bld-dlgrich', 'bldDlgRich');
    bind('#pad-bld-preset', 'bldUsePreset');   // T13：访谈经预设 opt-in（锻造不受影响）——同 bldSummary/bldStat 用 bind
    // ✂️ 锻造后自动精简（轻精简层）：总开关关 或 轻精简整体关闭（ENABLE_LIGHT_CONDENSE=false）时整行不渲染。
    const bldAutoCondRow = win.querySelector('#pad-bld-autocond-row');
    if (bldAutoCondRow && (!ENABLE_DRAFT_CONDENSE || !ENABLE_LIGHT_CONDENSE)) bldAutoCondRow.style.display = 'none';
    bind('#pad-bld-autocond', 'bldAutoCondense');
    // ✂️✂️ 深度精简 = Opus-only 说明行（无勾选项；深度恒串行流式，见 runCondenseDepth）：总开关关时整行不渲染。
    const bldCondInfoRow = win.querySelector('#pad-bld-condinfo');
    if (bldCondInfoRow && !ENABLE_DRAFT_CONDENSE) bldCondInfoRow.style.display = 'none';
    const bldMaxTok = win.querySelector('#pad-bld-maxtok');
    if (bldMaxTok) {
        bldMaxTok.value = getSettings().bldMaxTokens || '';   // 建窗时回填当前值（原始字符串）
        bldMaxTok.addEventListener('change', () => { getSettings().bldMaxTokens = bldMaxTok.value.trim(); save(); });
    }
    // Tier 0 ③（1.25.0）：校正回复上限 —— 仿 bldMaxTok，空串=自动（地板 4096）。全局、对手动+自动都生效。
    const fixMaxTok = win.querySelector('#pad-fix-maxtok');
    if (fixMaxTok) {
        fixMaxTok.value = getSettings().fixMaxTokens || '';
        fixMaxTok.addEventListener('change', () => { getSettings().fixMaxTokens = fixMaxTok.value.trim(); save(); });
    }
    win.querySelector('#pad-bld-book-list')?.addEventListener('change', (e) => {
        if (e.target && e.target.matches('input[type="checkbox"]')) onBldBookSelectionChange();
    });
    // 「全部激活」：清空选书、回到「跟随当前所有激活的世界书」（bldBooks = [] 语义），重画选书 / 选条目器。
    win.querySelector('#pad-bld-books-active')?.addEventListener('click', () => {
        getSettings().bldBooks = [];
        save();
        populateBuilderBooks();   // 重渲选书行（全取消勾）+ 更新摘要 + 刷新选条目器
    });
    win.querySelector('#pad-bld-ent-all')?.addEventListener('click', () => setAllBldEntries(true));
    win.querySelector('#pad-bld-ent-none')?.addEventListener('click', () => setAllBldEntries(false));
    win.querySelector('#pad-bld-ent-filtered')?.addEventListener('click', () => selectFilteredBldEntries());
    win.querySelector('#pad-bld-ent-blue')?.addEventListener('click', () => setBldEntriesByType('blue'));
    win.querySelector('#pad-bld-ent-green')?.addEventListener('click', () => setBldEntriesByType('green'));
    win.querySelector('#pad-bld-ent-filter')?.addEventListener('input', (e) => filterBookEntries('#pad-bld-entry-list', e.target.value, updateBldFilteredBtn, win));
    win.querySelector('#pad-bld-book-filter')?.addEventListener('input', (e) => filterBldBooks(e.target.value));
    // ✨ 校正模式 Phase 4：校正配置按【当前聊天】持久化（chat A 的目标不渗进 chat B）。专用 bindFix——
    // 写到 setFixCfg（per-chat 元数据）而非 getSettings()；不写全局、不调 save()（setFixCfg 自己触发 saveChatMetadata）。
    const bindFix = (id, key, parse = (v) => v) => {
        const el = win.querySelector(id);
        const evt = (el.type === 'checkbox') ? 'change' : 'input';
        el.addEventListener(evt, () => {
            setFixCfg({ [key]: el.type === 'checkbox' ? el.checked : parse(el.value) });
        });
    };
    // ✨ 校正 手动/自动 分家（2026-06-26）：下拉只切「显示哪套设置」（纯 UI 视图，全局存 fixSettingsView，不进 per-chat）。
    const fixModeSel = win.querySelector('#pad-fix-mode-select');
    if (fixModeSel) {
        fixModeSel.addEventListener('change', () => {
            getSettings().fixSettingsView = (fixModeSel.value === 'auto') ? 'auto' : ((ENABLE_FIX_CUSTOM_TASK && fixModeSel.value === 'custom') ? 'custom' : 'manual');
            save();
            applyFixModeView();
            updateFixVerdict();   // ✨ 1.18.0：判定行可见性跟视图 / per-chat 自动开关走（P8），切视图即时对齐
            // 首次切到「自动校正」→ 弹一次性标签块提醒（用户功能请求）。仅用户手动 change 触发；
            // applyFixModeView 程序化设 sel.value 不发 change，故载入 / 切聊天不会误弹。
            if (fixModeSel.value === 'auto' && !getSettings().autoFixWarned) openAutoFixWarn();
        });
    }
    // ✨ 经预设发送（破限 / 越狱用）—— 全局开关（不进 per-chat），同 advisorUsePreset 写法（写 getSettings + save）。
    const fixmPresetCb = win.querySelector('#pad-fixm-preset');
    if (fixmPresetCb) fixmPresetCb.addEventListener('change', () => { getSettings().fixM_usePreset = fixmPresetCb.checked; save(); applyFixPresetLock(); });
    const fixaPresetCb = win.querySelector('#pad-fixa-preset');
    if (fixaPresetCb) fixaPresetCb.addEventListener('change', () => { getSettings().fixA_usePreset = fixaPresetCb.checked; save(); applyFixPresetLock(); });
    // ✨ MVU「额外模型更新」抢写协调（opt-in，全局设置——用户环境级，不入 per-chat FIX_CFG_KEYS）。
    const fixWaitMvuCb = win.querySelector('#pad-fix-wait-mvu');
    if (fixWaitMvuCb) fixWaitMvuCb.addEventListener('change', () => { getSettings().fixWaitForMvu = fixWaitMvuCb.checked; save(); });
    // 数字框条数 parse：非数字 / 非正数 → -1（全部），正数原样。手动 / 自动各一份独立存储。
    const depthParse = (v) => { const n = parseInt(v, 10); return (Number.isNaN(n) || n <= 0) ? -1 : n; };
    // 手动：0 = 不带前文（默认值就是 0，resolveFixModeCfg 也按「显式 0 = 不带」读）。原版共用上面那个 parse，
    // 手填 0 会被存成 -1 = 带上全部前文，与界面显示相反（二创版 2.1.1 修）。负数 / 清空仍 = -1（全部）。
    const depthParseM = (v) => { const n = parseInt(v, 10); return (Number.isNaN(n) || n < 0) ? -1 : n; };
    // 手动模式控件（fixM_*）——上下文条数 / 卡 / 世界书 / 概要。
    bindFix('#pad-fixm-depth', 'fixM_contextDepth', depthParseM);
    bindFix('#pad-fixm-card', 'fixM_includeCard');
    bindFix('#pad-fixm-world', 'fixM_includeWorld');
    bindFix('#pad-fixm-summary', 'fixM_includeSummary');
    bindFix('#pad-fixm-protectthink', 'fixM_protectThink');   // ✨ 思考块保护（W1）
    bindFix('#pad-fixm-scope', 'fixM_scopeTag');   // 二创版 2.1：手动整篇的正文标签（留空 = 整条）
    win.querySelector('#pad-fixm-scope').addEventListener('blur', (e) => {   // 失焦清洗：全角括号 / <> 包装 / 多词只取第一个
        const cleaned = normalizeScopeInput(e.target.value);
        if (cleaned === e.target.value) return;
        e.target.value = cleaned;
        setFixCfg({ fixM_scopeTag: cleaned });
    });
    // 自动模式控件（fixA_*）——目标 / 排除区 / 约束 / 收紧 / 折叠上下文 + 运行按钮 + 自动开关。
    bindFix('#pad-fix-tgt-slop', 'fixA_targetSlop');
    bindFix('#pad-fix-tgt-dialogue', 'fixA_targetDialogue');
    bindFix('#pad-fix-tgt-precision', 'fixA_targetPrecision');
    bindFix('#pad-fix-tgt-magic', 'fixA_targetMagic');
    bindFix('#pad-fix-tgt-pacing', 'fixA_targetPacing');
    bindFix('#pad-fix-tgt-archaic', 'fixA_targetArchaic');
    // ✨ 作用域标签（per-chat）。Phase 5（D+E）：用户在这里亲手打字 = 明确表达了意图，标记 fixA_scopeManual:true——
    // 之后 resolveFixScope 缓存未命中时永不代替用户改写，只会建议（suggest），不会自作主张 detected 采纳新标签。
    win.querySelector('#pad-fix-scope').addEventListener('input', (e) => { setFixCfg({ fixA_scopeTag: e.target.value, fixA_scopeManual: true }); updateFixVerdict(); renderFixConfigWarnings(); });
    // ✨ 防呆（1.18.0）：失焦清洗——IME 全角括号 / <>[] 包装 / 多词只取第一个（normalizeScopeInput）。留空是合法 opt-out，不动。
    win.querySelector('#pad-fix-scope').addEventListener('blur', (e) => {
        const cleaned = normalizeScopeInput(e.target.value);
        if (!e.target.value.trim() || cleaned === e.target.value) return;
        e.target.value = cleaned;
        setFixCfg({ fixA_scopeTag: cleaned, fixA_scopeManual: true });
        updateFixVerdict();
        renderFixConfigWarnings();
    });
    bindFix('#pad-fix-join', 'fixA_pieceJoin');   // ✨ 整体校正 vs 分段逐次（per-chat，默认开）
    win.querySelector('#pad-fix-join')?.addEventListener('change', () => { updateFixVerdict(); });
    win.querySelector('#pad-fix-keep').addEventListener('input', (e) => { setFixCfg({ fixA_keepTags: e.target.value }); updateFixVerdict(); renderFixConfigWarnings(); });
    win.querySelector('#pad-fix-drop').addEventListener('input', (e) => { setFixCfg({ fixA_dropTags: e.target.value }); renderFixConfigWarnings(); });
    win.querySelector('#pad-fix-know').addEventListener('input', (e) => { setFixCfg({ fixA_knowledgeBoundary: e.target.value }); });
    win.querySelector('#pad-fix-guard').addEventListener('input', (e) => { setFixCfg({ fixA_guardrails: e.target.value }); });
    // ✨ 校正提示词选择器（轻校 / 精校 + 侧重）：写 per-chat；切版本时即时显隐侧重行。归一在此就地做（只认 thorough / opus）。
    win.querySelector('#pad-fix-prompt-version')?.addEventListener('change', (e) => {
        setFixCfg({ fixA_promptVersion: e.target.value === 'thorough' ? 'thorough' : 'light' });
        applyFixFlavorView();
    });
    win.querySelector('#pad-fix-prompt-flavor')?.addEventListener('change', (e) => {
        setFixCfg({ fixA_promptFlavor: ['opus', 'gemini'].includes(e.target.value) ? e.target.value : 'deepseek' });
    });
    bindFix('#pad-fix-card', 'fixA_includeCard');
    bindFix('#pad-fix-ctx', 'fixA_includeContext');
    bindFix('#pad-fix-ctx-depth', 'fixA_contextDepth', depthParse);
    bindFix('#pad-fix-world', 'fixA_includeWorld');
    bindFix('#pad-fixa-summary', 'fixA_includeSummary');
    win.querySelector('#pad-fix-run').addEventListener('click', () => { runFixByTargets(); });
    win.querySelector('#pad-fixsel-open')?.addEventListener('click', () => openFixSelectCard());   // ✂️ 选段校正（1.27.0）
    // ✂️ 输入框上方快捷按钮开关（1.44.0）：改设置后立刻放 / 撤按钮（不只是存），同 🌙 那颗的手感。
    win.querySelector('#pad-fixsel-barbtn')?.addEventListener('change', (e) => {
        getSettings().fixSelBarButton = e.target.checked;
        save();
        syncFixSelBarButton();
    });
    // ✂️ 回复右上角那颗的隐藏开关（1.77.0，opt-out `fixSelRowButton`）：同款手感——改设置后立刻
    // 重挂 / 拔掉（refreshFixChatEntry 起手就先拔光，所以取消勾选是当场生效，不必等楼层重建）。
    win.querySelector('#pad-fixsel-rowbtn')?.addEventListener('change', (e) => {
        getSettings().fixSelRowButton = e.target.checked;
        save();
        refreshFixChatEntry();
    });
    win.querySelector('#pad-fix-scan')?.addEventListener('click', () => { scanFixScope(); });   // ✨ Phase 6：扫描本卡正文标签
    win.querySelector('#pad-fix-reset')?.addEventListener('click', () => { resetFixCfg(); });   // ✨ Phase 7（M4）：恢复推荐设置
    bindFix('#pad-fix-auto', 'autoFixEnabled');   // 自动校正每条新回复（message_received 编排读 cfg.autoFixEnabled）
    win.querySelector('#pad-fix-auto')?.addEventListener('change', updateFixButtonVisual);   // 改开关 → ✨ 金色指示即时对齐
    // ✨ 防呆（P5）：开自动但连接没配 → 一次性说明（fixEnvNote），否则用户只看到「什么都没发生」；顺带刷新判定行 / 警告盒。
    win.querySelector('#pad-fix-auto')?.addEventListener('change', (e) => {
        if (e.target.checked) {
            const st = getSettings();
            const unset = (st.mode === 'direct' && (!st.endpoint || !st.model)) || (st.mode === 'profile' && !st.profileId);
            if (unset && typeof toastr !== 'undefined') toastr.warning(fixEnvNote('connectionUnset'), '剧情推进 · 自动校正', { timeOut: 8000 });
        }
        updateFixVerdict();
        renderFixConfigWarnings();
    });
    // ✨ 校正 Phase 4：全局命名套餐库——加载 / 保存为… / 删除（saveFixBundle / loadFixBundle / deleteFixBundle + populateFixBundles）。
    win.querySelector('#pad-fix-bundle-load').addEventListener('click', () => {
        const sel = win.querySelector('#pad-fix-bundle');
        const name = sel && sel.value;
        if (!name) { toastr.info('先选一个已存套餐'); return; }
        if (loadFixBundle(name)) toastr.success(`已加载套餐「${name}」到本聊天`);
    });
    win.querySelector('#pad-fix-bundle-save').addEventListener('click', async () => {
        const name = await uiPrompt('给这套校正配置起个名字（如「硬核西幻」）：', '');
        const trimmed = (name || '').trim();
        if (!trimmed) return;   // 取消 / 空 = no-op
        if (saveFixBundle(trimmed)) { populateFixBundles(); const sel = win.querySelector('#pad-fix-bundle'); if (sel) sel.value = trimmed; toastr.success(`已保存套餐「${trimmed}」`); }
    });
    win.querySelector('#pad-fix-bundle-del').addEventListener('click', async () => {
        const sel = win.querySelector('#pad-fix-bundle');
        const name = sel && sel.value;
        if (!name) { toastr.info('先选一个要删的套餐'); return; }
        if (!(await uiConfirm(`删除套餐「${name}」？`))) return;
        if (deleteFixBundle(name)) { populateFixBundles(); toastr.success(`已删除套餐「${name}」`); }
    });
    // 📋 自定义模板任务（1.77.0）：整块由旗 + 面板存在性双门控——旗关时面板根本没渲染，一个监听都不挂。
    if (ENABLE_FIX_CUSTOM_TASK && win.querySelector('#pad-fix-custom-wrap')) {
        win.querySelector('#pad-fixc-run').addEventListener('click', () => { runCustomTaskNow(); });
        win.querySelector('#pad-fixc-auto').addEventListener('change', (e) => {
            // 首次勾选【不】弹「自动模式会花钱」提醒（Prince 2026-09-04 定：模板档不需要这道一次性提醒）；
            // 自动面板 #pad-fix-auto 的首弹保持原样。
            if (e.target.checked) {
                setFixCfg({ autoFixEnabled: true, fixA_task: 'custom' });
            } else setFixCfg({ autoFixEnabled: false });
            seedFixControls(); updateFixButtonVisual();
        });
        // 自动面板的勾选：勾上即回到校正任务（互斥）。任务变了 ✨ 金色指示也要跟着重算（pending 判据看 task）。
        win.querySelector('#pad-fix-auto')?.addEventListener('change', (e) => { if (e.target.checked) { setFixCfg({ fixA_task: 'fix' }); seedFixControls(); updateFixButtonVisual(); } });
        const tplSel = win.querySelector('#pad-fixc-template');
        const tplBox = win.querySelector('#pad-fixc-prompt');
        tplBox.addEventListener('input', () => { markFixTemplateDirty(); updateFixTplDirtyMarker(); });   // 只置脏；归属由「回填正文」的那些地方记
        tplSel.addEventListener('change', async () => {
            // 用户【亲手】换模板才走这条确认；取消时退回【归属】而不是配置里的名字——脏着时配置可能早被
            // 切聊天 / 套餐改成别人了，退回配置等于把未保存的正文交给另一份模板。
            if (fixTplDirty && !(await uiConfirm('当前模板正文有未保存的改动，放弃并切换？'))) { tplSel.value = fixTplDirtyFor || getEffectiveFixCfg(getSettings(), getFixCfg()).fixC_template || ''; updateFixTplDirtyMarker(); return; }
            setFixCfg({ fixC_template: tplSel.value });
            const t = findFixTemplate(getSettings(), tplSel.value);
            tplBox.value = t ? t.prompt : '';
            clearFixTemplateDirty(tplSel.value); updateFixTplDirtyMarker();
            updateFixVerdict();
        });
        win.querySelector('#pad-fixc-tpl-new').addEventListener('click', async () => {
            // 新建会把文本框清空——脏着时先问一句，与「亲手换模板」同一道防误覆盖闸（spec §4.3）。
            // 放在起名之前：用户改主意时连名字都不必编。
            if (fixTplDirty && !(await uiConfirm('当前模板正文有未保存的改动，放弃并新建？'))) return;
            const name = (await uiPrompt('给这份模板起个名字（如「中译日」）：', '') || '').trim();
            if (!name) return;
            // 「已存在」只问【用户库】：findFixTemplate 现在会兜底到内置示例，拿它判会对着内置名多问一句
            // 「覆盖？」，而 saveFixTemplate 压根不会覆盖它（保留名硬拒）。
            if (normalizeFixTemplates(getSettings().fixTemplates).some((t) => t.name === name)
                && !(await uiConfirm(`模板「${name}」已存在，覆盖？`))) return;
            // 存不下就停在这儿（内置保留名被拒）：照着往下走会把配置指到一个用户库里没有的名字上
            // ——下拉显示内置那一份、正文框却空着，再按保存又是一次另存，纯属添乱。
            if (!saveFixTemplate(name, '')) return;
            setFixCfg({ fixC_template: name });
            populateFixTemplates(); tplSel.value = name; tplBox.value = ''; clearFixTemplateDirty(name); updateFixTplDirtyMarker(); updateFixVerdict();
        });
        win.querySelector('#pad-fixc-tpl-save').addEventListener('click', async () => {
            // 写回【归属】那一份，不是下拉此刻显示的那一份：脏着时两者本就该相等（seed 会把下拉钉住），
            // 但归属才是这段文字真正的主人，按它写永远不会写错人。写完把配置也同步到实际保存的那份。
            const name = fixTplDirtyFor || tplSel.value;
            if (!name) { toastr.info('先新建或选一份模板'); return; }
            // 📋 内置示例是只读的（正文由电池钉死）：正文框照旧可改，但「保存」改走【另存为】——
            // 起个新名字存成用户自己的一份并选中它，示例本身一个字不动。收尾与「新建」逐项同一套。
            if (fixTemplateIsBuiltin(name)) {
                const copy = (await uiPrompt('内置示例本身不会被改动。给你改过的这一份起个名字：', fixSampleCopyName(name)) || '').trim();
                if (!copy) return;
                if (fixTemplateIsBuiltin(copy)) { toastr.info('这是内置示例的名字，换一个'); return; }
                // 「已存在」只问【用户库】：findFixTemplate 现在会兜底到示例，拿它判会把上面那句拒绝重问一遍。
                if (normalizeFixTemplates(getSettings().fixTemplates).some((t) => t.name === copy)
                    && !(await uiConfirm(`模板「${copy}」已存在，覆盖？`))) return;
                if (!saveFixTemplate(copy, tplBox.value)) return;
                setFixCfg({ fixC_template: copy });
                clearFixTemplateDirty(copy); updateFixTplDirtyMarker();
                populateFixTemplates(); tplSel.value = copy;
                updateFixVerdict();
                toastr.success(`已另存为「${copy}」——内置示例本身不会被改动`);
                return;
            }
            saveFixTemplate(name, tplBox.value);
            clearFixTemplateDirty(name); updateFixTplDirtyMarker();
            setFixCfg({ fixC_template: name });
            populateFixTemplates(); tplSel.value = name;
            updateFixVerdict();
            toastr.success(`已保存模板「${name}」`);
        });
        win.querySelector('#pad-fixc-tpl-del').addEventListener('click', async () => {
            const name = tplSel.value;
            if (!name) { toastr.info('先选一个要删的模板'); return; }
            // 内置示例删不掉（它根本不在 fixTemplates 里，deleteFixTemplate 会静默 false）——先说一句，
            // 否则用户点了确认框、什么也没发生，看着像坏了。
            if (fixTemplateIsBuiltin(name)) { toastr.info('内置示例不能删除'); return; }
            if (!(await uiConfirm(`删除模板「${name}」？`))) return;
            if (deleteFixTemplate(name)) {
                // 删掉后下拉会落到【另一份】模板上（populateFixTemplates 的 prev 已不存在）——必须把选择态
                // 与正文一起搬过去认领它，否则「配置说没选、下拉显示着 A、正文却空着」，再点一次保存就把
                // 用户从没打开过的 A 清空了（spec §4.3 防误覆盖）。清旗后交给 seedFixControls 统一回填
                // ——它在「不脏」这一支里会把 fixTplDirtyFor 一并记成新认领的这份。
                clearFixTemplateDirty(); updateFixTplDirtyMarker();
                setFixCfg({ fixC_template: '' });
                populateFixTemplates();
                setFixCfg({ fixC_template: tplSel.value || '' });
                seedFixControls();
                updateFixVerdict();
                toastr.success(`已删除模板「${name}」`);
            }
        });
        // 🌐 模板广场（1.86.0）：旗关时按钮根本没渲染，这里同门跳过。📤 分享恒在。
        if (ENABLE_FIX_TEMPLATE_HUB) {
            win.querySelector('#pad-fixc-hub').addEventListener('click', openFixHub);
        }
        win.querySelector('#pad-fixc-share').addEventListener('click', () => { openFixShare(); });
        win.querySelector('#pad-fixc-mech').addEventListener('change', async (e) => {
            if (!e.target.checked && !getSettings().customFixWarned) {
                const ok = await uiConfirm('关掉后，状态栏 / 变量块也会一起交给模板，模板输出会原样替换整条回复。应用后仍可在结果卡撤销。确定？');
                if (!ok) { e.target.checked = true; return; }
                getSettings().customFixWarned = true; save();
            }
            setFixCfg({ fixC_useMechanic: e.target.checked }); updateFixVerdict(); updateFixButtonVisual();
        });
        bindFix('#pad-fixc-keep', 'fixC_keepTags');
        bindFix('#pad-fixc-drop', 'fixC_dropTags');
        for (const id of ['#pad-fixc-keep', '#pad-fixc-drop']) win.querySelector(id).addEventListener('input', () => { renderFixConfigWarnings(); updateFixVerdict(); });
        win.querySelector('#pad-fixc-preset').addEventListener('change', (e) => { getSettings().fixC_usePreset = e.target.checked; save(); });
        bindFix('#pad-fixc-minchars', 'fixAutoMinChars', (v) => clampFixAutoMinChars(v));
    }
    bind('#pad-regex', 'applyRegex');
    bind('#pad-wi', 'worldInfoMode');
    if (ENABLE_WI_EJS_RENDER) bind('#pad-wi-ejs', 'wiRenderEjs');   // 世界书 EJS 渲染（行仅在开关开时渲染）
    bind('#pad-sendtemp', 'sendTemperature');
    win.querySelector('#pad-wi').addEventListener('change', updateWiHint);
    bind('#pad-persona', 'personaId');
    bindPersonaEditor();
    win.querySelector('#pad-sysprompt-preset').addEventListener('change', (e) => onPresetSelected(e.target.value));
    win.querySelector('#pad-sysprompt-preset-refresh').addEventListener('click', populateSysPromptPresets);
    win.querySelector('#pad-sysprompt-preset-recurate').addEventListener('click', () => {
        const s = getSettings();
        const cur = s.sysPromptPresetName;
        if (!cur) return;
        // 回显【已保存】的挑选（1.88.0）：不带种子行就会按分类器默认重建，用户以为没存上、再存一遍反把选择盖掉。
        const snap = getCuratedSnapshot(s, cur);
        openCuration(cur, snap ? curationRowsFromSnapshot(buildCurationRows(cur), snap) : undefined);
    });
    // 提示词编辑器：设置「提示词」页里点开的条目，文本框改的就是那一条（PROMPT_DEFS）。
    let promptInjectTimer = null;
    const afterPromptEdit = (id) => {
        refreshPromptBadges();
        // 主聊天注入类：停手片刻后重登记一次，正在进行的引导立刻换上新文字。
        if (/^inject\./.test(id)) {
            clearTimeout(promptInjectTimer);
            promptInjectTimer = setTimeout(() => { applyPlanInjection(); if (win) renderPlanBar(); }, 600);
        }
    };
    win.querySelector('#pad-sysprompt').addEventListener('input', (e) => {
        promptSet(promptEditId, e.target.value);
        save();
        applyPromptEditorUiState();   // 实时刷新「内置 / 已自定义」与缺项提示
        afterPromptEdit(promptEditId);
    });
    win.querySelector('#pad-sysprompt-reset').addEventListener('click', async () => {
        const d = promptDef(promptEditId);
        if (!d) return;
        if (!(await uiConfirm(`确定把「${d.group} · ${d.label}」重置为内置默认吗？当前的修改会丢失。`))) return;
        promptReset(d.id);
        save();
        loadPromptEditor();
        afterPromptEdit(d.id);
        addSystemNote(`已将「${d.group} · ${d.label}」重置为内置默认。`);
    });

    // send
    sendBtn.addEventListener('click', onSend);
    win.querySelector('#pad-model-fetch').addEventListener('click', onFetchModels);
    win.querySelector('#pad-model-list').addEventListener('change', (e) => {
        const val = e.target.value;
        if (!val) return;
        const input = win.querySelector('#pad-model');
        input.value = val;
        s.model = val;
        updateBadge();
        save();
    });
    // 1.85.1：Enter 是否发送跟随酒馆「用户设置 → 按 Enter 发送」（手机默认 Enter 换行）——判据见 soEnterShouldSend。
    // 设置在【按键当时】读，用户在酒馆里改了立即生效，不必重开窗口。
    inputEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (soEnterShouldSend(e, soReadSendOnEnter(), soIsMobileForEnter())) {
            e.preventDefault();
            onSend();
        }
    });
    inputEl.addEventListener('input', autoGrowInput);                                                      // #4 输入框随内容自动增高
    // #1 跟随意图【只】由真·用户手势（滚轮 / 触摸）更新——程序化滚动（固定顶部 / 跟随到底）不触发 wheel / touchmove，
    // 故不会被「空占位气泡刚固定到顶时 nearBottom 恰好为真」误翻成跟随（先前用通用 scroll 监听正栽在这）。
    const soUpdateFollow = () => { try { requestAnimationFrame(() => { trackStreamFollow(nearBottom()); }); } catch (e) { trackStreamFollow(nearBottom()); } };
    messagesEl.addEventListener('wheel', soUpdateFollow, { passive: true });        // 桌面滚轮
    messagesEl.addEventListener('touchmove', soUpdateFollow, { passive: true });    // 手机触摸滑动

    // 用户功能请求：反映持久化的自动诊断状态（重载后若 AUTO 仍开着，按钮显示红色 + AUTO）。
    updateDiagButtonVisual();
    updateFixButtonVisual();
    soApplyConvoIoVisual(null);   // 📥📤 气泡行 / 空态入口：首次建窗时按当前模式定可见性（此后由 setOracleMode 维持）
}

function loadSettingsIntoForm() {
    const s = getSettings();
    win.querySelector('#pad-mode').value = s.mode;
    win.querySelector('#pad-endpoint').value = s.endpoint;
    win.querySelector('#pad-apikey').value = s.apiKey;
    win.querySelector('#pad-model').value = s.model;
    win.querySelector('#pad-stream').checked = !!s.stream;
    win.querySelector('#pad-direct-backend').checked = !!s.directViaBackend; // 1.17.23：经酒馆后端转发
    win.querySelector('#pad-raw-url').checked = !!s.directRawUrl;            // 1.22.0：地址原样使用

    win.querySelector('#pad-temp').value = s.temperature;
    win.querySelector('#pad-maxtok').value = s.maxTokens;
    win.querySelector('#pad-depth').value = s.contextDepth;
    win.querySelector('#pad-adv-depth').value = s.advisorDepth;
    syncNodeDetailSeg();
    win.querySelector('#pad-card').checked = !!s.includeCard;
    win.querySelector('#pad-stat').checked = !!s.chatIncludeStat;
    win.querySelector('#pad-world').checked = !!s.chatIncludeWorld;
    if (ENABLE_BBS_BRIDGE) win.querySelector('#pad-bbs').checked = !!s.chatIncludeBbs;   // 柏宝书记忆桥
    if (ENABLE_LWB_BRIDGE) win.querySelector('#pad-lwb').checked = !!s.chatIncludeLwb;   // 小白X 记忆桥
    if (ENABLE_AUTO_DIAGNOSE) win.querySelector('#pad-diag-mvu-compat').checked = !!s.autoDiagnoseMvuCompat;   // MVU external-analysis compatibility
    if (ENABLE_AUTO_DIAGNOSE) win.querySelector('#pad-diag-cowrite').checked = !!s.autoDiagnoseCoWrite;         // 🧩 允许与其他脚本并写 MVU（1.83.0）
    if (ENABLE_AUTO_DIAGNOSE) {   // 🔁 失败自动重试（2026-08-28）
        win.querySelector('#pad-diag-retry').checked = !!s.autoDiagnoseRetry;
        // 次数经 diagRetryMax（与运行时同一枚消毒器）回画：存档里的胡话 / 越界值不原样上屏。
        win.querySelector('#pad-diag-retry-count').value = diagRetryMax(s);
        win.querySelector('#pad-diag-retry-empty').checked = !!s.autoDiagnoseRetryOnEmpty;
        win.querySelector('#pad-diag-retry-format').checked = !!s.autoDiagnoseRetryOnFormat;
        win.querySelector('#pad-diag-retry-error').checked = !!s.autoDiagnoseRetryOnError;
        reflectDiagRetryVisible();
    }
    if (ENABLE_DIAG_BODY_INJECT) win.querySelector('#pad-diag-inject').checked = !!s.diagInjectBody;   // 🩺 诊断修正写进正文（1.65.0 起住在「诊断设置」里）
    reflectAutoDiagCheckbox();   // 🩺 自动诊断勾选框（1.65.0）：与 autoDiagnoseEnabled 同步，唯一写者
    win.querySelector('#pad-hidden').checked = !!s.includeHiddenFloors;
    // ✨ 校正模式 Phase 4：校正控件从【本聊天】生效配置读种子（per-chat 覆盖全局）——不直读 s.fix*。
    seedFixControls();
    populateFixBundles();   // ✨ 校正 Phase 4：填充全局命名套餐下拉
    win.querySelector('#pad-qr-toggle').checked = !!s.showQrButton;
    win.querySelector('#pad-chatbar-toggle').checked = !!s.showChatBarButton;
    win.querySelector('#pad-clickout-toggle').checked = !!s.clickOutsideClose;   // 1.48.0 点击窗外自动收起
    win.querySelector('#pad-window-skin').value = s.windowSkin;   // 1.45.0 窗口配色
    const fixSelBarBox = win.querySelector('#pad-fixsel-barbtn');   // 门控关时该行不存在
    if (fixSelBarBox) fixSelBarBox.checked = !!s.fixSelBarButton;
    const fixSelRowBox = win.querySelector('#pad-fixsel-rowbtn');   // 同上；判 !== false = 老档缺键当「开」
    if (fixSelRowBox) fixSelRowBox.checked = getSettings().fixSelRowButton !== false;
    win.querySelector('#pad-tools-header-toggle').checked = !!s.toolsInHeader;
    win.querySelector('#pad-regex').checked = !!s.applyRegex;
    win.querySelector('#pad-wi').value = wiEffectiveMode(s);
    if (ENABLE_WI_EJS_RENDER) { const soWiEjs = win.querySelector('#pad-wi-ejs'); if (soWiEjs) soWiEjs.checked = !!s.wiRenderEjs; }   // 世界书 EJS 渲染（回填勾选态）
    win.querySelector('#pad-sendtemp').checked = !!s.sendTemperature;
    win.querySelector('#pad-lb-story').checked = !!s.lorebookIncludeStory;
    win.querySelector('#pad-lb-preset').checked = !!s.lorebookUsePreset;
    reflectLbPreview();   // 「👁 内容预览」开关按钮初始高亮跟随保存的设置
    // 角色工坊：概要 / 状态栏勾选的初始态（bind() 只挂监听、不回填，同世界书那两项的处理）。
    const bldSum = win.querySelector('#pad-bld-summary');
    if (bldSum) bldSum.checked = !!s.bldIncludeSummary;
    const bldStat = win.querySelector('#pad-bld-stat');
    if (bldStat) bldStat.checked = !!s.bldIncludeStat;
    const bldScanWi = win.querySelector('#pad-bld-scanwi');
    if (bldScanWi) bldScanWi.checked = !!s.bldScanWi;
    const bldDlgRich = win.querySelector('#pad-bld-dlgrich');
    if (bldDlgRich) bldDlgRich.checked = !!s.bldDlgRich;
    const bldPreset = win.querySelector('#pad-bld-preset');
    if (bldPreset) bldPreset.checked = !!s.bldUsePreset;

    win.querySelector('#pad-adv-preset').checked = !!s.advisorUsePreset;
    win.querySelector('#pad-diag-preset').checked = !!s.diagnoseUsePreset;
    if (ENABLE_SCHEMA_DIAG) { const sr = win.querySelector('#pad-diag-schema-retry'); if (sr) sr.checked = !!s.diagSchemaRetry; }
    updateWiHint();
    populatePersonas();
    // 提示词编辑器：载入当前条目；设置面板停在上次打开的那一页。
    populateSysPromptPresets();
    loadPromptEditor();
    setSettingsTab();
    applyModeVisibility();
    updateBadge();
}
