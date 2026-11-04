import { cancelPostReply, refreshLatestMvuBar, refreshMessageBar } from '../../core/post-reply.js';
import { getCtx, getSettings, save, uiConfirm } from '../../core/settings.js';

import { appendNoteToRoom, scrollToBottom } from '../chat/history.js';
import { diagUserFloorNotice, mvuMsgOpts, mvuedPathStr } from './auto.js';
import { diagDoubleBlockNotice, diagSchemaDryLines, diagZeroHeadline, maybeRunSaveHealth, repairDiagNote } from './diagnostics.js';
import { trainerReadRules, trainerSetRule } from './editor.js';
import { buildDiagPatchPayload, diffMvuStat, insertDiagPatchIntoBlock, stripDiagPatchFromText, verifyDiagOps } from './patch.js';
import { addSwipeToMessage, getMvu, stripFixKeepMarks } from './mvu.js';
import { applyFix, diagReportLines, diagUndoDrifted, renderDiffCard, undoFix } from '../fix/algorithms.js';
import { fixScopeNoteText } from '../fix/capture.js';
import { ENABLE_MODE_ROOMS, ENABLE_MVU_TRAINER, ENABLE_SCHEMA_DIAG } from '../../prompts/builtins.js';
import { syncChatBarButton, syncQrButton } from '../../ui/chat-entry.js';
import { centeredWindowBox, currentView } from '../../ui/geometry.js';
import { toggleWindow } from '../../ui/mode-shell.js';
import { nextCid } from '../../core/conversation-store.js';
import { win } from '../../ui/refs.js';
import { getHostGlobal } from '../../st/host.js';
// 取「诊断前快照」与「诊断后现状」的差异 → 绝对值 ops。现取 MVU（autoApplyFix 刚 replaceMvuData 写过）。
// 尽力而为：拿不到任一侧 / 抛错 / 自检不过 → []（调用方据此不注入，行为回到不开时的样子）。
export function canonicalizeDiagOps(snapshot, Mvu) {
    try {
        if (!snapshot || !Mvu || typeof Mvu.getMvuData !== 'function') return [];
        const now = Mvu.getMvuData(mvuMsgOpts());
        if (!now) return [];
        const ops = diffMvuStat(snapshot.stat_data, now.stat_data, '');
        if (!ops.length) return [];
        if (!verifyDiagOps(snapshot.stat_data, now.stat_data, ops)) {
            console.warn('[剧情推进] 诊断修正未写进正文：补丁自检没能精确重放出当前状态（这张卡的变量形状特殊），已跳过；变量修正照常生效。');
            return [];
        }
        return ops;
    } catch (e) {
        console.warn('[剧情推进] 诊断修正折算绝对值补丁失败：', e);
        return [];
    }
}

// 把这次诊断的实际改动插进第 idx 条消息已有的更新区块里。expectText = 诊断当时读到的正文，用作陈旧守卫：
// 调用往返期间用户改了 / 划了 swipe / 别的扩展写过 → 正文已不是我们诊断的那份，直接放弃（绝不写进错的地方）。
// 幂等：先摘掉上一次插进去的那段再插新的（同一条消息重跑诊断不会越堆越多）。
// 与 writeUpdateBlockToMessage 同款收尾：镜像到当前 swipe 槽（校正换过 swipe 时不丢）+ saveChat + 重渲染。
// 返回实际写进正文的那段文本（供撤销时精确摘除）；没写 → ''。
export async function injectDiagPatchIntoMessage(idx, ops, expectText) {
    const ctx = getCtx();
    const m = (ctx.chat || [])[idx];
    if (!m || typeof m.mes !== 'string') return '';
    if (expectText != null && m.mes !== expectText) {
        console.warn('[剧情推进] 诊断修正未写进正文：这条回复在诊断期间被改动过（已跳过，变量修正照常生效）。');
        return '';
    }
    const payload = buildDiagPatchPayload(ops);
    if (!payload) return '';
    const next = insertDiagPatchIntoBlock(stripDiagPatchFromText(m.mes), payload);
    if (next == null) {
        console.warn('[剧情推进] 诊断修正未写进正文：这条回复的更新区块没有完整的闭标签（不另起一块——两个区块会让多数卡的状态栏被折叠面板吞掉）。');
        return '';
    }
    m.mes = next;
    if (Array.isArray(m.swipes) && typeof m.swipes[m.swipe_id] === 'string') m.swipes[m.swipe_id] = m.mes;
    try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
    catch (e) { console.warn('[剧情推进] 诊断修正写进正文后保存失败：', e); }
    refreshMessageBar(idx);
    return payload;
}

// 撤销 / 重新应用时同步正文。wb = { idx, text, mode:'derive'|'inject' }，由写回那一刻登记。
// 内容校验：目标消息里确实有（确实没有）那段才动手 —— 用户改过正文 / 换过聊天就静默放手，绝不误伤。
// 没有 wb（没开注入、或重载后按钮已只读）→ 无操作，行为与今天相同。
export async function removeDiagWriteBack(wb) {
    if (!wb || !wb.text) return;
    const ctx = getCtx();
    const m = (ctx.chat || [])[wb.idx];
    if (!m || typeof m.mes !== 'string') return;
    const withSep = '\n\n' + wb.text;
    if (m.mes.includes(withSep)) m.mes = m.mes.replace(withSep, '');
    else if (m.mes.includes(wb.text)) m.mes = m.mes.replace(wb.text, '');
    else return;                                   // 已经不在了（用户手改 / 已撤销过）→ 什么都不做
    if (Array.isArray(m.swipes) && typeof m.swipes[m.swipe_id] === 'string') m.swipes[m.swipe_id] = m.mes;
    try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
    catch (e) { console.warn('[剧情推进] 撤销诊断修正后保存失败：', e); }
    refreshMessageBar(wb.idx);
}

// 「重新应用」时把那段文本放回正文（与 removeDiagWriteBack 对称，否则重新应用之后再点【重新处理变量】
// 又会丢——正是本功能要根治的那个循环）。已在则不重复。
export async function restoreDiagWriteBack(wb) {
    if (!wb || !wb.text) return;
    const ctx = getCtx();
    const m = (ctx.chat || [])[wb.idx];
    if (!m || typeof m.mes !== 'string' || m.mes.includes(wb.text)) return;
    if (wb.mode === 'inject') {
        const next = insertDiagPatchIntoBlock(stripDiagPatchFromText(m.mes), wb.text);
        if (next == null) return;
        m.mes = next;
    } else {
        m.mes = m.mes.trimEnd() + '\n\n' + wb.text;
    }
    if (Array.isArray(m.swipes) && typeof m.swipes[m.swipe_id] === 'string') m.swipes[m.swipe_id] = m.mes;
    try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
    catch (e) { console.warn('[剧情推进] 重新应用诊断修正后保存失败：', e); }
    refreshMessageBar(wb.idx);
}

// 把校正稿作为【新 swipe】写入第 idx 条消息（非破坏性，原文留在 swipe 0），保存、重渲染、补发
// MESSAGE_SWIPED/UPDATED（让酒馆助手重建状态栏 iframe，与 refreshMessageBar 同理）。返回 true=成功。
// 2026-06-26 两个真机 bug 的修复（手动与自动校正共用本函数，一处修两处都好）：
//  · Bug 1（计数停在 1/1、滑不回原文，得重载才变 2/2）：updateMessageBlock 只重渲染 .mes_text，不碰 ST
//    的 .swipes-counter / 左右箭头；补发 MESSAGE_SWIPED 也不刷新计数。故加一刀 ctx.swipe.refresh(true)
//    （= refreshSwipeButtons(updateCounters=true)）——更新「X/Y」文字、并在 swipes.length>1 时点亮左箭头
//    （swipes_visible），于是无需重载即可滑回原文。
//  · Bug 2（机制块随校正稿带过来了，但 stats 没应用）：MVU 只在 MESSAGE_RECEIVED/SENT 解析更新块，新 swipe
//    是代码造的，MVU 不会给它建变量快照 → 状态栏读不到原回复那次更新。修法：把【原回复已生效】的 MVU 整盘
//    状态【拷贝】到新 swipe（换前 getMvuData 抓快照、换后 replaceMvuData 写回 latest）。是【拷贝】不是
//    【重解析】——绝不会把「好感度 += 5」这类相对更新二次累加；最坏情形（被某 MVU 监听覆盖）也只是没刷新 =
//    与修复前一致，绝不会改坏存档。真实卡片上的状态栏【数值】仍需肉眼复核（MVU 的 swipe 语义此处测不到）。
export async function applyFixAsSwipe(idx, finalText) {
    const ctx = getCtx();
    const m = (ctx.chat || [])[idx];
    if (!m || typeof m.mes !== 'string') return false;

    // Bug 2 ①：换 swipe 前，抓住当前（= 被校正那条 swipe 已生效）的 MVU 整盘状态，待会儿原样拷给新 swipe。
    let mvuSnapshot = null;
    try {
        const Mvu = await getMvu();
        if (Mvu && typeof Mvu.getMvuData === 'function') {
            const cur = Mvu.getMvuData(mvuMsgOpts());
            if (cur) mvuSnapshot = JSON.parse(JSON.stringify(cur));
        }
    } catch (e) { console.warn('[剧情推进] 校正前读取 MVU 状态失败：', e); }

    const now = new Date();
    const info = { send_date: now.toISOString(), gen_started: null, gen_finished: now.toISOString(), extra: { story_oracle_fix: true } };
    addSwipeToMessage(m, finalText, info);
    try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
    catch (e) { console.warn('[剧情推进] 校正写入 swipe 后保存失败：', e); return false; }

    // Bug 2 ②：把抓到的状态【拷贝】到新 swipe（它现在已是 latest）。replaceMvuData 同时写 stat_data +
    // display_data，下面 updateMessageBlock 重渲染时状态栏即读到正确值。放在补发事件【之前】，尽量先于
    // MVU 可能的 swipe 监听落定。
    if (mvuSnapshot) {
        try {
            const Mvu = await getMvu();
            if (Mvu && typeof Mvu.replaceMvuData === 'function') {
                await Mvu.replaceMvuData(mvuSnapshot, mvuMsgOpts());
            }
        } catch (e) { console.warn('[剧情推进] 校正后写回 MVU 状态失败：', e); }
    }

    try { if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(idx, m); }
    catch (e) { console.warn('[剧情推进] 校正后重渲染失败：', e); }

    // Bug 1：刷新 ST 的 swipe 计数 + 左右箭头（updateMessageBlock 不管这块）。ctx.swipe.refresh 即
    // refreshSwipeButtons；传 true 连「X/Y」文字一起更新。带回退以防个别 ST 构建把它摆在别处。
    try {
        const swipeRefresh = (ctx.swipe && ctx.swipe.refresh) || ctx.refreshSwipeButtons;
        if (typeof swipeRefresh === 'function') swipeRefresh(true);
    } catch (e) { console.warn('[剧情推进] 校正后刷新 swipe 计数失败：', e); }

    try {
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.emit === 'function') {
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_SWIPED || 'message_swiped', idx)).catch(() => {});
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_UPDATED || 'message_updated', idx)).catch(() => {});
        }
    } catch (e) { console.warn('[剧情推进] 校正后发事件失败：', e); }
    return true;
}

// 非破坏性地把某条消息切到一个【已存在的】swipe（不新增、不删除——只换 swipe_id + mes）。Task 3 的
// 「用原文」会用它切回原文 swipe；现在仅作为已挂载的 async 函数存在。swipeId 越界 / 不是字符串 → 返回
// false（不动）。命中后复用 applyFixAsSwipe 的保存 / 重渲染 / 发事件尾巴（saveChat → updateMessageBlock →
// emit MESSAGE_SWIPED + MESSAGE_UPDATED），让状态栏 iframe 随之刷新。
async function selectSwipe(idx, swipeId) {
    const ctx = getCtx();
    const m = (ctx.chat || [])[idx];
    if (!m || !Array.isArray(m.swipes) || typeof m.swipes[swipeId] !== 'string') return false;
    m.swipe_id = swipeId;
    m.mes = m.swipes[swipeId];
    // Bug 3（同 addSwipeToMessage）：切到另一条已存在 swipe（用原文 / 用校正稿）也要作废 extra.display_text 的旧
    // 渲染缓存，否则 updateMessageBlock 会渲染旧 display_text 而不是切过去的 mes。对齐 ST 原生 swipe。
    if (m.extra && typeof m.extra === 'object') delete m.extra.display_text;
    try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
    catch (e) { console.warn('[剧情推进] 校正写入 swipe 后保存失败：', e); return false; }
    try { if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(idx, m); }
    catch (e) { console.warn('[剧情推进] 校正后重渲染失败：', e); }
    try {
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.emit === 'function') {
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_SWIPED || 'message_swiped', idx)).catch(() => {});
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_UPDATED || 'message_updated', idx)).catch(() => {});
        }
    } catch (e) { console.warn('[剧情推进] 校正后发事件失败：', e); }
    return true;
}

// 纯函数：unparsed 记录里那段「回复摘要」的唯一裁剪口（1.71.1 从 autoDiagNoteContent 提炼，逻辑
// 逐字节不变）。只取开头 3 行【且】至多 400 字：记录是给人看的，不是日志。行数闸单独用是不够的
// （FIX 6）——这条记录每失败一轮就【持久化】进 chat metadata 一份，而模型完全可能吐一整段没有换行
// 的几千字（JSON / 长散文），三行照样能把 metadata 撑起来。\r 一并剥掉（/\r?\n/）：中转回来的
// CRLF 会让残留的 \r 混进记录正文。截断（按行或按字）恒补一个 … ——不补的话用户看到的是一段
// 干净收尾的文本，会以为模型就说了这么多。
// cut 同时是「查看完整回复」按钮的出现判据（diagFullReplyOpts）——按钮与 … 必须同源，
// 否则会出现「有 … 没按钮」或「没 … 还挂按钮」。
// 400 这个数【有意写成字面量】：提成 ALL_CAPS 常量就要凑够元测试要求的 ≥2 处引用（同 1.62.0
// 体积读数阈值的处理），而它只有这一个消费者（本函数）。
function diagRawExcerpt(raw) {
    const lines = String(raw == null ? '' : raw).trim().split(/\r?\n/);
    let head = lines.slice(0, 3).join('\n');
    let cut = lines.length > 3;
    if (head.length > 400) { head = head.slice(0, 400); cut = true; }
    if (head && cut) head += '…';
    return { head, cut };
}

// 纯函数：这条自动诊断记录要不要挂「查看完整回复」按钮（1.71.1，Prince 点单：摘要被截时得能自己
// 看到模型的完整回复才断得了因）。只有 unparsed 且摘要真被截过（… 在场）才挂——没截过时记录本来
// 就是全文，再挂按钮反而暗示「还有更多」。负载 = 回复原文，只进【内存】注册表（registerNoteOpts）
// 绝不落盘：这条记录每失败一轮就持久化一份，把几千字原文一起落盘正是 FIX 6 要挡的存档膨胀；代价
// 是重载后按钮消失、记录只剩摘要（与撤销按钮同一契约，Prince 拍板 2026-08-27）。
function diagFullReplyOpts(status, raw) {
    if (status !== 'unparsed') return null;
    const s = String(raw == null ? '' : raw);
    return (s.trim() && diagRawExcerpt(s).cut) ? { fullReply: s } : null;
}

// 纯函数：拼一条自动诊断侧聊记录的正文。诚实分类（Task 4，审计簇 C/E）——每一种结局都渲染
// 【它真正发生的那件事】，绝不再折成同一句「无需改动」：
//   applied      已改动、已写入（带补丁，记录上还会长一个撤销按钮）
//   verified     模型给了空 <JSONPatch> = 它核验通过，本回合本就无需改动（真·合格）
//   ineffective  补丁跑了，但一个值都没变（report = 逐 op 对账，经 diagReportLines 附在末尾）
//   unparsed     没能从模型回复里摘出更新区块（detail = diagParseFailReason 的人话原因；raw = 回复
//                原文，取开头几行摆给用户看 —— Prince 点单：要能自己看一眼模型到底说了什么）
//   stale        写入前世界已经变了 → 跳过（detail = 原因键，经下面的表转人话）
//   failed       跑完了但没能解析 / 应用
//   nochange     旧的笼统「无需改动」：_.set 方言下我们【真的】分不清 verified / ineffective，那时老实
//                回它；也留作旧调用方的别名，故其文案逐字不变。
// stamp 由调用方传入（纯函数不读时钟，便于单测）。【文案待 Prince 定】可单测。
// zero / repair（1.67.0，两个可选槽）：zero = autoApplyFix 在【零变化】那一支算好的逐条诊断
// （本函数是纯的、拿不到补丁与状态，只能由调用方带进来；缺席则退回 diagReportLines 的零变化版，
// 那一版同样【不会】说「可能已生效」）。repair = 修复流水线的计数读数。两槽都缺席时正文
// 与加这两个槽之前【逐字节】相同（老记录零漂移，diag-note-content.test.mjs 有字节钉）。
//   doubleblock  回复里有两个（或更多）MVU 更新区块 → 一个字都没写，请重掷（1.68.0，Prince 定调）
//   scoped（1.83.0，可选槽）= 🧩 并写模式裁过的读数 { kept, dropped }：dropped 非空才在末尾追加一行点名；缺席 /
//                空数组时正文逐字节同旧（老记录零漂移）。
function autoDiagNoteContent({ status, patch, stamp, detail, raw, report, notice, zero, repair, blocks, scoped, schemaDry, schemaRetried }) {
    const t = stamp ? ' · ' + stamp : '';
    const fixNote = repairDiagNote(repair) + diagCoWriteDroppedLine(scoped);
    // 🩺 1.89.0：schema 预演读数 + 「已让模型重写一次」（两槽缺席 → ''，旧文逐字节不变）。
    const retryNote = (schemaRetried && schemaRetried.firstDry)
        ? `\n↻ 第一份补丁里有 ${(schemaRetried.firstDry.refused || []).length} 处过不了这张卡的规则，已让模型按原因重写一次。`
        : '';
    const dryNote = diagSchemaDryLines(schemaDry) + retryNote;
    if (status === 'applied') {
        const body = (patch && patch.trim()) ? `\n${patch.trim()}` : '';
        // notice（Task 7）= 写入落在用户自己那一楼时的落点提示，由调用方【在写入那一刻】算好传进来
        // （本函数不读 ctx、不读时钟）。缺席时这一行逐字节等同于加这个槽之前 —— 老记录零漂移。
        // 只有 applied 这一支消费它：没写进去的轮次带上「记在哪」纯属答非所问。
        const n = (notice && String(notice).trim()) ? `\n${notice}` : '';
        // 部分生效（whole-branch review FIX 1）：手动路早就如实说了（addApplyControls 的
        // 「已应用（N 条指令中 M 条生效）」），自动路却把 report 一路传到这儿又扔掉 —— 于是
        // 「一条生效 + 一条被跳」在侧聊记录里读起来与全部成功一模一样，用户没有任何线索去看那条
        // 没生效的指令。形状对齐 ineffective 那一支：头条说清 M/N，末尾附 diagReportLines 的逐条原因。
        // report 缺席（_.set 方言，无对账依据）或全生效 → 走下面那句，【逐字节】与本次改动之前相同。
        if (report && report.applied < report.total) {
            return `🔧 自动诊断${t} —— 已修复本回合的 MVU 状态（${report.total} 条指令中 ${report.applied} 条生效，在下方点「撤销」可还原）。${n}${body}${diagReportLines(report)}${fixNote}${dryNote}`;
        }
        return `🔧 自动诊断${t} —— 已自动修复本回合的 MVU 状态（在下方点「撤销」可还原）。${n}${body}${fixNote}${dryNote}`;
    }
    if (status === 'schemarefused') {
        return `⚠️ 自动诊断${t} —— 这份修复里的每一处都过不了这张卡的规则（未写入）。${dryNote}`;
    }
    if (status === 'failed') {
        return `⚠️ 自动诊断${t} —— 跑完了，但这条更新没能解析 / 应用（已跳过，未改动状态）。`;
    }
    if (status === 'verified') {
        return `🩺 自动诊断${t} —— 模型核验通过（补丁为空），本回合无需改动。${dryNote}`;
    }
    if (status === 'ineffective') {
        // 1.67.0：这一支【有证据】—— 一个字都没写，所以逐条一律说死「未生效」+ 原因 + 下一步。
        // zero 缺席时退回 diagReportLines 的【零变化版】（ctx='zero'），它同样不会说「可能已生效」——
        // 那句诚实只属于部分生效语境。两条路都在全生效 / 无对账依据时回空串，故直接拼、不留空行残渣。
        // 1.68.0：头条走 diagZeroHeadline（与手动路共用那一份）—— 「指令列表没读懂」那一档不能说
        // 「补丁运行了」。zero 缺席时它回默认那句，与加这一步之前【逐字节】相同。
        const z = (zero && zero.text) ? zero.text : diagReportLines(report, 'zero');
        return `⚠️ 自动诊断${t} —— ${diagZeroHeadline(zero && zero.code)}（未写入）。${fixNote}${z}${dryNote}`;
    }
    if (status === 'doubleblock') {
        // 1.68.0：模型在一条回复里甩了两个更新区块。绝不合并、绝不挑一块 —— 说清风险，请重掷。
        return `⚠️ 自动诊断${t} —— ${diagDoubleBlockNotice(blocks || 2)}`;
    }
    if (status === 'unparsed') {
        // 摘要裁剪在 diagRawExcerpt（1.71.1 提炼——「查看完整回复」按钮与 … 必须同一判据）。
        const { head, cut } = diagRawExcerpt(raw);
        // 1.71.1：没截过就说「全文」——「开头」两个字暗示后面还有，Discord 实锤有用户把一条
        // 孤标签回复（模型真就只回了那么多）读成「记录把消息截断了、诊断不了」。截断分支逐字节不动。
        const rawLabel = cut ? '模型回复开头' : '模型回复全文（模型只返回了这些）';
        return `⚠️ 自动诊断${t} —— 没能读懂模型的回复，本轮没有诊断结论（未改动状态）。\n可能原因：${detail || '未知'}${head ? `\n${rawLabel}：\n${head}` : ''}`;
    }
    if (status === 'stale') {
        // 认不出的 reason 走兜底 —— 绝不把内部键名漏给用户看。
        // ⚠ 'chatSwitched' 有意留在表里：本函数是【纯的】、按 status+reason 说人话，这是它的契约；
        // 至于那一轮该不该真的落一条记录，是【调用方】的作用域判断（runAutoDiagnose 走 noNote 掐掉），
        // 别因为「现在没人渲染它」把这一行删了 —— 将来若改成往【捕获到的那个聊天】补写记录，就要它。
        // 1.83.0（Prince 候选 B）：状态被改那一档说清是【MVU 变量】被改、可能是别的脚本 / 扩展所为 ——
        // 三张真卡（世界推进 / MVU核验 / JL12M）都是回合后引擎在写，旧句「另一次写入 / 新回复」谁也看不懂。
        // 并写模式下全部冲突时，diagCoWriteDroppedLine 点名撞上的路径（缺席 = 一字不加）。
        if (detail === 'stateMoved') {
            return `⏭️ 自动诊断${t} —— 已跳过：MVU 变量在自动诊断运行期间被改动（可能是其他脚本 / 扩展所为），诊断模式的修改未写入。${diagCoWriteDroppedLine(scoped)}`;
        }
        const why = {
            chatSwitched: '聊天已切换',
            gone: '目标回复已不在了',
        }[detail] || '目标已失效';
        return `⏭️ 自动诊断${t} —— 已跳过：${why}，未写入。`;
    }
    return `🩺 自动诊断${t} —— 已检查最新回复，本回合无需改动。`;   // nochange
}

// 纯函数（1.83.0 🧩 并写）：被裁掉的 op 点名成一行；没裁掉任何一条 → 空串（老记录逐字节不动）。
// 【文案待 Prince 定】可单测。
function diagCoWriteDroppedLine(scoped) {
    const d = (scoped && Array.isArray(scoped.dropped)) ? scoped.dropped : [];
    if (!d.length) return '';
    const paths = d.map((x) => (x && x.path) || '（无路径）').join('、');
    return `\n（有 ${d.length} 条与其他脚本的改动冲突，已跳过：${paths}）`;
}

// 纯函数：拼一条自动【校正】侧聊记录的正文（仿 autoDiagNoteContent）。status: fixed（已校正、已作为新
// swipe 应用）/ nochange（成本门 / 无操作，未改动）/ failed（没解析出 <FixedReply>，未改动）。fixed 提示
// 向左划可看原文（原文留在 swipe 0，本扩展不破坏它），并附上「发现并修正」摘要（problems，可空）。
// stamp 由调用方传入（纯函数不读时钟，便于单测）。可单测。
export function autoFixNoteContent({ status, problems, stamp }) {
    const t = stamp ? ' · ' + stamp : '';
    if (status === 'fixed') {
        const body = (problems && String(problems).trim()) ? `\n发现并修正：\n${String(problems).trim()}` : '';
        return `✨ 自动校正${t} —— 已校正最新回复，并作为新 swipe 应用。原文还在——向左划看原文，或点下方「看改动」对比。${body}`;
    }
    if (status === 'failed') {
        // ✨ 防呆（P5 接线）：problems 槽可携带 fixFailureReason 的人话原因（空 / 拒绝 / 垃圾），空则字节不变。
        const extra = (problems && String(problems).trim()) ? `\n可能原因：${String(problems).trim()}` : '';
        return `⚠️ 自动校正${t} —— 跑完了，但没能从模型回复里解析出校正稿（已跳过，未改动回复）。${extra}`;
    }
    // Phase 4：P-TRUNC 截断 —— 模型回复被中转 / max_tokens 砍成半句，未应用（半句稿会腰斩回复）。
    if (status === 'truncated') {
        return `⚠️ 自动校正${t} —— 模型回复像是被截断了（没写完就断了），未应用（把「最大 token 数」调大些再试）。`;
    }
    // ✨ 分段校正（1.18.0）：一轮多段的诚实结算——headline 恒为「已校正 N 段正文中的 M 段」；有回退段附
    // 逐段原因；失败正文过半（majority）头条翻 ⚠️ 警告、建议重试——大面积回退绝不能读成无保留的已校正。
    if (status === 'partial') {
        const p = problems || {};
        const lines = (Array.isArray(p.failLines) && p.failLines.length) ? '\n' + p.failLines.join('\n') : '';
        const body = (p.problems && String(p.problems).trim()) ? `\n发现并修正：\n${String(p.problems).trim()}` : '';
        if (p.majority) {
            return `⚠️ 自动校正${t} —— 大部分正文没能校正（${p.headline || ''}），未校正的段落已保留原文，建议稍后点 ↻ 重试。${lines}${body}`;
        }
        const kept = lines ? '；未校正的段落已保留原文' : '';
        return `✨ 自动校正${t} —— ${p.headline || '已校正'}，已作为新 swipe 应用${kept}。原文还在——向左划看原文，或点下方「看改动」对比。${lines}${body}`;
    }
    // ✨ 分段校正：确认一次（散文+结构混排 / 未知包裹名的卡）——本轮不校正，等用户一次确认（详见 emitPieceAsk）。
    if (status === 'ask') {
        const p = problems || {};
        const guess = p.tag
            ? `我认为这张卡的正文包在 <${p.tag}> 里`
            : '这张卡没有正文包裹标签，我认为正文是【标签之外的散文】';
        return `✋ 自动校正${t} —— 需要确认一次：${guess}（约 ${p.prose | 0} 字；${p.guards | 0} 块结构将原样保留）。点弹出的提示确认，或在「校正设置」的判定行点「确认」；确认前不会自动改动任何回复。`;
    }
    // Phase 4：P-CORRUPT 陈旧 —— LLM 返回后聊天 / 目标已变，跳过写入。reason 经 problems 槽传入、映射成人话。
    if (status === 'stale') {
        const why = {
            chatSwitched: '聊天已切换（避免写到别的对话）',
            contentChanged: '这条回复已发生变化（避免覆盖新内容）',
            swipeChanged: '这条回复已切到别的 swipe',
            gone: '目标回复已不在了',
        }[problems] || '目标已失效';
        return `⏭️ 自动校正${t} —— 已跳过：${why}，未改动这条回复。`;
    }
    // ✨ Phase 5 D+E：作用域懒检测 / 记忆 / 静默兜底——problems 槽这次装的是 resolveFixScope 的 note 描述符
    // （{code,cachedTag,detectedTag} 对象，不是字符串），交给 fixScopeNoteText 转成人话；emoji 由它给，不用前缀的✨。
    if (status === 'scope') {
        const e = fixScopeNoteText(problems);
        return `${e.emoji} 自动校正${t} —— ${e.body}`;
    }
    // Tier 0 ①：近抄 —— 模型返回了稿子但与原文几乎相同（不是「本就无需校正」，是模型基本没改）。与 nochange 区分，
    // 便于用户看出是模型没使上劲（尤其高上下文），而非回复本来就干净。
    if (status === 'nearcopy') {
        return `✨ 自动校正${t} —— 模型基本没改，已按无需校正处理（未落稿）。`;
    }
    return `✨ 自动校正${t} —— 已检查最新回复，无需校正（未改动）。`;   // nochange
}

// 📋 自定义模板任务记录文案（spec §5.6；§11 草稿待 Prince 否决权）。与 autoFixNoteContent 分函数 = 校正字串逐字节不动。
export function customTaskNoteContent({ status, problems, stamp, template }) {
    const t = stamp ? ' · ' + stamp : '';
    const who = `📋 模板〔${template || ''}〕${t}`;
    const p = (problems && typeof problems === 'string') ? problems.trim() : '';
    if (status === 'fixed') return `${who} —— 已处理最新回复，并作为新 swipe 应用。原文还在——向左划看原文，或点下方「看改动」对比。${p ? '\n' + p : ''}`;
    if (status === 'nochange') return `${who} —— 无需处理${p ? '（' + p + '）' : ''}，未改动回复。`;
    if (status === 'notemplate') return `⚠ 模板〔${template || ''}〕不存在或正文为空，本条未处理——到「校正设置 → 自定义」里选一份模板。`;
    if (status === 'failed') return `⚠️ ${who} —— 跑完了，但没能从模型回复里解析出处理稿（已跳过，未改动回复）。${p ? '\n可能原因：' + p : ''}`;
    if (status === 'truncated') return `⚠️ ${who} —— 模型回复像是被截断了（没写完就断了），未应用（把「校正输出上限」调大些再试）。`;
    if (status === 'stale') {
        const why = { chatSwitched: '聊天已切换（避免写到别的对话）', contentChanged: '这条回复已发生变化（避免覆盖新内容）', swipeChanged: '这条回复已切到别的 swipe', gone: '目标回复已不在了' }[problems] || '目标已失效';
        return `⏭️ ${who} —— 已跳过：${why}，未改动这条回复。`;
    }
    return autoFixNoteContent({ status, problems, stamp });   // scope / ask 等共用句式
}

// 「诊断途中聊天被切走」的环境提示 —— 两道闸【共用】的唯一一份（whole-branch review FIX 2/3）。
// 判这件事的地方有两处：① 写入前的事务闸（runAutoDiagnose 里 chatIdentityKey() !== captured.chatKey）；
// ② autoApplyFix 内部 parseMessage 那扇 await 窗口（回 stale/chatSwitched，经 notifyAutoDiagnose 的
// noNote 支）。它们判的是同一件事，用户却分不清是哪一道拦的 —— 所以必须说【同一句话】；分成两份
// 迟早漂成两种说法（本轮之前正是：一处彻底静默、一处弹一句还指着一份不存在的记录）。
// ⚠ 作用域是这句话的全部要害：侧聊【记录】是聊天级的持久物（appendNoteToRoom 写的是「现在」那个
//   聊天的 metadata），人已经切走了，那一轮的记录无处可写 —— 两道闸都【不留记录】；而 toast 是
//   会话级的环境提示、不落任何聊天，两道闸都【照发】。故这句话绝不可以说「详情见诊断记录」：
//   那条记录根本不存在，而用户此刻已经在另一个聊天里，去哪儿都找不到它。【文案待 Prince 定】
export function toastDiagChatSwitched() {
    try {
        const toastr = getHostGlobal('toastr');
        toastr && toastr.warning && toastr.warning(
            '本轮已跳过：诊断期间聊天已切换（未写入，也未留记录）。',
            '剧情推进 · 自动诊断', { timeOut: 5000 });
    } catch (e) { /* toastr 不在就算了 */ }
}

// 自动诊断跑完一轮后的提示。用户功能请求：每轮都在侧聊里留一条【持久】记录（含「无需改动」）；改动
// 的那条还带一个【撤销按钮】（与手动诊断同款，经 applyFix/undoFix），撤销不再走 toast。toast 只作信息
// 提示。注意：撤销按钮只在【刚跑完的本会话】可用——重载后记录变只读（重放旧补丁不安全，与手动诊断回复
// 重载后失去按钮一致）。
// opts.noNote（可选）：只发 toast、【不留】侧聊记录。作用域不同是硬道理——toast 是会话级的环境提示，
// 记录是聊天级的持久物；调用方判定「这条记录会落进一个无辜的对话」时用它（见 runAutoDiagnose 的注释）。
export function notifyAutoDiagnose(result, patch, writeBack, opts) {
    const status = (result && result.status) || 'failed';
    const snapshot = status === 'applied' ? result.snapshot : null;

    // 信息 toast（不再承担撤销动作——撤销在记录的按钮上）。分档同记录（Task 4）：真的没事 = info，
    // 「跑完了但没落地」的每一种 = warning，且各说各的原因，绝不再共用一句「没能解析 / 应用」。
    try {
        const toastr = getHostGlobal('toastr');
        if (status === 'applied') {
            // 部分生效（FIX 1）：记录里已如实分列，toast 也别一句「已自动修复」了事 —— 那是唯一
            // 会被大多数用户看到的一面，读起来必须与记录是同一件事。后半句（去哪儿撤销）两支共用，
            // 全生效时拼出来的整句与本次改动之前【逐字节相同】。
            const rp = result && result.report;
            const head = (rp && rp.applied < rp.total)
                ? '已自动修复（部分指令未生效，详情见诊断记录）。'
                : '已自动修复最新回复的 MVU 状态。';
            toastr && toastr.success && toastr.success(
                // 分房间后记录（含撤销按钮）在诊断房间——人在别的模式时提示到点上（点诊断按钮即回诊断视图）
                head + (ENABLE_MODE_ROOMS
                    ? '可到剧情推进侧聊的诊断记录里点「撤销」还原（点🩺诊断按钮即达）。'
                    : '可在剧情推进侧聊里点「撤销」还原。'),
                '剧情推进 · 自动诊断', { timeOut: 7000 });
        } else if (status === 'nochange' || status === 'verified') {
            toastr && toastr.info && toastr.info(
                '已检查最新回复，本回合无需改动。', '剧情推进 · 自动诊断', { timeOut: 4000 });
        } else if (status === 'stale' && opts && opts.noNote) {
            // FIX 2：noNote = 这一轮【确定不会】留记录（切聊天，见下面那道早退）。原先这里照发通用的
            // stale 文案，末尾却挂着「详情见诊断记录」—— 指着一份根本没写的记录，而用户已经在别的
            // 聊天里了。换成与写入前那道事务闸【同一句】（toastDiagChatSwitched），并点名真正的原因。
            toastDiagChatSwitched();
        } else if (opts && opts.retryLine) {
            // 🔁 这一轮失败但马上会自动重试：失败 warning 只在【最终】失败后发（不然每一跳都弹一次
            // = 重试越多越吵），中间跳靠记录里的重试标注 + 紧随其后的「正在重试」toast 说话。
        } else {
            // 'failed' 的那句逐字保留（旧行为），其余三种各自说人话；详细原因在诊断记录里。
            // stale 这一句只服务【留得下记录】的那几种（状态被改动过 / 换楼换 swipe）；切聊天走上面那支。
            const msg = {
                // 1.67.0：补丁本身完全合规却零变化 = 问题在环境（酒馆助手版本 / mvu_zod 静默拒绝），
                // 与「补丁自己写错了」是两件事 —— toast 是大多数用户唯一会看到的一面，得说到点上。
                ineffective: (result && result.zero && result.zero.code === 'residual')
                    ? '补丁本身没问题，但卡片侧的 MVU 一条也没执行（未写入）——详情见诊断记录。'
                    : (diagZeroHeadline(result && result.zero && result.zero.code) + '（未写入）——详情见诊断记录。'),
                // 1.68.0：双区块是【模型的输出形状】出问题，与「补丁没生效」是两件事，得各说各的。
                doubleblock: '模型写了两个更新区块，为安全起见未写入——详情见诊断记录。',
                schemarefused: '这份修复里的每一处都过不了这张卡的规则（未写入）——详情见诊断记录。',   // 🩺 1.89.0
                unparsed: '没能读懂模型的回复，本轮没有诊断结论（未改动状态）——详情见诊断记录。',
                stale: '本轮已跳过：写入前状态 / 聊天已经变了（未写入）——详情见诊断记录。',
            }[status] || '自动诊断跑完了，但这条更新没能解析 / 应用（已跳过）。';
            toastr && toastr.warning && toastr.warning(
                msg, '剧情推进 · 自动诊断', { timeOut: 5000 });
        }
    } catch (e) { /* toastr 不在就算了 */ }

    // 【有意不留记录】的那一支（opts.noNote）：toast 已经发过了，到此为止。appendNoteToRoom 写的是
    // getChatMetadataSafe() —— 也就是【现在】那个聊天的元数据，切聊天后写进去等于在无辜的对话里
    // 说另一个对话的事（与写入前那道事务闸同一条不变量，那边同样是静默作废）。
    if (opts && opts.noNote) {
        console.debug('[剧情推进] 自动诊断：写入前发现聊天已切换，本轮作废（未写入）。');
        return;
    }

    // 持久侧聊记录（每轮都写）。窗口关着也留得下（DOM 在 init 就建好）；随 per-chat 持久化、跨重载存活。
    // 它是 note 条目，不是问答轮，绝不回灌给模型（见 convoForPrompt）。
    try {
        const stamp = (() => { try { return new Date().toLocaleTimeString(); } catch (e) { return ''; } })();
        // ⚠ 陈旧跳过的原因走的是 result.reason（autoApplyFix 的字段），不是 result.detail（unparsed 那支
        // 才用 detail）—— 两个槽在这里合流，漏掉任一个都会把原因静默丢成兜底的「目标已失效」。
        const entry = { id: nextCid(), role: 'note', content: autoDiagNoteContent({
            status, patch, stamp,
            detail: result && (result.detail != null ? result.detail : result.reason),
            raw: result && result.raw,
            report: result && result.report,
            // 1.67.0：零变化的逐条诊断 + 修复流水线读数由 autoApplyFix 一次算好带过来（本函数下游的
            // autoDiagNoteContent 是纯的，拿不到补丁与状态）。两槽缺席时正文逐字节与加槽前相同。
            zero: result && result.zero,
            repair: result && result.repair,
            blocks: result && result.blocks,   // 1.68.0：双区块那一支要报出「几块」
            scoped: result && result.scoped,   // 1.83.0 🧩 并写：被裁掉的 op 点名（缺席 = 记录逐字节同旧）
            schemaDry: result && result.schemaDry,   // 🩺 1.89.0：schema 预演读数（缺席 = 记录逐字节同旧）
            schemaRetried: result && result.schemaRetried,   // 🩺 1.89.0：这一轮让模型按原因重写过一次
            // Task 7（审计簇 D）：落点提示【在这里现算】——记录是持久物、会在很久以后被重画，
            // 那时的最末楼早不是写入时那一楼了。只有真写进去的那一轮才算它。
            notice: status === 'applied' ? diagUserFloorNotice() : '',
        // 🔁 重试标注拼在纯函数【之外】：autoDiagNoteContent 的既有输出保持逐字节不动（它有字节钉），
        // retryLine 缺席时这条拼接是空操作。
        }) + ((opts && opts.retryLine) ? '\n' + opts.retryLine : '') };
        // 改动型记录在本会话挂可用的撤销按钮；其余（无改动 / 失败 / 重载后）是只读记录。
        // applied（Task 5）= 这一轮写进去的那一份，撤销侧拿它当漂移比较锚：「这条记录之后世界又动过没有」。
        // 1.71.1：unparsed 且摘要被截过 → 改挂「查看完整回复」按钮（diagFullReplyOpts；与 undoable
        // 结构性互斥——unparsed 那一支没有 snapshot/patch）。
        const undoable = (snapshot && patch) ? { snapshot, applied: result.applied, patch, writeBack: writeBack || null } : null;
        appendNoteToRoom('diagnose', entry, undoable || diagFullReplyOpts(status, result && result.raw));   // 自动诊断记录归入【诊断房间】（不可见时直接落其元数据、不上屏）
        // 🩺 1.89.0：被存档污染挡住 → 紧跟着让存档检查说清是哪一格（去重在 maybeRunSaveHealth 里）。
        if (ENABLE_SCHEMA_DIAG && result && result.schemaDry && result.schemaDry.poisoned) maybeRunSaveHealth('failure');
    } catch (e) { console.warn('[剧情推进] 自动诊断记录写入侧聊失败：', e); }
}

// 「正在自动诊断…」提示。返回一个句柄交给 dismissToast 收掉（toastr 不在则回 null）。timeOut:0 = 不
// 自动消失，由我们在生成结束后手动 clear。
// retry（可空）= 🔁 重试跳的 { used, max }：带上「第几次」标注，用户看得出这不是首跑。不传时
// 文案与 1.73.0 之前逐字相同。
export function showAutoDiagGenerating(retry) {
    try {
        const toastr = getHostGlobal('toastr');
        if (toastr && toastr.info) {
            const msg = retry
                ? `诊断重试中（第 ${retry.used}/${retry.max} 次）…（点此中断）`   // 文案 Prince 亲选（换序版，2026-08-28）
                : '正在分析最新回复、生成诊断报告…（点此中断）';
            return toastr.info(msg, '剧情推进 · 自动诊断', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, onclick: () => cancelPostReply() });
        }
    } catch (e) { /* ignore */ }
    return null;
}
export function dismissToast(handle) {
    try { const toastr = getHostGlobal('toastr'); if (handle && toastr && toastr.clear) toastr.clear(handle); } catch (e) { /* ignore */ }
}

// 自动诊断记录上的「撤销 / 重新应用」按钮条（与 addApplyControls 同款，复用 applyFix/undoFix）。
// 记录创建时修复【已自动应用】，故按钮初始就是「撤销」态。
// info = { snapshot, applied, patch, writeBack, undone? }（Task 5 起的形状，与 addMvuedUndoControls 同款）：
//   · snapshot = 写入【前】整份深拷贝（撤销靶子）；applied = 写入【后】那一份（漂移比较锚）；
//   · writeBack（可空）= 这次诊断往消息正文里写过的那段（衍生块 / 注入的补丁）。撤销 / 重新应用要
//     【连正文一起】同步：只还原变量而把那段留在正文里，下次 MVU【重新处理变量】会照着正文把它重新
//     算回来 —— 撤销就等于白撤。没有 writeBack 时两个调用都是空操作。
//   · undone 记在 info 上（注册表存的就是这个对象的引用）——换房重画时按钮按真实状态重生，不会把
//     「已撤销」的记录又画成崭新「撤销」态（1.33.2 fixApply.applied 同款做法）。
// 「查看完整回复」（1.71.1，Prince 点单）：unparsed 记录的摘要被截过（…）时挂一枚按钮，把模型回复
// 【原文】就地展开 / 收起——Discord 实锤：三行摘要常常不够用户看清模型到底回了什么。原文只活在
// 会话注册表（见 diagFullReplyOpts 头注），重载后按钮不再出现（记录只读，与撤销同契约）。
// ⚠ 面板恒 textContent：原文里满是 <UpdateVariable> 这类标签，走 innerHTML 会被当 HTML 吞掉。
export function addFullReplyControls(wrap, fullText) {
    const bar = document.createElement('div');
    bar.className = 'pad-apply-bar pad-note-undo';
    const btn = document.createElement('button');
    btn.className = 'pad-apply-btn';
    bar.appendChild(btn);
    wrap.appendChild(bar);
    let panel = null;
    const paint = () => {
        btn.innerHTML = panel
            ? '<i class="fa-solid fa-eye-slash"></i> 收起'
            : '<i class="fa-solid fa-eye"></i> 查看完整回复';
    };
    paint();
    btn.addEventListener('click', () => {
        if (panel) { panel.remove(); panel = null; }
        else {
            panel = document.createElement('div');
            panel.className = 'pad-note-fullreply';
            panel.textContent = String(fullText == null ? '' : fullText);
            wrap.insertBefore(panel, bar);   // 面板落在摘要正文之下、按钮条之上
        }
        paint();
    });
}

export function addNoteUndoControls(wrap, info) {
    const bar = document.createElement('div');
    bar.className = 'pad-apply-bar pad-note-undo';
    const btn = document.createElement('button');
    btn.className = 'pad-apply-btn';
    const status = document.createElement('span');
    status.className = 'pad-apply-status';
    bar.appendChild(btn);
    bar.appendChild(status);
    wrap.appendChild(bar);

    const patch = info && info.patch;
    const writeBack = (info && info.writeBack) || null;
    let snapshot = info ? info.snapshot : null;    // 撤销靶子（重新应用成功后换成新的一份）
    let applied = (info && info.applied) || null;  // 这条记录写下的那一份（撤销侧的漂移比较锚）
    let undone = !!(info && info.undone);
    let dead = false;                              // 写成了却拿不到可回退的靶子 → 按钮就地作废（见下）
    const paint = () => {
        btn.innerHTML = undone
            ? '<i class="fa-solid fa-wand-magic-sparkles"></i> 重新应用'
            : '<i class="fa-solid fa-rotate-left"></i> 撤销此次修复';
    };
    paint();
    btn.addEventListener('click', async () => {
        status.classList.remove('pad-hint-error');
        btn.disabled = true;
        // 漂移守卫（Task 5，审计簇 B）：撤销是【整份互换】（undoFix → replaceMvuData 整份写前快照），
        // 这条记录之后发生过的一切都会被这一下盖掉；重新应用是【按当时的状态算的补丁】重放到现在的
        // 状态上。两个方向都可能把「后来的变化」弄没，点下去之前问一句——不拦，只说实话。
        // expect = 这条记录声称「现在应该是」的那一份；取不到现值 / 缺锚点（旧会话的负载没有 applied）
        // → 不问，照旧行为走（读不到就证不了任何事）。
        const expect = undone ? snapshot : applied;
        let live = null;
        try { const Mvu = await getMvu(); live = Mvu && typeof Mvu.getMvuData === 'function' ? Mvu.getMvuData(mvuMsgOpts()) : null; }
        catch (e) { live = null; }
        if (diagUndoDrifted(live, expect)) {
            const okGo = await uiConfirm(undone
                ? '状态在这之后变过，应用可能覆盖后来的变化。确定？'
                : '状态在这之后变过，撤销会把后来的变化也回退。确定？');
            if (!okGo) { status.textContent = '已取消。'; btn.disabled = false; return; }
        }
        if (!undone) {
            // undoFix 是整份互换：没有快照就没有靶子（replaceMvuData(null) 会把整份状态换成 null）。
            // 调用方（addNoteMessage）已经把这种记录挡在门外了，这一行是不给第二个调用方留坑。
            if (!snapshot) { status.textContent = '没有可还原的快照。'; btn.disabled = true; return; }
            status.textContent = '正在还原…';
            try {
                await undoFix(snapshot);
                await removeDiagWriteBack(writeBack);   // 连正文里那段一起摘掉，否则「重新处理变量」会把它算回来
                undone = true;
                if (info) info.undone = true;
                paint();
                // Task 7：还原也是一次 MVU 写入（整份互换），落点同样是最末非系统楼 —— 落在用户楼上时
                // 同样看不见。现算，绝不缓存（`.pad-apply-status` 是 pre-line，换行真的换行）。
                const n = diagUserFloorNotice();
                status.textContent = '已还原到修复前的状态。' + (n ? '\n' + n : '');
            } catch (e) {
                status.textContent = '还原失败：' + (e?.message || e);
                status.classList.add('pad-hint-error');
            }
        } else {
            status.textContent = '正在重新应用…';
            try {
                // applyFix 回 { snapshot, applied, report }；null = 一个字都没写（原因已写在 status 上）。
                // 判据是 r 而不是 r.snapshot：读不到写入【前】的状态时 snapshot 会是 null，但那一份【确实
                // 写进去了】——按 snapshot 判会让界面停在「正在重新应用…」，等于对用户撒谎。
                const r = await applyFix(patch, status);
                if (r) {
                    await restoreDiagWriteBack(writeBack);   // 与撤销对称：正文那段也放回去
                    snapshot = r.snapshot;
                    applied = r.applied || null;
                    undone = false;
                    if (info) { info.undone = false; info.snapshot = snapshot; info.applied = applied; }
                    // snapshot 为空 = 没有可回退的靶子：如实报成功，但绝不给一颗按下去什么都回不去的
                    // 「撤销」（undoFix(null) 会把整份状态换成 null），按钮就地作废。
                    dead = !snapshot;
                    paint();
                    const n = diagUserFloorNotice();   // Task 7：落点提示，现算（见 diagUserFloorNotice 头注）
                    status.textContent = ((r.report && r.report.applied < r.report.total)
                        ? `已重新应用（${r.report.total} 条指令中 ${r.report.applied} 条生效）。` + diagReportLines(r.report)
                        : '已重新应用。') + repairDiagNote(r.repair) + (n ? '\n' + n : '');
                }
            } catch (e) {
                status.textContent = '重新应用失败：' + (e?.message || e);
                status.classList.add('pad-hint-error');
            }
        }
        btn.disabled = dead;
    });
}

// ✨ 校正 Phase 4：自动校正【已应用】记录上的「用原文 / 看改动」按钮条（仿 addNoteUndoControls 的结构）。
// info = { idx, before, after, fixSwipeId }。自动校正在创建记录时已把校正稿作为新 swipe 应用，原文留在
// swipe 0。两个按钮：
//   · 用原文：切回 swipe 0（selectSwipe(idx,0)），成功后改标签为「用校正稿」并把动作翻到切回 fixSwipeId——
//     原文 ↔ 校正稿 的二态开关（本会话内）。selectSwipe 返回 false（swipe 已不在，例如用户重 roll 了）→
//     状态写「无法切换」并禁用按钮。
//   · 看改动：懒构建一次 renderDiffCard(before, after) 接到 wrap 上，之后切 hidden 复用（与手动卡同款）。
export function addAutoFixControls(wrap, info) {
    const bar = document.createElement('div');
    bar.className = 'pad-apply-bar pad-note-undo';
    const swapBtn = document.createElement('button');
    swapBtn.className = 'pad-apply-btn';
    swapBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 用原文';
    const diffBtn = document.createElement('button');
    diffBtn.className = 'pad-apply-btn';
    diffBtn.innerHTML = '<i class="fa-solid fa-eye"></i> 看改动';
    const status = document.createElement('span');
    status.className = 'pad-apply-status';
    bar.appendChild(swapBtn);
    bar.appendChild(diffBtn);
    bar.appendChild(status);
    wrap.appendChild(bar);

    // 原文 ↔ 校正稿 二态开关。showingOriginal=false = 当前显示校正稿（记录创建时即此态）。
    let showingOriginal = false;
    swapBtn.addEventListener('click', async () => {
        status.classList.remove('pad-hint-error');
        swapBtn.disabled = true;
        const targetSwipe = showingOriginal ? info.fixSwipeId : 0;
        const ok = await selectSwipe(info.idx, targetSwipe);
        if (!ok) {
            // swipe 不在了（用户重 roll / 删了）——这条记录的切换不再可靠，停用。
            status.textContent = '无法切换（原 swipe 已不在）。';
            status.classList.add('pad-hint-error');
            return;   // 留 disabled
        }
        showingOriginal = !showingOriginal;
        if (showingOriginal) {
            swapBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 用校正稿';
            status.textContent = '已切回原文。';
        } else {
            swapBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 用原文';
            status.textContent = '已切回校正稿。';
        }
        swapBtn.disabled = false;
    });

    let diffCard = null;
    diffBtn.addEventListener('click', () => {
        if (!diffCard) {
            diffCard = renderDiffCard(stripFixKeepMarks(info.before), stripFixKeepMarks(info.after));   // 别把 ⟦SO_KEEP_n⟧ 锚点露进「看改动」
            wrap.appendChild(diffCard);
        } else {
            diffCard.hidden = !diffCard.hidden;
        }
        scrollToBottom();
    });
}

// 🎛 手动编辑记录的「撤销 / 重新应用」二态按钮（仿 addNoteUndoControls，但走 replaceMvuData 整份快照
// 互换，不涉及补丁重放 —— 手动编辑写的是绝对值，两份快照哪份都能原样盖回去）。
// info = { snapshot, applied, trainerFreeze?, undone? }：snapshot/applied 两份都是写入时的深拷贝，
// 点一次再深拷贝一份交给 MVU，谁也不与 MVU 手里的活对象共享引用。undone 记在 info 上（注册表存的就是
// 这个对象的引用）——换房重画时按钮按真实状态重生，不会把「已撤销」的记录又画成崭新「撤销」态
// （1.33.2 fixApply.applied 同款做法）。重载后注册表为空 → 记录只读，与自动诊断记录同款半径。
// trainerFreeze（ENABLE_MVU_TRAINER，Finding 2）= [{path, prevValue, nextValue}]｜undefined：这次应用
// 里被「冻结重新武装」改过目标的规则，写入前后各一份值。只换 MvuData 不够——那些规则仍指着重新武装后
// 的新值，下一条回复会把撤销掉的编辑又拉回来（「撤销」形同虚设）。
export function addMvuedUndoControls(wrap, info) {
    const bar = document.createElement('div');
    bar.className = 'pad-apply-bar pad-note-undo';
    const btn = document.createElement('button');
    btn.className = 'pad-apply-btn';
    const status = document.createElement('span');
    status.className = 'pad-apply-status';
    bar.appendChild(btn);
    bar.appendChild(status);
    wrap.appendChild(bar);

    let undone = !!(info && info.undone);
    const paint = () => {
        btn.innerHTML = undone
            ? '<i class="fa-solid fa-wand-magic-sparkles"></i> 重新应用'
            : '<i class="fa-solid fa-rotate-left"></i> 撤销';
    };
    paint();
    btn.addEventListener('click', async () => {
        status.classList.remove('pad-hint-error');
        btn.disabled = true;
        status.textContent = undone ? '正在重新应用…' : '正在还原…';
        try {
            const Mvu = await getMvu();
            if (!Mvu || typeof Mvu.replaceMvuData !== 'function') throw new Error('未检测到 MVU');
            const target = undone ? info.applied : info.snapshot;
            // F2（staleness-audit §4）：这颗按钮做的是【整份 MvuData 互换】，不是外科手术式的补丁回退。
            // 「这条记录之后又发生过改动」时（又应用了一次 / 又来了几条回复 / 别的记录也撤销过），撤销会把
            // 那些改动一并抹掉，而按钮上写的还是那句轻飘飘的「撤销」。点下去之前问一句——不拦，只说实话。
            // 比对口径 = 【除 display_data / delta_data 之外的全部】（diagUndoDrifted → diagCmpKey，
            // Task 5 起是全仓唯一那一份；这里原先自带一份逐字复制的 cmpKey，两份迟早会漂）。那两样是
            // MVU 每一轮都会重算的派生数据，把它们算进去会在「状态其实没变」时也弹窗，而假阳性一多，
            // 用户就学会闭眼点确定、守卫等于没有。其余的键（stat_data、schema、initialized_lorebooks…）
            // 都要比：撤销是【整份互换】，它们同样会被这一下盖掉，光比 stat_data 会漏掉「schema /
            // 已初始化世界书被回退」这类。
            // expect = 这条记录声称「现在应该是」的那一份：未撤销态下是它写进去的 applied，已撤销态下是
            // 它回退到的 snapshot。取不到现值（读失败）→ 不问，照旧行为走。
            const expect = undone ? info.snapshot : info.applied;
            let live = null;
            try { live = Mvu.getMvuData(mvuMsgOpts()); } catch (e) { live = null; }
            if (diagUndoDrifted(live, expect)) {
                const okGo = await uiConfirm(undone
                    ? '这条记录之后状态又变过（别的应用 / 新回复）。重新应用会把整份变量换成本次编辑【之后】的那一版，后来的变化会一并丢失。确定吗？'
                    : '这条记录之后状态又变过（别的应用 / 新回复）。撤销会连同后来的变化一起回退，确定吗？');
                if (!okGo) { status.textContent = '已取消。'; btn.disabled = false; return; }
            }
            await Mvu.replaceMvuData(JSON.parse(JSON.stringify(target)), mvuMsgOpts());
            refreshLatestMvuBar();   // replaceMvuData 不发刷新事件，状态栏得自己踢一下
            undone = !undone;
            if (info) info.undone = undone;
            // 🎛 冻结联动撤销（Finding 2）：这条记录的应用当初可能把某些字段的冻结目标改成了【应用后】
            // 的新值（mvuedApply 的「冻结重新武装」）。单纯把 MvuData 换回旧值不够——那些规则仍指着新
            // 值，下一条 AI 回复经过修改器时会把用户刚撤销掉的编辑原样拉回来，「撤销」一回合后就被悄悄
            // 推翻。这里把同一件事反过来做：undone=true（刚点了撤销）→ 目标改回武装前的 prevValue；
            // undone=false（刚点了重新应用）→ 改回武装后的 nextValue。只动【现在仍是 freeze】的规则——
            // 用户此后如果已经解冻了这个字段，那是他自己的后续决定，撤销/重做都不该替他把冻结加回来。
            if (ENABLE_MVU_TRAINER && info && Array.isArray(info.trainerFreeze) && info.trainerFreeze.length) {
                try {
                    const stillFrozen = trainerReadRules().filter(r => r.kind === 'freeze');
                    for (const t of info.trainerFreeze) {
                        const k = mvuedPathStr(t.path);
                        if (stillFrozen.some(r => mvuedPathStr(r.path) === k)) {
                            trainerSetRule(t.path, 'freeze', { value: undone ? t.prevValue : t.nextValue });
                        }
                    }
                } catch (err) {
                    console.warn('[剧情推进] 🎛 冻结联动撤销失败（MvuData 已换回，规则目标可能仍是旧值）：', err);
                }
            }
            paint();
            // 落点提示（whole-branch review FIX 4）：这颗按钮做的是【整份 MvuData 互换】，与首次应用
            // 完全同一种写入，落点同样是最末非系统楼 —— 落在用户自己那一楼上时，值换对了、状态栏却
            // 纹丝不动。诊断卡（addApplyControls）与自动记录条（addNoteUndoControls）的撤销 / 重新应用
            // 早就说这句话，唯独编辑器这条记录一直静默。现算（见 diagUserFloorNotice 头注）。
            const n = diagUserFloorNotice();
            status.textContent = (undone ? '已还原到编辑前的状态。' : '已重新应用。') + (n ? '\n' + n : '');
        } catch (e) {
            status.textContent = '操作失败：' + (e && e.message ? e.message : e);
            status.classList.add('pad-hint-error');
        }
        btn.disabled = false;
    });
}

/* 入口按钮的「它还活着吗」判定（用户报告 2026-08-11：窗口没了之后 🌙 与魔杖项点了都没反应，
   只有回复气泡上的 ✂️ 能把窗口叫回来）。根因：酒馆或别的扩展把宿主容器整块重建（典型是
   innerHTML 往返）后，回来的是【同 id 同外观的克隆节点】——属性全在，addEventListener 绑的
   监听器却随旧节点一起没了；而旧守卫只查「这个 id 存在吗」，于是拒绝重新注入，那颗按钮就永远
   是个哑巴。JS 属性不随 innerHTML 复制，正好用来区分「我们亲手绑过的那颗」与「克隆出来的哑巴」。
   同族做法见 refreshFixChatEntry（楼层 ✂️ 每次渲染事件全量重挂，所以它一直是活的 = 用户唯一
   还能用的入口）。数量不为 1 一律重建：0 = 没了，>1 = 别的扩展搬动过程中被重复插入，收敛掉。 */
const SO_LIVE_FLAG = '__soLiveEntry';
export function soEntryIsLive(id, container) {
    const all = document.querySelectorAll('#' + id);
    if (all.length !== 1) return false;
    const el = all[0];
    return !!el[SO_LIVE_FLAG] && (!container || container.contains(el));
}
export function soMarkEntryLive(el) { el[SO_LIVE_FLAG] = true; return el; }
export function soDropEntries(id) { document.querySelectorAll('#' + id).forEach((e) => e.remove()); }

// 魔杖菜单里的两项一起判、一起重建（它们由本函数成对插入，只补一半会留下顺序错乱的残项）。
export function injectWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    if (soEntryIsLive('pad-wand-button', menu) && soEntryIsLive('pad-wand-recenter', menu)) return;
    soDropEntries('pad-wand-button');
    soDropEntries('pad-wand-recenter');

    const item = document.createElement('div');
    item.id = 'pad-wand-button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<i class="fa-solid fa-moon"></i><span>剧情推进</span>`;
    item.addEventListener('click', () => {
        // Just open our window. SillyTavern's own outside-click handler closes
        // the wand menu (our item isn't a no-close target). Do NOT touch
        // #extensionsMenu here: adding .displayNone (display:none !important)
        // permanently breaks ST's fadeIn and the menu never reopens.
        toggleWindow(true);
    });
    menu.appendChild(soMarkEntryLive(item));

    // 手机专属救援入口：紧随其后放一个「窗口归位（居中）」项。手机用户把窗口拖丢 / 拖到屏外时，这是【永远够得到】
    // 的复位入口——它在 ST 常驻的魔棒菜单里、不在那个可能已不可见的窗口里。桌面用 CSS @media 隐藏（见 style.css）。
    const rc = document.createElement('div');
    rc.id = 'pad-wand-recenter';
    rc.className = 'list-group-item flex-container flexGap5 interactable';
    rc.tabIndex = 0;
    rc.innerHTML = `<i class="fa-solid fa-arrows-to-dot"></i><span>窗口归位</span>`;
    rc.addEventListener('click', () => recenterWindow());
    menu.appendChild(soMarkEntryLive(rc));
}

// 手机「窗口归位」：把窗口复位到【居中 + 默认尺寸 380×540（夹进可见视口）】并存档。经魔棒菜单常驻项触发，故窗口
// 即便被拖到屏外也救得回来（写绝对居中坐标、与当前位置无关；reset 用默认尺寸而非当前可能已拖坏的尺寸）。桌面项被
// CSS 隐藏、不会触发。
function recenterWindow() {
    toggleWindow(true);                       // 关着 / 在屏外都先确保开着
    if (!win) return;
    const c = centeredWindowBox(currentView());   // 无 opts → 默认 380×540（reset 语义：撤销被拖坏的尺寸）
    win.style.left = `${c.left}px`;
    win.style.top = `${c.top}px`;
    win.style.width = `${c.width}px`;
    win.style.height = `${c.height}px`;
    win.style.right = 'auto';
    const s = getSettings();                  // 存档：复位持久化（后续开窗不再回到坏位置 / 坏尺寸）
    s.winLeft = c.left; s.winTop = c.top; s.winWidth = c.width; s.winHeight = c.height;
    save();
}

// 用户功能请求：在 ST 聊天输入栏（#leftSendForm，紧挨 ☰ 菜单键）放一个一键开 / 关神谕侧窗的小按钮（🌙）。
// 默认关——仅当神谕设置里勾了「聊天栏快捷按钮」(showChatBarButton) 才出现；与魔棒入口并存、互不影响。
// 复用 ST 自带的 .interactable / fa- 图标样式，故外观与 ☰ 等原生按钮一致（着色见 style.css）。
export function injectChatBarButton() {
    const bar = document.getElementById('leftSendForm');
    if (!bar) return;
    if (soEntryIsLive('pad-chatbar-button', bar)) return;   // 见 soEntryIsLive：克隆出来的哑巴节点要重建
    soDropEntries('pad-chatbar-button');
    const btn = document.createElement('div');
    btn.id = 'pad-chatbar-button';
    btn.className = 'fa-solid fa-moon interactable';
    btn.title = '剧情推进 —— 点击开 / 关侧窗';
    btn.tabIndex = 0;
    btn.addEventListener('click', () => toggleWindow());   // 无参 = 切换开 / 关
    bar.appendChild(soMarkEntryLive(btn));
}

// 两个「把窗口叫回来」的入口（🌙 聊天栏 + 魔杖菜单两项）在宿主容器被重建后会变成哑巴节点，
// 故挂在已有的那批渲染 / 换聊天事件上按需重挂。两个函数在节点还活着时都是
// O(1) 早返回、一个字节都不碰 DOM，所以可以无条件调（绝不自激）。
export function refreshOracleEntries() {
    try {
        injectWandButton();
        syncChatBarButton();
        syncQrButton();
    } catch (e) { /* 宿主 DOM 异形 → 静默，绝不打断事件链 */ }
}

export function removeChatBarButton() {
    const btn = document.getElementById('pad-chatbar-button');
    if (btn) btn.remove();
}

/* ✂️ 选段校正·输入框上方快捷按钮（1.44.0，opt-in `fixSelBarButton`）——把选段校正入口放到聊天
   输入框【上方】那一排（ST 的快速回复条）。这段代码所有看起来奇怪的地方都源自两条 ST 事实：
   ① 快速回复按钮的原生外观全靠【祖先选择器】`#qr--bar > .qr--buttons .qr--button` —— 按钮必须
      物理落在这个结构里才长得对，光给自己挂 class / 自己写样式都是四不像；
   ② ST 会在切聊天、改快速回复设置时【重建】 `#qr--bar`，把条里的按钮一并冲掉 —— 故必须盯住
      `#send_form` 补挂，一次性注入活不过第一次切聊天。
   点击一律委托 onFixChatEntryClick()（1.42.0 那条已验证的路：确认门 → 选区送达 → 预选开卡），
   本处不另写一套开卡逻辑。 */
export const FIXSEL_BAR_BTN_ID = 'pad-fixsel-qr-btn';
export const FIXSEL_BAR_OWN_CLASS = 'pad-fixsel-own-bar';