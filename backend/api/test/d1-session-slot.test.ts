import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/cloudflare.ts";
import { D1Repository } from "../src/repository/d1.ts";
import type { SessionRecord } from "../src/repository/types.ts";

let sqliteModule: typeof import("node:sqlite") | null = null;
/**
 * CIはNode 22で、node:sqliteは22系では実験的なため、フラグなしでは読み込めない場合がある。
 * SQLの検証を持たない状態へ戻さず、使える環境では実行し、使えない環境だけスイートを飛ばす。
 */
try {
  sqliteModule = await import("node:sqlite");
} catch {
  try {
    // Vite 5がnode:sqliteをsqliteへ書き換える環境では、Node自身のrequireへ戻す。
    sqliteModule = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  } catch {
    sqliteModule = null;
  }
}

const describeWithSqlite = sqliteModule ? describe : describe.skip;
const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

type Migration = { name: string; sql: string };

async function migrations(): Promise<Migration[]> {
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(join(migrationDirectory, name), "utf8"),
    })),
  );
}

function openDatabase(): DatabaseSync {
  if (!sqliteModule) throw new Error("node:sqliteを読み込めません");
  return new sqliteModule.DatabaseSync(":memory:");
}

function apply(database: DatabaseSync, entries: readonly Migration[]): void {
  for (const migration of entries) database.exec(migration.sql);
}

function d1Result<T>(results: T[], changes: number): D1Result<T> {
  return { results, success: true, meta: { changes } };
}

function sqliteValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error(`SQLiteへbindできない値です: ${typeof value}`);
}

class SQLitePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SQLitePreparedStatement(this.database, this.query, values.map(sqliteValue));
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values);
    return row ? ({ ...row } as T) : null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.database
      .prepare(this.query)
      .all(...this.values)
      .map((row) => ({ ...row }) as T);
    return d1Result(rows, 0);
  }

  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.query).run(...this.values);
    return d1Result([], Number(result.changes));
  }

  execute<T>(): D1Result<T> {
    if (/^(SELECT|PRAGMA|WITH)\b/i.test(this.query.trimStart())) {
      const rows = this.database
        .prepare(this.query)
        .all(...this.values)
        .map((row) => ({ ...row }) as T);
      return d1Result(rows, 0);
    }
    const result = this.database.prepare(this.query).run(...this.values);
    return d1Result([], Number(result.changes));
  }
}

/** D1Repositoryが使うAPIだけをnode:sqliteへ写す薄いアダプタ。 */
class SQLiteD1Database implements D1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SQLitePreparedStatement(this.database, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SQLitePreparedStatement)) {
          throw new Error("SQLiteアダプタ以外の文はbatchできません");
        }
        return statement.execute<T>();
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    device_id: "device_a",
    kind: "new",
    status: "open",
    created_at: "2026-08-03T13:24:07.000Z",
    completed_at: null,
    local_date: "2026-08-03",
    photo_key: null,
    topic_ids: [],
    hole_id: null,
    duration_seconds: null,
    context: null,
    ...overrides,
  };
}

describeWithSqlite("D1の授業枠", () => {
  it("マイグレーションをファイル名順に最後まで適用できる", async () => {
    const database = openDatabase();
    try {
      const entries = await migrations();
      apply(database, entries);

      expect(entries.map((entry) => entry.name)).toContain("0003_session_day_seq.sql");
      expect(entries.map((entry) => entry.name)).toContain("0004_drop_session_day_seq_index.sql");
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("ux_sessions_device_date_seq"),
      ).toBeUndefined();
      expect(
        database
          .prepare("PRAGMA table_info(sessions)")
          .all()
          .some((column) => column["name"] === "day_seq"),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("既存行の値を変えず、作成日時とIDの全順序で日ごとに採番する", async () => {
    const database = openDatabase();
    try {
      const entries = await migrations();
      apply(database, entries.slice(0, 2));
      database.exec(`
        INSERT INTO users (device_id, created_at) VALUES
          ('device_a', '2026-08-01T00:00:00.000Z'),
          ('device_b', '2026-08-01T00:00:00.000Z');

        INSERT INTO sessions
          (id, device_id, kind, status, created_at, completed_at, local_date,
           photo_key, topic_ids, hole_id, duration_seconds, context)
        VALUES
          ('session_b', 'device_a', 'new', 'open',
           '2026-08-03T13:00:00.000Z', NULL, '2026-08-03',
           'photos/b', '["M2-ZUKEI-ENCHOKU"]', NULL, NULL, '{"summary":"b"}'),
          ('session_a', 'device_a', 'review', 'completed',
           '2026-08-03T13:00:00.000Z', '2026-08-03T13:20:00.000Z', '2026-08-03',
           NULL, '["M1-NIJI-HANBETSU"]', 'hole_a', 1200, '{"summary":"a"}'),
          ('session_c', 'device_a', 'new', 'open',
           '2026-08-03T12:00:00.000Z', NULL, '2026-08-03',
           NULL, '[]', NULL, NULL, NULL),
          ('session_next_day', 'device_a', 'new', 'open',
           '2026-08-04T12:00:00.000Z', NULL, '2026-08-04',
           NULL, '[]', NULL, NULL, NULL),
          ('session_other_device', 'device_b', 'new', 'open',
           '2026-08-03T12:00:00.000Z', NULL, '2026-08-03',
           NULL, '[]', NULL, NULL, NULL);
      `);

      const originalColumns = `id, device_id, kind, status, created_at, completed_at, local_date,
        photo_key, topic_ids, hole_id, duration_seconds, context`;
      const before = database
        .prepare(`SELECT ${originalColumns} FROM sessions ORDER BY id`)
        .all()
        .map((row) => ({ ...row }));

      const third = entries.find((entry) => entry.name === "0003_session_day_seq.sql");
      if (!third) throw new Error("0003マイグレーションがありません");
      apply(database, [third]);

      const after = database
        .prepare(`SELECT ${originalColumns} FROM sessions ORDER BY id`)
        .all()
        .map((row) => ({ ...row }));
      expect(after).toEqual(before);
      expect(
        database
          .prepare(
            `SELECT device_id, local_date, id, day_seq FROM sessions
              ORDER BY device_id, local_date, day_seq`,
          )
          .all()
          .map((row) => ({ ...row })),
      ).toEqual([
        { device_id: "device_a", local_date: "2026-08-03", id: "session_c", day_seq: 0 },
        { device_id: "device_a", local_date: "2026-08-03", id: "session_a", day_seq: 1 },
        { device_id: "device_a", local_date: "2026-08-03", id: "session_b", day_seq: 2 },
        {
          device_id: "device_a",
          local_date: "2026-08-04",
          id: "session_next_day",
          day_seq: 0,
        },
        {
          device_id: "device_b",
          local_date: "2026-08-03",
          id: "session_other_device",
          day_seq: 0,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("上限を超えて挿入せず、確保した分を含む本数を返す", async () => {
    const database = openDatabase();
    try {
      apply(database, await migrations());
      const repository = new D1Repository(new SQLiteD1Database(database));
      await repository.ensureUser("device_a", new Date("2026-08-03T13:00:00.000Z"));

      const reservations = [];
      for (let index = 0; index < 4; index += 1) {
        reservations.push(
          await repository.reserveSessionSlot({
            session: session(`session_${index}`),
            maxPerDay: 3,
          }),
        );
      }

      expect(reservations).toEqual([
        { reserved: true, sessionsToday: 1 },
        { reserved: true, sessionsToday: 2 },
        { reserved: true, sessionsToday: 3 },
        { reserved: false },
      ]);
      expect(await repository.countSessionsOnDate("device_a", "2026-08-03")).toBe(3);
    } finally {
      database.close();
    }
  });

  it("旧Workerが既定値0を重ねたあとも0004と新Workerが動く", async () => {
    const database = openDatabase();
    try {
      const entries = await migrations();
      const fourthIndex = entries.findIndex(
        (entry) => entry.name === "0004_drop_session_day_seq_index.sql",
      );
      if (fourthIndex < 0) throw new Error("0004マイグレーションがありません");
      apply(database, entries.slice(0, fourthIndex));
      database.exec(`
        INSERT INTO users (device_id, created_at)
        VALUES ('device_a', '2026-08-03T13:00:00.000Z');

        -- デプロイの窓で動く旧Workerと同じく、day_seqを列挙しない。
        INSERT INTO sessions
          (id, device_id, kind, status, created_at, completed_at, local_date,
           photo_key, topic_ids, hole_id, duration_seconds, context)
        VALUES
          ('old_worker_1', 'device_a', 'new', 'open',
           '2026-08-03T13:00:01.000Z', NULL, '2026-08-03',
           NULL, '[]', NULL, NULL, NULL),
          ('old_worker_2', 'device_a', 'new', 'open',
           '2026-08-03T13:00:02.000Z', NULL, '2026-08-03',
           NULL, '[]', NULL, NULL, NULL);
      `);
      expect(
        database
          .prepare("SELECT day_seq FROM sessions ORDER BY id")
          .all()
          .map((row) => row["day_seq"]),
      ).toEqual([0, 0]);

      apply(database, entries.slice(fourthIndex));
      const repository = new D1Repository(new SQLiteD1Database(database));
      expect(
        await repository.reserveSessionSlot({ session: session("new_worker"), maxPerDay: 3 }),
      ).toEqual({ reserved: true, sessionsToday: 3 });
      expect(
        await repository.reserveSessionSlot({ session: session("over_limit"), maxPerDay: 3 }),
      ).toEqual({ reserved: false });
      expect(await repository.countSessionsOnDate("device_a", "2026-08-03")).toBe(3);
    } finally {
      database.close();
    }
  });

  it("旧版0003を適用済みでも0004がINDEXだけを外して既存行を保つ", async () => {
    const database = openDatabase();
    try {
      const entries = await migrations();
      const fourthIndex = entries.findIndex(
        (entry) => entry.name === "0004_drop_session_day_seq_index.sql",
      );
      if (fourthIndex < 0) throw new Error("0004マイグレーションがありません");
      apply(database, entries.slice(0, fourthIndex));
      database.exec(`
        INSERT INTO users (device_id, created_at)
        VALUES ('device_a', '2026-08-03T13:00:00.000Z');
        INSERT INTO sessions
          (id, device_id, kind, status, created_at, completed_at, local_date,
           photo_key, topic_ids, hole_id, duration_seconds, context, day_seq)
        VALUES
          ('existing_1', 'device_a', 'new', 'open',
           '2026-08-03T13:00:01.000Z', NULL, '2026-08-03',
           NULL, '[]', NULL, NULL, NULL, 0),
          ('existing_2', 'device_a', 'new', 'open',
           '2026-08-03T13:00:02.000Z', NULL, '2026-08-03',
           NULL, '[]', NULL, NULL, NULL, 1);
        CREATE UNIQUE INDEX ux_sessions_device_date_seq
          ON sessions (device_id, local_date, day_seq);
      `);
      const before = database.prepare("SELECT * FROM sessions ORDER BY id").all();

      apply(database, entries.slice(fourthIndex));

      expect(database.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(before);
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("ux_sessions_device_date_seq"),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("途中の枠を返したあとも同じ日にもう一度押さえられる", async () => {
    const database = openDatabase();
    try {
      apply(database, await migrations());
      const repository = new D1Repository(new SQLiteD1Database(database));
      await repository.ensureUser("device_a", new Date("2026-08-03T13:00:00.000Z"));
      for (let index = 0; index < 3; index += 1) {
        await repository.reserveSessionSlot({
          session: session(`session_${index}`),
          maxPerDay: 3,
        });
      }

      await repository.deleteSession("session_1");

      expect(
        await repository.reserveSessionSlot({ session: session("session_retry"), maxPerDay: 3 }),
      ).toEqual({ reserved: true, sessionsToday: 3 });
      expect(
        database
          .prepare("SELECT day_seq FROM sessions ORDER BY day_seq")
          .all()
          .map((row) => row["day_seq"]),
      ).toEqual([0, 0, 0]);
    } finally {
      database.close();
    }
  });
});
