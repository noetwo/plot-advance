import { getCtx, getSettings, uiConfirm } from './settings.js';

import { CONVO_META_KEY, DIAG_WI_META_KEY, SUMMARY_META_KEY, WI_CUSTOM_META_KEY, getChatMetadataSafe } from '../modes/advisor/metadata.js';
import { BUILDER_VARIANTS, builderVariantKey } from '../modes/lorebook/core.js';
import { ENABLE_BUILDER_PERSONA_STYLES, ENABLE_MODE_ROOMS } from '../prompts/builtins.js';
import { builderTargetLabel } from '../prompts/helpers.js';
import { abortCtl, convo, convoStreamKey, isGenerating, liveCondense, liveForge } from './runtime-state.js';
import { diagEntrySel } from '../modes/diagnose/state.js';

/* ------------------------------------------------------------------ *
 * 用户功能请求：按【当前聊天】持久化侧聊历史 + 运行概要（与剧情脉络同风格——
 * 随聊天保存、随切换刷新、只在手动清空时清掉）。
 * ------------------------------------------------------------------ */
// 写元数据后触发 ST 的持久化（setPath 等共用的安全封装）。
export function saveChatMetadata() {
    try {
        const ctx = getCtx();
        (ctx.saveMetadataDebounced || ctx.saveMetadata || (() => {}))();
    } catch (e) { /* metadata still set in memory */ }
}

// 纯函数：剥掉 _el（DOM 链接）等运行期字段，只留可持久化的 {id, role, content}。也保留自动诊断
// 的 note 记录（用户功能请求：把自动诊断的回复留在侧聊框里、跨重载存活）。可单测。
// diagStamp（Task 5）是唯一的例外字段：诊断卡片的陈旧印章要跨重载才拦得住「躺了很久的卡片按旧状态
// 写入」。只留【最后一枚】——能重挂应用按钮的只有本房最新那张卡（repaintControlPlan 的 latest-only
// 规则），旧印章纯粹占元数据，而 statKey 是整份 stat_data 的指纹、不小。
// 读回（loadConvoForChat）也走本函数：落盘与读回共用一份口径，两处各写一遍必然漂移。
export function serializeConvo(list) {
    const out = (Array.isArray(list) ? list : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'note') && typeof m.content === 'string')
        .map((m) => (m.diagStamp && typeof m.diagStamp === 'object')
            ? { id: m.id, role: m.role, content: m.content, diagStamp: m.diagStamp }
            : { id: m.id, role: m.role, content: m.content });
    for (let i = out.length - 1, seen = false; i >= 0; i--) {
        if (!out[i].diagStamp) continue;
        if (seen) delete out[i].diagStamp; else seen = true;
    }
    return out;
}

// 发往模型的对话历史：只取真正的问答轮（user/assistant）。导入分隔线等 note 条目只在侧聊框里
// 展示 + 持久化，绝不能作为一轮对话回灌给模型（否则会污染问答上下文，甚至把非法 role 发出去）。
// 默认取当前全局 convo；传显式数组即可单测。所有「把 convo 拼进 messages」的地方都改走这里。
export function convoForPrompt(list = convo) {
    return (Array.isArray(list) ? list : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        // 出站净化——convo 条目带 id / _el 等内部字段，绝不能进请求体。裸路径（buildMessages
        // 与预设兜底）是把这些对象【原样摊进 messages】的，JSON.stringify 会把内部字段一起发出去。
        // 消费者只读 role / content / length，故恒回纯净两键对象。
        .map((m) => ({ role: m.role, content: m.content }));
}

/* ── 📥 导出对话（用户功能请求：和神谕聊嗨了，想把这页存下来）─────────────────────────
   纯核在此，UI / 下载在 exportConvo 一带。只导出【真问答轮】——note 记录（自动诊断 / 自动校正 /
   导入分隔线 / 系统提示）是机制流水不是对话，一律丢弃（与 convoForPrompt 同一口径）。正文【原样照抄】：
   不转义、不跑宏、不渲染 Markdown，参谋的 <StoryPlan> 块也原样留着（导出的是原文，不是屏幕）。 */

// 纯判定：哪些模式给「导出对话」入口。普通聊天 + 剧情参谋两房是【可读对话】；诊断 / 世界书 / 校正 /
// 工坊的侧聊是机制记录（补丁 / 预检 / 校正稿 / 访谈稿），导出没意义 → 入口不出现。
export function convoExportAllowed(mode) {
    return mode === 'chat' || mode === 'advisor';
}

// 纯函数：房间的 convo 数组 + meta{modeLabel, chatName, when} → 整份 .md 文本。
// when 由调用端预先格式化好（纯函数不碰时钟，单测才钉得住）。过滤后一条对话都不剩 → 返回 ''，
// 由调用端决定提示什么（这里不造空壳文件）。
export function buildConvoExportMd(list, meta) {
    const turns = convoForPrompt(Array.isArray(list) ? list : []).filter((m) => typeof m.content === 'string');
    if (!turns.length) return '';
    const m = meta || {};
    const head = [
        '# 剧情推进对话导出',
        '',
        `- 模式：${String(m.modeLabel == null ? '' : m.modeLabel)}`,
        `- 聊天：${String(m.chatName == null ? '' : m.chatName)}`,
        `- 导出时间：${String(m.when == null ? '' : m.when)}`,
        `- 共 ${turns.length} 条对话`,
    ].join('\n');
    const body = turns.map((t) => `**${t.role === 'user' ? '【我】' : '【剧情推进】'}**\n\n${t.content}`);
    return [head, ...body].join('\n\n---\n\n') + '\n';
}

// 纯函数：把聊天名收拾成能当文件名的样子——Windows/macOS 都禁的那批字符 + 控制字符去掉、空白折叠、
// 长度夹到 60（避免撞路径上限）、末尾的点与空格剃掉（Windows 不接受）。收拾完为空 → 「未命名」。
function soSanitizeFileName(name) {
    const cleaned = String(name == null ? '' : name)
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
        .replace(/[.\s]+$/, '');
    return cleaned || '未命名';
}

// 纯函数：导出文件名 剧情推进-{模式}-{聊天名}-{YYYYMMDD-HHMM}.md。三段都过一遍清洗
// （模式名是内置常量，聊天名才是用户数据；一视同仁省得日后加来源时漏掉）。
export function buildConvoExportFileName(modeLabel, chatName, stamp) {
    return `剧情推进-${soSanitizeFileName(modeLabel)}-${soSanitizeFileName(chatName)}-${soSanitizeFileName(stamp)}.md`;
}

// 纯函数（Date 由调用端传进来，单测才不碰时钟）：导出用的两种时间写法——正文里的可读时间 +
// 文件名里的紧凑戳。⚠ 不用 `instanceof Date` 判：jsdom 单测里的 Date 来自另一个 realm，
// instanceof 会假阴（仓级跨领域陷阱）——按鸭子类型认。
export function soExportTimeParts(d) {
    const ok = d && typeof d.getFullYear === 'function' && typeof d.getTime === 'function' && !isNaN(d.getTime());
    const dt = ok ? d : new Date(0);
    const p = (n) => String(n).padStart(2, '0');
    const Y = String(dt.getFullYear()), M = p(dt.getMonth() + 1), D = p(dt.getDate());
    const h = p(dt.getHours()), mi = p(dt.getMinutes());
    return { when: `${Y}-${M}-${D} ${h}:${mi}`, stamp: `${Y}${M}${D}-${h}${mi}` };
}

/* ── 📤 导入对话（1.61.0）—— buildConvoExportMd 的【逆运算】。纯核在此，UI 在 importConvo 一带。
   设计取舍全部写在这里，别处不重述：
   ① 段界只认导出器真正写出的那一串 —— 空行 + `---` + 空行，【且】后面紧跟说话人标记（正向 lookahead）。
      于是正文里孤零零的一行 `---`（普通 Markdown 分隔线）不会被误当段界 —— 这是刻意保的真。
   ② 反过来说：正文里若原样出现「空行 `---` 空行 `**【我】**`」，它【会】被切成新的一轮。边界可伪造，
      这一点与导出侧评审的结论一致（accepted-by-design）：导出是纯文本档案，不是带校验的容器格式。
   ③ 容错：BOM / CRLF / 标记行尾空格 / 抬头被改被删 / 抬头与首轮之间那条 `---` 被人手删掉（粘连找回）。
   ④ 一条有效对话都没读到 → null（调用端据此报「这不是剧情推进导出的对话文件」）。
   ⑤ 正文【逐字】还原：不 trim、不去转义、不渲染 —— 与导出侧的逐字照抄对称。
   ⑥ 切出来了却认不出的段 → 计进 `skipped`（调用端在成功提示里如实说 N/M，绝不静默吞）。
   文件末尾那个换行是导出器加的（`+ '\n'`），这里精确脱掉一个，round-trip 才是字节级的逆。 */
export function parseConvoExportMd(text) {
    if (typeof text !== 'string') return null;
    const t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
    if (!t) return null;
    // split 对正则恒按全局切，无需 /g；lookahead 保证只在真段界处下刀。
    const segs = t.split(/\n[ \t]*\n[ \t]*-{3,}[ \t]*\n[ \t]*\n(?=\*\*【(?:我|神谕|剧情推进)】\*\*)/);
    const meta = {};
    if (segs.length && !/^\*\*【(?:我|神谕|剧情推进)】\*\*/.test(segs[0])) {
        let head = segs.shift();
        // 抬头与首轮之间的 `---` 被删时首轮会粘在抬头里 —— 从抬头里第一个【行首】说话人标记处切开找回；
        // 不做这一步则首轮被静默吞掉。这条找回路要过【两道】闸（review 2026-08-09 m1 抓到的假阳：
        // 任意一份外来 Markdown 只要有一行说话人标记，标记之前的全文就会被当抬头【静默丢弃】）：
        //   ① 标记后面必须跟换行或到头 —— 与下面认轮的正则同款边界，两处对齐，免得挑中一个认不出的标记；
        //   ② 被切掉的那截前缀必须【确实长得像我们的抬头】（标题行 / `- 模式：`… / `- 共 N 条对话`），
        //      或者本就是空白。别人的笔记里出现一行 `**【神谕】**` → 两闸不过 → 整份判 null，
        //      而不是悄悄吞掉前半篇。
        const glue = /(?:^|\n)\*\*【(?:我|神谕|剧情推进)】\*\*[ \t]*(?:\n\n|\n|$)/.exec(head);
        const at = glue ? (glue.index === 0 ? 0 : glue.index + 1) : -1;
        const prefix = at >= 0 ? head.slice(0, at) : '';
        if (at >= 0 && (!prefix.trim()
            || /^#[ \t]*(?:故事神谕|剧情推进)对话导出[ \t]*$|^-[ \t]*(?:模式|聊天|导出时间)：|^-[ \t]*共[ \t]*\d+[ \t]*条对话[ \t]*$/m.test(prefix))) {
            segs.unshift(head.slice(at));
            head = prefix;
        }
        const grab = (re) => { const m = re.exec(head); return m ? m[1].trim() : null; };
        const modeLabel = grab(/^-[ \t]*模式：(.*)$/m);
        const chatName = grab(/^-[ \t]*聊天：(.*)$/m);
        const when = grab(/^-[ \t]*导出时间：(.*)$/m);
        const count = grab(/^-[ \t]*共[ \t]*(\d+)[ \t]*条对话[ \t]*$/m);
        if (modeLabel != null) meta.modeLabel = modeLabel;
        if (chatName != null) meta.chatName = chatName;
        if (when != null) meta.when = when;
        if (count != null) meta.count = Number(count);
    }
    const turns = [];
    let skipped = 0;
    for (const seg of segs) {
        // 标记行后面通常是空行 + 正文；只有一个换行（手改过）或直接到头（空内容）也认。
        const m = /^\*\*【(我|神谕|剧情推进)】\*\*[ \t]*(\n\n|\n|$)/.exec(seg);
        // 不是一轮（半截文本 / 改坏了，例如 `**【我】**问题` 标记后没换行）→ 跳过、不猜，但【记账】：
        // 调用端要在成功提示里如实说「N 段无法识别、已跳过」，绝不静默吞（house N/M 诚实制）。
        if (!m) { skipped++; continue; }
        turns.push({ role: m[1] === '我' ? 'user' : 'assistant', content: seg.slice(m[0].length) });
    }
    return turns.length ? { turns, meta, skipped } : null;
}

// ==== 侧聊流（1.25.0 用户角色分家；1.28.0 推广为每模式独立房间）====
// 主流 = 普通聊天，旧键原样（旧档零迁移）；参谋配一间独立房（per-chat metadata，随聊天走）。
// 房间之间绝不混入无关记录（ENABLE_MODE_ROOMS 关则统回主流）。

// 每模式独立房间的流键解析（推广自旧 convoStreamKeyFor(isBuilder,...)，1.28.0 起替代它）。mode 由调用端传
// currentOracleMode()——纯函数、便于单测（沿用旧函数「把模式/标志当参数传入」的约定）。
// 工坊 → 变体房间（受 ENABLE_BUILDER_PERSONA_STYLES 管辖，逻辑不变）；
// 其余非普通模式 → 各自房间（受 ENABLE_MODE_ROOMS 管辖）；普通聊天 → 主流。
export function convoStreamKeyForMode(mode, s) {
    if (mode === 'builder') {
        return ENABLE_BUILDER_PERSONA_STYLES ? BUILDER_VARIANTS[builderVariantKey(s)].streamKey : 'main';
    }
    if (!ENABLE_MODE_ROOMS) return 'main';
    switch (mode) {
        case 'diagnose': return 'diagnose';
        case 'lorebook': return 'lorebook';
        case 'advisor': return 'advisor';
        case 'fix': return 'fix';
        default: return 'main';
    }
}
// PURE：这次换房会不会误杀一条在途生成？（1.36.0 切模式中断确认的判定核。）保活运行（锻造 / 深度精简）
// 不算——它们切房本就不中断；目标房与当前相同（诊断→AUTO）也不会中断。
function roomSwapWouldAbort(generating, hasLiveRun, targetKey, currentKey) {
    return !!generating && !hasLiveRun && targetKey !== currentKey;
}
// 切模式 / 换房前的中断确认（1.36.0，用户功能请求：用户不知道切模式会中止在途回复、误当 bug 上报）：
// 有非保活生成在途且目标房不同 → 先问一声，取消 = 留在原模式。uiConfirm 自身不抛；再包一层 fail-open
// —— 万一弹窗环节出错，按「确定」放行（维持 1.28.0 起「照常切换中止」的旧行为，绝不把模式切换卡死）。
export async function confirmConvoSwap(targetKey) {
    if (!roomSwapWouldAbort(isGenerating && !!abortCtl, !!(liveForge || liveCondense), targetKey, convoStreamKey)) return true;
    try {
        return await uiConfirm('当前还有回复正在生成——现在切换会中止它，未完成的内容将丢弃。仍要切换吗？');
    } catch (e) { return true; }
}
// 便捷封装：按目标【模式】算房间键再确认（模式按钮 / 菜单入口用）。
export async function confirmModeSwitch(mode) {
    return confirmConvoSwap(convoStreamKeyForMode(mode, getSettings()));
}
const IMPORT_DIVIDER_TEXT = '—— 以下导入自普通聊天的讨论 ——';
// 参谋「导入普通聊天的讨论」纯核：把主流的问答轮（丢弃 note）前置一条分隔提示，返回待插入的 {role,content} 列表
// （id 由挂载端分配）。主流无问答 → 空数组（不导入、不留分隔线）。
export function buildImportedTurns(mainList) {
    const qa = (Array.isArray(mainList) ? mainList : [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content }));
    if (!qa.length) return [];
    return [{ role: 'note', content: IMPORT_DIVIDER_TEXT }, ...qa];
}
// 某侧聊流是否已有真问答轮（user/assistant）。参谋进入时据此决定是否值得提供「导入」chip。
export function roomHasDiscussion(list) {
    return (Array.isArray(list) ? list : []).some((m) => m && (m.role === 'user' || m.role === 'assistant'));
}
// 侧聊房间的头部提示线文案（每模式独立房间）。主流不显示（null）；工坊房间保留原「访谈记录：<目标>」；
// 其余各模式一句「本模式独立保存」提示。纯函数（传 streamKey + settings），便于单测。
export function streamCueLabel(streamKey, s) {
    if (!streamKey || streamKey === 'main') return null;
    if (streamKey.startsWith('bld_')) return `访谈记录：${builderTargetLabel(s)}（独立保存，切换目标不丢失）`;
    const noun = { diagnose: '诊断记录', lorebook: '世界书讨论', advisor: '参谋讨论', fix: '校正记录' }[streamKey];
    return noun ? `${noun}（本模式独立保存）` : '本模式记录（独立保存）';
}
export function convoMetaKeyFor(streamKey) {
    return (!streamKey || streamKey === 'main') ? CONVO_META_KEY : CONVO_META_KEY + '_' + streamKey;
}

// 读取某侧聊流保存的历史（始终回数组）。默认当前流。
export function getConvoMeta(streamKey = convoStreamKey) {
    const md = getChatMetadataSafe();
    const arr = md ? md[convoMetaKeyFor(streamKey)] : null;
    return Array.isArray(arr) ? arr : [];
}

// 把当前 convo 写回某侧聊流的元数据（空则删键）。⚠ 只能用【全局 convo 当前所属的那个 key】调用
// ——绝不传外流 key（那会把当前 convo 写进别的房间）。
export function persistConvo(streamKey = convoStreamKey) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    const arr = serializeConvo(convo);
    const key = convoMetaKeyFor(streamKey);
    if (arr.length) md[key] = arr; else delete md[key];
    saveChatMetadata();
    return true;
}

// 读 / 写本聊天的运行概要（用户粘贴的前情提要 / 总结）。空串即删键。
export function getSummary() {
    const md = getChatMetadataSafe();
    const t = md ? md[SUMMARY_META_KEY] : '';
    return typeof t === 'string' ? t : '';
}

export function setSummary(text) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    const t = String(text || '');
    if (t.trim()) md[SUMMARY_META_KEY] = t; else delete md[SUMMARY_META_KEY];
    saveChatMetadata();
    return true;
}


// 反向：{ 书名: uid[] } -> { 书名: Set<uid> }。容错非数组 / 非数字。
export function deserializeEntrySel(obj) {
    const out = {};
    if (obj && typeof obj === 'object') {
        for (const [book, arr] of Object.entries(obj)) {
            out[book] = new Set((Array.isArray(arr) ? arr : []).filter((x) => x != null && x !== '').map(Number).filter((n) => Number.isFinite(n)));
        }
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * 用户功能请求：诊断模式「精选世界书条目」——按【当前聊天】持久化的选择（与 plan/convo/summary 同风格：
 * 随聊天保存、随切换刷新、全默认时删键）。元数据形状见 DIAG_WI_META_KEY。两层开关：
 *   use    L1 主开关——开了才精选；关 = 诊断完全走原行为（worldInfoMode 扫描 + collectMvuUpdateRules）
 *   hybrid L2 混合——精选条目 ∪ 主聊天当前触发的绿灯条目（仅 use 开时有意义）
 * 选择本体 sel:{书名:uid[]} 与内存镜像 diagEntrySel:{书名:Set<uid>} 互转。纯函数可单测。
 * ------------------------------------------------------------------ */
// 内存 { 书名: Set<uid> } -> 可持久化 { 书名: uid[]（升序）}。空集合的书也保留键（= 该书选了零条）。
export function serializeDiagSel(map) {
    const out = {};
    for (const [book, set] of Object.entries(map || {})) {
        if (!(set instanceof Set)) continue;
        out[book] = [...set].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    }
    return out;
}

// 读本聊天的诊断选条目元数据（始终回带默认值的对象，绝不返回 null）。
export function getDiagWiMeta() {
    const md = getChatMetadataSafe();
    const m = md ? md[DIAG_WI_META_KEY] : null;
    return {
        use: !!(m && m.use),
        hybrid: !!(m && m.hybrid),
        target: (m && typeof m.target === 'string') ? m.target : '',
        sel: (m && m.sel && typeof m.sel === 'object') ? m.sel : {},
    };
}

// 写本聊天的诊断选条目元数据（全默认 = 删键，保持元数据干净）。
export function setDiagWiMeta(obj) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    const o = obj || {};
    const sel = (o.sel && typeof o.sel === 'object') ? o.sel : {};
    const empty = !o.use && !o.hybrid && !o.target && !Object.keys(sel).length;
    if (empty) delete md[DIAG_WI_META_KEY];
    else md[DIAG_WI_META_KEY] = { use: !!o.use, hybrid: !!o.hybrid, target: o.target || '', sel };
    saveChatMetadata();
    return true;
}


/* ------------------------------------------------------------------ *
 * 🌐 世界书范围「自定义」（ENABLE_WI_CUSTOM_PICK，1.81.0）——按聊天记忆的元数据层。
 * 没有内存镜像：清单每次渲染直接读 metadata，改选直接合并写回。
 * 「有没有聊天」只能用 getCurrentChatId() 判（chatMetadata 没开聊天时也是常真 {}）；群聊有 id、照常支持。
 * ------------------------------------------------------------------ */
// 当前聊天 id；没开聊天 / 取不到 → null。
export function wiCustomChatId() {
    try {
        const ctx = getCtx();
        if (ctx && typeof ctx.getCurrentChatId === 'function') {
            const id = ctx.getCurrentChatId();
            return (id === undefined || id === null || id === '') ? null : id;
        }
    } catch (e) { /* fall through */ }
    return null;
}

// 读本聊天的自定义选择；没开聊天 / 拿不到 metadata → null（调用方 fail-closed）；有聊天无键 → 默认对象。
export function getWiCustomMeta() {
    if (wiCustomChatId() === null) return null;
    const md = getChatMetadataSafe();
    if (!md) return null;
    const m = md[WI_CUSTOM_META_KEY];
    return {
        books: (m && Array.isArray(m.books)) ? m.books.filter((n) => typeof n === 'string' && n) : [],
        hybrid: !!(m && m.hybrid),
        sel: (m && m.sel && typeof m.sel === 'object' && !Array.isArray(m.sel)) ? m.sel : {},
    };
}

// 全默认判定（纯）：books 空 ∧ !hybrid ∧ sel **无键**。{Book:[]} 有键 = 显式「一条不发」，不是默认。
function wiCustomIsDefault(meta) {
    const o = meta || {};
    const books = Array.isArray(o.books) ? o.books : [];
    const sel = (o.sel && typeof o.sel === 'object' && !Array.isArray(o.sel)) ? o.sel : {};
    return !books.length && !o.hybrid && !Object.keys(sel).length;
}

// 写本聊天的自定义选择（全默认 = 删键）。sel 的值是 uid 数组（有 Set 的调用方先转成数组）。没聊天 → false。
export function setWiCustomMeta(obj) {
    if (wiCustomChatId() === null) return false;
    const md = getChatMetadataSafe();
    if (!md) return false;
    const o = obj || {};
    const next = {
        books: Array.isArray(o.books) ? o.books.filter((n) => typeof n === 'string' && n) : [],
        hybrid: !!o.hybrid,
        sel: (o.sel && typeof o.sel === 'object' && !Array.isArray(o.sel)) ? o.sel : {},
    };
    if (wiCustomIsDefault(next)) delete md[WI_CUSTOM_META_KEY];
    else md[WI_CUSTOM_META_KEY] = next;
    saveChatMetadata();
    return true;
}

// 把内存选择 diagEntrySel 回写元数据，保留 use/hybrid/target。每次勾选 / 快捷按钮后调用。
export function persistDiagSel() {
    const cur = getDiagWiMeta();
    setDiagWiMeta({ use: cur.use, hybrid: cur.hybrid, target: cur.target, sel: serializeDiagSel(diagEntrySel) });
}