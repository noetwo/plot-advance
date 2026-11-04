// lorebook 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let lbContextText = '';
export function setLbContextText(value) { lbContextText = value; return lbContextText; }

export let lbBookNames = [];
export function setLbBookNames(value) { lbBookNames = value; return lbBookNames; }

export let lbEntryFilter = {};
export function setLbEntryFilter(value) { lbEntryFilter = value; return lbEntryFilter; }

export let lbSelHydrated = false;
export function setLbSelHydrated(value) { lbSelHydrated = value; return lbSelHydrated; }

export let smartSelState = null;
export function setSmartSelState(value) { smartSelState = value; return smartSelState; }
