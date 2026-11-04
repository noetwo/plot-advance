import { mvuIsVwdPair } from './auto.js';
import { extractUpdateBlock } from './mvu.js';
import { DIAG_PATCH_CLOSE, DIAG_PATCH_OPEN, MVU_BLOCK_DIALECTS } from '../../prompts/builtins.js';
import { detectMvuBlockDialect } from '../../prompts/helpers.js';
// 纯函数：把「诊断前 → 诊断后」的 stat_data 差异折成一串【绝对值】JSONPatch 操作。
// 为什么不把模型出的补丁原样写进正文：模型的补丁常含相对量（delta），那是按【诊断当时】的状态算的；
// 一旦回放时的起点与当时不同（用户中途改过变量 / 别的扩展写过 / MVU 额外模型解析插过手），相对量就会漂。
// 写进正文的是【MVU 实际算出来的结果】而非模型的意图 —— 回放多少次都落在同一个值上，且天然幂等。
// 规则：VWD 对只出第一格标量；新增键出 add（MVU 的 set 碰到不存在的路径会直接跳过，只有 insert/add 建得了）；
// 删除出 remove；其余出 replace。$internal 是 MVU 自己塞进 stat_data 的运行期字段（update_variables.ts:682），跳过。
// 比较沿用本文件既有的 JSON.stringify 口径（同 autoApplyFix）。可单测。
export function diffMvuStat(oldStat, newStat, base) {
    const prefix = base || '';
    const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const a = isPlainObj(oldStat) ? oldStat : {};
    const b = isPlainObj(newStat) ? newStat : {};
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const keys = Object.keys(a);
    for (const k of Object.keys(b)) if (!has(a, k)) keys.push(k);
    const ops = [];
    for (const k of keys) {
        if (!prefix && k === '$internal') continue;
        const path = prefix + '/' + k;
        if (has(a, k) && !has(b, k)) { ops.push({ op: 'remove', path }); continue; }
        if (!has(a, k) && has(b, k)) { ops.push({ op: 'add', path, value: b[k] }); continue; }
        const va = a[k], vb = b[k];
        if (mvuIsVwdPair(va) && mvuIsVwdPair(vb)) {
            if (JSON.stringify(va[0]) !== JSON.stringify(vb[0])) ops.push({ op: 'replace', path, value: vb[0] });
            continue;
        }
        if (isPlainObj(va) && isPlainObj(vb)) { for (const op of diffMvuStat(va, vb, path)) ops.push(op); continue; }
        if (JSON.stringify(va) !== JSON.stringify(vb)) ops.push({ op: 'replace', path, value: vb });
    }
    return ops;
}

// 纯函数：把 ops 拼成要插进区块里的那段文本（含定界注释）。ops 为空 → ''（调用方据此不注入）。可单测。
export function buildDiagPatchPayload(ops) {
    if (!Array.isArray(ops) || !ops.length) return '';
    return DIAG_PATCH_OPEN + '\n<JSONPatch>\n' + JSON.stringify(ops) + '\n</JSONPatch>\n' + DIAG_PATCH_CLOSE + '\n';
}

// 纯函数：把 payload 插进【文本里最早那个】更新区块的闭标签之前（跨方言，取块沿用 extractUpdateBlock）。
// 闭标签靠【块尾】定位，不另写 `</name` 正则 —— 那会被 </update_analysis> 抢先命中（1.40.2 同款边界坑）。
// 没有干净闭标签（区块被截断）→ 返回 null，调用方【什么都不做】。可单测。
export function insertDiagPatchIntoBlock(text, payload) {
    const s = String(text == null ? '' : text);
    if (!payload) return null;
    const block = extractUpdateBlock(s);
    if (!block) return null;
    const tail = /<\/[A-Za-z_][\w.:-]*\s*>\s*$/.exec(block);
    if (!tail) return null;
    const at = s.indexOf(block);
    if (at < 0) return null;
    return s.slice(0, at + tail.index) + payload + s.slice(at + tail.index);
}

// 纯函数：把我们插进去的那段（含定界注释）整段摘掉，令正文【逐字节】回到插入前。幂等；没插过就原样返回。可单测。
export function stripDiagPatchFromText(text) {
    const s = String(text == null ? '' : text);
    return s.replace(new RegExp(DIAG_PATCH_OPEN + '[\\s\\S]*?' + DIAG_PATCH_CLOSE + '\\n?', 'g'), '');
}

// 纯函数：把我们自己会发的三种 op（replace / add / remove）按【MVU 的语义】重放到 base 上，返回新状态。
// 只需覆盖这三种——补丁是我们生成的，不会出现 move / delta。唯一的语义要点就是 VWD：路径当前值是
// `[值,"说明"]` 时，MVU 的 set 写的是第一格（update_variables.ts:767-786），这里照做。可单测。
function replayDiagOps(baseStat, ops) {
    const out = (baseStat == null) ? {} : JSON.parse(JSON.stringify(baseStat));
    for (const op of (Array.isArray(ops) ? ops : [])) {
        const segs = String((op && op.path) || '').split('/').slice(1);
        if (!segs.length) continue;
        let node = out;
        for (let i = 0; i < segs.length - 1 && node && typeof node === 'object'; i++) node = node[segs[i]];
        if (!node || typeof node !== 'object') continue;
        const last = segs[segs.length - 1];
        if (op.op === 'remove') { delete node[last]; continue; }
        if (op.op === 'replace' && mvuIsVwdPair(node[last])) { node[last][0] = op.value; continue; }
        node[last] = (op.value === undefined) ? null : JSON.parse(JSON.stringify(op.value));
    }
    return out;
}

// 纯函数：比对用的归一化 —— VWD 对折成它的第一格。理由：说明槽（第二格）不是状态，而且 MVU 的标量 set
// 【够不着】它，所以「说明变了」既不该判成差异、也不该拖累别的路径。其余结构原样递归。可单测。
export function normalizeForVerify(v) {
    if (mvuIsVwdPair(v)) return normalizeForVerify(v[0]);
    if (Array.isArray(v)) return v.map(normalizeForVerify);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) { if (k !== '$internal') out[k] = normalizeForVerify(v[k]); }
        return out;
    }
    return v;
}

// 纯函数：自检 —— 这串 ops 从「诊断前」按 MVU 语义重放，能不能精确落回「诊断后」？
// 卡片的变量形状千奇百怪（各种命名、嵌套、数组、VWD、甚至键名里带斜杠），与其写一份会算出别的结果的
// 补丁进用户存档，不如**一个字都不写**。这是本功能对「未知形状」的兜底闸门。可单测。
export function verifyDiagOps(beforeStat, afterStat, ops) {
    try {
        const got = normalizeForVerify(replayDiagOps(beforeStat, ops));
        const want = normalizeForVerify(afterStat == null ? {} : afterStat);
        return JSON.stringify(got) === JSON.stringify(want);
    } catch (e) { return false; }
}

/* ── 🩺 诊断加固纯函数四件套（陈旧判定 / 甲乙补充探针 / 摘块失败归因 / 逐 op 对账） ──
 * 四个都无副作用、不读全局，唯一依赖是本文件既有的口径函数（normalizeForVerify / mvuIsVwdPair /
 * detectMvuBlockDialect / MVU_BLOCK_DIALECTS）—— 口径只有一份，别另起炉灶。 */

// 纯函数：stat_data 指纹（陈旧判定口径）。折 VWD 取第一格、剥 $internal（沿用 normalizeForVerify），
// 说明槽变化 / MVU 运行期字段不算「状态变了」。可单测。
export function diagStatKey(stat) {
    try { return JSON.stringify(normalizeForVerify(stat == null ? null : stat)); }
    catch (e) { return 'null'; }
}

// 纯函数（1.83.0 🧩 允许与其他脚本并写 MVU）：把补丁裁到「没被别人动过」的那部分。snapStat = 诊断时拍的
// stat_data、liveStat = 写入前现读的那份；一条 op 的落点路径（path；move 类还看 from）在两份之间【值不同】
// = 别人在诊断期间动过它 → 丢弃并点名，其余照留。判据是逐路径取值比对、口径沿用 normalizeForVerify（VWD 折
// 第一格、剥 $internal），与 diagOpOutcomes 同源：整个父容器被换掉时子路径的值自然也不同，天然算冲突；新建键
// 两边都查不到 = 没人动过。只认 <JSONPatch> / <json_patch> 里的 JSON 数组（_.set 方言回 null，调用方退回整份
// 跳过）。ops 数组之外的字节一个不动（外壳原样，写回手法同 repairDiagPatch）。可单测。
export function diagScopePatchToUntouched(patchText, snapStat, liveStat) {
    const text = String(patchText == null ? '' : patchText);
    const got = diagPatchOpsOf(text);
    if (!got || !Array.isArray(got.ops)) return null;
    const fp = (stat, path) => {
        const r = diagResolvePath(stat, path, true);
        return (r && r.ok) ? JSON.stringify(normalizeForVerify(r.value)) : null;
    };
    const touched = (p) => typeof p === 'string' && p !== '' && fp(snapStat, p) !== fp(liveStat, p);
    const kept = [], dropped = [];
    for (const op of got.ops) {
        const dest = (op && typeof op.path === 'string') ? op.path : ((op && typeof op.to === 'string') ? op.to : '');
        const from = (op && typeof op.from === 'string') ? op.from : '';
        if (touched(dest) || touched(from)) dropped.push({ op: op && op.op, path: dest });
        else kept.push(op);
    }
    if (!dropped.length) return { text, kept: kept.length, dropped };
    const at = text.indexOf(got.inner, got.m.index);
    if (at < 0) return null;
    return {
        text: text.slice(0, at) + '\n' + JSON.stringify(kept, null, 2) + '\n' + text.slice(at + got.inner.length),
        kept: kept.length,
        dropped,
    };
}

// 纯函数：这段文本里有没有【裸】可执行 MVU 指令（不带已识别包装）——bare <json_patch> 或行首 _.set(。
// 只喂给 甲/乙 推导闸（detectMvuBlockDialect 之外的补充探针），绝不接到 extract/strip 等其它消费者上：
// MVU 按文本位置执行这两种形态（方言表注释），探不到就误入【乙·推导】= 已生效的回合被再算一遍。可单测。
export function detectBareMvuOps(text) {
    const s = String(text == null ? '' : text);
    // 已识别方言包装在场 → 不是「裸」指令，甲/乙 闸由方言探测负责。<update> 方言【本来就】装着
    // <json_patch>（1.40.2 重复计数那只 bug 的方言）——不先让路，整块规范回复会被误报成裸指令。
    if (detectMvuBlockDialect(s)) return false;
    if (/<json_patch\b/i.test(s)) return true;
    return /(^|[\n\r])\s*_\.set\(/.test(s);
}

// 纯函数：extractUpdateBlock 摘不到时，给「为什么摘不到」分类并点名缺了什么（Prince 点单：要能看出
// 缺哪个闭合标签）。宽松探测沿用 detectMvuBlockDialect / detectBareMvuOps；闭合标签清点只对已探测到的
// 包装族做（wrapper + 它的 inner + 经典内标签 JSONPatch/Analysis），开>闭 即记缺。可单测。
export function diagParseFailReason(finalText) {
    const s = String(finalText == null ? '' : finalText);
    if (!s.trim()) return { code: 'empty', detail: '模型没有返回内容（可能被拒答或截断）' };
    const wrapper = detectMvuBlockDialect(s);
    if (wrapper) {
        const suspects = [wrapper, 'JSONPatch', 'Analysis',
            ...(MVU_BLOCK_DIALECTS.find((d) => d.wrapper === wrapper) || { inner: [] }).inner];
        const missing = [];
        for (const t of suspects) {
            const opens = (s.match(new RegExp('<' + t + '\\b[^>]*>', 'gi')) || []).length;
            const closes = (s.match(new RegExp('<\\/' + t + '\\s*>', 'gi')) || []).length;
            if (opens > closes) missing.push('</' + t + '>');
        }
        return missing.length
            ? { code: 'unclosed', detail: '检测到 <' + wrapper + '> 区块，但缺少 ' + missing.join('、') + ' 闭合标签（换模型后常见）' }
            : { code: 'noblock', detail: '检测到 <' + wrapper + '> 标签，但没能按已知格式摘出完整区块' };
    }
    // 1.69.0：拼法对齐 —— MVU 的块正则写的是 `json_?patch`（下划线【可有可无】），而
    // detectBareMvuOps 的探针写死了下划线（它另有消费者，有意不动它，见其头注）。于是模型甩一段
    // 无包装的 <JSONPatch> 时，归因会掉到最后那句「模型没按格式输出更新区块」= 不实：它输出了，
    // 只是没套包装标签。这里补一道同族探针，只影响【归因文案】，不改任何闸门判定。
    if (detectBareMvuOps(s) || /<json_?patch\b/i.test(s)) {
        return { code: 'nonstd', detail: '检测到 <json_patch>/<JSONPatch>/_.set 指令，但没有标准包装标签' };
    }
    return { code: 'noblock', detail: '模型没按格式输出更新区块' };
}

// 纯函数：逐 op 对账（Prince 点单：告诉用户为什么没生效）。只认 <JSONPatch> 里的 JSON 数组（_.set 方言
// 回 null，调用方退回整体比较文案）。result 判定：「applied」= 这条 op 【自己那条路径】上、前后两份状态
// 的值变了没有；未变化的 op 再按 old 侧路径解析分类——路径解析不到且非 add = missing-path（set 不新建
// 键），解析到且值已等于目标 = noop-equal，其余 unknown（诚实：不懂就说不懂）。VWD 折第一格（说明槽
// 不是状态），口径沿用 normalizeForVerify。可单测。
// ⚠ 判据【有意】不走 diffMvuStat 的变化集：那份差异不进列表内部（数组不是 plain object，只在外层记一条
// 「/今日待办 变了」），于是打在列表项里的 op（/今日待办/0/状态）永远对不上自己的路径 —— 真生效了也
// 只能报「没能从状态变化里判断」。也【不能】退而用前缀命中：同一个列表上另一条 op 造成的变化会把这条
// 没动过的一起算成生效（diag-hardening-helpers.test.mjs 有反向钉）。逐路径取值比对两头都不沾。
export function diagOpOutcomes(patchBlock, oldStat, newStat) {
    let ops = null;
    try {
        const m = /<JSONPatch\s*>([\s\S]*?)<\/JSONPatch\s*>/i.exec(String(patchBlock == null ? '' : patchBlock));
        if (m) ops = JSON.parse(m[1]);
    } catch (e) { ops = null; }
    if (!Array.isArray(ops)) return null;
    const resolve = (stat, path) => {
        const segs = String(path || '').split('/').filter(Boolean);
        let node = stat, ok = true;
        for (const seg of segs) {
            if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, seg)) node = node[seg];
            else { ok = false; break; }
        }
        return ok ? { ok, value: node } : { ok };
    };
    // 该路径上的可比指纹；解析不到回 null（JS null，与 JSON 串 'null' 不会撞）——于是「原本没有 → 现在
    // 有了」（insert 建键）与「原本有 → 现在没了」（remove）都天然算作变了。
    const fingerprint = (stat, path) => {
        const r = resolve(stat, path);
        return r.ok ? JSON.stringify(normalizeForVerify(r.value)) : null;
    };
    const outcomes = ops.map((op) => {
        const path = (op && op.path) || '';
        // path 为空（move 这类只有 from/to 的 op）→ 不比：拿根路径比等于「别处只要变过就算它生效」。
        if (path && fingerprint(oldStat, path) !== fingerprint(newStat, path)) {
            return { op: op && op.op, path, result: 'applied' };
        }
        const cur = resolve(oldStat, path);
        // 能建新键的动词只有 insert / add（diffMvuStat 注释同款口径：set 语义碰到不存在的路径直接跳过）。
        // insert 是【模型真会写】的那个——DIAGNOSE_SYSTEM_PROMPT 给的词表是 replace、delta、insert、
        // remove、move；add 是我们自己 diffMvuStat 出的。两者都不能因「路径当时不存在」判成没生效。
        if (!cur.ok && !(op && (op.op === 'add' || op.op === 'insert'))) return { op: op && op.op, path, result: 'missing-path' };
        if (cur.ok) {
            const curVal = mvuIsVwdPair(cur.value) ? cur.value[0] : cur.value;
            if (JSON.stringify(curVal) === JSON.stringify(op && op.value)) return { op: op && op.op, path, result: 'noop-equal' };
        }
        return { op: op && op.op, path, result: 'unknown' };
    });
    return { total: outcomes.length, applied: outcomes.filter((o) => o.result === 'applied').length, outcomes };
}

// 纯函数：把模型【开错根】的 JSONPatch 路径掰回 MVU 的路径空间（live 用户 2026-08-22 报「29 条指令中
// 0 条生效」，逐条都是「路径不存在」）。MVU 只剥掉开头那一个 '/' 就把整串当作 stat_data【内部】的 lodash
// 路径（update_variables.ts：jsonPatchPathToCommandPath → _.set(variables.stat_data, path, …)）——所以
// 模型写的 /stat_data/世界/时间 会被找成 stat_data.stat_data.世界.时间，恒不存在：replace/remove 被
// 静默跳过（一条都不落地），insert/add 更糟 —— _.set 会把整条父链造出来，存档里就长出一支垃圾
// stat_data.stat_data.*。提示词里已写明「根相对路径（例如 /主角状态/修为/进度百分比）」，模型照样会漏，
// 故硬保证放在代码侧。
// 动手条件（三条【全中】才改，宁可不改也绝不误改）：
//   ① 状态顶层【没有】真名叫 stat_data 的键 —— 少数卡真有，那种卡上 /stat_data/… 原样就是对的；
//   ② 这条路径按原样在当前状态里解析不到；
//   ③ 剥掉开头那个 stat_data 段之后解析得到（= 有证据说它只是开错根，而不是把名字写错了）。
// 判定落点按动词分：insert/add 建的就是【还不存在】的末段（数组追加更是 `-`），只能按【父容器】判，
// 否则这一档 —— 恰恰是唯一会污染存档的那一档 —— 永远救不了；其余（replace/delta/remove/move）按整条判。
// move 的 from/to 与 path 同等对待。
// 回 { text, fixed }：text = 掰过的区块（一条都没掰时【逐字节】原样返回）、fixed = 掰了几条。
// 摘不出 <JSONPatch> JSON 数组（_.set 方言）/ 拿不到状态 → 原样返回，绝不抛。可单测。
export function normalizeDiagPatchPaths(patchBlock, stat) {
    const text = String(patchBlock == null ? '' : patchBlock);
    const out = { text, fixed: 0 };
    if (!stat || typeof stat !== 'object') return out;
    if (Object.prototype.hasOwnProperty.call(stat, 'stat_data')) return out;   // 闸①
    let m = null, ops = null;
    try {
        m = /<JSONPatch\s*>([\s\S]*?)<\/JSONPatch\s*>/i.exec(text);
        if (m) ops = JSON.parse(m[1]);
    } catch (e) { return out; }
    if (!m || !Array.isArray(ops)) return out;
    // 解析口径与 diagOpOutcomes 的 resolve 同源：own-property 逐段查，数组下标同样按 own-property 命中。
    const resolves = (path) => {
        const segs = String(path || '').split('/').filter(Boolean);
        let node = stat;
        for (const seg of segs) {
            if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, seg)) node = node[seg];
            else return false;
        }
        return true;
    };
    // 单段路径的父容器 = 根（空串）→ resolves('') 恒真，于是「往顶层插一个新键」那档也掰得动。
    const probe = (op, path) => {
        if (op !== 'insert' && op !== 'add') return path;
        const at = String(path).lastIndexOf('/');
        return at > 0 ? path.slice(0, at) : '';
    };
    const reroot = (op, path) => {
        if (typeof path !== 'string' || !/^\/stat_data\//.test(path)) return null;
        if (resolves(probe(op, path))) return null;                             // 闸②：原样就查得到 → 不是开错根
        const stripped = path.slice('/stat_data'.length);
        return resolves(probe(op, stripped)) ? stripped : null;                 // 闸③：剥了才查得到，才算有证据
    };
    const next = ops.map((op) => {
        if (!op || typeof op !== 'object') return op;
        const copy = Object.assign({}, op);
        for (const key of ['path', 'from', 'to']) {
            const fixed = reroot(op.op, copy[key]);
            if (fixed != null) { copy[key] = fixed; out.fixed++; }
        }
        return copy;
    });
    if (!out.fixed) return out;
    const at = text.indexOf(m[1], m.index);
    out.text = text.slice(0, at) + '\n' + JSON.stringify(next, null, 2) + '\n' + text.slice(at + m[1].length);
    return out;
}

/* ── 🩺 1.67.0：MVU「受理」预检 + 确定性修复流水线 ────────────────────────────────
 * 全部纯函数、零副作用、绝不抛。依据是 MagVarUpdate@beta 与 mvu_zod 的【真源码】（2026-08-24 逐条核过），
 * 不是设计稿推测 —— 改这一族之前请先回去核源码，别按印象改：
 *   ① 块正则 /<(json_?patch)>(?:\s*```.*)?…(?:```\s*)?<\/\1>/gim：大小写不敏感（<JSONPatch> 恒命中）、
 *      允许紧贴标签的 ``` 围栏，但标签里【一个空白都不容】——「<JSONPatch >」对 MVU 完全隐形，而我们
 *      自家的摘块正则写的是 \s*，恒容忍 → 我们看得见、MVU 看不见，这是最难自查的一档。
 *   ② 内文经 parseString（YAML → JSON5 → jsonrepair 三连）解析，【宽容】；失败被 catch 吞掉 = 空命令表。
 *      所以我们的 JSON.parse 挂了【不等于】MVU 也挂 —— 那一档只敢报「判不出」，绝不敢报「一定失败」。
 *   ③ isJsonPatch 是 every：数组 + 每个元素都是 plain object + op 是字符串 + path 是字符串（move 可只有
 *      to）。一颗坏元素 → 整块指令一起被丢，好 op 全部陪葬。这就是「剔除毒元素」那一类修复存在的理由。
 *   ④ 动词表只有 replace/delta/insert/add/remove/move；认不出的动词在 switch 里没有分支 = 逐条静默丢弃。
 *   ⑤ set（replace）先 _.has，路径不存在 → outError + continue，【绝不新建】；旧值是 VWD 对 [值,"说明"]
 *      时只写第一格（旧值是数字还会 Number(新值)）—— 把整对递回去 = Number([...]) = NaN。
 *   ⑥ add（delta）同样先 _.has；增量非数字 → outError + continue。
 *   ⑦ insert/add 在 extractJsonPatch 里被拆成（容器路径, 末段键, 值）三参 —— 判定落点是【父容器】；
 *      容器不是集合（含 undefined）→ 报 assignPrimitive 跳过。1.66.1 的 probe 用的就是同一条口径。
 *   ⑧ jsonPatchPathToCommandPath 只剥开头那【一个】'/'，其余按 '/' 切、逐段解 ~1/~0，【不丢空段】：
 *      末尾多一个斜杠 = 多一个空键名，_.has 恒假（我们自家的解析 filter(Boolean) 会容忍它 → 分歧之二）。
 *   ⑨ 很多卡在 MVU 之上还挂 mvu_zod（StageDog/tavern_resource dist/util/mvu_zod.js）：路径里只要有一段
 *      以 '_' 开头就 return null【静默】不执行；整批结果 safeParse 不过也是【静默】丢弃（只有 console
 *      错误）。那份 schema 我们看不见，所以这两条只出【提示】，绝不写成「一定失败」。
 */

// 纯函数：按 MVU 的路径语义把 JSONPatch 路径切成段。strict=true 忠实 MVU（不丢空段，见 ⑧）；
// strict=false 沿用本仓既有的宽容口径（filter(Boolean)，同 diagOpOutcomes 的 resolve），供「剥掉多余
// 斜杠之后查得到吗」这类证据闸使用。空串 = 根路径（MVU 的 set 允许 path === ''）。可单测。
export function diagPathSegs(path, strict) {
    const raw = String(path == null ? '' : path);
    if (raw === '') return [];
    const segs = (raw.startsWith('/') ? raw.slice(1) : raw).split('/')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    return strict ? segs : segs.filter(Boolean);
}

// 纯函数：own-property 逐段走（口径同 diagOpOutcomes 的 resolve —— 数组下标同样按 own-property 命中）。
export function diagWalkSegs(stat, segs) {
    let node = stat;
    for (const seg of segs) {
        if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, seg)) node = node[seg];
        else return { ok: false };
    }
    return { ok: true, value: node };
}

// 纯函数：一条路径在当前状态里查不查得到。可单测。
export function diagResolvePath(stat, path, strict) {
    return diagWalkSegs(stat, diagPathSegs(path, strict));
}

// 纯函数：这个元素过不过得了 MVU 的 isJsonPatch 形状闸（③）。过不了的那一颗会拖着整块陪葬。可单测。
export function diagOpShapeOk(o) {
    return Object.prototype.toString.call(o) === '[object Object]'
        && typeof o.op === 'string'
        && (typeof o.path === 'string' || (o.op === 'move' && typeof o.to === 'string'));
}

// 纯函数：MVU 那条【严格】块正则现在看不看得见一块 json_patch —— 逐字照抄它的写法（标签里一个空白都
// 不容、允许紧贴标签的 ``` 围栏、内部不得再出现开标签）。这是「标签空白」那一类修复与预检的【唯一】
// 证据来源：看得见就说明这块 MVU 本来就吃得到，一个字节都不许动。可单测。
function mvuSeesPatchBlock(text) {
    return /<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/i
        .test(String(text == null ? '' : text));
}

// 纯函数：把这块补丁【自己的】<json_patch> 开 / 闭标签里的多余空白抹掉（①）。回 { text, fixed }，
// 形状与姊妹件 normalizeDiagPatchPaths 一致；一处没动 → text 逐字节原样返回。
// ⚠ 有意【不】做全局替换：补丁的 value 里完全可能原样带着「<json_patch >」这几个字（比如把模型的
//   输出记进某个日志字段），全局替换会去改用户真正要写进状态的【正文】——「没有证据就不改写模型
//   原文」是本族的红线。所以只动我们摘到的那一块的两个定界标签，块内文字一个字节都不碰。
// 别的标签（<Analysis > 之类）的空格与 MVU 无关，同样不碰。大小写原样保留：开 / 闭两侧各自捕获、
// 不用反向引用，于是闭标签写成别的大小写时也保留它自己的写法（MVU 的块正则是 /i，本就不在乎）。可单测。
export function normalizeDiagPatchTags(text) {
    const s = String(text == null ? '' : text);
    // 证据闸（codex 复核 FINDING）：MVU 现在【已经】看得见一块 → 这里没有任何毛病可修，一个字节都不动。
    // 少了这道闸，`value` 里原样带着一个 `</JSONPatch >` 的补丁会被咬伤：我们的懒惰匹配会停在【值里】
    // 那个闭标签上、把它的空格抹掉，于是它变成一个【真的】闭标签 —— MVU 的块就此被从中间截断，一条
    // 本来跑得好好的补丁被我们改废。修坏比不修坏得多。
    if (mvuSeesPatchBlock(s)) return { text: s, fixed: 0 };
    const m = /<(json_?patch)(\s*)>([\s\S]*?)<\/(json_?patch)(\s*)>/i.exec(s);
    if (!m || (!m[2] && !m[5])) return { text: s, fixed: 0 };
    const rebuilt = '<' + m[1] + '>' + m[3] + '</' + m[4] + '>';
    return {
        text: s.slice(0, m.index) + rebuilt + s.slice(m.index + m[0].length),
        fixed: (m[2] ? 1 : 0) + (m[5] ? 1 : 0),
    };
}

/* ── 🩺 1.68.0：弱模型错误电池（768 判分格，2026-08-25）蒸馏出的三类新修复 ────────────────
 * 全部纯函数、零副作用、绝不抛，证据闸与 1.67.0 那七类同一条红线：拿不到证据宁可不改，
 * 一处没动就【逐字节】原样返回。语料频次见 tests/unit/_diag-battery/FINDINGS-2026-08-25.md。
 */

// 纯函数：MVU 真会执行的【每一块】的整块原文（含定界标签）。逐字照抄它那条【严格】块正则
// （标签里不容空白、允许紧贴围栏），/gim 全局切。MVU 的 extractCommands 用的正是 /gim ——
// 它把【所有】块都执行，而我们的预检 / 修复只看第一块。
// 1.69.0 起闸门要【逐块】判「这一块到底写成了没有」（第二块可以把整条回复救回甲），故切出块
// 本身而不只是计数；diagCountPatchBlocks 从此是它的一行包装，两处口径构造性同源。可单测。
export function diagMvuPatchBlocks(text) {
    const s = String(text == null ? '' : text);
    if (!s) return [];
    return s.match(/<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/gim) || [];
}

// 纯函数：MVU 真会执行几块？双区块因此既有「重复执行」的风险，又撞卡片显示正则的状态栏吞噬
// 地雷（CLAUDE.md 地雷条）—— 这是双区块拒绝闸的唯一判据。可单测。
export function diagCountPatchBlocks(text) {
    return diagMvuPatchBlocks(text).length;
}

// 纯函数：从这段文本里切出【第一个结构完整】的 JSON 数组跨度（字符串感知的括号配对 —— 值里的
// 方括号 / 花括号骗不动它）。配不平 → null。给下面两类定界符修补当证据闸。可单测。
function diagJsonArraySpan(text) {
    const s = String(text == null ? '' : text);
    const start = s.indexOf('[');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') {
            depth--;
            if (depth === 0) return { start, end: i + 1 };
            if (depth < 0) return null;
        }
    }
    return null;
}

// 纯函数（修复类⑨）：补丁数组写完了、`</UpdateVariable>` 也在，就是【漏了 </JSONPatch>】——
// 于是 MVU 与我们的提取器全瞎，整条回复被判「没有区块」。语料 5/768，四例是 gemini 家族；
// 与 2026-08-15 异录战役钉死的 opus-4.8 漏闭合是同一物种（不是那只模型的怪癖，是弱模型通病）。
// 证据闸（四条【全中】才补，宁可不补也绝不误补）：
//   ① mvuSeesPatchBlock 现在【看不见任何块】—— 看得见就说明 MVU 本来就吃得到，一个字节都不许动。
//      这条闸顺带挡住 normalizeDiagPatchTags 头注里那口最险的咬：value 里原样带着一个 `</JSONPatch>`
//      时 MVU 的块正则会把它当真闭标签 → 它【看得见】一块 → 本类天生不动手。
//   ② 开标签在，且【本来就干净】（<json_patch> / <JSONPatch>，标签里没有空白）。带空白的那档是
//      类① 的活；开标签空白 + 缺闭合的双故障【有意】不修（两处都靠猜，风险不成比例）。
//   ③ 从开标签起、到 </UpdateVariable>（没有就到结尾）为止，切得出一个结构完整、能 JSON.parse 的数组；
//   ④ 数组里【每一个】元素都过得了 MVU 的 isJsonPatch 形状闸 —— 过不了的话补上闭合标签也是整块陪葬。
// 闭合标签的拼法【跟着开标签走】（用户写 <json_patch> 就补 </json_patch>）；数组之后若只剩一个紧贴
// 的 ``` 围栏，闭合标签排在围栏之后（MVU 的块正则明文允许围栏，排前面会把围栏甩出块外）。
// 回 { text, fixed }，形状与姊妹件 normalizeDiagPatchTags 一致。可单测。
export function repairDiagCloseTag(text) {
    const s = String(text == null ? '' : text);
    const out = { text: s, fixed: 0 };
    if (!s || mvuSeesPatchBlock(s)) return out;                       // 闸①
    const om = /<(json_?patch)>/i.exec(s);                            // 闸②（不容空白 = MVU 的口径）
    if (!om) return out;
    const after = om.index + om[0].length;
    const tail = s.slice(after);
    const endM = /<\/UpdateVariable\s*>/i.exec(tail);
    const zone = endM ? tail.slice(0, endM.index) : tail;
    const span = diagJsonArraySpan(zone);                             // 闸③
    if (!span) return out;
    let ops = null;
    try { ops = JSON.parse(zone.slice(span.start, span.end)); } catch (e) { return out; }
    if (!Array.isArray(ops) || !ops.every((o) => diagOpShapeOk(o))) return out;   // 闸④
    let at = span.end;
    const fence = /^\s*```\s*/.exec(zone.slice(at));
    if (fence) at += fence[0].length;
    out.text = s.slice(0, after + at) + '</' + om[1] + '>' + s.slice(after + at);
    out.fixed = 1;
    return out;
}

// 纯函数（修复类⑩）：块在、闭合标签也在，坏的是【JSON 容器本身】。语料两种形态（2/768，均 preview 臂）：
//   (a) 几条 op 逗号排开，忘了包 `[ ]`；(b) 开了 `[`、一条完整 op 之后忘了写 `]`。
// 旧路：JSON.parse 死 → 预检走 parse-uncertain（有意不 fatal）→ 零变化报告回 nodata → 侧聊写
// 「本回合无需改动」，而那几条【正确】的指令被静默扔掉。这是 1.67.0 诚实回归里最后一个撒谎的洞。
// 证据闸：补【之前】我们解析不动（got.ops === null），补【之后】解析得到一个【非空】的、每个元素都
// 过形状闸的数组。两种候选各试一次，互斥（包一层对 (b) 无效、补一个 ] 对 (a) 无效），谁成谁算。
// ⚠ 空数组【有意】不算成功：把 `[` 补成 `[]` 会伪造出一份「模型认为无需改动」——那是新的谎。
// ⚠ MVU 自己的 parseString 是【宽容】的（YAML → JSON5 → jsonrepair 三连），我们解析不动不代表它也
//   解析不动；但把定界符补齐【只会】让两边都更容易读懂，不会把它本来读得懂的东西改坏。
// 回 { text, fixed }。可单测。
export function repairDiagJsonWrap(text) {
    const s = String(text == null ? '' : text);
    const out = { text: s, fixed: 0 };
    const got = diagPatchOpsOf(s);
    if (!got || got.ops !== null) return out;
    const body = String(got.inner).replace(/^\s*```[^\n]*\n?/, '').replace(/```\s*$/, '').trim();
    if (!body) return out;
    for (const cand of ['[' + body + ']', body + ']']) {
        let ops = null;
        try { ops = JSON.parse(cand); } catch (e) { continue; }
        if (!Array.isArray(ops) || !ops.length || !ops.every((o) => diagOpShapeOk(o))) continue;
        const at = s.indexOf(got.inner, got.m.index);
        if (at < 0) return out;
        out.text = s.slice(0, at) + '\n' + JSON.stringify(ops, null, 2) + '\n' + s.slice(at + got.inner.length);
        out.fixed = 1;
        return out;
    }
    return out;
}

// 纯函数（修复类⑧）：把一条 move 拆成 insert(目标, 源值) + remove(源)。
// 依据：MagVarUpdate@beta 的 extractJsonPatch 会把 move 翻译成 type:'move' 命令，可执行 switch
// （update_variables.ts 760–1324）里【没有 case 'move'】—— 静默丢弃。1.67.0 的预检给它判 'ok' 是
// 假绿灯：37/768 格中招，且那 37 次 residual 文案（「问题在环境」）100% 是它，两条「常见原因」全不沾边。
// 对照组自己给出了修法：模型自发写成 remove+insert 两步的格【全部落地且意图达成】。
// 证据闸（全中才拆）：源路径解析得到（strict 切段、own-property 逐段走）+ 目标的【父容器】在且是集合。
// 另外三道保守闸：源与目标同路径、互为祖先、根路径 —— 拆了会把源头连带删掉，宁可不修。
// 值是【代码侧】从状态里深拷贝的，不经模型：VWD 的 [值,"说明"] 对整对搬走，说明槽不会掉。
// insert 排在 remove 【之前】是刻意的：中途失败只会留下一份多余的拷贝，绝不会把数据弄丢。
// 回 [insertOp, removeOp]；任一闸不过 → null（调用方原样保留那条 move）。可单测。
export function diagDecomposeMove(op, dest, stat) {
    if (!op || op.op !== 'move' || typeof op.from !== 'string' || typeof dest !== 'string') return null;
    if (!stat || typeof stat !== 'object') return null;
    const fromSegs = diagPathSegs(op.from, true);
    const destSegs = diagPathSegs(dest, true);
    if (!fromSegs.length || !destSegs.length) return null;
    if (JSON.stringify(fromSegs) === JSON.stringify(destSegs)) return null;
    const ancestor = (a, b) => a.length < b.length && a.every((s, i) => s === b[i]);
    if (ancestor(fromSegs, destSegs) || ancestor(destSegs, fromSegs)) return null;
    const src = diagWalkSegs(stat, fromSegs);
    if (!src.ok) return null;
    const parent = diagWalkSegs(stat, destSegs.slice(0, -1));
    if (!parent.ok || !parent.value || typeof parent.value !== 'object') return null;
    let value;
    try { value = JSON.parse(JSON.stringify(src.value)); } catch (e) { return null; }
    if (value === undefined) return null;
    return [{ op: 'insert', path: dest, value }, { op: 'remove', path: op.from }];
}

// 内部：摘出 <JSONPatch> 里的 JSON 数组。摘块正则脱胎于 diagOpOutcomes / normalizeDiagPatchPaths，
// 另兼容 <json_patch> 拼法与紧贴标签的 ``` 围栏（MVU 的块正则明文允许两者，见 ①）。
// ⚠ 已知的口径不对称（有意，1.67.0 不扩）：1.64.0 的 diagOpOutcomes 只认 <JSONPatch> 这一种拼法，
//   本族认两种（MVU 自己两种都执行）。后果只有一个方向：碰上 <json_patch> 拼法的块，本族照修
//   （对用户是净收益），而逐 op 对账仍回 null → 走「没有对账依据」那条老路，与 1.67.0 之前逐字一致。
//   要拉齐就得连 diagOpOutcomes 一起改，那是另一批的事。（开错根那一道闸已经拉齐了 —— repairDiagPatch
//   把 ops 包进合成外壳再喂 normalizeDiagPatchPaths，见那里的注释。）
// 回 null = 根本没有这种块（_.set 方言）；ops === null = 我们解析不动（MVU 未必也解析不动，见 ②）。
export function diagPatchOpsOf(text) {
    const s = String(text == null ? '' : text);
    // 先按 MVU 的【严格】块正则切一刀，切不到再退回宽容版。次序承重（codex 复核 FINDING）：宽容版的
    // `<\/\1\s*>` 会被【值里】一个 `</JSONPatch >` 骗停 —— 而 MVU 根本不认那个带空格的东西、照常读到
    // 整块。先严格后宽容 = 只要 MVU 读得到，我们就跟它读到同一段；MVU 也读不到时才轮到宽容版去救场。
    const m = /<(json_?patch)>(?:\s*```.*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/i.exec(s)
        || /<(json_?patch)\s*>([\s\S]*?)<\/\1\s*>/i.exec(s);
    if (!m) return null;
    const body = m[2].replace(/^\s*```[^\n]*\n?/, '').replace(/```\s*$/, '').trim();
    try { return { m, inner: m[2], ops: JSON.parse(body) }; }
    catch (e) { return { m, inner: m[2], ops: null }; }
}

// 纯函数：值的类型对不对得上（⑨ 的启发式提示，不是判决）。任一侧 null/undefined → 不表态（MVU 明文
// 允许把数值字段设成 null）。数字 ↔ 【整串都是数字】的字符串不算不符：MVU 自己会强转。可单测。
export function diagTypeMismatch(cur, val) {
    if (cur == null || val == null) return false;
    const kind = (v) => (Array.isArray(v) ? 'array' : typeof v);
    const a = kind(cur), b = kind(val);
    if (a === b) return false;
    const numish = (v) => (typeof v === 'number' ? true
        : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim()))));
    if (numish(cur) && numish(val)) return false;
    return true;
}

/* ── 🩺 1.77.3：schema 感知的两条判定 ────────────────────────────────────────────
 * 我们手里【本来就有】那份 schema —— applyFix / autoApplyFix 的 snapshot 就是整份 MvuData，
 * 里面的 .schema 从 1.67.0 起一直没人看过。而 MVU 的 generateSchema 默认把每一个对象【和】数组都
 * 标成 extensible:false（除非卡片写了 $meta.extensible / recursiveExtensible / $__META_EXTENSIBLE__$），
 * 于是「往没标可扩展的容器里新增一个键」是一条【可预测】的失败 —— 1.77.2 之前它被判 'creates' →
 * 落进 residual → 文案甩锅给「酒馆助手版本偏旧 / mvu_zod」（2026-09-06 Discord 报障那一张）。
 * 【红线】schema 缺席、或不是普通对象（mvu_zod 每轮把它设成字符串 '没有用别管这个'）时，这两条判定
 * 一律不启用 —— 判定权那时不在 MVU 原生执行器手里，行为必须与 1.77.2 逐字节相同。
 */

// 纯函数：按 MVU 的 getSchemaForPath（schema.ts:209）逐段走 schema 树。纯数字段 → 数组节点的
// elementType；其余 → 对象节点的 properties[段]；走不到回 null（null 在 MVU 那边 = 【不做】schema
// 检查，只剩父路径存在性那道闸）。空段数组 = 根节点。可单测。
export function diagSchemaNodeAt(schema, segs) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
    let node = schema;
    for (const seg of (segs || [])) {
        if (!node || typeof node !== 'object') return null;
        const s = String(seg);
        if (/^\d+$/.test(s)) {
            if (node.type === 'array' && node.elementType) node = node.elementType;
            else return null;
        } else if (node.type === 'object' && node.properties && node.properties[s]) {
            node = node.properties[s];
        } else return null;
    }
    return (node && typeof node === 'object') ? node : null;
}

// 纯函数：MVU 的 add 执行器（update_variables.ts:1324，= JSONPatch 的 delta）认不认这个【现值】。
// 认：数字 / VWD 对的第一格是数字 / Date 对象 / 「new Date 解析得动且不是纯数字串」的字符串（按毫秒加减）。
// 都不是 → addUnsupportedValue 报错跳过，一个字都写不进去。可单测。
export function diagDeltaTargetOk(cur) {
    const v = mvuIsVwdPair(cur) ? cur[0] : cur;
    if (typeof v === 'number') return true;
    if (Object.prototype.toString.call(v) === '[object Date]') return true;
    if (typeof v === 'string') {
        const d = new Date(v);
        return !isNaN(d.getTime()) && isNaN(Number(v));   // 纯数字串【有意】不算日期（源码原话）
    }
    return false;
}

