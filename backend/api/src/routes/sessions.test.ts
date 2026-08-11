import type { CreateSessionResponse } from "@ai-sensei/contract";
import {
  createSessionResponseSchema,
  problemTextMaxLength,
  sessionMetadataSchema,
  sessionPhotoParts,
} from "@ai-sensei/contract";
import { localeOfTopicId } from "@ai-sensei/curriculum";
import { formatProblemText, formatVisibleWork, getPrompt } from "@ai-sensei/prompts";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { verifyJwt } from "../lib/livekit.ts";
import {
  JPEG_BYTES,
  RecordingAnalyzer,
  type TestServices,
  analysisFixture,
  analysisFixtureEn,
  concurrencyBarrier,
  createSessionForm,
  problemPhotoFile,
  testBindings,
  testDeviceId,
  testServices,
} from "../test-support.ts";

let services: TestServices;
const app = createApp({ services: () => services });
const bindings = testBindings();

beforeEach(() => {
  services = testServices();
});

function post(form: FormData, headers: Record<string, string> = {}) {
  return app.request(
    "/v1/sessions",
    { method: "POST", body: form, headers: { "x-device-id": testDeviceId, ...headers } },
    bindings,
  );
}

function patchTopics(sessionId: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    `/v1/sessions/${sessionId}/topics`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-device-id": testDeviceId,
        ...headers,
      },
    },
    bindings,
  );
}

describe("POST /v1/sessions", () => {
  it("写真から単元を検出し、LiveKitトークンを返す", async () => {
    const response = await post(createSessionForm());
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.detected_topics.map((topic) => topic.topic_id)).toContain("M2-ZUKEI-ENCHOKU");
    expect(body.livekit.room).toBe(body.session_id);
  });

  it("LiveKitトークンに会話の文脈(許可トピック)を載せる", async () => {
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;

    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    expect(claims).not.toBeNull();
    const metadata = JSON.parse(String(claims?.["metadata"])) as {
      allowed_topic_ids: string[];
      max_seconds: number;
    };
    expect(metadata.allowed_topic_ids).toContain("M2-ZUKEI-ENCHOKU");
    // 前提トピックまで深掘りを許す
    expect(metadata.allowed_topic_ids).toContain("M1-NIJI-HANBETSU");
    expect(metadata.max_seconds).toBe(1200);
  });

  // 名前つきワーカーのときは、トークンでディスパッチしないと部屋に誰も来ない
  it("LIVEKIT_AGENT_NAMEがあれば、トークンで先輩を呼ぶ", async () => {
    const named = testBindings({ LIVEKIT_AGENT_NAME: "ai-sensei-senpai" });
    const response = await app.request(
      "/v1/sessions",
      { method: "POST", body: createSessionForm(), headers: { "x-device-id": testDeviceId } },
      named,
    );
    const body = (await response.json()) as CreateSessionResponse;

    const claims = await verifyJwt(body.livekit.token, named.LIVEKIT_API_SECRET);
    const roomConfig = claims?.["roomConfig"] as { agents: { agent_name: string }[] } | undefined;
    expect(roomConfig?.agents[0]?.agent_name).toBe("ai-sensei-senpai");
    // 文脈はジョブ側にも載せる(エージェントが参加者を待たずに読めるように)
    const dispatched = JSON.parse(
      String((roomConfig?.agents[0] as { metadata?: string } | undefined)?.metadata),
    ) as { allowed_topic_ids: string[] };
    expect(dispatched.allowed_topic_ids).toContain("M2-ZUKEI-ENCHOKU");
  });

  it("LIVEKIT_AGENT_NAMEが空なら自動ディスパッチに任せる", async () => {
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;
    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    expect(claims?.["roomConfig"]).toBeUndefined();
  });

  it("デバイスIDがなければ401", async () => {
    const response = await app.request(
      "/v1/sessions",
      { method: "POST", body: createSessionForm() },
      bindings,
    );
    expect(response.status).toBe(401);
  });

  // 無料枠はサーバ側で数える(クライアント改竄対策)
  it("無料ユーザーは1日1セッションまで", async () => {
    expect((await post(createSessionForm())).status).toBe(201);

    const second = await post(createSessionForm());
    expect(second.status).toBe(402);
    const body = (await second.json()) as { error: { code: string; retry_after_seconds: number } };
    expect(body.error.code).toBe("free_limit_reached");
    // 「また明日」と言えるように、翌日までの秒数を返す
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
  });

  it("Premiumは通常利用の2回目まで通り、無料と同じ20分を使える", async () => {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: "rc_1",
    });

    await post(createSessionForm());
    const second = await post(createSessionForm());
    expect(second.status).toBe(201);

    const body = (await second.json()) as CreateSessionResponse;
    expect(body.limits.max_seconds).toBe(1200);
    expect(body.limits.lesson_allowed_today).toBe(true);
  });

  it("Premiumは3回を使ったあとの4回目をフェアユースとして止める", async () => {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: "rc_1",
    });

    for (let count = 0; count < 3; count += 1) {
      expect((await post(createSessionForm())).status).toBe(201);
    }

    const fourth = await post(createSessionForm());
    expect(fourth.status).toBe(429);
    const body = (await fourth.json()) as {
      error: { code: string; message: string; retry_after_seconds: number };
    };
    expect(body.error.code).toBe("fair_use_limit_reached");
    expect(body.error.message).not.toMatch(/[0-9０-９]/);
    expect(body.error.retry_after_seconds).toBeGreaterThan(0);
  });

  it("数学のノートでなければ撮り直しを促す", async () => {
    services = testServices({
      analysis: {
        is_math_note: false,
        summary: "英語の単語帳が写っている",
        problem_text: "",
        visible_work: [],
        topics: [],
        unreadable: [],
        question_seeds: [],
      },
    });
    const response = await post(createSessionForm());
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "out_of_scope",
    );
  });

  it("単元を1つも特定できなければセッションを作らない", async () => {
    services = testServices({
      analysis: {
        is_math_note: true,
        summary: "ぼやけていて読み取れない",
        problem_text: "",
        visible_work: [],
        topics: [],
        unreadable: ["全体的に暗い"],
        question_seeds: [],
      },
    });
    const response = await post(createSessionForm());
    expect(response.status).toBe(422);
    expect(services.repository.sessions.size).toBe(0);
  });

  it("ユーザーがチップUIで直した単元を優先する", async () => {
    const response = await post(createSessionForm({ topic_ids: ["M1-NIJI-GURAFU"] }));
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M1-NIJI-GURAFU"]);
  });

  it("LLMが捏造したtopic_idは許可リストに入れない", async () => {
    services = testServices({
      analysis: {
        is_math_note: true,
        summary: "円と直線の位置関係",
        problem_text: "",
        visible_work: [],
        topics: [
          { topic_id: "M2-ZUKEI-ENCHOKU", confidence: 0.9 },
          { topic_id: "MX-SENKEI-DAISU", confidence: 0.8 },
        ],
        unreadable: [],
        question_seeds: [],
      },
    });
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M2-ZUKEI-ENCHOKU"]);
  });

  it("写真をR2に保存する", async () => {
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;
    const session = await services.repository.getSession(body.session_id);
    expect(session?.photo_key).toBe(`photos/${testDeviceId}/${body.session_id}`);
  });

  /**
   * Flutterの MultipartFile は contentType を渡さないと
   * application/octet-stream を送ってくる。申告をそのまま media_type にすると
   * Vision APIが400を返し、アプリからの写真つきセッションが全部500になっていた。
   */
  it("申告が application/octet-stream でも、中身を見てJPEGとして解析にかける", async () => {
    // 申告をそのまま渡していないことを見たいので、解析器が受け取った値を捕まえる
    let received: string | undefined;
    services = {
      ...testServices(),
      analyzer: {
        async analyze({ notes }) {
          received = notes?.contentType;
          return analysisFixture;
        },
      },
    };

    const form = new FormData();
    form.set(
      sessionPhotoParts.notes,
      new File([JPEG_BYTES], "note", { type: "application/octet-stream" }),
    );
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));

    const response = await post(form);
    expect(response.status).toBe(201);
    expect(received).toBe("image/jpeg");
  });

  it("画像でないものは422で返す(Vision APIに投げて500にしない)", async () => {
    const form = new FormData();
    form.set(
      "photo",
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "note.pdf", {
        type: "application/pdf",
      }),
    );
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));

    const response = await post(form);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("photo_unreadable");
  });

  it("読み取れない写真は今日の無料枠を消費しない", async () => {
    const form = new FormData();
    form.set("photo", new File([new Uint8Array([0, 1, 2, 3])], "note", { type: "image/heic" }));
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));
    expect((await post(form)).status).toBe(422);

    // 押さえた枠が返っていれば、撮り直した1枚はちゃんと通る
    expect((await post(createSessionForm())).status).toBe(201);
  });
});

// レビュー指摘: 復習はPremium機能なのに、hole_idを直接渡せば無料でも通っていた
describe("復習セッション", () => {
  async function seedHole(deviceId = testDeviceId): Promise<string> {
    await services.repository.insertKarte(
      {
        id: "kar_seed",
        session_id: "ses_seed",
        device_id: deviceId,
        created_at: "2026-08-01T11:00:00.000Z",
        topic_ids: ["M1-NIJI-GURAFU"],
        said_well: [],
        term_notes: [],
        followup_question: null,
      },
      [
        {
          id: "hol_seed",
          device_id: deviceId,
          karte_id: "kar_seed",
          topic_id: "M1-NIJI-GURAFU",
          desc: "平方完成のなぜで説明が止まった",
          severity: "high",
          evidence: null,
          status: "open",
          created_at: "2026-08-01T11:00:00.000Z",
          filled_at: null,
        },
      ],
    );
    return "hol_seed";
  }

  async function makePremium(): Promise<void> {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: null,
    });
  }

  function reviewForm(holeId: string): FormData {
    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "ja", hole_id: holeId }));
    return form;
  }

  it("無料ユーザーは hole_id を直接渡しても始められない", async () => {
    const holeId = await seedHole();
    const response = await post(reviewForm(holeId));
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "premium_required",
    );
  });

  it("Premiumは写真なしで復習セッションを始められる", async () => {
    await makePremium();
    const holeId = await seedHole();

    const response = await post(reviewForm(holeId));
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    expect(body.kind).toBe("review");
    // 写真がなくても、穴から単元を引く
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M1-NIJI-GURAFU"]);
  });

  it("他人の穴IDでは始められない", async () => {
    await makePremium();
    const holeId = await seedHole("99999999-8888-7777-6666-555555555555");

    const response = await post(reviewForm(holeId));
    expect(response.status).toBe(404);
  });

  /**
   * 端末を英語に切り替えたあとで、日本語で残した穴を復習する場合。
   * 穴の説明文も単元名も日本語なので、**会話は穴の課程の言語で始める**。
   * 表示言語(エラー文言)はアプリ側のままにする。
   */
  it("会話の言語は端末の設定ではなく、穴の課程で決まる", async () => {
    await makePremium();
    const holeId = await seedHole();

    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "en", hole_id: holeId }));

    const response = await post(form);
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    const metadata = JSON.parse(String(claims?.["metadata"])) as {
      locale: string;
      photo_summary: string;
    };

    expect(metadata.locale).toBe("ja");
    expect(metadata.photo_summary).toBe("前回、平方完成のなぜで説明が止まった");
  });

  it("表示言語(エラー文言)はアプリの設定に従う", async () => {
    const holeId = await seedHole();

    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "en", hole_id: holeId }));

    const response = await post(form);
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });
});

/**
 * 問題文のグラウンディング(計画書 §0 の決定4「問題とノートをセットで送る」)。
 *
 * ここが空のまま授業が始まると、**先輩は問題そのものを見ないまま教える**。
 * §1-1「AIが理解している建て付けのアプリほど誤読が致命傷になる」の急所。
 */
describe("問題文", () => {
  async function start(options: { problemPhoto?: File } = {}) {
    const response = await post(createSessionForm({}, options));
    expect(response.status).toBe(201);
    return (await response.json()) as CreateSessionResponse;
  }

  async function metadataOf(body: CreateSessionResponse) {
    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    return JSON.parse(String(claims?.["metadata"])) as { problem_text: string };
  }

  it("解析が読み取った問題文を、エージェントに渡す文脈に載せる", async () => {
    const metadata = await metadataOf(await start());
    expect(metadata.problem_text).toBe(analysisFixture.problem_text);
    // 要約(何が写っているか)を問題文として流用しない。これが元の不具合そのもの。
    expect(metadata.problem_text).not.toBe(analysisFixture.summary);
  });

  it("問題文をアプリにも返す(授業が始まる前に誤読を見せる)", async () => {
    const body = await start();
    expect(body.problem).toEqual({
      text: analysisFixture.problem_text,
      source: "notes_photo",
    });
  });

  // §4-1「写真2枚を必須にしない」。1枚に両方写るケースが多い。
  it("問題の写真が無くてもセッションは成立する", async () => {
    const body = await start();
    expect(body.session_id).toBeTruthy();
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: true, hadProblem: false },
    ]);
  });

  it("問題の写真を送ると、1回の解析に2枚まとめて渡す", async () => {
    const body = await start({ problemPhoto: problemPhotoFile() });
    // 2回叩くとVisionの課金が倍になり、しかも解析器が2枚を突き合わせられない
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: true, hadProblem: true },
    ]);
    expect(body.problem?.source).toBe("problem_photo");
  });

  /**
   * **著作物の扱い**(§4-1 / §10-4 を「解析後破棄」で決着させたもの)。
   * 教科書・問題集の紙面はR2に残さない。残っていないことを数で見る。
   */
  it("問題の写真はR2に保存しない(ノートだけが残る)", async () => {
    const body = await start({ problemPhoto: problemPhotoFile() });
    const stored = [
      ...(bindings.PHOTOS as unknown as { objects: Map<string, unknown> }).objects.keys(),
    ];

    // このセッションについてR2にあるのは、ノートの1件だけ。
    // 紙面が別キーで残っていれば、ここが2件になる。
    expect(stored.filter((key) => key.endsWith(body.session_id))).toEqual([
      `photos/${testDeviceId}/${body.session_id}`,
    ]);
  });

  /**
   * 2枚目が読めないだけでセッションを落とすと、**任意のはずの写真が事実上の必須**になり、
   * 「2枚必須にしない」がAPIの側から破れる。
   */
  it("問題の写真が壊れていても、ノートだけで進む", async () => {
    const form = createSessionForm();
    form.set(
      sessionPhotoParts.problem,
      new File([new Uint8Array([0, 1, 2, 3])], "p", { type: "image/heic" }),
    );

    const response = await post(form);
    expect(response.status).toBe(201);
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: true, hadProblem: false },
    ]);
  });

  // 問題が読めなくても授業は始まる。ただし先輩には「無い」と伝わっていないといけない。
  it("読み取れなければ null を返し、先輩には写真なしと伝える", async () => {
    services = testServices({ analysis: { ...analysisFixture, problem_text: "" } });
    const body = await start();

    expect(body.problem).toBeNull();
    expect((await metadataOf(body)).problem_text).toBe("(問題の写真なし)");
  });

  /**
   * このプレースホルダは `prompts/senpai_board.*.md` が名指しで見ている。
   * **ずれると「問題文を推測で組み立てないこと」という指示が発火しない** —
   * 発火しなければ、先輩は自分で作った問題を教えはじめる。
   *
   * 文言の正本は `@ai-sensei/prompts` の `formatProblemText()` に移した。
   * `packages/prompts` 側にも同じ照合があるが、こちらは別の壊れ方を見ている —
   * **API が正本を通さずに文言を組み立て直したら**、あちらは緑のままここが落ちる。
   */
  it("プレースホルダが、先輩のプロンプトが見ている文言と一致する", () => {
    expect(getPrompt("senpai_board", "ja").body).toContain(formatProblemText(null, "ja"));
    expect(getPrompt("senpai_board", "en").body).toContain(formatProblemText(null, "en"));
  });

  it("英語のセッションには英語のプレースホルダを渡す", async () => {
    services = {
      ...testServices(),
      analyzer: new RecordingAnalyzer({ ...analysisFixtureEn, problem_text: "" }, {}),
    };
    const response = await post(createSessionForm({ locale: "en" }));
    const body = (await response.json()) as CreateSessionResponse;

    expect((await metadataOf(body)).problem_text).toBe("(no photo of the problem)");
  });

  /**
   * 上限を超えるのは「紙面を丸ごと書き起こした」とき。先頭で切ると設問の途中で
   * 切れた問題を教えることになり、章末の解答まで混ざっている可能性も高い。
   */
  it("紙面を丸ごと書き起こした問題文は、切らずに捨てる", async () => {
    services = testServices({
      analysis: { ...analysisFixture, problem_text: "あ".repeat(problemTextMaxLength + 1) },
    });
    const body = await start();

    expect(body.problem).toBeNull();
    expect((await metadataOf(body)).problem_text).toBe("(問題の写真なし)");
  });

  /**
   * `@ai-sensei/guardrail` の `checkProblemText()` が**ルートから届く位置に繋がっている**
   * ことの確認。解答が混ざったまま渡すと、先輩は解き方を組み立てずに答えを写し、
   * 板書が「答え合わせの表示器」に劣化する。
   *
   * 落としてもセッションは止めない。先輩は「問題、読んでもらってもいい?」から始まる。
   */
  it("解答が混ざった問題文は先輩に渡さない(セッションは止めない)", async () => {
    services = testServices({
      analysis: {
        ...analysisFixture,
        problem_text: "x^2 - 3x + 2 = 0 を解け。 【解答】x = 1, 2",
      },
    });
    const body = await start();

    expect(body.problem).toBeNull();
    expect((await metadataOf(body)).problem_text).toBe(formatProblemText(null, "ja"));
  });

  // 単元を絞り込むだけで問題文が消えると、先輩が問題を見ないまま教える状態に戻る。
  it("単元を絞り込んでも問題文は残る", async () => {
    const session = await start({ problemPhoto: problemPhotoFile() });

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    const body = (await response.json()) as CreateSessionResponse;

    expect(body.problem).toEqual(session.problem);
    expect((await metadataOf(body)).problem_text).toBe(analysisFixture.problem_text);
  });

  it("エージェントに渡す文脈は contract のスキーマを満たす", async () => {
    const claims = await verifyJwt((await start()).livekit.token, bindings.LIVEKIT_API_SECRET);
    const parsed = sessionMetadataSchema.safeParse(JSON.parse(String(claims?.["metadata"])));
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });
});

/**
 * **ノートを持っていない生徒の経路。**
 *
 * ノートを必須にしていた頃、この生徒には紙面を `photo`(ノート枠)に入れる以外の
 * 道が無く、結果として**他者の著作物がR2に保存されていた**。
 * 破棄の約束を守る唯一の道が「紙面をノート枠に入れる動機を消す」ことだったので、
 * ノートの必須をやめた(§4-1 / §10-4)。
 */
describe("問題だけのセッション", () => {
  function problemOnlyForm(meta: Record<string, unknown> = {}): FormData {
    const form = new FormData();
    form.set(sessionPhotoParts.problem, problemPhotoFile());
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja", ...meta }));
    return form;
  }

  async function metadataOf(body: CreateSessionResponse) {
    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    return JSON.parse(String(claims?.["metadata"])) as {
      problem_text: string;
      visible_work: string;
    };
  }

  it("ノートが無くてもセッションが始まる", async () => {
    const response = await post(problemOnlyForm());
    expect(response.status).toBe(201);

    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.problem?.source).toBe("problem_photo");
  });

  // 破棄の約束そのもの。ノートが無いのだから、R2には**何も**増えない。
  it("紙面はR2に保存されない(バケツが空のまま)", async () => {
    // モジュール共有の bindings は他のテストが保存した写真を持っている
    // (session_id も ses_1 から振り直される)ので、ここだけ空のバケツで見る。
    const isolated = testBindings();
    const response = await app.request(
      "/v1/sessions",
      { method: "POST", body: problemOnlyForm(), headers: { "x-device-id": testDeviceId } },
      isolated,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateSessionResponse;

    const objects = (isolated.PHOTOS as unknown as { objects: Map<string, unknown> }).objects;
    expect([...objects.keys()]).toEqual([]);

    const session = await services.repository.getSession(body.session_id);
    expect(session?.photo_key).toBeNull();
  });

  it("解析器にはノート無しで渡す(紙面をノートとして解析させない)", async () => {
    await post(problemOnlyForm());
    expect((services.analyzer as RecordingAnalyzer).calls).toEqual([
      { locale: "ja", hadNotes: false, hadProblem: true },
    ]);
  });

  /**
   * 「ノートを撮ったが白紙」と「ノートを撮っていない」は別物。
   * 混ぜると先輩は、まだ手をつけていない生徒から「手が止まった場所」を探しはじめる。
   */
  it("student_work は「(なし)」ではなく「ノートの写真なし」になる", async () => {
    services = testServices({ analysis: { ...analysisFixture, visible_work: [] } });

    const response = await post(problemOnlyForm());
    const metadata = await metadataOf((await response.json()) as CreateSessionResponse);
    expect(metadata.visible_work).toBe("(ノートの写真なし)");
    expect(metadata.visible_work).not.toBe("(なし)");
  });

  it("英語のセッションには英語の文言を渡す", async () => {
    services = {
      ...testServices(),
      analyzer: new RecordingAnalyzer({ ...analysisFixtureEn, visible_work: [] }, {}),
    };
    const response = await post(problemOnlyForm({ locale: "en" }));
    const metadata = await metadataOf((await response.json()) as CreateSessionResponse);

    // 文言の正本は `@ai-sensei/prompts` の formatVisibleWork(プロンプトが名指ししている)。
    // API側で組み立て直していないことを、正本と突き合わせて固定する。
    expect(metadata.visible_work).toBe(formatVisibleWork(null, "en"));
    expect(metadata.visible_work).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  // 単元を絞り込んだだけで「ノートがある」ことにならない(写真は解析し直さない)。
  it("単元を絞り込んでも、ノート無しの文言のまま", async () => {
    services = testServices({ analysis: { ...analysisFixture, visible_work: [] } });
    const created = await post(problemOnlyForm());
    const session = (await created.json()) as CreateSessionResponse;

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    const metadata = await metadataOf((await response.json()) as CreateSessionResponse);
    expect(metadata.visible_work).toBe("(ノートの写真なし)");
  });

  /**
   * `problem_text` のプレースホルダと同じ手当て。プロンプト側には
   * 「ここが『(ノートの写真なし)』のときは手がかりが無い」という分岐があるので、
   * **1文字ずれるとその分岐が発火せず、先輩がノートを持っていない生徒に
   * 「ノート見せて」と言い出す。**
   */
  it("ノート無しの文言が、先輩のプロンプトが見ている文言と一致する", () => {
    for (const id of ["senpai_board", "senpai_conversation"] as const) {
      expect(getPrompt(id, "ja").body, id).toContain(formatVisibleWork(null, "ja"));
      expect(getPrompt(id, "en").body, id).toContain(formatVisibleWork(null, "en"));
    }
  });

  it("ノートがあるときは、従来どおり読み取った内容を渡す", async () => {
    const response = await post(createSessionForm());
    const metadata = await metadataOf((await response.json()) as CreateSessionResponse);
    expect(metadata.visible_work).toContain(analysisFixture.visible_work[0]);
  });

  // ここを緩めると「写真ゼロで始まるセッション」ができ、解析器が想像で単元を答える。
  it("どちらの写真も無ければ、従来どおり弾く", async () => {
    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));

    const response = await post(form);
    expect(response.status).toBe(422);
    expect(services.repository.sessions.size).toBe(0);
  });

  it("紙面が壊れていて、ノートも無ければ弾く(読めた写真がゼロ)", async () => {
    const form = new FormData();
    form.set(
      sessionPhotoParts.problem,
      new File([new Uint8Array([0, 1, 2, 3])], "p", { type: "image/heic" }),
    );
    form.set("meta", JSON.stringify({ kind: "new", locale: "ja" }));

    expect((await post(form)).status).toBe(422);
    // 読めない写真で今日の1回を失わせない(従来の約束)
    expect((await post(createSessionForm())).status).toBe(201);
  });

  /**
   * 復習は写真を使わず、文脈は前回の穴。ここに「ノートの写真なし」と書くと
   * **存在しない欠落**を報告することになる。
   */
  it("復習セッションの student_work は変わらない", async () => {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: null,
    });
    await services.repository.insertKarte(
      {
        id: "kar_seed",
        session_id: "ses_seed",
        device_id: testDeviceId,
        created_at: "2026-08-01T11:00:00.000Z",
        topic_ids: ["M1-NIJI-GURAFU"],
        said_well: [],
        term_notes: [],
        followup_question: null,
      },
      [
        {
          id: "hol_seed",
          device_id: testDeviceId,
          karte_id: "kar_seed",
          topic_id: "M1-NIJI-GURAFU",
          desc: "平方完成のなぜで説明が止まった",
          severity: "high",
          evidence: null,
          status: "open",
          created_at: "2026-08-01T11:00:00.000Z",
          filled_at: null,
        },
      ],
    );

    const form = new FormData();
    form.set("meta", JSON.stringify({ kind: "review", locale: "ja", hole_id: "hol_seed" }));

    const response = await post(form);
    expect(response.status).toBe(201);
    const metadata = await metadataOf((await response.json()) as CreateSessionResponse);
    expect(metadata.visible_work).toBe("(なし)");
  });
});

describe("検出単元の確信度", () => {
  it("解析器が返した確信度をそのまま渡す", async () => {
    const response = await post(createSessionForm());
    const body = (await response.json()) as CreateSessionResponse;

    const primary = body.detected_topics.find((t) => t.topic_id === "M2-ZUKEI-ENCHOKU");
    expect(primary?.confidence).toBe(0.92);
  });
});

// レビュー指摘: 無料枠の判定と行の作成が離れていると、同時投稿で二重に通る
describe("無料枠の押さえ方", () => {
  it("解析に失敗したら、その日の1回を消費しない", async () => {
    services = testServices({
      analysis: {
        is_math_note: false,
        summary: "英語の単語帳",
        problem_text: "",
        visible_work: [],
        topics: [],
        unreadable: [],
        question_seeds: [],
      },
    });
    expect((await post(createSessionForm())).status).toBe(422);
    expect(services.repository.sessions.size).toBe(0);

    // 撮り直せば、その日のうちにまだ始められる
    services.analyzer = testServices().analyzer;
    expect((await post(createSessionForm())).status).toBe(201);
  });

  it("解析の前に行を作って枠を押さえる", async () => {
    let sessionsDuringAnalysis = -1;
    services.analyzer = {
      async analyze() {
        sessionsDuringAnalysis = services.repository.sessions.size;
        return analysisFixture;
      },
    };

    await post(createSessionForm());
    // 解析中にはもう行がある = 同時に来た2本目は無料枠に弾かれる
    expect(sessionsDuringAnalysis).toBe(1);
  });
});

describe("同時実行の授業枠", () => {
  it("無料は同時に3本投げても1本しか通らない", async () => {
    const wait = concurrencyBarrier(3);
    const repository = services.repository;
    const original = repository.ensureUser.bind(repository);
    repository.ensureUser = async (deviceId: string, now: Date) => {
      const user = await original(deviceId, now);
      await wait();
      return user;
    };

    const responses = await Promise.all(Array.from({ length: 3 }, () => post(createSessionForm())));
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
      201, 402, 402,
    ]);

    const rejected = responses.filter((response) => response.status === 402);
    const errors = await Promise.all(
      rejected.map((response) => response.json() as Promise<{ error: { code: string } }>),
    );
    expect(errors.map((body) => body.error.code)).toEqual([
      "free_limit_reached",
      "free_limit_reached",
    ]);
    expect(repository.sessions.size).toBe(1);
  });

  it("Premiumは同時に5本投げても3本しか通らない", async () => {
    const repository = services.repository;
    await repository.ensureUser(testDeviceId, new Date());
    await repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: "rc_1",
    });

    const wait = concurrencyBarrier(5);
    const original = repository.ensureUser.bind(repository);
    repository.ensureUser = async (deviceId: string, now: Date) => {
      const user = await original(deviceId, now);
      await wait();
      return user;
    };

    const responses = await Promise.all(Array.from({ length: 5 }, () => post(createSessionForm())));
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
      201, 201, 201, 429, 429,
    ]);

    const rejected = responses.filter((response) => response.status === 429);
    const errors = await Promise.all(
      rejected.map((response) => response.json() as Promise<{ error: { code: string } }>),
    );
    expect(errors.map((body) => body.error.code)).toEqual([
      "fair_use_limit_reached",
      "fair_use_limit_reached",
    ]);
    expect(repository.sessions.size).toBe(3);
  });
});

/**
 * 不具合報告: 写真 → 分野選択 → 会話開始 で「今日のセッションは終わり」と出た。
 * 単元を確認しただけでセッションを作り直していたため、無料枠を2回消費していた。
 */
describe("PATCH /v1/sessions/{id}/topics", () => {
  async function startSession(): Promise<CreateSessionResponse> {
    const response = await post(createSessionForm());
    expect(response.status).toBe(201);
    return (await response.json()) as CreateSessionResponse;
  }

  it("単元を絞っても、今日の無料枠を二重に消費しない", async () => {
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      locale: "ja",
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    // 同じセッションのまま。行が増えていなければ枠も増えない
    expect(body.session_id).toBe(session.session_id);
    expect(services.repository.sessions.size).toBe(1);
    expect(body.limits.lesson_allowed_today).toBe(false);
  });

  it("外した単元は許可リストから消え、トークンも出し直す", async () => {
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M1-NIJI-HANBETSU"],
    });
    const body = (await response.json()) as CreateSessionResponse;

    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["M1-NIJI-HANBETSU"]);
    expect(body.livekit.token).not.toBe(session.livekit.token);

    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    const metadata = JSON.parse(String(claims?.["metadata"])) as {
      allowed_topic_ids: string[];
      photo_summary: string;
    };
    expect(metadata.allowed_topic_ids).not.toContain("M2-ZUKEI-ENCHOKU");
    // 写真をもう一度解析しなくても、会話の文脈は残っている
    expect(metadata.photo_summary).toBe(analysisFixture.summary);
  });

  it("解析時の確信度をそのまま返す(チップの見た目が変わらない)", async () => {
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics[0]?.confidence).toBe(0.92);
  });

  it("検出していない単元には差し替えられない", async () => {
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M1-NIJI-GURAFU"],
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "photo_unreadable",
    );
  });

  it("他人のセッションは触れない", async () => {
    const session = await startSession();

    const response = await patchTopics(
      session.session_id,
      { topic_ids: ["M2-ZUKEI-ENCHOKU"] },
      { "x-device-id": "99999999-8888-7777-6666-555555555555" },
    );
    expect(response.status).toBe(404);
  });

  it("終わったセッションは触れない", async () => {
    const session = await startSession();
    await services.repository.completeSession({
      sessionId: session.session_id,
      completedAt: new Date().toISOString(),
      durationSeconds: 300,
    });

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    expect(response.status).toBe(404);
  });

  it("Premiumも会話時間の上限は20分のまま", async () => {
    await services.repository.ensureUser(testDeviceId, new Date());
    await services.repository.setPremium({
      deviceId: testDeviceId,
      isPremium: true,
      expiresAt: null,
      rcAppUserId: "rc_1",
    });
    const session = await startSession();

    const response = await patchTopics(session.session_id, {
      topic_ids: ["M2-ZUKEI-ENCHOKU"],
    });
    const body = (await response.json()) as CreateSessionResponse;
    expect(body.limits.max_seconds).toBe(1200);
    expect(body.limits.lesson_allowed_today).toBe(true);
  });
});

/**
 * 海外向けの課程で始めるセッション。
 *
 * 見ているのは「英語で返るか」ではなく、**会話に渡す文脈が最後まで
 * 英語の課程で揃っているか**。ここが混ざると、後輩が英語で話しながら
 * 日本語の単元名でガードレールを引くことになる。
 */
describe("locale=en のセッション", () => {
  let analyzer: RecordingAnalyzer;

  beforeEach(() => {
    analyzer = new RecordingAnalyzer();
    services = { ...testServices(), analyzer };
  });

  it("英語の課程で解析し、英語の科目名をチップに返す", async () => {
    const response = await post(createSessionForm({ locale: "en" }));
    expect(response.status).toBe(201);

    expect(analyzer.calls).toEqual([{ locale: "en", hadNotes: true, hadProblem: false }]);

    const body = (await response.json()) as CreateSessionResponse;
    expect(createSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(body.detected_topics.map((topic) => topic.topic_id)).toContain("A2-COORD-CIRCLE");
    expect(body.detected_topics.map((topic) => topic.course)).toContain("Algebra 2");
  });

  it("エージェントに渡す文脈も英語で揃える", async () => {
    const response = await post(createSessionForm({ locale: "en" }));
    const body = (await response.json()) as CreateSessionResponse;

    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    const metadata = JSON.parse(String(claims?.["metadata"])) as {
      locale: string;
      allowed_topics: string;
      allowed_topic_ids: string[];
      question_seeds: string;
    };

    expect(metadata.locale).toBe("en");
    expect(metadata.allowed_topics).toContain("Algebra 2 / Coordinate Geometry");
    expect(metadata.allowed_topics).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    for (const id of metadata.allowed_topic_ids) {
      expect(localeOfTopicId(id), id).toBe("en");
    }
  });

  it("エラー文言も英語で返す", async () => {
    await post(createSessionForm({ locale: "en" }));
    const response = await post(createSessionForm({ locale: "en" }));

    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("free_limit_reached");
    expect(body.error.message).not.toMatch(/[ぁ-んァ-ン一-龯]/);
  });

  it("単元を絞り込んでも英語の課程のまま", async () => {
    const created = await post(createSessionForm({ locale: "en" }));
    const session = (await created.json()) as CreateSessionResponse;

    const response = await patchTopics(session.session_id, {
      locale: "en",
      topic_ids: ["A2-COORD-CIRCLE"],
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as CreateSessionResponse;
    expect(body.detected_topics.map((topic) => topic.topic_id)).toEqual(["A2-COORD-CIRCLE"]);

    const claims = await verifyJwt(body.livekit.token, bindings.LIVEKIT_API_SECRET);
    const metadata = JSON.parse(String(claims?.["metadata"])) as { locale: string };
    expect(metadata.locale).toBe("en");
  });
});
