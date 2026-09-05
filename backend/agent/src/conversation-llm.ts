import type { llm } from "@livekit/agents";
import * as anthropic from "@livekit/agents-plugin-anthropic";

/**
 * 会話LLM。**先輩の指示文にプロンプトキャッシュの印を付ける。**
 *
 * 指示文は `senpai_conversation.<locale>.md`(日本語版で11,000字)に板書の要約
 * (`lessonRecapMaxLength` = 2,000字)と写真の読み取りが載るので、1万トークン級になる。
 * これが**毎ターン丸ごと送られる**(`senpai.ts` の `lessonRecapMaxLength` のコメントも同じ話)。
 * 20分の会話で数十往復すると、会話の中身より指示文の再送のほうが高くつく。
 *
 * プラグイン(1.6.1)は `cache_control` をどこにも付けないので、ここで足す。
 * `_buildAnthropicContext` は `chat()` が `this.` 経由で呼ぶ protected メソッドなので、
 * 差し込み口はここ1箇所で足りる(リクエストの組み立てそのものは触らない)。
 *
 * **印は system の最後のブロックにだけ付ける。** Anthropic はキャッシュを
 * 「印まで」のプレフィックスとして扱うので、末尾に1つ置けば system 全体が載る。
 * 会話履歴(`messages`)には付けない — 毎ターン伸びるので、ブレークポイントを置いても
 * 書き込みばかりでヒットしない。
 *
 * **効くのは指示文が変わらない間だけ。** `agent.ts` の `updateInstructions` は
 * 問題の切り替えと授業の終わりでしか呼ばないので、その区間はまるごとヒットする。
 * 逆に毎ターン差し替える作りへ変えるとキャッシュは死ぬ。書き込みは通常の1.25倍なので、
 * そのときは**付けないより高くつく**。指示文の更新頻度を上げるPRは、ここを一緒に見ること。
 *
 * TTLは既定(5分)のまま。読むたびに延びるので、往復が続いている限り切れない。
 * 沈黙が5分を超えると書き直しが1回入るが、セッション上限は20分(`max_seconds`)で、
 * 教え返しは往復し続ける前提なので、1時間TTL(書き込み2倍)を買うほどではない。
 *
 * **Haiku 4.5 のキャッシュ最小長は4,096トークン**で、下回ると
 * エラーも警告もなく黙って無視される。指示文を大幅に削るときは、
 * `voice_metrics` の `cached_tokens` が 0 に落ちていないかを見ること。
 */
export class CachedInstructionsLLM extends anthropic.LLM {
  protected override _buildAnthropicContext(chatCtx: llm.ChatContext) {
    const context = super._buildAnthropicContext(chatCtx);
    const lastIndex = context.system.length - 1;
    const last = context.system[lastIndex];
    // system が空になるのは指示文がまだ無いとき。印の付け先が無いので素通しする。
    if (last === undefined) return context;
    return {
      ...context,
      system: context.system.with(lastIndex, {
        ...last,
        cache_control: { type: "ephemeral" },
      }),
    };
  }
}
