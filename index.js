import { init } from './src/bootstrap.js';
import { getHostGlobal } from './src/st/host.js';

getHostGlobal('jQuery')(() => {
    try {
        init();
    } catch (e) {
        console.error('[剧情推进] init failed:', e);
    }
});
