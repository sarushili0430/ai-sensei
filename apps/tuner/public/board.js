/**
 * 板書の受信箱。**アプリ(`apps/mobile` の `BoardInbox` / `BoardChannelReceiver`)と
 * 同じ検査を、同じ順番でやる。**
 *
 * ここを「とりあえず届いた順に積む」で書くと、チューニングの土台が崩れる。
 * 実機では欠落として捨てられる板書が web では出てしまい、
 * **プロンプトを直したのに実機だけ直らない**という見分けのつかない差になる。
 *
 * 検査(`packages/contract/src/board.ts` の `boardChannelLogSchema` が根拠):
 *   - `session_id` が接続中のセッションと一致すること
 *   - `seq` はセッション内で0始まり・1ずつ
 *   - 手順は `board_open` と `board_close` のあいだにあること
 *   - `index` は板書ごとに0始まり・1ずつ
 *   - `board_close.step_count` は実際に届いた手順数と一致すること
 *
 * とぎれたときの振る舞いもアプリに合わせる:
 * **積んだ行は消さない / そこから先は積まない / 次の `board_open` で復帰する**。
 */

/** 契約違反。呼び出し側は板書をとぎれさせる(握りつぶさない)。 */
export class BoardContractViolation extends Error {}

class BoardChannelReceiver {
  constructor(sessionId, expectedSeq = 0) {
    this.sessionId = sessionId;
    this.expectedSeq = expectedSeq;
    this.openBoardId = null;
    this.receivedSteps = 0;
    this.steps = [];
  }

  accept(message) {
    if (message.session_id !== this.sessionId) {
      throw new BoardContractViolation(
        `別のセッション宛てのメッセージです(session_id=${message.session_id}, 期待値=${this.sessionId})`,
      );
    }
    if (message.seq !== this.expectedSeq) {
      throw new BoardContractViolation(
        `seq は0始まりで1ずつ増やしてください(seq=${message.seq}, 期待値=${this.expectedSeq})`,
      );
    }
    this.expectedSeq += 1;

    if (message.type === "board_open") {
      if (this.openBoardId !== null) {
        throw new BoardContractViolation(`板書 ${this.openBoardId} が board_close されていません`);
      }
      this.openBoardId = message.board_id;
      this.receivedSteps = 0;
      this.steps = [];
      return;
    }

    if (message.board_id !== this.openBoardId) {
      throw new BoardContractViolation(
        `board_open されていない板書のメッセージです(board_id=${message.board_id})`,
      );
    }

    if (message.type === "board_step") {
      if (message.step.index !== this.receivedSteps) {
        throw new BoardContractViolation(
          `index は板書ごとに0始まりで1ずつ増やしてください(${this.receivedSteps} を期待して ${message.step.index})`,
        );
      }
      this.receivedSteps += 1;
      this.steps.push(message.step);
      return;
    }

    if (message.type === "board_close") {
      if (message.step_count !== this.receivedSteps) {
        throw new BoardContractViolation(
          `step_count が実際に届いた手順数(${this.receivedSteps})と違います(step_count=${message.step_count})`,
        );
      }
      this.openBoardId = null;
      return;
    }

    throw new BoardContractViolation(`知らない type です: ${String(message.type)}`);
  }
}

export class BoardInbox {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.receiver = new BoardChannelReceiver(sessionId);
    this.title = null;
    this.gapReason = null;
    /** 締めの理由(`completed` / `interrupted` / `error`)。画面の帯に出す。 */
    this.closedReason = null;
  }

  get steps() {
    return this.receiver.steps;
  }

  get hasBoard() {
    return this.title !== null || this.receiver.steps.length > 0;
  }

  /**
   * 封筒1通(JSON文字列)を処理する。戻り値は **板書が変わったか**。
   * 読めない封筒は「何が抜けたか分からない」ので、欠落と同じ扱いにする。
   */
  acceptPayload(payload) {
    let message;
    try {
      message = JSON.parse(payload);
    } catch (error) {
      return this.breakBoard(`封筒を読めませんでした: ${String(error)}`);
    }
    return this.accept(message);
  }

  accept(message) {
    if (this.gapReason !== null) {
      // とぎれた板書には積まない。復帰点は「別の問題に移るとき」だけ。
      if (message?.type !== "board_open") return false;
      this.receiver = new BoardChannelReceiver(this.sessionId, message.seq);
      this.gapReason = null;
      this.title = null;
    }

    try {
      this.receiver.accept(message);
    } catch (error) {
      if (error instanceof BoardContractViolation) return this.breakBoard(error.message);
      throw error;
    }

    if (message.type === "board_open") {
      this.title = message.title;
      this.closedReason = null;
    }
    if (message.type === "board_close") this.closedReason = message.reason;
    return true;
  }

  breakBoard(reason) {
    if (this.gapReason === reason) return false;
    this.gapReason = reason;
    return true;
  }
}
