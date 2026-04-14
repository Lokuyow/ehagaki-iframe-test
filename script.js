// DOM要素の取得
const openDialogBtn = document.getElementById('openDialogBtn');
const modal = document.getElementById('modal');
const closeBtn = document.getElementById('closeBtn');
const statusDiv = document.getElementById('status');
const iframe = document.getElementById('ehagaki-iframe');
const timelineStatusDiv = document.getElementById('timelineStatus');
const timelineDiv = document.getElementById('timeline');

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
async function getCurrentPubkey() {
    if (userPubkey) return userPubkey;
    if (window.nostr && typeof window.nostr.getPublicKey === 'function') {
        try {
            const pk = await window.nostr.getPublicKey();
            return pk;
        } catch (err) {
            throw new Error('user_rejected');
        }
    }
    throw new Error('no_wallet');
}

async function signEventWithYourClient(event) {
    if (!window.nostr) {
        throw new Error('no_wallet');
    }

    if (typeof window.nostr.signEvent === 'function') {
        try {
            const signed = await window.nostr.signEvent(event);
            if (typeof signed === 'string') {
                return { ...event, sig: signed };
            }
            return signed;
        } catch (err) {
            throw err;
        }
    }

    throw new Error('no_sign_function');
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
            showStatus('ログインに使用できるクライアントが見つかりません（NIP-07 対応が必要です）。', false);
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
    updateWalletUI();
    clearLoginFromStorage();
    showStatus('ログアウトしました', true);
}

// postMessageを受信してダイアログ制御
window.addEventListener('message', (event) => {
    // セキュリティ: 送信元のオリジンを確認
    if (event.origin !== EHAGAKI_ORIGIN) {
        console.warn('信頼できないオリジンからのメッセージを受信:', event.origin);
        return;
    }

    const data = event.data;
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
                        const signedEvent = await signEventWithYourClient(eventToSign);
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
});

// ログイン関連ボタンのイベント
if (loginBtn) loginBtn.addEventListener('click', login);
if (logoutBtn) logoutBtn.addEventListener('click', logout);
