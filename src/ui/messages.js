import { persistConvo } from '../core/chat-metadata.js';
import { getSettings, soDeleteConfirmMessage, uiConfirm } from '../core/settings.js';

import { appendConvoImportEntry, dropNoteOpts, peekNoteOpts, registerNoteOpts, renderEmptyState } from '../modes/advisor/cards.js';
import { recordLbApplySnapshot } from '../modes/advisor/metadata.js';
import { stripMechanismBlocks, stripReasoningTags } from '../modes/chat/context.js';
import { exportConvo, importConvo, isRecordApplied, markRecordApplied, scrollBubbleToTop, scrollToBottom, soApplyConvoIoVisual, unmarkRecordApplied } from '../modes/chat/history.js';
import { chatIdentityKey, generateReply } from '../modes/chat/send.js';
import { diagUserFloorNotice, mvuMsgOpts } from '../modes/diagnose/auto.js';
import { diagStatKey } from '../modes/diagnose/patch.js';
import { extractUpdateBlock, getLatestAiMessage, getMvu, getMvuStatData, mvuStatOf, wrapContentScope } from '../modes/diagnose/mvu.js';
import { diagSchemaDryLines, diagSchemaFilterPatch, diagSchemaRetryPlan, repairDiagNote, repairDiagPatch } from '../modes/diagnose/diagnostics.js';
import { applyFixAsSwipe, canonicalizeDiagOps, injectDiagPatchIntoMessage, removeDiagWriteBack, restoreDiagWriteBack } from '../modes/diagnose/schema.js';
import { applyFix, composeFixedReply, diagReportLines, diagStampDrifted, diagUndoDrifted, renderDiffCard, undoFix } from '../modes/fix/algorithms.js';
import { fixCurrentSnapshot, fixOutputTruncated, fixTargetStale } from '../modes/fix/capture.js';
import { applyLorebookOps, lbDryRunOps, lbFormatApplyLine, lbSummaryOf, lbVerdictRow, undoLorebookOps } from '../modes/lorebook/operations.js';
import { ENABLE_DIAG_BODY_INJECT } from '../prompts/builtins.js';
import { fixNearCopyNote } from '../prompts/helpers.js';
import { appendConvo, convo, convoStreamKey, nextCid, removeConvoRange } from '../core/conversation-store.js';
import { isGenerating } from '../core/generation.js';
import { messagesEl } from './refs.js';

export let soFollowStream = false;
export let soBulkRenderDepth = 0;

export function trackStreamFollow(followsLatest) {
    soFollowStream = !!followsLatest;
}

export function renderMessagesInBulk(fn) {
    soBulkRenderDepth++;
    try { return fn(); } finally { soBulkRenderDepth--; }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/* Copy that also works in non-secure (http) contexts. ST is frequently
 * served over plain HTTP on a LAN / Tailscale address, where
 * navigator.clipboard is undefined — so fall back to a hidden textarea +
 * execCommand, with the readonly + selection-range trick iOS needs. */
export async function copyTextRobust(text) {
    text = text || '';
    if (!text.trim()) return false;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (e) { /* fall through to legacy path */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length); // iOS Safari needs an explicit range
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch (e) {
        return false;
    }
}

export function addMessage(role, content, entry) {
    const empty = messagesEl.querySelector('.so-empty');
    if (empty) empty.remove();
    // 📤 新的 AI 气泡到场 = 气泡行上的 📥📤 回来了 → 撤掉那枚兜底的空页导入入口（它只在「本房一条
    // AI 气泡都没有」时才该在，否则会孤零零卡在消息中间）。空态卡片里的那枚随 .so-empty 一起走，
    // 这里收的是直接挂在消息区上的独立那枚。
    if (role === 'assistant') {
        for (const e of messagesEl.querySelectorAll(':scope > .so-empty-io')) e.remove();
    }

    const wrap = document.createElement('div');
    wrap.className = `so-msg so-${role}`;
    // 1.85.3 入场动画只给【直播新到】的气泡：批量重画出来的历史不挂；挂了的在动画放完后摘掉，
    // 否则每次开窗（display:none → flex 会重启 CSS 动画）几百条历史一起重播淡入。
    // 判 target + 动画名：气泡里子元素动画的 animationend 也会冒泡上来。
    if (soBulkRenderDepth === 0) {
        wrap.classList.add('so-msg-new');
        wrap.addEventListener('animationend', function soMsgNewDone(ev) {
            if (ev.target !== wrap || (ev.animationName && ev.animationName !== 'so-msg-in')) return;
            wrap.classList.remove('so-msg-new');
            wrap.removeEventListener('animationend', soMsgNewDone);
        });
    }
    if (entry) wrap.dataset.cid = entry.id;
    const icon = role === 'user' ? 'fa-user' : 'fa-moon';
    const label = role === 'user' ? '你' : '剧情推进';

    const copyBtn = role === 'assistant'
        ? `<button class="so-msg-btn so-copy-btn" type="button" title="复制" aria-label="复制此回复"><i class="fa-solid fa-copy"></i></button>`
        : '';
    // Per-message actions (shown on hover): edit (user) / regenerate (assistant) + delete.
    let actionBtns = '';
    if (entry) {
        if (role === 'user') {
            actionBtns += `<button class="so-msg-btn so-edit-btn" type="button" title="编辑并重新生成"><i class="fa-solid fa-pen"></i></button>`;
        } else {
            actionBtns += `<button class="so-msg-btn so-regen-btn" type="button" title="重新生成（会丢弃其后的内容）"><i class="fa-solid fa-rotate"></i></button>`;
        }
        actionBtns += `<button class="so-msg-btn so-del-btn" type="button" title="删除"><i class="fa-solid fa-trash"></i></button>`;
    }
    // 📥📤 整页导出 / 导入（1.61.0，Prince 点名要在气泡这一行也够得着）。它们是【整页】操作，不针对本条
    // 消息，所以哪条 AI 气泡上点都一样；只挂在 AI 气泡上（与复制同一惯例，用户气泡那行留给编辑/删除）。
    // 可见性【不】在这里判定就完事 —— 见 soApplyConvoIoVisual 的说明（换房重画覆盖不到所有模式过渡）。
    const convIoBtns = role === 'assistant'
        ? `<button class="so-msg-btn so-convio-btn so-msg-export-btn" type="button" title="导出本页对话" aria-label="导出本页对话"><i class="fa-solid fa-file-export"></i></button>`
          + `<button class="so-msg-btn so-convio-btn so-msg-import-btn" type="button" title="导入对话文件" aria-label="导入对话文件"><i class="fa-solid fa-file-import"></i></button>`
        : '';

    wrap.innerHTML =
        `<div class="so-avatar"><i class="fa-solid ${icon}"></i></div>` +
        `<div class="so-bubble"><div class="so-role"><span class="so-role-label">${label}</span></div>` +
        `<div class="so-content"></div><span class="so-actions">${copyBtn}${actionBtns}${convIoBtns}</span></div>`;
    const contentEl = wrap.querySelector('.so-content');
    contentEl.textContent = content;

    wrap.querySelector('.so-msg-export-btn')?.addEventListener('click', exportConvo);
    wrap.querySelector('.so-msg-import-btn')?.addEventListener('click', importConvo);
    soApplyConvoIoVisual(wrap);   // 建出来就按当前模式定初值（此后由切模式时的整片刷新维持）

    const cBtn = wrap.querySelector('.so-copy-btn');
    if (cBtn) {
        cBtn.addEventListener('click', async () => {
            const ok = await copyTextRobust(contentEl.textContent);
            cBtn.classList.add('so-copied');
            cBtn.innerHTML = ok ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>';
            cBtn.title = ok ? '已复制' : '复制失败 —— 请手动选择文本';
            setTimeout(() => {
                cBtn.classList.remove('so-copied');
                cBtn.innerHTML = '<i class="fa-solid fa-copy"></i>';
                cBtn.title = '复制';
            }, 1200);
        });
    }
    if (entry) {
        const editBtn = wrap.querySelector('.so-edit-btn');
        if (editBtn) editBtn.addEventListener('click', () => editUserMessage(entry));
        const regenBtn = wrap.querySelector('.so-regen-btn');
        if (regenBtn) regenBtn.addEventListener('click', () => regenerateFrom(entry));
        const delBtn = wrap.querySelector('.so-del-btn');
        if (delBtn) delBtn.addEventListener('click', async () => {
            // 1.22.0 删除二次确认（原生化自二创）：真消息先主题化确认；错误气泡（不在 convo 里）直接删不打扰。
            const i = convo.indexOf(entry);
            if (i !== -1) {
                const kind = entry.role === 'user'
                    ? ((convo[i + 1] && convo[i + 1].role === 'assistant') ? 'userPair' : 'user')
                    : 'assistant';
                if (!(await uiConfirm(soDeleteConfirmMessage(kind)))) return;
            }
            deleteMessage(entry);
        });
    }

    messagesEl.appendChild(wrap);
    if (role === 'assistant' && content === '') {
        soFollowStream = false;                     // #1 新流式回复：固定顶部、默认不跟随，让用户从开头读
        scrollBubbleToTop(wrap);
    } else {
        soFollowStream = true;                      // 用户发言 / 有内容的消息：滚到底并恢复跟随
        scrollToBottom();
    }
    return wrap;
}

// Re-show the empty placeholder if no real messages remain.
function maybeRenderEmpty() {
    if (!messagesEl.querySelector('.so-msg')) { messagesEl.innerHTML = ''; renderEmptyState(); }
    // 📤 删到一条 AI 气泡都不剩 → 📥📤 跟着消失（它们只挂在 AI 气泡上）。这里【当场】补上导入入口，
    // 否则用户要切一次房 / F5 才拿得回来（loadConvoForChat 那次兜底是同一条件、同一个幂等函数）。
    // 删除是唯一能把房间删成「有消息但没有 AI 回复」的路径，所以补这一处就够。
    if (!convo.some((m) => m.role === 'assistant')) appendConvoImportEntry(messagesEl);
}

// Delete one message. Deleting a user turn also drops its immediate assistant
// reply so the history stays well-formed; an error bubble (never pushed to convo)
// just drops from the DOM.
function deleteMessage(entry) {
    if (isGenerating) return;
    const i = convo.indexOf(entry);
    if (i === -1) {
        if (entry && entry._el) entry._el.remove();
        maybeRenderEmpty();
        return;
    }
    if (entry.role === 'user' && convo[i + 1] && convo[i + 1].role === 'assistant') {
        const reply = convo[i + 1];
        if (reply._el) reply._el.remove();
        removeConvoRange(i, 2);
    } else {
        removeConvoRange(i, 1);
    }
    if (entry._el) entry._el.remove();
    persistConvo();
    maybeRenderEmpty();
}

// Regenerate an assistant reply: drop it (and everything after) and re-run from
// the preceding user turn. The common case (the most recent reply) leaves nothing
// after it, so this is just "re-roll the last answer".
async function regenerateFrom(entry) {
    if (isGenerating) return;
    const el = entry._el;
    const i = convo.indexOf(entry);
    if (i !== -1) removeConvoRange(i);     // drop this entry and all after (error bubbles aren't in convo)
    if (el) { while (el.nextSibling) el.nextSibling.remove(); el.remove(); }
    persistConvo();
    if (!convo.length || convo[convo.length - 1].role !== 'user') { maybeRenderEmpty(); return; }
    await generateReply();
}

// Inline-edit a user message, then truncate everything after it and regenerate.
function editUserMessage(entry) {
    if (isGenerating) return;
    const el = entry._el;
    if (!el) return;
    const bubble = el.querySelector('.so-bubble');
    const contentEl = bubble.querySelector('.so-content');
    if (bubble.querySelector('.so-edit-box')) return; // already editing

    const box = document.createElement('div');
    box.className = 'so-edit-box';
    const ta = document.createElement('textarea');
    ta.className = 'so-edit-ta';
    ta.value = entry.content;
    ta.rows = Math.min(12, Math.max(2, entry.content.split('\n').length));
    const actions = document.createElement('div');
    actions.className = 'so-edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'so-edit-save'; saveBtn.textContent = '保存并重新生成';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'so-edit-cancel'; cancelBtn.textContent = '取消';
    actions.appendChild(saveBtn); actions.appendChild(cancelBtn);
    box.appendChild(ta); box.appendChild(actions);
    contentEl.style.display = 'none';
    bubble.appendChild(box);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);

    const close = () => { box.remove(); contentEl.style.display = ''; };
    cancelBtn.addEventListener('click', close);
    const commit = async () => {
        const newText = ta.value.trim();
        const i = convo.indexOf(entry);
        if (!newText || i === -1) { close(); return; }
        entry.content = newText;
        contentEl.textContent = newText;
        removeConvoRange(i + 1);                               // drop later turns
        persistConvo();
        close();
        while (el.nextSibling) el.nextSibling.remove();        // drop their DOM
        await generateReply();
    };
    saveBtn.addEventListener('click', commit);
    ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); close(); }
        else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commit(); }
    });
}

// 失败回复气泡上的【常显】「↻ 重试」按钮（用户功能请求）。.so-actions 里的 regen 按钮只在 hover 时出现，
// 手机上够不着；这里显式加一个一直可见的按钮。点它 = regenerateFrom(entry)：去掉这条失败气泡，对当前侧聊尾部
// （刚发的那条用户消息还在）重新生成——不用重打。复用 .so-apply-bar/.so-apply-btn 样式（零新 CSS）。
export function addRetryControl(assistantEl, entry) {
    if (!assistantEl) return;
    const bubble = assistantEl.querySelector('.so-bubble');
    if (!bubble || bubble.querySelector('.so-retry-btn')) return;   // 防重复添加
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar so-retry-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'so-apply-btn so-retry-btn';
    btn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> 重试';
    bar.appendChild(btn);
    bubble.appendChild(bar);
    scrollToBottom();
    btn.addEventListener('click', () => {
        if (isGenerating) return;
        regenerateFrom(entry);
    });
}

// 🩺 1.89.0：手动诊断的补丁卡 —— 应用键上方先说清哪几处这张卡不会接受（T1），必要时自动发一次重写请求（T6）。
// 重写请求是侧聊里一条看得见的用户消息（schemaRetry 标记），同一轮只发一次；旧卡标「已由下一张替代」。
// 全程兜底：任何一步抛错只丢一行 warn，绝不影响那张卡本身的「应用」。
// 纯函数：这条用户消息是不是我们发的「重写请求」（标记只活在内存里、重载后靠内容前缀认——minors M7）。
function diagSchemaIsRetryTurn(e) {
    return !!(e && (e.schemaRetry || (typeof e.content === 'string' && e.content.startsWith('系统：上一份补丁里有'))));
}
// opts.previewOnly：换房 / 重载重画卡片时只补回预演块，绝不再发重写（minors M7）。
export async function diagSchemaAfterManualReply(assistantEl, finalText, aEntry, opts) {
    try {
        const Mvu = await getMvu();
        if (!Mvu || typeof Mvu.getMvuData !== 'function') return;
        const md = Mvu.getMvuData(mvuMsgOpts());
        const block = extractUpdateBlock(finalText);
        const sf = block ? diagSchemaFilterPatch(repairDiagPatch(block, mvuStatOf(md)).text, md) : null;
        const lines = sf ? diagSchemaDryLines(sf.dry) : '';
        const bar = assistantEl && assistantEl.querySelector('.so-apply-bar');
        if (lines && bar) {
            const pv = document.createElement('div');
            pv.className = 'so-hint so-diag-schema-preview';
            pv.textContent = lines.replace(/^\n/, '');
            bar.parentNode.insertBefore(pv, bar);
        }
        if (opts && opts.previewOnly) return;
        const prev = convo[convo.indexOf(aEntry) - 1];
        const already = diagSchemaIsRetryTurn(prev);
        const plan = diagSchemaRetryPlan(finalText, md, getSettings(), already);
        if (!plan) return;
        // generateReply 还在收尾（isGenerating 仍为真）——等它落定再插话；用户已经接着聊了就不插。
        await new Promise((res) => { const t = setInterval(() => { if (!isGenerating) { clearInterval(t); res(); } }, 100); });
        if (convo[convo.length - 1] !== aEntry) return;
        // 第二张在生成时先锁住第一张的「应用」，免得两张都点、同一处 delta 算两遍（minors M7）。只锁还是「应用」态的键。
        const applyBtn = bar && bar.querySelector('.so-apply-btn');
        const lockable = !!(applyBtn && !applyBtn.disabled && /将修复应用到状态/.test(applyBtn.textContent || ''));
        if (lockable) applyBtn.disabled = true;
        const entry = { id: nextCid(), role: 'user', content: plan.message, schemaRetry: true };
        appendConvo(entry);
        persistConvo();
        entry._el = addMessage('user', plan.message, entry);
        try { await generateReply(); } catch (e) { /* 下面按「没有第二张」处理 */ }
        // 真有了第二张（带补丁的回复）才标「已由下一张替代」并让第一张保持锁住；没有就把第一张还原（minors M7）。
        const last = convo[convo.length - 1];
        const replaced = !!(last && last !== entry && last.role === 'assistant' && extractUpdateBlock(String(last.content || '')));
        if (replaced && bar) {
            const n = document.createElement('div');
            n.className = 'so-hint';
            n.textContent = '已由下一张替代';
            bar.parentNode.insertBefore(n, bar);
        } else if (lockable) applyBtn.disabled = false;
    } catch (e) {
        console.warn('[Story Oracle] 🩺 schema 预演 / 重写失败（不影响应用）：', e);
    }
}

// Apply / Undo bar appended to a diagnose reply that contains a corrective patch.
// replyText（可选，第 4 参，1.68.0）= 这条诊断回复的【原文】，供双区块闸看清 MVU 会执行几块
// （extractUpdateBlock 只摘最早那一个包装块）。换房重画 / 重载后的卡片拿不到原文 → 退化成只数补丁
// 本身：那仍挡得住「一个包装块里两个区块」这一档，只是「两个包装块」那一档在重画后回到旧行为。
export function addApplyControls(assistantEl, patchBlock, entry, replyText) {
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将修复应用到状态';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    // 已应用状态（1.33.2）：会话内应用过（注册表有快照）→ 撤销态重生；只剩持久标记（重载过，
    // 快照已失）→ 不出应用按钮、只留说明——旧补丁对已前进的状态重放不安全（delta 会二次叠加）。
    const sess = entry ? ((peekNoteOpts(convoStreamKey, entry) || {}).diagApplied || null) : null;
    if (!sess && entry && isRecordApplied(convoStreamKey, entry)) {
        status.textContent = '此前已应用过此补丁，应用按钮已收起（重载后撤销不可用）。需要再修请重新诊断。';
        bar.appendChild(status);
        assistantEl.querySelector('.so-bubble').appendChild(bar);
        scrollToBottom();
        return;
    }
    bar.appendChild(btn);
    bar.appendChild(status);
    assistantEl.querySelector('.so-bubble').appendChild(bar);
    scrollToBottom();

    let snapshot = null;
    let applied = null;   // 这次应用写下的那一份（撤销侧的漂移比较锚）
    let wb = null;        // 实际写进正文的那段（Task 6：撤销 / 重新应用时据此精确同步；没开注入 → 恒 null）
    let dead = false;     // 写成了却拿不到可回退的靶子 → 按钮就地作废（见应用分支）
    if (sess) {
        // 换房重画重生：快照从注册表取回，按钮直接是「撤销」——与 1.28.0 前留在原位的手感一致。
        snapshot = sess.snapshot;
        applied = sess.applied || null;
        wb = sess.wb || null;   // 老形状的负载没有这一格 → null，撤销退化成「只回滚变量」（= 接上之前的行为）
        btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销';
        status.textContent = '已应用 —— 状态已更新。';
    }
    btn.addEventListener('click', async () => {
        status.classList.remove('so-hint-error');
        if (snapshot) {
            // currently applied -> undo
            btn.disabled = true;
            // 漂移守卫（Task 5，审计簇 B）：undoFix 是【整份互换】（replaceMvuData 整份写前快照），
            // 这次应用之后发生过的一切（新回复写的变量 / 别的应用 / 修改器）都会被这一下盖掉，而按钮上
            // 只写着「撤销」。点下去之前问一句——不拦，只说实话。取不到现值 / 没有比较锚（旧会话登记的
            // 负载只有 snapshot）→ 不问，照旧行为走。
            let live = null;
            try { const Mvu = await getMvu(); live = Mvu && typeof Mvu.getMvuData === 'function' ? Mvu.getMvuData(mvuMsgOpts()) : null; }
            catch (e) { live = null; }
            if (diagUndoDrifted(live, applied)) {
                const okGo = await uiConfirm('状态在这之后变过，撤销会把后来的变化也回退。确定？');
                if (!okGo) { status.textContent = '已取消。'; btn.disabled = false; return; }
            }
            status.textContent = '正在还原…';
            try {
                await undoFix(snapshot);
                await removeDiagWriteBack(wb);   // 连正文里那段一起摘掉，否则「重新处理变量」会把它算回来
                snapshot = null;
                applied = null;
                // wb【有意保留】：与 addNoteUndoControls 同款对称——重新应用时把同一段放回去。
                if (entry) { dropNoteOpts(convoStreamKey, entry); unmarkRecordApplied(convoStreamKey, entry); }
                btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将修复应用到状态';
                // Task 7：还原也是一次 MVU 写入，落点同样是最末非系统楼——落在用户楼上时同样看不见。
                const n = diagUserFloorNotice();
                status.textContent = '已还原到之前的状态。' + (n ? '\n' + n : '');
            } catch (e) {
                status.textContent = '还原失败：' + (e?.message || e);
                status.classList.add('so-hint-error');
            }
            btn.disabled = false;
            return;
        }
        btn.disabled = true;
        // 陈旧卡守卫（Task 5，审计簇 F）：这张卡片的补丁是按【出卡当时】那份状态算的，而卡片会在侧聊里
        // 躺很久（跟着记录跨重载）。等世界又前进过几回合再点「应用」，等于把后来的变化改回去。印章在 =
        // 先自查一次；不符就问一句——不拦，只说实话。
        const st = entry && entry.diagStamp;
        let expectStatKey;
        // 现读不到状态（没装 MVU / 读失败）→ 不问也不钉指纹：读不到就证不了任何事，绝不新造一种打扰
        // （真没 MVU 时 applyFix 自己会说「未检测到 MVU」，那句才是用户要看的）。
        const liveStat = (st && st.statKey) ? await getMvuStatData() : null;
        if (st && st.statKey && liveStat != null) {
            const liveKey = diagStatKey(liveStat);
            if (diagStampDrifted(st, liveKey, chatIdentityKey())) {
                const okGo = await uiConfirm('状态在这之后变过，应用可能覆盖后来的变化。确定？');
                if (!okGo) { status.textContent = '已取消。'; btn.disabled = false; return; }
                // 用户明确压过了这道闸 → 【不】再把指纹交给 applyFix：那会在里面二次拦截，表现成
                // 「点了确定还是不写」。他知道自己在做什么，这是他的决定。
            } else {
                // 印章相符 → 把刚读到的这一份当指纹交给 applyFix，堵住「自查完到真写入之间」的空档
                // （TOCTOU：这中间还隔着弹窗 / await，世界照样能动）。
                expectStatKey = st.statKey;
            }
        }
        status.textContent = '正在应用…';
        try {
            // applyFix 回 { snapshot, applied, report }（null = 一个字都没写，原因已由 applyFix 写在
            // status 上）。判据是 r 而不是 r.snapshot：读不到写入【前】的状态时 snapshot 会是 null，但
            // 那一份【确实写进去了】——按 snapshot 判会让界面停在「正在应用…」，等于对用户撒谎。
            // 部分生效同样要如实说出来，别一律报「已应用」。
            const r = await applyFix(patchBlock, status, expectStatKey, replyText);
            snapshot = r ? r.snapshot : null;
            applied = r ? (r.applied || null) : null;
            if (r) {
                // 正文注入（Task 6，审计簇 I）：与自动路同一味药——把这次修复的【实际改动】折成绝对值补丁，
                // 插进目标回复【已有的】更新区块内部，让卡片的「重新处理变量」重放正文时也落到修复后的结果
                // （不插 = 用户一点重放，刚修好的值就被原样冲回去）。折算 / 自检 / 幂等 / 陈旧守卫全复用
                // auto 的三件套，绝不另写一份。整段包在 try 里：注入是【附加】动作，出任何岔子都不许把一次
                // 成功的应用报成失败——变量已经写进去了，那才是用户要的东西。
                try {
                    if (wb) {
                        // 撤销之后的「重新应用」：撤销时摘掉的那段放回去（与 addNoteUndoControls 同序同理），
                        // 否则重新应用完再点「重新处理变量」又会丢，正是本功能要根治的那个循环。
                        // 【同一条最末楼不变量，另一道门】撤销【有意】留着 wb，于是有这条路：撤销 → 主聊天
                        // 又落了一楼 → 重新应用。restoreDiagWriteBack 只校验「那段在不在正文里」，不看楼位；
                        // Task 5 的 diagStamp 漂移弹窗管的是【状态】陈旧、不是楼位，还能被用户压过（新楼没碰
                        // 这份 stat 时更是根本不弹）。放回去 = 又把绝对值补丁写进一个不再最后重放的区块，
                        // 正是本任务刚在「首次应用」那道门上堵住的同一个缺陷。故同样处理：楼位不符就跳过，
                        // 变量的重新应用照常成功、照常报成功。同样【不】改钉最新那楼。
                        // ⚠ 自动路的 addNoteUndoControls 不需要这道门：它的 wb.idx 钉的是【刚刚处理完】的那条
                        //   回复，跑完就在眼前；能跨着新楼躺很久的只有手动卡片。别为了「统一」把这道门删掉。
                        if (getLatestAiMessage().idx === wb.idx) await restoreDiagWriteBack(wb);
                    } else if (ENABLE_DIAG_BODY_INJECT && getSettings().diagInjectBody) {
                        // 靶子由诊断定稿时钉进会话注册表（generateReply）。重载后没有 → 不注入，行为与今天相同。
                        const tgt = entry ? ((peekNoteOpts(convoStreamKey, entry) || {}).diagTarget || null) : null;
                        // 【最末楼不变量】折出来的是绝对值补丁，只有落在「重新处理变量」最后重放的那个区块里
                        // 才算数。自动路天然满足（它当场就跑，钉住的就是最新那楼）；手动卡却能在侧聊里躺很久，
                        // 而 Task 5 的漂移弹窗还【明确允许】用户在新回复落地之后照样应用。此时靶子已经不是
                        // 最末楼：expectText 拦不住它（那一楼的正文确实没变），可补丁里的绝对值已经含进了后
                        // 来那楼的贡献 —— 写进去等于在历史楼层里记下一份从未成立过的数值，而最末楼的重放照样
                        // 会把修好的值冲回去。故：靶子不再是最末楼 → 【整段跳过】注入（变量修正照常生效）。
                        // 有意【不】改钉最新那楼：那份正文是这次诊断从没读过的东西，往里写更糟。
                        if (tgt && getLatestAiMessage().idx === tgt.aiIdx) {
                            const payload = await injectDiagPatchIntoMessage(tgt.aiIdx, canonicalizeDiagOps(r.snapshot, await getMvu()), tgt.aiText);
                            if (payload) wb = { idx: tgt.aiIdx, text: payload, mode: 'inject' };
                        }
                    }
                } catch (e) {
                    console.warn('[Story Oracle] 诊断修正写进正文失败（变量修正照常生效）：', e);
                }
                if (entry) {
                    // 已应用状态（1.33.2）：登记会话快照（换房重画以撤销态重生）+ 落持久标记（重载后只留说明）。
                    // 快照为空 = 没有可回退的靶子 → 只落标记、【不】登记会话状态，否则重画会长出一颗按下去
                    // 什么都回不去的「撤销」（undoFix(null) 会把整份状态换成 null）。同理这颗按钮就地作废。
                    if (snapshot) registerNoteOpts(convoStreamKey, entry, Object.assign({}, peekNoteOpts(convoStreamKey, entry) || {}, { diagApplied: { snapshot, applied, wb } }));
                    markRecordApplied(convoStreamKey, entry);
                }
                if (snapshot) btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销';
                else dead = true;
                // Task 7（审计簇 D）：落点是用户自己那一楼时，值写对了、状态栏却要等下一条 AI 回复才
                // 显示得出来——不说这句，用户只会认为这次修复没生效。现算（见 diagUserFloorNotice 头注）。
                const n = diagUserFloorNotice();
                status.textContent = ((r.report && r.report.applied < r.report.total)
                    ? `已应用（${r.report.total} 条指令中 ${r.report.applied} 条生效）。` + diagReportLines(r.report)
                    : '已应用 —— 状态已更新。') + repairDiagNote(r.repair) + diagSchemaDryLines(r.schemaDry) + (n ? '\n' + n : '');
            }
        } catch (e) {
            status.textContent = '应用失败：' + (e?.message || e);
            status.classList.add('so-hint-error');
        }
        btn.disabled = dead;
    });
}

// 校正卡的「应用到回复」按钮条（仿 addApplyControls）。应用 = 把校正稿（接回原文机制块后）作为新
// swipe 写入目标消息；原文留在左滑。Phase 1 只做应用（撤销 = 左滑回 swipe 0）。
// ✨ Phase 4：校正「应用」被陈旧守卫拦下时给手动卡片 status span 的人话文案（P-CORRUPT 切聊天 / 内容变更 / 换 swipe / 目标消失）。
function staleMsg(reason) {
    if (reason === 'chatSwitched') return '聊天已切换，未把校正写入这条回复（避免写到别的对话）。';
    if (reason === 'contentChanged') return '这条回复已发生变化，未应用（避免覆盖新内容）。请重新校正。';
    if (reason === 'swipeChanged') return '这条回复已切到别的 swipe，未应用。请切回后重新校正。';
    return '目标回复已不在了，未应用。';   // gone（含未知原因兜底）
}

// finalOverride（✨ 分段校正 1.18.0）：非空 = 「应用」写入这份【已 splice 回原位的整条】，跳过整稿截断复检
// （逐段已各自查过；拼接稿的「断句 + 偏短」启发式不适用）；陈旧守卫照跑。空 = 老行为（composeFixedReply +
// wrapContentScope），既有调用点传 7 参 → undefined → 逐字节不变。
export function addFixApplyControls(assistantEl, parsed, originalReply, targetIdx, keepSections, scope, captured, finalOverride, opts = {}, dependencies) {
    const targetStale = dependencies?.fixTargetStale || fixTargetStale;
    const currentSnapshot = dependencies?.fixCurrentSnapshot || fixCurrentSnapshot;
    const outputTruncated = dependencies?.fixOutputTruncated || fixOutputTruncated;
    const applyAsSwipe = dependencies?.applyFixAsSwipe || applyFixAsSwipe;
    const staleMessage = dependencies?.staleMsg || staleMsg;
    const nearCopyNote = dependencies?.fixNearCopyNote || fixNearCopyNote;
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 应用到回复';
    // 「看改动」：原文（去机制块，prose↔prose）→ 校正稿的内联差异卡，懒构建一次后切 hidden 复用。
    const diffBtn = document.createElement('button');
    diffBtn.className = 'so-apply-btn';
    diffBtn.innerHTML = '<i class="fa-solid fa-eye"></i> 看改动';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    bar.appendChild(btn);
    bar.appendChild(diffBtn);
    bar.appendChild(status);
    const bubble = assistantEl.querySelector('.so-bubble');
    bubble.appendChild(bar);
    // 近抄警示（Tier 0 ①，Prince 定案：手动只【警示】、不拦应用）：稿子与原文几乎相同时如实告知——高上下文
    // DeepSeek 的「抄原文不改」此前以一枚正常「应用」按钮示人（fixNoOp 只抓逐字相同）。警示是加分项、包 try 不阻断。
    // 已应用态重挂（1.33.2）时不再出警示——稿子已写入，警示徒增噪音。
    if (!opts.applied) {
        try {
            const ncBefore = (captured && captured.prose) || stripMechanismBlocks(String(originalReply || ''));
            const ncNote = nearCopyNote(ncBefore, (parsed && parsed.fixed) || '');
            if (ncNote) {
                const warn = document.createElement('div');
                warn.className = 'so-fix-nearcopy-warn';
                warn.textContent = ncNote;
                bubble.insertBefore(warn, bar);
            }
        } catch (e) { /* 警示失败不影响应用流程 */ }
    }
    scrollToBottom();

    let diffCard = null;
    diffBtn.addEventListener('click', () => {
        if (!diffCard) {
            // 看改动 = 原文 ↔【实际会应用的结果】。after 用 composeFixedReply（把保留区块 + 机制块接回原位）而非
            // 裸 parsed.fixed——否则「保留区块」在 after 里是被抹掉的占位标记，会被【误标成大段删除】（用户报的
            // 「<branches> 放进保留区还是被删」其实是这个 diff 假象：块并没送模型、应用后也在，只是看改动显示错了）。
            // 两侧都 stripMechanismBlocks，让 <UpdateVariable> 不在差异里刷屏；真正被删的【未保留】块仍会如实标红。
            const appliedPreview = stripMechanismBlocks(composeFixedReply(parsed.fixed, originalReply, keepSections));
            diffCard = renderDiffCard(stripMechanismBlocks(String(originalReply || '')), appliedPreview);
            bubble.appendChild(diffCard);
        } else {
            diffCard.hidden = !diffCard.hidden;
        }
        scrollToBottom();
    });

    let applied = false;
    if (opts.applied) {
        // 已应用状态（1.33.2）：会话内应用过、换房重画重生——按钮以已应用态出现（防止再点出重复
        // swipe），「看改动」照常可用（材料都在）。
        applied = true;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-check"></i> 已应用（左滑看原文）';
        status.textContent = '已作为新 swipe 写入这条回复。';
    }
    btn.addEventListener('click', async () => {
        if (applied) return;
        status.classList.remove('so-hint-error');
        btn.disabled = true;
        status.textContent = '正在应用…';
        try {
            // P-CORRUPT（主要面 = 延迟点击「应用」）：写入前再核对捕获快照。这段时间里可能切了聊天、划了 swipe、
            // 或编辑了这条回复——失效则不写、给人话原因、把按钮放回去让用户重新校正（绝不写到别的对话 / 覆盖新内容）。
            const st = targetStale(captured, currentSnapshot(targetIdx));
            if (st.stale) {
                status.textContent = staleMessage(st.reason);
                status.classList.add('so-hint-error');
                btn.disabled = false;
                return;
            }
            // P-TRUNC 廉价复检：成品（parsed.fixed）像是半句且明显短于原文 → 不写入（半句稿会腰斩回复）。
            // 分段校正（finalOverride）已逐段查过截断，整稿复检跳过（拼接稿的「断句 + 偏短」启发式不适用）。
            if (finalOverride == null && outputTruncated(parsed.fixed, undefined, captured && captured.prose).truncated) {
                status.textContent = '校正稿似乎被截断了，未应用。请点 ↻ 重试或调大「最大 token 数」后重新校正。';
                status.classList.add('so-hint-error');
                btn.disabled = false;
                return;
            }
            const finalText = (finalOverride != null)
                ? finalOverride   // ✨ 分段校正：已 splice 回原位的整条（守卫逐字、修好的段进原槽）
                : wrapContentScope(scope, composeFixedReply(parsed.fixed, originalReply, keepSections));   // ✨ 作用域：校正稿回插信封原位（inactive 时为无操作）
            const ok = await applyAsSwipe(targetIdx, finalText);
            if (ok) {
                applied = true;
                if (opts.entry) {
                    // 已应用状态（1.33.2）：给注册表里的材料打 applied 旗标——换房重画以已应用态重生，
                    // 防止重挂出崭新按钮、再点写出第二条重复 swipe。
                    const cur = peekNoteOpts(convoStreamKey, opts.entry);
                    if (cur && cur.fixApply) cur.fixApply.applied = true;
                }
                btn.innerHTML = '<i class="fa-solid fa-check"></i> 已应用（左滑看原文）';
                status.textContent = '已作为新 swipe 写入这条回复。';
            } else {
                status.textContent = '应用失败：没找到目标消息或保存失败。';
                status.classList.add('so-hint-error');
                btn.disabled = false;
            }
        } catch (e) {
            status.textContent = '应用失败：' + (e?.message || e);
            status.classList.add('so-hint-error');
            btn.disabled = false;
        }
    });
}

// Apply / Undo bar appended to a lorebook reply that contains a <LorebookEdit>
// block. Mirrors addApplyControls, but writes through saveWorldInfo and snapshots
// every touched book for a one-click revert.
export function addLorebookApplyControls(assistantEl, parsed, entry) {
    const ops = (parsed && parsed.ops) || [];
    const errors = (parsed && parsed.errors) || [];
    const bubble = assistantEl.querySelector('.so-bubble');

    const bar = document.createElement('div');
    bar.className = 'so-apply-bar';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将改动应用到世界书';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    // 已应用状态（1.33.2）：会话内应用过（注册表有快照+结果）→ 撤销态重生；只剩持久标记（重载过，
    // 快照已失）→ 不出应用按钮、只留说明——重放旧书快照会回滚整本书；再点应用则 create 类操作会出重复条目。
    const sess = entry ? ((peekNoteOpts(convoStreamKey, entry) || {}).lbApplied || null) : null;
    if (!sess && entry && isRecordApplied(convoStreamKey, entry)) {
        status.textContent = '此前已应用过这批改动，应用按钮已收起（重载后撤销不可用）。需要再次应用或调整，请让我重新出一版改动。';
        bar.appendChild(status);
        bubble.appendChild(bar);
        scrollToBottom();
        return;
    }
    bar.appendChild(btn);
    bar.appendChild(status);
    bubble.appendChild(bar);

    // B5 应用前预检行（fire-and-fill 填入，见函数末尾）。放在结果区之前、按钮之下。
    const previewEl = document.createElement('div');
    previewEl.className = 'so-lb-preview';
    bubble.appendChild(previewEl);

    // Per-op outcomes, rendered after Apply.
    const resultsEl = document.createElement('div');
    resultsEl.className = 'so-lb-results';
    bubble.appendChild(resultsEl);

    // Surface any blocks we couldn't parse — never silently drop them.
    if (errors.length) {
        const e = document.createElement('div');
        e.className = 'so-lb-parse-errors so-hint-error';
        e.textContent = `另有 ${errors.length} 处改动无法解析（已忽略）：` + errors.map((x) => x.error).join('；');
        bubble.appendChild(e);
    }

    if (!ops.length) {
        btn.disabled = true;
        status.classList.add('so-hint-error');
        status.textContent = errors.length
            ? '这次的改动没能解析出来。让我「把刚才的改动严格按格式重发一次」即可，或把改动拆小一点再试。'
            : '没有检测到可应用的改动。';
        scrollToBottom();
        return;
    }

    status.textContent = `待应用：${lbSummaryOf(ops)}`;
    scrollToBottom();

    const renderResults = (results) => {
        resultsEl.innerHTML = '';
        for (const r of results) {
            const line = document.createElement('div');
            line.className = 'so-lb-result ' + (r.ok ? 'so-lb-ok' : 'so-lb-skip');
            line.textContent = lbFormatApplyLine(r);   // F3c 共用格式化（✓ 带尺寸回声 / ⤫ 跳过原因）
            resultsEl.appendChild(line);
            // B4/B6/改锚/T2 附注：同名转编辑 / 无键自动常驻 / 已改锚 / 常驻目标等，落地结果也一并说明。
            if (r.note) { const n = document.createElement('div'); n.className = 'so-lb-note'; n.textContent = '↳ ' + r.note; resultsEl.appendChild(n); }
            if (r.warn) { const w = document.createElement('div'); w.className = 'so-lb-warn-note'; w.textContent = '⚠ ' + r.warn; resultsEl.appendChild(w); }
        }
    };

    let snapshots = null;
    if (sess) {
        // 换房重画重生：快照、逐条结果、汇总都从注册表取回，按钮直接是「撤销」——1.28.0 前的手感。
        snapshots = sess.snapshots;
        renderResults(sess.results);
        btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销';
        status.textContent = `已应用：${sess.summary}。世界书已保存。`;
    }
    btn.addEventListener('click', async () => {
        status.classList.remove('so-hint-error');
        if (snapshots) {
            // currently applied -> undo
            btn.disabled = true;
            status.textContent = '正在还原…';
            try {
                await undoLorebookOps(snapshots);
                snapshots = null;
                if (entry) { dropNoteOpts(convoStreamKey, entry); unmarkRecordApplied(convoStreamKey, entry); }
                resultsEl.innerHTML = '';
                btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将改动应用到世界书';
                status.textContent = `已还原。待应用：${lbSummaryOf(ops)}`;
            } catch (e) {
                status.textContent = '还原失败：' + (e?.message || e);
                status.classList.add('so-hint-error');
            }
            btn.disabled = false;
            return;
        }
        btn.disabled = true;
        status.textContent = '正在应用…';
        previewEl.innerHTML = '';   // 预检让位给真结果（点应用即以实际书为准）
        try {
            const res = await applyLorebookOps(ops);
            renderResults(res.results);
            recordLbApplySnapshot(res.results);   // F4：落最近一次应用结果快照（下次发送在〔世界书快照〕里回显版本号 + 结果）
            if (res.applied > 0) {
                snapshots = res.snapshots;
                if (entry) {
                    // 已应用状态（1.33.2）：登记会话状态（换房重画以撤销态重生）+ 落持久标记（重载后只留说明）。
                    registerNoteOpts(convoStreamKey, entry, { lbApplied: { snapshots: res.snapshots, results: res.results, summary: res.summary } });
                    markRecordApplied(convoStreamKey, entry);
                }
                btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销';
                status.textContent = `已应用：${res.summary}。世界书已保存。`;
            } else {
                snapshots = null;
                status.textContent = '没有任何改动被应用（全部跳过，见下方原因）。';
                status.classList.add('so-hint-error');
            }
        } catch (e) {
            status.textContent = '应用失败：' + (e?.message || e);
            status.classList.add('so-hint-error');
        }
        btn.disabled = false;
        scrollToBottom();
    });

    // B5 应用前预检（fire-and-fill）：只读跑一遍 dry-run，逐条把每个 op 会怎样落地摆到按钮下方——
    // 通过行常态、未通过行灰显 + 内联原因、改锚 / 同名转编辑 / 无键常驻 / 常驻目标各带附注。
    // 异步、绝不阻塞消息渲染；已应用态（sess）不预检；预检回来前已点应用则不覆盖真结果。
    if (!sess && ops.length) {
        (async () => {
            let verdicts = null;
            try { verdicts = await lbDryRunOps(ops); } catch (e) { verdicts = null; }
            if (!verdicts || snapshots) return;   // 模块不可用 / 预检返回前已应用 → 不渲染
            previewEl.innerHTML = '';
            const head = document.createElement('div');
            head.className = 'so-lb-preview-head';
            head.textContent = '应用前预检（点「应用」时以当前世界书为准）：';
            previewEl.appendChild(head);
            for (const v of verdicts) {
                const row = lbVerdictRow(v);
                const el = document.createElement('div');
                el.className = 'so-lb-prow ' + row.cls;
                const main = document.createElement('div');
                main.className = 'so-lb-prow-main';
                main.textContent = row.line;
                el.appendChild(main);
                if (row.note) { const n = document.createElement('div'); n.className = 'so-lb-note'; n.textContent = '↳ ' + row.note; el.appendChild(n); }
                if (row.warn) { const w = document.createElement('div'); w.className = 'so-lb-warn-note'; w.textContent = '⚠ ' + row.warn; el.appendChild(w); }
                previewEl.appendChild(el);
            }
            scrollToBottom();
        })();
    }
}


// 纯函数（Tier 0 ②，1.25.0，原为校正而写）：定位标签【开】的位置。模型在思考段里【提到】字面标签会劫持
// 首次出现锚定（nval 实证：评分工件——把 think 尾文当成稿）。真区块按输出格式独占一行；规则：行首出现取【最后
// 一个】，无行首出现再取最后一次任意位置（维持旧容错下限）。tagName 参数化，现由人格扩写（parsePersonaFleshReply）使用。可单测。
export function locateTagOpen(src, tagName) {
    const s = String(src == null ? '' : src);
    const re = new RegExp('<' + tagName + '\\b[^>]*>', 'gi');
    let m, last = null, lastLineStart = null;
    while ((m = re.exec(s)) !== null) {
        const nl = s.lastIndexOf('\n', m.index - 1);
        if (/^[ \t]*$/.test(s.slice(nl + 1, m.index))) lastLineStart = { index: m.index, length: m[0].length };
        last = { index: m.index, length: m[0].length };
    }
    return lastLineStart || last;
}

export function parseFixedReply(text) {
    const src = String(text || '');
    const open = locateTagOpen(src, 'FixedReply');
    if (!open) return null;
    const rest = src.slice(open.index + open.length);
    const close = rest.match(/<\/FixedReply\s*>/i);
    const fixed = (close ? rest.slice(0, close.index) : rest).trim();
    if (!fixed) return null;
    let problems = '';
    const po = src.match(/<problems\b[^>]*>/i);
    if (po) {
        const after = src.slice(po.index + po[0].length);
        const pc = after.match(/<\/problems\s*>/i);
        if (pc) problems = after.slice(0, pc.index).trim();
        else { const fr = after.match(/<FixedReply\b[^>]*>/i); problems = (fr ? after.slice(0, fr.index) : after).trim(); }
    }
    return { fixed, problems };
}

// 纯函数：手动校正的宽容解析（recovery + 截断守卫）。仅手动模式用；自动仍用严格 parseFixedReply。
// 恢复顺序（先命中先返回）：① 有 <FixedReply> → parseFixedReply（干净两端定界，向后兼容/容忍缺闭合）；
// ② 无可用 <FixedReply> 但有【闭合的】<fix_think>…</fix_think> → </fix_think> 之后的正文；③ 连 <fix_think>
// 都没有 → 整条回复即答案；④ <fix_think> 开了没闭 + 无 <FixedReply> → 判【截断】。剥思维链标签 + 抠掉残留
// 结构标记（<fix_think>/<FixedReply>），避免它们混进被应用的正文。<fix_think> 标签名须与 FIX_SYSTEM_PROMPT_MANUAL 同步。可单测。
function parseManualFix(text) {
    const src = String(text || '');
    const strip = (s) => stripReasoningTags(s)
        .replace(/<\/?fix_think\b[^>]*>/gi, '')
        .replace(/<\/?FixedReply\b[^>]*>/gi, '')
        .trim();
    // ① 显式 <FixedReply>（干净路径，向后兼容）
    const strict = parseFixedReply(src);
    if (strict && strict.fixed) return { fixed: strict.fixed };
    // ②/④ 看 <fix_think>
    const open = src.match(/<fix_think\b[^>]*>/i);
    if (open) {
        const rest = src.slice(open.index + open[0].length);
        const close = rest.match(/<\/fix_think\s*>/i);
        if (!close) return { truncated: true };                 // ④ 开了没闭 + 无 FixedReply → 截断
        const after = strip(rest.slice(close.index + close[0].length));
        return after ? { fixed: after } : { truncated: true };  // ② 闭合后的正文；空 → 也当截断
    }
    // ③ 无 fix_think、无 FixedReply → 整条即答案
    const whole = strip(src);
    return whole ? { fixed: whole } : null;
}

// 纯函数：按模式选解析器 + 归一成状态。手动 → parseManualFix（宽容 + 截断守卫）；其余（自动）→ parseFixedReply（严格）。
// 返回 { status, fixed, problems }：status ∈ 'ok'|'truncated'|'unparseable'。renderFixCard 据 status 分派 DOM。可单测。
export function parseFixReply(text, mode) {
    if (mode === 'manual') {
        const r = parseManualFix(text);
        if (!r) return { status: 'unparseable', fixed: '', problems: '' };
        if (r.truncated) return { status: 'truncated', fixed: '', problems: '' };
        return { status: 'ok', fixed: r.fixed, problems: '' };
    }
    const parsed = parseFixedReply(text);
    if (!parsed) return { status: 'unparseable', fixed: '', problems: '' };
    return { status: 'ok', fixed: parsed.fixed, problems: parsed.problems };
}