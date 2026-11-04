import { soCallModel } from '../../bootstrap.js';
import { convoStreamKeyForMode, persistConvo, saveChatMetadata } from '../../core/chat-metadata.js';
import { migrateChatNamespace } from '../../core/namespace-migration.js';
import { cancelPostReply, postReplyCancelsOnChatSwitch } from '../../core/post-reply.js';
import { POST_REPLY_CALL_TIMEOUT_MS, getCtx, getSettings, uiConfirm } from '../../core/settings.js';

import { addSystemNote, clearNoteOpts, loadConvoForChat } from './cards.js';
import { ADVISOR_REMIND_AFTER, getPath, setPath } from './metadata.js';
import { discardPathEdit, renderPlanBar } from './ui.js';
import { toggleAdvisor } from '../builder/ui.js';
import { buildAdvisorPrompt, primeLwbFromMetadata, stripReasoningTags } from '../chat/context.js';
import { refreshSummaryUI } from '../chat/history.js';
import { chatIdentityKey } from '../chat/send.js';
import { cancelMvuedScan, closeMvuEditor } from '../diagnose/editor.js';
import { getMvuStatData } from '../diagnose/mvu.js';
import { loadDiagSelForChat, refreshWiCustomUI } from '../diagnose/pickers.js';
import { fixDrainParked } from '../fix/staging.js';
import { applyPlanInjection, chatMsgCount, pathActiveNode, pathIsMulti, pathNodeNeedsDetail, pathProgressLabel } from '../fix/templates.js';
import { loadFixCfgForChat } from '../fix/ui.js';
import { buildAdvisorPresetMessages } from '../../presets/messages.js';
import { ADVISOR_SPEEDS, ENABLE_WI_CUSTOM_PICK, ENABLE_WI_EJS_RENDER } from '../../prompts/builtins.js';
import { P } from '../../prompts/registry.js';
import { buildWorldInfo } from '../../st/adapters.js';
import { getHostGlobal } from '../../st/host.js';
import { addMessage } from '../../ui/messages.js';
import { currentOracleMode, refreshDraftCard, toggleWindow } from '../../ui/mode-shell.js';
import { maybeWrapJb, presetCurationActive } from '../../ui/settings.js';
import { abortCtl, clearLiveGenerations, isGenerating, stopGeneration } from '../../core/generation.js';
import { appendConvo, nextCid, selectConvoStream } from '../../core/conversation-store.js';
import { advisorMode } from '../../core/oracle-modes.js';
import { win } from '../../ui/refs.js';
let nodeDetailJob = null;

/* ------------------------------------------------------------------ *
 * 剧情脉络（2.5.0）—— 纯函数层。时钟 now = 主聊天消息数，由调用方注入（chatMsgCount()）。
 * 参谋卡解析出来的 { title, overall, nodes:[{ name, keywords, detail }] } → 存进聊天元数据的脉络：
 * 每个节点带 id 和 status（active / pending / done / skipped），cursor 指向当前节点。
 * ------------------------------------------------------------------ */
export function pathNodeFrom(n, id, status) {
    return {
        id, status,
        name: String(n.name || '').trim(),
        keywords: String(n.keywords || '').trim(),
        detail: String(n.detail || '').trim(),
    };
}
export function buildPath(parsed, speed, now) {
    return {
        title: String(parsed.title || '').trim(),
        overall: String(parsed.overall || '').trim(),
        speed: ADVISOR_SPEEDS[speed] ? speed : 'normal',
        nodes: (parsed.nodes || []).map((n, i) => pathNodeFrom(n, i + 1, i === 0 ? 'active' : 'pending')),
        cursor: 0, nodeStartAt: now, adoptedAt: now, reminded: false,
    };
}

// 完成当前节点：done → 下一个未开始的节点（跨过已跳过的）。没有了 ⇒ ended。
export function pathAdvance(path, now) {
    const cur = pathActiveNode(path);
    if (!cur) return { ended: true };
    cur.status = 'done';
    for (let i = path.cursor + 1; i < path.nodes.length; i++) {
        if (path.nodes[i].status === 'pending') {
            path.nodes[i].status = 'active';
            path.cursor = i;
            path.nodeStartAt = now;
            path.reminded = false;
            return { ended: false, node: path.nodes[i] };
        }
    }
    return { ended: true };
}

// 跳过一个未开始的节点（当前节点没有跳过——完成即推进；已完成的是历史）。
export function pathSkipNode(path, nodeId) {
    const n = (path.nodes || []).find((x) => x.id === nodeId);
    if (!n || n.status !== 'pending') return false;
    n.status = 'skipped';
    return true;
}

// 用新卡替换「当前节点起」剩下的部分（找参谋改改之后采用）：已完成 / 已跳过的历史留着，id 续号不复用。
// 新卡带了标题 / 整体目标就换上，没带就沿用。
export function pathSpliceTail(path, parsed, now) {
    const fresh = parsed.nodes || [];
    if (!fresh.length) return path;
    const maxId = path.nodes.reduce((m, n) => Math.max(m, n.id || 0), 0);
    const head = path.nodes.slice(0, path.cursor);
    path.nodes = [...head, ...fresh.map((n, i) => pathNodeFrom(n, maxId + i + 1, i === 0 ? 'active' : 'pending'))];
    path.cursor = head.length;
    if (String(parsed.title || '').trim()) path.title = String(parsed.title).trim();
    if (String(parsed.overall || '').trim()) path.overall = String(parsed.overall).trim();
    path.nodeStartAt = now;
    path.reminded = false;
    return path;
}

export function pathHasUnplayed(path) {
    return !!(path && path.nodes.some((n) => n.status === 'active' || n.status === 'pending'));
}

/* ------------------------------------------------------------------ *
 * 剧情脉络 —— 集成层（副作用：元数据 + 注入 + 方案条重画 + 侧聊记录）。规矩：纯函数算状态，
 * 这里落盘并把注入整体重登记；注入随后由 applyPlanInjection 现场从元数据推导，不存在第二份真相。
 * ------------------------------------------------------------------ */

// 采用参谋卡。已有没走完的脉络：先确认，再用新卡替换「当前节点起」剩下的部分；否则全新开始。
export async function adoptPath(parsed, speed) {
    if (!parsed || !Array.isArray(parsed.nodes) || !parsed.nodes.length) return false;
    const now = chatMsgCount();
    const existing = getPath();
    let path;
    let note;
    if (existing && pathHasUnplayed(existing)) {
        if (!(await uiConfirm(`「${existing.title || '当前引导'}」还没走完。用这张卡替换剩下的部分吗？已完成的节点会留着。`))) return false;
        path = pathSpliceTail(existing, parsed, now);
        if (ADVISOR_SPEEDS[speed]) path.speed = speed;
        note = `已用这张卡替换剩下的部分，现在是${pathProgressLabel(path)}「${pathActiveNode(path).name}」。`;
    } else {
        path = buildPath(parsed, speed, now);
        note = pathIsMulti(path)
            ? `已开始按剧情脉络「${path.title || '未命名'}」引导（共 ${path.nodes.length} 个节点）：现在是节点 1「${path.nodes[0].name}」，走完了点「完成这个节点」。`
            : '已开始引导：主聊天的 AI 会逐步把剧情推向这个目标（你正常进行 RP 即可）。可以在上方的方案条里调整推进速度、查看注入内容，或停止引导。';
    }
    abortNodeDetailJob();
    discardPathEdit();
    if (!setPath(path)) {
        addSystemNote('无法保存引导：当前似乎没有打开任何聊天。');
        return false;
    }
    const ok = applyPlanInjection();
    renderPlanBar();
    addSystemNote(ok ? note : '已保存，但当前 SillyTavern 不支持注入接口（setExtensionPrompt）——引导不会生效，请更新 ST 版本。');
    maybeWritePathDetail(path);
    return true;
}

// 完成当前节点：推进到下一个；最后一个也完成了就收束（清元数据 + 清注入，主聊天恢复原状）。
export function pathComplete() {
    const path = getPath();
    if (!path) return;
    const multi = pathIsMulti(path);
    abortNodeDetailJob();
    discardPathEdit();
    const r = pathAdvance(path, chatMsgCount());
    if (r.ended) {
        setPath(null);
        applyPlanInjection();
        renderPlanBar();
        addSystemNote(multi
            ? `剧情脉络「${path.title || '未命名'}」全部走完，引导已停止——主聊天恢复原状。`
            : `方案「${path.title || '未命名'}」已完成，引导已停止——主聊天恢复原状。`);
        return;
    }
    setPath(path);
    applyPlanInjection();
    renderPlanBar();
    const writing = pathNodeNeedsDetail(r.node) && wantAutoDetail();
    addSystemNote(`已进入${pathProgressLabel(path)}「${r.node.name}」。`
        + (writing ? '参谋正在按刚演完的剧情写这个节点的详细，写好前先按关键词引导。' : ''));
    maybeWritePathDetail(path);
}

// 放弃：多节点先确认一次（损失比单个方案大）。
export async function pathAbandon() {
    const path = getPath();
    if (!path) return;
    if (pathIsMulti(path) && !(await uiConfirm('确定放弃？整条剧情脉络和引导都会清除，主聊天恢复原状。'))) return;
    abortNodeDetailJob();
    discardPathEdit();
    setPath(null);
    applyPlanInjection();
    renderPlanBar();
    addSystemNote(`「${path.title || '当前引导'}」已放弃，引导已停止——主聊天恢复原状。`);
}

// 「找参谋改改」：什么都不拆——注入照旧（主聊天的引导直到真正采用修订才变），只是开窗进参谋房，落一条代码侧的
// 开场白：真 assistant 条目、随 convoForPrompt 喂回模型（参谋知道自己已经开过口），零模型调用。
// 修订依据（当前脉络的状态块）由 buildAdvisorPathBlock 每次参谋调用都带上，这里不重复。
export async function pathSendBack() {
    const path = getPath();
    if (!path) return;
    toggleWindow(true);
    if (!advisorMode) await toggleAdvisor();   // 开关型：已在参谋房则不动
    // 换房确认里点了「取消」= 留在原来那一房：开场白绝不能落到别的房里。
    if (!advisorMode) return;
    const node = pathActiveNode(path);
    const where = pathIsMulti(path)
        ? `剧情脉络「${path.title || '未命名'}」的${pathProgressLabel(path)}${node ? `「${node.name}」` : ''}`
        : `方案「${path.title || '未命名'}」`;
    const content = P('advisor.sendBack', { where });
    const entry = { id: nextCid(), role: 'assistant', content };
    entry._el = addMessage('assistant', content, entry);
    appendConvo(entry);
    persistConvo();
}

// 推进速度：整条脉络共用一档，换节点时沿用。
export function setPathSpeed(speed) {
    const path = getPath();
    if (!path || !ADVISOR_SPEEDS[speed]) return;
    path.speed = speed;
    setPath(path);
    applyPlanInjection();
    renderPlanBar();
}

// 跳过一个未开始的节点：注入里的「后续」会少一项，所以要重登记。
export function pathSkipNodeUi(nodeId) {
    const path = getPath();
    if (!path || !pathSkipNode(path, nodeId)) return;
    setPath(path);
    applyPlanInjection();
    renderPlanBar();
}

/* 「到了再写」（参谋设置 advisorNodeDetail = 'later'）：轮到一个还没写详细的节点时，请参谋看着已经演出来的剧情补写。
 * 写好直接生效（方案条上可以改）；等的时候先按节点名 + 关键词引导。同一时间只跑一个；聊天、脉络或当前节点变了，
 * 结果作废。「一次写全」下参谋没给详细的节点不自动请求，方案条上有「让参谋写」按钮。 */
export function wantAutoDetail(s = getSettings()) {
    return s.advisorNodeDetail === 'later';
}
export function maybeWritePathDetail(path) {
    if (!pathIsMulti(path) || !wantAutoDetail() || !pathNodeNeedsDetail(pathActiveNode(path))) return;
    void writePathNodeDetail();
}
function pathJobKey(path, node) {
    return `${chatIdentityKey()}|${path.adoptedAt}|${node.id}`;
}
function abortNodeDetailJob() {
    const job = nodeDetailJob;
    nodeDetailJob = null;
    if (job) { try { job.ctl.abort(); } catch (e) { /* ignore */ } }
}
export function nodeDetailWriting(path, node) {
    return !!(nodeDetailJob && path && node && nodeDetailJob.key === pathJobKey(path, node));
}
export async function writePathNodeDetail() {
    const path = getPath();
    const node = pathActiveNode(path);
    if (!node || nodeDetailWriting(path, node)) return;
    abortNodeDetailJob();
    const job = { key: pathJobKey(path, node), ctl: new AbortController() };
    nodeDetailJob = job;
    renderPlanBar();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; job.ctl.abort(); }, POST_REPLY_CALL_TIMEOUT_MS);
    let detail = '';
    let error = '';
    try {
        const s = getSettings();
        const reply = await soCallModel(await buildNodeDetailMessages(path, node, s),
            { signal: job.ctl.signal, maxTokens: Math.max(Number(s.maxTokens) || 0, 4096) });   // 流式跟随设置，与参谋平时的调用同一条路
        detail = parseNodeDetail(reply);
        if (!detail) error = '回复里没有 <NodeDetail> 区块';
    } catch (e) {
        error = timedOut ? '等太久没有回应' : String((e && e.message) || e);
    } finally {
        clearTimeout(timer);
    }
    if (nodeDetailJob !== job) return;   // 已被取消，或被新的一次顶掉
    nodeDetailJob = null;
    const cur = getPath();
    const curNode = pathActiveNode(cur);
    if (!curNode || pathJobKey(cur, curNode) !== job.key) { renderPlanBar(); return; }
    if (error) {
        renderPlanBar();
        addSystemNote(`参谋没写出节点「${curNode.name}」的详细（${error}）——先按关键词引导；可以在方案条上点 ✏️ 自己写，或点「让参谋写」再试一次。`);
        return;
    }
    if (pathNodeNeedsDetail(curNode)) {   // 等的这段时间你自己写了，就不覆盖
        curNode.detail = detail;
        setPath(cur);
        applyPlanInjection();
        addSystemNote(`节点「${curNode.name}」的详细已写好并开始引导，可以在方案条上点 ✏️ 修改。`);
    }
    renderPlanBar();
}
// 请参谋写节点详细的那一组消息：参谋提示词（角色卡、世界书、变量、对话记录、当前脉络）+ 一句请求。
// 世界书和变量现取、显式传给 buildAdvisorPrompt，不碰 generateReply 用的那两个全局。
async function buildNodeDetailMessages(path, node, s) {
    const ctx = getCtx();
    const wi = await buildWorldInfo(undefined, undefined, { renderEjs: ENABLE_WI_EJS_RENDER && !!s.wiRenderEjs });
    const stat = await getMvuStatData();
    const block = buildAdvisorPrompt(ctx, s, { wi, stat: stat ? JSON.stringify(stat, null, 2) : '' });
    const ask = P('advisor.nodeAsk', {
        title: path.title || '', progress: pathProgressLabel(path), name: node.name, keywords: node.keywords || '',
    }, s);
    if (s.advisorUsePreset && presetCurationActive(s)) {
        return buildAdvisorPresetMessages(s, { block, tail: [{ role: 'user', content: ask }] });
    }
    return maybeWrapJb([{ role: 'system', content: block }, { role: 'user', content: ask }], 'advisor', s);
}
function parseNodeDetail(text) {
    const t = stripReasoningTags(String(text || ''));
    const m = t.match(/<Node[_-]?Detail>([\s\S]*?)(?:<\/Node[_-]?Detail>|$)/i);
    return m ? m[1].trim() : '';
}

// 参谋设置里「后面节点的详细什么时候写」两段按钮 + 一行说明。
export function syncNodeDetailSeg() {
    if (!win) return;
    const later = wantAutoDetail();
    win.querySelectorAll('#pad-adv-detail-seg [data-v]').forEach((b) => b.classList.toggle('active', (b.dataset.v === 'later') === later));
    const hint = win.querySelector('#pad-adv-detail-hint');
    if (hint) {
        hint.textContent = later
            ? '参谋先只写第 1 个节点的详细；每完成一个节点，参谋看着刚演完的剧情写下一个。更贴合，但每换一个节点多一次调用。'
            : '参谋出方案时就把每个节点的详细都写好，不多花调用。演着跑偏了，在方案条上点 ✏️ 手改。';
    }
}

// 停滞提醒（一次）：当前节点挂太久就提醒一句——一直静默挂着引导，是「AI 老惦记那个节日」这类报告的来源。
export function checkPlanReminder() {
    const path = getPath();
    if (!path || path.paused || path.reminded) return;
    const n = chatMsgCount() - (path.nodeStartAt || 0);
    if (n < ADVISOR_REMIND_AFTER) return;
    path.reminded = true;
    setPath(path);
    const node = pathActiveNode(path);
    addSystemNote(pathIsMulti(path)
        ? `剧情脉络「${path.title || '未命名'}」的${pathProgressLabel(path)}${node ? `「${node.name}」` : ''}已持续 ${n} 条消息——走完了就点「完成这个节点」，想调整可以点「找参谋改改」。`
        : `方案「${path.title || '未命名'}」已持续 ${n} 条消息——剧情走到了吗？可以在剧情参谋里问我「检查进度」，或在上方方案条里完成 / 调整它。`);
}


// Chat switched (or first chat loaded): re-register from THIS chat's metadata —
// registers its plan, or clears any previous chat's injection. The extension's
// only event-driven side effect; everything else stays pull-based.
export function onChatChanged() {
    const ctx = getCtx();
    if (migrateChatNamespace(ctx.chatMetadata)) saveChatMetadata();
    primeLwbFromMetadata();   // 小白X 记忆桥(a)：从本聊天 metadata 快照回填缓存（重开酒馆 / 切聊天即暖；自守门）
    // ✨ Phase 4 P-CORRUPT 的【1.77.0 修订】（Prince 亲裁 2026-09-04）：切聊天不再无条件作废在途那一轮。
    //   · 🩺 自动诊断 / 🎛 修改器写的是【当前聊天】的 MVU 状态 —— 切走即作废，这一条不变。
    //   · ✨ 自动校正 / 📋 模板任务 只往【那条回复】里写一个新 swipe —— 让它跑完，落地时发现聊天已切走就
    //     暂存（fixLandOrPark），等回到那个聊天再落（下面的 fixDrainParked）。此前这里的无条件 cancel 把
    //     已经买单的模型回复直接扔掉。
    // 判据里的 postReplyBusy 那一半同样不可少：postReplyCancelled 是【轮次级】状态，没有轮次在飞时置位就是
    // 一面粘滞的旗——两个自动开关都关的用户 maybePostReply 从不清零，按钮路的产出会被永久静默丢弃
    //（1.77.0 根因，见 runCustomTaskNow）。判据与 CHAT_CHANGED 的 supersede 监听器共用同一份。
    if (postReplyCancelsOnChatSwitch()) cancelPostReply();
    // 保活：切聊天必须显式中断在途的后台锻造 / 深度精简并清两槽——它们属于【旧聊天】（用旧卡/草稿生成），
    // 绝不能把结果写进新聊天。清空后 runForge / runCondenseDepth 的完成/失败分支会看到身份不符而丢弃落盘。
    if (isGenerating && abortCtl) stopGeneration();
    clearLiveGenerations();
    clearNoteOpts();      // 换聊天即作废本会话的记录按钮材料：撤销 / 换 swipe 针对的是旧聊天的 MVU / 楼层，跨聊天重挂会写错对象
    closeMvuEditor();     // 🎛 变量编辑器：卡里摆的是【旧聊天】的 stat_data 快照与脏表，跨聊天按「应用」就是往新聊天写旧路径 —— 直接关掉（没开时是空操作）
    cancelMvuedScan();    // 🎛 并掐掉在途的「分析取值规则」（它的结果已注定被丢弃：白烧钱，还会让新聊天的扫描键僵在「分析中…」最长 120 秒）。刻意不放进 closeMvuEditor —— ✕ / 点背景关卡不该中断本聊天的扫描
    // 剧情脉络：「到了再写」在途的调用属于旧聊天，掐掉；方案条上没保存的修改作废。
    abortNodeDetailJob();
    discardPathEdit();
    applyPlanInjection();
    if (win) renderPlanBar();
    checkPlanReminder();
    selectConvoStream(convoStreamKeyForMode(currentOracleMode(), getSettings()));   // 新聊天：可见流复位到当前模式应在的房间（旧流已由自身写入落盘；这里不 sync，免把旧 convo 灌进新聊天元数据）
    loadConvoForChat();   // 用户功能请求：把本聊天保存的侧聊历史载入窗口（per-chat 持久化）
    refreshSummaryUI();   // 用户功能请求：刷新本聊天的运行概要编辑器
    loadDiagSelForChat(); // 用户功能请求：载入本聊天的诊断「精选世界书条目」选择
    if (ENABLE_WI_CUSTOM_PICK) refreshWiCustomUI();   // 🌐 自定义范围清单随聊天重画（它自己读 metadata）
    loadFixCfgForChat();  // ✨ 校正模式 Phase 4：把校正控件重置成本聊天的生效配置（per-chat 持久化）
    if (win) refreshDraftCard();  // 角色工坊：把本聊天保存的草稿常驻卡载入 / 清空（per-chat 持久化，随切换刷新）
    // ✨/📋 1.77.0：回到这个聊天时，把切走那会儿暂存下来的校正 / 模板成品落地。放在【最后】——记录要落进
    // loadConvoForChat() 刚载好的那份侧聊里。不 await（与 drainPendingPostReply 同一约定：事件监听不该被
    // 一趟 saveChat 拖住）；没有暂存时是即时返回的空操作。
    Promise.resolve(fixDrainParked()).catch((e) => console.warn('[剧情推进] 暂存的校正结果落地失败：', e));
}

// 1.3.2 暂停引导（用户功能请求：想先跑偏一阵再回来）：paused 记在当前聊天的剧情脉络上。暂停期间主聊天不注入、
// 不弹停滞提醒；节点、进度、推进速度都原样保留。继续时从此刻重新计时。
export function guidePaused(path = getPath()) {
    return !!(path && path.paused);
}
export function toggleGuidePause() {
    const path = getPath();
    if (!path) return;
    if (path.paused) {
        delete path.paused;
        path.reminded = false;
        path.nodeStartAt = chatMsgCount();
    } else {
        path.paused = true;
    }
    setPath(path);
    applyPlanInjection();
    renderPlanBar();
    const toastr = getHostGlobal('toastr');
    if (toastr) {
        toastr.info(path.paused ? '已暂停引导：主聊天先不注入剧情导向，进度都保留，随时点「继续」。' : '已继续引导。',
            '剧情推进', { timeOut: 2500 });
    }
}