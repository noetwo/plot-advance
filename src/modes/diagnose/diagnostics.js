import { saveChatMetadata } from '../../core/chat-metadata.js';
import { getChatMetadataSafe } from '../advisor/metadata.js';
import { appendNoteToRoom } from '../chat/history.js';
import { mvuIsVwdPair, mvuMsgOpts, mvuedPathStr } from './auto.js';
import { openMvuEditor } from './editor.js';
import { detectBareMvuOps, diagDecomposeMove, diagDeltaTargetOk, diagMvuPatchBlocks, diagOpShapeOk, diagPatchOpsOf, diagPathSegs, diagResolvePath, diagSchemaNodeAt, diagTypeMismatch, diagWalkSegs, normalizeDiagPatchPaths, normalizeDiagPatchTags, normalizeForVerify, repairDiagCloseTag, repairDiagJsonWrap } from './patch.js';
import { extractUpdateBlock, getMvu, mvuStatOf } from './mvu.js';
import { diagReportLines } from '../fix/algorithms.js';
import { ENABLE_MVU_EDITOR, ENABLE_SCHEMA_DIAG, MODULE } from '../../prompts/builtins.js';
import { detectMvuBlockDialect } from '../../prompts/helpers.js';
import { P } from '../../prompts/registry.js';
import { nextCid } from '../../core/conversation-store.js';
import { getHostGlobal, getMvuZodSchema } from '../../st/host.js';
import { win } from '../../ui/refs.js';
let soZodReadWarned = false;


/* ── 🩺 1.89.0：schema 感知诊断（spec 2026-09-27-schema-aware-diagnosis-design.md）────────────────
 * mvu_zod 卡把自己的 zod 规则交给酒馆助手 registerVariableSchema(z.object({stat_data}), {type:'message'})，
 * 酒馆助手 4.9.5 只存进内部 pinia store、没有公开 getter。2026-09-27 spike 实证可读的唯一路径见下；
 * 另一条（包装 registerVariableSchema）读不到：卡脚本 iframe 建立时就把 TavernHelper 成员拷走、跨 /newchat 不重建。
 * 【红线】这是酒馆助手的内部结构、随时会变：任何一环缺失 / 抛错 → null，调用方行为与 1.88.0 逐字节相同。 */

function soReadZodSchema(mvuData) {
    const miss = () => {
        if (!soZodReadWarned) {
            soZodReadWarned = true;
            console.warn('[剧情推进] 🩺 这张卡挂了 mvu_zod，但没能从酒馆助手读到它的变量规则（酒馆助手版本变化？）——诊断按原样工作，不做 schema 预检。');
        }
        return null;
    };
    try {
        if (!mvuData) return null;
        // mvu_zod 的指纹：每轮更新结束把 MvuData.schema 设成这个字符串（mvu-facts ⑨）。开局楼还没有指纹（schema 仍是 MVU
        // 原生对象），但卡已经注册了 zod 规则——有注册就用注册的（store 随换角色清空，不会是上一张卡的）。
        const fingerprint = mvuData.schema === '没有用别管这个';
        const soft = () => (fingerprint ? miss() : null);   // 没指纹也没注册 = 普通 / 原生卡 → 静默 null，不 warn
        const sc = getMvuZodSchema();
        if (!sc || typeof sc.safeParse !== 'function') return soft();
        const probe = sc.safeParse({ stat_data: mvuStatOf(mvuData) });
        // 根部就失败 = 形状对不上（别的脚本注册了别的东西）；深处失败 = 存档被污染（B 要的正是这种）→ 仍可用。
        if (probe && probe.success === false) {
            const issues = (probe.error && Array.isArray(probe.error.issues)) ? probe.error.issues : [];
            if (issues.some((i) => !Array.isArray(i.path) || i.path.length <= 1)) return soft();
        }
        return sc;
    } catch (e) {
        return (mvuData && mvuData.schema === '没有用别管这个') ? miss() : null;
    }
}

// 纯函数：按 MVU 命令语义（JSONPatch → set / add / insert / delete，mvu_zod 收到的就是这几种）把一条 op 落到状态副本上。
// 回 { ok, stat }；ok=false = 这条命令在执行器那里就落不了地（delta 打在非数字上 / 父容器不存在等）。不改入参。
// emptyAs = 'arr'：父容器不存在时把【最后一层】建成 [] 而不是 {}（mvu_zod 的 insert：先试 {}、不过再试 []）。
function diagSchemaApplyOp(stat, op, emptyAs) {
    let s;
    try { s = JSON.parse(JSON.stringify(stat == null ? {} : stat)); } catch (e) { return { ok: false, stat }; }
    const segs = diagPathSegs(op && op.path, true);
    const parentOf = (root, sg, lastArr) => {
        let node = root;
        for (let i = 0; i < sg.length; i++) {
            const k = sg[i];
            if (node == null || typeof node !== 'object') return null;
            if (!Object.prototype.hasOwnProperty.call(node, k)) node[k] = (lastArr && i === sg.length - 1) ? [] : {};   // lodash _.set 语义：沿途建对象
            node = node[k];
        }
        return (node && typeof node === 'object') ? node : null;
    };
    const key = segs.length ? segs[segs.length - 1] : '';
    const verb = op && op.op;
    const copyVal = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
    if (verb === 'replace') {
        if (!segs.length) return { ok: true, stat: copyVal(op.value) };
        const parent = parentOf(s, segs.slice(0, -1));
        if (!parent) return { ok: false, stat: s };
        const cur = parent[key];
        parent[key] = (mvuIsVwdPair(cur) && !mvuIsVwdPair(op.value)) ? [copyVal(op.value), cur[1]] : copyVal(op.value);
        return { ok: true, stat: s };
    }
    if (verb === 'delta') {
        const cur = diagWalkSegs(s, segs);
        if (!cur.ok || !segs.length) return { ok: false, stat: s };
        const v = mvuIsVwdPair(cur.value) ? cur.value[0] : cur.value;
        if (typeof v !== 'number' || typeof op.value !== 'number') return { ok: false, stat: s };
        const parent = diagWalkSegs(s, segs.slice(0, -1)).value;
        if (mvuIsVwdPair(cur.value)) parent[key][0] = v + op.value; else parent[key] = v + op.value;
        return { ok: true, stat: s };
    }
    if (verb === 'insert' || verb === 'add') {
        const pw = diagWalkSegs(s, segs.slice(0, -1));
        const parent = (pw.ok && pw.value && typeof pw.value === 'object') ? pw.value : parentOf(s, segs.slice(0, -1), emptyAs === 'arr');
        if (!parent) return { ok: false, stat: s };
        const val = copyVal(op.value);
        if (Array.isArray(parent)) {
            if (key === '-' || key === '') parent.push(val);
            else if (/^\d+$/.test(key)) parent.splice(Number(key), 0, val);
            else return { ok: false, stat: s };
        } else parent[key] = val;
        return { ok: true, stat: s };
    }
    if (verb === 'remove') {
        const pw = diagWalkSegs(s, segs.slice(0, -1));
        if (!segs.length || !pw.ok || !pw.value || typeof pw.value !== 'object') return { ok: false, stat: s };
        if (Array.isArray(pw.value) && /^\d+$/.test(key)) pw.value.splice(Number(key), 1);
        else delete pw.value[key];
        return { ok: true, stat: s };
    }
    return { ok: false, stat: s };
}

// 纯函数：在写入【之前】预演这块补丁会被这张卡怎么处理（spec §4.1）。
//   zod 卡：逐条复刻 mvu_zod —— 落到当前状态副本 → 整棵 safeParse → 过了就用【解析后的输出】推进状态（它就是这么做的）。
//     判定：没过 = zod-rejected（问题落在别处 = blockedByOther，即存档本身不合规）；过了但目标路径没了 = zod-stripped
//     （嵌套固定对象里的新键被悄悄剥掉）；过了但值变了 = zod-altered（transform / 强转，带 detail.to）。
//     mvu_zod 在路径段以 '_' 开头时直接不执行（schema-blocked）；add 打在非数字上报错不执行（delta-target-not-number）。
//   原生 schema 卡：直接复用 diagPreflightOp 的三条 schema 判定，提前说出来（不另写逻辑）。
// safeParse 抛错 → 'unknown'，这条放行（fail-open）；单次超过 200ms → 余下一律 'unknown'（spec §9）。
// 空补丁 / 没有可判依据 → null（调用方照旧走）。不改入参。
const DIAG_SCHEMA_REFUSALS = ['zod-rejected', 'zod-stripped', 'not-extensible', 'delta-target-not-number', 'schema-blocked'];
function diagSchemaDryRun(ops, stat, { zod, nativeSchema } = {}) {
    if (!Array.isArray(ops) || !ops.length) return null;
    const zodOn = !!(zod && typeof zod.safeParse === 'function');
    const nativeOn = !zodOn && !!(nativeSchema && typeof nativeSchema === 'object' && !Array.isArray(nativeSchema));
    if (!zodOn && !nativeOn) return null;
    const strip = (p) => (Array.isArray(p) ? (p[0] === 'stat_data' ? p.slice(1) : p.slice()) : []);
    const pick = (i) => ({ code: i.code, path: strip(i.path), expected: i.expected, values: i.values,
        minimum: i.minimum, maximum: i.maximum, inclusive: i.inclusive, origin: i.origin, errors: i.errors, keys: i.keys, message: i.message });
    // 与键顺序无关的比较（zod 按 shape 重排键不算「改写」——minors M1）。
    const canon = (v) => (Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object')
        ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {}) : v);
    const same = (x, y) => { try { return JSON.stringify(canon(x)) === JSON.stringify(canon(y)); } catch (e) { return false; } };
    let state;
    try { state = JSON.parse(JSON.stringify(stat == null ? {} : stat)); } catch (e) { return null; }
    let poisoned = false;
    let baseIssues = [];   // 写之前存档里【本来就有】的问题：op 撞上它们不算 op 自己的错（minors M2/M3）
    if (zodOn) {
        try {
            const r0 = zod.safeParse({ stat_data: state });
            poisoned = r0.success === false;
            if (poisoned) baseIssues = ((r0.error && r0.error.issues) || []).map(pick);
        } catch (e) { poisoned = false; }
    }
    const issueKey = (i) => i.code + '\u0000' + JSON.stringify((i.path || []).map(String));
    const baseKeys = new Set(baseIssues.map(issueKey));
    let slow = false;
    const items = ops.map((op, index) => {
        const path = (op && typeof op.path === 'string') ? op.path : '';
        const segs = diagPathSegs(path, true);
        const it = { index, op: op && op.op, path, segs, verdict: 'ok', detail: null };
        if (slow) { it.verdict = 'unknown'; return it; }
        if (!zodOn) {
            // 原生 MVU：只认它自己的两条 schema 判定（'_' 段 = schema-blocked 是 mvu_zod 的规矩，不属于原生卡——review 1b）。
            // 判过的 op 照 MVU 落到副本上，后面的 op 才对着「前面那些写完之后」的状态判（review 1d）。
            const v = diagPreflightOp(op, state, nativeSchema).verdict;
            if (v === 'not-extensible' || v === 'delta-target-not-number') { it.verdict = v; return it; }
            const applied = diagSchemaApplyOp(state, op);
            if (applied.ok) state = applied.stat;
            return it;
        }
        // mvu_zod 的 '_' 闸：set / add(delta) / delete 看整条路径，insert 只看【容器】路径（源码 insert 分支 p(s)、s = args[0]）
        // ——新键本身以 _ 开头照样写得进（review 1a）。
        const underSegs = (op && (op.op === 'insert' || op.op === 'add')) ? segs.slice(0, -1) : segs;
        if (underSegs.some((sg) => String(sg).startsWith('_'))) { it.verdict = 'schema-blocked'; return it; }
        if (op && op.op === 'delta') {
            const cur = diagWalkSegs(state, segs);
            const v = cur.ok ? (mvuIsVwdPair(cur.value) ? cur.value[0] : cur.value) : undefined;
            if (typeof v !== 'number') { it.verdict = 'delta-target-not-number'; return it; }
        }
        let applied = diagSchemaApplyOp(state, op);
        if (!applied.ok) return it;   // 执行器层落不了地：不归 schema 管，交给既有预检 / 报告照旧说
        let res;
        const t0 = Date.now();
        try { res = zod.safeParse({ stat_data: applied.stat }); } catch (e) { it.verdict = 'unknown'; return it; }
        if (Date.now() - t0 > 200) slow = true;
        // mvu_zod 的 insert 碰上不存在的父容器：先按 {} 建、过不了再按 [] 建（它的 d || c(g.set(s,[])) 那一步）——照抄，免得误判拒绝。
        if (res && res.success === false && (op.op === 'insert' || op.op === 'add') && !diagWalkSegs(state, segs.slice(0, -1)).ok) {
            const alt = diagSchemaApplyOp(state, op, 'arr');
            if (alt.ok) {
                let res2 = null;
                try { res2 = zod.safeParse({ stat_data: alt.stat }); } catch (e) { res2 = null; }
                if (res2 && res2.success) { applied = alt; res = res2; }
            }
        }
        if (!res || res.success === false) {
            const issues = ((res && res.error && res.error.issues) || []).map(pick);
            const mine = issues.filter((i) => !baseKeys.has(issueKey(i)));
            it.verdict = 'zod-rejected';
            it.detail = { issues: mine.length ? mine : issues, blockedByOther: mine.length === 0, baseline: baseIssues.length ? baseIssues[0].path : null };
            return it;
        }
        const out = (res.data && res.data.stat_data !== undefined) ? res.data.stat_data : applied.stat;
        if (op.op !== 'remove') {
            const got = diagWalkSegs(out, segs);
            const wrote = diagWalkSegs(applied.stat, segs);
            // 往列表里 insert：下标越界时 splice 直接追加（mvu_zod 同样），值不在「写的那个下标」上不代表被剥掉（review 1c）。
            const parentArr = Array.isArray(diagWalkSegs(applied.stat, segs.slice(0, -1)).value);
            const isAppend = (op.op === 'insert' || op.op === 'add') && (segs[segs.length - 1] === '-' || parentArr);
            if (!isAppend && !got.ok) it.verdict = 'zod-stripped';
            else if (!isAppend && wrote.ok && !same(got.value, wrote.value)) { it.verdict = 'zod-altered'; it.detail = { to: got.value }; }
        }
        try { state = JSON.parse(JSON.stringify(out)); } catch (e) { /* 保持旧状态 */ }
        return it;
    });
    // 原生卡：判定只用来【说明】与重写，绝不过滤（review 1e：这条路没有真卡证据；真不合规的 op MVU 自己会跳过，
    // 照写 = 1.88 行为，最坏也不比 1.88 差）。zod 卡才真正只写能过的。
    const passOps = nativeOn ? ops.slice() : ops.filter((_, i) => DIAG_SCHEMA_REFUSALS.indexOf(items[i].verdict) < 0);
    const refused = items.filter((i) => DIAG_SCHEMA_REFUSALS.indexOf(i.verdict) >= 0);
    return { items, passOps, refused, poisoned };
}

// 纯函数：把补丁块里的 JSON 数组整段换成 ops（其余文字逐字节保留）。摘不到 / 解析不动 → 原样返回（不替模型改写）。
function diagPatchWithOps(patchText, ops) {
    const s = String(patchText == null ? '' : patchText);
    const got = diagPatchOpsOf(s);
    if (!got || !Array.isArray(got.ops)) return s;
    const at = s.indexOf(got.inner, got.m.index);
    if (at < 0) return s;
    return s.slice(0, at) + '\n' + JSON.stringify(ops, null, 2) + '\n' + s.slice(at + got.inner.length);
}

// 纯函数：路径 → 玩家看得懂的字段名（与 🎛 变量编辑器同一套标签；数组下标说「第 N 项」）。
function diagFieldLabel(segs) {
    return (Array.isArray(segs) ? segs : []).map((s) => (/^\d+$/.test(String(s)) ? `第 ${Number(s) + 1} 项` : String(s))).join(' › ');
}
const DIAG_TYPE_ZH = { string: '文字', number: '数字', int: '整数', boolean: '开关（是/否）', object: '一组字段', array: '列表', null: '空', date: '日期' };
function diagValShow(v) {
    if (v === null || v === undefined) return '空';
    if (typeof v === 'object') { const j = JSON.stringify(v); return j.length > 60 ? j.slice(0, 57) + '…' : j; }
    return String(v);
}
// 纯函数：一条 zod issue（或原生判定码）→ 不带字段名的短原因（spec §6/§7）。认不出的 code 恒走通用句，绝不漏英文。
function diagSchemaReason(x) {
    if (typeof x === 'string') {
        return {
            'not-extensible': '这一层是卡片没标成可扩展的对象 / 列表，MVU 不允许往里新增项',
            'delta-target-not-number': '这一项现在的值不是数字也不是日期，delta 做不了加减',
            'schema-blocked': '路径里有以下划线开头的层级 —— 卡片的 schema 校验层（mvu_zod）会静默拦掉这种改动',
        }[x] || '没通过这张卡自己的检查（卡片作者没有写原因）';
    }
    const i = x || {};
    if (i.code === 'invalid_type') return '必须是' + (DIAG_TYPE_ZH[i.expected] || '另一种类型');
    if (i.code === 'invalid_value' || i.code === 'invalid_enum_value') return '只能是：' + (i.values || []).map(diagValShow).join('、');
    if (i.code === 'too_small' || i.code === 'too_big') return diagBoundPhrase(i);
    if (i.code === 'invalid_union') { const u = diagUnionPhrase(i); if (u) return u; }
    if (i.code === 'unrecognized_keys') return '这张卡不允许在这里新增项';   // 严格对象（z.strictObject）上的未知键
    if (i.code === 'custom' && i.message && !/^Invalid/i.test(i.message)) return `没通过这张卡自己的检查：「${i.message}」`;
    return '没通过这张卡自己的检查（卡片作者没有写原因）';
}
// 纯函数：上下限的说法——认 inclusive（能不能等于）与 origin（数值 / 文字长度 / 列表项数）（minors M5）。
function diagBoundPhrase(i) {
    const small = i.code === 'too_small';
    const n = small ? i.minimum : i.maximum;
    const excl = i.inclusive === false;
    if (i.origin === 'string') return small ? (excl ? `长度必须多于 ${n} 个字` : `长度不能少于 ${n} 个字`) : (excl ? `长度必须少于 ${n} 个字` : `长度不能超过 ${n} 个字`);
    if (i.origin === 'array' || i.origin === 'set') return small ? (excl ? `必须多于 ${n} 项` : `至少要有 ${n} 项`) : (excl ? `必须少于 ${n} 项` : `最多只能有 ${n} 项`);
    return small ? (excl ? `必须大于 ${n}` : `不能小于 ${n}`) : (excl ? `必须小于 ${n}` : `不能大于 ${n}`);
}
// 纯函数：invalid_union → 「必须是：数字 或 文字」（从各分支的 invalid_type 里收集类型；收不到 → null 走通用句）。
function diagUnionPhrase(i) {
    const kinds = [];
    for (const branch of (Array.isArray(i.errors) ? i.errors : [])) {
        for (const e of (Array.isArray(branch) ? branch : [])) {
            const zh = e && e.code === 'invalid_type' && DIAG_TYPE_ZH[e.expected];
            if (zh && kinds.indexOf(zh) < 0) kinds.push(zh);
        }
    }
    return kinds.length ? '必须是：' + kinds.join(' 或 ') : null;
}
function diagSchemaItemReason(it) {
    if (it.verdict === 'zod-rejected') {
        if (it.detail && it.detail.blockedByOther) {
            return (Array.isArray(it.detail.baseline) && it.detail.baseline.length)
                ? `存档里「${diagFieldLabel(it.detail.baseline)}」已经不合规，这张卡现在拒绝一切更新——先修那一格（见存档检查）`
                : '存档里别处已有不合规的值，这张卡现在拒绝一切更新（见存档检查）';
        }
        const first = it.detail && it.detail.issues && it.detail.issues[0];
        return diagSchemaReason(first || {});
    }
    return diagSchemaReason(it.verdict);
}
// 纯函数：A 的 T1 块（补丁卡 / 自动诊断记录共用）。什么都没有 → ''（调用方拼接后与旧文逐字节相同）。
export function diagSchemaDryLines(dry) {
    const items = (dry && Array.isArray(dry.items)) ? dry.items : [];
    const bad = items.filter((i) => i.verdict === 'zod-rejected' || i.verdict === 'not-extensible'
        || i.verdict === 'delta-target-not-number' || i.verdict === 'schema-blocked' || i.verdict === 'zod-stripped');
    const alt = items.filter((i) => i.verdict === 'zod-altered');
    if (!bad.length && !alt.length) return '';
    const lines = [];
    if (bad.length) lines.push(`⚠ 这份修复里有 ${bad.length} 处这张卡不会接受，应用时会跳过：`);
    for (const it of bad) {
        lines.push(it.verdict === 'zod-stripped'
            ? `· ${diagFieldLabel(it.segs)}：这张卡不允许在这里新增项，写进去也会被悄悄丢掉`
            : `· ${diagFieldLabel(it.segs)}：${diagSchemaItemReason(it)}`);
    }
    for (const it of alt) lines.push(`· ${diagFieldLabel(it.segs)}：会被这张卡改成「${diagValShow(it.detail && it.detail.to)}」`);
    return '\n' + lines.join('\n');
}
// 纯函数：B 的存档检查（spec §5）。zod 缺 / 抛错 → null。深路径在前，至多 20 条。
function diagSaveHealth(zod, stat) {
    if (!zod || typeof zod.safeParse !== 'function') return null;
    let res;
    try { res = zod.safeParse({ stat_data: stat == null ? {} : stat }); } catch (e) { return null; }
    if (!res || res.success !== false) return { ok: true, total: 0, findings: [] };
    const issues = (res.error && Array.isArray(res.error.issues)) ? res.error.issues : [];
    const all = issues.map((i) => {
        const segs = (Array.isArray(i.path) ? i.path : []).filter((p, k) => !(k === 0 && p === 'stat_data'));
        const cur = diagWalkSegs(stat, segs);
        return { segs, code: i.code, now: cur.ok ? cur.value : undefined, expected: i.expected, values: i.values,
            minimum: i.minimum, maximum: i.maximum, inclusive: i.inclusive, origin: i.origin, errors: i.errors, message: i.message, keys: i.keys };
    }).sort((a, b) => b.segs.length - a.segs.length);
    return { ok: false, total: all.length, findings: all.slice(0, 20) };
}
function diagSaveHealthSig(h) {
    if (!h) return '';
    return JSON.stringify((h.findings || []).map((f) => [f.segs, f.code]));
}
// 纯函数：B 的记录正文。spec §7 option a；每条四问：哪一格 / 现在 vs 要求 / 为什么要紧（整条只说一次）/ 怎么修。
function diagSaveHealthText(h, opts) {
    if (!h || h.ok) return '🩺 存档检查通过';
    const one = (f) => {
        const field = diagFieldLabel(f.segs);
        // 缺了一整格：🎛 编辑器不新建字段，这一条不许承诺「去编辑器里改」（review 4）。
        if (f.code === 'invalid_type' && f.now === undefined) return `${field} 在存档里不存在，但这张卡要求它必须有（应是${DIAG_TYPE_ZH[f.expected] || '另一种类型'}）。`;
        if (f.code === 'invalid_type') return `${field} 现在存的是「${diagValShow(f.now)}」，但这张卡规定它必须是${DIAG_TYPE_ZH[f.expected] || '另一种类型'}。`;
        if (f.code === 'invalid_value' || f.code === 'invalid_enum_value') return `${field} 现在是「${diagValShow(f.now)}」，这张卡只接受：${(f.values || []).map(diagValShow).join('、')}。`;
        if (f.code === 'too_small' || f.code === 'too_big') return `${field} 现在是 ${diagValShow(f.now)}，这张卡规定它${diagBoundPhrase(f)}。`;
        if (f.code === 'invalid_union' && diagUnionPhrase(f)) return `${field} 现在是「${diagValShow(f.now)}」，这张卡规定它${diagUnionPhrase(f)}。`;
        if (f.code === 'unrecognized_keys') return `${field} 里有这张卡不允许新增的项：${(f.keys || []).map(diagValShow).join('、')}。`;
        if (f.code === 'custom' && f.message && !/^Invalid/i.test(f.message)) return `${field} 没通过这张卡自己的检查：「${f.message}」`;
        return `${field} 没通过这张卡自己的检查（卡片作者没有写原因）。`;
    };
    const lines = [(opts && opts.stillBroken) ? `🩺 存档检查 —— 还有 ${h.total} 处不合规的值：` : `🩺 存档检查 —— 发现 ${h.total} 处不合规的值：`];
    for (const f of h.findings) lines.push('⚠ ' + one(f));
    if (h.total > h.findings.length) lines.push(`（还有 ${h.total - h.findings.length} 处）`);
    lines.push('因为存档里有不合规的值，这张卡之后的每一次变量更新都会被拒绝（包括讲故事的模型自己写的），所以变量会看起来「怎么都不动」。');
    lines.push(ENABLE_MVU_EDITOR ? '怎么修：在 🎛 变量编辑器里把它改成符合要求的值。' : '怎么修：把它改成符合要求的值。');
    return lines.join('\n');
}
const SAVE_HEALTH_META_KEY = MODULE + '_saveHealth';
// 纯函数：这一次存档检查要不要出声（spec §5）。回 null = 不跑（本聊天已首检过）；否则 { note, toast, recovered, meta }。
// failure 与 first 只在「问题集合变了」时出声（sig 去重）——被污染的存档每回合都会触发 failure，同一件事不许刷屏。
function diagSaveHealthDecide(prev, h, reason) {
    if (!h) return null;
    if (reason === 'first' && prev) return null;
    const meta = { v: 1, ok: !!h.ok, count: h.total | 0, sig: diagSaveHealthSig(h) };
    const changed = !prev || prev.sig !== meta.sig;
    if (reason === 'button') return { note: true, toast: false, recovered: false, meta };
    if (reason === 'recheck') {
        const recovered = !!(prev && prev.ok === false && h.ok);
        // 改完仍不合规：照样说一句（review 4——否则「照着改了、问题还在」没有任何反馈）。
        const stillBroken = !!(prev && prev.ok === false && !h.ok);
        return { note: recovered || stillBroken || (!h.ok && changed), toast: false, recovered, stillBroken, meta };
    }
    return { note: !h.ok && changed, toast: !h.ok && changed, recovered: false, meta };
}

// 纯函数：该不该让模型按原因重写一次（spec §4.3）——只看【op 自己造成】的拒绝；存档污染 / 仅改写 不算。
function diagSchemaRetryWanted(dry) {
    const items = (dry && Array.isArray(dry.items)) ? dry.items : [];
    return items.some((i) => (i.verdict === 'zod-rejected' && !(i.detail && i.detail.blockedByOther))
        || i.verdict === 'not-extensible' || i.verdict === 'delta-target-not-number');
}
// 纯函数：给模型的 T6 重写请求（spec §7 T6；【模型可见】，受真模型电池把关）。末句「完整的新补丁」是必要补充：
// 重写的补丁会【整份替换】第一份，模型若只回改过的那几条，能过的指令就丢了。
function diagSchemaRetryMessage(dry) {
    const items = (dry && Array.isArray(dry.items)) ? dry.items : [];
    const bad = items.filter((i) => (i.verdict === 'zod-rejected' && !(i.detail && i.detail.blockedByOther))
        || i.verdict === 'not-extensible' || i.verdict === 'delta-target-not-number' || i.verdict === 'zod-stripped');
    const lines = [];
    for (const it of bad) {
        const why = it.verdict === 'zod-stripped' ? '这张卡不允许在这里新增项，写进去也会被悄悄丢掉' : diagSchemaItemReason(it);
        lines.push(`· ${it.path}（${it.op}）：${why}`);
    }
    return P('diag.schemaRetry', { count: String(bad.length), items: lines.join('\n') });
}

// 写入口共用：给一块（已过修复流水线的）补丁做预演，回 { text: 只含能过的指令的补丁, dry } 或 null（照旧走）。
// 任何一步抛错 → null（= 1.88 行为），绝不把一次本该照写的诊断变成失败（spec §9；review 5）。
export function diagSchemaFilterPatch(patchText, mvuData) {
    if (!ENABLE_SCHEMA_DIAG) return null;
    try {
        const got = diagPatchOpsOf(patchText);
        if (!got || !Array.isArray(got.ops) || !got.ops.length) return null;
        const zod = soReadZodSchema(mvuData);
        const dry = diagSchemaDryRun(got.ops, mvuStatOf(mvuData), { zod, nativeSchema: mvuData && mvuData.schema });
        if (!dry) return null;
        const text = dry.passOps.length === got.ops.length ? patchText : diagPatchWithOps(patchText, dry.passOps);
        return { text, dry };
    } catch (e) {
        return null;
    }
}

// 该不该让模型重写一次（spec §4.3）；该 → { message, dry }。已重写过 / 设置关 / 没有 op 自己造成的拒绝 → null。
export function diagSchemaRetryPlan(finalText, mvuData, s, alreadyRetried) {
    if (!ENABLE_SCHEMA_DIAG || alreadyRetried || !s || !s.diagSchemaRetry) return null;
    try {
        const block = extractUpdateBlock(String(finalText == null ? '' : finalText));
        if (!block) return null;
        const repaired = repairDiagPatch(block, mvuStatOf(mvuData));
        const sf = diagSchemaFilterPatch(repaired.text, mvuData);
        if (!sf || !diagSchemaRetryWanted(sf.dry)) return null;
        return { message: diagSchemaRetryMessage(sf.dry), dry: sf.dry };
    } catch (e) {
        return null;
    }
}

// 自动诊断的那一次重写（spec §4.3），整轮编排收在一处、可单测（callModel / shouldStop 由调用方注入）。回 { finalText, schemaRetried }。
//   · 重写调用抛错（网络 / 超时）→ 留第一份回复，它能过的那些照写（review 2：不许因为多问一句反而一条都不写）；
//     用户中断 / 新回合 supersede（shouldStop）→ 原样抛出，中断语义与 1.88 相同。
//   · 重写版会【整份替换】第一份：模型要是漏掉了第一份里本来能过的指令（只回改过的那条、或回 []），把漏掉的按路径
//     补回去——路径已在重写版里出现的绝不再补，免得同一处 delta 算两遍（review 3：硬保证放在代码里，不靠提示词）。
export async function diagSchemaRetryRound(finalText, mvuData, s, messages, callModel, shouldStop) {
    const plan = mvuData ? diagSchemaRetryPlan(finalText, mvuData, s, false) : null;
    if (!plan) return { finalText, schemaRetried: null };
    const msgs2 = (Array.isArray(messages) ? messages : []).concat([{ role: 'assistant', content: finalText }, { role: 'user', content: plan.message }]);
    let second = null;
    try { second = await callModel(msgs2); } catch (e) {
        if (shouldStop && shouldStop()) throw e;
        return { finalText, schemaRetried: null };
    }
    const block2 = extractUpdateBlock(String(second == null ? '' : second));
    const got2 = block2 ? diagPatchOpsOf(block2) : null;
    if (!got2 || !Array.isArray(got2.ops)) return { finalText, schemaRetried: null };
    const have = new Set(got2.ops.map((o) => (o && typeof o.path === 'string') ? o.path : ''));
    const missing = plan.dry.passOps.filter((o) => o && typeof o.path === 'string' && !have.has(o.path));
    const merged = missing.length ? diagPatchWithOps(block2, got2.ops.concat(missing)) : block2;
    const text2 = missing.length ? String(second).replace(block2, merged) : String(second);
    return { finalText: text2, schemaRetried: { firstDry: plan.dry, merged: missing.length } };
}

// 纯函数：记录正文 / 推导写回里放哪一块——zod 卡真筛掉了指令时放【实际写入】的那一块（已修复 + 已筛），否则原样
// （原生卡不筛、无 schema 卡没有 schemaDry → 逐字节同 1.88）（minors M8）。
export function diagShownPatch(result, patchBlock) {
    const d = result && result.schemaDry;
    if (d && result.repair && typeof result.repair.text === 'string' && Array.isArray(d.passOps) && Array.isArray(d.items)
        && d.passOps.length < d.items.length) return result.repair.text;
    return patchBlock;
}

// 🩺 B 的唯一触发口：first（本聊天首次见到 zod 卡）/ failure（一次写入零变化或被存档污染挡住）/ button / recheck（🎛 应用后）。
// 全程兜底：检查失败只丢一行 warn，绝不影响诊断本身。
export async function maybeRunSaveHealth(reason) {
    if (!ENABLE_SCHEMA_DIAG) return null;
    try {
        const Mvu = await getMvu();
        if (!Mvu || typeof Mvu.getMvuData !== 'function') {
            if (reason === 'button') appendNoteToRoom('diagnose', { id: nextCid(), role: 'note', content: '🩺 存档检查：没有检测到 MVU 变量框架，无法检查。' });
            return null;
        }
        const data = Mvu.getMvuData(mvuMsgOpts());
        const zod = soReadZodSchema(data);
        if (!zod) {
            if (reason === 'button') appendNoteToRoom('diagnose', { id: nextCid(), role: 'note', content: '🩺 存档检查：这张卡没有可读取的变量规则（不是 mvu_zod 卡，或酒馆助手版本读不到），无需检查。' });
            return null;
        }
        const h = diagSaveHealth(zod, mvuStatOf(data));
        const md = getChatMetadataSafe();
        const d = diagSaveHealthDecide(md ? md[SAVE_HEALTH_META_KEY] : null, h, reason);
        if (!d) return h;
        if (md) { md[SAVE_HEALTH_META_KEY] = Object.assign({ at: Date.now() }, d.meta); saveChatMetadata(); }
        if (d.note) {
            const content = d.recovered ? '🩺 ✓ 存档已恢复正常' : diagSaveHealthText(h, { stillBroken: !!d.stillBroken });
            const info = (!h.ok && !d.recovered)
                ? { health: { findings: h.findings.map((f) => Object.assign({}, f, { focus: diagFocusPathOf(f.segs, mvuStatOf(data)) })), raw: h.findings.map((f) => `${(f.segs || []).join('.')}: ${f.code} ${f.message || ''}`).join('\n') } }
                : undefined;
            appendNoteToRoom('diagnose', { id: nextCid(), role: 'note', content }, info);
        }
        if (d.toast && !(win && win.style.display !== 'none')) {
            try { const toastr = getHostGlobal('toastr'); toastr && toastr.warning && toastr.warning(`剧情推进：这张卡的存档里有 ${h.total} 处不合规的值，变量更新会一直失败。打开诊断看详情。`, '剧情推进 · 存档检查', { timeOut: 8000 }); } catch (e) { /* ignore */ }
        }
        return h;
    } catch (e) {
        console.warn('[剧情推进] 🩺 存档检查失败（不影响诊断）：', e);
        if (reason === 'button') {
            try { appendNoteToRoom('diagnose', { id: nextCid(), role: 'note', content: '🩺 存档检查失败：' + (e && e.message ? e.message : String(e)) }); } catch (e2) { /* ignore */ }
        }
        return null;
    }
}

// 纯函数：zod 的问题路径 → 🎛 编辑器的节点路径。编辑器里列表下标是【数字】（mvuedPathStr 按 JSON 比），
// zod 路径段可能是数字串，全数字段一律转数字，其余原样。
// 纯函数：一处存档问题要求的输入类型（只认 invalid_type 的 数字 / 文字 / 开关），给「打开这一格」时用对的输入框（review 4）。
function diagExpectedEditKind(f) {
    if (!f || f.code !== 'invalid_type') return null;
    return (f.expected === 'number' || f.expected === 'string' || f.expected === 'boolean') ? f.expected : null;
}
// 纯函数：🎛 叶子按覆盖表换成要求的类型（「很累」→ 数字框、null → 可编辑）；类型变了值清空、下拉 / 滑杆失效。无覆盖 → 原对象。
export function mvuedEffectiveLeaf(nd, overrides) {
    const k = (overrides && nd && nd.type === 'leaf') ? overrides[mvuedPathStr(nd.path)] : null;
    if (!k || k === nd.kind) return nd;
    const same = (k === 'number' && typeof nd.value === 'number') || (k === 'string' && typeof nd.value === 'string') || (k === 'boolean' && typeof nd.value === 'boolean');
    return Object.assign({}, nd, { kind: k, value: same ? nd.value : (k === 'boolean' ? false : ''), options: null, range: null, canList: false });
}

// 给了 stat → 只有【列表】里的数字段转数字（记录的键 "1" 仍是字符串——minors M10）；没给 → 旧口径（全数字段转数字）。
function diagFocusPathOf(segs, stat) {
    const list = Array.isArray(segs) ? segs : [];
    if (stat === undefined) return list.map((x) => (/^\d+$/.test(String(x)) ? Number(x) : x));
    let node = stat;
    return list.map((x) => {
        const isArr = Array.isArray(node);
        const seg = (isArr && /^\d+$/.test(String(x))) ? Number(x) : x;
        node = (node && typeof node === 'object') ? node[seg] : undefined;
        return seg;
    });
}

// 存档检查记录下的按钮：每一处一个「在变量编辑器里打开这一格」+ 折叠的技术细节。字段名 / 值来自角色卡 → 只走 textContent。
export function addSaveHealthControls(wrap, info) {
    const list = document.createElement('div');
    list.className = 'pad-apply-bar pad-health-bar';
    if (ENABLE_MVU_EDITOR) {
        for (const f of (info.findings || [])) {
            const row = document.createElement('div');
            const lab = document.createElement('span');
            lab.textContent = diagFieldLabel(f.segs) + ' ';
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'pad-lb-mini';
            b.textContent = '在变量编辑器里打开这一格';
            if (f.now === undefined) continue;   // 缺了的一格在编辑器里没有行可跳（编辑器不新建字段）
            const focusPath = Array.isArray(f.focus) ? f.focus : diagFocusPathOf(f.segs);
            const focusKind = diagExpectedEditKind(f);
            b.addEventListener('click', () => { openMvuEditor({ focusPath, focusKind }); });
            row.appendChild(lab); row.appendChild(b);
            list.appendChild(row);
        }
    }
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = '技术细节（报障时复制这段）';
    const pre = document.createElement('pre');
    pre.textContent = info.raw || '';
    det.appendChild(sum); det.appendChild(pre);
    list.appendChild(det);
    wrap.appendChild(list);
}

// 纯函数：单条 op 的受理判定。verdict 取值（按判定顺序）：
//   poison / unknown-verb / bad-path / missing-path / bad-container / bad-delta / vwd-shape
//   / noop-equal / schema-blocked / not-extensible / delta-target-not-number / type-mismatch
//   / creates / ok
// 拿不到状态 = 没有证据 → 一律停在 'ok'，绝不冤枉补丁。
// schema（可选，1.77.3）= 这张卡的 MvuData.schema。缺席 / 不是普通对象 → 与 1.77.2 逐字节相同。
function diagPreflightOp(op, stat, schema) {
    const path = (typeof op.path === 'string') ? op.path : (typeof op.to === 'string' ? op.to : '');
    const r = { index: 0, op: op.op, path, verdict: 'ok' };
    if (['replace', 'delta', 'insert', 'add', 'remove', 'move'].indexOf(op.op) < 0) { r.verdict = 'unknown-verb'; return r; }
    const segs = diagPathSegs(path, true);
    const fromSegs = (op.op === 'move') ? diagPathSegs(op.from, true) : [];
    const hasStat = !!(stat && typeof stat === 'object');
    // 空段（多写的斜杠）→ MVU 的 _.has 会去找一个【空键名】，恒假。但「恒假」有一个真实的例外：
    // 这张卡的变量里真有一个空串键。所以这一档也走证据闸 —— 查得到就不是这个毛病，照常往下判。
    const empty = (a) => a.some((s) => s === '') && !(hasStat && diagWalkSegs(stat, a).ok);
    if (empty(segs) || empty(fromSegs)) { r.verdict = 'bad-path'; return r; }
    const under = (a) => a.some((s) => String(s).indexOf('_') === 0);
    // 1.68.0：move 的判定【与状态无关】—— 它是【动词】层的事实，所以必须排在「没有状态就不表态」
    // 那道早退【之前】，否则读不到状态时又变回假绿灯。MVU 的执行 switch 里没有 case 'move'
    // （update_variables.ts 760–1324 逐行核过）：翻译层认得它、执行层静默丢弃，一个字都写不进去。
    // 1.67.0 在这里判 'ok'，于是 37/768 格的失败被 residual 文案甩锅给「酒馆助手版本 / mvu_zod」。
    // 修复层通常会先把它拆成 insert+remove（diagDecomposeMove），拆不动才轮到这条判定说话。
    if (op.op === 'move') { r.verdict = 'move-unsupported'; return r; }
    if (!hasStat) return r;                                          // 没有状态 = 没有证据
    // 1.77.3：schema 看得懂才启用下面两条判定（mvu_zod 把它设成字符串 → 恒不启用，见上方红线）
    const schemaOn = !!(schema && typeof schema === 'object' && !Array.isArray(schema));
    if (op.op === 'insert' || op.op === 'add') {
        // ⑦ 判定落点是【父容器】：末段本来就不该存在（数组追加更是 '-'）
        const parent = diagWalkSegs(stat, segs.slice(0, -1));
        if (!parent.ok || !parent.value || typeof parent.value !== 'object') { r.verdict = 'bad-container'; return r; }
        if (under(segs)) { r.verdict = 'schema-blocked'; return r; }
        const key = segs.length ? segs[segs.length - 1] : '';
        if (schemaOn) {
            // MVU 查的是【schema 的 properties】而不是数据里有没有这个键 —— 逐字照抄 case 'insert'
            // 的两道 schema 闸；节点查不到（null）时 MVU 那边同样不做检查，我们也就不表态。
            const node = diagSchemaNodeAt(schema, segs.slice(0, -1));
            if (node && node.type === 'object' && node.extensible === false
                && !Object.prototype.hasOwnProperty.call(node.properties || {}, key)) { r.verdict = 'not-extensible'; return r; }
            if (node && node.type === 'array' && node.extensible !== true) { r.verdict = 'not-extensible'; return r; }
        }
        r.verdict = Object.prototype.hasOwnProperty.call(parent.value, key) ? 'ok' : 'creates';
        return r;
    }
    const cur = diagWalkSegs(stat, segs);
    if (!cur.ok) { r.verdict = 'missing-path'; return r; }           // ⑤⑥ set / add 都先 _.has
    if (op.op === 'remove') { if (under(segs)) r.verdict = 'schema-blocked'; return r; }
    if (op.op === 'delta') {
        if (typeof op.value !== 'number' || !Number.isFinite(op.value)) { r.verdict = 'bad-delta'; return r; }
        if (under(segs)) { r.verdict = 'schema-blocked'; return r; }
        // 1.77.3：现值不是数字 / 日期 → MVU 报 addUnsupportedValue 跳过（我们从前只查 op 自己的增量）
        if (schemaOn && !diagDeltaTargetOk(cur.value)) r.verdict = 'delta-target-not-number';
        return r;
    }
    // replace（= MVU 的 set）
    const isVwd = mvuIsVwdPair(cur.value);
    if (isVwd && mvuIsVwdPair(op.value)) { r.verdict = 'vwd-shape'; return r; }   // ⑤：整对递回去 = NaN
    const curVal = isVwd ? cur.value[0] : cur.value;
    try {
        if (JSON.stringify(normalizeForVerify(curVal)) === JSON.stringify(normalizeForVerify(op.value))) {
            r.verdict = 'noop-equal'; return r;
        }
    } catch (e) { /* 循环结构之类：不表态 */ }
    if (under(segs)) { r.verdict = 'schema-blocked'; return r; }
    if (diagTypeMismatch(curVal, op.value)) r.verdict = 'type-mismatch';
    return r;
}

// 纯函数：模拟 MVU（+ mvu_zod）会不会受理这块补丁。回
// { code, fatal, poison:[下标], total, ops:[{index,op,path,verdict}] }。
// code：ok / no-block / tag-space / parse-uncertain / not-array / poison。
// fatal = MVU 连一条指令都不会执行（整块被丢）。'parse-uncertain' 【有意】不 fatal（见 ②）。可单测。
// schema（可选，1.77.3）原样转交 diagPreflightOp —— 缺席时逐字节等于 1.77.2。
function diagPreflightPatch(patchBlock, stat, schema) {
    const text = String(patchBlock == null ? '' : patchBlock);
    const out = { code: 'no-block', fatal: false, poison: [], total: 0, ops: [] };
    const got = diagPatchOpsOf(text);
    if (!got) return out;
    // 标签空白判定恒走 normalizeDiagPatchTags（唯一那一份、块作用域）：拿全文 .test 会把补丁 value
    // 里原样带着的「<json_patch >」几个字误判成致命 —— 与那个函数里同一条红线。
    if (normalizeDiagPatchTags(text).fixed) { out.code = 'tag-space'; out.fatal = true; return out; }
    if (got.ops === null) { out.code = 'parse-uncertain'; return out; }
    if (!Array.isArray(got.ops)) { out.code = 'not-array'; out.fatal = true; return out; }
    out.ops = got.ops.map((o, i) => {
        if (!diagOpShapeOk(o)) {
            out.poison.push(i);
            return { index: i, op: (o && o.op) || null, path: (o && o.path) || '', verdict: 'poison' };
        }
        const v = diagPreflightOp(o, stat, schema);
        v.index = i;
        return v;
    });
    out.total = out.ops.length;
    if (out.poison.length) { out.code = 'poison'; out.fatal = true; return out; }
    out.code = 'ok';
    return out;
}

/* ── 🩺 1.69.0 D6：自动诊断 甲/乙 闸门【重新配钥】 ──────────────────────────────────────
 * 病灶（2026-08-15 异录战役 + 2026-08-25 弱模型电池 768 格，两份独立证据）：叙述模型每回合吐
 * 一个【死区块】（漏 </JSONPatch> / 标签带空白 / 一颗毒元素 / 全 move / 全部开错根）→ MVU 一条
 * 指令都没执行、卡片状态就此冻住。而旧闸门问的是「这段文字里有没有【包装标签的痕迹】」——
 * 见痕迹就判【甲·核验】，附则还明明白白告诉诊断模型「它【已经生效】了」。诊断模型于是每回合
 * 回 []，永远修不好那个由叙述者亲手造成的冻结。
 * 另有一个【当时正在发生】的双计数洞：无包装的 <JSONPatch>（无下划线）拼法 —— MVU 的块正则写的
 * 是 json_?patch（下划线可有可无）、照常执行，而 detectBareMvuOps 的探针写死了下划线 → 探不到
 * → 旧闸判【乙·推导】→ 同一笔算两遍（1.40.2 那只 bug 的同族入口）。
 * 修法：闸门语义从「有没有痕迹」改成【MVU 这一回合到底执行了没有】，收进下面这一枚纯函数，
 * runAutoDiagnose 只读它 —— 全仓唯一判据。谓词形状 = 研究台架 _gate-matrix.mjs 的 P4（19 形状
 * 矩阵里唯一既不掀翻任何保护钉、又能救回全部事故形状的那一个）。
 */

// 纯函数：这条 op 的判定是不是【单调安全】的「没写成」证据 —— 即拿【块跑完之后】的状态回头看，
// 这个判定也足以反推出「当时必然一个字都没写进去」。诊断时刻能拿到的只有后态（前态可得性实测
// 只有 29%，见台架探针 E4），所以这一条就是敢不敢降级的全部依据。
// 【有意排除，两条红线】
//   · noop-equal —— 那正是【已生效】的签名：一条健康的 replace 落地之后，回头看当前值当然已经
//     等于目标值。按它降级 = 每一个健康回合都被判成「没执行」→ 全量重推 = 1.40.2 那只双计数
//     bug 按回合规模复发。本族最重要的一行，改它之前先去看 diag-gate-rekey.test.mjs 的 P02。
//   · remove 的 missing-path —— 一条【删成功了】的 remove，事后看起来与「这条路径本来就不存在」
//     一模一样，单调性不成立。replace / delta 不建键（MVU 的 set 语义碰到不存在的路径直接跳过），
//     那两个动词上它才是真证据。可单测。
function diagGateOpInert(v) {
    if (!v) return false;
    if (v.verdict === 'move-unsupported') return true;                  // 翻译层认、执行 switch 里没有 case
    if (v.verdict === 'unknown-verb' || v.verdict === 'bad-path' || v.verdict === 'bad-delta') return true;
    if (v.verdict === 'bad-container') return true;                     // 真 MVU 会就地建容器 → 后态还缺 = 当时没跑成
    if (v.verdict === 'missing-path' && (v.op === 'replace' || v.op === 'delta')) return true;
    return false;
}

// 纯函数：【单独一块】MVU 看得见的补丁，算不算「执行了点什么」。算 → 回一个短原因码；
// 不算（= 可证零写入）→ 回 null。可单测。
//   · parse-uncertain 【有意】算作执行：我们的 JSON.parse 未必比 MVU 的解析器严格，没有证据说
//     它没跑成 —— 而误判成「没执行」的代价是把一个已生效的回合重推一遍。永久已知接受项。
//   · total === 0（空数组 []）算作执行：那是叙述者【显式声明】「本回合无变化」，不是「一条都没
//     写成」。少了这道闸，每一个健康的无变化回合都会被重新推导一遍（台架 P3a 就是栽在这里）。
function diagGateBlockReason(blockText, stat) {
    const pf = diagPreflightPatch(blockText, stat);
    if (pf.code === 'parse-uncertain') return 'parse-uncertain';
    if (pf.fatal || pf.code !== 'ok') return null;                      // tag-space / not-array / poison / no-block
    if (!pf.total) return 'empty-patch';
    return pf.ops.every(diagGateOpInert) ? null : 'ops-effective';
}

// 纯函数：MVU 这一回合到底执行了没有？—— 自动诊断三分支的【唯一】判据。
// 回 { executed, reason, deadBlock }：
//   executed=true                    → 甲·核验（状态里已经含这回合的变化，绝不重推）
//   executed=false · deadBlock=false → 乙·推导（正文里根本没有更新，我们代 MVU 推一遍）
//   executed=false · deadBlock=true  → 丙·带死区块推导（1.69.0 新增：块在、但一条都没执行）
// 判定顺序（承重）：
//   ① 裸指令（行首 _.set( / 带下划线的 <json_patch>）—— MVU 按【文本位置】执行，已生效；
//   ② MVU 一块都看不见 —— 有包装标签 / patch 开标签的【痕迹】= 块坏了（丙），什么痕迹都没有 = 乙；
//   ③ 看得见 → 【逐块】判，任意一块算执行就整条判甲（MVU 的 /gim 把所有块都跑，第二块救得回第一块）；
//   ④ 每一块都可证零写入 → 丙。
// 抛错时朝【甲】倒：推导是破坏性分支（写库 + 写回正文），没有证据就绝不启动它。可单测。
export function diagGateProbe(latestReply, stat) {
    const s = String(latestReply == null ? '' : latestReply);
    try {
        if (detectBareMvuOps(s)) return { executed: true, reason: 'bare-ops', deadBlock: false };
        const blocks = diagMvuPatchBlocks(s);
        if (!blocks.length) {
            // 痕迹探测比 MVU 宽得多，【有意】如此：宁可把一段其实无关的标签当成死块（代价 = 文案
            // 说得更保守，仍照常推导），也不要把一个真死块说成「正文里没有区块」。
            const trace = !!detectMvuBlockDialect(s) || /<json_?patch\b/i.test(s);
            return { executed: false, reason: trace ? 'dead-block' : 'none', deadBlock: trace };
        }
        for (const b of blocks) {
            const why = diagGateBlockReason(b, stat);
            if (why) return { executed: true, reason: why, deadBlock: false };
        }
        return { executed: false, reason: 'block-inert', deadBlock: true };
    } catch (e) {
        return { executed: true, reason: 'probe-error', deadBlock: false };
    }
}

// 纯函数：确定性修复流水线 —— 把模型常犯的几种写法掰成 MVU 真的会受理的样子。
// 【流水线顺序】（顺序本身承重，别调）：
//   ① 标签空白（与状态无关，纯文本层，必须最先——不然后面几步改完再回写，空白还在，整块照样隐形）
//   ⑨ 补上缺失的 </JSONPatch>（1.68.0，文本层，紧跟 ①：后面每一步都要 diagPatchOpsOf 先【摘得到块】，
//      而缺闭合标签时它连块都找不到。排在 ① 之后是因为 ① 已经把「标签带空白」那档变成 MVU 看得见的块，
//      于是 ⑨ 的第一道闸 mvuSeesPatchBlock 天生把它让开，两类不会互相踩）
//   ⑩ JSON 容器坏损（1.68.0，文本层，紧跟 ⑨：⑨ 把块补出来之后，才轮得到「块里的 JSON 缺定界符」）
//   ② 开错根（证据闸【逐字节】复用 1.66.1 的 normalizeDiagPatchPaths，绝不另起炉灶；喂给它的是包了
//      合成 <JSONPatch> 外壳的 ops 数组，好让 <json_patch> 拼法的块也享受同一道闸——详见下方注释）
//   ③ 剔除形状不合规的元素（救活整块；后面几步就能在干净数组上跑）
//   ④ 多余斜杠（路径层最后一道；②→④ 的次序让「开错根 + 末尾斜杠」双中那档也能一路掰通）
//   ⑤ 动词同义词（必须在路径修完【之后】：它的证据闸是「这条路径查得到」）
//   ⑥ delta 的数字串
//   ⑦ VWD 整对折成第一格（必须在 ⑤【之后】：set→replace 掰完才轮得到它）
//   ⑧ move → insert + remove（1.68.0，【每条 op 的最后一步】：它的证据闸是「这两条路径现在查得到吗」，
//      所以必须等 ②④ 把路径掰完；它是唯一会把【一条】op 变成【两条】的一步）
// 每一类都【证据闸】：拿不到证据宁可不改。一处没动 → text 逐字节原样返回。绝不抛。可单测。
// 回 { text, fixed, tag, closetag, wrap, rooted, slash, verb, delta, vwd, move, dropped }。
export function repairDiagPatch(patchBlock, stat) {
    const original = String(patchBlock == null ? '' : patchBlock);
    const out = { text: original, fixed: 0, tag: 0, closetag: 0, wrap: 0, rooted: 0, slash: 0, verb: 0, delta: 0, vwd: 0, move: 0, dropped: 0 };
    try {
        const tagged = normalizeDiagPatchTags(out.text);                                  // ①
        out.tag = tagged.fixed; out.text = tagged.text;
        const closed = repairDiagCloseTag(out.text);                                      // ⑨
        out.closetag = closed.fixed; out.text = closed.text;
        const wrapped = repairDiagJsonWrap(out.text);                                     // ⑩
        out.wrap = wrapped.fixed; out.text = wrapped.text;
        const got = diagPatchOpsOf(out.text);
        if (got && Array.isArray(got.ops)) {
            // ② 开错根：口径只有 normalizeDiagPatchPaths 那一份（1.66.1，本批一个字节都不改它）。
            // 它只认 <JSONPatch> 拼法，而 MVU 同样执行 <json_patch> 拼法的块 —— 所以这里把【ops 数组
            // 本身】包进一个合成的 <JSONPatch> 外壳喂给它，再把掰过的数组取回来：证据闸仍是它那三条，
            // 而用户的标签拼法一个字节都不动。（直接拿 out.text 喂它，underscore 拼法就永远享受不到这道闸。）
            let ops = got.ops;
            const shell = normalizeDiagPatchPaths('<JSONPatch>' + JSON.stringify(ops) + '</JSONPatch>', stat);
            out.rooted = shell.fixed;
            if (shell.fixed) {
                try { ops = JSON.parse(/<JSONPatch\s*>([\s\S]*?)<\/JSONPatch\s*>/i.exec(shell.text)[1]); }
                catch (e) { ops = got.ops; out.rooted = 0; }
            }
            const hasStat = !!(stat && typeof stat === 'object');
            // 与 normalizeDiagPatchPaths 的 probe 同款：insert/add 按【父容器】判，其余按整条判。
            // ⚠ 有意【不】先把「含空段」一律判死：这张卡真有一个空串键时，那条路径原样就查得到，
            // 于是闸① 会挡住剥斜杠 —— 正是我们要的（剥了反而改坏）。insert/add 落在带尾斜杠的路径上
            // 时按父容器判恒成立，同样会被闸① 挡住不修：把 /a/b/ 剥成 /a/b 会把「往 a.b 里插一个空键」
            // 变成「往 a 里插 b」，那是另一条指令 —— 宁可不修，交给预检去说。
            const probeOk = (verb, p) => {
                const segs = diagPathSegs(p, true);
                return diagWalkSegs(stat, (verb === 'insert' || verb === 'add') ? segs.slice(0, -1) : segs).ok;
            };
            const slashFix = (verb, p) => {
                if (typeof p !== 'string' || !/\/\/|\/$/.test(p)) return null;             // 没有多余斜杠 → 不是这毛病
                if (probeOk(verb, p)) return null;                                         // 原样就查得到 → 不动
                const stripped = '/' + diagPathSegs(p, false).join('/');
                return (stripped !== p && probeOk(verb, stripped)) ? stripped : null;       // 剥了才查得到，才算有证据
            };
            const next = [];
            for (const op of ops) {
                if (!diagOpShapeOk(op)) { out.dropped++; continue; }                        // ③
                const copy = Object.assign({}, op);
                if (hasStat) {
                    for (const key of ['path', 'from', 'to']) {                             // ④
                        const fixed = slashFix(copy.op, copy[key]);
                        if (fixed != null) { copy[key] = fixed; out.slash++; }
                    }
                    // ⑤ 只掰成 replace，且必须「这条路径现在查得到」。查不到就【不掰】——尤其绝不掰成
                    // insert：那是唯一会往用户存档里造垃圾父链的动词（1.66.1 头注）。
                    if (typeof copy.op === 'string'
                        && ['set', 'update', 'change', 'modify', '修改'].indexOf(copy.op.toLowerCase()) >= 0
                        && probeOk('replace', copy.path)) { copy.op = 'replace'; out.verb++; }
                }
                if (copy.op === 'delta' && typeof copy.value === 'string') {                // ⑥
                    const t = copy.value.trim();
                    if (t !== '' && Number.isFinite(Number(t))) { copy.value = Number(t); out.delta++; }
                }
                if (hasStat && copy.op === 'replace' && mvuIsVwdPair(copy.value)) {         // ⑦
                    const cur = diagResolvePath(stat, copy.path, true);
                    // ⚠ 收窄闸（codex 复核 FINDING c）：现值的【第一格是字符串】时，这个形状是**有歧义**的
                    // ——它可能是 VWD 的 [值,"说明"]，也可能就是一个正正经经的两串列表（["张三","李四"]）。
                    // 折错了 = 把人家第二个元素直接抹掉。本仓对这份歧义早有定案：1.56.0 的「当作列表」开关
                    // 就是因为 [串,串] 分不清、**拒绝替用户自动决定**（数值对才照常按 VWD 覆盖）。这里沿用
                    // 同一条：只有第一格【不是字符串】（数值 / 布尔 = VWD 无歧义）才折；字符串那档交给预检
                    // 出提示，绝不动手。
                    if (cur.ok && mvuIsVwdPair(cur.value) && typeof cur.value[0] !== 'string') {
                        copy.value = copy.value[0]; out.vwd++;
                    }
                }
                // ⑧ move → insert + remove（1.68.0）。MVU 的执行 switch 里没有 case 'move'，翻译层
                // 认得、执行层静默丢弃 —— 全语料 37/768 中招。目标路径按 MVU 翻译层同一条口径取
                // （`op.path ?? op.to`）。证据闸 + 三道保守闸全在 diagDecomposeMove 里，那是唯一那一份。
                if (hasStat && copy.op === 'move') {
                    const two = diagDecomposeMove(copy, (typeof copy.path === 'string') ? copy.path
                        : (typeof copy.to === 'string' ? copy.to : null), stat);
                    if (two) { next.push(two[0], two[1]); out.move++; continue; }
                }
                next.push(copy);
            }
            if (out.rooted || out.dropped || out.slash || out.verb || out.delta || out.vwd || out.move) {
                // got.inner 是从 out.text 上摘下来的，indexOf 必中；真没中就把这一轮的 op 级计数【全部
                // 归零】—— 读数只准报【真写回去了】的修复，宁可少报也绝不虚报（标签那一类在文本层已落地，
                // 不受影响）。
                const at = out.text.indexOf(got.inner, got.m.index);
                if (at >= 0) out.text = out.text.slice(0, at) + '\n' + JSON.stringify(next, null, 2) + '\n' + out.text.slice(at + got.inner.length);
                else { out.rooted = 0; out.dropped = 0; out.slash = 0; out.verb = 0; out.delta = 0; out.vwd = 0; out.move = 0; }
            }
        }
    } catch (e) {
        console.warn('[剧情推进] 诊断补丁修复流水线出错（按未修处理，绝不改写模型原文）：', e);
        return { text: original, fixed: 0, tag: 0, closetag: 0, wrap: 0, rooted: 0, slash: 0, verb: 0, delta: 0, vwd: 0, move: 0, dropped: 0 };
    }
    out.fixed = out.tag + out.closetag + out.wrap + out.rooted + out.slash + out.verb + out.delta + out.vwd + out.move + out.dropped;
    if (!out.fixed) out.text = original;    // 保险绳：一处没动就【逐字节】等于模型原文
    return out;
}

// 纯函数：修复计数折成状态行里的一句短读数（没修 → 空串，不啰嗦）。【文案待 Prince 定】可单测。
export function repairDiagNote(rep) {
    if (!rep || !rep.fixed) return '';
    const parts = [];
    const add = (n, label) => { if (n) parts.push(`${label} ${n} 条`); };
    add(rep.tag, '标签写法');
    add(rep.closetag, '补上缺失的闭合标签');
    add(rep.wrap, '补齐 JSON 的方括号');
    add(rep.rooted, '路径开错根');
    add(rep.slash, '多余的斜杠');
    add(rep.verb, '动词写法');
    add(rep.delta, '增量不是数字');
    add(rep.vwd, '值的形状');
    add(rep.move, '改名/搬家拆成两步');
    add(rep.dropped, '认不出的条目已剔除');
    return `\n（已自动修正补丁里的 ${rep.fixed} 处写法问题：${parts.join('、')}。）`;
}

// 纯函数：零变化语境的【头条】。1.68.0 新增一档 —— 「指令列表根本没读懂」时说「补丁运行了」是
// 一句假话（它压根没跑成）。其余语境逐字不变（1.67.0 的措辞两处共用，绝不许漂成两种说法）。
// 【文案待 Prince 定】可单测。
export function diagZeroHeadline(code) {
    return code === 'malformed'
        ? '补丁格式不完整，没有执行'
        : '补丁运行了，但没有任何值发生变化';
}

// 纯函数：一条回复里有两个（或更多）MVU 更新区块时的说法。Prince 定调：【检测 + 拒绝 + 请重掷】，
// 绝不替用户合并、也绝不挑一块执行 —— MVU 会把它们逐个执行（同一笔可能算两次），而卡片的显示正则
// 是贪婪 + dotall 的，两个区块会让状态栏被整段吞掉（CLAUDE.md 地雷条：1734 张卡实测 123/1734 幸存）。
// 语料 2/768，其中一格两块的 op 完全不同 = 我们只摘第一块 → 另一半指令被静默丢掉。
// 【文案待 Prince 定】可单测。
export function diagDoubleBlockNotice(n) {
    return `这条回复有 ${n} 个更新区块，不安全（重复执行 + 状态栏消失），已跳过未写入。`
        + '下一步：请重新诊断。';
}

// 纯函数：residual（每条 op 按我们的规则都该落地、却一个字都没写）那一段的收尾建议。1.77.3 拆成两版：
// 挂了 mvu_zod 的卡（指纹 = MvuData.schema 被设成字符串 '没有用别管这个'）走 zod 版，其余走原生版。
// 两版共用同一条【真正可照做】的下一步：MVU 的错误通知默认是关的（酒馆助手 → MVU 变量框架面板 → 通知），
// 打开之后 MVU / mvu_zod 自己的 toast 会写明是哪条指令、为什么被拒 —— 我们猜不出来的那部分它知道。
// ⚠ 1.77.2 之前这里写「mvu_zod【整批一起】拒绝」——2026-09-06 逐行核过 mvu_zod 源码，它自 2026-02-07
//   起是【逐条】apply + safeParse、成功的合并进去，所以那句是错话，不许再写回来。
// 【文案待 Prince 否决权】可单测。
function diagResidualAdvice(schema) {
    if (schema === '没有用别管这个') {
        return '这张卡挂了变量结构校验脚本（mvu_zod）：它逐条检查每一个写入，不合规的那条会被悄悄丢掉，'
            + '其余照常。要看真正原因：打开酒馆助手的 MVU 变量框架面板 → 通知 → 勾上「变量初始化/更新出错时通知」，'
            + '再跑一次，弹出的 [MVU zod] 提示会写明是哪条指令、为什么被拒。'
            + '常见原因：① 值超出卡片规定的范围或选项；② 往卡片没定义的位置新增字段（会被静默剥掉）；'
            + '③ 存档里已经有一个不合规的值 —— 那样之后每一条更新都会被拒，包括正文模型自己的，'
            + '得先在🎛 变量编辑器里把那个值改回合规。';
    }
    return '这些指令按我们的检查是合法的（动词、路径、取值都对得上），但 MVU 一条都没执行。'
        + '要看真正原因：打开酒馆助手的 MVU 变量框架面板 → 通知 → 勾上「变量初始化/更新出错时通知」，'
        + '再跑一次，弹出的 [MVU] 提示会写明是哪条指令、为什么被拒（F12 控制台也有）。'
        + '常见原因：① 往卡片没标成可扩展的对象/列表里新增项（MVU 默认不允许）；② 给文字字段做加减；'
        + '③ 酒馆助手 / MVU 版本太旧。';
}

// 纯函数：【零变化】语境专用的逐条诊断。与 diagReportLines 的区别是这里【有证据】——
// diagCmpKey(新) === diagCmpKey(旧)，一个字都没写；所以每一条都必须说死「未生效」，再给分类原因
// 与一个照做得了的下一步。「可能已生效」那句诚实只在【部分生效】语境成立，这里出现就是撒谎。
// 回 { code, text }：
//   classified  逐条都归得了类（含块级致命）
//   residual    有 op 按 MVU 的规则本该写进去 → 问题在环境（酒馆助手版本 / mvu_zod 静默拒绝）
//   all-dropped 毒元素剔完就没指令了（绝不冒充「无需改动」）
//   empty       本来就没有 op（调用方去说「模型认为无需改动」）
//   nodata      判不出（_.set 方言 / 解析不动）→ 退回 diagReportLines 的零变化版
// 【文案待 Prince 定】可单测。
export function diagZeroChangeReport(patchText, stat, report, repair, schema) {
    const pre = diagPreflightPatch(patchText, stat, schema);
    const dropped = (repair && repair.dropped) | 0;
    const blockLine = {
        'poison': `补丁里有 ${pre.poison.length} 条格式不合规的条目 —— MVU 会把整块指令一起丢掉，所以一条都没执行。下一步：请再点一次「诊断」重新生成补丁。`,
        'not-array': '补丁不是一个 JSON 数组 —— MVU 会把整块指令丢掉，所以一条都没执行。下一步：请再点一次「诊断」重新生成补丁。',
        'tag-space': '<JSONPatch> 标签里多了空格 —— MVU 认不出这块，整块指令都没被执行。下一步：请再点一次「诊断」重新生成补丁。',
    }[pre.code];
    if (blockLine) return { code: 'classified', text: '\n' + blockLine };
    // 'no-block' = _.set 方言等，我们【真的】判不出（1.64.0 定案，反向钉在案）→ 退回笼统那一版。
    // 'parse-uncertain' 1.67.0 与它同挤一档 → 一路走到 applyFix 的 'nochange' → 「本回合无需改动」，
    // 而那几条【正确】的指令被静默扔掉（1.68.0 电池语料 2/768，均落在 live 报障的同一型号上）。
    // 修复层的类⑩已经能补齐两种常见的定界符坏损；补不了的那些说实话：读不懂 + 一个字都没写 + 下一步。
    // ⚠ 措辞【不敢】说「MVU 一定也读不懂」：它的 parseString 是宽容三连（YAML → JSON5 → jsonrepair）。
    //   但这一支【有证据】证明状态一个字都没变，所以「没有任何值被写进去」是站得住的。
    if (pre.code === 'no-block') return { code: 'nodata', text: diagReportLines(report, 'zero') };
    if (pre.code === 'parse-uncertain') {
        return { code: 'malformed', text: '\n这份补丁的 JSON 缺了括号之类的东西，没能解析 —— 未写入任何值。'
            + '下一步：请重新诊断。' };
    }
    if (!pre.ops.length) {
        return dropped
            ? { code: 'all-dropped', text: `\n补丁里的 ${dropped} 条指令格式都不合规，已全部剔除 —— 没有一条能执行的指令。下一步：请再点一次「诊断」重新生成补丁。` }
            : { code: 'empty', text: '' };
    }
    const why = {
        'unknown-verb': ['指令动词「%OP%」不是 MVU 认识的写法，这条被直接丢掉了', 'MVU 只认 replace / delta / insert / remove / move —— 请再点一次「诊断」重新生成'],
        'missing-path': ['状态里没有这个路径（replace / remove 碰到不存在的路径只会跳过，不会新建）', '核对一下这个变量名是不是写错了；确实要【新增】的项得用 insert'],
        'bad-container': ['要挂进去的上一层不存在，或那一层不是个集合', '先确认上一层的变量名写对了，再重新诊断一次'],
        'bad-path': ['路径里有空的层级（多写了斜杠）', '请再点一次「诊断」重新生成补丁'],
        'bad-delta': ['delta 的增量不是数字', '请再点一次「诊断」，或改用 replace 直接写最终值'],
        // 措辞有意只描述【形状】、不断言它一定是「值＋说明」对：[串,串] 那种两格结构本身就有歧义
        // （可能是 VWD，也可能就是个两项列表）—— 但不论哪种读法，把整对递回去的后果都一样。
        'vwd-shape': ['这一项是两格结构，补丁却把整对写了回去 —— MVU 只会把整对塞进第一格（变成嵌套），它认的是【第一格那个值】', '把它改成只写第一格该有的那个值，或再点一次「诊断」重新生成'],
        'noop-equal': ['本来就是这个值', '这一条不用管'],
        'type-mismatch': ['写进去的值和现在的值【类型】对不上（卡片若开了 schema 校验，这类写入会被静默拒绝）', '看一眼状态栏里这一项本该是数字还是文字，再重新诊断一次'],
        'schema-blocked': ['路径里有以下划线开头的层级 —— 卡片的 schema 校验层（mvu_zod）会静默拦掉这种改动', '这类内部字段请在🎛 变量编辑器里直接改'],
        'poison': ['这一条的格式不合规', '请再点一次「诊断」重新生成补丁'],
        // 1.68.0：move 的执行器在 MVU 里【根本不存在】（源码级事实，见 diagPreflightOp 那条注释）。
        // 修复层通常已把它拆成 insert+remove；能走到这一行，说明连拆的证据都不够（源路径查不到之类）。
        'move-unsupported': ['这条写的是「搬家」（move），酒馆助手的变量更新引擎不认这个动作，直接跳过了',
            '重新诊断一次，让它拆成「新建 + 删除」两条'],
        // 1.77.3：两条 schema 感知的判定（只在拿得到 MvuData.schema 的原生卡上出现）。
        'not-extensible': ['这一层是卡片没标成可扩展的对象 / 列表，MVU 不允许往里新增项',
            '改用 replace 写已有字段；真要新增，得在卡片的 $meta 里把这一层标成 extensible'],
        'delta-target-not-number': ['这一项现在的值不是数字也不是日期，delta 做不了加减',
            '改用 replace 直接写最终值'],
    };
    const bad = pre.ops.filter((o) => why[o.verdict]);
    const lines = bad.slice(0, 5).map((o) =>
        `「${o.path}」：未生效 —— ${why[o.verdict][0].replace('%OP%', String(o.op))}。下一步：${why[o.verdict][1]}。`);
    const residual = pre.ops.length - bad.length;
    if (residual) {
        // Deliverable A ③：这些 op 按 MVU 自己的规则本该落地，却一个字都没写 —— 死胡同到此为止。
        // 1.77.3：文案整段搬进 diagResidualAdvice（原生 / mvu_zod 两版），指的路从「猜环境」换成
        // 「打开 MVU 自己的错误通知」—— 那条 toast 里写着我们猜不出来的那一半。
        lines.push(diagResidualAdvice(schema));
    }
    return { code: residual ? 'residual' : 'classified', text: lines.length ? '\n' + lines.join('\n') : '' };
}


