// What a DeepSeek request costs, from its token counts and the time it was sent. Prices are DeepSeek's
// published list prices per million tokens (api-docs.deepseek.com, September 2026): the Chinese page
// lists yuan, the English page dollars, and neither is a conversion of the other. Peak hours cost
// double: Monday to Friday, 9:00–12:00 and 14:00–18:00 Beijing time. No DOM here.

const PRICES = {
  "deepseek-flash": {
    usd: { hit: 0.003, miss: 0.15, output: 0.6 },
    cny: { hit: 0.02, miss: 1, output: 4 }
  },
  "deepseek-v4-pro": {
    usd: { hit: 0.022, miss: 0.66, output: 1.98 },
    cny: { hit: 0.15, miss: 4.5, output: 13.5 }
  }
};
const PEAK_HOURS = [[9, 12], [14, 18]];
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

// Beijing has no daylight saving, so shifting by eight hours and reading the UTC fields gives its clock.
export function isPeakTime(time = Date.now()) {
  const beijing = new Date(new Date(time).getTime() + BEIJING_OFFSET_MS);
  const day = beijing.getUTCDay();
  const hour = beijing.getUTCHours();
  return day >= 1 && day <= 5 && PEAK_HOURS.some(([from, to]) => hour >= from && hour < to);
}

// `usage` is the API's usage object. Returns { usd, cny, peak }, or null for a model without prices.
// Cache hits are part of prompt_tokens, and thinking is part of completion_tokens (billed as output).
export function requestCost(model, usage, time = Date.now()) {
  const prices = PRICES[model];
  if (!prices || !usage) {
    return null;
  }
  const input = Number(usage.prompt_tokens) || 0;
  const hit = Math.min(input, Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0);
  const output = Number(usage.completion_tokens) || 0;
  const peak = isPeakTime(time);
  const price = rates => ((input - hit) * rates.miss + hit * rates.hit + output * rates.output) / 1_000_000 * (peak ? 2 : 1);
  return { usd: price(prices.usd), cny: price(prices.cny), peak };
}

// Small amounts keep enough digits to be more than zero: $0.0042, $0.031, $1.25.
export function formatCost(amount, currency) {
  const symbol = currency === "cny" ? "¥" : "$";
  if (!(amount > 0)) {
    return `${symbol}0`;
  }
  const digits = amount >= 1 ? 2 : amount >= 0.01 ? 3 : Math.min(6, 1 - Math.floor(Math.log10(amount)));
  return `${symbol}${amount.toFixed(digits)}`;
}
