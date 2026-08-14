import { afterEach, describe, expect, it } from "vitest";
import { newId } from "./ids.ts";

const originalGetRandomValues = crypto.getRandomValues;

function restoreCrypto(): void {
  Object.defineProperty(crypto, "getRandomValues", {
    configurable: true,
    writable: true,
    value: originalGetRandomValues,
  });
}

afterEach(restoreCrypto);

describe("newId", () => {
  it("接頭辞+時刻+乱数の形になる", () => {
    const id = newId("ses", new Date("2026-08-03T13:24:07.000Z"));
    expect(id).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{20}$/);
  });

  it("新しいほど文字列として大きい(時系列にソートできる)", () => {
    const older = newId("ses", new Date("2026-08-03T13:24:07.000Z"));
    const newer = newId("ses", new Date("2026-08-03T13:24:08.000Z"));
    expect(newer > older).toBe(true);
  });

  /**
   * workerd checks the receiver of built-in APIs, so calling `getRandomValues`
   * detached from `crypto` throws Illegal invocation. Node's crypto tolerates it,
   * so a plain test shows no difference. This reproduces workerd's strictness to
   * pin how the default calls it.
   */
  it("乱数は crypto をレシーバにしたまま引く(workerdのIllegal invocation対策)", () => {
    let receiver: unknown = null;
    Object.defineProperty(crypto, "getRandomValues", {
      configurable: true,
      writable: true,
      value: function (this: unknown, array: Uint8Array): Uint8Array {
        receiver = this;
        if (this !== crypto) {
          throw new TypeError("Illegal invocation: function called with incorrect `this`");
        }
        // Only the call style (the receiver) matters, so the values need not be real randomness
        return array.fill(1);
      },
    });

    expect(() => newId("ses")).not.toThrow();
    expect(receiver).toBe(crypto);
  });

  it("乱数は差し替えられる(テスト用)", () => {
    const id = newId("hol", new Date("2026-08-03T13:24:07.000Z"), (array) => array.fill(0));
    expect(id.endsWith("0000000000")).toBe(true);
  });
});
