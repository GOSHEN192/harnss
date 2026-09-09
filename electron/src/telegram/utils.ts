export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export function isValidTelegramBotToken(token: string): boolean {
  return token.length >= 20
    && token.length <= 300
    && /^\d+:[A-Za-z0-9_-]+$/.test(token);
}

export function splitTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (cut < 1000) cut = TELEGRAM_MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
