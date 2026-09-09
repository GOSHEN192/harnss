import { describe, expect, it } from "vitest";
import {
  isValidTelegramBotToken,
  splitTelegramMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "./utils";

describe("Telegram utilities", () => {
  it("validates bot token shape without accepting whitespace", () => {
    expect(isValidTelegramBotToken("123456:abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(isValidTelegramBotToken("not-a-token")).toBe(false);
    expect(isValidTelegramBotToken("123456:abc def")).toBe(false);
  });

  it("splits long messages at a newline when possible", () => {
    const text = `${"a".repeat(3000)}\n${"b".repeat(2000)}`;
    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= TELEGRAM_MAX_MESSAGE_LENGTH)).toBe(true);
    expect(chunks.join("\n")).toBe(text);
  });
});
