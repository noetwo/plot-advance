// builder 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let bldContextText = '';
export function setBldContextText(value) { bldContextText = value; return bldContextText; }

export let bldScanWiText = '';
export function setBldScanWiText(value) { bldScanWiText = value; return bldScanWiText; }

export let bldBookNames = [];
export function setBldBookNames(value) { bldBookNames = value; return bldBookNames; }

export let bldStatData = '';
export function setBldStatData(value) { bldStatData = value; return bldStatData; }

export let bldEntryFilter = {};
export function setBldEntryFilter(value) { bldEntryFilter = value; return bldEntryFilter; }

export let bldSelHydrated = false;
export function setBldSelHydrated(value) { bldSelHydrated = value; return bldSelHydrated; }
