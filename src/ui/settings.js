import { CONN_PRESET_KEYS, connPresetIsCurrent, connPresetSnapshot, connPresetUpsert, getCtx, getSettings, renderConnPresets, renderModelBar, save, uiConfirm } from '../core/settings.js';

import { populateWiCustomBooks } from '../modes/diagnose/pickers.js';
import { fixUsePresetFor } from '../modes/fix/templates.js';
import { BUILTIN_JB_AUTHOR, BUILTIN_JB_LABEL, ENABLE_BUILTIN_JAILBREAK, SO_JB_SENTINEL } from '../presets/builtin-jailbreak.js';
import { subst } from '../presets/messages.js';
import { ENABLE_FIX_CUSTOM_TASK, ENABLE_SYSPROMPT_PRESET, ENABLE_WI_CUSTOM_PICK } from '../prompts/builtins.js';
import { P, PROMPT_DEFS, promptDef, promptIsCustom, promptProblems, promptRaw } from '../prompts/registry.js';
import { updateExtraParamsHint } from '../transport/direct.js';
import { openCuration } from './mode-shell.js';
import { advisorMode, builderMode, diagnoseMode, fixMode, lorebookMode } from '../core/oracle-modes.js';
import { modeBadge, win } from './refs.js';

export let promptEditId = 'chat.system';
let promptGroup = null;
let promptEditorOpen = false;

// ---------- 连接存档：一键切换（设置页的存档列表 + 输入框上方的切换栏共用）----------
function currentConnPreset(s = getSettings()) {
    const act = activeConnPreset(s);
    if (act && connPresetIsCurrent(act, s)) return act;   // 两个存档内容相同时，认最近用的那个
    return (s.connPresets || []).find((p) => connPresetIsCurrent(p, s)) || null;
}
// 最近一次载入 / 保存的存档（已被删掉则为 null）。
function activeConnPreset(s = getSettings()) {
    const n = s.connPresetActive;
    return n ? ((s.connPresets || []).find((p) => p.name === n) || null) : null;
}
// 当前连接对应哪个存档：四项全同 → 就是它（modified=false）；否则若最近用的存档还在 →
// 当前连接是在它的基础上改过的（modified=true）。直连以外的模式不对应任何存档。
export function connPresetState(s = getSettings()) {
    if (s.mode !== 'direct') return null;
    const exact = currentConnPreset(s);
    if (exact) return { preset: exact, modified: false };
    const act = activeConnPreset(s);
    return act ? { preset: act, modified: true } : null;
}
// 把当前的端点 / 密钥 / 模型 / 地址原样开关 / 高级选项与生成参数写回最近用的存档（位置不变）。
export function saveToActiveConnPreset() {
    const s = getSettings();
    const p = activeConnPreset(s);
    if (!p) return false;
    s.connPresets = connPresetUpsert(s.connPresets, { ...connPresetSnapshot(s), name: p.name });
    save();
    updateBadge();
    if (window.toastr) window.toastr.success(`已保存到「${p.name}」${s.model ? `（${s.model}）` : ''}`, '剧情推进', { timeOut: 1800 });
    return true;
}
// 当前连接改过、还没存回存档时，切换会把改动冲掉——先问一句。
async function confirmDiscardConnEdits() {
    const s = getSettings();
    const st = connPresetState(s);
    if (!st || !st.modified) return true;
    return uiConfirm(`当前连接改过（模型：${s.model || '未填'}），还没保存到「${st.preset.name}」。切换后这些改动会丢失，仍要切换吗？`);
}
// 模型名太长时只显示最后一段（anthropic/claude-opus-5.5 → claude-opus-5.5）。
export function shortModelName(m) {
    return String(m || '').split('/').pop();
}
// 切到某个连接存档。存档都是直连配置，所以顺带切到直连模式；设置面板建好了就同步表单。
export function applyConnPreset(name) {
    const s = getSettings();
    const p = (s.connPresets || []).find((x) => x.name === name);
    if (!p) return false;
    s.mode = 'direct';
    s.endpoint = p.endpoint || '';
    s.apiKey = p.apiKey || '';
    s.model = p.model || '';
    s.directRawUrl = !!p.rawUrl;   // 1.22.0：地址原样开关随存档走（旧存档缺省 = 关）
    for (const k of CONN_PRESET_KEYS) if (k in p) s[k] = p[k];   // 2.4.0：高级选项与生成参数随存档走
    s.connPresetActive = p.name;
    save();
    if (win) {
        const setVal = (sel, v) => { const el = win.querySelector(sel); if (el) el.value = v; };
        setVal('#so-mode', 'direct');
        setVal('#so-endpoint', s.endpoint);
        setVal('#so-apikey', s.apiKey);
        setVal('#so-model', s.model);
        const setChk = (sel, v) => { const el = win.querySelector(sel); if (el) el.checked = !!v; };
        setChk('#so-raw-url', s.directRawUrl);
        setChk('#so-direct-backend', s.directViaBackend);
        setVal('#so-temp', s.temperature);
        setVal('#so-maxtok', s.maxTokens);
        setChk('#so-stream', s.stream);
        setChk('#so-sendtemp', s.sendTemperature);
        updateExtraParamsHint();
        applyModeVisibility();
    }
    updateBadge();   // 顺带重画存档列表与切换栏
    return true;
}
export async function switchConnPreset(name) {
    if (!(await confirmDiscardConnEdits())) return;
    if (!applyConnPreset(name)) return;
    const p = (getSettings().connPresets || []).find((x) => x.name === name);
    if (window.toastr) window.toastr.info(`已切换到「${name}」${p && p.model ? `（${p.model}）` : ''}`, '剧情推进', { timeOut: 1800 });
}

// 设置「连接」页的存档选择：平时只占一行（当前在用的存档）；点开后在它下面【浮出】一个弹出框，盖在
// 下方内容上、不挤压页面（同酒馆「连接配置」那个下拉）：顶上是搜索框，下面每行一个存档，点哪个就用哪个、
// 选完收起，行尾可删除。点别处或按 Esc 收起。

   // 删存档会重画弹出框，搜索词留着别丢

export function applyModeVisibility() {
    const s = getSettings();
    win.querySelector('#so-direct-fields').style.display = s.mode === 'direct' ? '' : 'none';
    win.querySelector('#so-profile-fields').style.display = s.mode === 'profile' ? '' : 'none';
    // 转发 / 原样地址只对直连有意义；附加参数两种方式都用，所以留在高级选项里。
    const directAdv = win.querySelector('#so-direct-adv');
    if (directAdv) directAdv.style.display = s.mode === 'direct' ? '' : 'none';
    for (const b of win.querySelectorAll('#so-mode-seg [data-mode]')) b.classList.toggle('active', b.dataset.mode === s.mode);
}

export function updateWiHint() {
    const hint = win.querySelector('#so-wi-hint');
    if (!hint) return;
    const mode = win.querySelector('#so-wi').value;
    if (mode === 'st') {
        hint.textContent = '像主提示词一样扫描聊天：蓝色（常驻）条目始终注入，绿色（关键词）条目在其关键词匹配时注入。剧情推进侧聊最近几条问答（按世界书「扫描深度」）同样参与匹配。';
    } else if (mode === 'all') {
        hint.textContent = '无视关键词，发送所有已启用的世界书条目。适合做规划，但可能会消耗大量 token。';
    } else if (mode === 'char') {
        hint.textContent = '只扫描角色相关世界书（角色卡内嵌 + 角色绑定 + 本对话绑定），排除全局与人设世界书；蓝灯常驻 + 绿灯关键词匹配照常（含剧情推进侧聊最近问答）。';
    } else if (mode === 'custom') {
        hint.textContent = '剧情推进读世界书时只用你在下方勾选的条目——无视关键词与启用 / 禁用状态（开了混合模式会再加上已选书里当前触发的绿灯）。选择按【本聊天】记忆；一本书第一次进入范围时会按当前激活情况预选一份。变量规则条目（[mvu_update]）只喂诊断，这里不列出；token 估算不含混合模式追加与 EJS 展开。';
    } else {
        hint.textContent = '';
    }
    if (ENABLE_WI_CUSTOM_PICK) reflectWiCustomVisible(mode === 'custom');
}

// 🌐 自定义范围整块只在下拉为「自定义」时显示；显示时填充清单（它自己读 metadata，不依赖 onChatChanged 的先后）。
function reflectWiCustomVisible(on) {
    if (!win || !ENABLE_WI_CUSTOM_PICK) return;
    const box = win.querySelector('#so-wi-custom');
    if (!box) return;
    box.hidden = !on;
    if (on) populateWiCustomBooks(false);
}

export function updateBadge() {
    const s = getSettings();
    let label = '';
    if (s.mode === 'direct') {
        label = s.model || '未设置模型';
    } else {
        const p = getProfiles().find((x) => x.id === s.profileId);
        label = p ? p.name : '未选择配置文件';
    }
    modeBadge.textContent = label ? `· ${label}` : '';
    renderConnPresets();   // 当前在用的存档高亮跟着变
    renderModelBar();
}

export function getProfiles() {
    const ctx = getCtx();
    // Preferred: the service-filtered list (only types we can actually send to).
    try {
        const supported = ctx.ConnectionManagerRequestService?.getSupportedProfiles?.();
        if (Array.isArray(supported) && supported.length) return supported;
    } catch (e) {
        console.warn('[Story Oracle] getSupportedProfiles failed, falling back to raw profiles:', e);
    }
    // Fallback: raw saved profiles. Covers version differences and over-strict filtering.
    const raw = ctx.extensionSettings?.connectionManager?.profiles;
    return Array.isArray(raw) ? raw.filter((p) => p && p.id) : [];
}

function profilesStatus() {
    const ctx = getCtx();
    if (!ctx.ConnectionManagerRequestService) {
        return '当前 ST 版本未找到连接管理器 —— 请改用直连模式。';
    }
    const raw = ctx.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(raw) || raw.length === 0) {
        return '未找到已保存的配置文件。请先在 ST 的“连接配置文件”面板中创建一个（API 设置里的书签图标）。';
    }
    return '存在配置文件，但似乎没有兼容的。请尝试刷新按钮，或改用直连模式。';
}

export function refreshProfiles() {
    const s = getSettings();
    const sel = win.querySelector('#so-profile');
    const hint = win.querySelector('#so-profile-hint');
    const profiles = getProfiles();
    sel.innerHTML = '';
    if (!profiles.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '— 无 —';
        sel.appendChild(opt);
        if (hint) hint.textContent = profilesStatus();
        return;
    }
    if (hint) hint.textContent = '通过 ST 服务器转发（无 CORS）。新增配置文件后请点击刷新。';
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        sel.appendChild(opt);
    }
    if (s.profileId && profiles.some((p) => p.id === s.profileId)) {
        sel.value = s.profileId;
    } else {
        s.profileId = sel.value;
        save();
    }
    updateBadge();
}

/* ------------------------------------------------------------------ *
 * Chat Completion presets as system-prompt source
 *
 * A user can pick one of their saved Chat Completion presets; we flatten its
 * written (non-marker) prompt blocks into a single system prompt and use that
 * instead of the textarea. Markers (chat history, char description, world info,
 * etc.) are runtime-injection placeholders, so we skip them. Macros are left
 * intact — buildSystemPrompt() runs the whole thing through substituteParams().
 * ------------------------------------------------------------------ */
function getCompletionPresetManager() {
    const ctx = getCtx();
    try {
        if (typeof ctx.getPresetManager === 'function') {
            return ctx.getPresetManager('openai') || ctx.getPresetManager();
        }
    } catch (e) {
        console.warn('[Story Oracle] getPresetManager failed:', e);
    }
    return null;
}

function getCompletionPresetNames() {
    const pm = getCompletionPresetManager();
    if (!pm || typeof pm.getPresetList !== 'function') return [];
    let list;
    try { list = pm.getPresetList(); } catch (e) { return []; }
    if (!list) return [];
    const names = list.preset_names ?? list.presetNames;
    if (Array.isArray(names)) return names.filter(Boolean);
    if (names && typeof names === 'object') return Object.keys(names);
    if (Array.isArray(list.presets)) return list.presets.map((p) => p && p.name).filter(Boolean);
    return [];
}

function getPresetByName(name) {
    const pm = getCompletionPresetManager();
    if (!pm) return null;
    try {
        if (typeof pm.getCompletionPresetByName === 'function') {
            const p = pm.getCompletionPresetByName(name);
            if (p) return p;
        }
    } catch (e) { /* fall through */ }
    try {
        const list = pm.getPresetList?.();
        if (list && Array.isArray(list.presets)) {
            const nm = list.preset_names ?? list.presetNames;
            if (nm && typeof nm === 'object' && nm[name] != null) return list.presets[nm[name]];
            const hit = list.presets.find((p) => p && p.name === name);
            if (hit) return hit;
        }
    } catch (e) { /* ignore */ }
    return null;
}

// Best-effort name of the Chat Completion preset currently active in MAIN chat,
// for the curation mismatch warning. Returns '' if it can't be determined.
export function getActiveMainPresetName() {
    const pm = getCompletionPresetManager();
    if (!pm) return '';
    try { if (typeof pm.getSelectedPresetName === 'function') return pm.getSelectedPresetName() || ''; } catch (e) { /* */ }
    try {
        if (typeof pm.getSelectedPreset === 'function') {
            const v = pm.getSelectedPreset();
            if (typeof v === 'string') return v;
            const list = pm.getPresetList?.();
            const names = list && (list.preset_names ?? list.presetNames);
            if (names && typeof names === 'object' && !Array.isArray(names)) {
                for (const [n, i] of Object.entries(names)) if (i === v) return n;
            }
            if (Array.isArray(names) && typeof v === 'number') return names[v] || '';
        }
    } catch (e) { /* */ }
    return '';
}

// Flatten a Chat Completion preset's enabled, ordered, non-marker prompt blocks.
// SillyTavern's runtime-injection markers. Each is a positional slot that the
// faithful assembly fills with the Oracle's own context, in the preset's order.
const MARKER_IDS = new Set([
    'personaDescription', 'worldInfoBefore', 'charDescription', 'charPersonality',
    'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory',
]);

// Pull a preset's ordered block list. Returns [{ block, enabledInOrder }] in
// sequence (ALL blocks, enabled and disabled — the caller marks the disabled
// ones), or [] if unreadable.
function readPresetOrderedBlocks(preset) {
    if (!preset || !Array.isArray(preset.prompts)) return [];
    const byId = {};
    for (const p of preset.prompts) if (p && p.identifier) byId[p.identifier] = p;

    // The global prompt order. Real presets key it 100001 (older builds 100000);
    // pick whichever exists, else the longest order, else the first entry.
    let entry = null;
    if (Array.isArray(preset.prompt_order) && preset.prompt_order.length) {
        const po = preset.prompt_order;
        entry = po.find((e) => e && e.character_id === 100001)
             || po.find((e) => e && e.character_id === 100000)
             || po.slice().sort((a, b) => (b?.order?.length || 0) - (a?.order?.length || 0))[0]
             || po[0];
    }
    const order = entry && Array.isArray(entry.order) ? entry.order : null;
    if (!order) {
        // No usable order: fall back to prompt array order (treat all as enabled).
        return preset.prompts.filter(Boolean).map((b) => ({ block: b, enabledInOrder: true }));
    }
    const out = [];
    for (const o of order) {
        if (!o) continue;
        const b = byId[o.identifier];
        if (b) out.push({ block: b, enabledInOrder: o.enabled !== false });
    }
    return out;
}

// Strip every {{...}} macro (iteratively, to peel nesting) and trim — what
// remains is the block's visible literal text.
function visibleResidue(content) {
    let s = String(content || '');
    for (let i = 0; i < 6; i++) s = s.replace(/\{\{[^{}]*\}\}/g, '');
    return s.trim();
}

// Heuristic default keep/drop + category for one block. The user is the sole
// curator and reviews every row, so these are only the pre-checked defaults.
const SO_DROP_NAME = /(cot|思维链|思考模式|字数|禁词|禁用词|防打断|抢话|杀八股|杀超雄|超雄|杀比拟|杀揭示|杀说明|杀声述|白描|微观|通感|占有|支配|转折词|模型选择|特化|破限|文风|人称|视角|草稿|prism|core|油腻|谄媚|揣测|语气描写|防情绪|防复述|转述|推剧情|极端|全知|反全知|生动化|加强|复述|抗过拟合|抗绝望|抗抢话)/i;
const SO_KEEP_NAME = /(人格|情感|基调|世界|world|角色|故事|设定|主提示|主提示词|lore|背景|场景|情景)/i;

function classifyBlock(block) {
    if (block.marker || MARKER_IDS.has(block.identifier)) {
        return { keep: true, category: 'marker', note: '上下文插槽' };
    }
    const content = block.content || '';
    const role = block.role || 'system';
    const name = block.name || '';
    const residue = visibleResidue(content);
    const setCount = (content.match(/\{\{(setvar|setglobalvar)::/gi) || []).length;
    const hasSet = setCount > 0;
    const hasGet = /\{\{(getvar|getglobalvar)::/i.test(content);
    const hasLastMsg = /\{\{lastusermessage\}\}/i.test(content);
    const dropName = SO_DROP_NAME.test(name);
    const keepName = SO_KEEP_NAME.test(name);

    // Block that's *primarily* an echo of the RP's last user message — wrong for
    // the Oracle. Only when it's short/echo-dominated; a long structural block
    // that merely contains a {{lastusermessage}} slot is handled below.
    if (hasLastMsg && residue.length <= 60) {
        return { keep: false, category: 'user-echo', note: '回显主聊天输入' };
    }

    // Renders to nothing after macro substitution.
    if (!residue) {
        // The master variable initializer (大清洗 / 初始化变量) sets many keys and
        // is required so the kept blocks' getvars resolve. Detect by structure,
        // not name, and keep it.
        if (hasSet && !hasGet && setCount >= 15) {
            return { keep: true, category: 'machinery', note: '变量初始化（隐形・必留）' };
        }
        // Named output/CoT toggles (also implemented as invisible setvars) — drop
        // by default to match the user's expectation, even though harmless to keep.
        if (dropName) return { keep: false, category: 'output', note: '输出 / 思维链 / 反模式（隐形）' };
        if (keepName) return { keep: true, category: 'story', note: '故事 / 世界 / 人格（隐形）' };
        if (hasSet) return { keep: true, category: 'machinery', note: '变量控制（隐形）' };
        if (hasGet) return { keep: true, category: 'wrapper', note: '结构变量（隐形）' };
        return { keep: false, category: 'inert', note: '注释 / 空块' };
    }
    // Voice prefills carried as assistant/user turns — drop regardless of any
    // stray brackets in their text (checked before the wrapper heuristic).
    if (role === 'assistant' || role === 'user') {
        return { keep: false, category: 'prefill', note: `${role} 起手` };
    }
    // Has visible literal text but it's mostly structural tags/banners (short,
    // bracket-heavy) -> a system wrapper around a marker; keep for faithfulness.
    const looksStructural = residue.length <= 120 && /[<>\[\]]/.test(residue);
    if (looksStructural && !dropName) return { keep: true, category: 'wrapper', note: '包裹标签' };

    if (block.identifier === 'main') return { keep: true, category: 'story', note: '主提示' };
    if (dropName) return { keep: false, category: 'output', note: '输出 / 思维链 / 反模式' };
    if (keepName) return { keep: true, category: 'story', note: '故事 / 世界 / 人格' };
    return { keep: true, category: 'review', note: '未分类 · 请确认' };
}

// Build the curation row model for a preset (live read). Markers included.
// Every block in the preset's prompt order becomes a row so the list mirrors
// ST's prompt manager 1:1 — including blocks that are currently DISABLED in the
// order (shown, marked 停用, and unchecked by default) and ones whose content is
// empty (tagged inert) so nothing silently disappears.
export function buildCurationRows(name) {
    const preset = getPresetByName(name);
    const ordered = readPresetOrderedBlocks(preset);
    const rows = [];
    for (const { block, enabledInOrder } of ordered) {
        const isMarker = !!block.marker || MARKER_IDS.has(block.identifier);
        const content = block.content || '';
        const c = classifyBlock(block);
        const disabled = enabledInOrder === false;
        rows.push({
            identifier: block.identifier,
            name: (block.name || block.identifier || '').trim(),
            role: block.role || 'system',
            kind: isMarker ? 'marker' : 'text',
            content,
            chars: content.length,
            // A block the preset author turned off defaults to unchecked; the user
            // can still opt it in. Enabled blocks use the classifier default.
            keep: disabled ? false : c.keep,
            disabled,
            category: c.category,
            note: c.note,
        });
    }
    return rows;
}

// Freeze the user's curated selection (kept rows, in their final order).
export function snapshotFromRows(rows) {
    const items = rows.filter((r) => r.keep).map((r) => (
        r.kind === 'marker'
            ? { kind: 'marker', identifier: r.identifier, name: r.name }
            : { kind: 'text', identifier: r.identifier, name: r.name, role: r.role, content: r.content }
    ));
    return { items, curatedAt: Date.now() };
}

// 「重新挑选」的行表 = 以【已保存的快照】为真相重建（1.88.0）。报障：再点重新挑选打开时永远是分类器默认勾选，
// 像是根本没保存（保存其实一直生效——组装走 curatedPresets——只是弹窗从不回显它）；用户于是再存一遍，把默认勾选
// 盖回自己的真实选择。口径：
//   · 勾选行 = 快照条目、按快照顺序；正文 / 角色取【冻结版】（活预设的改动不许漏进来，同 curatedPresets 的初衷；
//     想要预设的新正文 → 「重置默认」）；停用标记 / 分类沿用现读行（只是显示）。
//   · 未勾选行 = 现读行里没被快照认领的，恒不勾，插在它在预设顺序里最近的前驱之后（无前驱 → 排最前）。
//   · 预设里已删掉、快照里还在用的块 → 仍以勾选行出现（它确实在用，丢掉就等于悄悄改了用户的组装）。
// 认领按 kind + identifier（无 identifier 的旧快照退回 name），每条现读行只认领一次。
// 于是「打开后原样保存」= 快照逐项相同。空 / 坏快照 → 原样返回现读行。纯函数，不改入参。
export function curationRowsFromSnapshot(freshRows, snap) {
    const fresh = Array.isArray(freshRows) ? freshRows : [];
    const items = (snap && Array.isArray(snap.items)) ? snap.items : [];
    if (!items.length) return fresh.slice();
    const keyOf = (kind, identifier, name) => `${kind}\u0000${identifier != null && identifier !== '' ? identifier : '\u0001' + (name || '')}`;
    const claimed = new Map();   // fresh 下标 → 输出行
    const out = [];
    for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const kind = it.kind === 'marker' ? 'marker' : 'text';
        const k = keyOf(kind, it.identifier, it.name);
        const idx = fresh.findIndex((r, i) => !claimed.has(i) && keyOf(r.kind, r.identifier, r.name) === k);
        const base = idx >= 0 ? fresh[idx] : null;
        let r;
        if (kind === 'marker') {
            r = base ? { ...base, name: it.name || base.name, keep: true } : {
                identifier: it.identifier, name: it.name || it.identifier || '', role: 'system', kind: 'marker',
                content: '', chars: 0, keep: true, disabled: false, category: 'marker', note: '上下文插槽',
            };
        } else {
            const content = String(it.content == null ? '' : it.content);
            const role = it.role || 'system';
            const c = base ? null : classifyBlock({ identifier: it.identifier, name: it.name, role, content });
            r = {
                ...(base || { disabled: false, category: c.category, note: c.note }),
                identifier: it.identifier, name: it.name || (base && base.name) || '', role, kind: 'text',
                content, chars: content.length, keep: true,
            };
        }
        if (idx >= 0) claimed.set(idx, r);
        out.push(r);
    }
    fresh.forEach((fr, i) => {
        if (claimed.has(i)) return;
        const r = { ...fr, keep: false };
        let at = 0;
        for (let j = i - 1; j >= 0; j--) {
            const prev = claimed.get(j);
            const pos = prev ? out.indexOf(prev) : -1;
            if (pos >= 0) { at = pos + 1; break; }
        }
        out.splice(at, 0, r);
        claimed.set(i, r);
    });
    return out;
}

export function getCuratedSnapshot(s, name) {
    const cp = s.curatedPresets;
    return (cp && typeof cp === 'object' && cp[name]) || null;
}

// Is a curated preset the active system-prompt source right now?
export function presetCurationActive(s) {
    if (!ENABLE_SYSPROMPT_PRESET || !s.sysPromptPresetName) return false;
    if (s.sysPromptPresetName === SO_JB_SENTINEL) return false;   // 内置破限走【包裹】不走替换，绝不能被当成策展预设
    const snap = getCuratedSnapshot(s, s.sysPromptPresetName);
    return !!(snap && Array.isArray(snap.items) && snap.items.length);
}

/* ---------------- 内置破限：判定 + 包裹（纯函数，便于单测） ---------------- */

// 用户当前是否选了内置破限（＝下拉里那个哨兵）。
function builtinJbActive(s) {
    return !!(ENABLE_BUILTIN_JAILBREAK && s && s.sysPromptPresetName === SO_JB_SENTINEL);
}

// 当前是哪个模式（给 modeWantsJb 用）。
export function currentJbModeKey() {
    if (diagnoseMode) return 'diagnose';
    if (lorebookMode) return 'lorebook';
    if (advisorMode) return 'advisor';
    if (builderMode) return 'builder';
    if (fixMode) return 'fixManual';
    return 'chat';
}

// 本模式要不要套破限。Prince 2026-07-26 定案：
//   · 普通聊天 = 默认开（选了内置破限就生效，不需要再勾任何东西）
//   · 其余模式 = 一律 opt-in，复用各自【已有的】「经自定义补全预设」开关，默认关
//   · 诊断 = 1.43.0 起也 opt-in（原判据「无拒绝面」不成立：诊断读的是主聊天正文，
//     内容敏感时带审查的模型照样会拒绝这次审计）。默认仍关。
// 复用旧开关而不新增五个复选框：语义就是「这个模式也走我选的那个『预设』」，内置破限
// 只是下拉里的一个选项，语义天然一致；也不必为此再教用户一套新概念。
function modeWantsJb(s, mode) {
    if (!builtinJbActive(s)) return false;
    switch (mode) {
        case 'chat': return true;
        case 'diagnose': return !!s.diagnoseUsePreset;
        case 'lorebook': return !!s.lorebookUsePreset;
        case 'advisor': return !!s.advisorUsePreset;
        case 'builder': return !!s.bldUsePreset;
        case 'fixManual': return fixUsePresetFor(s, 'manual');
        case 'fixAuto': return fixUsePresetFor(s, 'auto');
        case 'fixCustom': return ENABLE_FIX_CUSTOM_TASK && fixUsePresetFor(s, 'custom');
        default: return false;
    }
}

// 把破限层【包裹】在一组已建好的消息外面。纯函数，不改入参。
// 两块都含 {{user}}（JB_CORE 里还有 auth: {{user}}=root）→ 必须跑 substituteParams，
// 否则字面 {{user}} 直达模型（现有预设通道在 buildPresetMessages 里也是这么做的）。
// 1.2 起作者删掉了 main，包裹只剩 core + tail（见顶部注释）。
function wrapBuiltinJb(messages, ctx) {
    const inner = Array.isArray(messages) ? messages : [];
    if (!ENABLE_BUILTIN_JAILBREAK) return inner;
    return [
        { role: 'system', content: subst(ctx, P('jb.core')) },
        ...inner,
        { role: 'system', content: subst(ctx, P('jb.tail')) },
    ];
}

// 布线糖：本模式该套就套、不该套原样返回。所有接线点都走它，保证判定只有一处。
export function maybeWrapJb(messages, mode, s) {
    const st = s || getSettings();
    return modeWantsJb(st, mode) ? wrapBuiltinJb(messages, getCtx()) : messages;
}




export function populateSysPromptPresets() {
    const wrap = win.querySelector('#so-sysprompt-preset-wrap');
    if (!ENABLE_SYSPROMPT_PRESET) {
        if (wrap) wrap.style.display = 'none';
        const ta = win.querySelector('#so-sysprompt');
        if (ta) ta.disabled = false;   // never leave the textarea locked while dormant
        return;
    }
    if (wrap) wrap.style.display = '';
    const sel = win.querySelector('#so-sysprompt-preset');
    if (!sel) return;
    const s = getSettings();
    const names = getCompletionPresetNames();
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— 自定义（使用下方文本框）—';
    sel.appendChild(none);
    // 内置破限置顶（紧跟「自定义」）。它不是 ST 的预设，所以不在 names 里，下面的存活校验必须豁免它。
    if (ENABLE_BUILTIN_JAILBREAK) {
        const jb = document.createElement('option');
        jb.value = SO_JB_SENTINEL;
        jb.textContent = BUILTIN_JB_LABEL;
        sel.appendChild(jb);
    }
    for (const n of names) {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        sel.appendChild(opt);
    }
    // Restore selection only if the saved preset still exists.
    if (builtinJbActive(s)) {
        sel.value = SO_JB_SENTINEL;   // 哨兵永远有效：它不来自 ST 预设表，不受「预设被删」影响
    } else if (s.sysPromptPresetName && names.includes(s.sysPromptPresetName)) {
        sel.value = s.sysPromptPresetName;
    } else {
        // 预设被删 / 改名 → 清空。这里补上迁移的时序陷阱：迁移在 init 跑，那时这些人的名字
        // 还“存在”，会被当成第二类跳过；等到开窗才被清成 ''，就再也拿不到内置版了。
        // 迁移已跑过（打了标记）而人落到这一步 ＝ 正是那批人，直接给内置破限。
        if (s.sysPromptPresetName) {
            s.sysPromptPresetName = (ENABLE_BUILTIN_JAILBREAK && s.builtinJbMigrated) ? SO_JB_SENTINEL : '';
            save();
        }
        sel.value = s.sysPromptPresetName || '';
    }
    applyPromptEditorUiState();
}

export function applySysPromptPresetUiState() {
    const s = getSettings();
    const ta = win.querySelector('#so-sysprompt');
    const hint = win.querySelector('#so-sysprompt-preset-hint');
    const recurate = win.querySelector('#so-sysprompt-preset-recurate');
    const active = !!s.sysPromptPresetName;
    // When a preset is selected, the chat textarea (and the built-in short prompt
    // it holds) is fully disabled — no fallback, per design. The textarea is now
    // shared across edit modes, though, so only disable it while CHAT is the mode
    // being edited (a preset only ever replaces the chat prompt).
    // 内置破限是【包裹】不是替换——神谕自己的提示词照常在用，所以文本框不该被停用，
    // 也没有「重新挑选」可点（块选择已冻结）。
    const jbOn = builtinJbActive(s);
    if (ta) ta.disabled = active && !jbOn && promptEditId === 'chat.system';
    if (recurate) recurate.style.display = (active && !jbOn) ? '' : 'none';
    if (!hint) return;
    hint.classList.remove('so-hint-error');
    if (jbOn) {
        hint.textContent = `已启用内置破限「初心破限 1.2」（作者：${BUILTIN_JB_AUTHOR}）。`
            + `它【包裹】在剧情推进自己的提示词外面，而不是替换——下方文本框照常生效。`
            + `默认只作用于【普通聊天】；世界书 / 参谋 / 工坊访谈 / 校正 / 诊断 需各自在其设置里勾选「经自定义补全预设」才会套用。`
            + `随时可在此下拉换回「自定义」或你自己的预设。`;
        return;
    }
    if (!active) {
        const have = getCompletionPresetNames().length;
        hint.textContent = have
            ? '选择一个补全预设并挑选要保留的块；剧情推进会按预设的原始结构（角色卡 / 世界书 / 上下文插槽 + 各块角色）忠实组装。选「自定义」则使用下方文本框。'
            : '未找到已保存的补全预设。请先在 ST 的“预设”里保存一个，然后点刷新。';
        return;
    }
    const snap = getCuratedSnapshot(s, s.sysPromptPresetName);
    if (snap && Array.isArray(snap.items) && snap.items.length) {
        const texts = snap.items.filter((i) => i.kind === 'text').length;
        const slots = snap.items.filter((i) => i.kind === 'marker').length;
        hint.textContent = `正在按预设「${s.sysPromptPresetName}」的忠实结构组装：保留 ${texts} 个文本块 + ${slots} 个上下文插槽。下方文本框（含内置简短提示词）已停用。点[重新挑选]可修改。`;
    } else {
        hint.textContent = `预设「${s.sysPromptPresetName}」尚未挑选内容。点[重新挑选]开始，或重新从下拉中选择以打开挑选界面。`;
        hint.classList.add('so-hint-error');
    }
}

// 设置「提示词」页：先选分组，再点条目；点开的条目下面展开编辑区（共用一个文本框 #so-sysprompt）。
// 每条都带一句说明（PROMPT_DEFS 的 desc），改过的条目和分组都会标出来。
// 分组按注册表里出现的先后排列（用到时再算：PROMPT_DEFS 定义在文件后面）。
function promptGroups() {
    return [...new Set(PROMPT_DEFS.map((d) => d.group))];
}
          // 当前展开的分组；null = 跟随正在编辑的那条
    // 编辑区是否展开（点同一条可以收起）

function promptCustomCount(group, s = getSettings()) {
    return PROMPT_DEFS.filter((d) => (!group || d.group === group) && promptIsCustom(d.id, s)).length;
}

export function renderPromptNav() {
    if (!win) return;
    const groupsEl = win.querySelector('#so-pgroups');
    const listEl = win.querySelector('#so-plist');
    const ed = win.querySelector('#so-peditor');
    if (!groupsEl || !listEl || !ed) return;
    const s = getSettings();
    if (!promptDef(promptEditId)) promptEditId = 'chat.system';
    const groups = promptGroups();
    if (!groups.includes(promptGroup)) promptGroup = promptDef(promptEditId).group;

    groupsEl.innerHTML = '';
    for (const g of groups) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'so-pgroup' + (g === promptGroup ? ' active' : '');
        b.dataset.group = g;
        b.textContent = g;
        const n = promptCustomCount(g, s);
        if (n) {
            const c = document.createElement('span');
            c.className = 'so-pgroup-count';
            c.title = `本组已自定义 ${n} 条`;
            c.textContent = String(n);
            b.appendChild(c);
        }
        b.addEventListener('click', () => { promptGroup = g; renderPromptNav(); });
        groupsEl.appendChild(b);
    }

    // 编辑区是常驻元素：重建列表前先把它挪出来，免得跟着 innerHTML 一起被清掉。
    ed.hidden = true;
    listEl.after(ed);
    listEl.innerHTML = '';
    for (const d of PROMPT_DEFS.filter((x) => x.group === promptGroup)) {
        const active = promptEditorOpen && d.id === promptEditId;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'so-pitem' + (active ? ' active' : '');
        item.dataset.id = d.id;
        item.innerHTML = '<span class="so-pitem-head"><span class="so-pitem-label"></span><span class="so-pbadge" hidden>已自定义</span></span><span class="so-pitem-desc"></span>';
        item.querySelector('.so-pitem-label').textContent = d.label;
        item.querySelector('.so-pbadge').hidden = !promptIsCustom(d.id, s);
        const desc = item.querySelector('.so-pitem-desc');
        if (d.desc) desc.textContent = d.desc; else desc.remove();
        item.addEventListener('click', () => {
            if (promptEditorOpen && promptEditId === d.id) { promptEditorOpen = false; renderPromptNav(); return; }
            promptEditId = d.id;
            promptEditorOpen = true;
            loadPromptEditor();
            renderPromptNav();
            const box = win.querySelector('#so-sysprompt');
            if (box && !box.disabled) { box.focus(); box.setSelectionRange(0, 0); box.scrollTop = 0; }
        });
        listEl.appendChild(item);
        if (active) {
            item.after(ed);
            ed.hidden = false;
        }
    }
    refreshPromptBadges();
}

// 只刷新「已自定义」标记与计数（编辑时每敲一个字都会调用，不能重建列表——那样会把文本框的焦点弄丢）。
export function refreshPromptBadges() {
    if (!win) return;
    const s = getSettings();
    for (const item of win.querySelectorAll('#so-plist .so-pitem')) {
        const badge = item.querySelector('.so-pbadge');
        if (badge) badge.hidden = !promptIsCustom(item.dataset.id, s);
    }
    for (const b of win.querySelectorAll('#so-pgroups .so-pgroup')) {
        const n = promptCustomCount(b.dataset.group, s);
        let c = b.querySelector('.so-pgroup-count');
        if (n && !c) {
            c = document.createElement('span');
            c.className = 'so-pgroup-count';
            b.appendChild(c);
        }
        if (c) {
            if (n) { c.textContent = String(n); c.title = `本组已自定义 ${n} 条`; } else c.remove();
        }
    }
    const sum = win.querySelector('#so-prompt-summary');
    if (sum) {
        const total = promptCustomCount(null, s);
        sum.textContent = total ? `已自定义 ${total} 条` : '全部为内置版本';
    }
}

// 把编辑区指向当前条目：标题、正文、可插入的变量、提示行。
export function loadPromptEditor() {
    const ta = win && win.querySelector('#so-sysprompt');
    if (!ta) return;
    const d = promptDef(promptEditId);
    if (!d) return;
    ta.value = promptRaw(promptEditId);
    const title = win.querySelector('#so-peditor-title');
    if (title) title.textContent = `${d.group} · ${d.label}`;
    const varsEl = win.querySelector('#so-pvars');
    if (varsEl) {
        varsEl.innerHTML = '';
        const vars = Object.entries(d.vars || {});
        if (vars.length) {
            const lead = document.createElement('span');
            lead.textContent = '点一下插入变量：';
            varsEl.appendChild(lead);
            for (const [k, label] of vars) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'so-pvar';
                b.title = label;
                b.textContent = `{%${k}%}`;
                const small = document.createElement('small');
                small.textContent = label;
                b.appendChild(small);
                b.addEventListener('click', () => {
                    if (ta.disabled) return;
                    const ins = `{%${k}%}`;
                    const a = ta.selectionStart ?? ta.value.length;
                    const z = ta.selectionEnd ?? a;
                    ta.setRangeText(ins, a, z, 'end');
                    ta.focus();
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                });
                varsEl.appendChild(b);
            }
        }
    }
    applyPromptEditorUiState();
}

// 编辑区的状态：普通聊天的系统提示词在选了补全预设时停用；提示行写明内置 / 已自定义、条目说明、
// 变量规则，缺了必需变量或格式契约时标红。
export function applyPromptEditorUiState() {
    const d = promptDef(promptEditId);
    if (!d || !win) return;
    const ta = win.querySelector('#so-sysprompt');
    const hint = win.querySelector('#so-sysprompt-which-hint');
    if (d.id === 'chat.system') applySysPromptPresetUiState();   // 选了补全预设时停用文本框
    else if (ta) ta.disabled = false;
    if (!hint) return;
    const s = getSettings();
    const text = ta ? ta.value : promptRaw(d.id, s);
    const lines = [promptIsCustom(d.id, s)
        ? '已自定义。点「↺ 恢复默认」可回到内置版本。'
        : '这是内置版本，可直接修改；没改过的条目会随扩展更新自动改进。'];
    if (d.note) lines.push(d.note);
    if (Object.keys(d.vars || {}).length) {
        lines.push('一行里的变量都为空时整行省略；{%#变量%}…{%/变量%} 只在变量非空时保留，{%^变量%}…{%/变量%} 只在变量为空时保留。{{user}} 等酒馆宏照常可用。');
    }
    const problems = promptProblems(d.id, text).map((x) => `缺少 ${x}`);
    if (/^inject\.pace\./.test(d.id)) {
        const phrases = ['seed', 'normal', 'push'].map((k) => P('inject.pace.' + k, null, s).trim());
        if (new Set(phrases).size < phrases.length) problems.push('三档节奏句有重复——换档时分不清是哪一档');
    }
    if (problems.length) lines.push(`⚠ ${problems.join('；')}。这条对应的引导 / 解析会失效，可点「↺ 恢复默认」。`);
    hint.textContent = lines.join('\n');
    hint.classList.toggle('so-hint-error', problems.length > 0);
}

// Dropdown change: gate curation. Empty -> custom/textarea. Already-curated ->
// use it. New -> open the checklist; commit only when the user saves.
export function onPresetSelected(rawName) {
    const s = getSettings();
    const name = rawName || '';
    if (!name) {
        s.sysPromptPresetName = '';
        save();
        applySysPromptPresetUiState();
        updateBadge();
        return;
    }
    // 内置破限：块选择已冻结（就那三块），没有可策展的东西 → 跳过策展弹窗，直接落盘。
    if (ENABLE_BUILTIN_JAILBREAK && name === SO_JB_SENTINEL) {
        s.sysPromptPresetName = SO_JB_SENTINEL;
        save();
        applySysPromptPresetUiState();
        updateBadge();
        return;
    }
    if (getCuratedSnapshot(s, name)) {
        s.sysPromptPresetName = name;
        save();
        applySysPromptPresetUiState();
        updateBadge();
        return;
    }
    // Not curated yet — open the checklist. Revert the dropdown to the committed
    // value until the user actually saves a curation.
    const sel = win.querySelector('#so-sysprompt-preset');
    if (sel) sel.value = s.sysPromptPresetName || '';
    openCuration(name);
}