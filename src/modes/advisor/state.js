// advisor 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let advStatData = '';
export function setAdvStatData(value) { advStatData = value; return advStatData; }

export let planBarEl = null;
export function setPlanBarEl(value) { planBarEl = value; return planBarEl; }

export let pathEditDraft = null;
export function setPathEditDraft(value) { pathEditDraft = value; return pathEditDraft; }

export let nodeDetailJob = null;
export function setNodeDetailJob(value) { nodeDetailJob = value; return nodeDetailJob; }

export let planFloat = null;
export function setPlanFloat(value) { planFloat = value; return planFloat; }

export let planFloatSlot = null;
export function setPlanFloatSlot(value) { planFloatSlot = value; return planFloatSlot; }

export let soGuideText = '';
export function setSoGuideText(value) { soGuideText = value; return soGuideText; }

export let soGuideArmed = false;
export function setSoGuideArmed(value) { soGuideArmed = value; return soGuideArmed; }
