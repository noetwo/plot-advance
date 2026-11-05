import { confirmModeSwitch, persistConvo } from '../../core/chat-metadata.js';
import { cancelPostReply } from '../../core/post-reply.js';
import { POST_REPLY_CALL_TIMEOUT_MS, getCtx, getSettings } from '../../core/settings.js';

import { addSystemNote, showTyping } from '../advisor/cards.js';
import { buildFixPrompt, buildSpanMessages, parseFixSpan, renderFixResultHtml, stripMechanismBlocks } from '../chat/context.js';
import { appendNoteToRoom, registerFixApply, scrollToBottom } from '../chat/history.js';
import { isUserAbort } from '../chat/send.js';
import { extractExcludedSections, fixKeepPlaceholder, getLatestAiMessage } from '../diagnose/mvu.js';
import { autoFixNoteContent, customTaskNoteContent } from '../diagnose/schema.js';
import { clampFixAutoMinChars, composeFixedReply, composeFixedReplyDetailed, fixJoinTable, fixPiecePlan, fixPieceSummary, fixSpliceTable, renderDiffCard } from './algorithms.js';
import { captureFixContext, fixFingerprint, fixOutputTruncated, fixScopeNoteText, renderFixCard } from './capture.js';
import { applyFixInPlace, fixActionForMessage, isFixedReply, reapplyFix, registerFixActionPainter, resolveFixAction, undoFix } from './writeback.js';
import { fixFailureReason } from './staging.js';
import { fixUsePresetFor, getEffectiveFixCfg, getFixCfg, resolveFixModeCfg, setFixCfg } from './templates.js';
import { updateFixVerdict } from './ui.js';
import { buildFixPresetMessages } from '../../presets/messages.js';
import { ENABLE_FIXSEL_CHAT_ENTRY, ENABLE_FIX_CUSTOM_TASK, ENABLE_FIX_PIECEWISE, ENABLE_FIX_SELECT, ENABLE_FIX_TAP_SELECT, ENABLE_REPLY_FIX, FIXSEL_CH_NUDGE_WIN, FIXSEL_CH_PAGE, MULTIFIX_CONCURRENCY, MULTIFIX_MAX_PINS } from '../../prompts/builtins.js';
import { buildFixSelOverlayHtml, buildFixSelPickerHtml, compileFixTargets, fixEffMaxTokens, fixEffectivelyUnchanged, fixNoOp, fixSelDispatchMode, fixSelGraphemes, fixSelJudgeTap, fixSelPickMode, fixSelUnits, fixTargetOverrides, mapSelectionToRaw, multiFixRunnable, normalizePinAdd, resolvePinInstruction, resolveRecordedSelection, spliceSpan, spliceSpansBackToFront, validateSpanFix } from '../../prompts/helpers.js';
import { callDirect, callProfile, callProfileStream, resolveEndpointUrl, streamDirect } from '../../transport/direct.js';
import { addFixApplyControls, addMessage, parseFixedReply, soFollowStream } from '../../ui/messages.js';
import { enterFixMode, toggleWindow, updateFixButtonVisual } from '../../ui/mode-shell.js';
import { maybeWrapJb, presetCurationActive } from '../../ui/settings.js';
import { beginGeneration, finishGeneration, isGenerating } from '../../core/generation.js';
import { appendConvo, convo, nextCid } from '../../core/conversation-store.js';
import { fixMode } from '../../core/oracle-modes.js';
import { win } from '../../ui/refs.js';

let fixChatSelSnap = null;
let fixSelState = null;
let fixSelCard = null;
let fixSelStored = null;
let fixSelMode = 'drag';
let fixSelExpandArmed = false;
let fixSelDebug = false;
let fixSelDebugLines = [];
const fixSelGate = { down: null, lastScrollAt: -1e9, active: new Set() };
let fixSelSegOk = false;

const FIX_TRANSPORT_DEPENDENCIES = {
    callDirect,
    callProfile,
    callProfileStream,
    resolveEndpointUrl,
    streamDirect,
};

/* ------------------------------------------------------------------ *
 * ✂️ 选段校正·主聊天入口（1.42.0，spec 2026-07-27-fixsel-chat-entry）：最新 AI 楼层动作行上的 ✂️ 按钮。
 * RCMM（RightClickMessageMenu 三方扩展）的右键菜单靠克隆 .mes_button 行成菜单 → 真按钮 = 自动进菜单，
 * 零耦合；没装 RCMM 的用户直接点按钮。划选追踪器：点按钮/菜单那一刻浏览器选区已塌，所以 selectionchange
 * 时记下「最后一次完整落在带 mesid 楼层 .mes_text 里的选区」，点击时取用（是否最新楼层由取用侧判）。
 * ------------------------------------------------------------------ */
const FIXSEL_CHAT_CTX_LEN = 40;      // 渲染层前后文各取几字（映射阶梯②消歧）
const FIXSEL_CHAT_TTL_MS = 180000;   // 划选记忆保鲜期 3 分钟（防很久前的旧划选还魂预选）
           // { text, prefix, suffix, mesIdx, ts } | null

// 从 DOM Range 提取划选快照：两端点须同在【带 mesid 的 .mes】的同一个 .mes_text 里（状态栏 iframe 是另一份
// document，天然进不来）。prefix/suffix 取渲染层文本（与 Range.toString 同一语义）。不读 ctx——纯 DOM 可单测。
function extractChatSelRange(range) {
    try {
        if (!range || range.collapsed) return null;
        const text = range.toString();
        if (!text || text.trim().length < 2) return null;
        const owner = (node) => {
            const el = (node && node.nodeType === 1) ? node : (node ? node.parentElement : null);
            return el ? el.closest('.mes_text') : null;
        };
        const a = owner(range.startContainer);
        if (!a || a !== owner(range.endContainer)) return null;
        const mes = a.closest('.mes');
        const mesIdx = mes ? Number(mes.getAttribute('mesid')) : NaN;
        if (!Number.isInteger(mesIdx)) return null;
        const doc = range.startContainer.ownerDocument || document;
        const pre = doc.createRange();
        pre.selectNodeContents(a);
        pre.setEnd(range.startContainer, range.startOffset);
        const startOff = pre.toString().length;
        const whole = doc.createRange();
        whole.selectNodeContents(a);
        const fullText = whole.toString();
        const endOff = startOff + text.length;
        return {
            text,
            prefix: fullText.slice(Math.max(0, startOff - FIXSEL_CHAT_CTX_LEN), startOff),
            suffix: fullText.slice(endOff, endOff + FIXSEL_CHAT_CTX_LEN),
            mesIdx,
        };
    } catch (e) { return null; }
}

// 记录：提取成功才覆盖——塌陷/出界的选区【不抹掉】刚记下的好选区（点菜单前选区常先塌一次，这正是追踪器
// 存在的理由）。顺手清过期残留。
function recordChatSelection(range) {
    const snap = extractChatSelRange(range);
    if (snap) fixChatSelSnap = { ...snap, ts: Date.now() };
    else if (fixChatSelSnap && (Date.now() - fixChatSelSnap.ts) > FIXSEL_CHAT_TTL_MS) fixChatSelSnap = null;
}
export function clearFixChatSel() { fixChatSelSnap = null; }
// 取用（点 ✂️ 时）：楼层仍是最新 AI + 保鲜期内 → 返回快照。【不消费】——送达开卡那步才消费（spec 决定 5/6：
// 确认弹窗被拒时留着，重试点一次还在）。
function takeFixChatSel(latestIdx, now) {
    const s = fixChatSelSnap;
    if (!s) return null;
    if (s.mesIdx !== latestIdx) return null;
    if ((now === undefined ? Date.now() : now) - s.ts > FIXSEL_CHAT_TTL_MS) return null;
    return s;
}

// selectionchange 驱动的划选追踪（守卫在函数内；try 包死——追踪器绝不打扰任何东西）。
export function onChatSelectionChange() {
    if (!ENABLE_FIXSEL_CHAT_ENTRY || !ENABLE_REPLY_FIX || !ENABLE_FIX_SELECT) return;
    try {
        const s = window.getSelection && window.getSelection();
        if (s && s.rangeCount && !s.isCollapsed) recordChatSelection(s.getRangeAt(0));
    } catch (e) { /* 静默 */ }
}

// 最新 AI 楼层 ✂️ 按钮（幂等重挂）：先拔光旧的，再（门都开着且有最新 AI 楼层时）插到该楼 .mes_buttons 的
// ✏️ 编辑键之前。ST 编辑/滑动会整层重建 DOM——「每次事件全量重挂」是唯一可靠形态。DOM 缺位一律静默
//（jsdom / TauriTavern 异形安全）。RCMM 克隆 .mes_button 行成右键菜单 → 本按钮自动进菜单，零耦合。
export function refreshFixChatEntry() {
    try {
        document.querySelectorAll('.pad-fixsel-chat-entry').forEach((b) => b.remove());
        if (!ENABLE_FIXSEL_CHAT_ENTRY || !ENABLE_REPLY_FIX || !ENABLE_FIX_SELECT) return;
        // 1.77.0 用户请求：可藏起这颗 ✂️（opt-out `fixSelRowButton`，默认开）。门必须排在上面
        // 「先拔光」【之后】——取消勾选才会当场生效；只认显式 false，老档缺键 = 照挂（迁移安全）。
        if (getSettings().fixSelRowButton === false) return;
        const latest = getLatestAiMessage();
        if (!latest || latest.idx < 0) return;
        const mes = document.querySelector('#chat .mes[mesid="' + latest.idx + '"]');
        const row = mes ? mes.querySelector('.mes_buttons') : null;
        if (!row) return;
        const btn = document.createElement('div');
        btn.className = 'mes_button pad-fixsel-chat-entry fa-solid fa-scissors';
        btn.title = '选段校正 (划选正文后点击)';   // ASCII 括号是刻意的：RCMM 竖排菜单按 (…) 拆成「标签 + 悬停提示」
        btn.addEventListener('click', () => {   // RCMM 菜单会模拟 click + pointerup——只挂 click，天然单次
            Promise.resolve(onFixChatEntryClick()).catch((e) => console.warn('[剧情推进] 选段入口点击失败：', e));
        });
        const edit = row.querySelector('.mes_edit');
        if (edit) row.insertBefore(btn, edit); else row.appendChild(btn);
    } catch (e) { /* 主聊天 DOM 异形 → 静默不挂 */ }
}

// 过门收尾等待（终审修）：确认「仍要切换」后，被中止那次生成的 finally 要过一拍才放下 isGenerating——
// 有界轮询等它落地（fail-open：超时照样往下走、撞原有守卫出提示，绝不弱化守卫本身、绝不卡死）。
function soWaitGenIdle(maxMs) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
            if (!isGenerating || (Date.now() - t0) >= maxMs) { resolve(); return; }
            setTimeout(tick, 50);
        };
        tick();
    });
}

// 点 ✂️（或 RCMM 菜单克隆项）：确认在前、动 UI 在后（spec 决定 6「拒绝零足迹」——确认是 ST 自己的主题化
// 弹窗，与本窗开合无关；拒绝 = 屏上零变化、追踪器不消费、重试还在）。过门后走无门本体 enterFixMode()
//（不复用 toggleFix＝不弹第二次确认）。
export async function onFixChatEntryClick() {
    if (!ENABLE_FIXSEL_CHAT_ENTRY || !ENABLE_REPLY_FIX || !ENABLE_FIX_SELECT) return;
    const latest = getLatestAiMessage();
    if (!latest || latest.idx < 0) return;
    const presel = takeFixChatSel(latest.idx);
    const needEnter = !fixMode;   // enterFixMode 会翻转 fixMode——先拍板，两处分支同一判据
    if (needEnter) {
        if (!(await confirmModeSwitch('fix'))) return;
    }
    toggleWindow(true);
    if (needEnter) {
        enterFixMode();
        await soWaitGenIdle(2000);   // 终审修：过门=用户已同意中止在途回复，等 abort 的 finally 放下 isGenerating 再开卡
    }
    openFixSelectCard(presel || undefined);
}

/* ------------------------------------------------------------------ *
 * ✂️ 选段校正（1.27.0，Part C）：划选卡 + 选区采集。手动模式专属；展示最新 AI 回复【当前 swipe 的原始 m.mes】
 * 于只读 textarea——划选定位到字符偏移，回插精确（片段之外的字节永不进模型、永不变，结构块构造性安全）。
 * 采集规则仿 GG corrections.js（5 条，见下）。开始校正 → runFixSelect。整篇手动校正独立并存、不受影响。
 * ------------------------------------------------------------------ */
    // { idx, swipeId, fingerprint, start, end, text, full, pins }
     // 懒建一次、复用
   // 存下的选区 { start, end }（失焦后信它——浏览器失焦常报损坏范围）

/* ------------------------------------------------------------------ *
 * ✂️ 点选模式（ENABLE_FIX_TAP_SELECT）的模块级前提。权威状态【仍然只有】一个精确草稿 fixSelStored
 * + 钉选表 fixSelState.pins —— 单元下标永远只是查表结果，不是状态（R1 的 index+delta 方案会在扩选
 * 时悄悄丢掉已修剪的那一头，四人一致否掉）。模式在开卡时定一次，中途绝不因旋转 / 插鼠标而改。
 * ------------------------------------------------------------------ */
          // 'tap' | 'drag'
    // 扩选一次性武装：下一次被接受的点击取并集后立即解除
          // 裁定 0.3：localStorage['pad.fixsel.debug'] 打开的逐手势日志
        // 环形缓冲（≤400 行），镜像进卡里那个只读文本框
// 点击闸门的记录（按下那一刻的时间/坐标/滚动位 + 在按的指针集合）。住在模块级【只】为了让
// fixSelApplyMode 能在每次开卡 / 切模式时把它归零（复审 #4）；布线仍全在 buildFixSelCard 里。

          // 微调可用性：开卡拿 fixSelGraphemes 探一次（Intl.Segmenter 缺席 → 置灰 + 说明，绝不手搓拆字）

// 开卡时定一次模式：旗关恒拖选；否则存过的偏好赢，没存过看 (hover:none)+(pointer:coarse)。
// localStorage / matchMedia 在隐私模式与老 WebView 上会缺席或抛 → 一律按「没存过 / 不是手机」处理。
function fixSelResolveMode() {
    if (!ENABLE_FIX_TAP_SELECT) return 'drag';   // 点选杀死开关读点①
    let pref = null;
    try { pref = localStorage.getItem('pad.fixsel.mode'); } catch (e) { pref = null; }
    const coarse = typeof window.matchMedia === 'function' && !!window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    return fixSelPickMode(pref, coarse);
}

// 提示行文案的唯一出口（两种模式各一套说法）。拖选三句与 1.78.0 逐字节相同——那是回归钉，别动。
function fixSelHint(kind, n) {
    const tap = fixSelMode === 'tap';
    if (kind === 'pinned') return tap ? `已钉住 ${n} 段——可继续点选下一段，或直接开始。` : `已钉住 ${n} 段——可继续划选下一段，或直接开始。`;
    if (kind === 'none-open') return tap ? '未选中片段——请轻点上方一句。' : '未选中片段——请在上方文本里划选。';
    return tap ? '未选中片段——请轻点上方一句。' : '未选中片段——请在上方文本里划选（至少 2 个字）。';
}

// 被拒文案的唯一出口（复审 #6：满 8 段那一句原先在 📌 与轻点各写了一遍，改文案必漏一处）。
// reason 直接用 normalizePinAdd 自己的词汇（'overlap' / 'cap' / 'empty'），外加只有点选才可能发生
// 的 'expand-cross'。'cap' 与模式无关；其余两种模式各一句。拖选那几句与 1.78.0 逐字节相同——回归钉。
function fixSelRefuse(reason, n) {
    const tap = fixSelMode === 'tap';
    if (reason === 'cap') return `一次最多钉 ${MULTIFIX_MAX_PINS} 段。`;
    if (reason === 'expand-cross') return `扩选会跨过片段${n}——请分开钉住。`;
    if (reason === 'overlap') return tap ? `这句在片段${n} 里——先移除再重选。` : `与片段${n}重叠——换一段划选。`;
    return tap ? '这句太短（至少 2 个字）。' : '这段去掉首尾空白后太短（至少 2 个字）。';
}

// 裁定 0.3 的逐手势日志（一行一条，环形 ≤400 行）。开关没开 = 不建 DOM、不攒缓冲、零开销。
// 每条 apply 都印 activeElement（§5 opus：藏起来的 textarea 会不会又偷偷拿到焦点，只能这样看见）。
function fixSelLog(kind, f) {
    if (!fixSelDebug) return;
    const o = f || {};
    const v = (x) => (x === undefined || x === null ? '-' : x);
    const sel = (fixSelStored && fixSelStored.end > fixSelStored.start) ? (fixSelStored.end - fixSelStored.start) : 0;
    const act = (document.activeElement && document.activeElement.tagName) ? document.activeElement.tagName : '-';
    const t = (performance.now() / 1000).toFixed(2).padStart(7);
    fixSelDebugLines.push(`${t} ${kind} dt=${v(o.dt)} dx=${v(o.dx)} dy=${v(o.dy)} dTop=${v(o.dTop)} since=${v(o.since)} reason=${v(o.reason)} unit=${v(o.unit)} sel=${sel} mode=${fixSelMode} active=${act}`);
    if (fixSelDebugLines.length > 400) fixSelDebugLines.shift();
    const box = fixSelCard ? fixSelCard.querySelector('.pad-fixsel-debuglog') : null;
    if (box) box.value = fixSelDebugLines.join('\n');
}

// 开卡时读一次调试开关：开 → 在 #pad-fixsel-body 末尾挂一个可全选复制的只读文本框（不碰剪贴板 API，
// 手机上不需要授权）；关 → 连元素都不留（开过又关掉时把上一次那个撤走）。
function fixSelDebugInit(card) {
    let on = false;
    try { on = !!localStorage.getItem('pad.fixsel.debug'); } catch (e) { on = false; }
    fixSelDebug = on;
    fixSelDebugLines = [];
    let box = card.querySelector('.pad-fixsel-debug');
    if (!on) { if (box) box.remove(); return; }
    if (!box) {
        box = document.createElement('details');
        box.className = 'pad-fixsel-debug';
        box.innerHTML = '<summary>调试日志</summary><textarea class="pad-fixsel-debuglog" readonly></textarea>';
        card.querySelector('#pad-fixsel-body').appendChild(box);
    }
    box.querySelector('.pad-fixsel-debuglog').value = '';
}

// 贴底操作条的从属态：清除只在有草稿时可点；扩选按钮的字与 on 类跟着一次性武装走。
// 凡是刷新提示行的地方都要顺手叫它一次（apply / 📌 / 移除 × / 开卡）。
function fixSelSyncStrip(card) {
    if (!ENABLE_FIX_TAP_SELECT || !card) return;
    const clearBtn = card.querySelector('.pad-fixsel-clear');
    const expandBtn = card.querySelector('.pad-fixsel-expand');
    const adjustBtn = card.querySelector('.pad-fixsel-adjust');
    const has = !!(fixSelStored && fixSelStored.end > fixSelStored.start);
    if (clearBtn) clearBtn.disabled = !has;
    if (expandBtn) {
        expandBtn.textContent = fixSelExpandArmed ? '取消扩选' : '扩选';
        expandBtn.classList.toggle('on', fixSelExpandArmed);
    }
    // 微调要两个前提：手上有草稿，而且这个浏览器拆得了字素。拆不了就一直灰着并把原因写在 title 上
    //（§2「No Intl.Segmenter」：宁可少一个功能，也绝不手搓拆字把 ZWJ 家庭 / 旗帜拆散）。
    // 还有第三个前提（复审 #7）：钉满 8 段时 fixSelChProbe 的每一格都会被 normalizePinAdd 的 cap 挡掉 ——
    // 开出来就是一窗全灰的格子、还没有一句解释。不如根本不让它开。
    if (adjustBtn) {
        const capped = ((fixSelState && fixSelState.pins) || []).length >= MULTIFIX_MAX_PINS;
        adjustBtn.disabled = !has || !fixSelSegOk || capped;
        adjustBtn.classList.toggle('pad-fixsel-adjust-na', !fixSelSegOk);
        if (fixSelSegOk) adjustBtn.removeAttribute('title');
        else adjustBtn.title = '此浏览器不支持逐字微调';
    }
}

// 把卡切进当前模式（开卡一次、头部切换一次）：类 / 按钮态 / 标题 / 切句表 / 信息行落位 / 重画。
// 点选：textarea 落进一个 display:none 的祖先【并且】blur()——光靠 opacity/visibility/移出屏藏不死它
//（§5 opus：那两个老监听会在每次轻点后 50ms 把草稿踩回去）；信息行连同那唯一一颗 📌【搬】进滚动器
// 外面的贴底操作条（是搬不是克隆：一个元素、一处布线），软键盘弹起时正文照旧可见（裁定 0.2）。
function fixSelApplyMode(card) {
    if (!ENABLE_FIX_TAP_SELECT || !card) return;
    const tap = fixSelMode === 'tap';
    card.classList.toggle('pad-fixsel-tap', tap);
    card.querySelectorAll('.pad-fixsel-mode-btn').forEach((b) => b.classList.toggle('on', b.dataset.mode === fixSelMode));
    // 标题文字的唯一写点就是那个 span（旗开时 buildFixSelCard 一定建了它，复审 #2）——1b #e：原先那条
    // 「找不到 span 就改文本节点」的兜底是死代码（旗关时本函数早已 return），删掉，不留第二个写法。
    const titleTx = card.querySelector('#pad-fixsel-head .pad-fixsel-title-text');
    if (titleTx) titleTx.textContent = tap ? ' ✂️ 选段校正 —— 轻点要改的句子' : ' ✂️ 选段校正 —— 划选要改的片段';
    fixSelExpandArmed = false;
    // 闸门记录按【每次开卡 / 每次切模式】归零（复审 #4）：万一有一次抬手被吃掉（页面被别的扩展挡下、
    // 切后台），残留的 pointerId 会让此后每一次轻点都被判成「多指」——重开一次卡就该干净。
    fixSelGate.down = null;
    fixSelGate.active.clear();
    // 1b #d：上一次滚动的时刻也一起归零。它的含义是「本次开卡里离上一次滚动多久」，上一张卡关掉前
    // 那一下滚动与这一次无关；留着它，关卡后 120ms 内重开的第一次轻点会被 scroll-quiet 白白挡掉。
    fixSelGate.lastScrollAt = -1e9;
    // 微调选择器不跨模式、也不跨开卡：这里统一收起来（开卡走这条、头部切换也走这条）。真正的「落定 /
    // 还原」在卡里那对 openChooser/closeChooser 手上，切换前已经先落定过了，这一下只是保证屏上不留残影。
    const chBox = card.querySelector('.pad-fixsel-chooser');
    if (chBox) chBox.classList.remove('open');
    // 开窗期间藏起钉选 chips / 整体要求的那个标记也一并撤掉。钉选框的【内联】display 不在这里还原：
    // 走到这儿只有两条路——开卡（紧接着 renderFixSelPins 会重写它）与头部切换（切换处理器已经先
    // closeChooser(true) 还原过了），两条路都不会留下一个藏着的钉选框。
    card.classList.remove('pad-fixsel-ch-open');
    const body = card.querySelector('#pad-fixsel-body');
    const wrap = card.querySelector('.pad-fixsel-wrap');
    const strip = card.querySelector('.pad-fixsel-tapstrip');
    const inforow = card.querySelector('.pad-fixsel-inforow');
    // 清除按钮也是【搬】不是克隆（复审 #1）：拖选模式下贴底操作条整条不显示，撞上「与钉段重叠」或
    // 「满 8 段」的草稿就既钉不进、又清不掉，而裁定 0.4 会一直拦着开始校正 —— 死胡同。搬到信息行里
    // 紧挨 📌，两种模式同一个节点、同一处布线、同一处 disabled 刷新（fixSelSyncStrip）。
    const clearBtn = card.querySelector('.pad-fixsel-clear');
    const tapbtns = card.querySelector('.pad-fixsel-tapbtns');
    const pinBtn = card.querySelector('.pad-fixsel-pin-btn');
    // 1.79 Prince 实报（长回复 + 点选）：点选层不封顶，于是钉选 chips 与「整体要求」框被顶到折叠线
    // 以下——用户看不见自己钉了什么，更找不到写要求的框。它们跟信息行、清除一样【搬】进贴底条
    //（同一个节点、布线一字不动：renderFixSelPins 与 go 都是 card.querySelector 现查）。
    // 贴底条里的顺序恒为：信息行 → 钉选 chips → 整体要求 → 按钮排。
    const pinsBox = card.querySelector('.pad-fixsel-pins');
    const instrBox = card.querySelector('.pad-fixsel-instr');
    if (tap) {
        if (fixSelState) fixSelState.units = fixSelUnits(fixSelState.full);   // 查表用，开卡与切换时重算
        const ta = card.querySelector('.pad-fixsel-text');
        try { ta.blur(); } catch (e) { /* ignore */ }
        if (strip && inforow && inforow.parentElement !== strip) strip.insertBefore(inforow, strip.firstChild);
        if (strip && tapbtns && pinsBox && instrBox) {   // 位置已经对了就不搬（搬动会让正在输入的框失焦）
            if (pinsBox.parentElement !== strip || pinsBox.nextElementSibling !== instrBox) strip.insertBefore(pinsBox, tapbtns);
            if (instrBox.parentElement !== strip || instrBox.nextElementSibling !== tapbtns) strip.insertBefore(instrBox, tapbtns);
        }
        if (clearBtn && tapbtns && clearBtn.parentElement !== tapbtns) tapbtns.appendChild(clearBtn);   // 回到 微调 之后
    } else {
        if (body && wrap && inforow && inforow.parentElement !== body) body.insertBefore(inforow, wrap.nextSibling);
        if (body && inforow && pinsBox && instrBox) {   // 回到滚动体里的原顺序：正文 → 信息行 → chips → 要求
            if (pinsBox.parentElement !== body || pinsBox.previousElementSibling !== inforow) body.insertBefore(pinsBox, inforow.nextSibling);
            if (instrBox.parentElement !== body || instrBox.previousElementSibling !== pinsBox) body.insertBefore(instrBox, pinsBox.nextSibling);
        }
        if (clearBtn && inforow && pinBtn && clearBtn.parentElement !== inforow) inforow.insertBefore(clearBtn, pinBtn.nextSibling);
    }
    fixSelSyncStrip(card);
    paintFixSelOverlayAll(card);
    fixSelLog('MODE', { reason: fixSelMode });
}

// 点选层重画：整块 innerHTML 换 + scrollTop 保存/恢复（探针实测 30 次轻点 0 跳动）。所有重画点
//（📌 / 移除 × / 预选 / 失焦）都经 paintFixSelOverlayAll 分流到这里，所以不需要第二套重画调用点。
function renderFixSelPicker(card) {
    const body = card.querySelector('#pad-fixsel-body');
    const picker = card.querySelector('.pad-fixsel-picker');
    if (!body || !picker) return;
    const top = body.scrollTop;
    picker.innerHTML = buildFixSelPickerHtml(
        (fixSelState && fixSelState.full) || '',
        (fixSelState && fixSelState.units) || [],
        fixSelStored,
        (fixSelState && fixSelState.pins) || []);
    body.scrollTop = top;
}

// 点进已钉段时闪一下那段：chip 行与点选层里属于它的片同时加 pad-fixsel-flash（CSS 两拍描边），
// 动画结束自摘。jsdom 不发 animationend，类留着也无害。
function fixSelFlashPin(card, idx) {
    const pin = ((fixSelState && fixSelState.pins) || [])[idx];
    if (!pin) return;
    const targets = [];
    const rows = card.querySelectorAll('.pad-fixsel-pinrow');
    if (rows[idx]) { const tag = rows[idx].querySelector('.pad-fixsel-pintag'); if (tag) targets.push(tag); }
    card.querySelectorAll('.pad-fixsel-picker .pad-fixsel-u-pin').forEach((sp) => {
        if (Number(sp.dataset.s) >= pin.start && Number(sp.dataset.e) <= pin.end) targets.push(sp);
    });
    targets.forEach((elm) => {
        elm.classList.remove('pad-fixsel-flash');
        void elm.offsetWidth;   // 强制回流：连点同一段时动画要能重放
        elm.classList.add('pad-fixsel-flash');
        elm.addEventListener('animationend', () => elm.classList.remove('pad-fixsel-flash'), { once: true });
    });
}

// 保险带（§4 风险①）：万一原生选区还是在点选层里冒了出来（iOS 长按放大镜 / 别家扩展的选区弹窗），
// 立刻清掉并记一行——点选层本就 user-select:none，出现即异常，值得在日志里留痕。
function fixSelClearNativeSelection(card) {
    try {
        const picker = card.querySelector('.pad-fixsel-picker');
        const sel = document.getSelection ? document.getSelection() : null;
        if (!picker || !sel || !sel.anchorNode || !picker.contains(sel.anchorNode)) return;
        sel.removeAllRanges();
        fixSelLog('SEL-CLEAR', { reason: 'native-selection-in-picker' });
    } catch (e) { /* 没有选区 API 无害 */ }
}

// 纯函数（点选·微调）：一个字符位置落在哪个【散文】单元里。落在 gap 里或够不着时，取这个位置【之后】
// 的第一个散文单元；再没有就退回 0（空表也回 0——调用方拿不到单元自然什么都画不出来）。可单测。
function fixSelChUnitAt(units, pos) {
    const us = Array.isArray(units) ? units : [];
    const p = Number(pos) || 0;
    let idx = us.findIndex((u) => u.kind === 'prose' && p >= u.start && p < u.end);
    if (idx < 0) idx = us.findIndex((u) => u.kind === 'prose' && u.start >= p);
    return Math.max(0, idx);
}

// 微调里【唯一】的「这条边能不能落在这儿」判定口。候选区间恒交给既有的 normalizePinAdd 裁决——微调自己
// 不判收白边、不判至少 2 字、不判与钉段重叠、不判上限（§5 fable：多一处判定 = 多一套选择系统）。
// 返回 ok（格子给不给点）+ exact（规整后与候选逐字节相同；‹ 一字 / 一字 › 只认这一种，被收边就算没落稳）
// + added（规整后的区间，挑格子时直接采纳它）。edge='start' 时 pos 是新开头，'end' 时 pos 是新结尾。
function fixSelChProbe(edge, pos) {
    const d = fixSelStored;
    if (!d || !fixSelState) return { ok: false, exact: false, cand: null, added: null, reason: 'no-draft' };
    const cand = edge === 'start' ? { start: pos, end: d.end } : { start: d.start, end: pos };
    const r = normalizePinAdd(fixSelState.pins, cand, fixSelState.full, MULTIFIX_MAX_PINS);
    if (!r.ok) return { ok: false, exact: false, cand, added: null, reason: r.reason };
    const added = { start: r.added.start, end: r.added.end };
    return { ok: true, exact: added.start === cand.start && added.end === cand.end, cand, added, reason: '' };
}

export function openFixSelectCard(presel) {
    if (!ENABLE_FIX_SELECT) return;                       // 杀死开关读点①
    // 生成中禁开卡（终审补钉）：并发单段跑会抢走 generation 控制器（停止键错杀）并提前释放 isGenerating
    if (isGenerating) { addSystemNote('正在生成回复中——请等它完成或先停止，再开选段校正。'); return; }
    const ctx = getCtx();
    const latest = getLatestAiMessage();
    if (!latest || latest.idx < 0) { addSystemNote('没有可校正的 AI 回复。'); return; }
    const m = (ctx.chat || [])[latest.idx];
    const full = (m && typeof m.mes === 'string') ? m.mes : '';
    if (!full.trim()) { addSystemNote('最新回复为空，无法选段。'); return; }
    fixSelState = { idx: latest.idx, swipeId: (m && Number.isInteger(m.swipe_id)) ? m.swipe_id : 0, fingerprint: fixFingerprint(full), start: 0, end: 0, text: '', full, pins: [] };
    fixSelStored = null;
    if (!fixSelCard) fixSelCard = buildFixSelCard();
    const ta = fixSelCard.querySelector('.pad-fixsel-text');
    ta.value = full;
    try { ta.setSelectionRange(0, 0); } catch (e) { /* ignore */ }   // 复开同文时 Chromium 不重置原生选区（值没变=赋值 no-op）——显式清掉，开卡必须真「未选中」
    fixSelCard.querySelector('.pad-fixsel-instr').value = '';
    if (ENABLE_FIX_TAP_SELECT) {   // 点选杀死开关读点③：开卡定一次模式，此后旋转 / 插鼠标都不再改
        fixSelMode = fixSelResolveMode();
        fixSelDebugInit(fixSelCard);
        // 微调可用性：开卡拿一个字探一次，整个开卡周期就用这个答案（真拆字时 fixSelGraphemes 仍会
        // 每次现查 Intl.Segmenter——这个布尔只决定按钮灰不灰，不是可用性的判据）。
        fixSelSegOk = !!fixSelGraphemes('字', 0, 1);
        fixSelApplyMode(fixSelCard);
    }
    const info = fixSelCard.querySelector('.pad-fixsel-info');
    info.textContent = fixSelHint('none-open');
    fixSelCard.querySelector('.pad-fixsel-pin-btn').disabled = true;
    renderFixSelPins(fixSelCard);      // 开卡从零开始（v1 钉选不跨开卡持久，交接 4.1）
    updateFixSelGo(fixSelCard);        // 恢复「开始校正」+ disabled（0 钉无选区）
    const overlay = fixSelCard.querySelector('.pad-fixsel-overlay');
    overlay.innerHTML = ''; overlay.style.display = 'none';
    fixSelCard.classList.add('open');
    if (presel && presel.text) {   // 主聊天入口预选（1.42.0）：送达即消费——成败都算送达（spec 决定 5）
        clearFixChatSel();
        const mapped = mapSelectionToRaw(presel.text, presel.prefix, presel.suffix, full);
        if (mapped) {
            if (ENABLE_FIX_TAP_SELECT && fixSelMode === 'tap') {
                // 点选：逐字采纳映射到的区间（【不】吸附到整句边界），并且绝不去聚焦那个已经藏起来的
                // textarea、不派发 select —— 那两样都会把 record() 那条老路重新叫醒。
                fixSelStored = { start: mapped.start, end: mapped.end };
                fixSelCard.dispatchEvent(new Event('pad-fixsel-refresh'));   // 卡内同一段写回（apply + 重画）
                scrollFixSelToOffset(fixSelCard, mapped.start);
            } else {
                try {
                    ta.focus();
                    ta.setSelectionRange(mapped.start, mapped.end);
                    fixSelStored = { start: mapped.start, end: mapped.end };
                    ta.dispatchEvent(new Event('select'));   // 走卡自己的 record/apply 原路：已选中 N 字 + 📌 + go 态
                    scrollFixSelToOffset(fixSelCard, mapped.start);
                } catch (e) { /* 预选设置失败 = 按未选中开卡（fail-open） */ }
            }
        } else {
            info.textContent = '未能在原文定位所选片段，请在卡内重新划选。';
        }
    }
}

// 懒建选段卡 DOM + 一次性 wiring（复用 #pad-fixwarn 的 inset:0 骨架 + .pad-warn-x 逃生 + 点遮罩关闭，防手机遮罩锁死）。
function buildFixSelCard() {
    const win = document.getElementById('pad-window') || document.body;
    const el = document.createElement('div');
    el.id = 'pad-fixsel';
    el.innerHTML = `
        <div id="pad-fixsel-card">
            <div id="pad-fixsel-head"><span class="pad-warn-title"><i class="fa-solid fa-scissors"></i> ✂️ 选段校正 —— 划选要改的片段</span><div class="pad-iconbtn pad-warn-x" title="关闭"><i class="fa-solid fa-xmark"></i></div></div>
            <div id="pad-fixsel-body">
                <div class="pad-fixsel-wrap">
                    <div class="pad-fixsel-overlay" aria-hidden="true"></div>
                    <textarea class="pad-fixsel-text" readonly spellcheck="false"></textarea>
                </div>
                <div class="pad-fixsel-inforow">
                    <div class="pad-fixsel-info pad-hint">未选中片段——请在上方文本里划选。</div>
                    <button type="button" class="pad-fixsel-pin-btn" disabled title="把当前划选存为一个片段（每段可单独写要求），然后可继续划下一段">📌 钉住这段</button>
                </div>
                <div class="pad-fixsel-pins"></div>
                <textarea class="pad-fixsel-instr" rows="3" placeholder="想怎么改这个片段？（例：这段重写得更简洁 / 这句对白改得更冷）"></textarea>
            </div>
            <div id="pad-fixsel-btns">
                <button type="button" class="pad-fixsel-cancel">取消</button>
                <button type="button" class="pad-fixsel-go" disabled>开始校正</button>
            </div>
        </div>`;
    win.appendChild(el);
    if (ENABLE_FIX_TAP_SELECT) {   // 点选杀死开关读点②：旗关时以下三件一件不建 → 卡 HTML 与 1.78.0 逐字节相同
        // ① 点选层：住在 #pad-fixsel-body 里、排在 .pad-fixsel-wrap 之前；它自己【不设】max-height/overflow，
        //    所以点选模式下 #pad-fixsel-body 是唯一的滚动器（共识 2）。
        const picker = document.createElement('div');
        picker.className = 'pad-fixsel-picker';
        picker.setAttribute('role', 'listbox');
        picker.setAttribute('aria-label', '回复正文');
        el.querySelector('#pad-fixsel-body').insertBefore(picker, el.querySelector('.pad-fixsel-wrap'));
        // ② 头部两段切换（永远可见，挨着逃生 ✕）。
        const modes = document.createElement('span');
        modes.className = 'pad-fixsel-modes';
        modes.innerHTML = '<button type="button" class="pad-fixsel-mode-btn" data-mode="tap" title="轻点句子选段（手机）">点选</button>'
            + '<button type="button" class="pad-fixsel-mode-btn" data-mode="drag" title="在文本里划选（桌面）">拖选</button>';
        el.querySelector('#pad-fixsel-head').insertBefore(modes, el.querySelector('.pad-warn-x'));
        el.classList.add('pad-fixsel-modes-on');   // 有切换 = 标题要让位（防 CJK min-content 把它塌成一字一行）
        // 标题那段文字包进一个 span：.pad-warn-title 是 display:flex，text-overflow 对它无效（复审 #2），
        // 要省略号就得落在一个真正的文字盒上。fixSelApplyMode 之后改的也是这个 span。
        const titleEl = el.querySelector('#pad-fixsel-head .pad-warn-title');
        if (titleEl && titleEl.lastChild && titleEl.lastChild.nodeType === 3) {
            const titleTx = document.createElement('span');
            titleTx.className = 'pad-fixsel-title-text';
            titleEl.insertBefore(titleTx, titleEl.lastChild);
            titleTx.appendChild(titleTx.nextSibling);
        }
        // ③ 贴底操作条：在 #pad-fixsel-body 【外面】（裁定 0.2——软键盘弹起时正文不被挤走）。
        //    信息行与那颗 📌 由 fixSelApplyMode 搬进来，不在这里克隆。
        const strip = document.createElement('div');
        strip.className = 'pad-fixsel-tapstrip';
        strip.innerHTML = '<div class="pad-fixsel-tapbtns">'
            + '<button type="button" class="pad-fixsel-expand">扩选</button>'
            + '<button type="button" class="pad-fixsel-adjust" disabled>微调</button>'
            + '<button type="button" class="pad-fixsel-clear" disabled>清除</button>'
            + '</div>';
        el.querySelector('#pad-fixsel-card').insertBefore(strip, el.querySelector('#pad-fixsel-btns'));
        // ④ 微调选择器：停靠在 #pad-fixsel-body 【下面】、贴底操作条【上面】——正文永远在屏上，绝不被
        //    它替换（共识 1.9）。开合只切 open 类（不玩 hidden 属性），默认不显示。
        const chooser = document.createElement('div');
        chooser.className = 'pad-fixsel-chooser';
        chooser.innerHTML = '<div class="pad-fixsel-ch-tabs">'
            + '<button type="button" class="pad-fixsel-ch-tab on" data-edge="start">开头：选第一个要改的字</button>'
            + '<button type="button" class="pad-fixsel-ch-tab" data-edge="end">结尾：选最后一个要改的字</button>'
            + '</div>'
            + '<div class="pad-fixsel-ch-nav">'
            + '<button type="button" class="pad-fixsel-ch-prevunit">‹ 上一句</button>'
            + `<button type="button" class="pad-fixsel-ch-prev">‹ 前 ${FIXSEL_CH_PAGE} 字</button>`
            + `<button type="button" class="pad-fixsel-ch-next">后 ${FIXSEL_CH_PAGE} 字 ›</button>`
            + '<button type="button" class="pad-fixsel-ch-nextunit">下一句 ›</button>'
            + '<span class="pad-fixsel-ch-spacer"></span>'
            + '<button type="button" class="pad-fixsel-ch-nudge-l" title="边界前移一字">‹ 一字</button>'
            + '<button type="button" class="pad-fixsel-ch-nudge-r" title="边界后移一字">一字 ›</button>'
            + '</div>'
            + '<div class="pad-fixsel-ch-cells"></div>'
            + '<div class="pad-fixsel-ch-preview"></div>'
            + '<div class="pad-fixsel-ch-foot">'
            + '<button type="button" class="pad-fixsel-ch-done">完成</button>'
            + '<button type="button" class="pad-fixsel-ch-cancel">取消微调</button>'
            + '</div>';
        el.querySelector('#pad-fixsel-card').insertBefore(chooser, strip);
    }
    // 微调选择器的「先落定、再继续」钩子：卡上【不在】点选布线块里的那些动作（📌）要在改动草稿之前
    // 先把微调窗收掉。旗关 / 没建选择器时恒为 null，调用点一律 if (chCommit) …。
    let chCommit = null;
    const ta = el.querySelector('.pad-fixsel-text');
    const overlay = el.querySelector('.pad-fixsel-overlay');
    const info = el.querySelector('.pad-fixsel-info');
    const go = el.querySelector('.pad-fixsel-go');
    const close = () => { el.classList.remove('open'); clearFixChatSel(); };   // 关卡即弃划选记忆（go 三分支都先 close() → 「开始校正」也覆盖）

    el.addEventListener('click', (e) => { if (e.target === el) close(); });   // 点遮罩关闭（点卡内不关）
    el.querySelector('.pad-warn-x').addEventListener('click', close);
    el.querySelector('.pad-fixsel-cancel').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {   // Esc 关卡（1.42.0；同 ⋯ 工具菜单的 document 级先例）
        if (e.key === 'Escape' && el.classList.contains('open')) close();
    });

    const apply = () => {
        const sel = resolveRecordedSelection(
            { focused: document.activeElement === ta, start: ta.selectionStart, end: ta.selectionEnd },
            fixSelStored, ta.value.length);
        const pinBtn = el.querySelector('.pad-fixsel-pin-btn');
        const nPins = (fixSelState && fixSelState.pins) ? fixSelState.pins.length : 0;
        if (sel && (sel.end - sel.start) >= 2) {
            fixSelState.start = sel.start; fixSelState.end = sel.end; fixSelState.text = ta.value.slice(sel.start, sel.end);
            info.textContent = '已选中 ' + fixSelState.text.length + ' 字。' + (nPins ? `（已钉 ${nPins} 段）` : '');
            pinBtn.disabled = false;
        } else {
            fixSelState.start = 0; fixSelState.end = 0; fixSelState.text = '';
            info.textContent = nPins ? fixSelHint('pinned', nPins) : fixSelHint('none');
            pinBtn.disabled = true;
        }
        updateFixSelGo(el);
        fixSelSyncStrip(el);         // 点选操作条的清除/扩选跟着走（旗关时 no-op）
        fixSelLog('APPLY', {});      // 裁定 0.3：每次 apply 都印 activeElement
    };
    const record = () => {
        if (fixSelMode === 'tap') return;   // 结构性闸门（§5 opus）：点选模式下这条老路【永不】写草稿
        const start = ta.selectionStart, end = ta.selectionEnd;
        if (typeof start === 'number' && typeof end === 'number' && end > start) fixSelStored = { start, end };   // 规则3：只在真选区时更新存档
        apply();
    };
    // 规则1：mouseup / keyup / select
    ['mouseup', 'keyup', 'select'].forEach((ev) => ta.addEventListener(ev, record));
    // 规则2：touchend（iOS 长按选择手柄不触发 mouseup）
    ta.addEventListener('touchend', () => setTimeout(record, 50), { passive: true });
    // 规则1（续）：document selectionchange，仅当焦点在本 textarea——iOS 拖选手柄时唯一可靠信号
    document.addEventListener('selectionchange', () => {
        if (ENABLE_FIX_TAP_SELECT && fixSelMode === 'tap') { fixSelClearNativeSelection(el); return; }   // 点选：只清场，永不 record
        if (document.activeElement === ta) record();
    });
    // 规则5（多段版）：聚焦时只画钉选段——活选区让位给原生黄选；无钉 = 隐藏（与旧版行为一致）
    ta.addEventListener('focus', () => paintFixSelOverlayAll(el));
    // 规则4（多段版）：失焦时画 钉选段 + 存档选区（用户敲指令时都看得见）
    ta.addEventListener('blur', () => paintFixSelOverlayAll(el));
    ta.addEventListener('scroll', () => { overlay.scrollTop = ta.scrollTop; overlay.scrollLeft = ta.scrollLeft; }, { passive: true });

    // 📌 钉住这段：规整（收白边 / 查重叠 / 查上限）→ 入列 → 清活选区（手机上顺序流：划一段钉一段）
    el.querySelector('.pad-fixsel-pin-btn').addEventListener('click', () => {
        if (!fixSelState || fixSelState.text.length < 2) return;
        if (chCommit) chCommit();   // 微调窗开着时按钉 = 先落定当下这个区间（不还原快照），再照常钉
        const r = normalizePinAdd(fixSelState.pins, { start: fixSelState.start, end: fixSelState.end }, fixSelState.full, MULTIFIX_MAX_PINS);
        if (!r.ok) {
            info.textContent = fixSelRefuse(r.reason, r.index + 1);
            return;
        }
        fixSelState.pins = r.pins;
        fixSelState.start = 0; fixSelState.end = 0; fixSelState.text = '';
        fixSelStored = null;
        try { ta.setSelectionRange(0, 0); } catch (e) { /* ignore */ }
        fixSelExpandArmed = false;   // 钉住 = 这一段结束，扩选的一次性武装随之作废
        renderFixSelPins(el);
        paintFixSelOverlayAll(el);
        info.textContent = fixSelHint('pinned', fixSelState.pins.length);
        el.querySelector('.pad-fixsel-pin-btn').disabled = true;
        updateFixSelGo(el);
        fixSelSyncStrip(el);
    });

    go.addEventListener('click', () => {
        const instr = (el.querySelector('.pad-fixsel-instr').value || '').trim();
        const pins = (fixSelState && fixSelState.pins) || [];
        // 裁定 0.4（两种模式同守）：有钉在手时，还亮着的那段草稿必须先钉住或清除——看得见的暖色高亮
        // 绝不能被悄悄丢掉。放在最前面，三条派发路都在它后面。
        if (pins.length >= 1 && fixSelState && fixSelState.text.length >= 2) {
            info.textContent = '还有一段选中但没钉住——请先钉住或清除。';
            return;
        }
        if (fixSelDispatchMode(pins.length) === 'batch') {   // 2+ 段 → 批发（每段一次冻结单段调用，并行）
            const chk = multiFixRunnable(pins, instr);
            if (!chk.ok) { info.textContent = `片段${chk.missing.join('、')}还没有要求——给这些段各写一条，或写一条整体要求。`; return; }
            close();
            runFixSelectBatch(instr);
            return;
        }
        if (pins.length === 1) {   // H1：单钉 = 钉的偏移灌回 fixSelState、走今天的单段路（字节同一调用）
            const eff = resolvePinInstruction(pins[0].instr, instr);
            if (!eff) { info.textContent = '请先说要怎么改这个片段（该段的要求或整体要求都行）。'; return; }
            fixSelState.start = pins[0].start; fixSelState.end = pins[0].end; fixSelState.text = pins[0].text;
            close();
            runFixSelect(eff);
            return;
        }
        if (!instr) { info.textContent = '请先说要怎么改这个片段。'; return; }
        if (!fixSelState || fixSelState.text.length < 2) { info.textContent = '请先在上方划选一段文字（至少 2 个字）。'; return; }
        close();
        runFixSelect(instr);   // C4（0 钉裸选区 = 今天的原路，逐字节不动）
    });

    if (ENABLE_FIX_TAP_SELECT) {   // 点选布线（旗关时一个监听都不挂）：闸门 → 单元点击 → 操作条 → 头部切换
        const bodyBox = el.querySelector('#pad-fixsel-body');
        const picker = el.querySelector('.pad-fixsel-picker');
        // 写回 = 共识 11 的那两行之后半段：apply() 出信息行 / 📌 / go 态，重画出高亮。预选支借
        // pad-fixsel-refresh 走同一段，所以卡里只有【一处】写回代码。
        const writeBack = () => { apply(); paintFixSelOverlayAll(el); };
        el.addEventListener('pad-fixsel-refresh', writeBack);

        // 一次被接受的轻点变成草稿的【唯一】出口，它自己什么都不裁决：能不能要（收白边 / ≥2 字 /
        // 与钉段重叠 / 到没到上限）全由既有的 normalizePinAdd 说了算（§5 fable：诊断书里最怕的就是
        // 这里冒出第二套判定）。它返回的 pins 数组在这儿丢掉——轻点只出草稿，不钉任何东西。
        const onUnitTap = (i) => {
            const unit = (fixSelState && fixSelState.units) ? fixSelState.units[i] : null;
            if (!unit) return;
            const cand = (fixSelExpandArmed && fixSelStored)
                ? { start: Math.min(fixSelStored.start, unit.start), end: Math.max(fixSelStored.end, unit.end) }
                : { start: unit.start, end: unit.end };
            const r = normalizePinAdd(fixSelState.pins, cand, fixSelState.full, MULTIFIX_MAX_PINS);
            if (!r.ok) {
                info.textContent = fixSelRefuse((r.reason === 'overlap' && fixSelExpandArmed) ? 'expand-cross' : r.reason, r.index + 1);
                if (r.reason === 'overlap') fixSelFlashPin(el, r.index);
                fixSelExpandArmed = false;
                fixSelSyncStrip(el);
                fixSelLog('TAP-NO', { unit: i, reason: r.reason });
                return;
            }
            closeChooser(true);   // 微调窗开着时新点一句 = 先落定当下的微调结果（不还原），再按新句重选
            fixSelStored = { start: r.added.start, end: r.added.end };   // 已经规整过：📌 不会再挪动看得见的边
            fixSelExpandArmed = false;
            writeBack();
        };

        bodyBox.addEventListener('scroll', () => { fixSelGate.lastScrollAt = performance.now(); }, { passive: true });
        picker.addEventListener('pointerdown', (e) => {
            fixSelGate.active.add(e.pointerId);
            const now = performance.now();
            fixSelGate.down = { id: e.pointerId, t: now, x: e.clientX, y: e.clientY, scrollTop: bodyBox.scrollTop, type: e.pointerType, sinceScroll: now - fixSelGate.lastScrollAt, multi: fixSelGate.active.size > 1, cancelled: false };
            fixSelLog('DOWN', { since: Math.min(99999, fixSelGate.down.sinceScroll) | 0 });
        });
        // 抬手 / 取消【恒挂在 document 上】：手指从点选层滑出去再松开时 picker 收不到 pointerup，
        // 挂在 picker 身上的计数就只增不减 —— 第二次轻点起全被判成「多指」，点选模式当场作废。
        // 探针没暴露这个洞（它每次都在同一块里抬手）。按 pointerId 记名，多余的抬手是无害的 delete。
        document.addEventListener('pointerup', (e) => { fixSelGate.active.delete(e.pointerId); });
        document.addEventListener('pointercancel', (e) => {
            fixSelGate.active.delete(e.pointerId);
            if (fixSelGate.down && fixSelGate.down.id === e.pointerId) fixSelGate.down.cancelled = true;
        });
        // 长按菜单 / 选区起手在点选层里一律不给（配 CSS 的 user-select:none 组）；touchmove 绝不 preventDefault、
        // 指针绝不 setPointerCapture —— 那两样会把正常的滚动手势一起吃掉。
        picker.addEventListener('contextmenu', (e) => { e.preventDefault(); });
        picker.addEventListener('selectstart', (e) => { e.preventDefault(); });
        picker.addEventListener('click', (e) => {
            const d = fixSelGate.down;
            const v = fixSelJudgeTap(d, performance.now(), { x: e.clientX, y: e.clientY }, bodyBox.scrollTop, fixSelGate.lastScrollAt);
            const u = (e.target && e.target.closest) ? e.target.closest('.pad-fixsel-u') : null;
            const line = {
                dt: v.dt, reason: v.reason || 'ok', unit: u ? u.dataset.i : '-',
                dx: d ? Math.abs(e.clientX - d.x) : '-', dy: d ? Math.abs(e.clientY - d.y) : '-',
                dTop: d ? (bodyBox.scrollTop - d.scrollTop) : '-', since: d ? (Math.min(99999, d.sinceScroll) | 0) : '-',
            };
            fixSelGate.down = null;
            if (!v.ok) { fixSelLog('TAP-REJECT', line); return; }   // 被拒 = 屏上零变化
            fixSelLog('TAP', line);
            if (!u) return;                                        // 点在 gap（空白）上：什么都不做
            onUnitTap(Number(u.dataset.i));
        });

        el.querySelector('.pad-fixsel-expand').addEventListener('click', () => {
            if (!fixSelStored || fixSelStored.end <= fixSelStored.start) { info.textContent = '先点一句，再按扩选。'; return; }
            fixSelExpandArmed = !fixSelExpandArmed;
            fixSelSyncStrip(el);
            if (fixSelExpandArmed) info.textContent = '扩选：再点另一头，中间全选上。';
            else apply();   // 收手 = 提示行回到「已选中 N 字」
            fixSelLog('EXPAND', { reason: fixSelExpandArmed ? 'armed' : 'disarmed' });
        });
        el.querySelector('.pad-fixsel-clear').addEventListener('click', () => {
            closeChooser(true);   // 清除 = 连微调一起收掉，且【不】把快照放回来（草稿就是要没了）
            fixSelStored = null;
            fixSelExpandArmed = false;
            // 拖选模式下 textarea 还聚焦着、原生选区还在，apply() 会走【实时】那一支把草稿原样捡回来
            //（复审 #1 的出路必须真的通）——同 📌 成功后的那一行，显式清零。点选模式下是 no-op。
            try { ta.setSelectionRange(0, 0); } catch (e) { /* ignore */ }
            apply();
            paintFixSelOverlayAll(el);
        });

        /* ------------------------------------------------------------------ *
         * 微调选择器：停靠在正文【下面】的字素格边界挑选器（共识 1.9）。CH 是它的【全部】状态——
         * 哪一头 / 哪一句 / 第几页 / 打开那一刻的快照。选区真相仍然只有 fixSelStored 一个；CH 里
         * 没有第二份区间（snapshot 只为「取消」服务，落定后立刻扔掉）。
         * ------------------------------------------------------------------ */
        const chooser = el.querySelector('.pad-fixsel-chooser');
        const pinsBox = el.querySelector('.pad-fixsel-pins');   // 开窗期间要把它藏起来（见 openChooser）
        const CH = { edge: 'start', unit: 0, page: 0, snapshot: null, pinsDisplay: null };
        const chIsOpen = () => chooser.classList.contains('open');
        const chCells = chooser.querySelector('.pad-fixsel-ch-cells');

        // 挑一格 = 把那一头挪到这一格的边上。写草稿的路与轻点【同一条】：判定问 fixSelChProbe（= 唯一
        // 那处 normalizePinAdd），采纳它规整后的区间，然后走 writeBack。
        const chPick = (g) => {
            const p = fixSelChProbe(CH.edge, CH.edge === 'start' ? g.start : g.end);
            if (!p.ok) return;
            fixSelStored = { start: p.added.start, end: p.added.end };
            fixSelLog('CH-PICK', { reason: `${CH.edge} → [${fixSelStored.start},${fixSelStored.end})`, unit: CH.unit });
            writeBack();
            renderChooser();   // 挑完不关窗：格子上的 on 跟着挪，可以接着挑
        };

        // ‹ 一字 / 一字 ›：在边界前后各 FIXSEL_CH_NUDGE_WIN 字的窗口里拆字素，挪到相邻的那个字素边界。
        // 只认【原样采纳】：规整后但凡被收过边（落在空白上）或被拒（踩进钉段 / 压塌区间），一律不动。
        const chNudge = (dir) => {
            if (!chIsOpen() || !fixSelStored || !fixSelState) return;
            const full = fixSelState.full;
            const pos = CH.edge === 'start' ? fixSelStored.start : fixSelStored.end;
            const lo = Math.max(0, pos - FIXSEL_CH_NUDGE_WIN), hi = Math.min(full.length, pos + FIXSEL_CH_NUDGE_WIN);
            const gs = fixSelGraphemes(full, lo, hi) || [];
            const bounds = gs.map((g) => g.start).concat([hi]);
            const at = bounds.findIndex((b) => b === pos);
            if (at < 0) return;
            const np = bounds[at + dir];
            if (np === undefined) return;
            const p = fixSelChProbe(CH.edge, np);
            if (!p.ok || !p.exact) { fixSelLog('CH-NUDGE-NO', { reason: p.reason || 'trimmed' }); return; }
            fixSelStored = { start: p.cand.start, end: p.cand.end };
            fixSelLog('CH-NUDGE', { reason: `${CH.edge} ${dir > 0 ? '+' : '-'}1 → [${fixSelStored.start},${fixSelStored.end})` });
            CH.unit = fixSelChUnitAt(fixSelState.units, CH.edge === 'start' ? fixSelStored.start : fixSelStored.end - 1);
            writeBack();
            renderChooser();
        };

        // 整块重画（页签 / 格子 / 翻页键从属态 / 预览）。没草稿的微调不成立 → 直接收工。
        const renderChooser = () => {
            if (!chIsOpen()) return;
            const d = fixSelStored;
            if (!d || d.end <= d.start || !fixSelState) { closeChooser(true); return; }
            chooser.querySelectorAll('.pad-fixsel-ch-tab').forEach((b) => b.classList.toggle('on', b.dataset.edge === CH.edge));
            const us = fixSelState.units || [];
            if (!us[CH.unit] || us[CH.unit].kind !== 'prose') {
                CH.unit = fixSelChUnitAt(us, CH.edge === 'start' ? d.start : d.end - 1);
            }
            const u = us[CH.unit];
            const gs = u ? (fixSelGraphemes(fixSelState.full, u.start, u.end) || []) : [];
            const pages = Math.max(1, Math.ceil(gs.length / FIXSEL_CH_PAGE));
            CH.page = Math.max(0, Math.min(CH.page, pages - 1));
            chCells.innerHTML = '';
            gs.slice(CH.page * FIXSEL_CH_PAGE, (CH.page + 1) * FIXSEL_CH_PAGE).forEach((g) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'pad-fixsel-ch-cell';
                b.dataset.s = String(g.start); b.dataset.e = String(g.end);
                if (/^\s+$/.test(g.g)) {   // 空白字素得看得见，否则用户以为这一格是空的
                    const w = document.createElement('span');
                    w.className = 'pad-fixsel-ch-ws';
                    w.textContent = /\n/.test(g.g) ? '↵' : '␣';
                    b.appendChild(w);
                } else { b.textContent = g.g; }
                // 纯装饰：这一格落在某个钉段里就标蓝。能不能点【不】看它，看下面那一问。
                b.classList.toggle('inpin', ((fixSelState.pins) || []).some((p) => g.start < p.end && p.start < g.end));
                b.disabled = !fixSelChProbe(CH.edge, CH.edge === 'start' ? g.start : g.end).ok;
                b.classList.toggle('on', CH.edge === 'start' ? g.start === d.start : g.end === d.end);
                b.addEventListener('click', () => chPick(g));
                chCells.appendChild(b);
            });
            chooser.querySelector('.pad-fixsel-ch-prev').disabled = CH.page === 0;
            chooser.querySelector('.pad-fixsel-ch-next').disabled = CH.page >= pages - 1;
            chooser.querySelector('.pad-fixsel-ch-preview').textContent = fixSelState.full.slice(d.start, d.end);
        };

        const openChooser = (edge) => {
            // 三道前提都由按钮的从属态挡在外面（没草稿 / 拆不了字 = 灰）；这里只是不信任地再守一遍，
            // 所以【不】写提示文案——屏上永远看不到它，只在调试日志里留痕。
            if (!fixSelSegOk || chIsOpen()) return;
            if (!fixSelStored || fixSelStored.end <= fixSelStored.start) { fixSelLog('CH-OPEN-NO', { reason: 'no-draft' }); return; }
            CH.edge = edge === 'end' ? 'end' : 'start';
            CH.snapshot = { start: fixSelStored.start, end: fixSelStored.end };
            CH.unit = fixSelChUnitAt(fixSelState.units, CH.edge === 'start' ? fixSelStored.start : fixSelStored.end - 1);
            CH.page = 0;
            chooser.classList.add('open');
            // 1.79 手机实测：贴底条在 540px 高的窗里已经吃掉约 227px，微调窗只剩约 51px（滚动条后面才是
            // 格子）。微调与「写要求」从来不是同时用的两件事 —— 开窗期间把钉选 chips 与整体要求框藏起来，
            // 信息行留着（它显示实时的「已选中 N 字」）。CSS 那条类规则管得住 .pad-fixsel-instr；
            // 钉选框管不住 —— renderFixSelPins 给它写的是【内联】display（flex/none），内联压过类规则
            //（1.45.0 那条地雷的同族）。所以钉选框走「开窗时记下内联值、改 none，关窗时原样放回」。
            // 记下的值不会过期：开窗期间 renderFixSelPins 一次也跑不到（📌 会先 chCommit() 收窗，
            // 移除 × 那些行本身正被藏着，开卡那条路进来时窗必然是关的）。
            CH.pinsDisplay = pinsBox ? pinsBox.style.display : null;
            if (pinsBox) pinsBox.style.display = 'none';
            el.classList.add('pad-fixsel-ch-open');
            fixSelLog('CH-OPEN', { reason: `edge=${CH.edge}`, unit: CH.unit });
            renderChooser();
        };
        // commit=true：留住当下的区间（完成 / 📌 / 清除 / 新轻点 / 换模式都走这条）；
        // commit=false：把草稿还原成打开那一刻的快照（只有「取消」走）。
        const closeChooser = (commit) => {
            if (!chIsOpen()) return;
            if (!commit && CH.snapshot) fixSelStored = { start: CH.snapshot.start, end: CH.snapshot.end };
            chooser.classList.remove('open');
            el.classList.remove('pad-fixsel-ch-open');
            // 只还原【显示】，绝不碰值：用户在整体要求框里敲的字原样还在（那是 textarea 的 value，
            // 从头到尾没人动过）。钉选框放回开窗前那个内联值。
            if (pinsBox) pinsBox.style.display = CH.pinsDisplay === null || CH.pinsDisplay === undefined ? '' : CH.pinsDisplay;
            CH.pinsDisplay = null;
            CH.snapshot = null;
            fixSelLog(commit ? 'CH-DONE' : 'CH-CANCEL', {});
            writeBack();
        };
        chCommit = () => closeChooser(true);   // 给布线块【外面】那颗 📌 的钩子

        el.querySelector('.pad-fixsel-adjust').addEventListener('click', () => openChooser('start'));
        chooser.querySelectorAll('.pad-fixsel-ch-tab').forEach((tab) => {
            tab.addEventListener('click', () => {   // 换一头 = 按【当前草稿的那一头】重新找句子，回到第 0 页
                if (!fixSelStored) return;
                CH.edge = tab.dataset.edge === 'end' ? 'end' : 'start';
                CH.unit = fixSelChUnitAt(fixSelState.units, CH.edge === 'start' ? fixSelStored.start : fixSelStored.end - 1);
                CH.page = 0;
                renderChooser();
            });
        });
        chooser.querySelector('.pad-fixsel-ch-prev').addEventListener('click', () => { CH.page--; renderChooser(); });
        chooser.querySelector('.pad-fixsel-ch-next').addEventListener('click', () => { CH.page++; renderChooser(); });
        const chMoveUnit = (dir) => {   // 只落在散文句上：换行 / 空白那些 gap 单元一律跳过
            const us = (fixSelState && fixSelState.units) || [];
            for (let k = CH.unit + dir; k >= 0 && k < us.length; k += dir) {
                if (us[k].kind === 'prose') { CH.unit = k; CH.page = 0; renderChooser(); return; }
            }
        };
        chooser.querySelector('.pad-fixsel-ch-prevunit').addEventListener('click', () => chMoveUnit(-1));
        chooser.querySelector('.pad-fixsel-ch-nextunit').addEventListener('click', () => chMoveUnit(1));
        chooser.querySelector('.pad-fixsel-ch-nudge-l').addEventListener('click', () => chNudge(-1));
        chooser.querySelector('.pad-fixsel-ch-nudge-r').addEventListener('click', () => chNudge(1));
        chooser.querySelector('.pad-fixsel-ch-done').addEventListener('click', () => closeChooser(true));
        chooser.querySelector('.pad-fixsel-ch-cancel').addEventListener('click', () => closeChooser(false));

        // 头部切换：只写 localStorage + 换模式（草稿 / 钉选 / 两处指令全原样留着；扩选武装作废）。
        el.querySelectorAll('.pad-fixsel-mode-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode === 'tap' ? 'tap' : 'drag';
                if (mode === fixSelMode) return;
                closeChooser(true);   // 换模式 = 先落定微调（拖选那边没有停靠选择器）
                try { localStorage.setItem('pad.fixsel.mode', mode); } catch (e) { /* 隐私模式写不进，不挡本次切换 */ }
                fixSelMode = mode;
                fixSelApplyMode(el);
                apply();   // 提示行换成新模式的说法
            });
        });
    }
    return el;
}

// 多段 overlay 全量重画（规则4/5 的多段版）：钉选段（.pad-fixsel-hl-pin，冷色）+ 失焦存档选区
//（.pad-fixsel-hl，暖色）。聚焦时只画钉——活选区让位原生黄选。无任何区间 = 隐藏（与旧版一致）。
function paintFixSelOverlayAll(card) {
    if (ENABLE_FIX_TAP_SELECT && fixSelMode === 'tap') { renderFixSelPicker(card); return; }   // 点选层是它自己的画布
    const ta = card.querySelector('.pad-fixsel-text');
    const overlay = card.querySelector('.pad-fixsel-overlay');
    const ranges = ((fixSelState && fixSelState.pins) || []).map((p) => ({ start: p.start, end: p.end, cls: 'pad-fixsel-hl-pin' }));
    if (document.activeElement !== ta && fixSelStored && fixSelStored.end > fixSelStored.start) {
        ranges.push({ start: fixSelStored.start, end: fixSelStored.end, cls: 'pad-fixsel-hl' });
    }
    if (!ranges.length) { overlay.innerHTML = ''; overlay.style.display = 'none'; return; }
    overlay.innerHTML = buildFixSelOverlayHtml(ta.value || '', ranges);
    overlay.style.display = 'block';
    overlay.scrollTop = ta.scrollTop; overlay.scrollLeft = ta.scrollLeft;
}

// 把 textarea 滚到指定字符偏移附近（预选送达时用）。textarea 无「滚到偏移」原生能力——借 overlay 镜像量高：
// 临时画一个只含标记 span 的 overlay、读它的 offsetTop、把 ta 滚到上 1/3 处，再交还 paintFixSelOverlayAll
// 重画常规态（钉/存档高亮 + 滚动同步在那边）。量不出（jsdom / 零高布局）→ 停在顶部，无害。
function scrollFixSelToOffset(card, start) {
    if (ENABLE_FIX_TAP_SELECT && fixSelMode === 'tap') {   // 点选：找 data-s ≤ start < data-e 的那一片，滚到上 1/3
        try {
            const body = card.querySelector('#pad-fixsel-body');
            const picker = card.querySelector('.pad-fixsel-picker');
            let mark = null;
            if (body && picker) {
                picker.querySelectorAll('span[data-s]').forEach((sp) => {
                    if (!mark && Number(sp.dataset.s) <= start && start < Number(sp.dataset.e)) mark = sp;
                });
                // 量位置只能用矩形差（复审 #3）：#pad-fixsel-body 与点选层都没有定位，一个片的
                // offsetParent 其实是 #pad-fixsel（position:absolute），offsetTop 量的是另一个盒子。
                if (mark) {
                    const top = mark.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
                    body.scrollTop = Math.max(0, top - Math.floor((body.clientHeight || 0) / 3));
                }
            }
        } catch (e) { /* jsdom / 零高布局量不出 → 停在顶部，无害 */ }
        return;
    }
    try {
        const ta = card.querySelector('.pad-fixsel-text');
        const overlay = card.querySelector('.pad-fixsel-overlay');
        if (!ta || !overlay) return;
        const len = (ta.value || '').length;
        overlay.innerHTML = buildFixSelOverlayHtml(ta.value || '', [{ start, end: Math.min(start + 1, len), cls: 'pad-fixsel-hl' }]);
        overlay.style.display = 'block';
        const mark = overlay.querySelector('span');
        const top = mark ? mark.offsetTop : 0;
        if (top > 0) ta.scrollTop = Math.max(0, top - Math.floor((ta.clientHeight || 0) / 3));
    } catch (e) { /* 量高失败无害 */ }
    paintFixSelOverlayAll(card);
}

// 钉选 chips 重画：每段一行 = 「片段k「摘要」」+ 该段要求输入 + 移除 ×。手机端：行 flex-wrap，输入框
// min-width 挤不下自动换整行；× ≥32px 点区。输入直写 pin.instr（对象引用，开跑时快照）。
function renderFixSelPins(card) {
    const box = card.querySelector('.pad-fixsel-pins');
    const pins = (fixSelState && fixSelState.pins) || [];
    box.innerHTML = '';
    box.style.display = pins.length ? 'flex' : 'none';
    pins.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'pad-fixsel-pinrow';
        const tag = document.createElement('span');
        tag.className = 'pad-fixsel-pintag';
        tag.textContent = `片段${i + 1}「${p.text.slice(0, 12)}${p.text.length > 12 ? '…' : ''}」`;
        const instr = document.createElement('input');
        instr.type = 'text';
        instr.className = 'pad-fixsel-pininstr';
        instr.placeholder = '这段怎么改？（留空则用下方整体要求）';
        instr.value = p.instr || '';
        instr.addEventListener('input', () => { p.instr = instr.value; });
        const rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'pad-fixsel-pinrm'; rm.title = '移除此段';
        rm.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        rm.addEventListener('click', () => {
            fixSelState.pins.splice(i, 1);
            renderFixSelPins(card); paintFixSelOverlayAll(card); updateFixSelGo(card);
            const info = card.querySelector('.pad-fixsel-info');   // 终审补钉：移除后同步刷新提示行（防「已钉 n 段」滞留旧数）
            if (info) info.textContent = fixSelState.pins.length ? fixSelHint('pinned', fixSelState.pins.length) : fixSelHint('none');
            fixSelSyncStrip(card);
        });
        row.appendChild(tag); row.appendChild(instr); row.appendChild(rm);
        box.appendChild(row);
    });
}

// go 键三态（H1 可视化 + V4 成本提示）：0 钉 = 今天的「开始校正」（活选区门控）；1 钉 = 同标签（走旧路）；
// 2+ = 「开始多段校正（n 段，n 次调用）」——调用数写在脸上，成本绝不意外。
function updateFixSelGo(card) {
    const go = card.querySelector('.pad-fixsel-go');
    const pins = (fixSelState && fixSelState.pins) || [];
    if (pins.length >= 2) { go.textContent = `开始多段校正（${pins.length} 段，${pins.length} 次调用）`; go.disabled = false; }
    else if (pins.length === 1) { go.textContent = '开始校正'; go.disabled = false; }
    else { go.textContent = '开始校正'; go.disabled = !(fixSelState && fixSelState.text.length >= 2); }
}

// 校正调用共用传输；回调接收累计全文，自动任务不传回调时保持非流式。
export async function fixCallTransport(s, messages, signal, onCum, effMaxTokens = fixEffMaxTokens(s), deps = FIX_TRANSPORT_DEPENDENCIES) {
    if (s.mode === 'direct') {
        const url = deps.resolveEndpointUrl(s);
        const body = { model: s.model, messages, max_tokens: effMaxTokens };
        if (s.sendTemperature) body.temperature = s.temperature;
        if (onCum && s.stream) {
            let acc = '';
            return deps.streamDirect(url, s.apiKey, body, signal, (d) => { acc += d; onCum(acc); });
        }
        return deps.callDirect(url, s.apiKey, body, signal);
    }
    const override = s.sendTemperature ? { temperature: s.temperature } : {};
    if (onCum && s.stream) return deps.callProfileStream(s.profileId, messages, effMaxTokens, override, signal, onCum);
    return deps.callProfile(s.profileId, messages, effMaxTokens, override, signal);
}

function persistFixResultEntry(entry) {
    if (!entry) return;
    if (!convo.includes(entry)) appendConvo(entry);
    persistConvo();
}

function paintFixActionButton(button, action) {
    const state = action ? resolveFixAction(action) : null;
    button.hidden = Boolean(action && !state);
    if (!state) return null;
    button.innerHTML = state.record.applied === false
        ? '<i class="fa-solid fa-wand-magic-sparkles"></i> 重新应用'
        : '<i class="fa-solid fa-rotate-left"></i> 撤销';
    return state;
}

async function toggleFixAction(button, status, action) {
    const state = paintFixActionButton(button, action);
    if (!state) {
        status.textContent = '目标回复已经变化，无法继续操作。';
        status.classList.add('pad-hint-error');
        return false;
    }
    const reapplying = state.record.applied === false;
    const ok = reapplying ? await reapplyFix(action) : await undoFix(action);
    if (!ok) {
        status.textContent = '操作已取消，或目标回复已经变化。';
        status.classList.add('pad-hint-error');
        return false;
    }
    paintFixActionButton(button, action);
    status.textContent = reapplying ? '已重新应用校正稿。' : '已恢复上一次校正前的正文。';
    return true;
}

// ✂️ 选段校正主流程（1.27.0，Part C）：把 fixSelState 里划选的片段 + 用户指令发给模型（冻结 FIX_SPAN_PROMPT），
// 只回改写片段；上下文走手动那套 fixM_* 开关（captureFixContext 为本轮冻结卡/概要/前文——选段正是能扛高上下文的形态）。
// 调用机理与 runFixByTargets 同构（direct/profile + 流式 + generation 控制器停止键）。定稿 → renderFixSelectResult。
async function runFixSelect(instruction) {
    if (!ENABLE_FIX_SELECT || !fixSelState || fixSelState.text.length < 2) return;
    const ctx = getCtx();
    const s = getSettings();
    const sel = fixSelState;   // 快照本次划选（fixSelState 可能被下次开卡覆盖）
    const fixContext = await captureFixContext(s, { mode: 'manual' });
    const messages = buildSpanMessages(ctx, s, sel, instruction, fixContext);

    const aEntry = { id: nextCid(), role: 'assistant', content: '' };
    const assistantEl = addMessage('assistant', '', aEntry);
    aEntry._el = assistantEl;
    const contentEl = assistantEl.querySelector('.pad-content');
    const clearTyping = showTyping(contentEl);
    const ctl = beginGeneration();
    const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, POST_REPLY_CALL_TIMEOUT_MS);
    let finalText = '';
    try {
        // 传输四格收进 fixCallTransport（1.37.0 单一来源）；onCum 累计语义 = 原 profile 流分支原样，
        // direct 流从「+= 增量」改「= 累计」——同一字符串级数，最终画面逐字节一致。
        if (s.stream) contentEl.classList.add('pad-streaming');
        finalText = await fixCallTransport(s, messages, ctl.signal, (full) => { clearTyping(); contentEl.textContent = full; if (soFollowStream) scrollToBottom(); });
        contentEl.classList.remove('pad-streaming');
        clearTyping();
        renderFixSelectResult(assistantEl, contentEl, sel, finalText, aEntry);
    } catch (e) {
        clearTyping();
        if (isUserAbort(e)) contentEl.textContent = '(已停止)';
        else { contentEl.textContent = '选段校正失败：' + (e?.message || e); contentEl.classList.add('pad-hint-error'); }
    } finally {
        clearTimeout(timer); finishGeneration();
        if (soFollowStream) scrollToBottom();
    }
}

// 解析选段结果：默认展示差异；「看全文」只展开新片段。应用后同一按钮切成撤销 / 重新应用。
function renderFixSelectResult(assistantEl, contentEl, sel, finalText, entry) {
    const parsed = parseFixSpan(finalText);
    if (parsed.status === 'truncated') {
        contentEl.textContent = finalText || '';
        addSystemNote('选段校正稿疑似被截断（模型思考占满额度或中转截断）——未改动回复。可调高「校正回复上限」或改直连后重试。');
        return;
    }
    if (parsed.status !== 'ok') {
        contentEl.textContent = finalText || '（空回复）';
        addSystemNote('没能从模型回复里解析出 <FixedSpan> 改写稿——请检查连接 / 模型，或重试。');
        return;
    }
    const newSpan = parsed.span;
    entry.content = newSpan;
    persistFixResultEntry(entry);
    const outside = sel.full.slice(0, sel.start) + sel.full.slice(sel.end);
    const v = validateSpanFix(sel.text, newSpan, outside);
    const bubble = assistantEl.querySelector('.pad-bubble') || contentEl.parentElement;
    contentEl.textContent = newSpan;
    contentEl.hidden = true;
    for (const warningText of v.warnings) {
        const warning = document.createElement('div');
        warning.className = 'pad-fix-nearcopy-warn';
        warning.textContent = warningText;
        bubble.appendChild(warning);
    }
    const diff = renderDiffCard(sel.text, newSpan);
    const bar = document.createElement('div');
    bar.className = 'pad-apply-bar';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'pad-apply-btn';
    applyBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 应用（回插这段）';
    const fullBtn = document.createElement('button');
    fullBtn.className = 'pad-apply-btn';
    fullBtn.innerHTML = '<i class="fa-solid fa-eye"></i> 看全文';
    const status = document.createElement('span');
    status.className = 'pad-apply-status';
    fullBtn.addEventListener('click', () => {
        contentEl.hidden = !contentEl.hidden;
        fullBtn.innerHTML = contentEl.hidden
            ? '<i class="fa-solid fa-eye"></i> 看全文'
            : '<i class="fa-solid fa-eye-slash"></i> 收起全文';
    });
    let action = null;
    registerFixActionPainter(applyBtn, () => action ? paintFixActionButton(applyBtn, action) : null);
    applyBtn.addEventListener('click', async () => {
        status.classList.remove('pad-hint-error');
        applyBtn.disabled = true;
        if (action) {
            await toggleFixAction(applyBtn, status, action);
            applyBtn.disabled = false;
            return;
        }
        const result = await applyFixSelect(sel, newSpan);
        if (typeof result === 'object' && result) {
            action = result;
            entry.fixAction = action;
            persistConvo();
            paintFixActionButton(applyBtn, action);
            status.textContent = '已替换这条回复，可随时撤销。';
        } else {
            status.textContent = result;
        }
        applyBtn.disabled = false;
    });
    bar.appendChild(applyBtn);
    bar.appendChild(fullBtn);
    bar.appendChild(status);
    bubble.appendChild(diff);
    bubble.appendChild(bar);
    scrollToBottom();
}

// 应用选段回插：陈旧守卫通过后直接替换当前回复，并返回持久 action locator。
async function applyFixSelect(sel, newSpan) {
    const ctx = getCtx();
    const message = (ctx.chat || [])[sel.idx];
    if (!message || typeof message.mes !== 'string') return '目标回复已不在了，未应用。';
    if (fixFingerprint(message.mes) !== sel.fingerprint) return '这条回复自划选后已发生变化（切换了回复分支 / 被改过）——为免覆盖新内容，未应用。请重开选段校正。';
    const spliced = spliceSpan(message.mes, sel.start, sel.end, newSpan);
    if (spliced == null) return '回插位置越界，未应用（请重开选段校正）。';
    const applied = await applyFixInPlace(sel.idx, spliced, { varTextChanges: [] });
    return applied?.ok ? fixActionForMessage(sel.idx) : '替换回复失败，未应用。';
}

/* ------------------------------------------------------------------ *
 * ✂️ 多段选段校正（1.37.0）：调度器 + 汇总器包在冻结单段调用外面。
 * 每段一次今天的冻结调用（prompt/信封零偏差，H2）；并发有帽、逐段 fail-open（H5）；
 * 评审卡逐段勾选、应用一次性降序回插（H3/H4）。0/1 段走旧路（H1）。
 * ------------------------------------------------------------------ */

// 有界并发池：至多 limit 路同时跑 thunks，结果按【输入序】落位；单个 thunk 抛错 → 该槽
// {status:'failed', reason}（fail-open，一段的失败绝不拖垮别段）。JS 单线程事件循环下 next++ 无竞态。可单测。
async function runBoundedPool(thunks, limit) {
    const results = new Array(thunks.length);
    let next = 0;
    const worker = async () => {
        while (next < thunks.length) {
            const i = next++;
            try { results[i] = await thunks[i](); }
            catch (e) { results[i] = { status: 'failed', reason: String((e && e.message) || e) }; }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, thunks.length)) }, () => worker()));
    return results;
}

// 纯函数（多段选段）：单段成稿归类。fixNoOp → 'nochange'（模型按原样返回，无勾选框）；
// validateSpanFix 有警示 → 'warned'（出 diff、默认不勾）；干净 → 'ok'（默认勾上）。可单测。
function classifySpanResult(pinText, span, outsideText) {
    if (fixNoOp(pinText, span)) return { status: 'nochange' };
    const v = validateSpanFix(pinText, span, outsideText);
    return { status: v.warnings.length ? 'warned' : 'ok', warnings: v.warnings };
}

// 纯函数（多段选段）：批发原始结果 → 评审行。ok → 补算该段之外全文再归类（classifySpanResult）；
// 其余状态原样直通。对已整理行幂等（重试后整卡重画会二过）。可单测。
function prepareBatchRows(job, results) {
    return (results || []).map((r) => {
        if (!r || r.status !== 'ok') return { ...(r || { status: 'failed' }) };
        const outside = job.full.slice(0, r.pin.start) + job.full.slice(r.pin.end);
        const c = classifySpanResult(r.pin.text, r.span, outside);
        return { ...r, status: c.status, warnings: c.warnings || [] };
    });
}

// 单段调用核（多段选段）：批内每段一次。per-call 超时 + 批级中断双钩（手动链 AbortController，
// 不依赖 AbortSignal.any —— 老 WebView 兼容）；不碰任何模块级槽（prompt 已在起跑前同步建好）。
// 返回状态对象，绝不抛（fail-open，H5）：用户停止/切走 = aborted；单段超时 = failed（可重试）。
async function runSpanCall(s, messages, batchSignal) {
    const perCall = new AbortController();
    const onBatchAbort = () => { try { perCall.abort(); } catch (e) { /* ignore */ } };
    if (batchSignal.aborted) onBatchAbort();
    else batchSignal.addEventListener('abort', onBatchAbort, { once: true });
    const timer = setTimeout(onBatchAbort, POST_REPLY_CALL_TIMEOUT_MS);
    try {
        const finalText = await fixCallTransport(s, messages, perCall.signal, () => { /* 批发不逐段直播（v1） */ });
        const parsed = parseFixSpan(finalText);
        if (parsed.status !== 'ok') return { status: parsed.status };   // 'truncated' | 'unparseable'
        return { status: 'ok', span: parsed.span };
    } catch (e) {
        if (batchSignal.aborted) return { status: 'aborted' };
        if (isUserAbort(e)) return { status: 'failed', reason: '单段超时' };
        return { status: 'failed', reason: String((e && e.message) || e) };
    } finally {
        clearTimeout(timer);
        try { batchSignal.removeEventListener('abort', onBatchAbort); } catch (e) { /* ignore */ }
    }
}

// 多段批发主流程：运行期气泡不会中途进入 convo；形成可用评审卡后才持久化结果。
async function runFixSelectBatch(sharedInstr) {
    if (!ENABLE_FIX_SELECT || isGenerating) return;
    if (!fixSelState || !Array.isArray(fixSelState.pins) || fixSelState.pins.length < 2) return;
    const ctx = getCtx();
    const s = getSettings();
    // 快照（await 前）：重开卡会覆盖 fixSelState，批发全程只认起跑这一刻的钉选
    const job = { idx: fixSelState.idx, swipeId: fixSelState.swipeId, fingerprint: fixSelState.fingerprint, full: fixSelState.full, pins: fixSelState.pins.map((p) => ({ ...p })) };
    const fixContext = await captureFixContext(s, { mode: 'manual' });
    const calls = job.pins.map((pin) => ({
        pin,
        messages: buildSpanMessages(ctx, s, { full: job.full, text: pin.text }, resolvePinInstruction(pin.instr, sharedInstr), fixContext),
    }));
    const aEntry = { id: nextCid(), role: 'assistant', content: '' };
    const assistantEl = addMessage('assistant', '', aEntry);
    aEntry._el = assistantEl;
    const contentEl = assistantEl.querySelector('.pad-content');
    const clearTyping = showTyping(contentEl);
    const ctl = beginGeneration();
    const batchSignal = ctl.signal;
    let done = 0;
    try {
        const results = await runBoundedPool(calls.map((c) => () =>
            runSpanCall(s, c.messages, batchSignal).then((r) => {
                done++;
                clearTyping();
                contentEl.textContent = `多段校正进行中… ${done}/${calls.length} 段完成`;
                return { ...r, pin: c.pin, messages: c.messages };
            })
        ), MULTIFIX_CONCURRENCY);
        clearTyping();
        renderFixSelectBatchResult(assistantEl, contentEl, job, results, aEntry);
    } catch (e) {
        clearTyping();
        contentEl.textContent = '多段校正失败：' + ((e && e.message) || e);
        contentEl.classList.add('pad-hint-error');
    } finally {
        finishGeneration();
        if (soFollowStream) scrollToBottom();
    }
}

// 多段评审卡同样默认展示每段差异；各段「看全文」展开新片段。
function renderFixSelectBatchResult(assistantEl, contentEl, job, results, entry) {
    const rows = prepareBatchRows(job, results);
    const changed = rows.filter((r) => r.status === 'ok' || r.status === 'warned').length;
    const kept = rows.filter((r) => r.status === 'nochange').length;
    const failed = rows.length - changed - kept;
    contentEl.textContent = `多段校正完成：改了 ${changed} 段 / 保留 ${kept} 段 / 失败 ${failed} 段。逐段核对后应用勾选的段。`;
    entry.content = contentEl.textContent;
    persistFixResultEntry(entry);
    const bubble = assistantEl.querySelector('.pad-bubble') || contentEl.parentElement;
    const old = bubble.querySelector('.pad-multifix-box');
    if (old) old.remove();
    const box = document.createElement('div');
    box.className = 'pad-multifix-box';
    const STATUS_LABEL = { nochange: '未改动（模型按原样返回）', truncated: '疑似截断——保留原文', unparseable: '未解析出改写稿——保留原文', failed: '调用失败——保留原文', aborted: '已停止——保留原文' };
    rows.forEach((r, i) => {
        const row = document.createElement('div');
        row.className = 'pad-multifix-row pad-multifix-' + r.status;
        const head = document.createElement('div');
        head.className = 'pad-multifix-rowhead';
        const excerpt = r.pin.text.slice(0, 15) + (r.pin.text.length > 15 ? '…' : '');
        if (r.status === 'ok' || r.status === 'warned') {
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.className = 'pad-multifix-accept';
            cb.checked = (r.status === 'ok');
            cb.dataset.row = String(i);
            const lb = document.createElement('label');
            lb.appendChild(cb);
            lb.appendChild(document.createTextNode(` 片段${i + 1}「${excerpt}」`));
            head.appendChild(lb);
            const fullBtn = document.createElement('button');
            fullBtn.className = 'pad-apply-btn pad-multifix-diffbtn';
            fullBtn.textContent = '看全文';
            head.appendChild(fullBtn);
            row.appendChild(head);
            for (const warningText of (r.warnings || [])) {
                const warning = document.createElement('div');
                warning.className = 'pad-fix-nearcopy-warn';
                warning.textContent = warningText;
                row.appendChild(warning);
            }
            const diff = renderDiffCard(r.pin.text, r.span);
            const full = document.createElement('div');
            full.className = 'pad-fix-full';
            full.textContent = r.span;
            full.hidden = true;
            fullBtn.addEventListener('click', () => {
                full.hidden = !full.hidden;
                fullBtn.textContent = full.hidden ? '看全文' : '收起全文';
            });
            row.appendChild(diff);
            row.appendChild(full);
        } else {
            head.textContent = `片段${i + 1}「${excerpt}」：` + (STATUS_LABEL[r.status] || STATUS_LABEL.failed) + (r.reason ? `（${r.reason}）` : '');
            row.appendChild(head);
        }
        box.appendChild(row);
    });
    const bar = document.createElement('div');
    bar.className = 'pad-apply-bar pad-multifix-bar';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'pad-apply-btn';
    const status = document.createElement('span');
    status.className = 'pad-apply-status';
    let action = null;
    registerFixActionPainter(applyBtn, () => action ? paintFixActionButton(applyBtn, action) : null);
    const updateApplyLabel = () => {
        if (action) {
            paintFixActionButton(applyBtn, action);
            applyBtn.disabled = false;
            return;
        }
        const count = box.querySelectorAll('.pad-multifix-accept:checked').length;
        applyBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 应用勾选的 ' + count + ' 段';
        applyBtn.disabled = count === 0;
    };
    box.addEventListener('change', (event) => {
        if (event.target?.classList?.contains('pad-multifix-accept')) updateApplyLabel();
    });
    applyBtn.addEventListener('click', async () => {
        applyBtn.disabled = true;
        status.classList.remove('pad-hint-error');
        if (action) {
            await toggleFixAction(applyBtn, status, action);
            applyBtn.disabled = false;
            return;
        }
        const accepted = [];
        box.querySelectorAll('.pad-multifix-accept:checked').forEach((checkbox) => {
            const row = rows[Number(checkbox.dataset.row)];
            if (row && typeof row.span === 'string') accepted.push(row);
        });
        const result = await applyFixSelectBatch(job, accepted);
        if (typeof result === 'object' && result) {
            action = result;
            entry.fixAction = action;
            persistConvo();
            paintFixActionButton(applyBtn, action);
            status.textContent = '已替换这条回复，可随时撤销。';
            applyBtn.disabled = false;
        } else {
            status.textContent = result;
            updateApplyLabel();
        }
    });
    bar.appendChild(applyBtn);
    const retriable = rows.filter((r) => r.status === 'failed' || r.status === 'truncated' || r.status === 'unparseable' || r.status === 'aborted');
    if (retriable.length) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'pad-apply-btn';
        retryBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i> 重试失败的 ' + retriable.length + ' 段';
        retryBtn.addEventListener('click', () => retryFixSelectBatch(assistantEl, contentEl, job, rows, entry));
        bar.appendChild(retryBtn);
    }
    bar.appendChild(status);
    box.appendChild(bar);
    bubble.appendChild(box);
    updateApplyLabel();
    scrollToBottom();
}

// 重试失败段：只重发 failed/truncated/unparseable/aborted 的段。messages 起跑时已建好、【原样复用】——
// 不重建 prompt、不再 captureFixContext（信封与首轮字节相同，H2 恒守）。归并结果后整卡重画。
async function retryFixSelectBatch(assistantEl, contentEl, job, rows, entry) {
    if (isGenerating) return;
    const s = getSettings();
    const targets = [];
    rows.forEach((r, i) => { if (r.status === 'failed' || r.status === 'truncated' || r.status === 'unparseable' || r.status === 'aborted') targets.push(i); });
    if (!targets.length) return;
    const ctl = beginGeneration();
    const batchSignal = ctl.signal;
    let done = 0;
    contentEl.textContent = `重试中… 0/${targets.length} 段完成`;
    try {
        const rr = await runBoundedPool(targets.map((i) => () =>
            runSpanCall(s, rows[i].messages, batchSignal).then((r) => {
                done++;
                contentEl.textContent = `重试中… ${done}/${targets.length} 段完成`;
                return r;
            })
        ), MULTIFIX_CONCURRENCY);
        targets.forEach((rowIdx, j) => { rows[rowIdx] = { ...rows[rowIdx], ...rr[j] }; });
        renderFixSelectBatchResult(assistantEl, contentEl, job, rows, entry);
    } catch (e) {
        contentEl.textContent = '重试失败：' + ((e && e.message) || e);
    } finally {
        finishGeneration();
    }
}

// 多段应用保持原子性：指纹不符整单拒绝；成功只原位替换一次。
async function applyFixSelectBatch(job, accepted) {
    if (!accepted || !accepted.length) return '没有勾选任何段，未应用。';
    const ctx = getCtx();
    const message = (ctx.chat || [])[job.idx];
    if (!message || typeof message.mes !== 'string') return '目标回复已不在了，未应用。';
    if (fixFingerprint(message.mes) !== job.fingerprint) return '这条回复自钉选后已发生变化（切换了回复分支 / 被改过）——为免覆盖新内容，未应用。请重开选段校正。';
    const spliced = spliceSpansBackToFront(message.mes, accepted.map((row) => ({ start: row.pin.start, end: row.pin.end, replacement: row.span })));
    if (spliced == null) return '回插位置越界，未应用（请重开选段校正）。';
    const applied = await applyFixInPlace(job.idx, spliced, { varTextChanges: [] });
    return applied?.ok ? fixActionForMessage(job.idx) : '替换回复失败，未应用。';
}

// 「按目标校正最新回复」：用勾选的目标 + 约束（不是手动输入）当指令，对最新回复跑一次两段式校正并出卡。
// 这是后续自动模式的核心，这里由按钮手动触发。一次性非流式调用（仿 runAutoDiagnose）。
export async function runFixByTargets(options = {}) {
    if (isGenerating) return;
    const s = options.settings || getSettings();
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) { addSystemNote('请先在设置里配置直连端点与模型。'); return; }
    if (s.mode === 'profile' && !s.profileId) { addSystemNote('请先在设置里选择一个连接配置档。'); return; }
    const fixContext = options.fixContext || await captureFixContext(s, { mode: 'auto' });
    if (!fixContext.targetProse.trim()) { addSystemNote('没找到可校正的 AI 回复（主聊天里要先有一条 AI 回复）。'); return; }
    // 手动重复校正继续允许，但明确提醒会覆盖上一层单步撤销记录。
    if (isFixedReply((getCtx().chat || [])[fixContext.targetIdx])) addSystemNote('这条回复当前显示的已是一次校正结果；继续应用会覆盖上一层撤销记录。');
    // ✨ Phase 5 D+E 门：与 runAutoFix 同一套判断（RESOLUTION A——这个按钮走的也是「自动」那套配置，理应遵守
    // 同一份 D 静默兜底），只是这里是一次性、有人盯着屏幕的手动触发，所以走 addSystemNote 通道（普通侧聊提示），
    // 不是 addAutoFixNote 的持久记录；suggest / skip 时直接 return，不出校正卡（呼应下面「没找到可校正的
    // AI 回复」那类提前退出，不留下一张会误导的卡片）。
    const scopeDec = fixContext.scopeDecision;
    if (scopeDec && scopeDec.action === 'detected') {
        setFixCfg({ fixA_scopeTag: scopeDec.tag, fixA_scopeManual: false });
        const scopeEl = win && win.querySelector('#pad-fix-scope');
        if (scopeEl) scopeEl.value = scopeDec.tag;
        addSystemNote(fixScopeNoteText(scopeDec.note).body);
    } else if (scopeDec && (scopeDec.action === 'suggest' || scopeDec.action === 'skip')) {
        addSystemNote(fixScopeNoteText(scopeDec.note).body);
        return;
    }
    // ✨ 分段校正（1.18.0）门（与 runAutoFix 同一套决策；这里是有人盯着屏幕的手动触发 → addSystemNote 通道，
    // 呼应 1.17.16 的 RESOLUTION A）。ask 时用户在场：立刻把提案摆出来（addSystemNote）+ 走一次 emitPieceAsk
    // （toast 可点确认 + 持久记录 + 记 pieceAsked），本轮不校正。
    if (ENABLE_FIX_PIECEWISE && fixContext.pieceDecision) {
        const pd = fixContext.pieceDecision;
        if (pd.adopt) {
            const cur = getEffectiveFixCfg(s, getFixCfg());
            if (cur.fixA_pieceMode !== 'wrapped' || cur.fixA_scopeTag !== pd.tag) {
                setFixCfg({ fixA_pieceMode: 'wrapped', fixA_scopeTag: pd.tag, fixA_scopeManual: false });
                const scopeEl = win && win.querySelector('#pad-fix-scope');
                if (scopeEl) scopeEl.value = pd.tag;
                if (!pd.adopt.quiet) addSystemNote(fixScopeNoteText(pd.note).body);
            }
        }
        if (pd.action === 'ask' || pd.action === 'pending') {
            const p = pd.proposal || { prose: 0, guards: 0 };
            const guess = (pd.mode === 'wrapped' && pd.tag)
                ? `我认为这张卡的正文包在 <${pd.tag}> 里`
                : '这张卡没有正文包裹标签，我认为正文是【标签之外的散文】';
            addSystemNote(`✋ 需要先确认一次：${guess}（约 ${p.prose | 0} 字；${p.guards | 0} 块结构将原样保留）。点弹出的提示或「校正设置」判定行的「确认」，然后再按此按钮。`);
            if (pd.action === 'ask') emitPieceAsk(pd); else updateFixVerdict();
            return;
        }
        if (pd.action === 'suggest' || pd.action === 'skip') { addSystemNote(fixScopeNoteText(pd.note).body); return; }
        if (fixContext.pieceTable) { await runFixByTargetsPieces(s, fixContext); return; }
        // bypass / whole：继续走下面的老单段路径
    }
    // 自动模式配置（per-chat 覆盖全局，再经 resolveFixModeCfg 归一）。
    const a = resolveFixModeCfg(getEffectiveFixCfg(s, getFixCfg()), 'auto');
    const directive = options.directive ?? compileFixTargets(
        a.targets,
        { card: a.includeCard, context: a.includeContext, world: a.includeWorld },
        { knowledge: a.knowledge, guardrails: a.guardrails },
        fixTargetOverrides(s),
    );
    if (!directive) { addSystemNote('还没勾选任何校正目标、也没填约束。请在「校正设置」里勾选或填写，或直接在下方输入框手动说要改什么。'); return; }

    const ctx = options.ctx || getCtx();
    const messages = options.messages || ((fixUsePresetFor(s, 'auto') && presetCurationActive(s))
        ? buildFixPresetMessages(s, directive, fixContext)
        : maybeWrapJb([{ role: 'system', content: buildFixPrompt(ctx, s, fixContext) }, { role: 'user', content: directive }], 'fixAuto', s));
    const aEntry = { id: nextCid(), role: 'assistant', content: '' };
    const assistantEl = options.assistantEl || addMessage('assistant', '', aEntry);
    aEntry._el = assistantEl;
    const contentEl = assistantEl.querySelector('.pad-content');
    const clearTyping = (options.showTyping || showTyping)(contentEl);
    const ctl = beginGeneration();
    const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, POST_REPLY_CALL_TIMEOUT_MS);
    try {
        const effMaxTokens = fixEffMaxTokens(s);   // Tier 0 ③：可被 fixMaxTokens 顶高（长楼层）
        const onCum = s.stream ? (full) => { clearTyping(); contentEl.textContent = full; if (soFollowStream) scrollToBottom(); } : undefined;
        if (s.stream) contentEl.classList.add('pad-streaming');
        const finalText = await fixCallTransport(s, messages, ctl.signal, onCum, effMaxTokens, options.transport);
        if (s.stream) contentEl.classList.remove('pad-streaming');
        clearTyping();
        if ((options.renderFixCard || renderFixCard)(assistantEl, contentEl, aEntry, finalText, fixContext) !== 'ok') {
            contentEl.textContent = finalText || '（空回复）';
            addSystemNote('没能从模型回复里解析出 <FixedReply> 校正稿。请检查连接 / 模型，或调整目标后重试。');
        }
    } catch (e) {
        clearTyping();
        if (isUserAbort(e)) {
            contentEl.textContent = '(已停止)';                       // 用户点停止键中断 → 平静收尾，不当报错（与 generateReply 一致）
        } else {
            contentEl.textContent = '校正失败：' + (e?.message || e);
            contentEl.classList.add('pad-hint-error');
        }
    } finally {
        clearTimeout(timer);
        finishGeneration();
        if (soFollowStream) scrollToBottom();   // #1 定稿后只在用户跟随到底部时才滚
    }
}

// 「按目标校正」的分段版：在侧聊气泡里逐段跑。发送键=停止键（generation 控制器中的 AbortController），
// 点停止 → isUserAbort → 「(已停止)」平静收尾、不写。跑完出校正卡：正文 =
// 各段校正稿拼接（预览），「应用到回复」写入 splice 回原位的整条（addFixApplyControls finalOverride），
// 应用前陈旧守卫照跑（fixContext.captured）。「看改动」= 修好各段的 prose↔prose 拼接对比（守卫两侧都不在，不刷屏）。
async function runFixByTargetsPieces(s, fixContext) {
    const ctx = getCtx();
    const table = fixContext.pieceTable;
    if (!table || !table.pieces.length) return;
    const cfg = getEffectiveFixCfg(s, getFixCfg());
    const a = resolveFixModeCfg(cfg, 'auto');
    const constraints = { knowledge: a.knowledge, guardrails: a.guardrails };
    const directive = compileFixTargets(a.targets, { card: a.includeCard, context: a.includeContext, world: a.includeWorld }, constraints, fixTargetOverrides(s));
    if (!directive) { addSystemNote('还没勾选任何校正目标、也没填约束。请在「校正设置」里勾选或填写，或直接在下方输入框手动说要改什么。'); return; }
    // ✨ 整体校正（默认开）：一次调用；结构块锚点原位保留。join 为 null（零正文）走下面分段路径的空提示。
    const join = a.pieceJoin ? fixJoinTable(table, a.dropTags) : null;
    const plan = join ? null : fixPiecePlan(table.pieces, a.targets, constraints, clampFixAutoMinChars(cfg.fixAutoMinChars));
    if (!join && !plan.attempts.length) { addSystemNote(`这条回复分了 ${table.pieces.length} 段正文，但都太短 / 成本门判定不值得发调用（可调低「成本门字符数」再试）。`); return; }
    const aEntry = { id: nextCid(), role: 'assistant', content: '' };
    const assistantEl = addMessage('assistant', '', aEntry);
    aEntry._el = assistantEl;
    const contentEl = assistantEl.querySelector('.pad-content');
    const clearTyping = showTyping(contentEl);
    const ctl = beginGeneration();
    const results = join ? [] : plan.entries.map((e) => ({ status: e.status }));
    let stopped = false;
    let joinResult = null;
    try {
        if (join) {
            clearTyping();
            const joinHead = `整体校正中…（1 次调用；${join.keepBlocks.length} 块结构锚点原位保留）`;
            contentEl.textContent = joinHead;
            const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, POST_REPLY_CALL_TIMEOUT_MS);
            try {
                contentEl.classList.add('pad-streaming');
                // ✨ 1.18.3：按钮路径流式直播草稿（尊重全局 流式 开关；锚点 / <FixedReply> 标签会原样闪过——
                // 定稿后由下方卡片渲染替换，同弧线实时输出的契约）。
                joinResult = await fixJoinCall(ctx, s, directive, join, ctl.signal,
                    (full) => { contentEl.textContent = joinHead + '\n\n' + full; if (soFollowStream) scrollToBottom(); }, fixContext);
            } catch (e) {
                if (isUserAbort(e)) { stopped = true; }
                else joinResult = { status: 'failed', reason: 'error' };
            } finally { clearTimeout(timer); contentEl.classList.remove('pad-streaming'); }
        } else {
            for (let k = 0; k < plan.attempts.length; k += 1) {
                const i = plan.attempts[k];
                clearTyping();
                const pieceHead = `正在分段校正…（第 ${k + 1}/${plan.attempts.length} 次调用，共 ${table.pieces.length} 段正文）`;
                contentEl.textContent = pieceHead;
                const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, POST_REPLY_CALL_TIMEOUT_MS);
                try {
                    contentEl.classList.add('pad-streaming');
                    results[i] = await fixPieceCall(ctx, s, a, directive, table.pieces[i], ctl.signal,
                        (full) => { contentEl.textContent = pieceHead + '\n\n' + full; if (soFollowStream) scrollToBottom(); }, fixContext);
                } catch (e) {
                    if (isUserAbort(e)) { stopped = true; break; }
                    results[i] = { status: 'failed', reason: 'error' };
                } finally { clearTimeout(timer); contentEl.classList.remove('pad-streaming'); }
            }
        }
        clearTyping();
        if (stopped) { contentEl.textContent = '(已停止)'; return; }
        // ✨ 整体校正：单结果直接出卡（应用 = head + 校正稿(锚点已还原) + tail）。
        if (join) {
            const r = joinResult || { status: 'failed', reason: 'error' };
            if (r.status !== 'fixed') {
                contentEl.textContent = r.status === 'truncated'
                    ? '校正稿像是被截断了（未改动回复）——把「最大 token 数」调大些再试。'
                    : (r.status === 'clean' || r.status === 'gated')
                        ? '模型判定无需改动（未改动回复）。'
                        : '整体校正没有产出可用的校正稿（未改动回复）。';
                return;
            }
            const spliced2 = join.head + r.fixedCore + join.tail;
            aEntry.content = r.after;
            persistFixResultEntry(aEntry);
            const html2 = renderFixResultHtml(r.after);
            if (html2 != null) {
                contentEl.innerHTML = html2;
                contentEl.classList.add('pad-rendered');
                contentEl.style.whiteSpace = 'normal';
            } else {
                contentEl.textContent = r.after;
            }
            const note2 = document.createElement('div');
            note2.className = 'pad-fix-changes';
            note2.textContent = `整体校正：1 次调用，${join.keepBlocks.length} 块结构锚点原位保留`
                + (r.anchorsMissing ? `\n⚠ ${r.anchorsMissing} 个锚点被模型挪动 / 弄丢，内容已兜底接回正文末尾（位置若不对可不应用）` : '')
                + (r.problems ? '\n发现并修正：\n' + r.problems : '');
            assistantEl.querySelector('.pad-bubble')?.appendChild(note2);
            // 重画保真（1.33.1）：登记应用材料，换房重画时最新一条凭它重挂（说明文一并原样重挂）。
            registerFixApply(aEntry, { fixed: r.after, problems: '' }, r.before, fixContext.targetIdx, [], { active: false }, fixContext.captured, spliced2, note2.textContent);
            addFixApplyControls(assistantEl, { fixed: r.after, problems: '' }, r.before, fixContext.targetIdx, [], { active: false }, fixContext.captured, spliced2, { entry: aEntry });
            return;
        }
        const summary = fixPieceSummary(table.pieces, results);
        if (summary.status === 'none') {
            contentEl.textContent = summary.failLines.length
                ? ('分段校正没有产出可用的校正稿（未改动回复）：\n' + summary.failLines.join('\n'))
                : '各段都无需校正 / 未过成本门（未改动回复）。';
            return;
        }
        const spliced = fixSpliceTable(table, results);
        aEntry.content = summary.afterJoined;
        persistFixResultEntry(aEntry);
        const html = renderFixResultHtml(summary.afterJoined);
        if (html != null) {
            contentEl.innerHTML = html;
            contentEl.classList.add('pad-rendered');
            contentEl.style.whiteSpace = 'normal';
        } else {
            contentEl.textContent = summary.afterJoined;
        }
        const note = document.createElement('div');
        note.className = 'pad-fix-changes';
        note.textContent = summary.headline
            + (summary.failLines.length ? '\n' + summary.failLines.join('\n') : '')
            + (summary.problems ? '\n发现并修正：\n' + summary.problems : '');
        assistantEl.querySelector('.pad-bubble')?.appendChild(note);
        // 应用控件：finalOverride = splice 好的整条；diff 用修好各段的 prose↔prose 拼接（keep 空、scope 关）。
        // 重画保真（1.33.1）：登记应用材料，换房重画时最新一条凭它重挂（说明文一并原样重挂）。
        registerFixApply(aEntry, { fixed: summary.afterJoined, problems: '' }, summary.beforeJoined, fixContext.targetIdx, [], { active: false }, fixContext.captured, spliced, note.textContent);
        addFixApplyControls(assistantEl, { fixed: summary.afterJoined, problems: '' }, summary.beforeJoined, fixContext.targetIdx, [], { active: false }, fixContext.captured, spliced, { entry: aEntry });
    } catch (e) {
        clearTyping();
        contentEl.textContent = '校正失败：' + (e?.message || e);
        contentEl.classList.add('pad-hint-error');
    } finally {
        finishGeneration();
        if (soFollowStream) scrollToBottom();
    }
}

// 「正在校正…」提示（仿 showAutoDiagGenerating）。timeOut:0 = 不自动消失，由我们在生成结束后 dismissToast 收掉。
export function showAutoFixGenerating() {
    try {
        if (window.toastr && window.toastr.info) {
            return window.toastr.info('正在校正最新回复…（点此中断）', '剧情推进 · 自动校正', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, onclick: () => cancelPostReply() });
        }
    } catch (e) { /* ignore */ }
    return null;
}

// 纯副作用：在侧聊里留一条【持久】自动校正记录（仿 notifyAutoDiagnose 的记录部分）。status:
// fixed / nochange / failed；problems = 「发现并修正」摘要（仅 fixed 有意义，可空）。窗口关着也留得下
// （DOM 在 init 建好），随 per-chat 持久化、跨重载存活；是 note 条目、绝不回灌给模型（见 convoForPrompt）。
export function addAutoFixNote(status, problems, fix = null, meta = null, notices = []) {
    try {
        const stamp = (() => { try { return new Date().toLocaleTimeString(); } catch (e) { return ''; } })();
        // 📋 meta = { task:'custom', template } → 记录换族（customTaskNoteContent）；meta 为空 = 校正一族，字节不动。
        const base = (meta && meta.task === 'custom')
            ? customTaskNoteContent({ status, problems, stamp, template: meta.template })
            : autoFixNoteContent({ status, problems, stamp });
        const extra = (Array.isArray(notices) ? notices : []).map((line) => String(line || '').trim()).filter(Boolean);
        const content = base + (extra.length ? '\n' + extra.join('\n') : '');
        const entry = { id: nextCid(), role: 'note', content, ...(fix ? { fixAction: fix } : {}) };
        // locator 进入持久侧聊条目；前后正文与 applied 状态仍以主消息自身记录为准。
        appendNoteToRoom('fix', entry, fix ? { fix } : null);
    } catch (e) { console.warn('[剧情推进] 自动校正记录写入侧聊失败：', e); }
}

// ✨ 分段校正「需要确认一次」（设计 §3 阶梯 8；1.17.4 toast-as-button 惯例）：散文+结构混排的卡第一次
// 遇到时问一次——本轮不校正：持久侧聊记录（autoFixNoteContent 'ask'）+ 可点确认的 toast + 记
// fixA_pieceAsked + 按钮转琥珀 pending。确认（confirmPieceBare）后按聊天记住 bare，之后每条新回复照常
// 分段校正。不确认：后续回复走 emitPiecePending【重弹可点 toast + 保持琥珀按钮】，绝不无声跳过——不确定性
// 是可见的问题（Option B：kill the silence，2026-07-07，修 prince-09 bare 卡「自动校正静默漏抓」）。
export function emitPieceAsk(dec) {
    setFixCfg({ fixA_pieceAsked: true });
    const p = (dec && dec.proposal) || { prose: 0, guards: 0 };
    const wrappedTag = (dec && dec.mode === 'wrapped' && dec.tag) ? dec.tag : '';
    addAutoFixNote('ask', { ...p, tag: wrappedTag });
    try {
        if (window.toastr && window.toastr.info) {
            const body = wrappedTag
                ? `✨校正需要确认一次：我认为这张卡的正文包在 <${wrappedTag}> 里（约 ${p.prose | 0} 字；${p.guards | 0} 块结构将原样保留）——点此确认`
                : `✨校正需要确认一次：这张卡没有正文包裹标签，我认为正文是【标签之外的散文】（约 ${p.prose | 0} 字；${p.guards | 0} 块结构将原样保留）——点此确认`;
            window.toastr.info(body, '剧情推进 · 自动校正',
                { timeOut: 20000, extendedTimeOut: 20000, onclick: () => (wrappedTag ? confirmPieceWrapped(wrappedTag) : confirmPieceBare()) });
        }
    } catch (e) { /* ignore */ }
    updateFixVerdict();
    updateFixButtonVisual();   // ✨ 问过 → 按钮转琥珀 pending（关着面板也看得见）
}

// pending（已问过、还没确认一次）：第一次 ask 已留过侧聊记录，这里不再逐条写记录（免刷屏），但每条新
// 回复仍【重新弹一次可点确认的 toast】+ 刷新判定行——让关着面板的用户也一直看得见「等你确认一次」，绝不
// 无声跳过（Option B：kill the silence）。点 toast 即 confirmPieceBare/Wrapped，之后每条回复正常自动校正。
export function emitPiecePending(dec) {
    const p = (dec && dec.proposal) || { prose: 0, guards: 0 };
    const wrappedTag = (dec && dec.mode === 'wrapped' && dec.tag) ? dec.tag : '';
    try {
        if (window.toastr && window.toastr.info) {
            const body = wrappedTag
                ? `✨校正等你确认一次：我认为这张卡的正文包在 <${wrappedTag}> 里（约 ${p.prose | 0} 字；${p.guards | 0} 块结构原样保留）——点此确认后开始自动校正`
                : `✨校正等你确认一次：这张卡的正文是【标签之外的散文】（约 ${p.prose | 0} 字；${p.guards | 0} 块结构原样保留）——点此确认后开始自动校正`;
            window.toastr.info(body, '剧情推进 · 自动校正',
                { timeOut: 12000, extendedTimeOut: 12000, onclick: () => (wrappedTag ? confirmPieceWrapped(wrappedTag) : confirmPieceBare()) });
        }
    } catch (e) { /* ignore */ }
    updateFixVerdict();
}

// 用户确认「正文是散文」：按聊天记住 bare（confirm-once 的 remember 半步）。
export function confirmPieceBare() {
    setFixCfg({ fixA_pieceMode: 'bare' });
    try { window.toastr && window.toastr.success && window.toastr.success('已确认：之后自动校正只改【标签之外的散文】，结构块原样保留。', '剧情推进 · 自动校正'); } catch (e) { /* ignore */ }
    updateFixVerdict();
    updateFixButtonVisual();   // ✨ 确认 → pending 琥珀清除、转正常金
}

// 用户确认「正文包在 <tag> 里」（梯 7.5 未知包裹名提案）：按聊天记住 wrapped + 标签（非手填，之后仍可自纠）。
export function confirmPieceWrapped(tag) {
    setFixCfg({ fixA_pieceMode: 'wrapped', fixA_scopeTag: tag, fixA_scopeManual: false });
    const scopeEl = win && win.querySelector('#pad-fix-scope');
    if (scopeEl) scopeEl.value = tag;
    try { window.toastr && window.toastr.success && window.toastr.success(`已确认：之后自动校正只改 <${tag}> 里的正文，标签外与内嵌结构块原样保留。`, '剧情推进 · 自动校正'); } catch (e) { /* ignore */ }
    updateFixVerdict();
    updateFixButtonVisual();   // ✨ 确认 → pending 琥珀清除、转正常金
}

// 一次普通校正调用跑一个正文片段。片段正文与保留区以派生上下文显式传递，
// 不修改 captureFixContext 返回的冻结对象。
export async function fixPieceCall(ctx, s, a, directive, piece, signal, onDelta, fixContext) {
    const ex = extractExcludedSections(piece.core, a.keepTags, a.dropTags);
    const pieceProse = stripMechanismBlocks(ex.prose);
    if (!pieceProse.trim()) return { status: 'gated' };
    const pieceContext = Object.freeze({ ...fixContext, targetProse: pieceProse, extraKeep: ex.keepBlocks });
    const messages = (fixUsePresetFor(s, 'auto') && presetCurationActive(s))
        ? buildFixPresetMessages(s, directive, pieceContext)
        : maybeWrapJb([{ role: 'system', content: buildFixPrompt(ctx, s, pieceContext) }, { role: 'user', content: directive }], 'fixAuto', s);
    const finalText = await fixCallTransport(s, messages, signal, onDelta);
    const parsed = parseFixedReply(finalText);
    if (!parsed) return { status: 'failed', reason: fixFailureReason(finalText, undefined).kind };
    const finishHint = (/<FixedReply\b[^>]*>/i.test(finalText) && !/<\/FixedReply\s*>/i.test(finalText)) ? 'length' : undefined;
    if (fixOutputTruncated(parsed.fixed, finishHint, pieceProse).truncated) return { status: 'truncated' };
    if (fixEffectivelyUnchanged(pieceProse, parsed.fixed)) return { status: 'clean' };
    return { status: 'fixed', fixedCore: composeFixedReply(parsed.fixed, piece.core, ex.keepBlocks), problems: parsed.problems || '', before: pieceProse, after: parsed.fixed };
}

// 整体校正的一次调用：join 的正文与保留锚点同样只进入派生上下文。
export async function fixJoinCall(ctx, s, directive, join, signal, onDelta, fixContext) {
    const pieceProse = fixContext.rewriteVariableBlock ? join.core : stripMechanismBlocks(join.core);
    if (!pieceProse.trim()) return { status: 'gated' };
    const joinContext = Object.freeze({ ...fixContext, targetProse: pieceProse, extraKeep: join.keepBlocks });
    const custom = (ENABLE_FIX_CUSTOM_TASK && joinContext.activeMode === 'custom');
    // 判据必须认捕获时的 customJoin，而不是 join.raw：raw:false 退路同样来自 fixCustomRawTable。
    const customRawTable = (custom && !!joinContext.customJoin);
    const jbMode = custom ? 'fixCustom' : 'fixAuto';
    const messages = (fixUsePresetFor(s, custom ? 'custom' : 'auto') && presetCurationActive(s))
        ? buildFixPresetMessages(s, directive, joinContext)
        : maybeWrapJb([{ role: 'system', content: buildFixPrompt(ctx, s, joinContext) }, { role: 'user', content: directive }], jbMode, s);
    const finalText = await fixCallTransport(s, messages, signal, onDelta);
    const parsed = parseFixedReply(finalText);
    if (!parsed) return { status: 'failed', reason: fixFailureReason(finalText, undefined).kind };
    const finishHint = (/<FixedReply\b[^>]*>/i.test(finalText) && !/<\/FixedReply\s*>/i.test(finalText)) ? 'length' : undefined;
    if (fixOutputTruncated(parsed.fixed, finishHint, pieceProse).truncated) return { status: 'truncated' };
    if (fixEffectivelyUnchanged(pieceProse, parsed.fixed)) return { status: 'clean' };
    const anchorsMissing = join.keepBlocks.filter((b, i) => !parsed.fixed.includes(fixKeepPlaceholder(i))).length;
    const composed = composeFixedReplyDetailed(parsed.fixed, join.core, join.keepBlocks, {
        rewriteVariableBlock: !!joinContext.rewriteVariableBlock,
    });
    return {
        status: 'fixed', fixedCore: composed.text, problems: parsed.problems || '',
        before: pieceProse, after: parsed.fixed, anchorsMissing, skipMvuTail: customRawTable,
        varTextChanges: composed.varTextChanges, variableBlock: composed.variableBlock,
    };
}