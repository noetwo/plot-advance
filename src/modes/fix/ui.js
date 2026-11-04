import { getDiagWiMeta } from '../../core/chat-metadata.js';
import { getCtx, getSettings } from '../../core/settings.js';
import { sharedState } from '../../core/state.js';
import { getLatestAiMessage, splitContentScope } from '../diagnose/mvu.js';
import { populateDiagWiBooks, reflectDiagPickerVisible } from '../diagnose/pickers.js';
import { clampFixAutoMinChars, detectInnerBlocks, detectScopeTag, fixConfigWarnings, fixCustomRawTable, fixCustomVerdictText, fixGuardSummary, fixKeepNameSet, fixScanBlocks, fixScopeVerdict, fixSegmentReply, fixTableCounts, resolveFixPieces } from './algorithms.js';
import { mergeKeepTags, recentAiReplies, resolveFixScope } from './capture.js';
import { confirmPieceBare, confirmPieceWrapped } from './selection.js';
import { findFixTemplate, fixUsePresetFor, getEffectiveFixCfg, getFixCfg, normalizeFixTemplates, resolveFixCustomCfg, resolveFixModeCfg, setFixCfg } from './templates.js';
import { ENABLE_DIAG_WI_PICKER, ENABLE_FIX_CUSTOM_TASK, ENABLE_FIX_PIECEWISE, FIX_SAMPLE_TEMPLATES } from '../../prompts/builtins.js';
import { updateFixButtonVisual } from '../../ui/mode-shell.js';

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4：把校正控件（#so-fix-bar 里的目标 / 约束 / 上下文开关 / 自动）
 * 与【本聊天】生效配置对齐。loadSettingsIntoForm 初次填表、切聊天（onChatChanged）都调 seedFixControls。
 * ------------------------------------------------------------------ */
// 校正设置面板：按 fixSettingsView 显示手动 / 自动那一套（纯视图切换，不改任何行为）。窗口未建好时静默跳过。
export function applyFixModeView() {
    if (!sharedState.win) return;
    // 📋 三态（1.77.0）：manual / auto / custom。旗关时 'custom' 回落 manual——旧档存过 custom 也不会卡在一个没渲染的视图上。
    const raw = getSettings().fixSettingsView;
    const view = (raw === 'auto') ? 'auto' : ((ENABLE_FIX_CUSTOM_TASK && raw === 'custom') ? 'custom' : 'manual');
    const sel = sharedState.win.querySelector('#so-fix-mode-select');
    if (sel) sel.value = view;
    const man = sharedState.win.querySelector('#so-fix-manual');
    const auto = sharedState.win.querySelector('#so-fix-auto-wrap');
    const custom = sharedState.win.querySelector('#so-fix-custom-wrap');
    if (man) man.style.display = (view === 'manual') ? '' : 'none';
    if (auto) auto.style.display = (view === 'auto') ? '' : 'none';
    if (custom) custom.style.display = (view === 'custom') ? '' : 'none';
    applyFixFlavorView();   // ✨ 精校侧重行仅在选了「精校」时显示
    updateFixVerdict();   // ✨ Phase 6：切到自动视图 / 刷新时更新作用域判定预览
}

// ✨ 校正提示词选择器：「精校侧重」行仅在版本 === 'thorough'（精校）时显示，轻校时隐藏（镜像作用域 / 排除区的条件显隐）。
// 读【本聊天】生效配置为准（非 DOM select 值），故 seed 顺序无关。窗口未建好时静默跳过。
export function applyFixFlavorView() {
    if (!sharedState.win) return;
    const cfg = getEffectiveFixCfg(getSettings(), getFixCfg());
    const row = sharedState.win.querySelector('#so-fix-prompt-flavor-row');
    if (row) row.style.display = (cfg.fixA_promptVersion === 'thorough') ? '' : 'none';
}

// ✨ 检测收据（1.18.3）：保留区上方的「本条已自动保留 N 块」读数——设计原则是给证据不给承诺（欢迎
// 用户核对；认漏的块点芯片一键固定进保留区，走 mergeKeepTags = 与扫描面板同一条管道）。跟着
// updateFixVerdict 的全部刷新点走（新回复 / 开窗 / 切聊天 / 配置输入）。绝不自动写 fixA_keepTags
// ——点芯片是用户的知情动作（设计 §2.2：静默写入会毁掉手填意图区分 + 经套餐泄漏到别的卡）。
function renderFixGuardReceipts() {
    if (!sharedState.win) return;
    const box = sharedState.win.querySelector('#so-fix-receipts');
    if (!box) return;
    box.innerHTML = '';
    if (!ENABLE_FIX_PIECEWISE) { box.hidden = true; return; }
    const latest = getLatestAiMessage();
    if (latest.idx < 0) {
        box.hidden = false;
        box.textContent = '还没有可分析的回复——主聊天里发一条后，这里会显示本条识别到的结构块。';
        return;
    }
    const a = resolveFixModeCfg(getEffectiveFixCfg(getSettings(), getFixCfg()), 'auto');
    const dec = resolveFixPieces({ pieceMode: a.pieceMode, scopeTag: a.scopeTag, scopeManual: a.scopeManual, pieceAsked: a.pieceAsked, reply: latest.text });
    const wrapped = (dec.mode === 'wrapped' && dec.tag);
    const table = (dec.action === 'run' || dec.action === 'ask' || dec.action === 'pending')
        ? fixSegmentReply(latest.text, wrapped ? { mode: 'wrapped', tag: dec.tag, keepNames: fixKeepNameSet(a.keepTags) } : { mode: 'bare' })
        : null;
    const items = table ? fixGuardSummary(table, { wrapperTag: wrapped ? dec.tag : '' }) : [];
    box.hidden = false;
    if (!items.length) {
        box.textContent = '这条没有识别到结构块' + ((dec.action === 'run' && dec.mode === 'whole') ? '（整条都是正文）。' : '。');
        return;
    }
    const head = document.createElement('div');
    head.textContent = '本条已自动保留 ' + items.reduce((n, x) => n + x.count, 0) + ' 块'
        + (String(a.dropTags || '').trim() ? '（丢弃区点名的除外）' : '') + '：';
    box.appendChild(head);
    const wrap = document.createElement('div');
    wrap.className = 'so-scan-blocks';
    for (const it of items) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'so-scan-cand';
        chip.textContent = it.label + (it.count > 1 ? ' ×' + it.count : '');
        if (it.name) {
            chip.title = '点一下固定进保留区：之后每条回复都强制保留（含行内出现）';
            chip.addEventListener('click', () => {
                const keepEl = sharedState.win.querySelector('#so-fix-keep');
                const merged = mergeKeepTags(keepEl ? keepEl.value : (a.keepTags || ''), [{ name: it.name, bracket: !!it.bracket }]);
                if (keepEl) keepEl.value = merged;
                setFixCfg({ fixA_keepTags: merged });
                updateFixVerdict();
                if (typeof toastr !== 'undefined') toastr.success('已把 ' + it.label + ' 固定进保留区');
            });
        } else {
            chip.disabled = true;
            chip.title = '自动识别的惰性区间（注释 / 代码栏等），无需设置';
        }
        wrap.appendChild(chip);
    }
    box.appendChild(wrap);
}

// ✨ 判定预览行（1.18.0 分段版）：对【最新一条回复】跑决策阶梯（= 自动模式此刻会怎么处理这条），渲染成
// 一行人话。P8：可见性 = 本聊天 autoFixEnabled【或】面板正显示自动视图（原来只看全局 fixSettingsView——
// per-chat 开了自动、面板停在手动视图时，唯一的「这卡会被怎么处理」预览恰好隐身）。分段开关开 → 计数
// 全部片段（修「绿判定只数第一块」）；待确认状态带内联「确认」按钮（confirmPieceBare）。数字 / 标签名
// （扫描器字符集无 HTML 元字符）→ 拼 DOM 安全。开关关 → 沿用 1.17.x 原判定逻辑（字节不变，在函数尾部）。
export function updateFixVerdict() {
    if (!sharedState.win) return;
    const el = sharedState.win.querySelector('#so-fix-verdict');
    if (!el) return;
    try { renderFixGuardReceipts(); } catch (e) { /* 收据渲染失败无碍判定行（防御：分段函数吃到诡异回复时） */ }
    const cfg = getEffectiveFixCfg(getSettings(), getFixCfg());
    // 📋 视图三态必须与 applyFixModeView 同一套归一（评审 F5b）：旗关时存档里残留的 'custom' 不算数——
    // 直接读原始 fixSettingsView 会让旗关的用户在「其实是 manual」的视图下把判定行显出来。
    const rawView = getSettings().fixSettingsView;
    const view = (rawView === 'auto') ? 'auto' : ((ENABLE_FIX_CUSTOM_TASK && rawView === 'custom') ? 'custom' : 'manual');
    if (view !== 'auto' && view !== 'custom' && !cfg.autoFixEnabled) { el.hidden = true; return; }
    el.hidden = false;
    // 📋 自定义模板任务：本聊天的任务是 custom（或面板正显示自定义视图）→ 改渲自定义句。
    // ask / pending 时故意 v = null 落回下面的自动分支：同一句提示 + 同一颗「确认」按钮，用户只学一次。
    const cc = ENABLE_FIX_CUSTOM_TASK ? resolveFixCustomCfg(cfg) : null;
    if (cc && (cc.task === 'custom' || view === 'custom')) {
        // 只因【视图】进这一支 = 这个聊天跑的还是校正 ⇒ 整支改渲【预览】，一句结局都不许（评审 F4）。
        const preview = cc.task !== 'custom';
        const latestC = getLatestAiMessage();
        const tpl = findFixTemplate(getSettings(), cc.template);
        const exists = !!(tpl && String(tpl.prompt || '').trim());
        let v;
        // 预览态（本聊天跑的仍是校正，只是面板切到了自定义视图）要把这件事说在前面——否则这句读起来
        // 像是「模板已经在管这个聊天了，只差一条回复」。非预览那句一字不动（真用户零波及，评审 F4 同款口径）。
        if (latestC.idx < 0) v = { cls: 'so-fix-verdict so-fix-verdict-neutral', text: preview
            ? 'ⓘ 本聊天目前跑的是校正；还没有可预览的回复——主聊天里发一条后，这里会显示切到模板后这条回复会怎么处理。'
            : 'ⓘ 还没有可预览的回复——主聊天里发一条后，这里会显示这条回复会怎么处理。' };
        else if (!exists || !cc.useMechanic) v = fixCustomVerdictText({ template: cc.template, exists, useMechanic: cc.useMechanic, preview, keepCount: (fixCustomRawTable(latestC.text, cc.keepTags, cc.dropTags) || { keepBlocks: [] }).keepBlocks.length });
        else {
            const ac = resolveFixModeCfg(cfg, 'auto');
            const dec = resolveFixPieces({ pieceMode: ac.pieceMode, scopeTag: ac.scopeTag, scopeManual: ac.scopeManual, pieceAsked: ac.pieceAsked, reply: latestC.text });
            if (dec.action === 'ask' || dec.action === 'pending') { v = null; }   // 与校正同一句 + 确认按钮：跳到下面的自动分支渲染
            else if (dec.action === 'run' && (dec.mode === 'wrapped' || dec.mode === 'bare')) {
                const c2 = fixTableCounts(fixSegmentReply(latestC.text, dec.mode === 'wrapped' ? { mode: 'wrapped', tag: dec.tag, keepNames: fixKeepNameSet(cc.keepTags) } : { mode: 'bare' }));
                v = fixCustomVerdictText({ template: cc.template, exists, useMechanic: true, preview, mode: dec.mode, tag: dec.tag, pieces: c2.pieces, prose: c2.prose, guards: c2.guards });
            } else v = fixCustomVerdictText({ template: cc.template, exists, useMechanic: true, preview, mode: 'whole' });
        }
        if (v) { el.className = v.cls; el.textContent = v.text; return; }
        // ask / pending：落到既有自动渲染（同一确认按钮）
    }
    const latest = getLatestAiMessage();
    if (latest.idx < 0) {
        el.className = 'so-fix-verdict so-fix-verdict-neutral';
        el.textContent = 'ⓘ 还没有可预览的回复——主聊天里发一条后，这里会显示这条回复的校正范围。';
        return;
    }
    const a = resolveFixModeCfg(cfg, 'auto');
    if (ENABLE_FIX_PIECEWISE) {
        const dec = resolveFixPieces({ pieceMode: a.pieceMode, scopeTag: a.scopeTag, scopeManual: a.scopeManual, pieceAsked: a.pieceAsked, reply: latest.text });
        const joinLabel = a.pieceJoin ? '整体校正（1 次调用）' : '分段校正';
        if (dec.action === 'run' && dec.mode === 'wrapped') {
            const table = fixSegmentReply(latest.text, { mode: 'wrapped', tag: dec.tag, keepNames: fixKeepNameSet(a.keepTags) });
            const c = fixTableCounts(table);
            if (!table.pieces.length) {
                el.className = 'so-fix-verdict so-fix-verdict-warn';
                el.textContent = '⏭️ 命中 <' + dec.tag + '>，但里面没有可校正的正文（全是结构块）→ 这条会跳过、不动。';
            } else {
                el.className = 'so-fix-verdict so-fix-verdict-ok';
                el.textContent = '✓ 命中 <' + dec.tag + '> → ' + joinLabel + '覆盖 ' + c.pieces + ' 段正文（共 ' + c.prose + ' 字）；' + c.guards + ' 块结构原样保留。';
            }
        } else if (dec.action === 'run' && dec.mode === 'bare') {
            const c = fixTableCounts(fixSegmentReply(latest.text, { mode: 'bare' }));
            el.className = 'so-fix-verdict so-fix-verdict-ok';
            el.textContent = '✓ 散文正文（已确认）→ ' + joinLabel + '覆盖 ' + c.pieces + ' 段正文（共 ' + c.prose + ' 字）；' + c.guards + ' 块结构原样保留。';
        } else if (dec.action === 'run') {   // whole
            el.className = 'so-fix-verdict so-fix-verdict-neutral';
            el.textContent = a.scopeTag
                ? 'ⓘ 这条回复没有包裹标签也没有结构块（整条都是正文）→ 会校正整条回复。'
                : 'ⓘ 没设作用域 → 会校正整条回复（适合没有状态栏 / 选项等结构块的简单卡）。';
        } else if (dec.action === 'ask' || dec.action === 'pending') {
            const wrappedAsk = dec.mode === 'wrapped' && dec.tag;
            const c = fixTableCounts(fixSegmentReply(latest.text, wrappedAsk
                ? { mode: 'wrapped', tag: dec.tag, keepNames: fixKeepNameSet(a.keepTags) }
                : { mode: 'bare' }));
            el.className = 'so-fix-verdict so-fix-verdict-warn';
            el.textContent = wrappedAsk
                ? '✋ 需要确认一次：正文像是包在 <' + dec.tag + '> 里（约 ' + c.prose + ' 字；' + c.guards + ' 块结构将原样保留）——确认一次后即可校正（之后不再问）。 '
                : '✋ 需要确认一次：正文像是【标签之外的散文】（约 ' + c.prose + ' 字；' + c.guards + ' 块结构将原样保留）——确认一次后即可校正（之后不再问）。 ';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'so-fix-ask-confirm';
            btn.className = 'so-fix-run-btn';
            btn.textContent = '确认';
            btn.addEventListener('click', () => (wrappedAsk ? confirmPieceWrapped(dec.tag) : confirmPieceBare()));
            el.appendChild(btn);
        } else if (dec.action === 'suggest') {
            el.className = 'so-fix-verdict so-fix-verdict-warn';
            el.textContent = dec.note.detectedTag
                ? '⚠️ 你设的 <' + a.scopeTag + '> 不在这条回复里；可能是 <' + dec.note.detectedTag + '>（点扫描采纳，或手动改）——这条会被跳过、不动。'
                : '⚠️ 你设的 <' + a.scopeTag + '> 不在这条回复里 → 这条会被跳过、不动（避免误改整条）。';
        } else {   // skip（anomaly / noNarrative）
            el.className = 'so-fix-verdict so-fix-verdict-warn';
            el.textContent = (dec.note && dec.note.code === 'noNarrative')
                ? '⏭️ 这条回复没有可校正的正文（全是结构块）→ 会跳过、不动。'
                : '⏭️ 这条回复里没有 <' + a.scopeTag + '> → 自动会跳过、不动它（可能这条格式特殊，或卡片换了标签——点扫描看看）。';
        }
        return;
    }
    // —— 开关关：以下为 1.17.x 原判定逻辑，字节不变 ——
    const dec = resolveFixScope({ cachedTag: a.scopeTag, scopeManual: a.scopeManual, reply: latest.text, replies: recentAiReplies(getCtx().chat, 5) });
    if (dec.action === 'cache') {
        const v = fixScopeVerdict(latest.text, a.scopeTag, a.keepTags);
        el.className = 'so-fix-verdict so-fix-verdict-ok';
        el.textContent = '✓ 命中 <' + a.scopeTag + '> → 只校正正文 ' + v.fixChars + ' 字，正文外 ' + v.preservedTags.length + ' 块原样保留'
            + (v.keepBlockCount ? ('（含你指定保留的 ' + v.keepBlockCount + ' 块）') : '');
    } else if (dec.action === 'fallbackWhole') {
        el.className = 'so-fix-verdict so-fix-verdict-neutral';
        el.textContent = a.scopeTag
            ? 'ⓘ 这条回复没有包裹标签（整条都是正文）→ 会校正整条回复。'
            : 'ⓘ 没设作用域 → 会校正整条回复（适合没有状态栏 / 选项等结构块的简单卡）。';
    } else if (dec.action === 'detected') {
        el.className = 'so-fix-verdict so-fix-verdict-warn';
        el.textContent = '✨ 这条回复用的是 <' + dec.note.detectedTag + '>（不是 <' + a.scopeTag + '>）→ 自动会切到 <' + dec.note.detectedTag + '> 再校正。';
    } else if (dec.action === 'suggest') {
        el.className = 'so-fix-verdict so-fix-verdict-warn';
        el.textContent = dec.note.detectedTag
            ? '⚠️ 你设的 <' + a.scopeTag + '> 不在这条回复里；可能是 <' + dec.note.detectedTag + '>（点扫描采纳，或手动改）——这条会被跳过、不动。'
            : '⚠️ 你设的 <' + a.scopeTag + '> 不在这条回复里 → 这条会被跳过、不动（避免误改整条）。';
    } else {   // skip（anomaly / uncertain）
        el.className = 'so-fix-verdict so-fix-verdict-warn';
        el.textContent = '⏭️ 这条回复里没有 <' + a.scopeTag + '> → 自动会跳过、不动它（可能这条格式特殊，或卡片换了标签——点扫描看看）。';
    }
}

// ✨ 防呆（P5 接线——fixConfigWarnings 定义于 1.17.16 却零调用点，红队核实的死代码）：把配置体检警告
// 渲染进 #so-fix-warnings（作用域标签误填保留区 / 尖方分隔符不匹配（带一键采纳）/ 自动开着却没勾目标）。
// 输入变化时调用；无警告清空隐藏。采纳 = 把建议形式【追加】到对应区（旧错项留着无害——同名同分隔符命中
// 后警告自然消失），不猜删用户原文。
export function renderFixConfigWarnings() {
    if (!sharedState.win) return;
    const box = sharedState.win.querySelector('#so-fix-warnings');
    if (!box) return;
    // 📋 自定义面板有自己的两区 → 自己的警告盒；按字段前缀分流，两边不串（自定义面板的警告出现在自动面板里没人看得懂）。
    const boxC = sharedState.win.querySelector('#so-fixc-warnings');
    const cfg = getEffectiveFixCfg(getSettings(), getFixCfg());
    const latest = getLatestAiMessage();
    const warnings = fixConfigWarnings(cfg, latest.idx >= 0 ? latest.text : null);
    const isCustomField = (f) => String(f || '').startsWith('fixC_');
    const listA = warnings.filter((w) => !isCustomField(w.field));
    const listC = warnings.filter((w) => isCustomField(w.field));
    const FIELD_INPUT = { fixA_dropTags: '#so-fix-drop', fixA_keepTags: '#so-fix-keep', fixC_dropTags: '#so-fixc-drop', fixC_keepTags: '#so-fixc-keep' };
    const render = (target, list) => {
        if (!target) return;
        target.innerHTML = '';
        target.hidden = !list.length;
        for (const w of list) {
            const line = document.createElement('div');
            line.className = 'so-fix-warnline';
            line.textContent = '⚠ ' + w.message;
            if (w.code === 'delimiterMismatch' && w.suggest) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'so-fix-run-btn';
                btn.textContent = '改成 ' + w.suggest;
                btn.addEventListener('click', () => {
                    const sel = FIELD_INPUT[w.field] || '#so-fix-keep';
                    const el2 = sharedState.win.querySelector(sel);
                    if (!el2) return;
                    el2.value = el2.value + ((el2.value && !el2.value.endsWith('\n')) ? '\n' : '') + w.suggest;
                    setFixCfg({ [w.field]: el2.value });
                    renderFixConfigWarnings();
                    updateFixVerdict();
                });
                line.appendChild(document.createTextNode(' '));
                line.appendChild(btn);
            }
            target.appendChild(line);
        }
    };
    render(box, listA);
    render(boxC, listC);
}

// ✨ Phase 6（C）——扫描按钮：对最近几条 AI 回复跑 detectScopeTag + detectInnerBlocks，出「采纳标签 / 加入保留区」建议。
// 标签名受 scanTopLevelBlocks 字符集约束（[A-Za-z0-9_一-龥-]，无 HTML 元字符）→ 直插 innerHTML 无注入风险。
export function scanFixScope() {
    if (!sharedState.win) return;
    const panel = sharedState.win.querySelector('#so-fix-scan-panel');
    if (!panel) return;
    panel.hidden = false;
    const chat = getCtx().chat;
    const replies = recentAiReplies(chat, 8);
    if (!replies.length) { panel.innerHTML = '<div class="so-hint">还没有 AI 回复可供扫描——先在主聊天里生成几条回复再来。</div>'; return; }
    const det = detectScopeTag(replies);
    if (det.noWrapper) {
        // ✨ 分段校正（1.18.0）：裸正文再分两种——① 夹着 own-line 结构块（bare-with-structure）→ 推荐
        // 「确认散文正文」（分段校正：只改散文、结构原样保留）；② 全裸（无结构）→ 留空作用域（整条校正，
        // 今天的正常情况）。开关关时恒走 ②（老面板字节不变）。
        const hasStruct = ENABLE_FIX_PIECEWISE && fixScanBlocks(replies[replies.length - 1] || '').length > 0;
        if (hasStruct) {
            panel.innerHTML = '<div class="so-scan-row">这几条回复的正文是【标签之外的散文】，中间夹着结构块。</div>'
                + '<div class="so-hint">→ 点「确认散文正文」：之后每条回复只校正散文，own-line 结构块（状态栏 / 选项 / 注记…）原样保留。</div>'
                + '<button type="button" id="so-scan-bare" class="so-fix-run-btn">确认散文正文（结构块原样保留）</button> '
                + '<button type="button" id="so-scan-clear" class="so-fix-run-btn">改成整条校正</button>';
            const bb = sharedState.win.querySelector('#so-scan-bare');
            if (bb) bb.addEventListener('click', () => { confirmPieceBare(); panel.hidden = true; });
        } else {
            panel.innerHTML = '<div class="so-scan-row">这几条回复的正文是【裸的】——没有包裹标签。</div>'
                + '<div class="so-hint">→ 把上面的「只校正此标签内」<strong>留空</strong>即可，会校正整条回复（简单卡的正常情况）。</div>'
                + '<button type="button" id="so-scan-clear" class="so-fix-run-btn">留空作用域</button>';
        }
        const cb = sharedState.win.querySelector('#so-scan-clear');
        if (cb) cb.addEventListener('click', () => applyScopeFromScan(''));
        return;
    }
    const conf = det.confidence;
    const confLabel = (conf === 'high') ? '很可能' : (conf === 'med' ? '可能' : '不太确定');
    let html = '<div class="so-scan-row">检测到正文标签：<code>&lt;' + det.tag + '&gt;</code> <span class="so-scan-conf so-scan-conf-' + conf + '">' + confLabel + '</span></div>';
    if (conf === 'high') {
        html += '<button type="button" class="so-fix-run-btn" data-scan-adopt="' + det.tag + '">采纳 &lt;' + det.tag + '&gt; 作为作用域</button>';
    } else {
        html += '<div class="so-hint">不太确定，从下面挑一个（点一下就填上），或直接手动填：</div><div class="so-scan-cands">';
        for (const c of det.candidates.slice(0, 5)) html += '<button type="button" class="so-scan-cand" data-scan-adopt="' + c.tag + '">&lt;' + c.tag + '&gt;</button>';
        html += '</div>';
    }
    const inner = (splitContentScope(replies[replies.length - 1], det.tag).inner) || '';
    const blocks = detectInnerBlocks(inner);
    if (blocks.length) {
        html += '<div class="so-scan-row" style="margin-top:6px;">这些结构块会被自动保留，无需设置。若某块出现在段落中间（行内），勾选加入保留区可强制原位保留：</div><div class="so-scan-blocks">';
        for (const b of blocks) {
            const form = b.bracket ? ('[' + b.name + ']') : ('&lt;' + b.name + '&gt;');
            html += '<label class="so-check"><input type="checkbox" class="so-scan-block" data-bn="' + b.name + '" data-bb="' + (b.bracket ? '1' : '0') + '" checked>&nbsp;<span>' + form + '</span></label>';
        }
        html += '</div><button type="button" id="so-scan-keep" class="so-fix-run-btn">把勾选的加入保留区</button>';
    }
    panel.innerHTML = html;
    panel.querySelectorAll('[data-scan-adopt]').forEach((b) => b.addEventListener('click', () => applyScopeFromScan(b.getAttribute('data-scan-adopt'))));
    const keepBtn = sharedState.win.querySelector('#so-scan-keep');
    if (keepBtn) keepBtn.addEventListener('click', () => {
        const picks = [...panel.querySelectorAll('.so-scan-block:checked')].map((c) => ({ name: c.getAttribute('data-bn'), bracket: c.getAttribute('data-bb') === '1' }));
        if (!picks.length) { if (typeof toastr !== 'undefined') toastr.info('没勾选任何块'); return; }
        const keepEl = sharedState.win.querySelector('#so-fix-keep');
        const merged = mergeKeepTags(keepEl.value, picks);
        keepEl.value = merged;
        setFixCfg({ fixA_keepTags: merged });
        updateFixVerdict();
        if (typeof toastr !== 'undefined') toastr.success('已把 ' + picks.length + ' 个结构块加入保留区');
    });
}

// 采纳扫描建议的作用域标签（写 per-chat 配置，scopeManual=false —— 这是「接受检测建议」非用户手填，之后仍可自纠）+ 刷新输入框 / 判定。
function applyScopeFromScan(tag) {
    // ✨ 分段校正（1.18.0）：采纳扫描标签 = 同步记住 wrapped 形态；留空 = 清掉形态记忆（回到现场判 / 整条）。
    setFixCfg({ fixA_scopeTag: tag, fixA_scopeManual: false, fixA_pieceMode: tag ? 'wrapped' : '' });
    const el = sharedState.win && sharedState.win.querySelector('#so-fix-scope');
    if (el) el.value = tag;
    updateFixVerdict();
    const panel = sharedState.win && sharedState.win.querySelector('#so-fix-scan-panel');
    if (panel) panel.hidden = true;
    if (typeof toastr !== 'undefined') toastr.success(tag ? ('作用域已设为 <' + tag + '>') : '作用域已留空（校正整条）');
}

// ✨ 校正模式「自动配置」Phase 7（M4）——把【本聊天】的自动校正设置一键还原成推荐值（作用域 content / 默认目标 /
// 排除区清空 / 收紧开 / 自动关 / scopeManual 清掉）。只动自动那套（fixA_* + autoFixEnabled），手动 fixM_* 不碰。
// 📋 自定义模板任务（1.77.0）起也一并归位：任务切回「校正」、清 fixC_*（模板选择 + 自带两区，沿用识别回默认开）。
export function resetFixCfg() {
    setFixCfg({
        fixA_scopeTag: 'content', fixA_scopeManual: false,
        fixA_pieceMode: '', fixA_pieceAsked: false, fixA_pieceJoin: true,   // ✨ 分段校正：清掉正文形态记忆 + 已询问标记（回到「现场判」）；整体校正回默认开
        fixA_targetSlop: true, fixA_targetDialogue: true, fixA_targetPrecision: true, fixA_targetMagic: false, fixA_targetPacing: true, fixA_targetArchaic: false,
        fixA_keepTags: '', fixA_dropTags: '', fixA_knowledgeBoundary: '', fixA_guardrails: '',
        fixA_tighten: true, autoFixEnabled: false,
        // 📋 自定义模板任务：本聊天回到「校正」任务、清模板选择与自带两区、沿用识别回默认开。
        fixA_task: 'fix', fixC_template: '', fixC_useMechanic: true, fixC_keepTags: '', fixC_dropTags: '',
    });
    seedFixControls();        // 回填控件（含 applyFixModeView → updateFixVerdict）
    updateFixButtonVisual();  // autoFixEnabled 归 false → ✨ 金色指示对齐
    if (typeof toastr !== 'undefined') toastr.success('已恢复本聊天的推荐校正设置');
}

// 经【自定义补全预设】发送时（fixM_/fixA_usePreset，手动 / 自动各自独立），角色卡 / 世界书由预设的 charDescription / worldInfo 标记提供 →
// 校正设置里的「带角色卡 / 带世界书」勾选会被忽略，故置灰（disabled + 变淡 + 悬停说明）。手动 + 自动两组都处理。
// 概要 / 前文仍走 slim 信封（不由预设标记提供），故不灰。
export function applyFixPresetLock() {
    if (!sharedState.win) return;
    const s = getSettings();
    const lockIds = (ids, locked) => {
        for (const id of ids) {
            const el = sharedState.win.querySelector(id);
            if (!el) continue;
            el.disabled = locked;
            const label = el.closest('label');
            if (label) {
                label.style.opacity = locked ? '0.45' : '';
                label.title = locked ? '已由自定义补全预设的标记提供（角色卡 / 世界书）——预设模式下此项被忽略' : '';
            }
        }
    };
    lockIds(['#so-fixm-card', '#so-fixm-world'], fixUsePresetFor(s, 'manual'));   // 手动组按 fixM_usePreset
    lockIds(['#so-fix-card', '#so-fix-world'], fixUsePresetFor(s, 'auto'));       // 自动组按 fixA_usePreset
}

// 用【本聊天】生效配置（per-chat 覆盖全局）回填校正控件（手动 fixM_* + 自动 fixA_*），并按 fixSettingsView 切视图。
// 控件未建好（窗口未初始化）时静默跳过。
export function seedFixControls() {
    if (!sharedState.win) return;
    const cfg = getEffectiveFixCfg(getSettings(), getFixCfg());
    const set = (id, prop, val) => { const el = sharedState.win.querySelector(id); if (el) el[prop] = val; };
    // 手动（fixM_*）
    set('#so-fixm-depth', 'value', cfg.fixM_contextDepth);
    set('#so-fixm-card', 'checked', !!cfg.fixM_includeCard);
    set('#so-fixm-world', 'checked', !!cfg.fixM_includeWorld);
    set('#so-fixm-summary', 'checked', !!cfg.fixM_includeSummary);
    set('#so-fixm-protectthink', 'checked', cfg.fixM_protectThink !== false);   // ✨ 思考块保护（W1）：缺键=开，与 resolveFixModeCfg 同式
    set('#so-fixm-scope', 'value', cfg.fixM_scopeTag || '');   // 二创版 2.1：手动整篇的正文标签
    // 自动（fixA_*）
    set('#so-fix-tgt-slop', 'checked', !!cfg.fixA_targetSlop);
    set('#so-fix-tgt-dialogue', 'checked', !!cfg.fixA_targetDialogue);
    set('#so-fix-tgt-precision', 'checked', !!cfg.fixA_targetPrecision);
    set('#so-fix-tgt-magic', 'checked', !!cfg.fixA_targetMagic);
    set('#so-fix-tgt-pacing', 'checked', !!cfg.fixA_targetPacing);
    set('#so-fix-tgt-archaic', 'checked', !!cfg.fixA_targetArchaic);
    set('#so-fix-scope', 'value', cfg.fixA_scopeTag != null ? cfg.fixA_scopeTag : 'content');   // ✨ 作用域标签（默认 content）
    set('#so-fix-join', 'checked', cfg.fixA_pieceJoin !== false);   // ✨ 整体校正（默认开）
    set('#so-fix-keep', 'value', cfg.fixA_keepTags || '');
    set('#so-fix-drop', 'value', cfg.fixA_dropTags || '');
    set('#so-fix-know', 'value', cfg.fixA_knowledgeBoundary || '');
    set('#so-fix-guard', 'value', cfg.fixA_guardrails || '');
    set('#so-fix-prompt-version', 'value', (cfg.fixA_promptVersion === 'thorough') ? 'thorough' : 'light');   // ✨ 校正提示词（轻校 / 精校）
    set('#so-fix-prompt-flavor', 'value', ['opus', 'gemini'].includes(cfg.fixA_promptFlavor) ? cfg.fixA_promptFlavor : 'deepseek');   // ✨ 精校侧重（DeepSeek / Opus / Gemini）
    set('#so-fix-card', 'checked', !!cfg.fixA_includeCard);
    set('#so-fix-ctx', 'checked', !!cfg.fixA_includeContext);
    set('#so-fix-ctx-depth', 'value', cfg.fixA_contextDepth);
    set('#so-fix-world', 'checked', !!cfg.fixA_includeWorld);
    set('#so-fixa-summary', 'checked', !!cfg.fixA_includeSummary);
    set('#so-fix-auto', 'checked', !!cfg.autoFixEnabled);
    set('#so-fixm-preset', 'checked', !!getSettings().fixM_usePreset);   // 全局开关（手动）；不在 cfg / FIX_CFG_KEYS 里
    set('#so-fixa-preset', 'checked', !!getSettings().fixA_usePreset);   // 全局开关（自动）
    set('#so-fix-wait-mvu', 'checked', !!getSettings().fixWaitForMvu);   // ✨ MVU「额外模型更新」抢写协调（全局 opt-in）
    // 📋 自定义模板任务（fixC_* + 任务开关）。两个「自动」勾选按 task 分家 = 构造性互斥（spec §4.2）。
    if (ENABLE_FIX_CUSTOM_TASK) {
        const cc = resolveFixCustomCfg(cfg);
        set('#so-fix-auto', 'checked', !!cfg.autoFixEnabled && cc.task === 'fix');    // 互斥显示（覆盖上面那行）
        set('#so-fixc-auto', 'checked', !!cfg.autoFixEnabled && cc.task === 'custom');
        populateFixTemplates();
        // 📋 未保存的模板正文把面板【钉】在它的归属模板上，直到用户保存或亲手换一份（spec §4.3 防误覆盖）。
        // seedFixControls 会被切聊天、加载套餐、两个自动勾选调到——脏着时若照常回填，轻则吃掉用户打的字，
        // 重则把下拉挪到别的模板上（程序化写 value 不发 change，「未保存」确认根本不会弹），再按保存就写错人。
        // 故脏着时下拉与文本框一起停在 fixTplDirtyFor 上；其余控件照常无条件回填。
        if (sharedState.fixTplDirty) {
            set('#so-fixc-template', 'value', sharedState.fixTplDirtyFor);
        } else {
            set('#so-fixc-template', 'value', cc.template);
            const t = findFixTemplate(getSettings(), cc.template);
            set('#so-fixc-prompt', 'value', t ? t.prompt : '');
            sharedState.fixTplDirtyFor = cc.template;   // 不变量：凡是【从模板回填 tplBox.value 的地方】都同时记下归属
        }
        updateFixTplDirtyMarker();   // 重种子后标记必须与旗一致（脏着回来时它得还在）
        set('#so-fixc-mech', 'checked', cc.useMechanic);
        set('#so-fixc-keep', 'value', cc.keepTags);
        set('#so-fixc-drop', 'value', cc.dropTags);
        set('#so-fixc-preset', 'checked', !!getSettings().fixC_usePreset);
        set('#so-fixc-minchars', 'value', clampFixAutoMinChars(cfg.fixAutoMinChars));
    }
    applyFixPresetLock();   // 预设模式下置灰「带角色卡 / 带世界书」（由预设标记提供）
    applyFixModeView();
    updateFixVerdict();          // ✨ 1.18.0：开窗 / 切聊天即刷新判定预览行（P8：per-chat 自动开着就该看得见）
    renderFixConfigWarnings();   // ✨ 防呆（P5）：配置体检警告随控件回填一起刷新
}

// 切聊天时把校正控件重置成新聊天的生效配置（同 loadConvoForChat / loadDiagSelForChat 风格）。
export function loadFixCfgForChat() {
    seedFixControls();
    updateFixButtonVisual();   // 切聊天后按本聊天生效的 autoFixEnabled 对齐 ✨ 金色指示
}

// ✨ 校正模式 Phase 4：用全局 fixBundles 的名字填充套餐下拉。窗口打开时 + 每次存 / 删后调用。
export function populateFixBundles() {
    if (!sharedState.win) return;
    const sel = sharedState.win.querySelector('#so-fix-bundle');
    if (!sel) return;
    const prev = sel.value;
    const bundles = (Array.isArray(getSettings().fixBundles) ? getSettings().fixBundles : []);
    sel.innerHTML = '';
    if (!bundles.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（暂无已存套餐）';
        sel.appendChild(opt);
    } else {
        for (const b of bundles) {
            if (!b || !b.name) continue;
            const opt = document.createElement('option');
            opt.value = b.name;
            opt.textContent = b.name;
            sel.appendChild(opt);
        }
        // 尽量保留原选中项（存 / 删后列表变了仍停在合理位置）。
        if (prev && bundles.some((b) => b && b.name === prev)) sel.value = prev;
    }
}

// 📋 自定义模板任务：填充模板下拉（仿 populateFixBundles）。seedFixControls + 每次存 / 删后调用。
// 排布 = 用户自己的 fixTemplates 在前，两份内置示例在【末尾的 optgroup】里（2026-09-05 产品负责人裁定：
// 示例直接列进下拉、不再有「示例…」按钮）。选 optgroup 而不是 data-builtin 属性：原生 <select> 的分组
// 是浏览器画的、ST 的 select 皮肤只管字色背景，用不着我们自己造「这是示例」的视觉。
// 空占位只在【当前没选】时才给一条（用户库空着时下面还有两份示例可选，再说「暂无模板」就是假话）——
// 没有这一条时 seedFixControls 那句 `set('#so-fixc-template','value','')` 会写不进去，下拉会停在第一项
// 而配置说「没选」，两边当场分家。
export function populateFixTemplates() {
    if (!sharedState.win || !ENABLE_FIX_CUSTOM_TASK) return;
    const sel = sharedState.win.querySelector('#so-fixc-template');
    if (!sel) return;
    const prev = sel.value;
    const templates = normalizeFixTemplates(getSettings().fixTemplates);
    // 「当前没选」的口径取【两处的并集】：下拉此刻的值 + 本聊天配置里的名字。只看下拉会漏掉「切到一个
    // 没配模板的聊天」——那一拍 seedFixControls 要把 value 写成 ''，没有这条占位就写不进去，下拉会停在
    // 上一个聊天的模板上而配置说「没选」（正是删除按钮那段注释里防的那种分家）。
    let cfgName = '';
    try { cfgName = String(getEffectiveFixCfg(getSettings(), getFixCfg()).fixC_template || ''); } catch (e) { cfgName = ''; }
    sel.innerHTML = '';
    if (!prev || !cfgName) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（未选择模板）';
        sel.appendChild(opt);
    }
    for (const t of templates) {
        const opt = document.createElement('option');
        opt.value = t.name;
        opt.textContent = t.name;
        sel.appendChild(opt);
    }
    // 同名时用户那一份赢（findFixTemplate 的口径）——老存档里若真躺着一份同名模板，示例这边就不再列，
    // 否则下拉里两条一模一样的名字，选哪条都是用户那份，纯属误导。
    const mine = new Set(templates.map((t) => t.name));
    const builtins = FIX_SAMPLE_TEMPLATES.filter((t) => !mine.has(t.name));
    if (builtins.length) {
        const grp = document.createElement('optgroup');
        grp.label = '内置示例';
        for (const t of builtins) {
            const opt = document.createElement('option');
            opt.value = t.name;
            opt.textContent = t.name;
            grp.appendChild(opt);
        }
        sel.appendChild(grp);
    }
    // 尽量保留原选中项（存 / 删后列表变了仍停在合理位置）；内置示例也算「还在列表里」。
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

// 📋 「未保存」标记与 fixTplDirty 同步。旗是这件事的唯一真相，标记只是它的投影——所以【每一处】
// 置 / 清旗的后面都跟一次本函数（input / 换模板 / 新建 / 保存 / 删除后认领 / seedFixControls），
// 而不是各自去 el.hidden = …；漏一处，用户就会看见一个与实际不符的「未保存」（或看不见该有的那个）。
// 窗口没建 / 旗关 / 节点不在 → 静默无操作（与 populateFixTemplates 同一套防御）。
export function updateFixTplDirtyMarker() {
    if (!sharedState.win || !ENABLE_FIX_CUSTOM_TASK) return;
    const el = sharedState.win.querySelector('#so-fixc-dirty');
    if (el) el.hidden = !sharedState.fixTplDirty;
}

// 让选条目器 UI（两个开关 + 可见性 + 列表）与本聊天元数据对齐。进入诊断模式 / 切聊天时调用。
export function refreshDiagPickerUI() {
    if (!sharedState.win || !ENABLE_DIAG_WI_PICKER) return;
    const meta = getDiagWiMeta();
    const useBox = sharedState.win.querySelector('#so-diag-usesel');
    const hybBox = sharedState.win.querySelector('#so-diag-hybrid');
    if (useBox) useBox.checked = meta.use;
    if (hybBox) hybBox.checked = meta.hybrid;
    reflectDiagPickerVisible(meta.use);
    if (meta.use && sharedState.diagnoseMode) populateDiagWiBooks();
}


function formatPrompt(msgs) {
    return msgs.map((m) => {
        const role = (m.role || '?').toUpperCase();
        return `┌─────────── ${role} ───────────\n${m.content || ''}`;
    }).join('\n\n');
}

export function openDebug() {
    const panel = sharedState.win.querySelector('#so-debug');
    const body = sharedState.win.querySelector('#so-debug-body');
    const meta = sharedState.win.querySelector('#so-debug-meta');
    if (!sharedState.lastPrompt || !sharedState.lastPrompt.length) {
        meta.textContent = '';
        body.textContent = '还没有发送过任何提示词。请先向剧情推进提问，然后再打开此面板。';
    } else {
        meta.textContent = sharedState.lastPromptMeta
            ? `· ${sharedState.lastPromptMeta.mode} · ${sharedState.lastPromptMeta.target} · ${sharedState.lastPromptMeta.chars.toLocaleString()} chars · ${sharedState.lastPromptMeta.time}`
            : '';
        body.textContent = formatPrompt(sharedState.lastPrompt);
    }
    panel.classList.add('open');
    body.scrollTop = 0;
}