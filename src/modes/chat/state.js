// chat 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let worldInfoBlock = '';
export function setWorldInfoBlock(value) { worldInfoBlock = value; return worldInfoBlock; }

export let wiBefore = '';
export function setWiBefore(value) { wiBefore = value; return wiBefore; }

export let wiAfter = '';
export function setWiAfter(value) { wiAfter = value; return wiAfter; }

export let chatStatData = '';
export function setChatStatData(value) { chatStatData = value; return chatStatData; }

export let chatWorldData = '';
export function setChatWorldData(value) { chatWorldData = value; return chatWorldData; }

export let lwbSummaryCache = '';
export function setLwbSummaryCache(value) { lwbSummaryCache = value; return lwbSummaryCache; }

export let soConvoImportInputEl = null;
export function setSoConvoImportInputEl(value) { soConvoImportInputEl = value; return soConvoImportInputEl; }
