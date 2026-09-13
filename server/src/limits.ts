/**
 * Limits for a publicly reachable demo.
 *
 * The service is deliberately open — people have to be able to try it — so the
 * job here is not to stop abuse but to cap what abuse can cost. Two things are
 * actually spendable: the treasury's devnet SOL, and CPU.
 */

/**
 * Every new cardholder is funded with real (devnet) SOL from the treasury, so
 * an open endpoint that creates them is a drain. At 0.02 SOL plus rent each,
 * an unbounded endpoint empties the wallet in a few hundred calls and the demo
 * simply stops working.
 */
export const MAX_DEMO_USERS = Number(process.env.MAX_DEMO_USERS ?? 40);

/**
 * The resolver runs Levenshtein against every brand pattern, so cost grows
 * with the length of the descriptor. Real card descriptors are short; anything
 * long is either a mistake or an attempt to burn CPU.
 */
export const MAX_DESCRIPTOR_LEN = 200;

/** Nothing sane exceeds this, and it keeps the µUSD conversion inside i64. */
export const MAX_AMOUNT_USD = 1_000_000;

export class BadInput extends Error {}

export function requireDescriptor(value: unknown, field = "merchantName"): string {
  const s = String(value ?? "");
  if (!s) throw new BadInput(`${field} is required`);
  if (s.length > MAX_DESCRIPTOR_LEN) {
    throw new BadInput(`${field} exceeds ${MAX_DESCRIPTOR_LEN} characters`);
  }
  return s;
}

export function requireAmountUsd(value: unknown, field = "amountUsd"): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT_USD) {
    throw new BadInput(`${field} must be a number in (0, ${MAX_AMOUNT_USD}]`);
  }
  return n;
}

export function requireId(value: unknown, field: string, max = 64): string {
  const s = String(value ?? "");
  if (!s || s.length > max) throw new BadInput(`${field} is required (max ${max} chars)`);
  return s;
}
