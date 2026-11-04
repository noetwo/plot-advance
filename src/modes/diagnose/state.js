// diagnose 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let diagStatData = '';
export function setDiagStatData(value) { diagStatData = value; return diagStatData; }

export let diagLatestUpdate = '';
export function setDiagLatestUpdate(value) { diagLatestUpdate = value; return diagLatestUpdate; }

export let diagEntrySel = {};
export function setDiagEntrySel(value) { diagEntrySel = value; return diagEntrySel; }

export let mvuedDirty = new Map();
export function setMvuedDirty(value) { mvuedDirty = value; return mvuedDirty; }

export let mvuedOpenData = null;
export function setMvuedOpenData(value) { mvuedOpenData = value; return mvuedOpenData; }

export let mvuedSchemaCache = null;
export function setMvuedSchemaCache(value) { mvuedSchemaCache = value; return mvuedSchemaCache; }

export let mvuedActiveTab = 0;
export function setMvuedActiveTab(value) { mvuedActiveTab = value; return mvuedActiveTab; }

export let mvuedKindOverrides = null;
export function setMvuedKindOverrides(value) { mvuedKindOverrides = value; return mvuedKindOverrides; }

export let mvuedApplying = false;
export function setMvuedApplying(value) { mvuedApplying = value; return mvuedApplying; }

export let mvuedScanning = false;
export function setMvuedScanning(value) { mvuedScanning = value; return mvuedScanning; }

export let mvuedScanCtl = null;
export function setMvuedScanCtl(value) { mvuedScanCtl = value; return mvuedScanCtl; }

export let mvuedOpenChatKey = null;
export function setMvuedOpenChatKey(value) { mvuedOpenChatKey = value; return mvuedOpenChatKey; }

export let mvuedRefreshTimer = null;
export function setMvuedRefreshTimer(value) { mvuedRefreshTimer = value; return mvuedRefreshTimer; }

export let trainerLastRun = null;
export function setTrainerLastRun(value) { trainerLastRun = value; return trainerLastRun; }

export let trainerRulesForRender = [];
export function setTrainerRulesForRender(value) { trainerRulesForRender = value; return trainerRulesForRender; }

export let wiCustomRenderSeq = 0;
export function setWiCustomRenderSeq(value) { wiCustomRenderSeq = value; return wiCustomRenderSeq; }
export function nextWiCustomRenderSeq() { return ++wiCustomRenderSeq; }

export let soZodReadWarned = false;
export function setSoZodReadWarned(value) { soZodReadWarned = value; return soZodReadWarned; }
