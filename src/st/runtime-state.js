// st 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let regexEngine = null;
export function setRegexEngine(value) { regexEngine = value; return regexEngine; }

export let worldInfoModule = null;
export function setWorldInfoModule(value) { worldInfoModule = value; return worldInfoModule; }

export let mvuApi = null;
export function setMvuApi(value) { mvuApi = value; return mvuApi; }

export let soMdConverter = null;
export function setSoMdConverter(value) { soMdConverter = value; return soMdConverter; }

export let scriptCore = null;
export function setScriptCore(value) { scriptCore = value; return scriptCore; }

export let personasModule = null;
export function setPersonasModule(value) { personasModule = value; return personasModule; }
