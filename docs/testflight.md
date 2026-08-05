# TestFlight — ベータ版アプリ情報

App Store Connect の **TestFlight > ベータ版アプリ情報** に貼るテキスト。

この画面の値は**ビルドをまたいで共通**で、テスターがTestFlightアプリで
最初に読む文章になる。外部テスターを入れるときは**ベータ版審査でもここが読まれる**ので、
「何のアプリか」「テスターは何をすればいいか」「課金は本物か」の3つを外さないこと。

ビルドごとの変更点は、こちらではなく**ビルド単位の「テスト内容」**(What to Test)に書く。
両方に同じことを書くと、次のビルドで片方だけ古くなる。

ストア公開側の申請作業は [`ci/store-setup.md`](ci/store-setup.md)、
課金の噛み合わせは [`revenuecat.md`](revenuecat.md)。

---

## 1. ベータ版アプリの説明(日本語)

4000字まで。以下をそのまま貼る。

```text
数学の「わかったつもり」を、声に出して説明させて見つけるアプリです。

ノートを撮ると、後輩AIが「え、なんでここで判別式を使うんですか?」と聞いてきます。
このアプリは答えを教えません。説明しているうちに、自分でも気づいていなかった
「理解の穴」が見つかります。見つかった穴はカルテに残り、翌日・3日後・7日後に
後輩がもう一度たずねてきます。

■ 1周の流れ(4〜5分)
1. 今日やった数学のノートを撮る
2. 読み取った単元が合っているか確認する
3. 後輩の質問に、声に出して説明する
4. 「言えたこと」と「穴」がカルテに残る
5. 通知が届いたら、埋まっていない穴をもう一度説明する

■ 試すときのお願い
・声を出せる場所で、できればイヤホンをつけて試してください。
　スピーカーのままだと、後輩の声をマイクが拾って会話がかみ合わないことがあります。
・扱えるのは高校数学(数I・A・II・B・III・C / 新課程)だけです。
　他教科や大学範囲のノートは想定していません。
・説明が出てこないときは「うまく言えない」を押してください。
　パスは失敗ではなく、そのまま穴として記録される仕様です。
・アカウント登録はありません。記録は端末ごとの匿名IDに紐づくので、
　アプリを削除すると引き継げません。

■ 使用する権限
カメラ(ノートの撮影) / マイク(声での説明) / 通知(復習のお願い)。
いずれも使う直前に確認します。断ってもアプリは続けられます。

■ 無料版とPremium
無料版は1日1セッション・1回5分まで、カルテは当日ぶんの閲覧まで。
Premiumにすると回数が無制限になり、1回15分まで話せて、過去の穴の復習と履歴が見られます。
TestFlightからの購入はすべてSandboxで、実際の請求は発生しません。
Sandboxでは1か月が数分に短縮されるため、更新や失効の挙動もその場で確認できます。

■ 送っていただけると助かるもの
・後輩の質問が、ノートと関係ない / 答えを教えてしまっている / 不快だった
　→ 設定 >「気になる質問を報告する」から、その質問ごと送ってください
・会話が途切れる、声が二重に聞こえる、返事が遅い → 起きた時刻と単元
・カルテの内容が、自分の説明した中身と食い違っている
・数式の聞き取り間違い(「にじょう」「ぶんの」など)
TestFlightのスクリーンショット送信でも受け取れます。

■ データの扱い
撮影したノートの写真と会話の音声は、単元の判定・質問の生成・カルテの作成のために
サーバおよび外部のAIサービスへ送信されます。ベータ期間中のデータは品質の確認に使います。
写り込ませたくないものが入った写真は撮らないでください。
```

### 書いていないことと、その理由

| 書かないもの | 理由 |
| --- | --- |
| Premiumの金額 | ストアの購入画面に出る値が正。ここに書くと価格を変えたときに二重管理になる |
| 無料トライアルの日数 | 付くかどうかは RevenueCat の Offering とストア商品しだいで、ビルドからは約束できない |
| 「AIが解説します」 | §0の約束を破る文言。ストア・通知・ベータ説明で**一度も使わない** |
| 既知の不具合 | ビルドごとに変わるので「テスト内容」側に書く。ここに書くと次のビルドで嘘になる |

## 2. ベータ版アプリの説明(英語)

Shipaton の審査員は英語圏なので、英語ロケールも足しておく
(ロケールは説明欄の右上のプルダウンから追加する)。

```text
A math app that never gives you the answer. You explain — and the gaps show up.

Photograph the notes you worked on today, and a junior student (your "kohai") asks
you about them: "Wait, why did you use the discriminant here?" The app never answers.
While you explain out loud, you find the gaps you didn't know you had. Each gap is
saved to your "karte", and your kohai asks again after 1, 3 and 7 days.

■ One loop (4-5 minutes)
1. Photograph today's math notes
2. Confirm the detected topic is right
3. Answer your kohai's questions out loud
4. What you explained, and where you stalled, are saved to your karte
5. When the reminder arrives, explain the open gap again

■ Notes for testers
- Please test somewhere you can speak out loud, ideally with earphones. On the
  built-in speaker the microphone may pick up the kohai's own voice.
- Scope is Japanese high school mathematics only (Math I, A, II, B, III, C).
- The app is in Japanese and English. The spoken conversation is in Japanese.
- If you can't explain something, tap "I can't explain this yet". Passing is not a
  failure — it is recorded as a gap on purpose.
- No account or sign-in. Everything is tied to an anonymous per-device ID, so
  deleting the app loses the history.

■ Permissions
Camera (photographing notes), microphone (speaking), notifications (review reminders).
Each is requested only at the moment it is needed.

■ Free vs Premium
Free: one session per day, five minutes per session, today's karte only.
Premium: unlimited sessions, fifteen minutes per session, review and history of past gaps.
All TestFlight purchases run in the App Store Sandbox — you will never be charged.
Sandbox compresses a month into a few minutes, so renewal and expiry are testable.

■ What we would like to hear about
- A question from the kohai that was unrelated to the notes, gave away an answer,
  or felt wrong → Settings > "Report a question that felt wrong"
- Dropped audio, echo, or slow replies → the time and the topic
- A karte that does not match what you actually said
Screenshot feedback from TestFlight works too.

■ How your data is used
Photos of your notes and the audio of the conversation are sent to our server and to
third-party AI services to detect the topic, generate questions and build the karte.
During the beta we review this data for quality. Please don't photograph anything
you would not want us to see.
```

## 3. フィードバックメールアドレス

**アプリ内の報告先(`SUPPORT_EMAIL`)と同じアドレスにする。**
テスターから見える窓口を2つに割らないため。

`SUPPORT_EMAIL` は設定画面の「気になる質問を報告する」が開く `mailto:` の宛先で、
本文に端末IDとバージョンが入る([`support_links.dart`](../apps/mobile/lib/src/features/settings/data/support_links.dart))。
Codemagic の変数グループ `mobile-dart-defines` に入れる値と揃えること。

> ここに入れたアドレスは**テスター全員に表示される**。
> 個人の受信箱ではなく、転送か共有のアドレスにしておくと後で移せる。

## 4. 同じ画面のついでに埋めるもの

| 欄 | 値 |
| --- | --- |
| ベータ版アプリの説明 | §1(日本語)・§2(英語) |
| フィードバックメールアドレス | §3 |
| マーケティングURL / プライバシーポリシーURL | `PRIVACY_POLICY_URL` と同じもの(未作成なら先に作る。[`ci/store-setup.md`](ci/store-setup.md) 0-2) |
| ベータ版App Review情報 > サインインが必要 | **いいえ**。アカウントを作らないのでデモアカウントは不要 |
| ベータ版App Review情報 > 連絡先 | 開発者本人。§3と同じで構わない |
| ベータ版App Review情報 > メモ | 外部テスターを入れるときだけ。§5 |

内部テスター(最大100人)は審査なしで配れるので、外部テスターを入れるまでは
§1と§3だけ埋めておけば止まらない。

## 5. 外部テスターを入れるときのメモ欄

ベータ版審査で聞かれる前に、先に書いておく。

```text
・本アプリは高校数学の学習アプリで、解答や解説は生成しません。
　ユーザーが撮影したノートについてAIが質問し、ユーザーが声で説明します。
・AIの質問は、写真から判定した単元と、アプリに同梱した高校数学カリキュラムの
　範囲に限定しています。生成された topic_id はサーバ側でホワイトリスト照合し、
　範囲外のものは再生成させています。
・不適切な質問の報告導線は、アプリ内の 設定 >「気になる質問を報告する」です。
・アカウント登録は不要です。全機能が起動直後から試せます。
・定期購入は RevenueCat SDK 経由です。TestFlightではSandbox購入となり、
　課金は発生しません。
・会話にはマイクを使います。シミュレータではなく実機でご確認ください。
```
