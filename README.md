# eHagaki iframe 埋め込みテスト

このプロジェクトは、eHagakiをiframeとしてダイアログ内に埋め込む実装例です。

## 機能

- ボタンクリックでモーダルダイアログを開く
- ダイアログ内にeHagakiのiframeを表示
- 投稿成功時（`POST_SUCCESS`）にダイアログを自動で閉じる
- 投稿失敗時（`POST_ERROR`）にエラーメッセージを表示
- セキュアなpostMessage通信

## ファイル構成

- `index.html` - メインのHTMLファイル
- `script.js` - JavaScript処理（ダイアログ制御、postMessage受信）
- `README.md` - このファイル

## 使い方

1. `index.html`をWebブラウザで開く
2. 「📝 eHagaki を開く」ボタンをクリック
3. ダイアログ内でeHagakiを使用して投稿
4. 投稿成功時に自動でダイアログが閉じる

## 実装されている機能

### ダイアログ制御
- ボタンクリックでダイアログを開く
- ×ボタン、背景クリック、ESCキーでダイアログを閉じる
- 投稿成功時に自動でダイアログを閉じる（0.8秒後）

### postMessage受信
- `POST_SUCCESS`: 投稿成功時にダイアログを閉じる
- `POST_ERROR`: エラーメッセージを表示（ダイアログは閉じない）

### セキュリティ
- オリジン検証（`https://lokuyow.github.io`のみ許可。）
- 不正なメッセージの無視