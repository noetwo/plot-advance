import { init } from './src/bootstrap.js';

jQuery(() => {
    try {
        init(import.meta.url);
    } catch (e) {
        console.error('[Story Oracle] init failed:', e);
    }
});
