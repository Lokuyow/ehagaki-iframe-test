// nip07-poller.js
// 軽量な NIP-07 待機ユーティリティ（nip07-awaiter を参考にした簡易実装）
(function () {
    function isNostr(value) {
        if (!value) return false;
        try {
            const hasGetPublicKey =
                'getPublicKey' in value &&
                (typeof value.getPublicKey === 'function' || typeof value.getPublicKey === 'object');
            const hasSignEvent =
                'signEvent' in value && (typeof value.signEvent === 'function' || typeof value.signEvent === 'object');

            return hasGetPublicKey && hasSignEvent;
        } catch (e) {
            return false;
        }
    }

    const getNostr = () => (isNostr(window.nostr) ? window.nostr : undefined);

    function setHeuristicInterval(callback) {
        let timeSum = 0;
        let time = 0;
        let timer;

        const updateInterval = () => {
            timeSum += time;
            if (timeSum < 1000) {
                time = 10;
            } else if (timeSum < 5000) {
                time = 100;
            } else {
                time = 1000;
            }
        };

        const spawn = () => {
            updateInterval();
            timer = setTimeout(() => {
                try {
                    callback();
                } catch (e) {
                    // ignore
                }
                spawn();
            }, time);
        };

        const teardown = () => {
            clearTimeout(timer);
        };

        spawn();

        return teardown;
    }

    function startPolling(options = {}) {
        return new Promise((resolve) => {
            const clearInterval = setHeuristicInterval(() => {
                const nostr = getNostr();
                if (nostr) {
                    resolve(nostr);
                    clearInterval();
                }
            });

            if (options.signal && typeof options.signal.addEventListener === 'function') {
                options.signal.addEventListener('abort', clearInterval);
            }
        });
    }

    function timeout(params) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                resolve(undefined);
            }, params.timeoutMs);

            if (params.signal && typeof params.signal.addEventListener === 'function') {
                params.signal.addEventListener('abort', () => clearTimeout(timer));
            }
        });
    }

    function canSetupSetterHook() {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(window, 'nostr');
            if (!descriptor) return true;
            return descriptor.configurable ?? false;
        } catch (e) {
            return false;
        }
    }

    function setupSetterHook() {
        let current = window.nostr;
        return new Promise((resolve) => {
            try {
                Object.defineProperty(window, 'nostr', {
                    configurable: true,
                    get: () => current,
                    set: (nostr) => {
                        try {
                            if (isNostr(nostr)) {
                                resolve(nostr);
                            }
                        } catch (e) {
                            // ignore
                        }
                        current = nostr;
                    },
                });
            } catch (e) {
                // defineProperty might fail in some environments
                resolve(undefined);
            }
        });
    }

    async function waitNostr(timeoutMs, options = {}) {
        if (isNostr(window.nostr)) {
            return window.nostr;
        }

        const controller = new AbortController();
        const { signal } = controller;

        if (options.signal && typeof options.signal.addEventListener === 'function') {
            options.signal.addEventListener('abort', () => controller.abort(options.signal.reason));
        }

        const promises = [startPolling({ signal })];

        if (canSetupSetterHook()) {
            promises.push(setupSetterHook());
        }

        if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
            promises.push(timeout({ signal, timeoutMs }));
        }

        const result = await Promise.race(promises);
        try {
            controller.abort();
        } catch (e) {
            // ignore
        }
        return result;
    }

    // 公開API
    window.nip07Awaiter = {
        isNostr,
        getNostr,
        waitNostr,
    };
})();
