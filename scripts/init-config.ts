/** Initialize the program Config PDA (idempotent). */

import * as chain from "../server/src/chain.ts";

const REWARD_BPS = Number(process.env.REWARD_BPS ?? 300); // 3%

async function main() {
  console.log(`program  : ${chain.programId().toBase58()}`);
  console.log(`config   : ${chain.configPda().toBase58()}`);
  console.log(`authority: ${chain.authority.publicKey.toBase58()}`);

  const existing = await chain.fetchConfig();
  if (existing) {
    console.log(`\nalready initialized — reward_bps = ${existing.rewardBps} (${existing.rewardBps / 100}%)`);
    console.log(`  accruals recorded : ${existing.accrualCount.toString()}`);
    console.log(`  total spend       : $${(Number(existing.totalSpentUsd) / 1e6).toFixed(2)}`);
    return;
  }

  const sig = await chain.initializeConfig(REWARD_BPS);
  console.log(`\ninitialized at ${REWARD_BPS} bps (${REWARD_BPS / 100}% cashback)`);
  console.log(`  ${chain.explorer("tx", sig)}`);
}

main()
  .then(() => process.exit(0)) // devnet websocket subscriptions keep the loop alive otherwise
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
