import { saveChatMetadata } from '../../core/chat-metadata.js';
import { cancelPostReply, refreshLatestMvuBar, refreshMessageBar } from '../../core/post-reply.js';
import { getCtx, getSettings, save, uiConfirm } from '../../core/settings.js';

import { getChatMetadataSafe } from '../advisor/metadata.js';
import { appendNoteToRoom, scrollToBottom } from '../chat/history.js';
import { diagUserFloorNotice, mvuIsVwdPair, mvuMsgOpts, mvuedPathStr } from './auto.js';
import { buildDiagPatchPayload, detectBareMvuOps, diagDecomposeMove, diagDeltaTargetOk, diagMvuPatchBlocks, diagOpShapeOk, diagPatchOpsOf, diagPathSegs, diagResolvePath, diagSchemaNodeAt, diagTypeMismatch, diagWalkSegs, diffMvuStat, insertDiagPatchIntoBlock, normalizeDiagPatchPaths, normalizeDiagPatchTags, normalizeForVerify, openMvuEditor, repairDiagCloseTag, repairDiagJsonWrap, stripDiagPatchFromText, trainerReadRules, trainerSetRule, verifyDiagOps } from './editor.js';
import { addSwipeToMessage, extractUpdateBlock, getMvu, mvuStatOf, stripFixKeepMarks } from './mvu.js';
import { applyFix, diagReportLines, diagUndoDrifted, renderDiffCard, undoFix } from '../fix/algorithms.js';
import { fixScopeNoteText } from '../fix/capture.js';
import { ENABLE_MODE_ROOMS, ENABLE_MVU_EDITOR, ENABLE_MVU_TRAINER, ENABLE_SCHEMA_DIAG, MODULE } from '../../prompts/builtins.js';
import { detectMvuBlockDialect } from '../../prompts/helpers.js';
import { P } from '../../prompts/registry.js';
import { syncChatBarButton, syncQrButton } from '../../ui/chat-entry.js';
import { centeredWindowBox, currentView } from '../../ui/geometry.js';
import { toggleWindow } from '../../ui/mode-shell.js';
import { nextCid } from '../../core/runtime-state.js';
import { setSoZodReadWarned, soZodReadWarned } from './state.js';
import { win } from '../../ui/state.js';

/* ── 🩺 1.89.0：schema 感知诊断（spec 2026-09-27-schema-aware-diagnosis-design.md）────────────────
 * mvu_zod 卡把自己的 zod 规则交给酒馆助手 registerVariableSchema(z.object({stat_data}), {type:'message'})，
 * 酒馆助手 4.9.5 只存进内部 pinia store、没有公开 getter。2026-09-27 spike 实证可读的唯一路径见下；
 * 另一条（包装 registerVariableSchema）读不到：卡脚本 iframe 建立时就把 TavernHelper 成员拷走、跨 /newchat 不重建。
 * 【红线】这是酒馆助手的内部结构、随时会变：任何一环缺失 / 抛错 → null，调用方行为与 1.88.0 逐字节相同。 */

function soReadZodSchema(mvuData) {
    const miss = () => {
        if (!soZodReadWarned) {
            setSoZodReadWarned(true);
            console.warn('[Story Oracle] 🩺 这张卡挂了 mvu_zod，但没能从酒馆助手读到它的变量规则（酒馆助手版本变化？）——诊断按原样工作，不做 schema 预检。');
        }
        return null;
    };
    try {
        if (!mvuData) return null;
        // mvu_zod 的指纹：每轮更新结束把 MvuData.schema 设成这个字符串（mvu-facts ⑨）。开局楼还没有指纹（schema 仍是 MVU
        // 原生对象），但卡已经注册了 zod 规则——有注册就用注册的（store 随换角色清空，不会是上一张卡的）。
        const fingerprint = mvuData.schema === '没有用别管这个';
        const soft = () => (fingerprint ? miss() : null);   // 没指纹也没注册 = 普通 / 原生卡 → 静默 null，不 warn
        const host = document.getElementById('tavern_helper');
        const app = host && host.__vue_app__;
        const gp = app && app.config && app.config.globalProperties;
        const pinia = gp && gp.$pinia;
        const store = (pinia && pinia._s && typeof pinia._s.get === 'function') ? pinia._s.get('variable_schemas') : null;
        let sc = store ? store.message : null;
        if (sc && sc.__v_raw) sc = sc.__v_raw;   // Vue reactive 代理：zod 内部会撞代理不变量而抛，必须取原对象
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
    const overlaps = (a, b) => { const n = Math.min(a.length, b.length); for (let k = 0; k < n; k++) if (String(a[k]) !== String(b[k])) return false; return true; };
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
            try { window.toastr && window.toastr.warning && window.toastr.warning(`剧情推进：这张卡的存档里有 ${h.total} 处不合规的值，变量更新会一直失败。打开诊断看详情。`, '剧情推进 · 存档检查', { timeOut: 8000 }); } catch (e) { /* ignore */ }
        }
        return h;
    } catch (e) {
        console.warn('[Story Oracle] 🩺 存档检查失败（不影响诊断）：', e);
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
    list.className = 'so-apply-bar so-health-bar';
    if (ENABLE_MVU_EDITOR) {
        for (const f of (info.findings || [])) {
            const row = document.createElement('div');
            const lab = document.createElement('span');
            lab.textContent = diagFieldLabel(f.segs) + ' ';
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'so-lb-mini';
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
        console.warn('[Story Oracle] 诊断补丁修复流水线出错（按未修处理，绝不改写模型原文）：', e);
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
            console.warn('[Story Oracle] 诊断修正未写进正文：补丁自检没能精确重放出当前状态（这张卡的变量形状特殊），已跳过；变量修正照常生效。');
            return [];
        }
        return ops;
    } catch (e) {
        console.warn('[Story Oracle] 诊断修正折算绝对值补丁失败：', e);
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
        console.warn('[Story Oracle] 诊断修正未写进正文：这条回复在诊断期间被改动过（已跳过，变量修正照常生效）。');
        return '';
    }
    const payload = buildDiagPatchPayload(ops);
    if (!payload) return '';
    const next = insertDiagPatchIntoBlock(stripDiagPatchFromText(m.mes), payload);
    if (next == null) {
        console.warn('[Story Oracle] 诊断修正未写进正文：这条回复的更新区块没有完整的闭标签（不另起一块——两个区块会让多数卡的状态栏被折叠面板吞掉）。');
        return '';
    }
    m.mes = next;
    if (Array.isArray(m.swipes) && typeof m.swipes[m.swipe_id] === 'string') m.swipes[m.swipe_id] = m.mes;
    try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
    catch (e) { console.warn('[Story Oracle] 诊断修正写进正文后保存失败：', e); }
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
    catch (e) { console.warn('[Story Oracle] 撤销诊断修正后保存失败：', e); }
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
    catch (e) { console.warn('[Story Oracle] 重新应用诊断修正后保存失败：', e); }
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
    } catch (e) { console.warn('[Story Oracle] 校正前读取 MVU 状态失败：', e); }

    const now = new Date();
    const info = { send_date: now.toISOString(), gen_started: null, gen_finished: now.toISOString(), extra: { story_oracle_fix: true } };
    addSwipeToMessage(m, finalText, info);
    try { if (typeof ctx.saveChat === 'function') await ctx.saveChat(); }
    catch (e) { console.warn('[Story Oracle] 校正写入 swipe 后保存失败：', e); return false; }

    // Bug 2 ②：把抓到的状态【拷贝】到新 swipe（它现在已是 latest）。replaceMvuData 同时写 stat_data +
    // display_data，下面 updateMessageBlock 重渲染时状态栏即读到正确值。放在补发事件【之前】，尽量先于
    // MVU 可能的 swipe 监听落定。
    if (mvuSnapshot) {
        try {
            const Mvu = await getMvu();
            if (Mvu && typeof Mvu.replaceMvuData === 'function') {
                await Mvu.replaceMvuData(mvuSnapshot, mvuMsgOpts());
            }
        } catch (e) { console.warn('[Story Oracle] 校正后写回 MVU 状态失败：', e); }
    }

    try { if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(idx, m); }
    catch (e) { console.warn('[Story Oracle] 校正后重渲染失败：', e); }

    // Bug 1：刷新 ST 的 swipe 计数 + 左右箭头（updateMessageBlock 不管这块）。ctx.swipe.refresh 即
    // refreshSwipeButtons；传 true 连「X/Y」文字一起更新。带回退以防个别 ST 构建把它摆在别处。
    try {
        const swipeRefresh = (ctx.swipe && ctx.swipe.refresh) || ctx.refreshSwipeButtons;
        if (typeof swipeRefresh === 'function') swipeRefresh(true);
    } catch (e) { console.warn('[Story Oracle] 校正后刷新 swipe 计数失败：', e); }

    try {
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.emit === 'function') {
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_SWIPED || 'message_swiped', idx)).catch(() => {});
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_UPDATED || 'message_updated', idx)).catch(() => {});
        }
    } catch (e) { console.warn('[Story Oracle] 校正后发事件失败：', e); }
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
    catch (e) { console.warn('[Story Oracle] 校正写入 swipe 后保存失败：', e); return false; }
    try { if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(idx, m); }
    catch (e) { console.warn('[Story Oracle] 校正后重渲染失败：', e); }
    try {
        const et = ctx.eventTypes || ctx.event_types || {};
        if (ctx.eventSource && typeof ctx.eventSource.emit === 'function') {
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_SWIPED || 'message_swiped', idx)).catch(() => {});
            Promise.resolve(ctx.eventSource.emit(et.MESSAGE_UPDATED || 'message_updated', idx)).catch(() => {});
        }
    } catch (e) { console.warn('[Story Oracle] 校正后发事件失败：', e); }
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
        window.toastr && window.toastr.warning && window.toastr.warning(
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
        if (status === 'applied') {
            // 部分生效（FIX 1）：记录里已如实分列，toast 也别一句「已自动修复」了事 —— 那是唯一
            // 会被大多数用户看到的一面，读起来必须与记录是同一件事。后半句（去哪儿撤销）两支共用，
            // 全生效时拼出来的整句与本次改动之前【逐字节相同】。
            const rp = result && result.report;
            const head = (rp && rp.applied < rp.total)
                ? '已自动修复（部分指令未生效，详情见诊断记录）。'
                : '已自动修复最新回复的 MVU 状态。';
            window.toastr && window.toastr.success && window.toastr.success(
                // 分房间后记录（含撤销按钮）在诊断房间——人在别的模式时提示到点上（点诊断按钮即回诊断视图）
                head + (ENABLE_MODE_ROOMS
                    ? '可到剧情推进侧聊的诊断记录里点「撤销」还原（点🩺诊断按钮即达）。'
                    : '可在剧情推进侧聊里点「撤销」还原。'),
                '剧情推进 · 自动诊断', { timeOut: 7000 });
        } else if (status === 'nochange' || status === 'verified') {
            window.toastr && window.toastr.info && window.toastr.info(
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
            window.toastr && window.toastr.warning && window.toastr.warning(
                msg, '剧情推进 · 自动诊断', { timeOut: 5000 });
        }
    } catch (e) { /* toastr 不在就算了 */ }

    // 【有意不留记录】的那一支（opts.noNote）：toast 已经发过了，到此为止。appendNoteToRoom 写的是
    // getChatMetadataSafe() —— 也就是【现在】那个聊天的元数据，切聊天后写进去等于在无辜的对话里
    // 说另一个对话的事（与写入前那道事务闸同一条不变量，那边同样是静默作废）。
    if (opts && opts.noNote) {
        console.debug('[Story Oracle] 自动诊断：写入前发现聊天已切换，本轮作废（未写入）。');
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
    } catch (e) { console.warn('[Story Oracle] 自动诊断记录写入侧聊失败：', e); }
}

// 「正在自动诊断…」提示。返回一个句柄交给 dismissToast 收掉（toastr 不在则回 null）。timeOut:0 = 不
// 自动消失，由我们在生成结束后手动 clear。
// retry（可空）= 🔁 重试跳的 { used, max }：带上「第几次」标注，用户看得出这不是首跑。不传时
// 文案与 1.73.0 之前逐字相同。
export function showAutoDiagGenerating(retry) {
    try {
        if (window.toastr && window.toastr.info) {
            const msg = retry
                ? `诊断重试中（第 ${retry.used}/${retry.max} 次）…（点此中断）`   // 文案 Prince 亲选（换序版，2026-08-28）
                : '正在分析最新回复、生成诊断报告…（点此中断）';
            return window.toastr.info(msg, '剧情推进 · 自动诊断', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, onclick: () => cancelPostReply() });
        }
    } catch (e) { /* ignore */ }
    return null;
}
export function dismissToast(handle) {
    try { if (handle && window.toastr && window.toastr.clear) window.toastr.clear(handle); } catch (e) { /* ignore */ }
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
    bar.className = 'so-apply-bar so-note-undo';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
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
            panel.className = 'so-note-fullreply';
            panel.textContent = String(fullText == null ? '' : fullText);
            wrap.insertBefore(panel, bar);   // 面板落在摘要正文之下、按钮条之上
        }
        paint();
    });
}

export function addNoteUndoControls(wrap, info) {
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar so-note-undo';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
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
        status.classList.remove('so-hint-error');
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
                // 同样看不见。现算，绝不缓存（`.so-apply-status` 是 pre-line，换行真的换行）。
                const n = diagUserFloorNotice();
                status.textContent = '已还原到修复前的状态。' + (n ? '\n' + n : '');
            } catch (e) {
                status.textContent = '还原失败：' + (e?.message || e);
                status.classList.add('so-hint-error');
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
                status.classList.add('so-hint-error');
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
    bar.className = 'so-apply-bar so-note-undo';
    const swapBtn = document.createElement('button');
    swapBtn.className = 'so-apply-btn';
    swapBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 用原文';
    const diffBtn = document.createElement('button');
    diffBtn.className = 'so-apply-btn';
    diffBtn.innerHTML = '<i class="fa-solid fa-eye"></i> 看改动';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    bar.appendChild(swapBtn);
    bar.appendChild(diffBtn);
    bar.appendChild(status);
    wrap.appendChild(bar);

    // 原文 ↔ 校正稿 二态开关。showingOriginal=false = 当前显示校正稿（记录创建时即此态）。
    let showingOriginal = false;
    swapBtn.addEventListener('click', async () => {
        status.classList.remove('so-hint-error');
        swapBtn.disabled = true;
        const targetSwipe = showingOriginal ? info.fixSwipeId : 0;
        const ok = await selectSwipe(info.idx, targetSwipe);
        if (!ok) {
            // swipe 不在了（用户重 roll / 删了）——这条记录的切换不再可靠，停用。
            status.textContent = '无法切换（原 swipe 已不在）。';
            status.classList.add('so-hint-error');
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
    bar.className = 'so-apply-bar so-note-undo';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
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
        status.classList.remove('so-hint-error');
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
                    console.warn('[Story Oracle] 🎛 冻结联动撤销失败（MvuData 已换回，规则目标可能仍是旧值）：', err);
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
            status.classList.add('so-hint-error');
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
    if (soEntryIsLive('so-wand-button', menu) && soEntryIsLive('so-wand-recenter', menu)) return;
    soDropEntries('so-wand-button');
    soDropEntries('so-wand-recenter');

    const item = document.createElement('div');
    item.id = 'so-wand-button';
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
    rc.id = 'so-wand-recenter';
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
    if (soEntryIsLive('so-chatbar-button', bar)) return;   // 见 soEntryIsLive：克隆出来的哑巴节点要重建
    soDropEntries('so-chatbar-button');
    const btn = document.createElement('div');
    btn.id = 'so-chatbar-button';
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
    const btn = document.getElementById('so-chatbar-button');
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
export const FIXSEL_BAR_BTN_ID = 'so-fixsel-qr-btn';
export const FIXSEL_BAR_OWN_CLASS = 'so-fixsel-own-bar';