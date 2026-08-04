# 写真解析(Vision LLM)の相見積もり — 2026-08 時点

`backend/api/src/lib/photo-analysis.ts` の `createAnthropicAnalyzer` が使っている
Vision LLM のコストを、他プロバイダと比較した資料。

**結論を先に:**

1. 一番効くのは**プロバイダ変更より先に「送る画像を小さくする」**。今は端末のフル解像度を
   そのまま投げていて、Claude 側で 4,784 visual token(上限)まで課金されている。
2. その上で乗り換えるなら **Gemini 2.5 Flash-Lite(約 1/54)** か
   **GPT-5.4 nano / Gemini 3 Flash(約 1/20)**。Anthropic 内で完結させたいなら
   **Haiku 4.5 + プロンプトキャッシュで 1/6.6**。
3. **2026-08-31 に Claude Sonnet 5 の導入価格が終了し、何もしなければ単価が 1.5 倍になる。**
   これが実質的な期限。

---

## 1. 現状の課金内訳

| 項目 | 値 | 出典 |
| --- | --- | --- |
| モデル | `claude-sonnet-5` | `backend/api/wrangler.toml` (`LLM_MODEL_VISION`) |
| 単価 | $3.00 / $15.00 per MTok(**導入価格 $2/$10 は 2026-08-31 まで**) | Anthropic 公式 |
| 画像の送り方 | `ImagePicker().pickImage(imageQuality: 85)` — **リサイズ指定なし** | `apps/mobile/lib/src/features/capture/presentation/capture_screen.dart:37` |
| system prompt | カリキュラム52件 + 指示 = 3,750文字 ≒ **2,200 token(概算)** | `prompts/photo_analysis.ja.md` + `curriculumDigest()` |
| プロンプトキャッシュ | **未使用** | `photo-analysis.ts:110-126` |

### 画像トークンの計算式(Anthropic 公式)

Claude は画像を **28×28px のパッチ**に分割し、`⌈幅/28⌉ × ⌈高さ/28⌉` を visual token として課金する。
モデル世代ごとに上限がある:

| 解像度 tier | 対象モデル | 長辺上限 | visual token 上限 |
| --- | --- | --- | --- |
| High-resolution | **Claude 4.7 以降(= Sonnet 5 / Opus 5)** | 2576 px | **4,784** |
| Standard | それ以前(= **Haiku 4.5**) | 1568 px | 1,568 |

つまり今の構成は、iPhone のフル解像度写真(12MP)を送る
→ 2576×1932 に縮小される → **画像だけで 4,784 token = 上限に張り付いている**。

> 公式ドキュメントにも「高解像度が不要なら送信前にダウンサンプルしてコストを抑えよ」と明記されている。

### 1枚あたりの内訳(現行)

```
画像      4,784 tok
system    2,200 tok
user text    20 tok
─────────────────
入力      7,004 tok × $3/M  = $0.0210
出力        500 tok × $15/M = $0.0075
                    合計    = $0.0285 ≒ 4.3円
```

---

## 2. 相見積もり表

前提: 1枚あたり出力500 token、system 2,200 token、150円/$ 換算。
「キャッシュ」は system prompt をプロンプトキャッシュに載せた場合(読み出しは約1/10)。

| モデル | in $/M | out $/M | 画像tok | 入力tok | 1枚 円 | 3万枚/月 | 30万枚/月 | 現行比 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Claude Sonnet 5(現行・定価)** | 3.00 | 15.00 | 4,784 | 7,004 | **4.28** | 128,304円 | 1,283,040円 | 1.0x |
| Claude Sonnet 5(〜8/31 導入価格) | 2.00 | 10.00 | 4,784 | 7,004 | 2.85 | 85,536円 | 855,360円 | 1.5x |
| Claude Sonnet 5 + 画像1092px + キャッシュ | 3.00 | 15.00 | 1,170 | 1,410 | 1.76 | 52,785円 | 527,850円 | 2.4x |
| Claude Haiku 4.5 | 1.00 | 5.00 | 1,568 | 3,788 | 0.94 | 28,296円 | 282,960円 | 4.5x |
| **Claude Haiku 4.5 + キャッシュ** | 1.00 | 5.00 | 1,568 | 1,808 | **0.65** | 19,386円 | 193,860円 | **6.6x** |
| Gemini 3.6 Flash | 1.50 | 7.50 | 1,032 | 3,252 | 1.29 | 38,826円 | 388,260円 | 3.3x |
| Gemini 3 Flash (preview) | 0.25 | 1.50 | 1,032 | 3,252 | 0.23 | 7,034円 | 70,335円 | 18.2x |
| **Gemini 2.5 Flash-Lite** | 0.10 | 0.40 | 1,032 | 3,252 | **0.08** | 2,363円 | 23,634円 | **54.3x** |
| GPT-5.4 mini | 0.75 | 4.50 | 1,536 | 3,756 | 0.76 | 22,802円 | 228,015円 | 5.6x |
| **GPT-5.4 nano** | 0.20 | 1.25 | 1,536 | 3,756 | **0.21** | 6,193円 | 61,929円 | **20.7x** |
| Qwen3-VL 30B A3B (DeepInfra) | 0.15 | 0.50 | 1,300 | 3,520 | 0.12 | 3,501円 | 35,010円 | 36.6x |
| Qwen3-VL 8B (DeepInfra / Fireworks) | 0.20 | 0.60 | 1,300 | 3,520 | 0.15 | 4,518円 | 45,180円 | 28.4x |

> **数値の確度について。** Anthropic の単価と画像トークン式は公式ドキュメント準拠。
> それ以外(Gemini / OpenAI / DeepInfra)は 2026年8月時点の第三者集計サイト経由のため、
> **契約前に各社の公式 pricing ページで再確認すること**。
> system prompt のトークン数も `count_tokens` を叩いていない概算値。

### 画像トークンの数え方はプロバイダごとに違う

| プロバイダ | 方式 | 4:3 のノート写真での目安 |
| --- | --- | --- |
| Anthropic | 28×28 パッチ。上限 4,784 (high-res) / 1,568 (standard) | 4,784(フル解像度) |
| Google Gemini | 768×768 タイル × 258 token。384px以下は258固定。Gemini 3 は `media_resolution` で制御可 | 1,032(1536×1152 の場合) |
| OpenAI | 32×32 パッチ、上限1,536パッチ。mini/nano は係数倍あり | 〜1,536 |

Gemini は同じ絵でも Claude の 1/4〜1/5 のトークンにしかならない。
**単価差(30倍)とトークン差(4.6倍)が掛け算になるので、Flash-Lite との差が 54倍に開く。**

---

## 3. 専用OCRという別ルート

「読み取り」と「カリキュラム照合」を分離して、前段を専用OCRに寄せる案。

| サービス | 価格 | 手書き | 数式 | 備考 |
| --- | --- | --- | --- | --- |
| Mathpix Convert API | $0.002〜/枚 (≒0.3円) | ◎ | ◎(LaTeX) | 数式特化。日本語対応の確認が必要 |
| Google Cloud Vision (`DOCUMENT_TEXT_DETECTION`) | $1.50/1000枚 (≒0.23円)、月1000枚無料 | ○ | △ | 数式のレイアウトは苦手 |
| Google Document AI (Enterprise OCR) | $1.50/1000枚、500万枚超で$0.60 | ○ | △ | 同上 |
| AWS Textract | $1.50/1000枚 | ○ | △ | 数式非対応に近い |
| セルフホスト(GLM-OCR / PaddleOCR-VL / DeepSeek-OCR2) | GPU固定費のみ | ○ | ○ | 損益分岐は月5〜10万枚。今の規模では割に合わない |

**ただしこのルートは、OCR結果を `topic_id` に対応づける second pass の LLM が別途必要**で、
合計すると Gemini Flash-Lite 一発(0.08円)より高くつく可能性が高い。
`photo_analysis` は単なる文字起こしではなく「カリキュラム照合 + 質問の種の抽出」なので、
**VLM 一発のほうが構成としても素直**。専用OCRは、VLM 単体で手書き認識精度が足りなかった
場合の補強(OCR結果をVLMに併せて渡す)として検討するのが現実的。

---

## 4. 推奨アクション(効果が大きい順)

### ① 画像を送信前にリサイズする ── コード変更のみ、乗り換え不要

`capture_screen.dart` の `pickImage` に `maxWidth` / `maxHeight` を渡すだけ。

```dart
await ImagePicker().pickImage(
  source: ImageSource.camera,
  imageQuality: 85,
  maxWidth: 1568,   // 要 A/B。1092 まで下げると画像tokは 1,170
);
```

- 4,784 → 1,170 token で **画像コストが約 1/4**
- 転送量が減るのでモバイル回線での待ち時間も縮む
- **トレードオフ**: 手書き数式は細部が命なので、下げすぎると読み取り精度が落ちる。
  Anthropic 公式も high-res の利点として「dense documents」を挙げている。
  **必ず実写データで精度を測ってから決めること**(→ Issue の評価データセット)

### ② プロンプトキャッシュを有効にする ── 数行の変更

system prompt は全リクエストで**バイト単位で同一**(`curriculumDigest()` は決定的)なので、
キャッシュ条件を満たす。Sonnet 5 の最小キャッシュ長は 1,024 token、system は約 2,200 token。

```ts
system: [{ type: "text", text: photoAnalysisPrompt(), cache_control: { type: "ephemeral" } }],
```

- 入力 2,200 → 220 token 相当で、1枚あたり約 19% 削減
- **注意**: TTL は既定5分。トラフィックが 5分に1回未満だと書き込み料(1.25倍)だけ払って
  読み出せない。ローンチ直後は `ttl: "1h"`(書き込み2倍)か、様子見で無効のほうが安いこともある

### ③ モデルを乗り換える

`Bindings` にはすでに `LLM_PROVIDER` / `OPENROUTER_API_KEY` / `LLM_MODEL_VISION` が定義済みだが、
`app.ts:73` は `createAnthropicAnalyzer` をハードコードしている。
`PhotoAnalyzer` は DI 可能なインターフェース(テストでは in-memory 実装に差し替え済み)なので、
**プロバイダ切り替えの実装コストは低い**。

推奨順:

1. **OpenRouter 経由で全候補を横並び評価** — 1つのキーで Gemini / GPT / Qwen を叩ける。
   評価フェーズだけ OpenRouter、本番は直契約、という使い分けが効率的
2. 精度が許容範囲なら **Gemini 2.5 Flash-Lite**(54倍安)
3. 精度が足りなければ **Gemini 3 Flash / GPT-5.4 nano**(20倍安)
4. Anthropic に残すなら **Haiku 4.5 + キャッシュ**(6.6倍安)。
   コードもプロンプトもほぼそのまま使えるのが利点

### ④ 無料枠のガードは既に効いている

`FREE_SESSIONS_PER_DAY = "1"` がサーバ側で強制されているので、
無課金ユーザ1人あたり写真1枚/日が上限。上の「3万枚/月」は DAU 1,000人相当。

---

## 5. 精度の検証なしに乗り換えないこと

このアプリのVLMは「文字が読めればいい」のではなく、

- 日本語の**手書き**を読む
- 数式(判別式、積分記号、添字)を読む
- 52トピックのカリキュラムに**正しく**対応づける
- **解答を書かない**というガードレールを守る

を全部やる必要がある。安いモデルほど最後の2つ(指示追従)が落ちやすい。
`packages/guardrail` と `resolveDetectedTopics()` のフォールバックがあるので破綻はしないが、
`topics` が空配列になる率が上がると体験が劣化する。

**判断材料は実写データでの A/B しかない。** 評価軸:

| 指標 | 測り方 |
| --- | --- |
| `is_math_note` 判定精度 | 数学ノート/それ以外を各20枚 |
| `topic_id` の的中率 | 人間が付けた正解ラベルとの一致率 |
| `topic_id` 捏造率 | `resolveDetectedTopics()` の `droppedIds` の発生率 |
| 解答漏洩率 | `visible_work` / `question_seeds` に解法や答えが混入した件数 |
| `unreadable` の妥当性 | 読めるのに読めないと言う / 読めないのに捏造する |
| p95 レイテンシ | 撮影→会話開始までの体感に直結 |

---

## 出典

- [Anthropic — Vision(画像トークン計算式・解像度tier)](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Anthropic — Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini — Understand and count tokens](https://ai.google.dev/gemini-api/docs/tokens)
- [Gemini 3.6 Flash pricing breakdown (eesel)](https://www.eesel.ai/blog/gemini-3-6-flash-pricing)
- [Gemini API Pricing (BenchLM, 2026-08)](https://benchlm.ai/google/api-pricing)
- [OpenAI API Pricing In 2026 (CloudZero)](https://www.cloudzero.com/blog/openai-pricing/)
- [OpenAI — Images and Vision](https://platform.openai.com/docs/guides/images)
- [Qwen3-VL 32B pricing across providers (Price Per Token)](https://pricepertoken.com/pricing-page/model/qwen-qwen3-vl-32b-instruct)
- [Mathpix Convert API pricing](https://mathpix.com/pricing/api)
- [Google Document AI pricing](https://cloud.google.com/document-ai/pricing)
- [Best Open-Source OCR / Document VLMs 2026 (Spheron)](https://www.spheron.network/blog/best-open-source-ocr-vlm-self-host-gpu-cloud-2026/)
- [Google Gemini データ取扱い(有料枠は学習利用なし)](https://meetily.ai/llm-privacy/gemini)
