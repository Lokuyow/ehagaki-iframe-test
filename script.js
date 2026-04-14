// DOM要素の取得
const openDialogBtn = document.getElementById('openDialogBtn');
const modal = document.getElementById('modal');
const closeBtn = document.getElementById('closeBtn');
const statusDiv = document.getElementById('status');
const iframe = document.getElementById('ehagaki-iframe');
const timelineStatusDiv = document.getElementById('timelineStatus');
const timelineDiv = document.getElementById('timeline');

// デバッグ: スクリプトが読み込まれたことと、window.nostr の有無をログに出す
console.log('script.js loaded:', window.location.href);
console.debug('window.nostr present:', typeof window.nostr !== 'undefined');
// Login UI
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const loginInfoDiv = document.getElementById('loginInfo');
const loginPubkeySpan = document.getElementById('loginPubkey');

// eHagaki 設定
const EHAGAKI_ORIGIN = 'https://ehagaki.vercel.app';
const EHAGAKI_URL = `${EHAGAKI_ORIGIN}/`;
const EHAGAKI_NAMESPACE = 'ehagaki.parentClient';
const RELAY_URL = 'wss://yabu.me/';
const SUBSCRIPTION_LIMIT = 30;

let relaySocket = null;
let relayConnected = false;
let timelineEvents = [];
let relayEoseReceived = false;

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

function loadSavedLogin() {
    try {
        const pk = localStorage.getItem(STORAGE_KEY);
        if (pk) {
            userPubkey = pk;
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
        relayConnected = true;
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
        relayConnected = false;
        setTimelineStatus('リレー接続でエラーが発生しました。再読込してください。', true);
    });

    relaySocket.addEventListener('close', () => {
        relayConnected = false;
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

function clearLocalSkStorage() {
    try {
        localStorage.removeItem(PRIVKEY_STORAGE_KEY);
    } catch (e) {
        console.warn('秘密鍵ストレージの削除に失敗しました', e);
    }
}

function hasStoredSk() {
    try {
        return !!localStorage.getItem(PRIVKEY_STORAGE_KEY);
    } catch (e) {
        return false;
    }
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
    const existing = _getSecpLib();
    if (existing) return existing;

    // Try ESM proxies first (may work if CORS allowed). Do not spam console on failure.
    const esmCandidates = [
        'https://esm.sh/@noble/secp256k1',
        'https://cdn.skypack.dev/@noble/secp256k1'
    ];
    for (const url of esmCandidates) {
        try {
            const mod = await import(/* @vite-ignore */ url);
            const secp = mod && (mod.default || mod);
            if (secp && typeof secp.getPublicKey === 'function') {
                window.nobleSecp256k1 = secp;
                return secp;
            }
        } catch (e) {
            // silent
        }
    }

    // Prefer the UMD build already included in the page. If it's not present,
    // inject the known UMD minified script and poll for the global to appear.
    const umdSrc = 'https://cdn.jsdelivr.net/npm/@noble/secp256k1@1.10.0/lib/index.umd.min.js';
    const existingScript = document.querySelector(`script[src="${umdSrc}"]`);
    if (!existingScript) {
        const s = document.createElement('script');
        s.src = umdSrc;
        s.async = true;
        document.head.appendChild(s);
    }

    const deadline = Date.now() + 5000; // wait up to 5s
    while (Date.now() < deadline) {
        const lib = _getSecpLib();
        if (lib) return lib;
        // short delay
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error('no_secp_lib');
}
// For diagnostics: helper to list potential global matches
function _diagnoseSecpGlobals() {
    try {
        const keys = Object.keys(window || {});
        const matches = keys.filter(k => /secp|noble|nobleSecp|secp256k1/i.test(k));
        const info = {};
        matches.forEach(k => {
            try { info[k] = typeof window[k]; } catch (e) { info[k] = 'error'; }
        });
        console.error('Secp globals diagnostic:', info);
        return info;
    } catch (e) {
        console.error('diagnoseSecpGlobals failed', e);
        return null;
    }
}

async function getPubkeyFromSk(skHex) {
    if (!skHex) throw new Error('invalid_sk');
    if (skHex.startsWith('nsec1')) {
        skHex = bech32Decode(skHex);
    }
    if (skHex.startsWith('0x')) skHex = skHex.slice(2);

    const secp = await ensureSecp();

    try {
        // Convert secret key hex to Uint8Array if needed
        const skBuf = (typeof skHex === 'string') ? hexToBytes(skHex) : skHex;
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
    if (skHex.startsWith('nsec1')) {
        skHex = bech32Decode(skHex);
    }
    const secp = await ensureSecp();
    try {
        // convert inputs to Uint8Array if needed
        const msgBuf = (typeof idHex === 'string') ? hexToBytes(idHex) : idHex;
        const skBuf = (typeof skHex === 'string') ? hexToBytes(skHex) : skHex;
        // Prefer Schnorr signing (Nostr requires BIP340 Schnorr signatures).
        if (secp.schnorr && typeof secp.schnorr.sign === 'function') {
            // produce signature
            let sig = secp.schnorr.sign(msgBuf, skBuf);
            if (sig instanceof Promise) sig = await sig;
            // normalize sig to hex string (no 0x)
            let sigHex;
            if (typeof sig === 'string') {
                sigHex = sig.startsWith('0x') ? sig.slice(2) : sig;
            } else if (sig instanceof Uint8Array) {
                sigHex = bytesToHex(sig);
            } else if (Array.isArray(sig)) {
                sigHex = bytesToHex(new Uint8Array(sig));
            } else {
                sigHex = String(sig);
            }


            // verification step: derive pubkey and verify signature locally before returning
            try {
                const derivedPubHex = await getPubkeyFromSk(skHex);
                const canVerify = (typeof secp.schnorr.verify === 'function');
                let verified = false;
                if (canVerify) {
                    verified = await secp.schnorr.verify(sigHex, msgBuf, derivedPubHex);
                }
                console.debug('signWithSk: local verify', { canVerify, verified, idHex, pubkey: derivedPubHex, sigLen: sigHex.length });
                if (!verified) {
                    console.error('署名の検証に失敗しました', { idHex, pubkey: derivedPubHex, sig: sigHex.slice(0, 16) + '...' });
                    _diagnoseSecpGlobals();
                    throw new Error('signature_verification_failed');
                }
            } catch (verErr) {
                console.error('署名検証中にエラーが発生しました', verErr);
                throw verErr;
            }

            return sigHex;
        }

        // If Schnorr API is not available, fail loudly with diagnostics rather than returning an incompatible signature.
        console.error('schnorr API not available on secp lib; aborting signature.');
        _diagnoseSecpGlobals();
        throw new Error('schnorr_not_available');
    } catch (e) {
        console.error('signWithSk error', e);
        throw e;
    }
}

async function signEventWithSk(event, skHex) {
    try {
        // work on a shallow copy to avoid mutating caller's object
        const ev = { ...event };

        // normalize secret key (allow nsec1 input)
        let sk = skHex;
        if (typeof sk === 'string' && sk.startsWith('nsec1')) {
            sk = bech32Decode(sk);
        }

        // ensure the event pubkey matches the derived pubkey for the provided secret key
        try {
            const derivedPub = await getPubkeyFromSk(sk);
            if (!ev.pubkey || ev.pubkey !== derivedPub) {
                console.debug('signEventWithSk: normalizing event.pubkey', { original: ev.pubkey, derived: derivedPub });
                ev.pubkey = derivedPub;
            }
        } catch (e) {
            console.warn('signEventWithSk: 公開鍵の導出に失敗しました', e);
        }

        // normalize created_at (milliseconds -> seconds) if needed
        if (typeof ev.created_at === 'number' && ev.created_at > 1000000000000) {
            ev.created_at = Math.floor(ev.created_at / 1000);
        }

        const id = await getEventHash(ev);
        const sig = await signWithSk(id, sk);

        const signedEvent = { ...ev, id, sig };

        // 保存用の診断情報を localStorage に書き出す（秘密鍵は含めない）
        try {
            const diag = {
                timestamp: Date.now(),
                pubkey: ev.pubkey,
                signedEvent,
            };
            localStorage.setItem('ehagaki_diag_signed_event', JSON.stringify(diag));
        } catch (e) {
            console.warn('diagnostic save failed', e);
        }

        console.debug('signEventWithSk: created signed event', { id, sig: sig && typeof sig === 'string' ? (sig.slice(0, 16) + '...') : sig, pubkey: ev.pubkey });
        return signedEvent;
    } catch (e) {
        console.error('signEventWithSk error', e);
        throw e;
    }
}

async function getCurrentPubkey() {
    if (userPubkey) return userPubkey;
    // Try to obtain NIP-07 provider; wait briefly if it may be injected later
    let nostr = window.nostr;
    if (!nostr && window.nip07Awaiter && typeof window.nip07Awaiter.waitNostr === 'function') {
        try {
            nostr = await window.nip07Awaiter.waitNostr(2000);
        } catch (e) {
            // ignore, will try other fallbacks
        }
    }
    if (nostr && typeof nostr.getPublicKey === 'function') {
        try {
            const pk = await nostr.getPublicKey();
            return pk;
        } catch (err) {
            throw new Error('user_rejected');
        }
    }

    // Fallback: session private key
    if (sessionSk) {
        try {
            const pub = await getPubkeyFromSk(sessionSk);
            return pub;
        } catch (e) {
            console.warn('sessionSk から公開鍵を導出できませんでした', e);
        }
    }

    // Fallback: stored private key in localStorage (plain HEX)
    if (hasStoredSk()) {
        try {
            const stored = loadSkFromStorage();
            if (stored) {
                sessionSk = stored;
                const pub = await getPubkeyFromSk(sessionSk);
                return pub;
            }
        } catch (e) {
            console.warn('保存鍵の読み込みに失敗しました', e);
            throw new Error('key_not_found');
        }
    }

    throw new Error('no_wallet');
}

async function signEventWithYourClient(event) {
    // Try to obtain NIP-07 provider; wait briefly if needed
    let nostr = window.nostr;
    if (!nostr && window.nip07Awaiter && typeof window.nip07Awaiter.waitNostr === 'function') {
        try {
            nostr = await window.nip07Awaiter.waitNostr(2000);
        } catch (e) {
            // ignore
        }
    }

    if (nostr && typeof nostr.signEvent === 'function') {
        try {
            const signed = await nostr.signEvent(event);
            if (typeof signed === 'string') {
                return { ...event, sig: signed };
            }
            return signed;
        } catch (err) {
            throw err;
        }
    }

    // Fallback: use session private key
    if (sessionSk) {
        try {
            return await signEventWithSk(event, sessionSk);
        } catch (e) {
            console.warn('sessionSk による署名に失敗しました', e);
            throw e;
        }
    }

    // Fallback: try stored private key in localStorage (plain HEX)
    if (hasStoredSk()) {
        try {
            const stored = loadSkFromStorage();
            if (!stored) throw new Error('key_not_found');
            sessionSk = stored;
            return await signEventWithSk(event, sessionSk);
        } catch (e) {
            console.warn('保存鍵の読み込み/署名に失敗しました', e);
            throw new Error('key_not_found');
        }
    }

    throw new Error('no_wallet');
}

function updateWalletUI() {
    if (userPubkey) {
        loginPubkeySpan.textContent = truncate(userPubkey, 12);
        loginInfoDiv.style.display = 'block';
        if (loginBtn) loginBtn.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'inline-block';
    } else {
        loginPubkeySpan.textContent = '';
        loginInfoDiv.style.display = 'none';
        if (loginBtn) loginBtn.style.display = 'inline-block';
        if (logoutBtn) logoutBtn.style.display = 'none';
    }
}

async function login() {
    try {
        const pk = await getCurrentPubkey();
        userPubkey = pk;
        updateWalletUI();
        showStatus('ログイン済み: ' + truncate(pk, 12), true);
        saveLoginToStorage(pk);
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
    sessionSk = null;
    updateWalletUI();
    clearLoginFromStorage();
    showStatus('ログアウトしました', true);
}

// postMessageを受信してダイアログ制御
window.addEventListener('message', (event) => {
    // セキュリティ: 送信元のオリジンを確認
    // 開発時や GitHub Pages でのホスティング（lokuyow.github.io）や
    // ローカルサーバー（127.0.0.1:3000）からの利用を許可するため、
    // 信頼できるオリジンの一覧を用意する。
    const TRUSTED_ORIGINS = new Set([
        EHAGAKI_ORIGIN,
        window.location.origin,
        'https://lokuyow.github.io',
        'http://127.0.0.1:3000',
    ]);

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
    console.log('eHagakiからメッセージを受信:', data);

    // 親クライアント連携（namespace ベース）のメッセージを優先処理
    if (data && data.namespace === EHAGAKI_NAMESPACE && data.version === 1) {
        // イベント発信元が iframe であることを確認
        if (event.source !== iframe.contentWindow) {
            console.warn('信頼できない送信元 (source) からの親クライアント要求');
            return;
        }

        (async () => {
            try {
                if (data.type === 'auth.request') {
                    // iframe が親に認証情報（pubkey）を要求
                    try {
                        const pubkeyHex = userPubkey || await getCurrentPubkey();
                        iframe.contentWindow.postMessage({
                            namespace: EHAGAKI_NAMESPACE,
                            version: 1,
                            type: 'auth.result',
                            requestId: data.requestId,
                            payload: {
                                pubkeyHex,
                                capabilities: ['signEvent']
                            }
                        }, EHAGAKI_ORIGIN);
                    } catch (err) {
                        iframe.contentWindow.postMessage({
                            namespace: EHAGAKI_NAMESPACE,
                            version: 1,
                            type: 'auth.error',
                            requestId: data.requestId,
                            payload: { message: err.message || 'auth failed' }
                        }, EHAGAKI_ORIGIN);
                    }
                    return;
                }

                if (data.type === 'rpc.request' && data.payload?.method === 'signEvent') {
                    // iframe からの署名リクエスト
                    try {
                        const eventToSign = data.payload?.params?.event;
                        console.debug('親クライアント: 署名リクエスト受信', { requestId: data.requestId });
                        console.debug('親クライアント: eventToSign', JSON.stringify(eventToSign));
                        const signedEvent = await signEventWithYourClient(eventToSign);
                        // Log full signed event as JSON so it's easy to copy for debugging (no secret key present)
                        try {
                            console.debug('親クライアント: 署名結果', { requestId: data.requestId, signedEventJson: JSON.stringify(signedEvent) });
                        } catch (e) {
                            console.debug('親クライアント: 署名結果 (object)', { requestId: data.requestId, signedEvent });
                        }
                        iframe.contentWindow.postMessage({
                            namespace: EHAGAKI_NAMESPACE,
                            version: 1,
                            type: 'rpc.result',
                            requestId: data.requestId,
                            payload: { result: signedEvent }
                        }, EHAGAKI_ORIGIN);
                    } catch (error) {
                        iframe.contentWindow.postMessage({
                            namespace: EHAGAKI_NAMESPACE,
                            version: 1,
                            type: 'rpc.error',
                            requestId: data.requestId,
                            payload: { message: error instanceof Error ? error.message : 'sign failed' }
                        }, EHAGAKI_ORIGIN);
                    }
                    return;
                }
            } catch (e) {
                console.error('親クライアント message handling error', e);
            }
        })();
        return;
    }

    if (data.type === 'POST_SUCCESS') {
        console.log('投稿成功:', data);
        showStatus('✅ 投稿に成功しました！', true);

        // 投稿成功時にダイアログを閉じる
        setTimeout(() => {
            closeDialog();
            // テキストボックスをクリア
            document.getElementById('contentInput').value = '';
        }, 800); // 0.8秒後に閉じる（ユーザーが成功メッセージを確認できるように）

    } else if (data.type === 'POST_ERROR') {
        console.error('投稿失敗:', data);

        // エラーメッセージを生成
        let errorMessage = '❌ 投稿に失敗しました';

        if (data.error) {
            switch (data.error) {
                case 'empty_content':
                    errorMessage += ': 投稿内容が空です';
                    break;
                case 'login_required':
                    errorMessage += ': ログインが必要です';
                    break;
                case 'nostr_not_ready':
                    errorMessage += ': Nostrクライアントが初期化されていません';
                    break;
                case 'key_not_found':
                    errorMessage += ': 秘密鍵が見つかりません';
                    break;
                case 'post_error':
                    errorMessage += ': 投稿エラーが発生しました';
                    break;
                default:
                    errorMessage += `: ${data.error}`;
            }
        }

        showStatus(errorMessage, false);

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
document.addEventListener('DOMContentLoaded', () => {
    console.log('eHagaki iframe テストページが読み込まれました');
    hideStatus();
    // リロード時に保存されたログイン情報を復元
    loadSavedLogin();
    renderTimeline();
    connectRelay();

    // 保存された秘密鍵がある場合、削除ボタンを表示
    try {
        const skClearBtnEl = document.getElementById('skClearBtn');
        if (skClearBtnEl) {
            if (hasStoredSk()) {
                skClearBtnEl.style.display = 'inline-block';
            } else {
                skClearBtnEl.style.display = 'none';
            }
        }
    } catch (e) {
        // ignore
    }
});

// ログイン関連ボタンのイベント
if (loginBtn) loginBtn.addEventListener('click', login);
if (logoutBtn) logoutBtn.addEventListener('click', logout);

// 秘密鍵ログインハンドラ
async function handleSkLogin() {
    const skInputEl = document.getElementById('skInput');
    const skClearBtnEl = document.getElementById('skClearBtn');
    if (!skInputEl) return;
    let skVal = skInputEl.value.trim();
    try {
        if (!skVal) {
            // 入力がない場合は保存鍵を読み込んでログインを試行
            if (hasStoredSk()) {
                const stored = loadSkFromStorage();
                if (!stored) {
                    showStatus('保存鍵の読み込みに失敗しました', false);
                    return;
                }
                sessionSk = stored;
                const pub = await getPubkeyFromSk(sessionSk);
                userPubkey = pub;
                updateWalletUI();
                showStatus('秘密鍵でログインしました: ' + truncate(pub, 12), true);
                if (skClearBtnEl) skClearBtnEl.style.display = 'inline-block';
                saveLoginToStorage(pub);
                return;
            } else {
                showStatus('秘密鍵が入力されていません', false);
                return;
            }
        }

        // 入力は nsec1 形式のみ許容
        if (!skVal.startsWith('nsec1')) {
            showStatus('nsec1形式の鍵を入力してください', false);
            return;
        }

        // bech32 -> HEX に変換して保存
        const skHex = bech32Decode(skVal);
        sessionSk = skHex;
        const pub = await getPubkeyFromSk(sessionSk);
        userPubkey = pub;
        updateWalletUI();
        showStatus('秘密鍵でログインしました: ' + truncate(pub, 12), true);
        saveLoginToStorage(pub);

        // plain HEX を localStorage に保存（パスフレーズは不要）
        saveSkToStorage(sessionSk);
        if (skClearBtnEl) skClearBtnEl.style.display = 'inline-block';
    } catch (e) {
        console.error('handleSkLogin error', e);
        if (e && e.message === 'no_secp_lib') {
            showStatus('ライブラリが読み込めません。index.html に以下のスクリプトを追加して再読み込みしてください: https://cdn.jsdelivr.net/npm/@noble/secp256k1@1.10.0/lib/index.umd.min.js', false);
            console.error('secp256k1 library not available. Add UMD script to index.html or enable network access.');
            _diagnoseSecpGlobals();
        } else {
            showStatus('秘密鍵ログインに失敗しました: ' + (e.message || e), false);
        }
    }
}

// UI ボタンのイベント登録
const skLoginBtn = document.getElementById('skLoginBtn');
const skClearBtn = document.getElementById('skClearBtn');
if (skLoginBtn) skLoginBtn.addEventListener('click', handleSkLogin);
if (skClearBtn) skClearBtn.addEventListener('click', () => {
    clearLocalSkStorage();
    sessionSk = null;
    updateWalletUI();
    skClearBtn.style.display = 'none';
    showStatus('保存した秘密鍵を削除しました', true);
});
