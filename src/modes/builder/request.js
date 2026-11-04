import { callDirect, callProfile, callProfileStream, resolveEndpointUrl, streamDirect } from '../../transport/direct.js';

const DEFAULT_TRANSPORT = { callDirect, callProfile, callProfileStream, resolveEndpointUrl, streamDirect };

// 工坊的直连 / 配置文件请求分派。传入显式 signal 与文本回调，便于锻造、精简共用并由真实 ESM 测试固定参数矩阵。
// onText 的 cumulative 标志区分直连增量与配置文件累计全文；非流式时不调用。
export async function dispatchBuilderRequest(settings, messages, maxTokens, signal, onText, options = {}) {
    const transport = options.transport || DEFAULT_TRANSPORT;
    const useStream = options.stream === undefined ? settings.stream : options.stream;
    if (settings.mode === 'direct') {
        const body = { model: settings.model, messages, max_tokens: maxTokens };
        if (settings.sendTemperature) body.temperature = settings.temperature;
        const url = transport.resolveEndpointUrl(settings);
        if (useStream) {
            return transport.streamDirect(url, settings.apiKey, body, signal, (delta) => {
                if (onText) onText(delta, false);
            });
        }
        return transport.callDirect(url, settings.apiKey, body, signal);
    }
    const override = settings.sendTemperature ? { temperature: settings.temperature } : {};
    if (useStream) {
        return transport.callProfileStream(settings.profileId, messages, maxTokens, override, signal, (full) => {
            if (onText) onText(full, true);
        });
    }
    return transport.callProfile(settings.profileId, messages, maxTokens, override, signal);
}
