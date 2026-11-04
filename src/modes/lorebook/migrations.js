import { ENABLE_BUILTIN_JAILBREAK, SO_JB_SENTINEL } from '../../presets/builtin-jailbreak.js';
import { presetCurationActive } from '../../ui/settings.js';

// 存档迁移（Tier 0 ④，1.25.0，Prince 定案「重置 + 告知」）：1.24.0 把手动校正默认改成精简上下文，但 getSettings
// 只补【缺失】键——老档里已落盘的旧默认（-1 全部前文 / 世界书开 / 概要开）会永远保留，而他们正是高上下文投诉高发
// 人群。只翻【仍等于旧默认值】的键（用户自定义的 30 层等不动）；fixLeanMigrated 打标防重跑；想全量的用户在
// 「校正设置」把前文条数改回 -1 即可（迁移提示里写明）。init 里在 buildWindow 之前调用一次 + 弹一次告知。纯函数、可单测。
export function migrateFixLeanDefaults(s) {
    if (!s || typeof s !== 'object' || s.fixLeanMigrated) return { migrated: false, hit: [] };
    s.fixLeanMigrated = true;
    const hit = [];
    if (s.fixM_contextDepth === -1) { s.fixM_contextDepth = 0; hit.push('前文'); }
    if (s.fixM_includeWorld === true) { s.fixM_includeWorld = false; hit.push('世界书'); }
    if (s.fixM_includeSummary === true) { s.fixM_includeSummary = false; hit.push('剧情概要'); }
    return { migrated: hit.length > 0, hit };
}

/* 一次性迁移（1.40.0）：把「没选任何预设」的用户预选到内置破限。Prince 2026-07-26 定案：
 *   · 新装 / 从没设过预设 / 选了但没策展完 → 预选内置破限（普通聊天即刻生效）
 *   · 已选了预设【且】真的策展过 → 完全不动（选择不碰、开关不碰）
 * 参谋的开关（advisorUsePreset）【不动】＝ 保持 opt-in，所以本函数只碰 sysPromptPresetName 一个键。
 *
 * 【不能靠改默认值实现】：getSettings 只补 undefined 的键，而老用户的 sysPromptPresetName
 * 已经显式落盘成 ''，永远轮不到默认值。必须显式迁移。
 *
 * 「选了但没策展完」归入第一类：那种半选状态本就 presetCurationActive()===false ＝ 等于没生效，
 * 设置行还会显红字报错，不是「有效且已策展的预设」。
 *
 * ⚠ 时序陷阱见 populateSysPromptPresets：预设被删 / 改名的用户，名字要到【开窗时】才被清成 ''，
 * 那时本迁移早已跑完并打了标记，他们会被漏掉——所以那边清空时会补判一次。
 * 纯函数、可单测。
 */
export function migrateBuiltinJbDefault(s) {
    if (!ENABLE_BUILTIN_JAILBREAK) return { migrated: false };
    if (!s || typeof s !== 'object' || s.builtinJbMigrated) return { migrated: false };
    s.builtinJbMigrated = true;
    // 「有效且已策展」＝ 名字非空【且】快照里真有内容。只有这一类完全不动。
    if (s.sysPromptPresetName && presetCurationActive(s)) return { migrated: false };
    s.sysPromptPresetName = SO_JB_SENTINEL;
    return { migrated: true };
}
