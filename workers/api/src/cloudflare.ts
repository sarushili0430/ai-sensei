/**
 * Cloudflareバインディングの最小型定義。
 *
 * `@cloudflare/workers-types` をグローバルに入れると `@types/node` と
 * fetch/Request/Response の宣言が衝突し、モノレポ全体の型検査が壊れる。
 * ここで使う分だけを手で宣言して、単一のtsconfigで通るようにしている。
 */

export type D1Result<T = unknown> = {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
};

export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
};

export type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
};

export type R2Bucket = {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
};

export type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};
