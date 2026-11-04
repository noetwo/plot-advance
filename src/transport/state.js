// transport 领域拥有的模块级可变绑定；跨模块写入必须经过下列命令函数。
export let soLastFinishReason = '';
export function setSoLastFinishReason(value) { soLastFinishReason = value; return soLastFinishReason; }
