# URL駆動の履歴SSE差分配信計画

## 目的

- 履歴フィルターの状態をCookieではなくページURLのクエリパラメータで表現する。
- 初期HTMLはURLの条件でサーバー側生成し、その同じ条件を履歴SSEにも渡す。
- 選択中runのグラフ、トレース、インスペクター更新と、Run historyの更新を別SSEに分離する。
- 履歴SSEでは全履歴HTMLを繰り返し送らず、フィルター条件に対して変化した行だけを追加、上書き、削除する。

## 非目標

- 実行履歴やフィルターの永続化を追加しない。
- ワークフロー定義、graph-flow実行モデル、cronの意味を変更しない。
- SSEで完全な履歴スナップショットを定期送信するフォールバックを作らない。

## URLを検索条件の唯一の正とする

画面の正規URLは次の形にする。

~~~text
/workflows/{workflow_id}/runs/{run_id}?history_workflow={workflow_id}&history_trigger={manual|cron}&history_status={running|completed|failed}
/workflows/{workflow_id}/runs/?history_workflow={workflow_id}&history_trigger={manual|cron}&history_status={running|completed|failed}
~~~

- パスの workflow_id は現在表示するワークフローである。ルートは登録順で最初のワークフローへリダイレクトする。
- run_id を含むパスは選択中の実行を表す。run_id はその workflow_id に属する必要があり、存在しない値や不一致は 404 とする。
- runがないワークフローの正規パスは末尾スラッシュを含む `/workflows/{workflow_id}/runs/` とする。この画面はグラフだけを表示し、step trace とrun inspectorは表示しない。
- 保持runが一つでもある場合、`/` と `/workflows/{workflow_id}` は当該ワークフローの最新runを含む正規パスへリダイレクトする。保持runがない場合だけ `/workflows/{workflow_id}/runs/` へリダイレクトする。
- history_workflow、history_trigger、history_status は任意であり、省略時は all とする。不正な値も all に正規化する。正規URLのクエリには all 値を含めず、`history_workflow`、`history_trigger`、`history_status` の順で非all値だけを出力する。
- Cookieは使わない。リロード、共有、戻る/進むで同じ条件を復元できる。

履歴フィルターは通常のGET formにする。検索ボタンでページ全体を再生成するため、URL、初期HTML、SSE購読条件が必ず一致する。

~~~html
<form method="get" action="/workflows/{workflow_id}/runs/{selected_run_id_or_empty}">
  <select name="history_workflow">...</select>
  <select name="history_trigger">...</select>
  <select name="history_status">...</select>
  <button type="submit">Search</button>
</form>
~~~

検索直後はSSR済みの履歴を表示し、そのURLに対応するSSEでリアルタイム更新を継続する。入力変更ごとの接続再作成は行わない。

## SSEの責務分離

| エンドポイント | 購読対象 | 初期送信 | 継続送信 |
| --- | --- | --- | --- |
| GET /events/runs/{run_id} | 選択中runのみ | 選択中runのstep traceとinspector。グラフの選択状態も同時に更新できる | そのrunのステップ、状態、出力の更新 |
| GET /events/history?history_workflow=...&history_trigger=...&history_status=...&after={revision} | URLで選んだ履歴集合 | 原則なし。SSRが初期表示を担う | フィルター後の行差分だけ |

- 選択runの変更では run SSEだけを接続し直す。
- 履歴フィルターの検索ではページ遷移により history SSEを接続し直す。
- 実行開始後に選択runへ遷移する場合は、`/workflows/{workflow_id}/runs/{run_id}` へ遷移して新しいrun SSEを購読する。
- run SSEで選択中のグラフを丸ごと再描画してよい。対象が1 runに限定され、更新頻度もワークフローのステップ単位だからである。

## 初期SSRとrevision

履歴には単調増加するrevisionを持たせる。

~~~rust
pub(crate) struct HistoryView {
    pub(crate) revision: u64,
    pub(crate) runs: Vec<RunSnapshot>,
}
~~~

ページハンドラーは次の順で処理する。

1. URLクエリを正規化し、HistoryFilterを作る。
2. フィルター済みHistoryViewを一度だけ読む。
3. そのrunsでRun historyのHTMLをSSRする。
4. revisionと正規化済みフィルターを、history SSE URLの after とクエリへ埋め込む。
5. ブラウザはそのSSE URLへ接続する。

この順序により、SSRの読み取りとSSE購読の間に起きた更新は after 以降の差分再生で補える。

## 差分ジャーナル

履歴データを変更するたびに、変更前と変更後のrunを記録する。

~~~rust
pub(crate) struct HistoryDelta {
    pub(crate) revision: u64,
    pub(crate) run_id: RunId,
    pub(crate) before: Option<RunSnapshot>,
    pub(crate) after: Option<RunSnapshot>,
}
~~~

- 開始時は before が None、after が初期スナップショットになる。
- ノード開始、ノード完了、失敗、完了時は、更新前後のスナップショットを保持する。
- ジャーナルは固定長のVecDequeにする。初期サイズは512件を目安にし、運用負荷に応じて調整する。
- 履歴SSE接続時は after より新しいジャーナルをフィルターして順番に再生してから、ライブ更新を購読する。
- 各接続は最後に送信したrevisionを保持し、重複を送らない。

フィルター判定は変更前と変更後の両方に対して行う。これにより、実行状態の変化で集合へ入る、集合から外れるケースを正しく扱える。

## 履歴行の差分patch

行とtbodyに安定したIDを付ける。

~~~html
<tbody id="run-history-body">
  <tr id="run-history-{run_id}">...</tr>
</tbody>
~~~

| 変更前が一致 | 変更後が一致 | 操作 |
| --- | --- | --- |
| false | true | 最新行としてtbody先頭へprepend |
| true | true | 同じ行をouter patchで上書き |
| true | false | 行をremove |
| false | false | 何もしない |

empty stateは専用IDにし、最初の一致行追加時に削除、最後の一致行削除時に追加する。行数をクライアントだけで推測せず、サーバーのフィルター済み表示状態からpatchを生成する。

Topcoat Datastarのpatchは次の対応を使う。

~~~rust
PatchElements::new(render_run_history_row(&run))
    .selector("#run-history-body")
    .mode(ElementPatchMode::Prepend);

PatchElements::new(render_run_history_row(&run))
    .selector(format!("#run-history-{}", run.run_id));

PatchElements::remove(format!("#run-history-{}", run.run_id));
~~~

## 選択中runのグラフSSE

run SSEは選択中run_idに限定する。接続直後に現在のRunSnapshotからインスペクター領域全体を送信し、その後は同じrun_idのWorkflowEventだけを処理する。

- ノード、エッジ、traceの選択状態は現在のrunスナップショットから再描画する。
- 他runのイベントは選択中グラフへ送らない。
- runが未選択の `/runs/` 画面ではrun SSEを接続しない。グラフはワークフロー定義だけからSSRする。
- 最初の実装はグローバルbroadcastをrun_idでサーバー側フィルターしてよい。後からrun_id別subscribeへ最適化できる。

## 再同期と回復

通常のhistory SSEは全履歴を送らない。次の場合だけ、ブラウザは現在URLへ通常のページロードを行いSSRで再同期する。

- afterがジャーナルの保持範囲より古い。
- broadcast receiverがlagした。
- revisionの不連続など、差分適用の安全性を保証できない。

再同期後は新しいSSR revisionからhistory SSEを再接続する。完全スナップショットはHTTP HTMLでのみ渡す。

## 変更対象

| ファイル | 変更内容 |
| --- | --- |
| src/web_page/routes.rs | runなしの `/runs/` とrunありの `/runs/{run_id}` を含む正規URL、リダイレクト、URLクエリの正規化 |
| src/web_page.rs | GETフィルターform、SSR revision、SSE URL生成 |
| src/web_page/console.rs | 行ID、tbody、empty state、履歴行の部品化 |
| src/web.rs | /events をrun/historyへ分離し、HistoryDeltaからDatastar patchを生成 |
| src/workflow.rs | revision、HistoryView、固定長ジャーナル、履歴購読API |
| src/workflow/driver.rs | RunSnapshot変更の前後を使ってHistoryDeltaを発行 |
| src/history_filter.rs | URLクエリのparse/normalize/match。Cookie処理は削除 |
| src/main.rs | Cookie middlewareがこの用途だけなら削除 |
| tests | URL復元、replay、prepend、outer patch、remove、lag時再同期を確認 |

## 検証計画

1. all条件でSSRした後、開始したrunが先頭に1行だけ追加され、実行進行中は同じ行だけ更新される。
2. completed条件で実行中runを開始すると行は表示されず、完了時に先頭へ追加される。
3. running条件で完了すると行が削除される。
4. フィルター付きURLをリロードして、同じ選択肢、同じSSR履歴、同じSSE条件になる。
5. filter検索後にcron実行が条件一致する場合だけ、ページ再ロードなしで履歴へ反映される。
6. 選択run以外のイベントでは、表示中グラフ、trace、インスペクターが更新されない。
7. ジャーナル範囲外またはreceiver lagで、通常ロードによるSSR再同期へ遷移する。

## 受け入れ条件

- CookieなしでURLだけからワークフロー、選択run、履歴フィルターを復元できる。runなしは正規の `/runs/` URLでグラフだけを復元できる。
- 履歴SSEの通常イベントは単一行の追加、更新、削除のみで、全履歴HTMLを送らない。
- URLフィルターに一致する履歴だけがSSRとリアルタイム更新の両方に現れる。
- グラフSSEは選択中runに限られ、選択runの完全な表示patchは許容する。
- SSRとSSE接続の境界で発生した更新をrevision replayで失わない。
- 差分再生が安全でない場合は、SSEで全量送信せずURLのSSRへ再同期する。
