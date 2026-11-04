import { init } from './src/bootstrap.js';
import { getHostGlobal } from './src/st/host.js';

getHostGlobal('jQuery')(() => {
    try {
        init(import.meta.url);
    } catch (e) {
        console.error('[Story Oracle] init failed:', e);
    }
});
