import { saveChatMetadata } from '../../core/chat-metadata.js';
import { getCtx } from '../../core/settings.js';
import { MODULE } from '../../prompts/builtins.js';
import { P } from '../../prompts/registry.js';

/* ------------------------------------------------------------------ *
 * 剧情参谋 plan 机制（实验性）。
 *
 * 单一目标方案，存于【当前聊天】的 chatMetadata（随聊天持久化、随聊天切换）。
 * 注入文本永远在注册那一刻从 metadata 现场推导（buildDirective），绝不另存——
 * 因此「清掉 metadata + 重新注册」就能确凿地终止引导，不存在第二份真相。
 * setExtensionPrompt 是全局的，所以切到没有方案的聊天时必须用空串清掉它
 * （applyPlanInjection 对 plan == null 正是这么做的）。
 * ------------------------------------------------------------------ */
export const ADVISOR_PROMPT_KEY = 'story_oracle_plan';
export const ADVISOR_REMIND_AFTER = 20;   // 主聊天走过这么多条消息后，提醒一次方案仍在引导
// 剧情脉络（2.5.0）：当前聊天正在引导主聊天的那一条（单节点方案也是一条只有一个节点的脉络）。
const PATH_META_KEY = MODULE + '_path';
// 2.5.0 之前的单拍方案 / 序列，以及原版的弧线：不再支持，打开聊天时直接丢掉（见 dropLegacyGuides）。
const LEGACY_GUIDE_META_KEYS = [MODULE + '_plan', MODULE + '_seq', MODULE + '_arc'];
// 用户功能请求 —— 都按【当前聊天】持久化，与剧情脉络同风格（随聊天保存、随切换刷新）：
//   _convo   持久化的侧聊问答历史（原本仅在内存里、刷新即丢）
//   _summary 用户粘贴的运行总结 / 前情提要
export const CONVO_META_KEY = MODULE + '_convo';
export const SUMMARY_META_KEY = MODULE + '_summary';
// 用户功能请求：诊断模式「精选世界书条目」按【当前聊天】持久化（与 plan/convo/summary 同风格）。
//   形状：{ use:bool（L1 主开关）, hybrid:bool（L2 混合）, target:''（书目标，''=全部激活）, sel:{ [书名]:uid[] } }
export const DIAG_WI_META_KEY = MODULE + '_diagwi';
// 🌐 世界书范围「自定义」按聊天记忆（1.81.0）：{ books: string[], hybrid: boolean, sel: { [书名]: uid[] } }。
export const WI_CUSTOM_META_KEY = MODULE + '_wisel';
// ✨ 校正模式 Phase 4：把校正配置（目标 / 约束 / 上下文开关 / 自动）按【当前聊天】持久化——每个聊天记住
// 自己的校正设定（chat A 的目标不会渗进 chat B）。形状 = 只存被覆盖的 fix* 键（其余现场回退全局 getSettings 默认）；
// 没有任何覆盖时删键，保持元数据干净（同 setDiagWiMeta 风格）。生效配置经 getEffectiveFixCfg 合并、是校正代码的唯一读取入口。
export const FIX_CFG_META_KEY = MODULE + '_fixcfg';
// 角色工坊：按【当前聊天】持久化的工坊状态（与 plan/arc/convo 同风格——随聊天保存、随切换刷新）。
//   形状：{ brief|null, draft|null, forgedAt|null }（brief/draft 是 parseCharBrief/parseCharDraft 的输出，含 raw）
const BLD_META_KEY = MODULE + '_builder';
// 世界书模式「最近一次应用结果」快照（F4，按【当前聊天】持久化，与 plan/builder 同风格）。
//   形状：{ serial:number, ops:[{ ok, label, reason?, chars? }] }。serial = 书状态版本号（无应用时视为 1，
//   任意一次含 ≥1 成功 op 的应用 +1）；ops = 最近一次应用的逐条结果（只留最近一次、每次覆盖，绝不累积）。
//   世界书快照块（buildLorebookSnapshotBlock）读它显示版本号 + 〔上次应用结果〕。
const LB_APPLY_META_KEY = MODULE + '_lbapply';
// 🎛 变量编辑器「分析取值规则」的扫描结果缓存（ENABLE_MVU_EDITOR，按【当前聊天】持久化）。
//   形状：{ v:1, fields:{ [pathStr]:{ options?:string[], min?:number, max?:number } }, groups:[{ label, paths:[pathStr] }] }
//   pathStr = mvuedPathStr(path)（JSON.stringify 的数组路径）。v 是格式版本闸：不等于 1 一律当没有缓存
//   （宁可让用户重扫一次，也不拿旧形状去喂 buildMvuedModel）。读侧 mvuedReadSchemaCache、写侧 runMvuedScan。
export const MVUED_META_KEY = MODULE + '_mvuedSchema';
// 🎛 变量编辑器「当作列表」的逐字段显示覆盖（ENABLE_MVU_EDITOR，按【当前聊天】持久化）。
//   形状：[pathStr, …]（mvuedPathStr 的 JSON 路径串数组；没有覆盖时【删键】，元数据保持干净）。
//   为什么需要它：全仓的 VWD 判定是纯结构判定（mvuIsVwdPair：恰好两格、第二格是字符串），
//   所以用户真有两项的列表（背包 = ['长剑','皮甲']）会被显示成「数值 + 描述」。判定本身不能改
//   （写入侧 diffMvuStat/applyFix 与之同口径，分歧才会把值写坏）→ 改为让用户逐字段翻正显示。
//   这是【纯显示偏好】：不进模型提示词（mvuedFieldPathList 对两种形状发的是同一条 dot 路径）、
//   不改写入口径（翻正后的编辑走既有列表机制，折成整列表替换）。
//   读侧 mvuedReadListOverrides、写侧 mvuedSetListOverride（编辑器内部才写得到）。
export const MVUED_LIST_META_KEY = MODULE + '_mvuedAsList';
// 🎛 变量修改器的规则表（ENABLE_MVU_TRAINER，按【当前聊天】持久化）。
// 形状：[{path:[...], kind:'freeze'|'step'|'clamp', value?/delta?/min?/max?}]
// 唯一键 =（path, kind）：一个字段最多各有一条 freeze / step / clamp，可以同时存在。
export const MVUED_TRAINER_META_KEY = MODULE + '_mvuedTrainer';

export let guideInjectionText = '';
export let guideInjectionArmed = false;

export function replaceGuideInjection(text) {
    guideInjectionText = text;
    return guideInjectionText;
}

export function armGuideInjection() {
    guideInjectionArmed = true;
}

export function disarmGuideInjection() {
    guideInjectionArmed = false;
}

export function getChatMetadataSafe() {
    try {
        const md = getCtx().chatMetadata;
        return (md && typeof md === 'object') ? md : null;
    } catch (e) { return null; }
}

// 当前聊天的剧情脉络（2.5.0），没有则 null。单节点方案也是一条只有一个节点的脉络。
// 形状：{ title, overall, speed, nodes:[{ id, name, keywords, detail, status }], cursor, nodeStartAt, adoptedAt,
//         reminded, paused? }。status：active / pending / done / skipped；detail 为空 = 还没写。
export function getPath() {
    const md = getChatMetadataSafe();
    const p = md ? md[PATH_META_KEY] : null;
    return (p && typeof p === 'object' && Array.isArray(p.nodes) && p.nodes.length) ? p : null;
}

export function setPath(path) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    if (path) md[PATH_META_KEY] = path;
    else delete md[PATH_META_KEY];
    saveChatMetadata();
    return true;
}

// 2.5.0 之前的单拍方案 / 序列，以及原版的弧线：不再支持，打开聊天时直接丢掉。返回是否丢过。
export function dropLegacyGuides() {
    const md = getChatMetadataSafe();
    if (!md) return false;
    const hit = LEGACY_GUIDE_META_KEYS.filter((k) => k in md);
    for (const k of hit) delete md[k];
    if (hit.length) saveChatMetadata();
    return hit.length > 0;
}

// 角色工坊状态（当前聊天，或 null）。形状：{ brief|null, draft|null, forgedAt|null }。与 getPath/setPath 同族，
// 用 saveChatMetadata()（saveMetadataDebounced 回退的共享封装，与 setConvo/setSummary 同款）持久化。
export function getBuilderState() {
    const md = getChatMetadataSafe();
    const v = md ? md[BLD_META_KEY] : null;
    return (v && typeof v === 'object') ? v : null;
}

export function setBuilderState(st) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    if (st) md[BLD_META_KEY] = st; else delete md[BLD_META_KEY];
    saveChatMetadata();
    return true;
}

// —— F4 世界书「最近一次应用结果」快照（当前聊天，或 null）——
export function getLbApplySnapshot() {
    const md = getChatMetadataSafe();
    const v = md ? md[LB_APPLY_META_KEY] : null;
    return (v && typeof v === 'object') ? v : null;
}
function setLbApplySnapshot(snap) {
    const md = getChatMetadataSafe();
    if (!md) return false;
    if (snap) md[LB_APPLY_META_KEY] = snap; else delete md[LB_APPLY_META_KEY];
    saveChatMetadata();
    return true;
}
// 纯函数：下一个版本号。无应用时基线视为 1；本次应用只要有 ≥1 个成功 op 就 +1（书状态真的变了），
// 全部跳过则版本号不动（书没变、版本不该跳）。可单测。
function nextLbApplySerial(prevSerial, results) {
    const base = (Number.isFinite(prevSerial) && prevSerial >= 1) ? prevSerial : 1;
    const anyOk = Array.isArray(results) && results.some((r) => r && r.ok);
    return anyOk ? base + 1 : base;
}
// 纯函数：把 applyLorebookOps 的逐条结果压成可持久化的紧凑 op（只留展示要用的字段）。可单测。
function compactLbApplyResults(results) {
    return (Array.isArray(results) ? results : []).map((r) => {
        const o = { ok: !!(r && r.ok), label: (r && r.label) || '' };
        if (r && !r.ok && r.reason) o.reason = r.reason;
        if (r && r.ok && r.chars && Number.isFinite(r.chars.from) && Number.isFinite(r.chars.to)) o.chars = { from: r.chars.from, to: r.chars.to };
        return o;
    });
}
// 每次应用后落一份最近结果快照（覆盖式）。返回新版本号。撤销不经此（书回滚由 undoLorebookOps 负责，
// 快照留旧值——下一次真发送会现读回滚后的书正文，〔上次应用结果〕仅作参考）。
export function recordLbApplySnapshot(results) {
    const prev = getLbApplySnapshot();
    const serial = nextLbApplySerial(prev ? prev.serial : 1, results);
    setLbApplySnapshot({ serial, ops: compactLbApplyResults(results) });
    return serial;
}

// 纯函数：草稿常驻卡 / 提示用的标签，按打造目标命名。可单测。
export function draftCardLabel(draft) {
    if (draft.target === 'persona-update') return '角色草稿：当前 Persona';
    if (draft.target === 'persona-new') return '新角色草稿：' + (draft.name || '未命名');
    return 'NPC 条目草稿：' + (draft.name || draft.comment || '未命名');
}

// ✂️ 精简·风格量测（纯函数，可单测）：叙述句长分布——「」台词剔除后，以 。！？ 断句（≥4 字才算句），
// 去空白计字。median>28 或 >50字占比>10% = 风格门点火（spec §4.1；DS/GM 原稿实测本就 terse，
// fortissimo 是 Opus 特有——这道门让 terse 稿根本不进精简调用）。
function condenseNarrStats(content) {
    const n = String(content || '').replace(/「[^」]*」/g, '');
    const lens = (n.match(/[^。！？\n]{4,}?[。！？]/g) || []).map((s) => s.replace(/\s/g, '').length);
    const sorted = [...lens].sort((a, b) => a - b);
    return {
        median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
        over50: lens.length ? +(lens.filter((l) => l > 50).length / lens.length * 100).toFixed(1) : 0,
        sents: lens.length,
    };
}
export function condenseStyleFlagged(content) {
    const s = condenseNarrStats(content);
    return s.median > 28 || s.over50 > 10;
}

// ✂️ 精简·回复解析（纯函数，可单测）：剥成对 <thinking>，认【恰好一个】content 围栏 = G1。
// 多围栏/零围栏都判失败（产品侧 fail-open 回落原稿）；围栏外文字（技术报告等）忽略。
export function parseCondenseReply(reply) {
    const nt = String(reply || '').replace(/\r\n/g, '\n').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    const fences = [...nt.matchAll(/<<<content\n?([\s\S]*?)\n?content>>>/g)];
    if (fences.length !== 1) return { content: null, error: fences.length ? '回复里有多个 content 围栏' : '回复里没有 content 围栏' };
    return { content: fences[0][1].trim(), error: '' };
}

// ✂️ 精简·守卫（纯函数，可单测；spec §4.3，fail-open——任一 fail 产品即回落原稿）。
// 参照实现 = tests/unit/_bld-tuning/condense-v0/_check.mjs + _check-md.mjs（电池校准过的判据，
// 含 2026-07-11 功能件掏空事故加的实体门：画面/衍生 句数地板 + 协议句全文逐字）。
// fails 返回码而非布尔，便于 toast 说人话。
export function condenseGuards(rawContent, outContent) {
    const raw = String(rawContent || ''), out = String(outContent || '');
    const fails = [];
    const headers = (t) => (t.match(/^【[^】\n]+】/gm) || []).sort().join('|');
    if (headers(raw) !== headers(out)) fails.push('headers');                              // G2
    const statusLines = (t) => (t.match(/^〔[^〕\n]*〕\s*$/gm) || []);
    const stIn = statusLines(raw), stOut = statusLines(out);
    if (!(stIn.length === stOut.length && stIn.every((l, i) => l.split('｜').length === (stOut[i] || '').split('｜').length))) fails.push('status');   // G3
    const strip = (t) => t.replace(/\s/g, '').length;
    const ratio = strip(raw) ? strip(out) / strip(raw) : 0;
    if (ratio < 0.55) fails.push('ratio-floor');                                            // G4 下限（防 DS 式过删）
    const mIn = condenseNarrStats(raw).median, mOut = condenseNarrStats(out).median;
    const styleGain = mIn > 0 ? (mIn - mOut) / mIn : 0;
    if (ratio > 0.95 && styleGain < 0.15) fails.push('noop');                               // G4 复合 no-op（风格大改则不算白跑）
    const quotes = (t) => (t.match(/「[^」]*」/g) || []).filter((q) => q.length - 2 >= 6 || /[。！？…]/.test(q));
    const qIn = quotes(raw), qOut = quotes(out), qInSet = new Set(qIn);
    const survived = qIn.filter((q) => qOut.includes(q)).length;
    const added = qOut.filter((q) => !qInSet.has(q)).length;
    if (!(qIn.length === 0 ? added === 0 : survived / qIn.length >= 0.90 && added === 0)) fails.push('quotes');   // G5 台词样引号
    const secsOf = (t) => { const m = {}; for (const p of t.split(/^(?=【[^】\n]+】)/m)) { const h = (p.match(/^【([^】\n]+)】/) || [])[1]; if (h) m[h] = p; } return m; };
    const secIn = secsOf(raw), secOut = secsOf(out);
    if (!Object.keys(secIn).every((k) => !secIn[k].includes('{{user}}') || (secOut[k] || '').includes('{{user}}'))) fails.push('user');   // G6 逐节 {{user}} 在场
    // ---- G7 相对结构（编辑只保全、不修复：输入有的，输出不得少）----
    const decl = (t) => [/性格调色盘：人的性格就像调色盘[\s\S]{0,80}活生生的人/.test(t), /人的性格不是调色盘上一格一格分开的颜色/.test(t)];
    const dIn = decl(raw), dOut = decl(out);
    if ((dIn[0] && !dOut[0]) || (dIn[1] && !dOut[1])) fails.push('decl');
    const counts = (t) => [
        (t.match(/^[^\n]{1,10}衍生[一二三四五六七八九]/gm) || []).length,
        (t.match(/^画面[一二三四五六]/gm) || []).length,
        (t.match(/^关于/gm) || []).length,
        (t.match(/^〔[^〕\n]+〕/gm) || []).length,   // 面孔标签 + 状态行合计（相对比较即可）
    ];
    const cIn = counts(raw), cOut = counts(out);
    if (cIn.some((n, i) => cOut[i] < n)) fails.push('counts');
    const FIVE = ['触发条件', '能量状态', '语料', '身体行为模式', '功能'];
    const faceBlocks = (t) => ((t.split(/^【多副面孔】/m)[1] || '').split(/^【/m)[0]).split(/^(?=〔[^〕\n]+〕)/m).filter((b) => /^〔/.test(b));
    const fIn = faceBlocks(raw), fOut = faceBlocks(out);
    if (fIn.length && !(fOut.length === fIn.length && fOut.every((b) => FIVE.every((k) => b.includes(k + '：') || b.includes(k + ':'))))) fails.push('face5');
    // 功能件实体地板（事故门）：画面 in≥2句→out≥2句；衍生 in≥1→out≥1。标签行同行内容计入本块。
    const unitSentences = (t, labelRe) => {
        const units = []; let cur = null;
        for (const ln of t.split('\n')) {
            const s2 = ln.trim();
            if (labelRe.test(s2)) {
                if (cur !== null) units.push(cur);
                cur = (s2.replace(/^[^\n]{0,10}?(画面[一二三四五六]|衍生[一二三四五六七八九])[：:]?/, '').match(/[。！？]/g) || []).length;
                continue;
            }
            if (cur !== null) {
                if (/^【|^〔.*〕$/.test(s2)) { units.push(cur); cur = null; continue; }
                cur += (s2.match(/[。！？]/g) || []).length;
            }
        }
        if (cur !== null) units.push(cur);
        return units;
    };
    const RE_HM = /^画面[一二三四五六]/, RE_YS = /^[^\n]{1,10}衍生[一二三四五六七八九]/;
    const hmIn = unitSentences(raw, RE_HM), hmOut = unitSentences(out, RE_HM);
    if (hmIn.some((n, i) => n >= 2 && (hmOut[i] ?? 0) < 2)) fails.push('unit-画面');
    const ysIn = unitSentences(raw, RE_YS), ysOut = unitSentences(out, RE_YS);
    if (ysIn.some((n, i) => n >= 1 && (ysOut[i] ?? 0) < 1)) fails.push('unit-衍生');
    // 协议句全文逐字（含尾巴）：输入里能抽出的完整句，输出必须原样包含。
    const proto = (t) => [
        (t.match(/性格调色盘：人的性格就像调色盘[^\n]*活生生的人。/) || [null])[0],
        (t.match(/人的性格不是调色盘上一格一格分开的颜色。[^\n]*(?:\n[^\n【画]*)?(?:颜色在跑。|画面[^\n]*。)/) || [null])[0],
    ];
    if (proto(raw).some((s2) => s2 && !out.includes(s2))) fails.push('protocol');
    return { pass: fails.length === 0, fails, ratio: +ratio.toFixed(2) };
}

// ✂️ 精简·变体语义（纯函数，可单测）：草稿可挂一份精简稿（draft.condensed + activeVariant），
// 【写入】与【DraftPatch 修订】都以「当前激活变体」为准（spec §4.1）。外科修订后两个变体已分叉——
// 只留打过补丁的那份为唯一真相（condensed/activeVariant 移除，卡上切换钮随之消失）。旧草稿无新键 = 恒原稿，零迁移。
export function activeDraftContent(draft) {
    return (draft && draft.activeVariant === 'condensed' && typeof draft.condensed === 'string')
        ? draft.condensed : (draft ? draft.content : '');
}
// 修订上下文块：当前草稿（激活变体）= DraftPatch 锚点的【权威唯一来源】，喂进 buildBuilderPrompt。
// 起因（Prince 2026-07-19，沈星落卡）：buildBuilderPrompt 从不喂当前草稿 → 模型凭对话记忆/用户转述造
// 锚点，与实际存稿的标点字句有出入（体型锚点写「——」但存稿是「。」→ 匹配失败），且打过补丁后对话里
// 的旧稿已过时 → 锚点反复失配、部分改动永不生效。喂【激活变体】= 与 applyDraftPatchOps 匹配的同一串。
// 无草稿（访谈阶段）→ 空串，提示词行为不变。可单测。
export function builderDraftRefBlock(draft) {
    const content = activeDraftContent(draft);
    if (!content || !String(content).trim()) return '';
    return P('bld.draftRef', { draft: content });
}
export function draftWithPatchedActive(draft, patchedText) {
    const d = { ...draft, content: patchedText };
    delete d.condensed;
    delete d.activeVariant;
    return d;
}

// ✂️✂️ 深度精简·分节（纯函数，可单测）：按字符量把按序章节均衡切成三组（每组≈总量/3，最后一组吃尾）。
// 不写死章节名——对任意作者格式成立（condense-v0 泛化轮，谈仲不均衡分组实测 OK）。
export function condenseSplitSections(content) {
    const SECS = String(content || '').split(/^(?=【[^】\n]+】)/m).filter((s) => /^【/.test(s));
    const names = SECS.map((s) => s.match(/^【([^】\n]+)】/)[1]);
    const total = SECS.reduce((n, s) => n + s.length, 0), target = total / 3;
    const groups = [[], [], []];
    let gi = 0, acc = 0;
    SECS.forEach((s, i) => {
        if (gi < 2 && acc >= target * (gi + 1) && groups[gi].length) gi++;
        groups[gi].push(i); acc += s.length;
    });
    return groups.map((idx) => ({ names: idx.map((i) => names[i]), text: idx.map((i) => SECS[i]).join('') }));
}

// ✂️✂️ 深度精简·重组（纯函数，可单测）：三份成稿按序拼接；章节头序列必须与原稿逐一相等，否则整体作废
//（防并行编辑漏节/越权——fail-open 语义的装置侧那一半）。
export function condenseAssemble(parts, rawContent) {
    const joined = parts.map((p) => String(p || '').trim()).join('\n\n');
    const heads = (t) => (String(t).match(/^【[^】\n]+】/gm) || []).join('|');
    if (heads(joined) !== heads(rawContent)) return { content: null, error: '重组后章节头与原稿不一致' };
    return { content: joined, error: '' };
}

// ✂️✂️ 深度精简·手术单解析（纯函数，可单测）：〔删〕/〔缩〕/〔过〕逐行；缩 = 「片段 → 替换短语」。
export function parseCondenseOps(reply) {
    const nt = String(reply || '').replace(/\r\n/g, '\n').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    const ops = [];
    for (const line of nt.split('\n')) {
        const s = line.trim();
        const m = /^〔(删|缩|过)〕\s*(.*)$/.exec(s);
        if (!m) continue;
        if (m[1] === '过') { ops.push({ kind: '过', span: '', repl: '' }); continue; }
        if (m[1] === '缩') {
            const parts = m[2].split(/\s*→\s*/);
            if (parts.length === 2) ops.push({ kind: '缩', span: parts[0].trim(), repl: parts[1].trim() });
            continue;
        }
        ops.push({ kind: '删', span: m[2].trim(), repl: '' });
    }
    return { ops, count: ops.length };
}

// ✂️✂️ 深度精简·手术单执行（纯函数，可单测）：逐刀核验、有禁区自动作废、其余照行（fail-open 到「刀」粒度）。
// 参照实现 = condense-v0/depth/_apply-ops.mjs。veto 五类：①片段须在正文【恰好一次】逐字出现；②保护区
//（「」/【】/〔〕/{{user}}/协议句/功能件标签）；③【功能件禁飞区】——画面/衍生块内一刀不开（2026-07-11
// 掏空事故修复：句数地板只能挡最后一刀、挡不住多刀蚕食，边界必须划在块上；块内精简归分节编辑）；
// ④〔缩〕替换短语只许用原片段里已有的字；⑤刀落后协议句全文仍须在场（事务地板，违者本刀回滚）。
export function applyCondenseOps(content, ops) {
    let text = String(content || '');
    const stats = { applied: 0, vetoed: [] };
    const count = (hay, needle) => hay.split(needle).length - 1;
    const RE_HM = /^画面[一二三四五六]/, RE_YS = /^[^\n]{1,10}衍生[一二三四五六七八九]/;
    const PROTO_HEADS = ['性格调色盘：人的性格就像调色盘', '人的性格不是调色盘上一格一格分开的颜色'];
    const protectedSpan = (s) => /[「」【】〔〕]/.test(s) || s.includes('{{user}}') || PROTO_HEADS.some((p) => s.includes(p.slice(0, 12)))
        || /画面[一二三四五六]|衍生[一二三四五六七八九]/.test(s);
    // 功能件块的字符区间（含标签行到下一章节头/状态行/下一功能件标签为止）
    const unitRanges = (t) => {
        const ranges = []; let start = -1, pos = 0;
        for (const ln of t.split('\n')) {
            const s = ln.trim();
            if (RE_HM.test(s) || RE_YS.test(s)) { if (start >= 0) ranges.push([start, pos]); start = pos; }
            else if (start >= 0 && /^【|^〔.*〕$/.test(s)) { ranges.push([start, pos]); start = -1; }
            pos += ln.length + 1;
        }
        if (start >= 0) ranges.push([start, pos]);
        return ranges;
    };
    const inUnit = (t, span) => { const i = t.indexOf(span); return i >= 0 && unitRanges(t).some(([a, b]) => i >= a && i < b); };
    const PROTO_FULL = [
        (text.match(/性格调色盘：人的性格就像调色盘[^\n]*活生生的人。/) || [null])[0],
        (text.match(/人的性格不是调色盘上一格一格分开的颜色。[^\n]*(?:\n[^\n【画]*)?(?:颜色在跑。|画面[^\n]*。)/) || [null])[0],
    ].filter(Boolean);
    for (const op of ops) {
        if (op.kind === '过') continue;
        const span = op.span;
        if (!span) { stats.vetoed.push({ reason: '空片段', span: '' }); continue; }
        if (protectedSpan(span)) { stats.vetoed.push({ reason: '保护区', span: span.slice(0, 24) }); continue; }
        const n = count(text, span);
        if (n === 0) { stats.vetoed.push({ reason: '未命中', span: span.slice(0, 24) }); continue; }
        if (n > 1) { stats.vetoed.push({ reason: '多处匹配', span: span.slice(0, 24) }); continue; }
        if (inUnit(text, span)) { stats.vetoed.push({ reason: '功能件禁区', span: span.slice(0, 24) }); continue; }
        let tent;
        if (op.kind === '缩') {
            const spanChars = new Set(span);
            if (![...op.repl].every((c) => spanChars.has(c) || /\s/.test(c))) { stats.vetoed.push({ reason: '缩用了新词', span: op.repl.slice(0, 20) }); continue; }
            tent = text.replace(span, op.repl);
        } else {
            tent = text.replace(span, '');
        }
        if (PROTO_FULL.some((p) => !tent.includes(p))) { stats.vetoed.push({ reason: '协议句受损', span: span.slice(0, 24) }); continue; }
        text = tent; stats.applied++;
    }
    // 轻清理：孤立标点与多余空行（与参照实现同款）
    text = text.replace(/，+。/g, '。').replace(/。{2,}/g, '。').replace(/：\s*\n\s*\n/g, '：\n').replace(/\n{3,}/g, '\n\n').replace(/^[ \t]+$/gm, '');
    return { content: text, applied: stats.applied, vetoed: stats.vetoed };
}

// 纯函数：把 NPC 草稿翻译成世界书 op（复用既有 applyLorebookOps 管线）。npc-edit → edit（打到 uid），
// 其余 → create。空的可选字段（comment/key）不进 fields，只有 content 恒在（钉住 draftToLorebookOp 测试）。可单测。
export function draftToLorebookOp(draft, resolvedUid) {
    const fields = {};
    if ((draft.comment || '').trim()) fields.comment = draft.comment.trim();
    if ((draft.key || '').trim()) fields.key = draft.key.trim();
    fields.content = draft.content;
    return {
        action: draft.target === 'npc-edit' ? 'edit' : 'create',
        book: draft.book || '',
        uid: draft.target === 'npc-edit' ? (resolvedUid ?? draft.uid) : null,
        anchor: '', replace: null,
        fields,
    };
}

// 归一条目标题：全角空格折半角、去首尾空白、大小写不敏感（供 resolveEntryUidByTitle 用）。
function bldNormTitle(s) {
    return String(s == null ? '' : s).replace(/　/g, ' ').trim().toLowerCase();
}
// 纯函数：在【已加载】的世界书 data（{entries:{uid:{uid,comment,…}}}）里按条目标题反查 uid。
// 依次尝试：① 精确匹配（comment 与 title 逐字相等）② 归一匹配（trim / 全角空格折半角 / 大小写不敏感）
// ③ 唯一子串包含（title ⊂ comment 或 comment ⊂ title）——包含阶段命中【多于一条】即判为有歧义、宁可返回 null。
// 空标题 / 无匹配 → null。npc-edit 草稿没带 uid 时靠它把标题落到具体条目。可单测。
export function resolveEntryUidByTitle(data, title) {
    const entries = data && data.entries;
    if (!entries || typeof entries !== 'object') return null;
    const rawTitle = String(title == null ? '' : title);
    if (!rawTitle.trim()) return null;
    const list = Object.values(entries).filter((e) => e && typeof e === 'object' && e.uid != null);
    const uidOf = (e) => { const n = Number(e.uid); return Number.isFinite(n) ? n : null; };
    // ① 精确
    for (const e of list) if (String(e.comment == null ? '' : e.comment) === rawTitle) return uidOf(e);
    // ② 归一
    const nt = bldNormTitle(rawTitle);
    if (!nt) return null;
    const norm = list.filter((e) => bldNormTitle(e.comment) === nt);
    if (norm.length) return uidOf(norm[0]);
    // ③ 唯一子串包含（歧义 = 失败保险）
    const contain = list.filter((e) => {
        const nc = bldNormTitle(e.comment);
        return nc && (nc.includes(nt) || nt.includes(nc));
    });
    if (contain.length === 1) return uidOf(contain[0]);
    return null;
}