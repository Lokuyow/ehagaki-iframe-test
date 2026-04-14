// DOM要素の取得
const openDialogBtn = document.getElementById('openDialogBtn');
const modal = document.getElementById('modal');
const closeBtn = document.getElementById('closeBtn');
const statusDiv = document.getElementById('status');
const iframe = document.getElementById('ehagaki-iframe');
const timelineStatusDiv = document.getElementById('timelineStatus');
const timelineDiv = document.getElementById('timeline');
const loginBtn = document.getElementById('loginBtn');
const skLoginContainer = document.getElementById('skLogin');
const skInput = document.getElementById('skInput');
const skLoginBtn = document.getElementById('skLoginBtn');

// eHagaki 設定
const EHAGAKI_ORIGIN = 'https://ehagaki.vercel.app';
const EHAGAKI_URL = `${EHAGAKI_ORIGIN}/`;
const EHAGAKI_NAMESPACE = 'ehagaki.parentClient';
const RELAY_URL = 'wss://yabu.me/';
const SUBSCRIPTION_LIMIT = 30;

let relaySocket = null;
let timelineEvents = [];
let relayEoseReceived = false;
let authMode = null; // 'nip07' or 'secret'
const TRUSTED_ORIGINS = new Set([
    EHAGAKI_ORIGIN,
    window.location.origin,
    'https://lokuyow.github.io',
    'http://127.0.0.1:3000',
]);

// throttle helper for subframe positioning responses
let _lastPositionResponseAt = 0;
function _handleCalculateSubFramePositioning(event) {
    const now = Date.now();
    if (now - _lastPositionResponseAt < 200) return; // throttle to 200ms
    _lastPositionResponseAt = now;
    try {
        const rect = iframe.getBoundingClientRect();
        const payload = {
            command: 'subFramePositioning',
            subFrameData: {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height
            }
        };
        // respond back to iframe (use event.source/origin)
        if (event && event.source && typeof event.source.postMessage === 'function') {
            event.source.postMessage(payload, event.origin || EHAGAKI_ORIGIN);
        }
    } catch (e) {
        // ignore
    }
}

let userPubkey = null;
// 永続化キー（公開鍵のみを保存）
const STORAGE_KEY = 'ehagaki_parent_pubkey';

function saveLoginToStorage(pubkey) {
    try {
        localStorage.setItem(STORAGE_KEY, pubkey);
    } catch (e) {
        console.warn('localStorage に保存できませんでした', e);
    }
}

function clearLoginFromStorage() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        console.warn('localStorage の削除に失敗しました', e);
    }
}

async function restoreLoginState() {
    try {
        const storedSk = getStoredSecretKey();
        if (storedSk) {
            sessionSk = normalizeSecretKey(storedSk);
            userPubkey = await getPubkeyFromSk(sessionSk);
            authMode = 'secret';
            updateWalletUI();
            showStatus('秘密鍵ログインを復元しました: ' + truncate(userPubkey, 12), true);
            return;
        }

        const pk = localStorage.getItem(STORAGE_KEY);
        if (pk) {
            userPubkey = pk;
            authMode = 'nip07';
            updateWalletUI();
            showStatus('ログイン情報を復元しました: ' + truncate(pk, 12), true);
        }
    } catch (e) {
        console.warn('localStorage からの読み込みに失敗しました', e);
    }
}

// ダイアログを開く
function openDialog(params = {}) {
    const contentInput = document.getElementById('contentInput');
    const content = contentInput.value.trim();
    const url = buildIframeUrl(content, params);
    iframe.src = url;

    modal.style.display = 'block';
    document.body.style.overflow = 'hidden'; // 背景のスクロールを無効化
    hideStatus();
}

function buildIframeUrl(content, params = {}) {
    const url = new URL(EHAGAKI_URL);

    if (content) {
        url.searchParams.set('content', content);
    }

    if (params.reply) {
        url.searchParams.set('reply', params.reply);
    }

    if (params.quote) {
        url.searchParams.set('quote', params.quote);
    }

    // 親クライアント連携のため parentOrigin を渡す
    try {
        url.searchParams.set('parentOrigin', window.location.origin);
    } catch (e) {
        console.warn('parentOrigin を設定できませんでした', e);
    }

    return url.toString();
}

// ダイアログを閉じる
function closeDialog() {
    modal.style.display = 'none';
    document.body.style.overflow = 'auto'; // 背景のスクロールを再有効化
}

// ステータスメッセージを表示
function showStatus(message, isSuccess = true) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${isSuccess ? 'success' : 'error'}`;
}

// ステータスメッセージを非表示
function hideStatus() {
    statusDiv.className = 'status hidden';
}

function setTimelineStatus(message, isError = false) {
    timelineStatusDiv.textContent = message;
    timelineStatusDiv.className = `timeline-status${isError ? ' error' : ''}`;
}

function truncate(value, maxLength = 10) {
    if (!value || value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength)}...`;
}

function formatDate(timestampSeconds) {
    const date = new Date(timestampSeconds * 1000);
    return date.toLocaleString('ja-JP');
}

function bytesToHex(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function hexToBytes(hex) {
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
        throw new Error('不正なHEXです');
    }

    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function convertBits(data, fromBits, toBits, pad = true) {
    let acc = 0;
    let bits = 0;
    const result = [];
    const maxv = (1 << toBits) - 1;

    for (const value of data) {
        if (value < 0 || value >> fromBits !== 0) {
            return null;
        }

        acc = (acc << fromBits) | value;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            result.push((acc >> bits) & maxv);
        }
    }

    if (pad) {
        if (bits > 0) {
            result.push((acc << (toBits - bits)) & maxv);
        }
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
        return null;
    }

    return result;
}

function bech32Polymod(values) {
    const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;

    for (const value of values) {
        const top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ value;
        for (let i = 0; i < 5; i += 1) {
            if ((top >> i) & 1) {
                chk ^= generators[i];
            }
        }
    }

    return chk;
}

function bech32HrpExpand(hrp) {
    const expanded = [];
    for (let i = 0; i < hrp.length; i += 1) {
        expanded.push(hrp.charCodeAt(i) >> 5);
    }
    expanded.push(0);
    for (let i = 0; i < hrp.length; i += 1) {
        expanded.push(hrp.charCodeAt(i) & 31);
    }
    return expanded;
}

function bech32CreateChecksum(hrp, data) {
    const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
    const polymod = bech32Polymod(values) ^ 1;
    const checksum = [];
    for (let i = 0; i < 6; i += 1) {
        checksum.push((polymod >> (5 * (5 - i))) & 31);
    }
    return checksum;
}

function bech32Encode(hrp, data) {
    const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const checksum = bech32CreateChecksum(hrp, data);
    const combined = [...data, ...checksum];
    let output = `${hrp}1`;

    for (const value of combined) {
        output += charset[value];
    }

    return output;
}

function toNoteId(eventIdHex) {
    try {
        const data = convertBits(hexToBytes(eventIdHex), 8, 5, true);
        if (!data) {
            return null;
        }
        return bech32Encode('note', data);
    } catch (error) {
        console.error('note1変換失敗:', error);
        return null;
    }
}

function isValidEvent(event) {
    return (
        event &&
        typeof event.id === 'string' &&
        typeof event.pubkey === 'string' &&
        typeof event.content === 'string' &&
        typeof event.created_at === 'number' &&
        event.kind === 1
    );
}

function renderTimeline() {
    timelineDiv.innerHTML = '';

    if (timelineEvents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'timeline-item';
        empty.textContent = '表示できる投稿がまだありません。';
        timelineDiv.appendChild(empty);
        return;
    }

    timelineEvents.forEach((eventItem) => {
        const item = document.createElement('div');
        item.className = 'timeline-item';

        const header = document.createElement('div');
        header.className = 'timeline-item-header';

        const pubkey = document.createElement('span');
        pubkey.textContent = `pubkey: ${truncate(eventItem.pubkey)}`;

        const date = document.createElement('span');
        date.textContent = formatDate(eventItem.created_at);

        header.appendChild(pubkey);
        header.appendChild(date);

        const content = document.createElement('div');
        content.className = 'timeline-item-content';
        content.textContent = eventItem.content || '(本文なし)';

        const actions = document.createElement('div');
        actions.className = 'timeline-actions';

        const noteId = toNoteId(eventItem.id);
        if (noteId) {
            const replyBtn = document.createElement('button');
            replyBtn.className = 'timeline-action-btn';
            replyBtn.textContent = '↩ リプライ';
            replyBtn.addEventListener('click', () => {
                openDialog({ reply: noteId });
            });

            const quoteBtn = document.createElement('button');
            quoteBtn.className = 'timeline-action-btn';
            quoteBtn.textContent = '💬 引用リポスト';
            quoteBtn.addEventListener('click', () => {
                openDialog({ quote: noteId });
            });

            actions.appendChild(replyBtn);
            actions.appendChild(quoteBtn);
        }

        item.appendChild(header);
        item.appendChild(content);
        item.appendChild(actions);
        timelineDiv.appendChild(item);
    });
}

function upsertTimelineEvent(eventItem) {
    if (!isValidEvent(eventItem)) {
        return;
    }

    const exists = timelineEvents.some((item) => item.id === eventItem.id);
    if (exists) {
        return;
    }

    timelineEvents.push(eventItem);
    timelineEvents.sort((a, b) => b.created_at - a.created_at);
    timelineEvents = timelineEvents.slice(0, SUBSCRIPTION_LIMIT);
    renderTimeline();
}

function handleRelayMessage(message) {
    if (!Array.isArray(message) || message.length < 2) {
        return;
    }

    const [type, subId, payload] = message;
    if (subId !== 'timeline-sub') {
        return;
    }

    if (type === 'EVENT') {
        upsertTimelineEvent(payload);
        if (!relayEoseReceived) {
            setTimelineStatus(`取得中... ${timelineEvents.length}件`);
        }
        return;
    }

    if (type === 'EOSE') {
        relayEoseReceived = true;
        setTimelineStatus(`接続中: ${timelineEvents.length}件を表示`);
        return;
    }

    if (type === 'NOTICE' && typeof payload === 'string') {
        setTimelineStatus(`リレー通知: ${payload}`, true);
    }
}

function connectRelay() {
    if (relaySocket && (relaySocket.readyState === WebSocket.OPEN || relaySocket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    setTimelineStatus('タイムラインを接続中...');
    relayEoseReceived = false;

    relaySocket = new WebSocket(RELAY_URL);

    relaySocket.addEventListener('open', () => {
        setTimelineStatus('接続完了。投稿を取得しています...');

        const request = [
            'REQ',
            'timeline-sub',
            {
                kinds: [1],
                limit: SUBSCRIPTION_LIMIT
            }
        ];
        relaySocket.send(JSON.stringify(request));
    });

    relaySocket.addEventListener('message', (event) => {
        try {
            const message = JSON.parse(event.data);
            handleRelayMessage(message);
        } catch (error) {
            console.error('リレーメッセージ解析失敗:', error);
        }
    });

    relaySocket.addEventListener('error', () => {
        setTimelineStatus('リレー接続でエラーが発生しました。再読込してください。', true);
    });

    relaySocket.addEventListener('close', () => {
        if (timelineEvents.length === 0) {
            setTimelineStatus('リレー接続が切断されました。再読込してください。', true);
        } else {
            setTimelineStatus(`切断されました（表示中 ${timelineEvents.length}件）`, true);
        }
    });
}

// ---------- Wallet / Parent-client helpers ----------
// local secret-key storage key (stores private key HEX in localStorage)
const PRIVKEY_STORAGE_KEY = 'ehagaki_privkey';
let sessionSk = null; // hex private key for current session (64 hex chars)
let secpLibPromise = null;

function saveSkToStorage(skHex) {
    try {
        localStorage.setItem(PRIVKEY_STORAGE_KEY, skHex);
    } catch (e) {
        console.warn('秘密鍵の保存に失敗しました', e);
    }
}

function loadSkFromStorage() {
    try {
        return localStorage.getItem(PRIVKEY_STORAGE_KEY);
    } catch (e) {
        console.warn('秘密鍵の読み込みに失敗しました', e);
        return null;
    }
}

function getStoredSecretKey() {
    const stored = loadSkFromStorage();
    return typeof stored === 'string' && stored ? stored : null;
}

function clearLocalSkStorage() {
    try {
        localStorage.removeItem(PRIVKEY_STORAGE_KEY);
    } catch (e) {
        console.warn('秘密鍵ストレージの削除に失敗しました', e);
    }
}


function normalizeSecretKey(skValue) {
    if (!skValue) {
        throw new Error('invalid_sk');
    }

    if (typeof skValue !== 'string') {
        return skValue;
    }

    let normalized = skValue.trim();
    if (normalized.startsWith('nsec1')) {
        normalized = bech32Decode(normalized);
    }
    if (normalized.startsWith('0x')) {
        normalized = normalized.slice(2);
    }
    return normalized;
}

function normalizeHexValue(value) {
    if (typeof value === 'string') {
        return value.startsWith('0x') ? value.slice(2) : value;
    }
    if (value instanceof Uint8Array) {
        return bytesToHex(value);
    }
    if (Array.isArray(value)) {
        return bytesToHex(new Uint8Array(value));
    }
    throw new Error('invalid_hex_value');
}

// bech32 decode for nsec / npub conversion (returns hex string)
function bech32Decode(bech) {
    const pos = bech.lastIndexOf('1');
    if (pos === -1) throw new Error('invalid_bech32');
    const hrp = bech.slice(0, pos).toLowerCase();
    const dataPart = bech.slice(pos + 1);
    const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const data = [];
    for (const ch of dataPart) {
        const idx = charset.indexOf(ch);
        if (idx === -1) throw new Error('invalid_bech32_char');
        data.push(idx);
    }
    const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
    if (polymod !== 1) throw new Error('invalid_bech32_checksum');
    const dataNoChecksum = data.slice(0, data.length - 6);
    const bytes = convertBits(dataNoChecksum, 5, 8, false);
    if (!bytes) throw new Error('invalid_bech32_convert');
    return bytesToHex(new Uint8Array(bytes));
}

function _getSecpLib() {
    // Try common global names used by bundles/UMD builds
    if (window.secp256k1 && typeof window.secp256k1.getPublicKey === 'function') return window.secp256k1;
    if (window.nobleSecp256k1 && typeof window.nobleSecp256k1.getPublicKey === 'function') return window.nobleSecp256k1;
    if (window.noble && window.noble.secp256k1 && typeof window.noble.secp256k1.getPublicKey === 'function') return window.noble.secp256k1;
    return null;
}

async function ensureSecp() {
    if (!secpLibPromise) {
        const existing = _getSecpLib();
        if (existing) {
            secpLibPromise = Promise.resolve(existing);
        } else {
            secpLibPromise = (async () => {
                const esmCandidates = [
                    'https://esm.sh/@noble/secp256k1@1.7.2',
                    'https://cdn.jsdelivr.net/npm/@noble/secp256k1@1.7.2/+esm',
                    'https://cdn.skypack.dev/@noble/secp256k1@1.7.2'
                ];

                for (const url of esmCandidates) {
                    try {
                        const mod = await import(/* @vite-ignore */ url);
                        const secp = mod && (mod.default || mod);
                        if (secp && typeof secp.getPublicKey === 'function') {
                            return secp;
                        }
                    } catch (e) {
                        // ignore and try next candidate
                    }
                }

                throw new Error('no_secp_lib');
            })();
        }
    }

    try {
        return await secpLibPromise;
    } catch (error) {
        secpLibPromise = null;
        throw error;
    }
}

async function getPubkeyFromSk(skHex) {
    const normalizedSk = normalizeSecretKey(skHex);

    const secp = await ensureSecp();

    try {
        // Convert secret key hex to Uint8Array if needed
        const skBuf = (typeof normalizedSk === 'string') ? hexToBytes(normalizedSk) : normalizedSk;
        // Prefer compressed public key (33 bytes) and return the X coordinate (32 bytes hex)
        let pub = secp.getPublicKey ? secp.getPublicKey(skBuf, true) : null;
        // handle promise/async libraries
        if (pub instanceof Promise) pub = await pub;

        if (typeof pub === 'string') {
            // hex string
            if (pub.length === 66 && (pub.startsWith('02') || pub.startsWith('03'))) {
                // compressed hex (33 bytes) -> remove prefix
                return pub.slice(2);
            }
            if (pub.length === 130 && pub.startsWith('04')) {
                // uncompressed hex (65 bytes) -> take X coordinate (32 bytes = 64 hex chars) after '04'
                return pub.slice(2, 66);
            }
            // otherwise, return as-is
            return pub;
        }

        // Uint8Array
        if (pub && pub.length) {
            if (pub.length === 33 && (pub[0] === 2 || pub[0] === 3)) {
                // compressed -> slice off prefix byte
                return bytesToHex(pub.slice(1, 33));
            }
            if (pub.length === 65 && pub[0] === 4) {
                // uncompressed -> take X coordinate bytes 1..32
                return bytesToHex(pub.slice(1, 33));
            }
            // fallback: return full hex
            return bytesToHex(pub);
        }

        throw new Error('invalid_pubkey');
    } catch (e) {
        console.error('getPubkeyFromSk error', e);
        throw e;
    }
}

async function getEventHash(event) {
    const ev = [0, event.pubkey, event.created_at, event.kind, event.tags || [], event.content];
    const serialized = JSON.stringify(ev);
    const enc = new TextEncoder();
    const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(serialized));
    return bytesToHex(new Uint8Array(hashBuf));
}

async function signWithSk(idHex, skHex) {
    const normalizedSk = normalizeSecretKey(skHex);
    const secp = await ensureSecp();
    if (!secp.schnorr || typeof secp.schnorr.sign !== 'function' || typeof secp.schnorr.verify !== 'function') {
        throw new Error('schnorr_not_available');
    }

    const msgBuf = (typeof idHex === 'string') ? hexToBytes(idHex) : idHex;
    const skBuf = (typeof normalizedSk === 'string') ? hexToBytes(normalizedSk) : normalizedSk;
    let sig = secp.schnorr.sign(msgBuf, skBuf);
    if (sig instanceof Promise) sig = await sig;

    const sigHex = normalizeHexValue(sig);
    const derivedPubHex = await getPubkeyFromSk(normalizedSk);
    const verified = await secp.schnorr.verify(sigHex, msgBuf, derivedPubHex);
    if (!verified) {
        throw new Error('signature_verification_failed');
    }

    return sigHex;
}

async function signEventWithSk(event, skHex) {
    const normalizedSk = normalizeSecretKey(skHex);
    const derivedPubkey = await getPubkeyFromSk(normalizedSk);
    const normalizedEvent = {
        ...event,
        pubkey: derivedPubkey,
        created_at: typeof event.created_at === 'number' && event.created_at > 1000000000000
            ? Math.floor(event.created_at / 1000)
            : event.created_at,
    };
    const id = await getEventHash(normalizedEvent);
    const sig = await signWithSk(id, normalizedSk);

    return { ...normalizedEvent, id, sig };
}

async function validateSignedEvent(event, expectedPubkey = null) {
    if (!event || typeof event !== 'object') {
        throw new Error('invalid_signed_event');
    }

    if (typeof event.id !== 'string' || typeof event.pubkey !== 'string' || typeof event.sig !== 'string') {
        throw new Error('invalid_signed_event_shape');
    }

    if (expectedPubkey && event.pubkey !== expectedPubkey) {
        throw new Error('signed_event_pubkey_mismatch');
    }

    const computedId = await getEventHash(event);
    if (event.id !== computedId) {
        throw new Error('signed_event_id_mismatch');
    }

    const secp = await ensureSecp();
    if (!secp.schnorr || typeof secp.schnorr.verify !== 'function') {
        throw new Error('schnorr_verify_not_available');
    }

    const verified = await secp.schnorr.verify(event.sig, hexToBytes(event.id), event.pubkey);
    if (!verified) {
        throw new Error('signed_event_signature_invalid');
    }

    return event;
}

async function tryGetNip07Provider() {
    let nostr = window.nostr;
    if (!nostr && window.nip07Awaiter?.waitNostr) {
        try {
            nostr = await window.nip07Awaiter.waitNostr(2000);
        } catch (e) {
            // ignore and fall back to other signers
        }
    }
    return nostr;
}

async function resolveSecretKeySigner() {
    if (authMode === 'nip07') {
        return null;
    }

    const candidates = [];

    if (sessionSk) {
        candidates.push(sessionSk);
    }

    const stored = getStoredSecretKey();
    if (stored && stored !== sessionSk) {
        candidates.push(stored);
    }

    for (const candidate of candidates) {
        try {
            const candidatePubkey = await getPubkeyFromSk(candidate);
            if (!userPubkey || userPubkey === candidatePubkey) {
                return {
                    sk: candidate,
                    pubkey: candidatePubkey,
                };
            }
        } catch (error) {
            console.warn('秘密鍵候補の公開鍵導出に失敗しました', error);
        }
    }

    return null;
}

async function getCurrentPubkey() {
    if (userPubkey) return userPubkey;

    if (authMode === 'secret') {
        const stored = sessionSk || getStoredSecretKey();
        if (stored) {
            try {
                const pub = await getPubkeyFromSk(stored);
                if (!sessionSk) sessionSk = normalizeSecretKey(stored);
                return pub;
            } catch (e) {
                console.warn('秘密鍵から公開鍵を導出できませんでした', e);
                throw new Error('key_not_found');
            }
        }
        throw new Error('key_not_found');
    }

    if (authMode === 'nip07') {
        const nostr = await tryGetNip07Provider();
        if (!nostr || typeof nostr.getPublicKey !== 'function') {
            throw new Error('no_wallet');
        }
        try {
            return await nostr.getPublicKey();
        } catch (err) {
            throw new Error('user_rejected');
        }
    }

    const stored = getStoredSecretKey();
    if (stored) {
        try {
            sessionSk = normalizeSecretKey(stored);
            authMode = 'secret';
            return await getPubkeyFromSk(sessionSk);
        } catch (e) {
            console.warn('保存鍵の読み込みに失敗しました', e);
            clearLocalSkStorage();
            throw new Error('key_not_found');
        }
    }

    const nostr = await tryGetNip07Provider();
    if (nostr && typeof nostr.getPublicKey === 'function') {
        try {
            return await nostr.getPublicKey();
        } catch (err) {
            throw new Error('user_rejected');
        }
    }

    throw new Error('no_wallet');
}

async function signEventWithYourClient(event) {
    const secretKeySigner = await resolveSecretKeySigner();
    if (secretKeySigner) {
        if (secretKeySigner.sk !== sessionSk) {
            sessionSk = secretKeySigner.sk;
        }
        return await signEventWithSk(event, secretKeySigner.sk);
    }

    const nostr = await tryGetNip07Provider();

    if (nostr && typeof nostr.signEvent === 'function') {
        try {
            const signed = await nostr.signEvent(event);
            const signedEvent = typeof signed === 'string'
                ? { ...event, id: await getEventHash(event), sig: signed }
                : signed;
            const expectedPubkey = userPubkey || event.pubkey || null;
            await validateSignedEvent(signedEvent, expectedPubkey);
            if (typeof signed === 'string') {
                return signedEvent;
            }
            return signedEvent;
        } catch (err) {
            throw err;
        }
    }

    throw new Error('no_wallet');
}

function updateWalletUI() {
    if (userPubkey) {
        if (authMode === 'nip07') {
            if (loginBtn) {
                loginBtn.textContent = '🔓 ログアウト';
                loginBtn.disabled = false;
                loginBtn.style.display = 'inline-block';
            }
            if (skLoginContainer) skLoginContainer.style.display = 'block';
            if (skInput) skInput.disabled = true;
            if (skLoginBtn) {
                skLoginBtn.textContent = '🔑 秘密鍵でログイン';
                skLoginBtn.disabled = true;
            }
        } else if (authMode === 'secret') {
            if (loginBtn) {
                loginBtn.textContent = '🔐 ブラウザ拡張でログイン';
                loginBtn.disabled = true;
                loginBtn.style.display = 'inline-block';
            }
            if (skLoginContainer) {
                skLoginContainer.style.display = 'block';
                if (skInput) skInput.disabled = false;
                if (skLoginBtn) {
                    skLoginBtn.textContent = '🔓 ログアウト';
                    skLoginBtn.disabled = false;
                }
            }
        } else {
            if (loginBtn) {
                loginBtn.textContent = '🔐 ブラウザ拡張でログイン';
                loginBtn.disabled = false;
                loginBtn.style.display = 'inline-block';
            }
            if (skLoginContainer) {
                skLoginContainer.style.display = 'block';
                if (skInput) skInput.disabled = false;
                if (skLoginBtn) {
                    skLoginBtn.textContent = '🔑 秘密鍵でログイン';
                    skLoginBtn.disabled = false;
                }
            }
        }
    } else {
        if (loginBtn) {
            loginBtn.textContent = '🔐 ブラウザ拡張でログイン';
            loginBtn.disabled = false;
            loginBtn.style.display = 'inline-block';
        }
        if (skLoginContainer) {
            skLoginContainer.style.display = 'block';
            if (skInput) skInput.disabled = false;
            if (skLoginBtn) {
                skLoginBtn.textContent = '🔑 秘密鍵でログイン';
                skLoginBtn.disabled = false;
            }
        }
    }
}

async function login() {
    try {
        const nostr = await tryGetNip07Provider();
        if (!nostr || typeof nostr.getPublicKey !== 'function') {
            throw new Error('no_wallet');
        }

        const pk = await nostr.getPublicKey();
        userPubkey = pk;
        authMode = 'nip07';
        sessionSk = null;
        clearLocalSkStorage();
        updateWalletUI();
        saveLoginToStorage(pk);
        showStatus('ログイン済み: ' + truncate(pk, 12), true);
    } catch (err) {
        if (err.message === 'no_wallet') {
            showStatus('ログインに使用できるクライアントが見つかりません（NIP-07 対応が必要です）。GitHub Pages上では拡張機能の権限設定が必要な場合があります。ブラウザ拡張をこのサイトで許可してください。', false);
        } else if (err.message === 'user_rejected') {
            showStatus('ログインがキャンセルされました。', false);
        } else {
            showStatus('ログインエラー: ' + err.message, false);
        }
        console.error(err);
    }
}

function logout() {
    userPubkey = null;
    authMode = null;
    sessionSk = null;
    updateWalletUI();
    clearLoginFromStorage();
    clearLocalSkStorage();
    sendAuthLogoutToIframe();
    showStatus('ログアウトしました', true);
}

function postToIframe(message) {
    if (iframe.contentWindow) {
        iframe.contentWindow.postMessage(message, EHAGAKI_ORIGIN);
    }
}

function sendAuthLogoutToIframe() {
    if (!iframe.contentWindow) return;
    postToIframe({
        namespace: EHAGAKI_NAMESPACE,
        version: 1,
        type: 'auth.logout'
    });
}

async function handleParentClientMessage(data) {
    if (data.type === 'auth.request') {
        try {
            const pubkeyHex = userPubkey || await getCurrentPubkey();
            postToIframe({
                namespace: EHAGAKI_NAMESPACE,
                version: 1,
                type: 'auth.result',
                requestId: data.requestId,
                payload: {
                    pubkeyHex,
                    capabilities: ['signEvent']
                }
            });
        } catch (error) {
            postToIframe({
                namespace: EHAGAKI_NAMESPACE,
                version: 1,
                type: 'auth.error',
                requestId: data.requestId,
                payload: { message: error instanceof Error ? error.message : 'auth failed' }
            });
        }
        return;
    }

    if (data.type === 'rpc.request' && data.payload?.method === 'signEvent') {
        try {
            const signedEvent = await signEventWithYourClient(data.payload?.params?.event);
            postToIframe({
                namespace: EHAGAKI_NAMESPACE,
                version: 1,
                type: 'rpc.result',
                requestId: data.requestId,
                payload: { result: signedEvent }
            });
        } catch (error) {
            postToIframe({
                namespace: EHAGAKI_NAMESPACE,
                version: 1,
                type: 'rpc.error',
                requestId: data.requestId,
                payload: { message: error instanceof Error ? error.message : 'sign failed' }
            });
        }
    }
}

function getPostErrorMessage(errorCode) {
    switch (errorCode) {
        case 'empty_content':
            return '❌ 投稿に失敗しました: 投稿内容が空です';
        case 'login_required':
            return '❌ 投稿に失敗しました: ログインが必要です';
        case 'nostr_not_ready':
            return '❌ 投稿に失敗しました: Nostrクライアントが初期化されていません';
        case 'key_not_found':
            return '❌ 投稿に失敗しました: 秘密鍵が見つかりません';
        case 'post_error':
            return '❌ 投稿に失敗しました: 投稿エラーが発生しました';
        default:
            return errorCode ? `❌ 投稿に失敗しました: ${errorCode}` : '❌ 投稿に失敗しました';
    }
}

async function loginWithSecretKey(secretKey, { persist = false } = {}) {
    sessionSk = normalizeSecretKey(secretKey);
    const pubkey = await getPubkeyFromSk(sessionSk);
    userPubkey = pubkey;
    authMode = 'secret';
    updateWalletUI();
    saveLoginToStorage(pubkey);
    if (persist) {
        saveSkToStorage(sessionSk);
    }
    showStatus('秘密鍵でログインしました: ' + truncate(pubkey, 12), true);
    return pubkey;
}

// postMessageを受信してダイアログ制御
window.addEventListener('message', async (event) => {
    if (!TRUSTED_ORIGINS.has(event.origin)) {
        console.warn('信頼できないオリジンからのメッセージを受信:', event.origin);
        return;
    }

    const data = event.data;
    // Suppress high-frequency positioning requests from the iframe to avoid console spam.
    if (data && data.command === 'calculateSubFramePositioning') {
        _handleCalculateSubFramePositioning(event);
        return;
    }
    console.debug('eHagakiからメッセージを受信:', data);

    // 親クライアント連携（namespace ベース）のメッセージを優先処理
    if (data && data.namespace === EHAGAKI_NAMESPACE && data.version === 1) {
        // イベント発信元が iframe であることを確認
        if (event.source !== iframe.contentWindow) {
            console.warn('信頼できない送信元 (source) からの親クライアント要求');
            return;
        }

        try {
            await handleParentClientMessage(data);
        } catch (error) {
            console.error('親クライアント message handling error', error);
        }
        return;
    }

    if (data.type === 'POST_SUCCESS') {
        console.debug('投稿成功:', data);
        showStatus('✅ 投稿に成功しました！', true);

        // 投稿成功時にダイアログを閉じる
        setTimeout(() => {
            closeDialog();
            // テキストボックスをクリア
            document.getElementById('contentInput').value = '';
        }, 800); // 0.8秒後に閉じる（ユーザーが成功メッセージを確認できるように）

    } else if (data.type === 'POST_ERROR') {
        console.error('投稿失敗:', data);

        showStatus(getPostErrorMessage(data.error), false);

        // エラー時はダイアログを閉じない（ユーザーが再試行できるように）
    }
});

// イベントリスナーの設定
openDialogBtn.addEventListener('click', openDialog);
closeBtn.addEventListener('click', closeDialog);

// モーダルの背景をクリックしたら閉じる
modal.addEventListener('click', (event) => {
    if (event.target === modal) {
        closeDialog();
    }
});

// ESCキーでダイアログを閉じる
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.style.display === 'block') {
        closeDialog();
    }
});

// ページ読み込み時の初期化
document.addEventListener('DOMContentLoaded', async () => {
    hideStatus();
    // リロード時に保存されたログイン情報を復元
    await restoreLoginState();
    renderTimeline();
    connectRelay();
});

// ログイン関連ボタンのイベント
if (loginBtn) {
    loginBtn.addEventListener('click', async () => {
        if (userPubkey && authMode === 'nip07') {
            logout();
        } else {
            await login();
        }
    });
}
if (skLoginBtn) {
    skLoginBtn.addEventListener('click', async () => {
        if (userPubkey && authMode === 'secret') {
            logout();
        } else {
            await handleSkLogin();
        }
    });
}

// 秘密鍵ログインハンドラ
async function handleSkLogin() {
    if (!skInput) return;

    const skVal = skInput.value.trim();
    try {
        if (!skVal) {
            const stored = getStoredSecretKey();
            if (stored) {
                await loginWithSecretKey(stored);
                return;
            }

            showStatus('秘密鍵が入力されていません', false);
            return;
        }

        // 入力は nsec1 形式のみ許容
        if (!skVal.startsWith('nsec1')) {
            showStatus('nsec1形式の鍵を入力してください', false);
            return;
        }

        await loginWithSecretKey(skVal, { persist: true });
        skInput.value = '';
    } catch (e) {
        if (e && e.message === 'no_secp_lib') {
            showStatus('秘密鍵ログインに必要なライブラリを読み込めませんでした。通信環境またはCDNアクセス制限を確認してください。', false);
        } else {
            showStatus('秘密鍵ログインに失敗しました: ' + (e.message || e), false);
        }
        console.error('handleSkLogin error', e);
    }
}

// UI ボタンのイベント登録
if (skLoginBtn) skLoginBtn.addEventListener('click', handleSkLogin);
