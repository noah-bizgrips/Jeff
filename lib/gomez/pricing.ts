/**
 * Pure cost estimation for Ask Gomez. Prices are USD per million tokens
 * (Anthropic first-party API, Sept 2026). Cache reads are billed at 0.1x
 * input, cache writes at 1.25x input. Unknown models fall back to Opus rates
 * so estimates err on the high side.
 */
export interface UsageCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /opus-5/, input: 5, output: 25 },
  { match: /sonnet-5/, input: 2, output: 10 },
  { match: /haiku-4-5/, input: 1, output: 5 },
  { match: /opus-4/, input: 5, output: 25 },
  { match: /sonnet-4/, input: 3, output: 15 },
];

export function priceFor(model: string) {
  return PRICES.find((p) => p.match.test(model)) ?? { input: 5, output: 25 };
}

export function estimateCostUsd(model: string, u: UsageCounts): number {
  const p = priceFor(model);
  const perTok = 1 / 1_000_000;
  const usd =
    u.input_tokens * p.input * perTok +
    u.output_tokens * p.output * perTok +
    u.cache_read_tokens * p.input * 0.1 * perTok +
    u.cache_write_tokens * p.input * 1.25 * perTok;
  return Math.round(usd * 1e6) / 1e6;
}

export function dailyBudgetUsd(): number {
  const n = Number(process.env.JEFF_DAILY_BUDGET_USD ?? "2");
  return Number.isFinite(n) && n >= 0 ? n : 2;
}
