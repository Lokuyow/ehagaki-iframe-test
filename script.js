// DOM要素の取得
const openDialogBtn = document.getElementById('openDialogBtn');
const modal = document.getElementById('modal');
const closeBtn = document.getElementById('closeBtn');
const statusDiv = document.getElementById('status');
const iframe = document.getElementById('ehagaki-iframe');

// ダイアログを開く
function openDialog() {
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden'; // 背景のスクロールを無効化
    hideStatus();
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

// postMessageを受信してダイアログ制御
window.addEventListener('message', (event) => {
    // セキュリティ: 送信元のオリジンを確認
    if (event.origin !== 'https://ehagaki.vercel.app') {
        console.warn('信頼できないオリジンからのメッセージを受信:', event.origin);
        return;
    }

    const data = event.data;
    console.log('eHagakiからメッセージを受信:', data);

    if (data.type === 'POST_SUCCESS') {
        console.log('投稿成功:', data);
        showStatus('✅ 投稿に成功しました！', true);

        // 投稿成功時にダイアログを閉じる
        setTimeout(() => {
            closeDialog();
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

// ページ読み込み時の初期化
document.addEventListener('DOMContentLoaded', () => {
    console.log('eHagaki iframe テストページが読み込まれました');
    hideStatus();
});