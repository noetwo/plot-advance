import { refreshLatestMvuBar } from '../../core/post-reply.js';
import { getCtx } from '../../core/settings.js';
import { mvuLatestMsgId, mvuMsgOpts } from '../diagnose/auto.js';
import { diagCountPatchBlocks, diagOpOutcomes, diagStatKey } from '../diagnose/patch.js';
import { extractExcludedSections, extractUpdateBlock, fixKeepPlaceholder, getMvu, mvuStatOf, parseExcludeTagNames, parseExcludeTags, splitContentScope, stripFixKeepMarks } from '../diagnose/mvu.js';
import { diagDoubleBlockNotice, diagSchemaDryLines, diagSchemaFilterPatch, diagZeroChangeReport, diagZeroHeadline, maybeRunSaveHealth, repairDiagNote, repairDiagPatch } from '../diagnose/diagnostics.js';
import { fixDropMinusKeep, fixTagOverlap } from './templates.js';
import { ENABLE_FIX_CUSTOM_TASK, ENABLE_SCHEMA_DIAG, FIX_MAX_PIECE_CALLS, FIX_PIECE_MAX_CHARS, STATUS_PLACEHOLDER } from '../../prompts/builtins.js';
import { fixPreFilter } from '../../prompts/helpers.js';
import { locateVariableBlock, mergeRewrittenVariableBlock } from './variable-block.js';

/* ------------------------------------------------------------------ *
 * ✨ 校正模式「自动配置」Phase 1 —— 纯检测 + 判定层（无 DOM / 无副作用 / 确定；无时钟无随机）。
 * 后续 UI / 守卫阶段消费这些函数：自动嗅探卡片把正文包在哪个标签里（作用域标签），让用户不必手配。
 * 这里只建【纯函数】——扫描顶层配平块、算「正文字数」、给作用域判定。复用 extractExcludedSections 的
 * 深度配平 + nb 名字边界（<plan>≠<planning>、[IMG]≠[IMGX]）、splitContentScope 的拆分、parseExcludeTags
 * 的标签解析、tokenizeForDiff 的 CJK 分类【思路】，不另起炉灶。
 * ------------------------------------------------------------------ */

// 「正文字数」判定码点：CJK 表意文字 + ASCII 字母。数字 / 标点 / 全角符号【不算】——它们是结构化数据信号，
// 不是正文（镜像 tokenizeForDiff 的 isCJK/isWord，但只认表意文字与字母，故 HP:80 这类数值面板几乎为 0 分）。
export function proseCharCount(text) {
    const s = String(text == null ? '' : text);
    let n = 0;
    for (let i = 0; i < s.length;) {
        const cp = s.codePointAt(i);
        i += cp > 0xffff ? 2 : 1;
        if ((cp >= 0x4e00 && cp <= 0x9fff) ||     // CJK 统一表意（一-鿿）
            (cp >= 0x3400 && cp <= 0x4dbf) ||     // CJK 扩展 A
            (cp >= 0xf900 && cp <= 0xfaff) ||     // CJK 兼容表意
            (cp >= 0x41 && cp <= 0x5a) ||         // A-Z
            (cp >= 0x61 && cp <= 0x7a)) n += 1;   // a-z
    }
    return n;
}

// 去掉嵌套标记（<…> / […] / {…}）后再数正文字数——让「几乎全是 HTML / JSON 的块」得低分、「叙事块」得高分
// （detectScopeTag 据此排名找正文包裹标签）。只剥标记【本身】，标记之间的文字保留。
function strippedProseChars(inner) {
    const stripped = String(inner == null ? '' : inner)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\{[^}]*\}/g, ' ');
    return proseCharCount(stripped);
}

// 纯函数：扫描 text 里【顶层】（深度 0）的配平块——尖括号 <name…>…</name> 与方括号 [NAME…]…[/NAME] 都认。
// 用一个栈：见开标签压栈（栈空时该块是一个顶层块的起点）；见闭标签，若栈中有同名（同分隔符）则一路出栈到它
// （自动闭合中间未闭的空元素，如 <br>），出栈到空 = 一个顶层块结束；栈里没有 = 孤立闭合，忽略。自闭合
// <name/> / [NAME/] 记为零内容顶层标记（selfClose，仅栈空时）。开了没闭（截断）→ 尖括号块取到结尾
// （方括号不做截断兜底——裸 [foo] 更可能是正文而非被截断的块）。名字边界用 nb（<plan>≠<planning>）。
// 返回 [{name,bracket,inner,selfClose,start,end}]，按文档顺序（start 升序），仅顶层。
function scanTopLevelBlocks(text) {
    const s = String(text == null ? '' : text);
    const nameCh = '[A-Za-z0-9_\\u4e00-\\u9fa5-]+';
    const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
    const re = new RegExp(
        '<\\/(' + nameCh + ')' + nb + '[^>]*>' +               // 1: 尖闭
        '|<(' + nameCh + ')' + nb + '([^>]*?)(\\/?)>' +        // 2 名 / 3 属性 / 4 斜杠：尖开
        '|\\[\\/(' + nameCh + ')' + nb + '[^\\]]*\\]' +        // 5: 方闭
        '|\\[(' + nameCh + ')' + nb + '([^\\]]*?)(\\/?)\\]',   // 6 名 / 7 属性 / 8 斜杠：方开
        'g');
    const blocks = [];
    const stack = [];   // { name, lower, bracket, openStart, innerStart }
    let m;
    while ((m = re.exec(s)) !== null) {
        const angleClose = m[1] != null;
        const angleOpen = m[2] != null;
        const bracketClose = m[5] != null;
        if (angleClose || bracketClose) {                       // —— 闭标签 ——
            const name = angleClose ? m[1] : m[5];
            const bracket = bracketClose;
            const lower = name.toLowerCase();
            let k = -1;
            for (let d = stack.length - 1; d >= 0; d -= 1) {
                if (stack[d].lower === lower && stack[d].bracket === bracket) { k = d; break; }
            }
            if (k === -1) continue;                             // 孤立闭合：忽略（留在正文）
            const opened = stack[k];
            stack.length = k;                                   // 出栈到 k（含）——自动闭合中间未闭的空元素
            if (stack.length === 0) {
                blocks.push({ name: opened.name, bracket: opened.bracket, inner: s.slice(opened.innerStart, m.index), selfClose: false, start: opened.openStart, end: m.index + m[0].length });
            }
        } else {                                                // —— 开标签 ——
            const name = angleOpen ? m[2] : m[6];
            const slash = angleOpen ? m[4] : m[8];
            const bracket = !angleOpen;
            if (slash === '/') {                                // 自闭合：仅栈空时记为顶层零内容标记
                if (stack.length === 0) blocks.push({ name, bracket, inner: '', selfClose: true, start: m.index, end: m.index + m[0].length });
                continue;
            }
            stack.push({ name, lower: name.toLowerCase(), bracket, openStart: m.index, innerStart: m.index + m[0].length });
        }
    }
    if (stack.length > 0 && !stack[0].bracket) {                // 截断：栈底【尖括号】块开了没闭 → 取到结尾
        const b = stack[0];
        blocks.push({ name: b.name, bracket: b.bracket, inner: s.slice(b.innerStart), selfClose: false, start: b.openStart, end: s.length });
    }
    blocks.sort((a, b) => a.start - b.start);
    return blocks;
}

// 纯函数：text 里【顶层】标签名数组（尖 + 方 + 自闭合），文档顺序，含重复（N 个块 = N 项）。
// fixScopeVerdict 用它列「正文外原样保留的块」；嵌套标签不计入。
function listTopLevelTagNames(text) {
    return scanTopLevelBlocks(text).map((b) => b.name);
}

// 已知【正文包裹】标签名（大小写不敏感）——命中即高置信（名字本身就是强信号）。小写常量以避开元测试「ALL_CAPS 须引用≥2次」规则。
const scopeKnownNames = new Set(['content', 'gametxt', '正文', 'story', 'text', 'narration', 'main', 'reply', 'msg']);
// 作用域【内层】里算【结构块】（保留区候选）的已知标签名（大小写不敏感，故存小写）。
const innerStructuralNames = new Set(['status', 'status_profile', 'item_info', 'char_info', 'options', 'branches', 'details', 'htmlcontent', 'updatevariable', 'img_gen', 'image', 'roll', 'bginfor', 'style', 'cestuff', 'action_info', 'so_seq']);   // action_info：命定之诗类战斗卡的结算面板（1.18.0 语料跑批采纳——此前靠标记密集启发式命中，改已知名后确定性守卫）。image：st-chatu8 类图生扩展的 <image>…</image> 生图提示词块（1.18.6 语料 prince-08 采纳——bare 模式靠 own-line 已守，wrapped 模式需白名单，否则 danbooru tag 被当散文送模型改花；姊妹名 img_gen 早已在册）
// 「有意义的正文」阈值（字）——低于它视作结构化 / 空块（noWrapper 据此判定）。
const scopeProseMin = 20;

// 纯函数：给最近 ~5 条 AI 回复，嗅探卡片把正文包在哪个【作用域标签】里。
// 每条回复找顶层配平块，算其【剥除嵌套标记后】的正文字数；跨回复按标签名累加（共识——一次性块被稀释）。
// 排名：已知名优先，再按正文字数降序。置信：已知 / 单一正文块 / 主块≥2×次块 → high；1.2–2× → med；近似并列或 3+ 相近 → low；
// 全无【有意义正文】→ none + noWrapper（卡片只包结构化数据、正文是裸的）。nullish/空 → none + noWrapper + candidates 空。
// 返回 { tag, bracket, confidence, candidates:[{tag,proseChars,known,bracket}], noWrapper }。
export function detectScopeTag(replies) {
    const list = Array.isArray(replies) ? replies : (replies == null || replies === '' ? [] : [replies]);
    if (!list.length) return { tag: '', bracket: false, confidence: 'none', candidates: [], noWrapper: true };
    const agg = new Map();   // lower → { tag, proseChars, known, bracket }
    for (const reply of list) {
        for (const b of scanTopLevelBlocks(reply)) {
            if (b.selfClose) continue;                          // 自闭合标记无正文，不作包裹候选
            const lower = b.name.toLowerCase();
            const prose = strippedProseChars(b.inner);
            const cur = agg.get(lower);
            if (cur) cur.proseChars += prose;
            else agg.set(lower, { tag: b.name, proseChars: prose, known: scopeKnownNames.has(lower), bracket: b.bracket });
        }
    }
    const candidates = [...agg.values()].sort((x, y) => {
        if (x.known !== y.known) return x.known ? -1 : 1;       // 已知名优先
        return y.proseChars - x.proseChars;                    // 再按正文字数降序
    });
    if (!candidates.length) return { tag: '', bracket: false, confidence: 'none', candidates: [], noWrapper: true };
    const prose = candidates.filter((c) => c.proseChars >= scopeProseMin).sort((x, y) => y.proseChars - x.proseChars);
    if (!prose.length) return { tag: '', bracket: false, confidence: 'none', candidates, noWrapper: true };   // 有块但全无有意义正文 → 结构化-only
    const top = candidates[0];
    let confidence;
    if (top.known) confidence = 'high';                         // 已知包裹名 = 强信号
    else if (prose.length <= 1) confidence = 'high';            // 独一份正文块
    else {
        const ratio = prose[0].proseChars / prose[1].proseChars;
        if (ratio >= 2) confidence = 'high';                    // 主块碾压次块
        else if (ratio < 1.2 || prose.length >= 3) confidence = 'low';   // 近似并列 / 多块混杂 → 说不准
        else confidence = 'med';                                // 有赢家但不算压倒
    }
    return { tag: top.tag, bracket: top.bracket, confidence, candidates, noWrapper: false };
}

// 标记密集：块内含 HTML 标签 / style= / { / [，且正文占比 < 0.5（叙事块几乎全是文字 → 占比高，不算结构）。
function isMarkupHeavy(text) {
    const s = String(text == null ? '' : text);
    if (!s) return false;
    const hasMarkup = /<[^>]+>/.test(s) || /style\s*=/.test(s) || s.indexOf('{') >= 0 || s.indexOf('[') >= 0;
    if (!hasMarkup) return false;
    // 正文占比以【剥除标记后】的正文字数为分子——HTML 标签名（div/style…）不是正文，不该计入。
    return strippedProseChars(s) / Math.max(1, s.length) < 0.5;
}

// 纯函数：作用域【内层】里的顶层块，返回其中的【结构块】[{name,bracket}]（保留区候选）。
// 结构块 = 名字在 innerStructuralNames，或【标记密集】（含 HTML / style= / { / [ 且正文占比低）。叙事块不返回。nullish → []。
export function detectInnerBlocks(scopeInner) {
    if (scopeInner == null || String(scopeInner) === '') return [];
    const out = [];
    for (const b of scanTopLevelBlocks(scopeInner)) {
        const lower = b.name.toLowerCase();
        if (innerStructuralNames.has(lower)) { out.push({ name: b.name, bracket: b.bracket }); continue; }
        if (b.selfClose) continue;                              // 非已知的自闭合标记：跳过（无内容可判）
        if (isMarkupHeavy(b.inner)) out.push({ name: b.name, bracket: b.bracket });
        // 否则叙事块，跳过
    }
    return out;
}

// 纯函数：某标签是否作为【开标签】出现在 text 里（nb 名字边界；尖 / 方按 spec.bracket）。
function tagPresentIn(text, spec) {
    const esc = spec.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
    return new RegExp((spec.bracket ? '\\[' : '<') + esc + nb, 'i').test(String(text == null ? '' : text));
}

/* ------------------------------------------------------------------ *
 * ✨ 分段校正（1.18.0）—— 纯层（无 DOM / 无副作用 / 确定；无时钟无随机）。
 * 把一条回复拆成「正文片段（piece）+ 结构守卫（guard）+ 碎屑（glue）」的有序表：正文片段逐段送
 * 【普通校正调用】（调优提示词字节不变），守卫（结构块 / 注释 / 代码栏 / 空元素行 / 水平线）绝不送
 * 模型、由代码逐字原位回拼（fixSpliceTable）。分类走「提议 → 确认一次 → 记住」阶梯（resolveFixPieces）。
 * 设计（Prince 批准 2026-07-01）：docs/superpowers/specs/2026-07-01-reply-fixer-piecewise-design.md。
 * scanTopLevelBlocks 字节不变（他处共用）；所有加固都在 fixMaskInert / fixScanBlocks 包装层。
 * ------------------------------------------------------------------ */

// HTML 空元素（void elements）——只有开标签、天生没有闭合。scanTopLevelBlocks 会把顶层未闭合的尖括号
// 开标签当「截断块」吞到结尾（红队 T3 幻影块），所以先遮掉再扫描。小写存（避开 ALL_CAPS 元测试规则）。
const fixVoidNames = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// 纯函数：把「惰性区间」遮成等长空白（\n 保留——own-line 判定与绝对偏移都依赖行结构；其余字符换空格），
// 返回 { masked, regions }。四类（先记先赢、区间互不重叠）：① 成对 HTML 注释 <!-- … -->；② 成对代码栏
// （own-line ``` 行，第 1-2 根配一对、3-4 配一对…；奇数根剩单不遮）；③ 空元素标签（fixVoidNames）；
// ④ own-line markdown 水平线 ---/***/___（3+，形状 B 的分隔线是结构不是正文）。未配对注释 / 代码栏不遮
// （当正文，降级=今天、绝不更糟）。遮蔽等长 → masked 上扫出的偏移在原文里原样可用。可单测。
function fixMaskInert(text) {
    const s = String(text == null ? '' : text);
    if (!s) return { masked: '', regions: [] };
    const regions = [];
    const overlaps = (a, b) => regions.some((r) => a < r.end && b > r.start);
    let m;
    const cRe = /<!--[\s\S]*?-->/g;
    while ((m = cRe.exec(s)) !== null) regions.push({ start: m.index, end: m.index + m[0].length, kind: 'comment' });
    const fRe = /^[ \t]*`{3,}[^\n]*$/gm;
    const fenceMarks = [];
    while ((m = fRe.exec(s)) !== null) {
        if (!overlaps(m.index, m.index + m[0].length)) fenceMarks.push({ start: m.index, end: m.index + m[0].length });
    }
    for (let i = 0; i + 1 < fenceMarks.length; i += 2) {
        const a = fenceMarks[i].start, b = fenceMarks[i + 1].end;
        if (!overlaps(a, b)) regions.push({ start: a, end: b, kind: 'fence' });
    }
    const vRe = new RegExp('<(?:' + [...fixVoidNames].join('|') + ')(?![A-Za-z0-9_\\u4e00-\\u9fa5-])[^>]*>', 'gi');
    while ((m = vRe.exec(s)) !== null) {
        if (!overlaps(m.index, m.index + m[0].length)) regions.push({ start: m.index, end: m.index + m[0].length, kind: 'void' });
    }
    const hRe = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm;
    while ((m = hRe.exec(s)) !== null) {
        const a = m.index + (m[0].match(/^[ \t]*/) || [''])[0].length;
        const b = m.index + m[0].replace(/[ \t]+$/, '').length;
        if (!overlaps(a, b)) regions.push({ start: a, end: b, kind: 'hr' });
    }
    // ✨ 同行贴连的注释合并成一个区间（1.18.0 语料实测 prince-06 修复）：房东模拟器类卡的「隐藏思考步」
    // 把 <!--A--><!--B--><!--C--> 连写在一行——单个注释因左右还贴着别的注释而过不了 own-line 判定，
    // 三个全都跟正文走 → CoT 泄漏进片段。合并（间隙只有空格 / 制表才算贴连）后整行一体、照常成守卫。
    regions.sort((x, y) => x.start - y.start);
    for (let i = regions.length - 2; i >= 0; i -= 1) {
        const a = regions[i], b = regions[i + 1];
        if (a.kind === 'comment' && b.kind === 'comment' && /^[ \t]*$/.test(s.slice(a.end, b.start))) {
            a.end = b.end;
            regions.splice(i + 1, 1);
        }
    }
    // ✨ ⑤ 被放弃的孤儿开标签（1.18.0 语料实测 prince-04 修复）：开了没闭、且同名标签在其后【再次开启】
    // ——管线重试 CoT 的野外常见形态（<logic_check> 截断后又来一个完整的）。不遮的话，scanTopLevelBlocks
    // 的截断兜底会让第一个开标签把【后面整条回复】吞成幻影块（<content> 都从顶层消失，分类 / 分段全瞎）。
    // 判据刻意收窄到「同名再开」：孤立的收尾截断开标签（回复被砍断的 <content>，无同名再开）绝不遮——
    // 那是合法截断，拆分 / 分段都靠兜底处理它。检测跑在①-④遮蔽【之后】的文本上（注释 / 代码栏 / 空元素
    // 里的假标签不参与判定）；只查尖括号（方括号块本就无截断兜底、吞不了文档）。
    regions.sort((x, y) => x.start - y.start);
    let pre = s;
    if (regions.length) {
        let acc = '', cursor = 0;
        for (const r of regions) { acc += s.slice(cursor, r.start) + s.slice(r.start, r.end).replace(/[^\n]/g, ' '); cursor = r.end; }
        pre = acc + s.slice(cursor);
    }
    {
        const nameCh = '[A-Za-z0-9_\\u4e00-\\u9fa5-]+';
        const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
        const tokRe = new RegExp('<\\/(' + nameCh + ')' + nb + '[^>]*>|<(' + nameCh + ')' + nb + '(?:[^>]*?)(\\/?)>', 'g');
        const stack = [];
        const opensByName = new Map();
        let tm;
        while ((tm = tokRe.exec(pre)) !== null) {
            if (tm[1] != null) {                                    // 闭标签：镜像 scanTopLevelBlocks 的出栈（连带自动闭合其上的未闭项）
                const lower = tm[1].toLowerCase();
                for (let d = stack.length - 1; d >= 0; d -= 1) {
                    if (stack[d].lower === lower) { stack.length = d; break; }
                }
            } else if (tm[3] !== '/') {                             // 开标签（自闭合不入栈）
                const lower = tm[2].toLowerCase();
                if (fixVoidNames.has(lower)) continue;              // 空元素已在④遮蔽，防御性跳过
                stack.push({ lower, start: tm.index, end: tm.index + tm[0].length });
                if (!opensByName.has(lower)) opensByName.set(lower, []);
                opensByName.get(lower).push(tm.index);
            }
        }
        for (const o of stack) {                                    // EOF 时仍未闭合的开标签 = 截断兜底的候选
            const list = opensByName.get(o.lower) || [];
            if (list.some((pos) => pos > o.start)) regions.push({ start: o.start, end: o.end, kind: 'orphan' });
        }
    }
    // ✨ ⑥ 不成对的方括号开标记（2026-07-12 语料实测 prince-11 修复）：规划文本里的裸数学 / 骰子方括号
    // （[20+(15+体力调整值)×2] 会匹配成名为「20」的方括号开标签）压进 scanTopLevelBlocks 的共享栈后永不
    // 闭合——若其外又没有任何包裹块替它自动闭合（prince-11 恰好缺了 <konatan_planning~> 开标签），其后
    // 【所有】配平良好的尖括号块都记在深度≥1、顶层扫描全瞎，阶梯掉到「纯散文」→ 整条回复送模型。
    // 方括号块本就没有截断兜底（裸 [foo] 更可能是正文），「其后无同名 [/name] 闭标记」的开标记今天
    // 也永远成不了块——遮掉它只消除栈污染、不丢任何现存块。成对（[IMG_GEN]…[/IMG_GEN]）与自闭合
    // （[NAME/]）不遮；同名双开单闭的重叠形态维持现状（没咬过人，咬了再修）。检测同⑤跑在①-④遮蔽
    // 后的文本上（注释 / 代码栏里的方括号不参与判定）。
    {
        const nameCh = '[A-Za-z0-9_\\u4e00-\\u9fa5-]+';
        const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
        const bkRe = new RegExp('\\[\\/(' + nameCh + ')' + nb + '[^\\]]*\\]|\\[(' + nameCh + ')' + nb + '(?:[^\\]]*?)(\\/?)\\]', 'g');
        const closesByName = new Map();   // lower → [闭标记起点…]（文档序）
        const opens = [];
        let bm;
        while ((bm = bkRe.exec(pre)) !== null) {
            if (bm[1] != null) {
                const lower = bm[1].toLowerCase();
                if (!closesByName.has(lower)) closesByName.set(lower, []);
                closesByName.get(lower).push(bm.index);
            } else if (bm[3] !== '/') {                             // 开标记（自闭合不入栈、不遮）
                opens.push({ lower: bm[2].toLowerCase(), start: bm.index, end: bm.index + bm[0].length });
            }
        }
        for (const o of opens) {
            if ((closesByName.get(o.lower) || []).some((pos) => pos > o.start)) continue;   // 其后有同名闭标记 = 可配平，不遮
            if (!overlaps(o.start, o.end)) regions.push({ start: o.start, end: o.end, kind: 'bracket' });
        }
    }
    // ✨ ⑦ 裸比较号 / 非标签尖括号开标记（2026-07-14 语料实测 prince-12 修复）：散文里的裸比较号
    // （「16<20，不达标」）会匹配成名为「20」的尖括号开标签，其懒惰 attrs `[^>]*?` 一路吃到文中
    // 【下一个 > 字符】——跨行、连真闭标签 </konatan_planning~> 一起吞进 attrs → 规划块永不闭合 →
    // EOF 截断兜底把整条回复吞成一个块 → <content> 顶层消失、阶梯提议错误包裹名（⑥的尖括号表亲，
    // 且更凶：不止污染栈，还偷吃一个真闭标签）。判据：开标记「名字纯数字」或「token 跨行」，且
    // 「其后无同名闭标签」（豁免理论上的 <20>…</20> 真数字标签与跨行 attrs 的真标签）。只遮
    // 【头部 <name】不遮整个 token——被吞进 attrs 的真闭标签因此重新暴露给扫描器（遮整段=闭标签
    // 跟着消失，块照样吞到结尾＝白修）。字母名的同行比较（a<b 且 c>d）不遮（没咬过人，咬了再修）。
    {
        const nameCh = '[A-Za-z0-9_\\u4e00-\\u9fa5-]+';
        const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
        const agRe = new RegExp('<\\/(' + nameCh + ')' + nb + '[^>]*>|<(' + nameCh + ')' + nb + '(?:[^>]*?)(\\/?)>', 'g');
        const closePos = new Map();   // lower → [闭标签起点…]（文档序）
        const opens = [];
        let am;
        while ((am = agRe.exec(pre)) !== null) {
            if (am[1] != null) {
                const lower = am[1].toLowerCase();
                if (!closePos.has(lower)) closePos.set(lower, []);
                closePos.get(lower).push(am.index);
            } else if (am[3] !== '/') {
                opens.push({ name: am[2], lower: am[2].toLowerCase(), start: am.index, text: am[0] });
            }
        }
        for (const o of opens) {
            if (!/^[0-9]+$/.test(o.name) && !o.text.includes('\n')) continue;   // 判据：纯数字名 或 跨行 token
            if ((closePos.get(o.lower) || []).some((pos) => pos > o.start)) continue;   // 其后有同名闭标签 = 真标签，豁免
            const headEnd = o.start + 1 + o.name.length;   // 只遮 <name 头
            if (!overlaps(o.start, headEnd)) regions.push({ start: o.start, end: headEnd, kind: 'cmp' });
        }
    }
    // ✨ ⑧ 缺开标签的块内裸开标签（2026-07-20 语料实测 prince-13 修复）：模型漏掉规划块的开标签
    // <konatan_planning~>（missing-open 家族第 3 例），规划里又有裸开标签 <history>/<writing_style>
    // （字母名、各自无闭）→ 第一个被 scanTopLevelBlocks 的【截断兜底】当栈底块吞到 EOF，连它后面
    // 完整闭合的 <content>/<tucao>/<UpdateVariable> 全吞进去 → <content> 顶层消失、fixDominantWrapper
    // 误判 <history> 为正文包裹。⑥（数字方括号）/ ⑦（数字或跨行尖括号）都逮不到字母名裸标签。判据：
    // 「其后无同名闭标签的裸开标签」且「其后存在一个孤儿闭标签（`</name>` 之前无同名开标签）」——孤儿
    // 闭标签＝某块开标签被漏掉的铁证，这些裸开就是那个丢了开标签的块【内部】之物，绝非真截断（真截断的
    // <content> 在 EOF、其后无完整块也无孤儿闭 → firstOrphanClose=∞ → 本规则不动它）。全遮（不只第一个）
    // ——否则第二个裸开接棒当栈底幻影。只遮头 <name（潜在吞进 attrs 的真闭标签重新暴露，同⑦）。
    // 【定点迭代】：遮掉一个幻影头后，可能露出它此前吞进 lazy attrs 的另一个裸开（MUT-5：顶部的 3<7 把
    // 紧随的 <history> 吞进 attrs → 单遍扫描时 <history> 藏在 7 的 token 里、看不见）——每轮在【已应用全部
    // region 的工作副本】上重扫，直到不再新增。被遮的头在副本里已成空白、不再匹配成开标签，故必然收敛。
    {
        const nameCh = '[A-Za-z0-9_\\u4e00-\\u9fa5-]+';
        const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
        const tokRe = new RegExp('<\\/(' + nameCh + ')' + nb + '[^>]*>|<(' + nameCh + ')' + nb + '(?:[^>]*?)(\\/?)>', 'g');
        let grew = true;
        while (grew) {
            grew = false;
            let work = '', cur = 0;   // s 应用【当前全部 region】后的工作副本（含 ⑤⑥⑦ 的遮蔽）
            for (const r of [...regions].sort((a, b) => a.start - b.start)) { work += s.slice(cur, r.start) + s.slice(r.start, r.end).replace(/[^\n]/g, ' '); cur = r.end; }
            work += s.slice(cur);
            const opensByName = new Map(), closesByName = new Map(), opens = [];
            let om; tokRe.lastIndex = 0;
            while ((om = tokRe.exec(work)) !== null) {
                if (om[1] != null) {
                    const lower = om[1].toLowerCase();
                    if (!closesByName.has(lower)) closesByName.set(lower, []);
                    closesByName.get(lower).push(om.index);
                } else if (om[3] !== '/') {
                    const lower = om[2].toLowerCase();
                    if (!opensByName.has(lower)) opensByName.set(lower, []);
                    opensByName.get(lower).push(om.index);
                    opens.push({ name: om[2], lower, start: om.index });
                }
            }
            let firstOrphanClose = Infinity;   // 最早的「其前无同名开标签」闭标签 = 丢了开标签的块的收尾
            for (const [lower, cps] of closesByName) {
                const ops = opensByName.get(lower) || [];
                for (const cp of cps) { if (!ops.some((op) => op < cp)) { firstOrphanClose = Math.min(firstOrphanClose, cp); break; } }
            }
            if (firstOrphanClose === Infinity) break;   // 无孤儿闭标签 = 无丢开标签的块 → 不动
            for (const o of opens) {
                if (o.start >= firstOrphanClose) continue;                                   // 只管孤儿闭之前（丢了开标签的块内部）
                if ((closesByName.get(o.lower) || []).some((pos) => pos > o.start)) continue;  // 有同名闭标签 = 真块，豁免
                const headEnd = o.start + 1 + o.name.length;
                if (overlaps(o.start, headEnd)) continue;
                regions.push({ start: o.start, end: headEnd, kind: 'lostopen' });
                grew = true;
            }
        }
    }
    regions.sort((x, y) => x.start - y.start);
    if (!regions.length) return { masked: s, regions };
    let out = '', last = 0;
    for (const r of regions) {
        out += s.slice(last, r.start) + s.slice(r.start, r.end).replace(/[^\n]/g, ' ');
        last = r.end;
    }
    return { masked: out + s.slice(last), regions };
}

// 纯函数：候选区间是否「独占整行」——开分隔符所在行、它之前只有空白；闭分隔符所在行、它之后只有空白。
// 行内的标记跟着正文走、不当守卫（设计 §2 own-line 规则——唯一的结构判断）。文首 / 文尾视作行界。
function fixOwnLine(text, start, end) {
    const s = String(text == null ? '' : text);
    for (let i = start - 1; i >= 0; i -= 1) {
        const ch = s[i];
        if (ch === '\n') break;
        if (ch !== ' ' && ch !== '\t') return false;
    }
    for (let j = end; j < s.length; j += 1) {
        const ch = s[j];
        if (ch === '\n') break;
        if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
    }
    return true;
}

// 纯函数：扫描 text 里可作【结构守卫】的顶层候选（绝对偏移、文档顺序、互不重叠、全部 own-line）。
// 加固全在这层（scanTopLevelBlocks 字节不变）：先 fixMaskInert 遮惰性区间再扫描（注释 / 代码栏里的假
// 标签不再骗过、空元素不再造「吞到结尾的幻影块」）；方括号块走白名单 innerStructuralNames（[IMG_GEN] /
// [STATUS] 是结构块，[b]/[color]/[quote] 这类 BBCode 是行内排版、跟正文走——红队 T3）；注释 / 代码栏 /
// 空元素 / 水平线本身也是候选；嵌在别的候选内部的丢弃（只留顶层）；最后 own-line 过滤（行内标记跟正文走）。
// 返回 [{start,end,name,bracket,kind,selfClose}]，kind ∈ 'block'|'comment'|'fence'|'void'|'hr'。可单测。
export function fixScanBlocks(text) {
    const s = String(text == null ? '' : text);
    if (!s) return [];
    const { masked, regions } = fixMaskInert(s);
    const cands = [];
    for (const b of scanTopLevelBlocks(masked)) {
        if (b.bracket && !innerStructuralNames.has(b.name.toLowerCase())) continue;   // 方括号白名单
        cands.push({ start: b.start, end: b.end, name: b.name, bracket: b.bracket, kind: 'block', selfClose: !!b.selfClose });
    }
    for (const r of regions) cands.push({ start: r.start, end: r.end, name: '', bracket: false, kind: r.kind, selfClose: false });
    cands.sort((a, b) => a.start - b.start || b.end - a.end);
    const top = [];
    let lastEnd = -1;
    for (const c of cands) {
        if (c.start >= lastEnd) { top.push(c); lastEnd = c.end; }   // 嵌套候选（注释在块内等）只留外层
    }
    return top.filter((c) => fixOwnLine(s, c.start, c.end));
}

// 纯函数：用户保留区标签名集合（小写、不分尖 / 方括号）——wrapped 递归判「结构样」时，用户点名保留的
// 块也算结构（设计 §2）。nullish 安全。
export function fixKeepNameSet(keepTags) {
    return new Set(parseExcludeTags(keepTags).map((sp) => sp.name.toLowerCase()));
}

// 内部走表器：按守卫区间把 text 切成有序段。守卫逐字 verbatim；守卫之间的散文 run 按正文字数分流——
// ≥ scopeProseMin 成为可校正 piece（lead/core/trail 三分：模型只看 trim 过的 core，行首行尾空白由代码
// 回拼，护住卡片按行锚定的正则——设计 §2 边界卫生），不足是 glue 碎屑（逐字保留）。空 run 直接省略
//（零长度、不影响平铺）。guards 需已按 start 升序、互不重叠、相对 text 的偏移。
// 平铺不变量：返回段落按序拼接 === text。
function segmentRuns(text, guards) {
    const s = String(text == null ? '' : text);
    const segs = [];
    const pushRun = (run) => {
        if (run === '') return;
        const lead = (run.match(/^\s*/) || [''])[0];
        if (lead.length === run.length) { segs.push({ kind: 'glue', text: run }); return; }   // 全空白
        const trail = (run.match(/\s*$/) || [''])[0];
        const core = run.slice(lead.length, run.length - trail.length);
        if (proseCharCount(core) < scopeProseMin) segs.push({ kind: 'glue', text: run });
        else segs.push({ kind: 'piece', text: run, lead, core, trail, index: -1 });
    };
    let pos = 0;
    for (const g of (Array.isArray(guards) ? guards : [])) {
        pushRun(s.slice(pos, g.start));
        if (g.end > g.start) segs.push({ kind: 'guard', text: s.slice(g.start, g.end) });
        pos = g.end;
    }
    pushRun(s.slice(pos));
    return segs;
}

// 纯函数：分段主入口（设计 §2）。opts.mode：
//   'bare'    —— 正文是标签之外的散文：fixScanBlocks 的 every own-line 候选都是守卫（散文卡上 "tagged"
//                就是 "非正文" 的定义——不做散文排名，无从被散文味的 <draft_notes>/<details>摘要 骗过）。
//   'wrapped' —— 见 Task 5（正文包在 opts.tag 里，可多块，块内递归）。
// 返回 { mode, segments, pieces, guards, wrapperCount, bypass }：segments 平铺不变量
// map(text).join('') === reply；pieces = piece 段引用（文档顺序，piece.index 对齐下标）；guards = 守卫段数；
// bypass 仅 wrapped 有意义（Task 5）。可单测。
export function fixSegmentReply(reply, opts) {
    const s = String(reply == null ? '' : reply);
    const o = opts || {};
    let segments;
    let wrapperCount = 0;
    let soleInner = null;
    if (o.mode === 'wrapped') {
        const name = (parseExcludeTagNames(o.tag)[0] || '').toLowerCase();
        const keepNames = (o.keepNames instanceof Set) ? o.keepNames : new Set();
        const { masked } = fixMaskInert(s);
        // 包裹块按【名字】认（不做 own-line / 白名单过滤——包裹是既定身份），尖 / 方都认（修 P2）。
        // 在遮蔽文本上扫（注释里的假 <content> 不算）；偏移 / 长度因等长遮蔽在原文上原样可用。
        const wrappers = name ? scanTopLevelBlocks(masked).filter((b) => !b.selfClose && b.name.toLowerCase() === name) : [];
        wrapperCount = wrappers.length;
        if (!wrappers.length) {
            segments = s ? [{ kind: 'guard', text: s }] : [];
        } else {
            segments = [];
            const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const nb = '(?![A-Za-z0-9_\\u4e00-\\u9fa5-])';
            const openRe = new RegExp('^(?:\\[' + esc + nb + '[^\\]]*\\]|<' + esc + nb + '[^>]*>)', 'i');
            let pos = 0;
            for (const w of wrappers) {
                const openLen = (s.slice(w.start).match(openRe) || [''])[0].length;
                if (!openLen) {   // 防御：开标签解析不出（不应发生）→ 整块当守卫，绝不切错
                    if (w.end > pos) segments.push({ kind: 'guard', text: s.slice(pos, w.end) });
                    pos = w.end;
                    continue;
                }
                const innerStart = w.start + openLen;
                const innerEnd = innerStart + w.inner.length;   // 遮蔽等长 → 长度可信
                if (innerStart > pos) segments.push({ kind: 'guard', text: s.slice(pos, innerStart) });   // 信封 + 开标签
                const innerText = s.slice(innerStart, innerEnd);   // 原文内层（不是遮蔽版）
                if (wrappers.length === 1) soleInner = innerText;
                // 内层递归：own-line 块【结构样】才是守卫——已知结构名 / 用户保留区点名 / 标记密集 /
                // 自闭合标记 / 注释·代码栏·空元素·水平线；散文样的未知块跟正文走（照今天，避免漏校）。
                const innerGuards = fixScanBlocks(innerText).filter((c) => {
                    if (c.kind !== 'block') return true;
                    if (c.selfClose) return true;
                    const lower = String(c.name).toLowerCase();
                    if (innerStructuralNames.has(lower) || keepNames.has(lower)) return true;
                    return isMarkupHeavy(innerText.slice(c.start, c.end));
                });
                for (const seg of segmentRuns(innerText, innerGuards)) segments.push(seg);
                pos = innerEnd;
            }
            if (pos < s.length) segments.push({ kind: 'guard', text: s.slice(pos) });   // 闭标签 + 信封尾
        }
    } else {
        segments = segmentRuns(s, fixScanBlocks(s));
    }
    const pieces = [];
    for (const seg of segments) if (seg.kind === 'piece') { seg.index = pieces.length; pieces.push(seg); }
    const guards = segments.filter((seg) => seg.kind === 'guard').length;
    const bypass = o.mode === 'wrapped' && wrapperCount === 1 && pieces.length === 1
        && soleInner !== null && pieces[0].text === soleInner;
    return { mode: o.mode === 'wrapped' ? 'wrapped' : 'bare', segments, pieces, guards, wrapperCount, bypass };
}

// 纯函数：判定行 / 确认提案文案用的表计数——正文片段数、正文总字数（core 的 proseCharCount 之和）、守卫块数。
export function fixTableCounts(table) {
    const pieces = (table && Array.isArray(table.pieces)) ? table.pieces : [];
    const segs = (table && Array.isArray(table.segments)) ? table.segments : [];
    return {
        pieces: pieces.length,
        prose: pieces.reduce((n, p) => n + proseCharCount(p.core), 0),
        guards: segs.filter((x) => x.kind === 'guard').length,
    };
}

// 📋 判定行（自定义任务）：纯文案（spec §4；§11 草稿）。
// preview（评审 F4）：本聊天【跑的还是校正】，用户只是把面板切到「自定义」看看——这时一句结局都不能许。
// 缺模板：不说「本条不会处理」（那对这个聊天是假话，它跑的是校正），改说现状 + 怎么切过来。
// 有模板：把如常那句原样加一个前缀标明是预览。判据只有 preview 这一个形参，其余分支逐字节不动。
export function fixCustomVerdictText({ template, exists, useMechanic, mode, tag, pieces, prose, guards, keepCount, preview }) {
    const name = `模板〔${template || ''}〕`;
    if (preview && !exists) return { cls: 'pad-fix-verdict pad-fix-verdict-neutral', text: 'ⓘ 本聊天目前跑的是校正。要改用模板，先在下方选或新建一份，再勾「每条新回复自动运行模板」。' };
    if (!exists) return { cls: 'pad-fix-verdict pad-fix-verdict-warn', text: `⚠ ${name}不存在或正文为空，本条不会处理——先在下方选或新建一份模板。` };
    const pre = preview ? '（预览·本聊天目前跑校正）' : '';
    if (!useMechanic) return { cls: 'pad-fix-verdict pad-fix-verdict-neutral', text: `${pre}ⓘ 本条回复将：整条交给${name}（保留区 ${keepCount | 0} 块原位保留）。` };
    if (mode === 'wrapped' || mode === 'bare') {
        const where = mode === 'wrapped' ? `命中 <${tag}> → ` : '散文正文 → ';
        return { cls: 'pad-fix-verdict pad-fix-verdict-ok', text: `${pre}✓ ${where}沿用识别：${pieces | 0} 段正文（共 ${prose | 0} 字）交给${name}；${guards | 0} 块结构原样保留。` };
    }
    return { cls: 'pad-fix-verdict pad-fix-verdict-neutral', text: `${pre}ⓘ 这条回复没有包裹标签也没有结构块 → 整条正文交给${name}。` };
}

// 纯函数：✨ 检测收据（1.18.3）——把分段表里的守卫段重扫成「本条已自动保留」清单，供保留区上方的
// 芯片读数（点芯片=固定进保留区）。对每个 guard 段：fixMaskInert 遮惰性区间 → scanTopLevelBlocks
// 数命名块（信封段里可能拼着多块，逐块计）；惰性区间按 kind 记（注释 / 代码栏 / 空标记 / 分隔线 /
// 未闭合标签）。wrapperTag 指包裹标签名（wrapped 模式）——信封里包裹自身的开 / 闭标签碎片会被
// scanTopLevelBlocks 的截断兜底当成幻影块，必须按名剔除。命名块在前（文档顺序）、惰性项在后。
// nullish 安全 → []。可单测。
export function fixGuardSummary(table, opts) {
    const o = opts || {};
    const wrapper = String(o.wrapperTag || '').toLowerCase();
    const segs = (table && Array.isArray(table.segments)) ? table.segments : [];
    const named = new Map();
    const kinds = new Map();
    const KIND_LABEL = { comment: '注释', fence: '代码栏', void: '空标记', hr: '分隔线', orphan: '未闭合标签' };
    for (const seg of segs) {
        if (!seg || seg.kind !== 'guard') continue;
        const { masked, regions } = fixMaskInert(String(seg.text || ''));
        for (const b of scanTopLevelBlocks(masked)) {
            const lower = b.name.toLowerCase();
            if (wrapper && lower === wrapper) continue;
            const key = (b.bracket ? '[' : '<') + lower;
            const cur = named.get(key) || { label: b.bracket ? ('[' + b.name + ']') : ('<' + b.name + '>'), name: b.name, bracket: !!b.bracket, count: 0 };
            cur.count += 1;
            named.set(key, cur);
        }
        for (const r of (Array.isArray(regions) ? regions : [])) {
            const lbl = KIND_LABEL[r.kind];
            if (!lbl) continue;
            const cur = kinds.get(r.kind) || { label: lbl, name: '', bracket: false, count: 0 };
            cur.count += 1;
            kinds.set(r.kind, cur);
        }
    }
    return [...named.values(), ...kinds.values()];
}

// 纯函数：把逐段结果 splice 回原位 → 整条最终文本（设计 §1 第 5 步）。守卫 / 碎屑逐字；修好的片段
// （status:'fixed' 且 fixedCore 是字符串）进原槽（lead + fixedCore + trail，行首行尾空白回贴）；其余
// （gated / failed / truncated / capped / toolong / clean / 缺槽）保留原文——单段失败只损失那一段。
// 无结果 = 恒等。可单测。
export function fixSpliceTable(table, results) {
    const segs = (table && Array.isArray(table.segments)) ? table.segments : [];
    const res = Array.isArray(results) ? results : [];
    let out = '';
    for (const seg of segs) {
        if (seg.kind === 'piece') {
            const r = res[seg.index];
            out += (r && r.status === 'fixed' && typeof r.fixedCore === 'string')
                ? seg.lead + r.fixedCore + seg.trail
                : seg.text;
        } else {
            out += seg.text;
        }
    }
    return out;
}

// 纯函数：某标签在 reply 里的顶层块统计（遮蔽后扫描——注释 / 代码栏里的假标签不算；尖 / 方都认）。
// prose = 各块内层剥标记正文字数之和（strippedProseChars）。
function fixWrapperStats(reply, tag) {
    const s = String(reply == null ? '' : reply);
    const name = (parseExcludeTagNames(tag)[0] || '').toLowerCase();
    if (!name || !s) return { present: false, prose: 0, count: 0 };
    const blocks = scanTopLevelBlocks(fixMaskInert(s).masked).filter((b) => !b.selfClose && b.name.toLowerCase() === name);
    return { present: blocks.length > 0, prose: blocks.reduce((n, b) => n + strippedProseChars(b.inner), 0), count: blocks.length };
}

// 纯函数：这条回复里「已知正文包裹名」（scopeKnownNames）的最优候选——在场、正文过地板、且【正文占优】
// （该名各块内层正文 ≥ 全回复正文一半——3 字 <text>好的。</text> 不抢跑，修 P3）。无 → null。
function fixKnownWrapper(reply) {
    const s = String(reply == null ? '' : reply);
    if (!s) return null;
    const total = strippedProseChars(s);
    const agg = new Map();
    for (const b of scanTopLevelBlocks(fixMaskInert(s).masked)) {
        if (b.selfClose) continue;
        const lower = b.name.toLowerCase();
        if (!scopeKnownNames.has(lower)) continue;
        const cur = agg.get(lower) || { tag: b.name, prose: 0 };
        cur.prose += strippedProseChars(b.inner);
        agg.set(lower, cur);
    }
    let best = null;
    for (const c of agg.values()) if (!best || c.prose > best.prose) best = c;
    if (!best || best.prose < scopeProseMin || best.prose < 0.5 * total) return null;
    return { tag: best.tag };
}

// 纯函数：这条回复里【任意名字】的正文占优包裹候选（fixKnownWrapper 的去白名单版；阶梯在已知名
// 检出失败后用它给「未知包裹标签」出【确认一次】提案——绝不静默采纳未知名，问过用户才记）。
// 同一门槛：正文过地板 且 ≥ 全回复正文一半。无 → null。可单测。
function fixDominantWrapper(reply) {
    const s = String(reply == null ? '' : reply);
    if (!s) return null;
    const total = strippedProseChars(s);
    const agg = new Map();
    for (const b of scanTopLevelBlocks(fixMaskInert(s).masked)) {
        if (b.selfClose) continue;
        const lower = b.name.toLowerCase();
        const cur = agg.get(lower) || { tag: b.name, prose: 0 };
        cur.prose += strippedProseChars(b.inner);
        agg.set(lower, cur);
    }
    let best = null;
    for (const c of agg.values()) if (!best || c.prose > best.prose) best = c;
    if (!best || best.prose < scopeProseMin || best.prose < 0.5 * total) return null;
    return { tag: best.tag };
}

// 纯函数：✨ 分段校正决策阶梯（设计 §3「提议 → 确认一次 → 记住」）。确定（同一条回复 → 同一决策）、
// 不写状态——采纳（adopt）/ 记忆 / 提示由调用方（runAutoFix / runFixByTargets）落地。与 1.17.16 的
// resolveFixScope 不同：不收 replies 语料，所有判断只看【钉住的这条回复】（1.17.12 pin-to-N 教训）。
// 阶梯（先中先出）：0 opt-out（标签留空=整条，用户主权）→ 1 手动神圣（命中 wrapped / 不在 suggest，
// 永不代改）→ 2 wrapped 缓存重验（在场+正文过地板，修 P1 只验在场）→ 3 bare 缓存重验（没冒出占优
// 已知包裹；冒出则往下重新提案）→ 4 静默迁移（无缓存但 cfg 标签就在这条里且过地板——默认 content /
// 1.17.16 老缓存原样接管，quiet 不打扰）→ 5 已知包裹检出（fixKnownWrapper 占优 → 采纳+一次性提示，
// 老 detected 行为）→ 6 wrapped 缓存失灵的个例回复（skip，绝不把既定包裹卡转成 bare 询问）→ 7 纯散文
// （无 own-line 结构 → 整条，无可保护）→ 8 确认一次（散文+结构混排：问过 pending / 没问过 ask）。
// 返回 { action, mode, tag, adopt, note }（形状见各 return）。可单测、可离线跑真卡语料（预发布门）。
export function resolveFixPieces({ pieceMode, scopeTag, scopeManual, pieceAsked, reply } = {}) {
    const tag = (scopeTag == null) ? '' : String(scopeTag).trim();
    if (!tag) return { action: 'run', mode: 'whole', tag: '', adopt: null, note: null };
    if (scopeManual) {
        const st = fixWrapperStats(reply, tag);
        if (st.present && st.prose >= scopeProseMin) return { action: 'run', mode: 'wrapped', tag, adopt: null, note: null };
        const det = fixKnownWrapper(reply);
        return { action: 'suggest', mode: '', tag, adopt: null, note: { code: 'suggest', cachedTag: tag, detectedTag: det ? det.tag : '' } };
    }
    if (pieceMode === 'wrapped') {
        const st = fixWrapperStats(reply, tag);
        if (st.present && st.prose >= scopeProseMin) return { action: 'run', mode: 'wrapped', tag, adopt: null, note: null };
    }
    if (pieceMode === 'bare' && !fixKnownWrapper(reply)) {
        return { action: 'run', mode: 'bare', tag: '', adopt: null, note: null };
    }
    if (pieceMode !== 'wrapped') {
        const st = fixWrapperStats(reply, tag);
        if (st.present && st.prose >= scopeProseMin) {
            return { action: 'run', mode: 'wrapped', tag, adopt: { quiet: true }, note: null };
        }
    }
    const det = fixKnownWrapper(reply);
    if (det) return { action: 'run', mode: 'wrapped', tag: det.tag, adopt: { quiet: false }, note: { code: 'autoWrapped', cachedTag: tag, detectedTag: det.tag } };
    if (pieceMode === 'wrapped') {
        return { action: 'skip', mode: '', tag, adopt: null, note: { code: 'skipAnomaly', cachedTag: tag, detectedTag: '' } };
    }
    // ✨ 梯 7.5（1.18.0 追加，Prince 定案）：未知名但【正文占优】的包裹标签（如 <narrative_x>）——绝不静默
    // 采纳未知名（那是 P3 的教训），改出【确认一次】的 wrapped 提案；此前这类卡会掉进 bare 提案 → 零 piece →
    // noNarrative 跳过（正文全在未知包裹里、bare 视角看不见），等于「没法校」。问过 → pending 同 bare。
    const dom = fixDominantWrapper(reply);
    if (dom) {
        return pieceAsked
            ? { action: 'pending', mode: 'wrapped', tag: dom.tag, adopt: null, note: null }
            : { action: 'ask', mode: 'wrapped', tag: dom.tag, adopt: null, note: { code: 'askWrapped', cachedTag: tag, detectedTag: dom.tag } };
    }
    if (!fixScanBlocks(reply).length) return { action: 'run', mode: 'whole', tag: '', adopt: null, note: null };
    return pieceAsked
        ? { action: 'pending', mode: 'bare', tag: '', adopt: null, note: null }
        : { action: 'ask', mode: 'bare', tag: '', adopt: null, note: null };
}

// 纯函数：给每个正文片段定处置（entries 文档顺序对齐 pieces）：'attempt'（值得发调用）/ 'gated'（成本门
// 不过——太短 / 无禁词命中且无约束，正常非错误）/ 'toolong'（> FIX_PIECE_MAX_CHARS，4096 token 输出地板
// 装不下）/ 'capped'（超出 FIX_MAX_PIECE_CALLS，最大优先、被挤掉的是最小的）。attempts = 应发调用的片段
// 下标、按 core 长度降序（最大优先——konatan：99 字开场不过门、1000 字主体过门 → 恰好一次调用）。可单测。
export function fixPiecePlan(pieces, targets, constraints, minChars) {
    const list = Array.isArray(pieces) ? pieces : [];
    const entries = list.map((p, i) => {
        const core = String((p && p.core) || '');
        if ([...core].length > FIX_PIECE_MAX_CHARS) return { index: i, status: 'toolong' };
        return { index: i, status: fixPreFilter(core, targets, constraints, minChars) ? 'attempt' : 'gated' };
    });
    const byLen = entries.filter((e) => e.status === 'attempt')
        .sort((a, b) => [...String((list[b.index] || {}).core || '')].length - [...String((list[a.index] || {}).core || '')].length);
    for (const e of byLen.slice(FIX_MAX_PIECE_CALLS)) e.status = 'capped';
    return { entries, attempts: byLen.slice(0, FIX_MAX_PIECE_CALLS).map((e) => e.index) };
}

// 纯函数：一轮分段校正的诚实结算（设计 §5）。results 与 pieces 文档顺序对齐（PieceResult）。规则：
// 区分「gated / clean（正常，不惊扰）」与「attempted-but-failed（failed / truncated——如实报第 k 段 + 原因）」；
// capped / toolong 也如实记一行（未校正、非错误）；失败按【正文字数】加权，过半 → majority=true（调用方
// 头条翻 ⚠️ 警告——大面积回退绝不能读成无保留的 ✨已校正）。before/afterJoined 只拼修好的段（prose↔prose
// 干净差异，供「看改动」）。status：有修好且有失败行 'partial' / 全修好 'fixed'（headline 同样如实 N/M）/
// 零修好 'none'（调用方按 failed / nochange 分流）。可单测。
export function fixPieceSummary(pieces, results) {
    const list = Array.isArray(pieces) ? pieces : [];
    const res = Array.isArray(results) ? results : [];
    const why = { failed: '没返回校正稿', truncated: '校正稿被截断' };
    const reasonWhy = { refusal: '模型拒绝', empty: '中转空回复', garbage: '回复异常', error: '调用失败' };
    let fixedCount = 0, attempted = 0, failedProse = 0, totalProse = 0;
    const failLines = [], problems = [], befores = [], afters = [];
    list.forEach((p, i) => {
        const prose = proseCharCount(p && p.core);
        totalProse += prose;
        const r = res[i] || { status: 'gated' };
        if (['fixed', 'clean', 'failed', 'truncated'].includes(r.status)) attempted += 1;
        if (r.status === 'fixed') {
            fixedCount += 1;
            if (r.problems && String(r.problems).trim()) problems.push(`第 ${i + 1} 段：${String(r.problems).trim()}`);
            befores.push(String(r.before || ''));
            afters.push(String(r.after || ''));
        } else if (r.status === 'failed' || r.status === 'truncated') {
            failedProse += prose;
            failLines.push(`第 ${i + 1} 段（原因：${reasonWhy[r.reason] || why[r.status]}）已保留原文`);
        } else if (r.status === 'capped') {
            failLines.push(`第 ${i + 1} 段（超出单轮调用数上限）未校正、已保留原文`);
        } else if (r.status === 'toolong') {
            failLines.push(`第 ${i + 1} 段（这段太长）未校正、已保留原文`);
        }
    });
    const anyFail = res.some((r) => r && (r.status === 'failed' || r.status === 'truncated'));
    return {
        fixedCount, attempted, total: list.length,
        majority: totalProse > 0 && failedProse > 0.5 * totalProse,
        status: fixedCount ? (anyFail || failLines.length ? 'partial' : 'fixed') : 'none',
        headline: `已校正 ${list.length} 段正文中的 ${fixedCount} 段`,
        failLines,
        problems: problems.join('\n'),
        beforeJoined: befores.join('\n\n'),
        afterJoined: afters.join('\n\n'),
    };
}

// ✨「整体校正」（1.18.0，Prince 定案默认开）：把分段表折成【一次】普通调用的原料。夹在正文之间的守卫
// 换成 ⟦SO_KEEP_n⟧ 锚点（1.17.3 已验证：composeFixedReply 按锚点原位还原 + buildFixPrompt 的既有锚点
// 提示 + 弄丢兜底接回不丢内容）；首尾的守卫连片直接进 head/tail 信封——不占锚点、绝不送模型（prince-01
// 类「结构全在首尾」的卡因此是零锚点纯正文单调用）。丢弃区点名的夹缝守卫既不占锚点、还原后也不在
//（thinking 类照旧丢弃）。core 首尾空白挪进 head/tail（compose 会 trim 成品，两端空白必须由信封持有，
// 恒等式才成立：head + core锚点还原 + tail === 原回复）。零 piece / nullish → null（调用方跳过）。可单测。
export function fixJoinTable(table, dropTags) {
    const segs = (table && Array.isArray(table.segments)) ? table.segments : [];
    let first = -1, last = -1;
    segs.forEach((seg, i) => { if (seg.kind === 'piece') { if (first < 0) first = i; last = i; } });
    if (first < 0) return null;
    const dropSet = fixKeepNameSet(dropTags);
    const leadName = (t) => {
        const m = String(t).match(/^\s*(?:<!--|`{3,}|-{3,}|\*{3,}|_{3,}|[<[]\/?\s*([A-Za-z0-9_一-龥-]+))/);
        return (m && m[1]) ? m[1].toLowerCase() : '';
    };
    let head = '', core = '', tail = '';
    const keepBlocks = [];
    segs.forEach((seg, i) => {
        if (i < first) { head += seg.text; return; }
        if (i > last) { tail += seg.text; return; }
        if (seg.kind !== 'guard') { core += seg.text; return; }
        if (dropSet.has(leadName(seg.text))) return;                       // 丢弃区：不占锚点、不还原
        core += fixKeepPlaceholder(keepBlocks.length);
        keepBlocks.push(seg.text);
    });
    const lead = (core.match(/^\s*/) || [''])[0];
    head += lead;
    core = core.slice(lead.length);
    const trail = (core.match(/\s*$/) || [''])[0];
    if (trail) { tail = trail + tail; core = core.slice(0, core.length - trail.length); }
    return { head, core, tail, keepBlocks };
}

// 📋 自定义模板任务「整条」表（spec §5.2）：与 fixJoinTable 输出同构 { head, core, tail, keepBlocks }，落地代码共用。
// 两区皆空 → 不跑任何抠取，core = 原文逐字节（首尾空白挪进 head/tail：head+core+tail === 原文）；任一区非空 → 只跑
// extractExcludedSections（保留 → ⟦SO_KEEP_n⟧ 锚点、丢弃 → 移除；该函数折叠 3+ 空行并 trim，与自动路径排除区一致）。
// 不剥 MVU 块、不认作用域、不做结构识别；raw:true 让 fixJoinCall 跳过 stripMechanismBlocks（opts.raw:false = 沿用识别
// 的「整条」退路：仍剥 MVU、composeFixedReply 接回）。两区同名 → 保留优先（fixDropMinusKeep）。空文本 → null。可单测。
export function fixCustomRawTable(text, keepTags, dropTags, opts) {
    const s = String(text == null ? '' : text);
    if (!s.trim()) return null;
    const keep = String(keepTags || '').trim();
    const drop = fixDropMinusKeep(keepTags, dropTags).trim();
    // 「有没有区」按【解析出来的条目数】判，不按 trim 后的字符串：'###' 一类噪音 trim 后非空、却一条标签
    // 也解析不出，老写法据此白跑一趟 extractExcludedSections（它折叠 3+ 空行并 trim）——「两区皆空 =
    // 逐字节」这条不变量就被一段无效文字破掉了（评审 owed A3）。
    const hasZone = parseExcludeTags(keep).length > 0 || parseExcludeTags(drop).length > 0;
    let core = s, keepBlocks = [];
    if (hasZone) {
        const ex = extractExcludedSections(s, keep, drop);
        core = ex.prose; keepBlocks = ex.keepBlocks;
    }
    const lead = (core.match(/^\s*/) || [''])[0];
    const head = lead;
    core = core.slice(lead.length);
    const trail = (core.match(/\s*$/) || [''])[0];
    let tail = '';
    if (trail) { tail = trail; core = core.slice(0, core.length - trail.length); }
    return { head, core, tail, keepBlocks, raw: !(opts && opts.raw === false) };
}

// 纯函数：作用域校正【判定】——tag 命中则只校正正文（绿），否则会校正整条（红，danger）。
//   命中：fixChars = 内层正文字数；preservedTags = 正文【外】(prefix+suffix) 的顶层标签；
//         keepBlockCount = keepTags 里有几个真出现在内层（用户排除区命中数）。
//   未命中 / 空 tag：danger=true，fixChars=0，preservedTags = 整条回复的顶层标签（提示这些都会被送进模型），keepBlockCount=0。
export function fixScopeVerdict(reply, tag, keepTags) {
    const tagName = parseExcludeTagNames(tag)[0] || '';
    const scope = splitContentScope(reply, tag);
    if (!tagName || !scope || !scope.active) {
        const message = tagName
            ? '⚠ 未找到 <' + tagName + '> → 会校正【整条】回复（含状态栏/选项/世界书）。请检查作用域标签。'
            : '⚠ 未设作用域 → 会校正【整条】回复（含状态栏/选项/世界书）。请检查作用域标签。';
        return { active: false, danger: true, fixChars: 0, preservedTags: listTopLevelTagNames(reply), keepBlockCount: 0, message };
    }
    let keepBlockCount = 0;
    for (const spec of parseExcludeTags(keepTags)) if (tagPresentIn(scope.inner, spec)) keepBlockCount += 1;
    const fixChars = proseCharCount(scope.inner);
    const preservedTags = listTopLevelTagNames(scope.prefix + '\n' + scope.suffix);   // \n 分隔，避免前后缀边界处 token 误粘
    const message = '作用域 <' + tagName + '> ✓ 命中 → 只校正正文 ' + fixChars + ' 字，正文外 ' + preservedTags.length + ' 块原样保留';
    return { active: true, danger: false, fixChars, preservedTags, keepBlockCount, message };
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式「自动配置」Phase 2 —— 配置健全性 PURE 层（无 DOM / 无副作用 / 确定；无时钟无随机）。
 * 给「作用域标签 / 保留区 / 丢弃区 / 校正目标 / 成本门字符数 / 套餐快照」几类常见误配置做纯函数体检。
 * 能自动纠正的就纠正（normalizeScopeInput 清洗单标签输入、clampFixAutoMinChars 钳制范围、
 * filterBundleCfg 剔除不该进套餐快照的键）；纠正不了的用 fixConfigWarnings 给出「码 + 人话 +
 * 定位字段」，delimiterMismatch 额外附 suggest（供后续 UI 阶段一键采纳）。复用 Phase 1 的
 * scanTopLevelBlocks（顶层配平块扫描，含尖 / 方括号）+ 既有 parseExcludeTags（保留/丢弃区解析）
 * + parseExcludeTagNames（标签名清洗字符集），不另起炉灶。这一层只报警，不写入任何设置——
 * 后续 UI / 守卫阶段消费这里的输出。
 * ------------------------------------------------------------------ */

// 纯函数：把「作用域标签」输入框的原始文本归一成【单个】干净标签名。容错：多词（逗号 / 换行 / 空白
// 分隔）只取第一个；剥掉两端的 < [ / > ] 包装；再按标签名字符集（同 parseExcludeTagNames，含中文）
// 截取。没有可用内容 → ''。fixConfigWarnings 用它判「保留/丢弃区误填了正文标签」；也供后续阶段给
// 作用域标签输入框失焦即清洗用。
export function normalizeScopeInput(str) {
    const first = String(str == null ? '' : str).split(/[,\n\s]+/).filter(Boolean)[0] || '';
    const bare = first.replace(/^[<[/＜〈《【［]+/, '').replace(/[/>\]＞〉》】］]+$/, '');   // ✨ 防呆（1.18.0）：IME 全角括号一并剥（红队 T8）
    const m = bare.match(/^[A-Za-z0-9_一-龥-]+/);
    return m ? m[0] : '';
}

// 纯函数：把「成本门字符数」fixAutoMinChars 钳到 [50, 2000] 合理区间（四舍五入取整）。
// 解析不出有限数字（null / undefined / 空串 / 纯空白 / 非数字字符串 / NaN / Infinity）→ 回退
// 字段默认值 200——而不是钳到下限 50。「解析不出数字」= 没配置 / 输入垃圾，该当默认值；跟「用户
// 明明白白填了个 0 或负数」（钳到地板 50）是两回事，不能混为一谈。
export function clampFixAutoMinChars(value) {
    if (value === null || value === undefined) return 200;
    if (typeof value === 'string' && value.trim() === '') return 200;
    const n = Number(value);
    if (!Number.isFinite(n)) return 200;
    return Math.min(2000, Math.max(50, Math.round(n)));
}

// 纯函数：套餐（bundle）快照前过滤 cfg——剔除 fixA_scopeTag（作用域标签是【卡片专属】，换一张
// 卡片套用别人的套餐不该带着别人的标签一起来）、fixA_scopeManual（Phase 5：这个标签是不是当前卡片
// 手填过，同样是【卡片专属】的来源痕迹，换卡也不该带过去——否则新卡会被误当成「用户手填过」，
// 缓存未命中时 resolveFixScope 就只会 suggest 不会自我纠正）与 autoFixEnabled（是否自动校正是
// 【模式开关】，套餐不该替用户悄悄打开后台自动改写）。浅拷贝出新对象，不改 cfg 本身；nullish / 非对象 → {}。
export function filterBundleCfg(cfg) {
    const out = {};
    if (!cfg || typeof cfg !== 'object') return out;
    for (const k of Object.keys(cfg)) {
        if (k === 'fixA_scopeTag' || k === 'fixA_scopeManual' || k === 'autoFixEnabled'
            || k === 'fixA_pieceMode' || k === 'fixA_pieceAsked') continue;   // ✨ 分段校正：正文形态是卡片专属，不进套餐
        out[k] = cfg[k];
    }
    return out;
}

// 纯函数：✨ 校正「自动模式」配置健全性检查——扫一遍常见误配置，给「码 + 人话 + 定位字段」，
// delimiterMismatch 额外带 suggest（纠正后的分隔符形式，供后续 UI 阶段一键采纳）。cfg = 原始
// fixA_* 形状（未经 resolveFixModeCfg 归一）；reply 可空——给了才跑「跨度占比」「分隔符是否真的
// 出现」这两类需要正文的检查，名字撞作用域标签那条不需要 reply。scanTopLevelBlocks(reply) 只扫一次，
// 同喂两类检查。只报警，不写任何东西。
//   scopeInKeep —— 保留 / 丢弃区某项名字 === 归一后的作用域标签（大小写不敏感），或者（给了 reply
//     时）它本身是回复里一个顶层配平块、且跨度 ≥ wrapperRatioMin（回复的大半个身子）——多半是正文
//     外壳本身被错填进了保留 / 丢弃区，而不是真正想排除的一小块。
//   zeroTargetAuto —— 自动校正开着，但 5 个校正目标 + 角色知识边界 / 剧情护栏两条约束全空，跑了
//     也是空转。field 固定为哨兵 'targets'（UI 据此整体置灰运行按钮，不是指某一个目标勾选框）。
//   delimiterMismatch —— 保留 / 丢弃区某项按它填的分隔符（尖 / 方括号）在回复顶层找不到同名块，
//     换个分隔符却有——多半是尖括号方括号打错了，suggest 给纠正后的形式。
export function fixConfigWarnings(cfg, reply) {
    const c = cfg || {};
    const warnings = [];
    const wrapperRatioMin = 0.6;   // 顶层块跨度 / 回复总长 ≥ 此值 → 判定为「正文外壳」而非真正的排除小块
    const targetKeys = ['fixA_targetSlop', 'fixA_targetDialogue', 'fixA_targetPrecision', 'fixA_targetMagic', 'fixA_targetPacing', 'fixA_targetArchaic'];

    const hasReply = reply != null && reply !== '';
    const replyLen = hasReply ? String(reply).length : 0;
    const scopeName = normalizeScopeInput(c.fixA_scopeTag).toLowerCase();
    // 外壳占比检查看【整条回复】的顶层块（rawBlocks，需原始偏移量算跨度）。分隔符检查看的块集合 keepBlocks =
    // 顶层同级块 + 作用域命中时的内层直接子块——后者与运行时 extractExcludedSections 跑在 fixScope.inner 上一致，
    // 故能看见埋在 <gametxt> 里的 [IMG_GEN] 等；前者兼顾正文外壳之外的同级块。只做「名+分隔符」存在性判断，重复无害。
    const rawBlocks = hasReply ? scanTopLevelBlocks(reply) : [];
    const scope = (hasReply && scopeName) ? splitContentScope(reply, scopeName) : null;
    const keepBlocks = (scope && scope.active) ? rawBlocks.concat(scanTopLevelBlocks(scope.inner)) : rawBlocks;

    // 📋 自定义模板任务：两区同名 → 保留优先（spec §6 不变量 7）。只报警不拦，字段名 fixC_ 让 UI 分流到自定义面板的警告盒。
    if (ENABLE_FIX_CUSTOM_TASK) {
        for (const n of fixTagOverlap(c.fixC_keepTags, c.fixC_dropTags)) {
            warnings.push({ code: 'keepDropOverlap', field: 'fixC_keepTags', message: `同一标签「${n}」既在保留区又在丢弃区：按保留处理` });
        }
    }

    // 📋 自定义档自己的两个字段只在旗开着时参与体检——旗关 = 面板根本没渲染，报了也没地方显示，
    // 且警告集必须与 1.76.0 逐条相同（「旗关 = 与上一版全同」的统一语义）。
    const warnFields = ENABLE_FIX_CUSTOM_TASK
        ? ['fixA_keepTags', 'fixA_dropTags', 'fixC_keepTags', 'fixC_dropTags']
        : ['fixA_keepTags', 'fixA_dropTags'];
    for (const field of warnFields) {
        for (const spec of parseExcludeTags(c[field])) {
            const lower = spec.name.toLowerCase();

            const nameHitsScope = !!scopeName && lower === scopeName;
            const isWrapperBlock = hasReply && rawBlocks.some((b) =>
                b.bracket === spec.bracket && b.name.toLowerCase() === lower && (b.end - b.start) / replyLen >= wrapperRatioMin);
            if (nameHitsScope || isWrapperBlock) {
                warnings.push({ code: 'scopeInKeep', field, message: '这个是正文标签，应填到上面『只校正此标签内』，不是保留区' });
                continue;   // 已经因为这条目报过警，不必再查它的分隔符
            }

            if (hasReply) {
                const sameBracketHit = keepBlocks.some((b) => b.bracket === spec.bracket && b.name.toLowerCase() === lower);
                if (!sameBracketHit) {
                    const oppo = keepBlocks.find((b) => b.bracket !== spec.bracket && b.name.toLowerCase() === lower);
                    if (oppo) {
                        const typedForm = spec.bracket ? ('[' + spec.name + ']') : ('<' + spec.name + '>');
                        const actualForm = oppo.bracket ? ('[' + oppo.name + ']') : ('<' + oppo.name + '>');
                        warnings.push({
                            code: 'delimiterMismatch', field,
                            message: '你填的是 ' + typedForm + '，但回复里实际出现的是 ' + actualForm + '——分隔符不匹配，这条保留/丢弃不会生效',
                            suggest: actualForm,
                        });
                    }
                }
            }
        }
    }

    if (c.autoFixEnabled) {
        const noTargets = targetKeys.every((k) => !c[k]);
        const noConstraints = !String(c.fixA_knowledgeBoundary || '').trim() && !String(c.fixA_guardrails || '').trim();
        if (noTargets && noConstraints) {
            warnings.push({ code: 'zeroTargetAuto', field: 'targets', message: '没勾任何校正目标，自动校正不会做事' });
        }
    }

    return warnings;
}

/* ------------------------------------------------------------------ *
 * ✨ 校正模式 Phase 4 —— 「看改动」卡片背后的前后差异引擎。
 * 纯函数，无时钟、无 DOM、确定。replies 很短，O(n·m) DP 足矣。
 * ------------------------------------------------------------------ */

// 纯函数：把文本切成适合做差异的 token。目标：一句中文逐字 diff，但拉丁词整块不被拆成单字母。
// 规则：① CJK 单字（含常见 CJK 标点 / 全角区）各自成一个 token；② ASCII/拉丁【字母+数字】连续串
// 合成一个 token；③ 每段空白（含全角空格交给 CJK 规则）合成一个 token；④ 其余任意单字符（标点 /
// 符号）各自成一个 token。把返回的 token 顺序拼接必须【逐字还原】原文。nullish 安全。
function tokenizeForDiff(text) {
    const s = String(text == null ? '' : text);
    const tokens = [];
    // CJK：统一表意文字 + 扩展 A + 兼容表意 + CJK 符号标点(　-〿) + 全角 / 半角形式(＀-￯)。
    // 单字成 token = 逐字 diff 的关键。
    const isCJK = (cp) =>
        (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs（一-鿿）
        (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Ext-A
        (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compatibility Ideographs
        (cp >= 0x3000 && cp <= 0x303f) ||   // CJK Symbols & Punctuation（　-〿，含。、「」等）
        (cp >= 0xff00 && cp <= 0xffef);     // Halfwidth & Fullwidth Forms（＀-￯，含全角！？，等）
    // 拉丁词字符：ASCII 字母 + 数字（连成一个整词，不逐字母 diff）。
    const isWord = (cp) =>
        (cp >= 0x30 && cp <= 0x39) ||       // 0-9
        (cp >= 0x41 && cp <= 0x5a) ||       // A-Z
        (cp >= 0x61 && cp <= 0x7a);         // a-z
    const isSpace = (ch) => /\s/.test(ch);

    let i = 0;
    while (i < s.length) {
        const cp = s.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        const step = ch.length;             // 代理对占 2 个 UTF-16 单元
        if (isCJK(cp)) {                     // ① CJK 单字成 token
            tokens.push(ch);
            i += step;
        } else if (isWord(cp)) {             // ② 拉丁字母 / 数字串整块
            let j = i;
            while (j < s.length && isWord(s.codePointAt(j))) j += 1;
            tokens.push(s.slice(i, j));
            i = j;
        } else if (isSpace(ch)) {            // ③ 空白串整块
            let j = i;
            while (j < s.length) {
                const c = String.fromCodePoint(s.codePointAt(j));
                if (!isSpace(c)) break;
                j += c.length;
            }
            tokens.push(s.slice(i, j));
            i = j;
        } else {                             // ④ 其余单字符（标点 / 符号 / 非 CJK 表意外字）各自成 token
            tokens.push(ch);
            i += step;
        }
    }
    return tokens;
}

// 纯函数：算出 before→after 的差异段。先各自分词，对两串 token 做最长公共子序列（O(n·m) DP），
// 回溯成 equal/del/ins 段，相邻同型合并，每段把 token 拼回成 text。确定、可复现。
// 一个被替换的跨度【先发 del（before 的 token）后发 ins（after 的 token）】。nullish → 同空串处理。
function diffSegments(before, after) {
    const a = tokenizeForDiff(before);   // before tokens（del 的来源）
    const b = tokenizeForDiff(after);    // after tokens（ins 的来源）
    const n = a.length;
    const m = b.length;

    // LCS DP 表：dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度（从尾部建表，便于正向回溯）。
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            dp[i][j] = a[i] === b[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    // 正向回溯成原始（未合并）操作序列。平手时优先「向下」(del) 再「向右」(ins)，
    // 保证被替换跨度里 del 整体排在 ins 之前。
    const raw = [];   // { type, text }，每个 text 是单个 token
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            raw.push({ type: 'equal', text: a[i] });
            i += 1;
            j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            raw.push({ type: 'del', text: a[i] });
            i += 1;
        } else {
            raw.push({ type: 'ins', text: b[j] });
            j += 1;
        }
    }
    while (i < n) { raw.push({ type: 'del', text: a[i] }); i += 1; }   // before 尾巴 → 全删
    while (j < m) { raw.push({ type: 'ins', text: b[j] }); j += 1; }   // after 尾巴 → 全增

    // 合并相邻同型段，把每段的 token 拼回 text。
    const segments = [];
    for (const op of raw) {
        const last = segments[segments.length - 1];
        if (last && last.type === op.type) last.text += op.text;
        else segments.push({ type: op.type, text: op.text });
    }
    return segments;
}

function diffSummaryText(before, after, segments) {
    let changes = 0;
    let inChange = false;
    for (const seg of segments) {
        if (seg.type === 'equal') {
            inChange = false;
        } else if (!inChange) {
            changes += 1;
            inChange = true;
        }
    }
    if (changes === 0) return '没有改动';

    const beforeChars = Array.from(before).length;
    const afterChars = Array.from(after).length;
    const delta = afterChars - beforeChars;
    const deltaText = delta > 0 ? `+${delta}` : (delta < 0 ? String(delta) : '±0');
    return `改了 ${changes} 处 · ${beforeChars}→${afterChars} 字（${deltaText}）`;
}

// 纯函数：汇总 before→after 的连续改动区间与 Unicode 字符数。相邻 del + ins 同属一个改动区间；
// 字符数按 Unicode code point 统计，代理对组成的 emoji 只算一个字。
export function summarizeDiff(before, after) {
    const beforeText = String(before == null ? '' : before);
    const afterText = String(after == null ? '' : after);
    const segments = diffSegments(beforeText, afterText);
    return diffSummaryText(beforeText, afterText, segments);
}

// 把 diffSegments(before, after) 渲染成一张内联差异卡（<div.pad-diff-card>）：头部显示摘要与图例，
// 正文 equal 段为普通文字、del 段划掉红、ins 段绿并加下划线。所有文本一律走 textContent
//（差异文本不可信，绝不 innerHTML）。返回未挂载的元素，由调用方插入。
export function renderDiffCard(before, after) {
    const beforeText = String(before == null ? '' : before);
    const afterText = String(after == null ? '' : after);
    const segments = diffSegments(beforeText, afterText);

    const card = document.createElement('div');
    card.className = 'pad-diff-card';

    const header = document.createElement('div');
    header.className = 'pad-diff-header';
    const summary = document.createElement('span');
    summary.className = 'pad-diff-summary';
    summary.textContent = diffSummaryText(beforeText, afterText, segments);
    const legend = document.createElement('span');
    legend.className = 'pad-diff-legend';
    const delLegend = document.createElement('span');
    delLegend.className = 'pad-diff-del pad-diff-legend-item';
    delLegend.textContent = '删除';
    const insLegend = document.createElement('span');
    insLegend.className = 'pad-diff-ins pad-diff-legend-item';
    insLegend.textContent = '新增';
    legend.appendChild(delLegend);
    legend.appendChild(insLegend);
    header.appendChild(summary);
    header.appendChild(legend);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pad-diff-body';
    for (const seg of segments) {
        const span = document.createElement('span');
        if (seg.type === 'del') span.className = 'pad-diff-del';
        else if (seg.type === 'ins') span.className = 'pad-diff-ins';
        span.textContent = seg.text;
        body.appendChild(span);
    }
    card.appendChild(body);
    return card;
}

// 把模型丢失的变量块放回原回复中的相对位置。首 / 尾位置是确定的；中间位置优先借原块两侧仍在的
// 文本作锚，锚也被改写时才按原来的正文比例兜底。只在「整条最新回复开放变量文字」路径使用。
function restoreVariableBlockPosition(text, original, originalLocated, block) {
    const source = String(text == null ? '' : text);
    const before = original.slice(0, originalLocated.start);
    const after = original.slice(originalLocated.end);
    if (!before.trim()) return block + (source.trim() ? '\n\n' + source.trimStart() : '');
    if (!after.trim()) return (source.trim() ? source.trimEnd() + '\n\n' : '') + block;

    let position = -1;
    const beforeAnchor = before.trimEnd();
    const afterAnchor = after.trimStart();
    for (let length = Math.min(160, beforeAnchor.length); length >= 8; length -= 1) {
        const anchor = beforeAnchor.slice(-length);
        const at = source.lastIndexOf(anchor);
        if (at !== -1) { position = at + anchor.length; break; }
    }
    if (position < 0) {
        for (let length = Math.min(160, afterAnchor.length); length >= 8; length -= 1) {
            const anchor = afterAnchor.slice(0, length);
            const at = source.indexOf(anchor);
            if (at !== -1) { position = at; break; }
        }
    }
    if (position < 0) {
        const total = before.length + after.length;
        position = total > 0 ? Math.round(source.length * before.length / total) : source.length;
        const leftBreak = source.lastIndexOf('\n', position);
        const rightBreak = source.indexOf('\n', position);
        if (leftBreak >= 0 || rightBreak >= 0) {
            position = rightBreak < 0 || (leftBreak >= 0 && position - leftBreak <= rightBreak - position)
                ? leftBreak + 1
                : rightBreak + 1;
        }
    }
    const left = source.slice(0, position).trimEnd();
    const right = source.slice(position).trimStart();
    return (left ? left + '\n\n' : '') + block + (right ? '\n\n' + right : '');
}

function removeVariableBlocks(text) {
    let source = String(text == null ? '' : text);
    let located = locateVariableBlock(source);
    while (located) {
        source = source.slice(0, located.start) + source.slice(located.end);
        located = locateVariableBlock(source);
    }
    return source;
}

function variableBlockPositionMatches(text, original, originalLocated, rewrittenLocated) {
    const originalBefore = original.slice(0, originalLocated.start).trimEnd();
    const originalAfter = original.slice(originalLocated.end).trimStart();
    const rewrittenBefore = text.slice(0, rewrittenLocated.start).trimEnd();
    const rewrittenAfter = text.slice(rewrittenLocated.end).trimStart();
    if (!originalBefore || !originalAfter) {
        return (!originalBefore) === (!rewrittenBefore) && (!originalAfter) === (!rewrittenAfter);
    }
    const left = originalBefore.slice(-Math.min(80, originalBefore.length));
    const right = originalAfter.slice(0, Math.min(80, originalAfter.length));
    return rewrittenBefore.endsWith(left) || rewrittenAfter.startsWith(right);
}

// 详细版供整条回复路径把「正文成品 + 变量文字变化 + 整块回退」作为一个结果向写回层传递。
// rewriteVariableBlock 未开时严格走 3.1.x 的原样接回逻辑；composeFixedReply 保留原字符串接口。
export function composeFixedReplyDetailed(fixedProse, originalReply, keepBlocks, opts) {
    let out = String(fixedProse || '').trim();
    const orig = String(originalReply || '');
    const blocks = Array.isArray(keepBlocks)
        ? keepBlocks
        : (String(keepBlocks || '').trim() ? [String(keepBlocks).trim()] : []);
    const tail = [];
    blocks.forEach((blk, i) => {
        const b = String(blk == null ? '' : blk);
        const ph = fixKeepPlaceholder(i);
        if (out.includes(ph)) out = out.replace(ph, () => b);
        else if (b && !out.includes(b)) tail.push(b);
    });
    out = stripFixKeepMarks(out);
    if (tail.length) out = out.trimEnd() + '\n\n' + tail.join('\n\n');

    let variableBlock = null;
    const originalLocated = locateVariableBlock(orig);
    if (opts && opts.rewriteVariableBlock && originalLocated) {
        const rewrittenLocated = locateVariableBlock(out);
        const merged = mergeRewrittenVariableBlock(originalLocated.block, out);
        variableBlock = {
            exposed: true,
            fellBack: merged.fellBack,
            reason: merged.reason,
            before: originalLocated.block,
            after: merged.block,
        };
        if (merged.fellBack) {
            out = restoreVariableBlockPosition(removeVariableBlocks(out), orig, originalLocated, merged.block);
        } else if (rewrittenLocated) {
            if (variableBlockPositionMatches(out, orig, originalLocated, rewrittenLocated)) {
                out = out.slice(0, rewrittenLocated.start) + merged.block + out.slice(rewrittenLocated.end);
            } else {
                const without = out.slice(0, rewrittenLocated.start) + out.slice(rewrittenLocated.end);
                out = restoreVariableBlockPosition(without, orig, originalLocated, merged.block);
            }
        } else {
            out = restoreVariableBlockPosition(out, orig, originalLocated, merged.block);
        }
        if (orig.includes(STATUS_PLACEHOLDER) && !out.includes(STATUS_PLACEHOLDER)) out = out.trimEnd() + '\n\n' + STATUS_PLACEHOLDER;
        return { text: out, varTextChanges: merged.changes, variableBlock };
    }

    const block = extractUpdateBlock(orig);
    if (block && !out.includes(block)) out = out.trimEnd() + '\n\n' + block;
    if (orig.includes(STATUS_PLACEHOLDER) && !out.includes(STATUS_PLACEHOLDER)) out = out.trimEnd() + '\n\n' + STATUS_PLACEHOLDER;
    return { text: out, varTextChanges: [], variableBlock };
}

export function composeFixedReply(fixedProse, originalReply, keepBlocks) {
    return composeFixedReplyDetailed(fixedProse, originalReply, keepBlocks).text;
}

// ✨ overlap 版（opt-in fixWaitForMvu）：MVU 额外模型更新在校正【捕获之后】才往回复末尾注入 <UpdateVariable> + 状态栏
// 占位符；校正是并行跑的，composeFixedReply 只接回了【捕获时】的机制块（那时 MVU 还没写）。这里把【当前】回复里的
// 机制块补接到校正稿末尾（已在则不重复），让替换后的回复带上 MVU 刚写好的变量块。MVU 注在整条消息末尾，故末尾追加即对齐。
// 纯函数、幂等、nullish 安全、可单测。
// opts.skipBlock（📋 1.77.0，仅「整条」模板任务传）：成品里【已经】带着一个（被模型改写过的）更新区块——
// 逐字包含判不出来，再补一块就是 MVU 地雷 ②。占位符分支不受影响（那一块补接是幂等的、也不会造成双区块）。
// 校正一族三个调用点都不传 opts ⇒ 逐字节旧行为。
export function mergeMvuTail(fixedText, currentReply, opts) {
    let out = String(fixedText == null ? '' : fixedText);
    const cur = String(currentReply == null ? '' : currentReply);
    const block = (opts && opts.skipBlock) ? '' : extractUpdateBlock(cur);
    if (block && !out.includes(block)) out = out.trimEnd() + '\n\n' + block;
    if (cur.includes(STATUS_PLACEHOLDER) && !out.includes(STATUS_PLACEHOLDER)) out = out.trimEnd() + '\n\n' + STATUS_PLACEHOLDER;
    return out;
}

/* ── 🩺 诊断加固（2026-08-21）Task 2：写入前三道闸的取样 / 判定 / 文案件 ──
 * 只服务 applyFix / autoApplyFix 这一对【唯一的 MVU 写入口】，故与它们同住。
 * 依赖的四个纯件（diagStatKey / diagOpOutcomes 等）住在 Task 1 那一族里，口径只有一份。 */

// 运行时薄封装：当前 MVU 目标楼 + 该楼当前 swipe_id（M1 钉的取样点）。拿不到 → null（宽容：不把
// 「取不到」本身当陈旧证据；两次取样怎么算「动了」交给 diagPinMoved）。
export function diagCaptureSwipe() {
    try {
        const id = mvuLatestMsgId();
        if (id == null) return null;
        const m = ((getCtx() || {}).chat || [])[id];
        return m ? { floor: id, swipe: (m.swipe_id | 0) } : null;
    } catch (e) { return null; }
}

// 纯函数：MvuData 比对口径（同 addMvuedUndoControls 的 F2 漂移守卫）——display_data / delta_data 是 MVU
// **每一轮都会重算**的派生数据（delta_data 更是「本轮变了什么」，值一样也会换内容），比对必须剔除，否则
// 「状态其实没变」也永远判「变了」= 诚实闸形同虚设（stub 的 delta 是冻的，结构上照不出，这行就是它的钉）。
// 其余的键（stat_data、schema、initialized_lorebooks…）都要比：写入是【整份替换】，它们同样会被盖掉。可单测。
export function diagCmpKey(d) {
    const o = Object.assign({}, d || {});
    delete o.display_data; delete o.delta_data;
    return JSON.stringify(o);
}

// 纯判定（Task 5，审计簇 B）：整份 MvuData 的「这条记录之后，世界又动过没有」。
// expect = 这条记录声称「现在应该是」的那一份（未撤销态 = 它写进去的 applied，已撤销态 = 它回退到的
// snapshot）；live = 现读。任一侧取不到 → false：读不到就证不了任何事，绝不新造一种打扰（假阳性一多，
// 用户就学会闭眼点确定，守卫等于没有）。口径恒走 diagCmpKey，全仓只有这一份。可单测。
export function diagUndoDrifted(live, expect) {
    if (!live || !expect) return false;
    return diagCmpKey(live) !== diagCmpKey(expect);
}

// 纯判定（Task 5，审计簇 F）：诊断卡片的【陈旧印章】对不对得上现在的世界。stamp = 出卡时钉在条目上的
// { chatKey, statKey }（跟着侧聊记录落盘，重载后仍在）；liveStatKey / liveChatKey = 现在这一份。
// 印章缺席（老卡片 / 非诊断卡）→ false：这道闸只加警告，绝不因为「没印章」把旧卡片拦死。
// 聊天都换了 = 补丁根本不是这个世界的，直接算漂移（两侧都取得到时才判，缺一侧不猜）。可单测。
export function diagStampDrifted(stamp, liveStatKey, liveChatKey) {
    if (!stamp || !stamp.statKey) return false;
    if (stamp.chatKey != null && liveChatKey != null && stamp.chatKey !== liveChatKey) return true;
    return stamp.statKey !== liveStatKey;
}

// 纯判定：两次取样之间，钉住的目标动了没有。两侧都取不到 → false（那种环境本来就证不了任何事，
// 绝不新造一种失败）；一侧取得到、另一侧取不到 → true（目标出现 / 消失【本身】就是变化）。可单测。
export function diagPinMoved(before, after) {
    if (!before && !after) return false;
    if (!before || !after) return true;
    return before.floor !== after.floor || before.swipe !== after.swipe;
}

// 纯函数：逐 op 对账折成状态行文案（report 为 null = _.set 方言、无 op 可对账，或全部生效 → ''）。
// 'unknown' 的措辞是硬约束，但【分语境】（1.67.0 live 报障的根因就是一张表服务了两个语境）：
//   ctx 缺省 = 【部分生效】语境 —— 确实有 op 写进去了，insert/add 落在【当时不存在】的路径上时我们
//     **真的**判断不了它生效没有，写成「失败」就是对用户撒谎（1.64.0 Task 1 定案，反向钉在
//     diag-hardening-helpers / diag-zero-change-report 两处，别削）。
//   ctx === 'zero' = 【零变化】语境 —— diagCmpKey(新) === diagCmpKey(旧)，我们【有证据】一个字都没写，
//     此时再说「可能已生效」就是自相矛盾。逐条一律说死「未生效」。
// 富文本版（带分类原因 + 下一步）在 diagZeroChangeReport；这里是它取不到补丁 / 状态时的退路。
// 【文案待 Prince 定】可单测。
export function diagReportLines(report, ctx) {
    if (!report || !report.outcomes || report.applied >= report.total) return '';
    const zero = ctx === 'zero';
    const why = {
        'missing-path': '路径不存在（补丁写错了名字，或状态里本来就没有这一项）',
        'noop-equal': '本来就是这个值',
        'unknown': zero ? '这条指令没能对上状态里的任何变化' : '没能从状态变化里判断（可能已生效也可能没有）',
    };
    const bad = report.outcomes.filter((o) => o.result !== 'applied').slice(0, 5)
        .map((o) => `「${o.path}」：${zero ? '未生效 —— ' : ''}${why[o.result] || o.result}`);
    return bad.length ? '\n' + bad.join('\n') : '';
}

// Apply a corrective <UpdateVariable> block through MVU's own pipeline.
// 回 { snapshot, applied, report }：snapshot = 应用【前】深拷贝（撤销靶子）、applied = 应用【后】深拷贝
// （漂移比较锚）、report = diagOpOutcomes 的逐 op 对账（_.set 方言时为 null）。null = 一个字都没写
// （原因已写在 statusEl 上）。成功 / 部分成功的文案【归调用方】——本函数只写失败与中止。
// expectStatKey（可选）= 调用方带来的「这份补丁是按哪份状态算的」指纹，对不上就不写（审计簇 A/F）。
// replyText（可选，1.68.0）= 模型这一轮回复的【原文】。双区块闸要数的是「MVU 会执行几块」，而
// extractUpdateBlock 只摘【最早】那一个包装块 —— 模型甩了两个包装块时，第二块的指令会被静默丢掉。
// 缺席时退化成只数补丁本身（重画出来的旧卡片没有原文，那一档仍挡得住「一个包装块里两个区块」）。
export async function applyFix(patchBlock, statusEl, expectStatKey, replyText) {
    // 双区块闸（1.68.0，Prince 定调：检测 + 拒绝 + 请重掷，绝不替用户合并或挑一块）。必须排在
    // 修复流水线与 parseMessage 【之前】：重复执行的风险在 parseMessage 那一刻就已经发生了。
    const nBlocks = Math.max(diagCountPatchBlocks(patchBlock), diagCountPatchBlocks(replyText));
    if (nBlocks >= 2) {
        statusEl.textContent = diagDoubleBlockNotice(nBlocks);
        statusEl.classList.add('pad-hint-error');
        return null;
    }
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.parseMessage !== 'function') {
        statusEl.textContent = '未检测到 MVU —— 无法自动应用。';
        statusEl.classList.add('pad-hint-error');
        return null;
    }
    const opts = mvuMsgOpts();   // F4：读写共用同一解析结果（消掉 TOCTOU），别在写之前再解析一次
    const oldData = Mvu.getMvuData(opts);
    // 陈旧闸（审计簇 A/F）：补丁是按【诊断当时】的状态算的，现读对不上就不写 —— 说人话，别硬套。
    // ⚠ 取数走 mvuStatOf（与读侧 getMvuStatData 同一份回退口径，FIX 5）：直接写 oldData.stat_data 会在
    // 「没有 stat_data 的退化 MvuData」上与读侧永久失和 → 这道闸恒触发、且给的建议永远无效。
    if (expectStatKey != null && diagStatKey(mvuStatOf(oldData)) !== expectStatKey) {
        statusEl.textContent = '状态已变化（这份补丁是按当时的状态算的），未写入。请重新诊断。';
        statusEl.classList.add('pad-hint-error');
        return null;
    }
    // 修复流水线（1.67.0；含 1.66.1 的开错根掰正 —— 顺序与证据闸见 repairDiagPatch 头注）。必须在交给
    // parseMessage 【之前】跑：mis-rooted 的 insert 一旦让 MVU 建出父链，等它跑完垃圾分支已经在存档里了；
    // 标签空白 / 毒元素那两类更是「跑完就整块没了」。逐 op 对账吃的也是修过的这一份 —— 两边共用同一个
    // 路径空间与同一份动词，绝不能一边看模型原文一边看修好的那份。
    let patch = repairDiagPatch(patchBlock, mvuStatOf(oldData));
    if (patch.fixed) console.warn('[剧情推进] 诊断补丁自动修正：', patch);
    // 🩺 1.89.0 A（同 autoApplyFix）：全被拒 → 一个字不写、说清楚；部分被拒 → 只写能过的，成功文案末尾附原因。
    const sf = diagSchemaFilterPatch(patch.text, oldData);
    if (sf) {
        if (!sf.dry.passOps.length) {
            statusEl.textContent = '这份修复里的每一处都过不了这张卡的规则 —— 未写入。' + diagSchemaDryLines(sf.dry);
            statusEl.classList.add('pad-hint-error');
            if (sf.dry.poisoned) maybeRunSaveHealth('failure');
            return null;
        }
        if (sf.text !== patch.text) patch = Object.assign({}, patch, { text: sf.text });
    }
    const swipePin = diagCaptureSwipe();          // M1 钉：解析【之前】把目标楼 + swipe 记下来
    const snapshot = JSON.parse(JSON.stringify(oldData));
    const newData = await Mvu.parseMessage(patch.text, oldData);
    if (!newData) {
        statusEl.textContent = '补丁未解析出任何改动 —— 请检查指令。';
        statusEl.classList.add('pad-hint-error');
        return null;
    }
    // 诚实闸（审计簇 C）：parseMessage 回了对象 ≠ 有任何值变了。空转绝不报「已应用」、绝不给撤销按钮。
    // ⚠ 两条口径都承重：① 基线用 snapshot（解析【前】的深拷贝）而非 oldData —— MVU 若就地改了 oldData
    // 再回克隆，拿 oldData 当基线会把真实改动误判成空转；② 比对走 diagCmpKey（剔除每轮重算的派生数据）
    // —— 拿整份比，真卡上 delta_data 每轮都换，这道闸就永远不会触发。
    const report = diagOpOutcomes(patch.text, (snapshot || {}).stat_data, newData.stat_data);
    if (diagCmpKey(newData) === diagCmpKey(snapshot)) {
        // 1.67.0：这一支【有证据】—— 一个字都没写。所以逐条一律说死「未生效」+ 分类原因 + 下一步，
        // 「可能已生效」在这里【不可能】出现（那句诚实只属于部分生效语境，见 diagReportLines 头注）。
        // ⚠ 状态取 snapshot（解析【前】的深拷贝）而不是 oldData —— 与上面 diagOpOutcomes 的基线同一份：
        // MVU 的 parseMessage 允许【就地】改 oldData（diag-applyfix 有专门的钉），拿它当基线，预检就会
        // 对着一份已经被动过的状态去判「这条路径存不存在」。取数仍走 mvuStatOf（退化 MvuData 的唯一口径）。
        // schema 第 5 参（1.77.3）：MvuData 自带的那份，用来判「这一层可不可扩展」+ 认出 mvu_zod 卡
        // （它把 schema 设成字符串）。拿不到就是缺席 → 判定与 1.77.2 逐字节相同。
        const zero = diagZeroChangeReport(patch.text, mvuStatOf(snapshot), report, patch, (snapshot || {}).schema);
        statusEl.textContent = (zero.code === 'empty')
            ? '模型认为无需改动（补丁为空）—— 未写入。'
            : diagZeroHeadline(zero.code) + ' —— 未写入。' + repairDiagNote(patch) + zero.text + (sf ? diagSchemaDryLines(sf.dry) : '');
        // 🩺 1.89.0：zod 卡上一次有内容的修复一个值都没变 → 很可能是存档被污染，让存档检查说清是哪一格。
        if (ENABLE_SCHEMA_DIAG && zero.code !== 'empty' && (snapshot || {}).schema === '没有用别管这个') maybeRunSaveHealth('failure');
        return null;
    }
    // 分支钉（审计簇 M1）：解析等待期间换了楼 / 切换回复分支 → 放弃，绝不把 A 分支算的状态写进 B。
    if (diagPinMoved(swipePin, diagCaptureSwipe())) {
        statusEl.textContent = '这条消息在应用期间被切换（楼层或回复分支已变），未写入。请重试。';
        statusEl.classList.add('pad-hint-error');
        return null;
    }
    await Mvu.replaceMvuData(newData, opts);
    refreshLatestMvuBar();   // 应用后刷新楼层状态栏（replaceMvuData 不发刷新事件，否则要手动重载——用户反馈）
    return Object.assign({ snapshot, applied: JSON.parse(JSON.stringify(newData)), report, repair: patch }, sf ? { schemaDry: sf.dry } : {});
}

export async function undoFix(snapshot) {
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.replaceMvuData !== 'function') throw new Error('MVU not available');
    await Mvu.replaceMvuData(snapshot, mvuMsgOpts());
    refreshLatestMvuBar();   // 撤销后同样刷新，免得状态栏停在已应用值
}