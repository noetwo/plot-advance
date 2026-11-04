import { getSettings } from '../core/settings.js';

import { stripReasoningTags } from '../modes/chat/context.js';
import { builderVariantKey } from '../modes/builder/model.js';
import { CUSTOM_PERSONA_CAPS, ENABLE_BUILDER_PERSONA_STYLES, ENABLE_CUSTOM_PERSONAS, FIXSEL_MAP_MAX_HITS, FIXSEL_MD_JUNK, FIXSEL_SCROLL_QUIET_MS, FIXSEL_SOFT_CUT, FIXSEL_TAP_MAX_MS, FIXSEL_TAP_MAX_PX, FIX_PREFILTER_PATTERNS, FIX_SAMPLE_TEMPLATES, FIX_TARGET_MODULES, MVU_BLOCK_DIALECTS, PERSONAS, fixSelClosers, fixSelDigit, fixSelSofts, fixSelTerms, fixSelWs } from './builtins.js';
import { P } from './registry.js';
import { locateTagOpen } from '../ui/messages.js';

let fixSelSegmenterCache = null;

// 变体 → 访谈提示词（card 回冻结原件）。
export function builderInterviewPromptFor(key) {
    if (key === 'steal') return P('bld.interviewSteal');
    if (key === 'nosteal') return P('bld.interviewNosteal');
    return P('bld.interview');
}

// 【当前目标】行文案。开关关闭时回退旧两态字串（与 1.23.x 字节相同）；card 恒为 NPC 字串。
export function builderTargetLabel(s) {
    if (!ENABLE_BUILDER_PERSONA_STYLES) return s.bldTarget === 'npc' ? 'NPC 世界书条目' : '角色（Persona）';
    const k = builderVariantKey(s);
    if (k === 'steal') return '用户角色（Persona·抢话——AI 也会扮演{{user}}）';
    if (k === 'nosteal') return '用户角色（Persona·不抢话——AI 只回应{{user}}，绝不替TA行动）';
    return 'NPC 世界书条目';
}

// 变体 → 锻造提示词（card 回冻结原件）。
export function builderForgePromptFor(key) {
    if (key === 'steal') return P('bld.forgeSteal');
    if (key === 'nosteal') return P('bld.forgeNosteal');
    return P('bld.forge');
}

// 纯函数：按【名字】取一份内置示例（下拉的 value 就是名字）。空 / 非串 / 认不出 → null。
// 名字是这一族唯一的键——下拉 value、fixC_template、findFixTemplate 的兜底、saveFixTemplate 的拒绝闸
// 全按它对齐；改名字必须同时改 SAMPLES.md 的注记与三处文档（fix-custom-samples.test.mjs 会钉住）。
export function fixSampleTemplateByName(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) return null;
    return FIX_SAMPLE_TEMPLATES.find((t) => t.name === n) || null;
}

// 纯函数：这个名字是不是内置示例的名字。用户库不许出现同名（saveFixTemplate 硬拒），
// 「保存 / 删除」两个按钮据此改走另存 / 拒绝分支。
export function fixTemplateIsBuiltin(name) {
    return !!fixSampleTemplateByName(name);
}

// 纯函数：把内置示例的名字变成「另存为」的默认名 = 去掉末尾的「（示例）」标记（半角括号也收）。
// 去空之后为空（用户把名字整个改成「（示例）」这种）→ 回原名，绝不返回空串让起名框开着空的。
export function fixSampleCopyName(name) {
    const raw = String(name == null ? '' : name).trim();
    const stripped = raw.replace(/[（(]示例[）)]\s*$/, '').trim();
    return stripped || raw;
}

// 纯函数：自动模式发 LLM 调用前的成本门。返回 false = 不值得调用（直接跳过该回复）。
// 规则：文本字符数 < minChars（CJK 按【字符】数，用展开符）→ false；否则当 (a) 任一【勾选】目标的禁词
// 命中文本，或 (b) constraints.knowledge / guardrails 非空（有约束总是值得查）→ true；都不满足 → false。
// 入参可空（targets/constraints 缺省为 {}，minChars 缺省 0，text 缺省 ''）。可单测。
export function fixPreFilter(text, targets, constraints, minChars) {
    const s = String(text || '');
    const min = Number(minChars) || 0;
    if ([...s].length < min) return false;
    const t = targets || {};
    for (const key of ['slop', 'dialogue', 'precision', 'magic', 'pacing', 'archaic']) {
        if (!t[key]) continue;
        const re = FIX_PREFILTER_PATTERNS[key];
        if (re && re.test(s)) return true;
    }
    const con = constraints || {};
    if (String(con.knowledge || '').trim()) return true;
    if (String(con.guardrails || '').trim()) return true;
    return false;
}

// 纯函数：校正稿相对原文是否「无实质改动」（仅空白差异）。去掉所有空白后逐字比较，相等 → true（视为无操作）。
// 入参可空（按 '' 处理）。可单测。
export function fixNoOp(originalProse, fixedProse) {
    const norm = (x) => String(x || '').replace(/\s+/g, '').trim();
    return norm(originalProse) === norm(fixedProse);
}

// 纯函数（Tier 0 ①，1.25.0）：近似回抄检测——高上下文 DeepSeek「抄原文不改」的【可见面】。fixNoOp 只抓逐字相同：
// 改了 1 个破折号的 99.97% 回抄稿照样过，手动便出一枚正常「应用」按钮（用户视角=把原文抄过来的草稿）。这里用
// 10 字 shingle【多重集】重合度（计次，对重复文本免疫）+ 长度带（差 >5% 的砍文/扩写不算近抄——那是另一类失灵、
// 各有守卫）判「几乎没改」。similar=true ⇒ 稿子与原文基本相同；changedApprox ≈ 估算改动字数（约数，仅供提示文案）。
// 用途：手动侧只【警示不拦】（fixNearCopyNote），自动侧当【无需校正】处理（fixEffectivelyUnchanged）。可单测。
function fixNearCopy(originalProse, fixedProse) {
    const norm = (x) => String(x || '').replace(/\s+/g, '');
    const a = norm(originalProse), b = norm(fixedProse);
    if (!a || !b) return { similar: false, changedApprox: 0 };
    if (a === b) return { similar: true, changedApprox: 0 };
    const K = 10;
    if (a.length < K * 3 || b.length < K * 3) {
        // 太短不足以 shingle：公共前后缀之外的中段当改动量
        let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
        let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
        const mid = Math.max(a.length, b.length) - p - s;
        return { similar: mid <= Math.max(2, Math.round(a.length * 0.03)), changedApprox: mid };
    }
    const ratio = b.length / a.length;
    if (ratio < 0.95 || ratio > 1.05) return { similar: false, changedApprox: 0 };
    const shCount = (t) => { const m = new Map(); for (let i = 0; i + K <= t.length; i++) { const g = t.slice(i, i + K); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const A = shCount(a), B = shCount(b);
    let overlap = 0; for (const [g, ca] of A) overlap += Math.min(ca, B.get(g) || 0);   // 多重集交集大小
    const totalA = a.length - K + 1, totalB = b.length - K + 1;
    const minCont = Math.min(totalA ? overlap / totalA : 0, totalB ? overlap / totalB : 0);
    return { similar: minCont >= 0.97, changedApprox: Math.max(1, Math.round((Math.max(totalA, totalB) - overlap) / K)) };
}

// 纯函数（Tier 0 ①）：手动校正近抄警示语（Prince 定案字面）。近抄 → 带估算改动字数的提示；否则空串。
// 手动【只警示不拦】——近抄未必是失败（「改一个错别字」本就近抄），判断权留给用户；自动侧走 fixEffectivelyUnchanged。可单测。
export function fixNearCopyNote(before, after) {
    const nc = fixNearCopy(before, after);
    return nc.similar
        ? '模型基本没改（改动约 ' + nc.changedApprox + ' 字）——若您要求的是较大修改，这次校正很可能失败了；建议调小前文或重试。'
        : '';
}

// 纯函数（Tier 0 ①）：自动校正的「等于没改」判定 = 逐字相同（fixNoOp）或 近抄（fixNearCopy.similar）。
// 自动无人盯着——自动落一份 99.97% 回抄稿只会白费一个 swipe 还报「已校正」；据此改判 clean/nochange，不落 swipe。可单测。
export function fixEffectivelyUnchanged(before, after) {
    return fixNoOp(before, after) || fixNearCopy(before, after).similar;
}

// 纯函数（Tier 0 ③，1.25.0）：校正调用的输出预算——全局 maxTokens / 校正专属 fixMaxTokens / 4096 地板 三者取大。
// 长楼层（8k+ 字）合规重写需 8-16k 输出 token，4096 地板会把成稿腰斩（fixOutputTruncated 拦下不应用，但用户视角=
// 「长楼层校正总失败」）。fixMaxTokens 默认空 = 不加码、逐字节同旧版；仿锻造的 bldMaxTokens。可单测。
export function fixEffMaxTokens(s) {
    return Math.max(Number(s && s.maxTokens) || 0, Number(s && s.fixMaxTokens) || 0, 4096);
}

// 纯函数（选段校正 1.27.0，Part C）：把改写稿原位回插到完整楼层文本。bounds 非法（start>end / 越界 / 非字符串）
// → null（调用方中止，绝不拿坏偏移去 slice）。片段之外的字节 = 原文原样，故结构块/状态栏在选段模式【构造性】不可能被动。可单测。
export function spliceSpan(full, start, end, replacement) {
    if (typeof full !== 'string' || typeof replacement !== 'string') return null;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > full.length || start > end) return null;
    return full.slice(0, start) + replacement + full.slice(end);
}

// 纯函数（选段校正）：改写稿的回插前体检——选段回插是【fail-open】（偏移永远对得上，模型吐的垃圾也能插进去，
// Part A G-cell 截断诊断实证），故必须体检。echo=基本没改（复用 fixNearCopy 多重集）；spill=输出含 >3 个仅存在于
// 片段【之外】的 10 字 shingle（模型越界改写 / 复述了片段外正文——截断时的典型垃圾形态）；lenRatio 超 [0.15,4]
// 记长度异常。只出 warnings【不拦应用】（人在环上 + 小片段 diff 可读，同 Prince 手动基调：警示不阻断）。可单测。
export function validateSpanFix(spanText, output, outsideText) {
    const K = 10;
    const sh = (t) => { const s = new Set(); const n = String(t || '').replace(/\s+/g, ''); for (let i = 0; i + K <= n.length; i++) s.add(n.slice(i, i + K)); return s; };
    const O = sh(output), SP = sh(spanText), OUT = sh(outsideText);
    let spillHits = 0; for (const g of O) if (OUT.has(g) && !SP.has(g)) spillHits++;
    const spill = spillHits > 3;
    const nc = fixNearCopy(spanText, output);
    const lenRatio = String(output).length / Math.max(1, String(spanText).length);
    const warnings = [];
    if (nc.similar) warnings.push('模型基本没改（改动约 ' + nc.changedApprox + ' 字）——若您要求的是较大修改，这次校正很可能失败了；建议调小前文或重试。');
    if (spill) warnings.push('模型疑似越界：改写稿里混入了片段之外的正文内容——应用前请看清 diff，或重试。');
    if (lenRatio < 0.15 || lenRatio > 4) warnings.push('改写稿长度异常（约为原片段的 ' + lenRatio.toFixed(1) + ' 倍）——应用前请看清 diff。');
    return { echo: nc.similar, spill, lenRatio, warnings };
}

// 纯函数（选段校正）：定位当前有效选区。聚焦时【实时】selectionStart/End 权威（end>start 才算）；失焦后浏览器常报
// 损坏范围（多为 0）→ 改信【存下的】范围，按 textLen 钳边（GG corrections.js 同法）。都不可用 → null。可单测。
export function resolveRecordedSelection(live, stored, textLen) {
    const n = Number(textLen) || 0;
    if (live && live.focused && Number.isInteger(live.start) && Number.isInteger(live.end) && live.end > live.start) {
        return { start: Math.max(0, Math.min(live.start, n)), end: Math.max(0, Math.min(live.end, n)) };
    }
    if (stored && Number.isInteger(stored.start) && Number.isInteger(stored.end) && stored.end > stored.start) {
        const start = Math.max(0, Math.min(stored.start, n));
        const end = Math.max(start, Math.min(stored.end, n));
        return end > start ? { start, end } : null;
    }
    return null;
}

// 纯函数（多段选段 1.37.0）：把一个候选选区规整后并入钉选列表。先钳边、收缩到非空白边界 → 不足 2 字
// 拒 'empty'；满 cap 拒 'cap'；与既有钉重叠拒 'overlap'（带重叠段下标，UI 报「与片段n重叠」）。通过 →
// 返回按 start 升序的【新数组】（不改入参）+ added（UI 定位新 chip）。相邻（end==下一段 start）合法。可单测。
export function normalizePinAdd(pins, cand, fullText, cap) {
    const list = Array.isArray(pins) ? pins : [];
    const text = String(fullText || '');
    let start = Math.max(0, Math.min(Number(cand && cand.start) || 0, text.length));
    let end = Math.max(start, Math.min(Number(cand && cand.end) || 0, text.length));
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end - start < 2) return { ok: false, reason: 'empty' };
    if (list.length >= cap) return { ok: false, reason: 'cap' };
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (start < p.end && p.start < end) return { ok: false, reason: 'overlap', index: i };
    }
    const pin = { start, end, text: text.slice(start, end), instr: '' };
    const merged = list.concat([pin]).sort((a, b) => a.start - b.start);
    return { ok: true, pins: merged, added: pin };
}

// 纯函数（多段选段）：单段生效指令 = 该段自己的要求（非空则赢），否则整体要求。【绝不拼接】——拼出来的
// 指令是今天单段路径造不出来的形状（交接 V8 铁律）；n=1 时同规则 → H1 字节同一性有良定义。可单测。
export function resolvePinInstruction(pinInstr, sharedInstr) {
    const own = String(pinInstr || '').trim();
    return own || String(sharedInstr || '').trim();
}

// 纯函数（多段选段）：开跑前校验——每段都得有生效指令（自己的或整体的）。缺的段以 1 基序号列出
//（UI 报「片段n还没写要求」）。可单测。
export function multiFixRunnable(pins, sharedInstr) {
    const missing = [];
    (pins || []).forEach((p, i) => { if (!resolvePinInstruction(p && p.instr, sharedInstr)) missing.push(i + 1); });
    return missing.length ? { ok: false, missing } : { ok: true };
}

// 纯函数（多段选段）：分流判定。0/1 段 → 'legacy'（今天的单段路径原封不动，H1）；2+ → 'batch'。可单测。
export function fixSelDispatchMode(pinCount) {
    return (Number(pinCount) || 0) >= 2 ? 'batch' : 'legacy';
}

// 纯函数（多段选段）：多段回插。edits = [{start,end,replacement}]（任意顺序）。先按 start 升序查重叠
//（钉选时已挡，这里是最后防线——重叠回插会静默串位，宁可整单拒绝）→ 再按 start 【降序】逐段 spliceSpan
//（后文先动，前段偏移恒有效）。任一段越界 / 重叠 → null（调用方整单不应用，绝不半套；应指纹已核对却
// 还越界 = bug 信号）。可单测。
export function spliceSpansBackToFront(full, edits) {
    if (typeof full !== 'string' || !Array.isArray(edits)) return null;
    const sorted = edits.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) return null;
    let out = full;
    for (let i = sorted.length - 1; i >= 0; i--) {
        out = spliceSpan(out, sorted[i].start, sorted[i].end, sorted[i].replacement);
        if (out == null) return null;
    }
    return out;
}

// 纯函数（多段选段）：整层文本 + 多个高亮区间 → overlay HTML（escape 后按区间插 <span class=…>）。
// ranges = [{start,end,cls}]：钳边、空/无类跳过、按 start 排序；重叠时后者跳过（钉选构造上不重叠，防线）。
// cls 只来自代码内常量类名，不含用户输入。可单测。
export function buildFixSelOverlayHtml(text, ranges) {
    const t = String(text || '');
    const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rs = (Array.isArray(ranges) ? ranges : [])
        .map((r) => ({
            start: Math.max(0, Math.min(Number(r && r.start) || 0, t.length)),
            end: Math.max(0, Math.min(Number(r && r.end) || 0, t.length)),
            cls: String((r && r.cls) || ''),
        }))
        .filter((r) => r.end > r.start && r.cls)
        .sort((a, b) => a.start - b.start);
    let html = '', pos = 0;
    for (const r of rs) {
        if (r.start < pos) continue;
        html += esc(t.slice(pos, r.start)) + '<span class="' + r.cls + '">' + esc(t.slice(r.start, r.end)) + '</span>';
        pos = r.end;
    }
    return html + esc(t.slice(pos));
}

// 纯函数（点选模式）：选哪个模式。存过的偏好（'tap' / 'drag'）恒赢；没存过才看 coarse pointer
//（无悬停 + 粗指针 = 手机/平板 → 点选，否则拖选）。偏好只住 localStorage，绝不进 extensionSettings
//（那是跨设备同步的，手机上的选择会翻掉桌面）。其余取值一律当「没存过」。可单测。
export function fixSelPickMode(storedPref, coarsePointer) {
    if (storedPref === 'tap' || storedPref === 'drag') return storedPref;
    return coarsePointer ? 'tap' : 'drag';
}

// 纯函数（点选模式）：点选层 HTML。切点 = 每个单元首尾 ∪ 草稿两端 ∪ 每个钉段两端，排序后两两成片；
// 每片一个 <span>，恒带【切句时就算好的】raw UTF-16 偏移 data-s / data-e —— 偏移从不靠搜索显示文字
// 找回（sol 警告：画出来的高亮绝不能变成第二个真相源）。落在 prose 单元里的片带 data-i + role=option
//（同一单元被草稿/钉边切成几片时，几片共享同一个 data-i）；gap 片是素片、不可点。草稿内加
// so-fixsel-u-hl、钉段内加 so-fixsel-u-pin，钉段的【第一片】带 data-badge（1 基序号）。
// 文本只转义 & < >；状态栏 / 更新块 / 代码围栏都是普通文字（裁定 0.1，不做块识别）。可单测。
export function buildFixSelPickerHtml(raw, units, draft, pins) {
    const t = String(raw || '');
    const us = Array.isArray(units) ? units : [];
    const ps = Array.isArray(pins) ? pins : [];
    const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const d = (draft && Number.isInteger(draft.start) && Number.isInteger(draft.end) && draft.end > draft.start) ? draft : null;
    const bounds = new Set([0, t.length]);
    for (const u of us) { bounds.add(u.start); bounds.add(u.end); }
    if (d) { bounds.add(d.start); bounds.add(d.end); }
    for (const p of ps) { bounds.add(p.start); bounds.add(p.end); }
    const cuts = Array.from(bounds).filter((x) => Number.isInteger(x) && x >= 0 && x <= t.length).sort((a, b) => a - b);
    let html = '', ui = 0;
    for (let c = 0; c + 1 < cuts.length; c++) {
        const s = cuts[c], e = cuts[c + 1];
        while (ui < us.length && us[ui].end <= s) ui++;
        const unit = us[ui];
        const pi = ps.findIndex((p) => s >= p.start && e <= p.end);
        const cls = (d && s >= d.start && e <= d.end ? ' so-fixsel-u-hl' : '') + (pi >= 0 ? ' so-fixsel-u-pin' : '');
        const badge = (pi >= 0 && s === ps[pi].start) ? ` data-badge="${pi + 1}"` : '';
        const off = ` data-s="${s}" data-e="${e}"`;
        const text = esc(t.slice(s, e));
        if (unit && unit.kind === 'prose' && s >= unit.start && e <= unit.end) {
            html += `<span class="so-fixsel-u${cls}" data-i="${ui}" role="option"${off}${badge}>${text}</span>`;
        } else {
            html += `<span${cls ? ` class="${cls.trim()}"` : ''}${off}${badge}>${text}</span>`;
        }
    }
    return html;
}   // 病态重复（整篇同一句）防护：收集到这么多命中就停，够消歧了
export function mapSelectionToRaw(selText, prefix, suffix, raw) {
    const sel = String(selText || '').trim();
    const hay = String(raw || '');
    if (sel.length < 2 || !hay) return null;
    const pre = String(prefix || '');
    const suf = String(suffix || '');
    const exact = [];
    for (let i = hay.indexOf(sel); i !== -1; i = hay.indexOf(sel, i + 1)) {
        exact.push({ start: i, end: i + sel.length });
        if (exact.length >= FIXSEL_MAP_MAX_HITS) break;
    }
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return pickByContext(exact, pre, suf, hay);
    const fuzzy = fuzzyScanRaw(sel, hay);
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) return pickByContext(fuzzy, pre, suf, hay);
    return null;
}

// 阶梯②：多处命中按前后文打分。得分 = prefix 贴着命中点的最长连续尾段匹配 + suffix 贴着命中尾的最长连续
// 头段匹配（逐字符）；平手取最早（严格大于才换人）。
function pickByContext(cands, pre, suf, hay) {
    let best = cands[0], bestScore = -1;
    for (const c of cands) {
        let s = 0;
        for (let k = 1; k <= pre.length && k <= c.start; k++) {
            if (hay[c.start - k] === pre[pre.length - k]) s++; else break;
        }
        for (let k = 0; k < suf.length && c.end + k < hay.length; k++) {
            if (hay[c.end + k] === suf[k]) s++; else break;
        }
        if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
}
// 单点模糊匹配：sel 侧空白串 ↔ hay 侧空白串（hay 侧空白串里可夹记号，但必须真吃到≥1个空白字符）；
// 非空白处 hay 侧先跳记号再逐字符相等。成功返回终点偏移，失败 -1。
function fuzzyMatchAt(sel, hay, start) {
    let si = 0, hi = start;
    while (si < sel.length) {
        const sc = sel[si];
        if (/\s/.test(sc)) {
            let sj = si; while (sj < sel.length && /\s/.test(sel[sj])) sj++;
            let hj = hi, ate = false;
            while (hj < hay.length && (/\s/.test(hay[hj]) || FIXSEL_MD_JUNK.includes(hay[hj]))) {
                if (/\s/.test(hay[hj])) ate = true;
                hj++;
            }
            if (!ate) return -1;
            si = sj; hi = hj;
            continue;
        }
        while (hi < hay.length && FIXSEL_MD_JUNK.includes(hay[hi])) hi++;
        if (hi >= hay.length || hay[hi] !== sc) return -1;
        si++; hi++;
    }
    return hi;
}
// 阶梯③全扫：首字符相同的位置才试（剪枝）。O(n·m) 上界，消息万级字符毫秒级。
function fuzzyScanRaw(sel, hay) {
    const out = [];
    const first = sel[0];
    if (!first) return out;
    for (let i = 0; i < hay.length; i++) {
        if (hay[i] !== first) continue;
        const end = fuzzyMatchAt(sel, hay, i);
        if (end !== -1) {
            out.push({ start: i, end });
            if (out.length >= FIXSEL_MAP_MAX_HITS) break;
        }
    }
    return out;
}

// 纯函数（点选）：把整条正文【确定性地】切成一张无缝单元表 [{start,end,kind:'prose'|'gap'}]，供点选渲染器
// 逐句渲染成可点的 DOM。切点：① 终止符连串 + 尾随闭合符之后切（「你好。」整句带引号走）；② 每个换行切、
// 各行独立切；③ 拉丁句点只在【后接空白或行尾、且前一字符不是数字】时切（"3.5 at dawn." 只在 dawn. 后切
// 一次）；④ 一段散文超过 FIXSEL_SOFT_CUT 字，就在 [半程, 满程) 窗口里【最后一个】、，, 处软切，窗口内无
// 逗号则不软切。空白连串自成 gap 单元（切点后的空白也归 gap，故 ". Next" 出 散文/gap/散文 三格）。
// 裁定 0.1：状态栏 / 机制块 / 代码围栏【不特殊】——按普通行切，可点可跨，与拖选一致。
// 恒等式（单测钉）：units.map(u => raw.slice(u.start, u.end)).join('') === raw；首 start = 0、段段接头、
// 尾 end = raw.length；空串 → []。偏移一律是 raw 里的 UTF-16 下标——渲染层【绝不】靠搜索文本反推位置。
// 句级 Intl.Segmenter 有意不用：各引擎切法不同，同一条正文在不同手机上会切出不同的表。可单测。
export function fixSelUnits(raw) {
    const text = String(raw || '');
    const n = text.length;
    const units = [];
    const push = (s, e, kind) => { if (e > s) units.push({ start: s, end: e, kind }); };
    // 一段散文：先把切点后的空白整串让给 gap，剩下的按 FIXSEL_SOFT_CUT 软切。
    const pushProse = (s, e) => {
        let w = s;
        while (w < e && fixSelWs.test(text[w])) w++;
        push(s, w, 'gap');
        s = w;
        if (s >= e) return;
        let t = s;
        while (e - t > FIXSEL_SOFT_CUT) {
            let cut = -1;
            for (let k = t + FIXSEL_SOFT_CUT / 2; k < t + FIXSEL_SOFT_CUT && k < e; k++) {
                if (fixSelSofts.includes(text[k])) cut = k + 1;
            }
            if (cut < 0) break;
            push(t, cut, 'prose');
            t = cut;
        }
        push(t, e, 'prose');
    };
    let i = 0;
    while (i < n) {
        if (fixSelWs.test(text[i])) {                                    // 空白连串 = 一个 gap
            let j = i;
            while (j < n && fixSelWs.test(text[j])) j++;
            push(i, j, 'gap');
            i = j;
            continue;
        }
        let j = i;
        while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;        // 本行 = [i, j)
        let s = i;
        for (let k = i; k < j; k++) {
            const c = text[k];
            let cut = -1;
            if (fixSelTerms.includes(c)) {
                let m = k + 1;
                while (m < j && fixSelTerms.includes(text[m])) m++;       // …… 算一整串
                while (m < j && fixSelClosers.includes(text[m])) m++;     // 闭合符跟着上一句走
                cut = m;
            } else if (c === '.') {
                const prevDigit = k > 0 && fixSelDigit.test(text[k - 1]); // 3.5 不是句末
                const nextWs = k + 1 >= j || fixSelWs.test(text[k + 1]);
                if (!prevDigit && nextWs) {
                    let m = k + 1;
                    while (m < j && fixSelClosers.includes(text[m])) m++;
                    cut = m;
                }
            }
            if (cut > 0) { pushProse(s, cut); s = cut; k = cut - 1; }
        }
        if (s < j) pushProse(s, j);
        i = j;
    }
    return units;
}

// 纯函数（点选）：点击闸门——判「这一下到底是点选还是滑动/惯性/误触」。down = 追踪到的 pointerdown 记录
// {t,x,y,scrollTop,sinceScroll,multi,cancelled}，为 null 表示【压根没有触控记录】= 键盘 / 辅助技术激活，
// 恒放行（可达性：闸门只管真实触控）。判定顺序固定：多指 → pointercancel → 按太久 → 位移超阈 →
// 按下到点击之间滚动条动过 → 按下时距上次 scroll 太近（这一下多半是在刹住惯性滚动）→ 点击时距上次
// scroll 太近。前两项之后的每个拒绝都带 dt / dist（逐手势调试日志要打这两个数）。可单测。
export function fixSelJudgeTap(down, now, click, scrollTop, lastScrollAt,
    thr = { t: FIXSEL_TAP_MAX_MS, d: FIXSEL_TAP_MAX_PX, q: FIXSEL_SCROLL_QUIET_MS }) {
    if (!down) return { ok: true, reason: 'no-pointer' };
    if (down.multi) return { ok: false, reason: 'multi-pointer' };
    if (down.cancelled) return { ok: false, reason: 'pointercancel' };
    const dt = now - down.t;
    const dist = Math.hypot(click.x - down.x, click.y - down.y);
    if (dt > thr.t) return { ok: false, reason: 'too-long', dt, dist };
    if (dist > thr.d) return { ok: false, reason: 'moved', dt, dist };
    if (scrollTop !== down.scrollTop) return { ok: false, reason: 'scrolled', dt, dist };
    if (down.sinceScroll < thr.q) return { ok: false, reason: 'scroll-quiet-at-down', dt, dist };
    if (now - lastScrollAt < thr.q) return { ok: false, reason: 'scroll-quiet', dt, dist };
    return { ok: true, dt, dist };
}

// 纯函数（点选·微调）：把 raw.slice(s, e) 切成字素格 [{start,end,g}]，start/end 是【raw 里的】UTF-16 下标
// （= s + 段内偏移），g 是这一格的字符串。Intl.Segmenter 缺席 → 返回 null，调用方把微调置灰并说明原因，
// 【绝不】退化成手搓拆字（ZWJ 家庭 👨‍👩‍👧 / 区域指示符旗帜 🇨🇳 必须整格不散）。可单测。
export function fixSelGraphemes(raw, s, e) {
    if (typeof Intl === 'undefined' || !Intl.Segmenter) return null;
    const text = String(raw || '');
    const from = Math.max(0, Math.min(Number(s) || 0, text.length));
    const to = Math.max(from, Math.min(Number(e) || 0, text.length));
    if (!fixSelSegmenterCache) fixSelSegmenterCache = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const cells = [];
    for (const seg of fixSelSegmenterCache.segment(text.slice(from, to))) {
        cells.push({ start: from + seg.index, end: from + seg.index + seg.segment.length, g: seg.segment });
    }
    return cells;
}

// 纯函数：勾选目标 + 非空约束 → 校正指令。T1 总附；T2 仅当依据上下文在场（八股需卡+前文、对话需卡、魔法需世界书）。
// 无目标且两约束皆空 → ''。可单测。
// overrides（1.47.0，可空）：{ slop, dialogue, precision, magic, pacing } 的用户自定义正文（见 fixTargetOverrides）。
// 缺省 / 全空 → 与改前逐字节相同。
export function compileFixTargets(targets, ctx, constraints, overrides) {
    const t = targets || {}, c = ctx || {}, con = constraints || {};
    const ovs = (overrides && typeof overrides === 'object') ? overrides : {};
    const gate = { slop: c.card && c.context, dialogue: c.card, magic: c.world, archaic: c.card || c.world };
    const blocks = [];
    for (const key of ['slop', 'dialogue', 'precision', 'magic', 'pacing', 'archaic']) {
        if (!t[key]) continue;
        const m = FIX_TARGET_MODULES[key];
        if (!m) continue;
        const ov = String(ovs[key] || '').trim();
        let body;
        if (ov) {
            // 自定义（1.47.0 决定 1）：整份恒发 —— 内置的两段式与依据门控都不适用，用户写什么发什么。
            body = '【' + m.label + '】\n' + ov;
        } else {
            body = '【' + m.label + '】\n' + m.t1;
            if (m.t2 && gate[key]) body += '\n' + m.t2;
        }
        blocks.push(body);
    }
    const know = String(con.knowledge || '').trim();
    if (know) blocks.push(P('fix.knowledge', { knowledge: know }));
    const guard = String(con.guardrails || '').trim();
    if (guard) blocks.push(P('fix.guardrails', { guardrails: guard }));
    if (!blocks.length) return '';
    return P('fix.targetsLead') + '\n\n' + blocks.join('\n\n');
}

// ✨ 校正目标覆盖（1.47.0）：全局设置里的五份自定义正文 → compileFixTargets 的 overrides 参。
// 键留在全局、【不】进 FIX_CFG_KEYS（fix-target-edit.test.mjs 钉住）：提示词文本是用户偏好，
// 不该随聊天元数据 / 套餐快照到处跑。空串 = 用内置模块正文。
export function fixTargetOverrides(s) {
    const g = s || {};
    return {
        slop: g.fixTargetSlopPrompt,
        dialogue: g.fixTargetDialoguePrompt,
        precision: g.fixTargetPrecisionPrompt,
        magic: g.fixTargetMagicPrompt,
        pacing: g.fixTargetPacingPrompt,
        archaic: g.fixTargetArchaicPrompt,
    };
}
// 归一（纯函数）：非数组→[]；缺 id / label / voice（非字符串或空白）者丢弃；超长截断；超额裁尾。
// 返回新数组（getSettings 把它赋回同一 settings 对象——对象引用稳定契约不破）。
export function normalizeCustomPersonas(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const p of arr) {
        if (!p || typeof p.id !== 'string' || !p.id) continue;
        if (typeof p.label !== 'string' || !p.label.trim()) continue;
        if (typeof p.voice !== 'string' || !p.voice.trim()) continue;
        out.push({
            id: p.id,
            label: p.label.trim().slice(0, CUSTOM_PERSONA_CAPS.label),
            voice: p.voice.slice(0, CUSTOM_PERSONA_CAPS.voice),
            example: (typeof p.example === 'string' ? p.example : '').slice(0, CUSTOM_PERSONA_CAPS.example),
        });
        if (out.length >= CUSTOM_PERSONA_CAPS.count) break;
    }
    return out;
}
// 内置 + 自定义合并视图：自定义条目打 custom:true 的【浅拷贝】——内置对象与存档条目都绝不被
// 改动（custom 标记不落盘）。开关关 / 无 s → 只有内置。
export function allPersonasView(s) {
    const customs = (ENABLE_CUSTOM_PERSONAS && s && Array.isArray(s.customPersonas))
        ? s.customPersonas.map((p) => ({ ...p, custom: true })) : [];
    return PERSONAS.concat(customs);
}
export function findPersonaById(list, id) {
    return (Array.isArray(list) ? list : []).find((x) => x && x.id === id) || null;
}

// 扩写请求消息（纯函数）：名称与已有草稿都进种子；两者皆空时调用方不应发起（UI 有闸）。
export function buildPersonaFleshMessages(name, seed) {
    const n = String(name || '').trim();
    const t = String(seed || '').trim();
    const parts = [];
    if (n) parts.push('人格名称：' + n);
    parts.push('我的点子 / 已有草稿：' + (t || '（暂无，按名称发挥）'));
    return [
        { role: 'system', content: P('persona.flesh') },
        { role: 'user', content: parts.join('\n') },
    ];
}
// 扩写回复解析（纯函数，fail-open）：剥思维链 → 找 <PersonaVoice> 区块；没找到 = 整段当 voice
// （fallback:true——反正落进可编辑文本框，用户可修剪）。<PersonaExample> 可选。
export function parsePersonaFleshReply(text) {
    const src = stripReasoningTags(String(text || '')).trim();
    const grab = (tag) => {
        const open = locateTagOpen(src, tag);
        if (!open) return null;
        const rest = src.slice(open.index + open.length);
        const close = rest.match(new RegExp('</' + tag + '\\s*>', 'i'));
        const body = (close ? rest.slice(0, close.index) : rest).trim();
        return body || null;
    };
    const voice = grab('PersonaVoice');
    if (!voice) return { voice: src, example: '', fallback: true };
    return { voice, example: grab('PersonaExample') || '', fallback: false };
}

// mode（可选）：'advisor' | 'lorebook' | 'builder' —— 追加对应的职责调整与结构保护；不传 = 普通模式。
// s = settings（显式传入保持纯函数可测；自定义人格从 s.customPersonas 解析，不传时仅内置可命中）。
// 自定义条目用 PERSONA_FRAME_CUSTOM（「动漫角色」→「角色」），内置条目框架字节不变。
export function buildPersonaBlock(personaId, mode, s) {
    const p = findPersonaById(allPersonasView(s), personaId);
    if (!p || !p.voice) return '';
    // 内置人格的腔调 / 示例走注册表（可在设置里改）；自定义人格本来就由用户自己写。
    const st = s || getSettings();
    const voice = p.custom ? p.voice : P('persona.voice.' + p.id, null, st);
    const example = p.custom ? p.example : P('persona.example.' + p.id, null, st);
    if (!voice) return '';
    let block = P(p.custom ? 'persona.frameCustom' : 'persona.frame', null, st) + '\n' + voice;
    if (example) {
        block += '\n\n' + P('persona.exampleLead', null, st) + '\n' + example;
    }
    if (mode === 'advisor') {
        block += '\n\n' + P('persona.advisorDuty', null, st) + '\n\n' + P('persona.structGuard', null, st);
    } else if (mode === 'lorebook' || mode === 'builder') {
        block += '\n\n' + P('persona.' + mode + 'Duty', null, st) + '\n\n' + P('persona.structGuardWi', null, st);
    }
    return block;
}

// 纯函数：某方言的整块正则。开标签容忍空格 / 属性（`<UpdateVariable >`、`<update type="mvu">`）；
// `\b` 是关键边界——它让 `<UpdateVariable` 不误吃 `<UpdateVariables>`、`<update` 不误吃
// `<update_analysis>`（下划线是词字符 = 无边界），于是非贪婪体也不会停在内层的 `</update_analysis>`。
// 每次新建 RegExp = 不留 lastIndex 状态。可单测。
export function mvuBlockRegex(wrapper, flags) {
    return new RegExp('<' + wrapper + '\\b[^>]*>[\\s\\S]*?<\\/' + wrapper + '\\s*>', flags || 'i');
}
// 纯函数：这段文本里是否出现过某标签的开标记（同样带 `\b` 边界）。
function mvuHasOpenTag(text, name) {
    return new RegExp('<' + name + '\\b', 'i').test(text);
}
// 纯函数：方言的 inner 门（inner 为空 = 无条件放行）。
export function mvuDialectInnerOk(text, d) {
    return !d.inner.length || d.inner.some((t) => mvuHasOpenTag(text, t));
}

// 纯函数：【宽松】探测这段回复用的是哪套更新区块方言，返回 wrapper 名或 null。
// 宽松 = 只要开标签在就算数——块被截断 / 没闭合 / 属性写歪也算。这正是自动诊断 甲/乙 判定要的语义：
// 「这里确实有一次更新，只是我摘不干净」必须走【核验】，绝不能走【推导】（推导会写库 + 写回消息 =
// 破坏性，且会把已生效的变化再算一遍）。可单测。
export function detectMvuBlockDialect(text) {
    const s = String(text == null ? '' : text);
    for (const d of MVU_BLOCK_DIALECTS) {
        if (mvuHasOpenTag(s, d.wrapper) && mvuDialectInnerOk(s, d)) return d.wrapper;
    }
    return null;
}