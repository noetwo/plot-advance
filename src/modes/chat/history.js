import { buildConvoExportFileName, buildConvoExportMd, convoExportAllowed, convoForPrompt, convoMetaKeyFor, getSummary, parseConvoExportMd, persistConvo, saveChatMetadata, soExportTimeParts } from '../../core/chat-metadata.js';
import { getCtx, uiConfirm } from '../../core/settings.js';

import { addNoteMessage, loadConvoForChat, registerNoteOpts } from '../advisor/cards.js';
import { getChatMetadataSafe } from '../advisor/metadata.js';
import { chatIdentityKey } from './send.js';
import { fixFingerprint } from '../fix/capture.js';
import { ENABLE_MODE_ROOMS, MODULE } from '../../prompts/builtins.js';
import { addFixApplyControls } from '../../ui/messages.js';
import { currentOracleMode } from '../../ui/mode-shell.js';
import { convo, convoStreamKey, isGenerating, nextCid } from '../../core/runtime-state.js';
import { setSoConvoImportInputEl, soConvoImportInputEl } from './state.js';
import { decrementSoBulkRenderDepth, incrementSoBulkRenderDepth, inputEl, messagesEl, soBulkRenderDepth, win } from '../../ui/state.js';

/* ------------------------------------------------------------------ *
 * 持久「已应用」标记（1.33.2）。applied/撤销 一直只活在按钮闭包里——1.33.1 重挂动作卡后，
 * 以前应用过的世界书/诊断记录重画后又顶着崭新「应用」按钮出现（Prince 报告）。撤销快照只在
 * 内存（重放旧快照会把整本书/状态回滚到旧拷贝 = 1.31.1 同族危险，绝不落盘），所以跨重载能
 * 诚实提供的只有一个事实标记：这条记录应用过。落盘 chat 元数据 `MODULE_applied`：
 * 房间::记录id → fixFingerprint(content)（指纹校验挡 id 撞旧记录，同 1.31.1 内容守卫思路）。
 * 应用成功落标记、撤销去标记；重画时【有标记而无会话状态】= 重载过 → 不出应用按钮、只留
 * 「此前已应用过」说明（Prince 定案 2026-07-16）。
 * ------------------------------------------------------------------ */
const APPLIED_META_KEY = MODULE + '_applied';
const APPLIED_MARKS_MAX = 200;   // 元数据保险：超长聊天只留最近 200 条标记（先进先出）
function appliedMarksMap(create) {
    const md = getChatMetadataSafe();
    if (!md) return null;
    if ((!md[APPLIED_META_KEY] || typeof md[APPLIED_META_KEY] !== 'object') && create) md[APPLIED_META_KEY] = {};
    const map = md[APPLIED_META_KEY];
    return (map && typeof map === 'object') ? map : null;
}
export function markRecordApplied(roomKey, entry) {
    if (!entry) return;
    const map = appliedMarksMap(true);
    if (!map) return;
    map[`${roomKey}::${entry.id}`] = fixFingerprint(entry.content);
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length - APPLIED_MARKS_MAX; i++) delete map[keys[i]];
    saveChatMetadata();
}
export function unmarkRecordApplied(roomKey, entry) {
    if (!entry) return;
    const map = appliedMarksMap(false);
    if (!map || !((`${roomKey}::${entry.id}`) in map)) return;
    delete map[`${roomKey}::${entry.id}`];
    saveChatMetadata();
}
export function isRecordApplied(roomKey, entry) {
    if (!entry) return false;
    const map = appliedMarksMap(false);
    return !!map && map[`${roomKey}::${entry.id}`] === fixFingerprint(entry.content);
}

// 校正「应用」材料登记 / 重挂（1.33.1 掉格式修复）。「应用到回复」不是从回复文本可再导出的：
// 它要把捕获时抠走的机制块/保留区接回（composeFixedReply）、写到捕获时的目标楼层、过陈旧守卫——
// 这些是调用当时的内存材料（fixOriginalReply/fixTargetIdx/fixExtraKeep/fixScope/fixCaptured 都是
// 单槽变量，下一次校正即被覆盖）。三个出卡点在挂应用控件前先按 房间::记录id 登记一份；换房重画时
// 仅【最新一条 AI 回复】凭 id+内容取回重挂（Prince 定案 2026-07-16）。材料从不落盘：重载后注册表
// 为空 = 记录只读（与 1.31.1 同一契约）。noteText = 卡下「发现并修正 / 整体校正…」说明的原文。
export function registerFixApply(entry, parsed, originalReply, targetIdx, keepSections, scope, captured, finalOverride, noteText) {
    registerNoteOpts(convoStreamKey, entry, {
        fixApply: { parsed, originalReply, targetIdx, keepSections, scope, captured, finalOverride, noteText: String(noteText || '') },
    });
}
export function rehangFixApply(assistantEl, fa, entry) {
    if (fa.noteText) {
        const note = document.createElement('div');
        note.className = 'so-fix-changes';
        note.textContent = fa.noteText;
        assistantEl.querySelector('.so-bubble')?.appendChild(note);
    }
    // 1.33.2：applied 旗标透传——应用过的稿子以「✓ 已应用」态重生（防重复 swipe）；entry 让重挂后
    // 首次点「应用」也能给注册表打旗标。
    addFixApplyControls(assistantEl, fa.parsed, fa.originalReply, fa.targetIdx, fa.keepSections, fa.scope, fa.captured, fa.finalOverride, { entry, applied: !!fa.applied });
}

// 后台记录写入指定房间（推广自 appendNoteToMain）。目标房间正可见 → 推 convo + 画气泡；否则直接写该房间元数据、
// 不上屏（记录不是警报，交互侧另有 toast）。ENABLE_MODE_ROOMS 关 → 一律回主流（= 旧 appendNoteToMain 行为）。
// 两条分支都先把按钮材料登记进注册表——首访 / 重画该房间时 loadConvoForChat 凭它重挂按钮。
export function appendNoteToRoom(roomKey, entry, opts) {
    const key = ENABLE_MODE_ROOMS ? (roomKey || 'main') : 'main';
    registerNoteOpts(key, entry, opts);
    if (key === convoStreamKey) {
        convo.push(entry);
        persistConvo();
        if (messagesEl) entry._el = addNoteMessage(entry, opts);
        return;
    }
    const md = getChatMetadataSafe();
    if (!md) return;
    const mk = convoMetaKeyFor(key);
    const arr = Array.isArray(md[mk]) ? md[mk].slice() : [];
    arr.push({ id: entry.id, role: 'note', content: entry.content });
    md[mk] = arr;
    saveChatMetadata();
}


// 📥 导出对话（1.60.0 用户功能请求；1.61.0 起入口 = AI 气泡行上的 📥 + 空页入口，⋯ 工具菜单已无此项）
// —— 非纯的那一半，纯核见 buildConvoExportMd 一带。

// 触发浏览器下载一份文本文件（Blob + 临时 <a download>）。零依赖、不落任何服务器。
// 立刻 revoke 对象 URL 在部分浏览器会赶在下载真正开始之前 → 延后一拍再释放。
// 失败不静默：给一条错误提示，别让用户以为已经存好了。
function downloadTextFile(filename, text) {
    try {
        const blob = new Blob([String(text == null ? '' : text)], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* 已释放 */ } }, 4000);
        return true;
    } catch (e) {
        console.error('[Story Oracle] 导出对话失败', e);
        window.toastr && window.toastr.error && window.toastr.error('导出失败——浏览器拒绝了这次下载。', '剧情推进');
        return false;
    }
}

// 当前聊天的显示名（只给导出的文件名 / 抬头用）：群聊取群名，单聊取角色名，都没有就退到聊天文件名。
function soExportChatName() {
    try {
        const ctx = getCtx();
        if (!ctx) return '';
        if (ctx.groupId) {
            const g = (Array.isArray(ctx.groups) ? ctx.groups : []).find((x) => x && String(x.id) === String(ctx.groupId));
            if (g && g.name) return String(g.name);
        }
        return String(ctx.name2 || ctx.chatId || '');
    } catch (e) { return ''; }
}

// AI 气泡行上的 📥 点击：把【当前房间】的侧聊导成 Markdown 文件。点击那一刻现读全局 convo —— 房间由
// setOracleMode / syncConvoStream 换好，所以这里拿到的永远是眼前这一页（参谋房导参谋房、普通房导普通房）。
// 按钮挂在哪条气泡上都一样：这是【整页】操作，不针对被点的那条消息。
export function exportConvo() {
    const mode = currentOracleMode();
    // 不允许导出的模式下气泡按钮本就被扫成隐藏；这里再挡一道（键盘等也可能触发）。⚠ 不静默 return——
    // 「点了什么都没发生」是最难报障的一类 bug，跟空房分支一样给一句话。
    if (!convoExportAllowed(mode)) {
        window.toastr && window.toastr.info && window.toastr.info('导出对话只在普通聊天和剧情参谋里可用。', '剧情推进');
        return;
    }
    const modeLabel = mode === 'advisor' ? '剧情参谋' : '普通聊天';
    const chatName = soExportChatName();
    const t = soExportTimeParts(new Date());
    const md = buildConvoExportMd(convo, { modeLabel, chatName, when: t.when });
    if (!md) {
        window.toastr && window.toastr.info && window.toastr.info('本页还没有对话，先聊两句再导出～', '剧情推进');
        return;
    }
    downloadTextFile(buildConvoExportFileName(modeLabel, chatName, t.stamp), md);
}

/* 📥📤 导出 / 导入入口的显隐 —— 全仓【唯一写者】。1.61.0 起 ⋯ 工具菜单不再设这两项（Prince 定案），
   入口只剩两处：AI 气泡行上那对小按钮（addMessage）＋ 空页时的空态入口（renderEmptyState），
   两处都带 `.so-convio-btn` 类，本函数凭它一扫而过。

   ⚠ 为什么不能「只在建的时候按模式判一次就算」：那等于把正确性押在「切模式必然重画消息区」上，
   而这条【不成立】——换房才重画（syncConvoStream 同键即 `return false`），ENABLE_MODE_ROOMS
   关掉时所有模式共用 'main' 房 → 任何模式切换都不重画，按钮会留在错误的模式里（点了只弹一句
   「不可用」的死按钮）；在不能导出的模式里新发的消息，退回普通聊天后（不重画）也会一直隐着。
   所以：按钮建出来就在，显隐交给这一扫。调用点 = buildWindow 末尾 + setOracleMode。
   空态入口另有 render-time 判定（空态本就每次切模式重画）。
   root 传具体气泡 = 只定它的初值（addMessage 用）；传 null = 扫整个消息区（切模式用）。 */
export function soApplyConvoIoVisual(root) {
    const scope = root || (win && win.querySelector('#so-messages'));
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    const on = convoExportAllowed(currentOracleMode());
    for (const b of scope.querySelectorAll('.so-convio-btn')) b.style.display = on ? '' : 'none';
}

/* ── 📤 导入对话（1.61.0）—— 导出的逆运算。纯核 = parseConvoExportMd（在 buildConvoExportMd 一带）。
   契约：只写【当前房间的侧聊 convo】，绝不碰主聊天 / 世界书 / MVU / 设置。导入进来的就是【真对话轮】
   （与自己聊出来的没有区别）：进 convo → 进元数据 → 之后照常作为历史发给模型（convoForPrompt 只挑
   user/assistant，导入轮天然在内）。当前页非空时先问一声，永远是【追加】、绝不覆盖。 */

   // 隐藏的 <input type="file">：建一次、反复用（每次用前清 value 才能重选同一个文件）

// 把 File 读成文本。现代浏览器有 file.text()；老环境回退 FileReader（顺带给 jsdom 单测留条路）。
function soReadTextFile(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
        try {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result == null ? '' : fr.result));
            fr.onerror = () => reject(fr.error || new Error('read failed'));
            fr.readAsText(file, 'utf-8');
        } catch (e) { reject(e); }
    });
}

// 隐藏文件选择器（仓内此前没有任何文件选择器；ST 核心自己也是这个形状的隐藏 input）。
function soConvoImportInput() {
    if (soConvoImportInputEl && soConvoImportInputEl.isConnected) return soConvoImportInputEl;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.md,.txt,text/markdown';
    inp.id = 'so-convo-import-file';
    inp.style.display = 'none';
    inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        inp.value = '';                 // 立刻清空：否则连着导入同一个文件时 change 不再触发
        if (f) soImportConvoFile(f);
    });
    document.body.appendChild(inp);
    setSoConvoImportInputEl(inp);
    return inp;
}

// 菜单项 / 气泡按钮点击：开文件选择器。真正的活在 soImportConvoFile 里（选文件是异步的）。
export function importConvo() {
    // 与导出同一道模式闸；拦下时不静默（「点了没反应」最难报障）。
    if (!convoExportAllowed(currentOracleMode())) {
        window.toastr && window.toastr.info && window.toastr.info('导入对话只在普通聊天和剧情参谋里可用。', '剧情推进');
        return;
    }
    if (isGenerating) {
        window.toastr && window.toastr.info && window.toastr.info('还有回复正在生成，等它跑完再导入～', '剧情推进');
        return;
    }
    if (!getChatMetadataSafe()) {
        window.toastr && window.toastr.info && window.toastr.info('请先打开一个聊天，导入的对话要存进这个聊天里。', '剧情推进');
        return;
    }
    try { soConvoImportInput().click(); }
    catch (e) {
        console.error('[Story Oracle] 打开文件选择器失败', e);
        window.toastr && window.toastr.error && window.toastr.error('打不开文件选择器。', '剧情推进');
    }
}

// 读文件 → 解析 → （非空则确认）→ 追加到当前房的侧聊。
// ⚠ 两处 await 之间用户完全可能切模式 / 切房 / 切聊天 —— 每次 await 之后都重核一遍（跨聊天守卫，
// 与仓内 chatIdentityKey 同一路数），否则会把一整页对话写进别人的房间。
async function soImportConvoFile(file) {
    const roomAtStart = convoStreamKey;
    const chatAtStart = chatIdentityKey();
    const stillHere = () => convoExportAllowed(currentOracleMode())
        && convoStreamKey === roomAtStart && chatIdentityKey() === chatAtStart;

    let text = '';
    try { text = await soReadTextFile(file); }
    catch (e) {
        console.error('[Story Oracle] 读取导入文件失败', e);
        window.toastr && window.toastr.error && window.toastr.error('读不了这个文件。', '剧情推进');
        return;
    }
    if (!stillHere()) {
        window.toastr && window.toastr.info && window.toastr.info('选文件期间换了模式 / 聊天，本次导入已取消。', '剧情推进');
        return;
    }
    const parsed = parseConvoExportMd(text);
    if (!parsed || !parsed.turns.length) {
        window.toastr && window.toastr.error && window.toastr.error('这不是剧情推进导出的对话文件——一条对话都没读到。', '剧情推进');
        return;
    }
    const have = convoForPrompt(convo).length;
    if (have) {
        const ok = await uiConfirm(`当前页已有 ${have} 条对话：导入的 ${parsed.turns.length} 条会接在后面（不会覆盖）。继续吗？`);
        if (!ok) return;
        if (!stillHere()) {
            window.toastr && window.toastr.info && window.toastr.info('确认期间换了模式 / 聊天，本次导入已取消。', '剧情推进');
            return;
        }
    }
    const n = appendImportedConvoTurns(parsed.turns);
    if (!n) return;
    // 诚实的 N/M（house 惯例，同 fixSegmentReply 的「N/M 段已改」）：解析时切出来却认不出的段
    // （parsed.skipped）＋ 落地时被挡掉的条（角色 / 类型不合法）都要报出来，绝不静默少几条。
    const dropped = (Number(parsed.skipped) || 0) + (parsed.turns.length - n);
    const msg = dropped > 0 ? `已导入 ${n} 条对话（${dropped} 段无法识别、已跳过）。` : `已导入 ${n} 条对话。`;
    window.toastr && window.toastr.success && window.toastr.success(msg, '剧情推进');
}

// 把解析出来的轮次落成【真侧聊条目】并重画。渲染刻意不自己搭气泡：写进 convo + 落盘之后直接调
// loadConvoForChat()，走的就是 F5 / 换房还原走的那条路（addMessage → repaintHtmlForRoom → 动作卡重挂），
// 所以参谋房导进来的 <StoryPlan> 会照常出采纳卡、渲染与重载后一模一样，零重复实现。
function appendImportedConvoTurns(turns) {
    const list = Array.isArray(turns) ? turns : [];
    if (!list.length) return 0;
    let n = 0;
    for (const t of list) {
        if (!t || (t.role !== 'user' && t.role !== 'assistant') || typeof t.content !== 'string') continue;
        convo.push({ id: nextCid(), role: t.role, content: t.content });
        n++;
    }
    if (!n) return 0;
    if (!persistConvo()) {           // 元数据写不进去（没打开聊天）→ 撤回，绝不留下只在屏幕上的假历史
        convo.splice(convo.length - n, n);
        window.toastr && window.toastr.error && window.toastr.error('无法保存到本聊天，导入已撤销。', '剧情推进');
        return 0;
    }
    loadConvoForChat();              // 与重载 / 换房同源的整页重画（末尾自带 scrollToBottom）
    return n;
}

// 打开运行概要编辑器（叠层，仿 openDebug）。
export function openSummary() {
    if (!win) return;
    const ta = win.querySelector('#so-summary-text');
    if (ta) ta.value = getSummary();
    updateSummaryIndicator(ta ? ta.value : getSummary());
    win.querySelector('#so-summary').classList.add('open');
    if (ta) ta.focus();
}

// 把本聊天的运行概要载入文本框 + 刷新字数 / 图标小红点。切换聊天 / 首次载入时调用。
export function refreshSummaryUI() {
    if (!win) return;
    const ta = win.querySelector('#so-summary-text');
    const text = getSummary();
    if (ta && document.activeElement !== ta) ta.value = text;   // 别在用户正打字时覆盖
    updateSummaryIndicator(text);
}

// 概要图标的「有内容」小红点 + 编辑器底部字数。text 传 null 时现读元数据。
export function updateSummaryIndicator(text) {
    if (!win) return;
    const t = String(text == null ? getSummary() : text);
    const btn = win.querySelector('#so-summary-btn');
    if (btn) btn.classList.toggle('so-has-summary', !!t.trim());
    const count = win.querySelector('#so-summary-count');
    if (count) count.textContent = t.trim() ? `${t.length} 字` : '（空——不会注入）';
}

// 流式滚动策略（用户反馈：流式时被一直拽到底、读不了开头）：新回复气泡出现时把它的【顶部】对到可视区顶部，
// 让用户从头读；流式过程中默认【不】跟随，只有当用户自己滚到底部（soFollowStream=true）时才跟随最新输出。

// 1.85.3 批量重画（开窗卡顿调查 2026-09-24）：整页重画（loadConvoForChat / 参谋导入普通聊天讨论）逐条 addMessage 时，
// 每条都 scrollToBottom = 读一次 scrollHeight = 整页强制样式+布局（200 轮 13s → 去掉后 0.6s）。
// soBulkRender(fn) 只包【同步】的批量段：段内 scrollToBottom / scrollBubbleToTop 静默不滚、新气泡不挂入场动画，
// 段尾由调用方照旧滚一次。深度计数 + finally 归零，抛错也不会漏成全局静默；流式回调是异步的，
// 不可能落在同步段内，所以直播路径（发送 / 流式 / 定稿）一律照旧。

export function soBulkRender(fn) {
    incrementSoBulkRenderDepth();
    try { return fn(); } finally { decrementSoBulkRenderDepth(); }
}
export function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
}
export function scrollToBottom() {
    if (!messagesEl) return;   // 窗口还没建好（极早期 / 单测里直接调控件函数）——没有可滚的容器就什么都不做
    if (soBulkRenderDepth > 0) return;   // 1.85.3 批量重画段内不逐条滚（段尾统一滚一次）
    messagesEl.scrollTop = messagesEl.scrollHeight;
}
// 把某条气泡的顶部对到消息区顶部（留 6px），让流式回复从开头开始读。
export function scrollBubbleToTop(el) {
    if (!el) return;
    if (soBulkRenderDepth > 0) return;   // 1.85.3 批量重画段内不滚（段尾的 scrollToBottom 反正会覆盖它）
    const cRect = messagesEl.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    messagesEl.scrollTop = Math.max(0, messagesEl.scrollTop + (eRect.top - cRect.top) - 6);
}
// 输入框自动增高（用户反馈：粘贴大段文字时输入框太小）：高度随内容增长，最多到神谕窗口高度的一半，再内部滚动。
function computeInputHeight(scrollH, winH, minH = 46) {
    const cap = Math.max(minH, Math.round((Number(winH) || 0) * 0.5));
    return Math.max(minH, Math.min(Number(scrollH) || minH, cap));
}
export function autoGrowInput() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    const winH = (win && win.clientHeight) || window.innerHeight || 540;
    inputEl.style.height = computeInputHeight(inputEl.scrollHeight, winH) + 'px';
}