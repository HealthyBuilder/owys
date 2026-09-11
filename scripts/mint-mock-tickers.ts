/**
 * Create the mock tokenized-equity mints on devnet and stock the treasury.
 *
 * Real xStocks / Ondo GM tokens exist only on mainnet, so an all-mock PoC has
 * to mint its own. One transaction per ticker: create the mint account,
 * initialize it, create the treasury ATA, mint the inventory.
 *
 * The script is resumable — it appends to .mock-tickers.json after every
 * success and skips whatever is already there. Public devnet RPC will rate-limit
 * and drop blockhashes partway through a 28-transaction run; re-running picks up
 * where it stopped instead of wasting rent on orphaned mints.
 */

import fs from "node:fs";
import {
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { connection, wallet, treasury, CLUSTER, explorer } from "../server/src/chain.ts";
import { TOKENIZED_UNIVERSE, TICKER_FILE, type MintRecord } from "../server/src/tickers.ts";

/** Whole tokens minted to the treasury per ticker. */
const SUPPLY = 5_000_000;
/**
 * Public devnet RPC rate-limits aggressively. Point RPC_URL at a paid endpoint
 * (Helius / Triton / QuickNode) and this finishes in seconds.
 */
const DELAY_MS = Number(process.env.MINT_DELAY_MS ?? 800);
const MAX_RETRIES = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RETRYABLE = /429|Too Many Requests|Blockhash not found|block height exceeded|Unable to obtain a new blockhash|timed out|fetch failed|socket hang up/i;

interface TickerFile {
  cluster: string;
  treasury: string;
  mints: MintRecord[];
}

function readState(): TickerFile {
  if (fs.existsSync(TICKER_FILE)) {
    return JSON.parse(fs.readFileSync(TICKER_FILE, "utf8")) as TickerFile;
  }
  return { cluster: CLUSTER, treasury: treasury.publicKey.toBase58(), mints: [] };
}

function writeState(state: TickerFile): void {
  fs.writeFileSync(`${TICKER_FILE}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${TICKER_FILE}.tmp`, TICKER_FILE);
}

async function createTicker(
  def: (typeof TOKENIZED_UNIVERSE)[number],
  rentLamports: number,
): Promise<MintRecord> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // A fresh mint keypair and a fresh blockhash per attempt: a failed attempt
    // may or may not have landed, and reusing the keypair would collide.
    const mintKp = Keypair.generate();
    const ata = getAssociatedTokenAddressSync(mintKp.publicKey, treasury.publicKey);

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MINT_SIZE,
        lamports: rentLamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mintKp.publicKey,
        def.decimals,
        wallet.publicKey, // mint authority
        null,             // no freeze authority; real tokenized equity usually has one
        TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        ata,
        treasury.publicKey,
        mintKp.publicKey,
        TOKEN_PROGRAM_ID,
      ),
      createMintToInstruction(
        mintKp.publicKey,
        ata,
        wallet.publicKey,
        BigInt(SUPPLY) * BigInt(10 ** def.decimals),
        [],
        TOKEN_PROGRAM_ID,
      ),
    );

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [wallet, mintKp], {
        commitment: "confirmed",
        maxRetries: 5,
      });
      console.log(
        `  ${def.symbol.padEnd(7)} ${mintKp.publicKey.toBase58().padEnd(44)} ${sig.slice(0, 8)}…`,
      );
      return {
        ticker: def.ticker,
        symbol: def.symbol,
        mint: mintKp.publicKey.toBase58(),
        decimals: def.decimals,
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (attempt === MAX_RETRIES || !RETRYABLE.test(msg)) throw err;
      const backoff = DELAY_MS * 2 ** attempt;
      console.log(`  ${def.symbol.padEnd(7)} retry ${attempt}/${MAX_RETRIES} in ${backoff}ms (${msg.split("\n")[0].slice(0, 60)})`);
      await sleep(backoff);
    }
  }
  throw new Error(`unreachable: ${def.symbol}`);
}

async function main() {
  const state = readState();
  const done = new Set(state.mints.map((m) => m.ticker));
  const todo = TOKENIZED_UNIVERSE.filter((d) => !done.has(d.ticker));

  console.log(`cluster   : ${CLUSTER}`);
  console.log(`rpc       : ${connection.rpcEndpoint}`);
  console.log(`payer     : ${wallet.publicKey.toBase58()}`);
  console.log(`treasury  : ${treasury.publicKey.toBase58()}`);
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`balance   : ${(balance / 1e9).toFixed(4)} SOL`);
  console.log(`already   : ${done.size}/${TOKENIZED_UNIVERSE.length} minted`);

  if (todo.length === 0) {
    console.log("\nnothing to do — all mints present.");
    return;
  }
  if (balance < 0.05e9) throw new Error("payer needs ~0.05+ SOL for mint + ATA rent");

  const rentLamports = await getMinimumBalanceForRentExemptMint(connection);
  console.log(`\ncreating ${todo.length} mock mints (${SUPPLY.toLocaleString()} supply each):`);

  for (const def of todo) {
    const rec = await createTicker(def, rentLamports);
    state.mints.push(rec);
    writeState(state); // resumable: persist immediately
    await sleep(DELAY_MS);
  }

  console.log(`\nwrote ${TICKER_FILE} (${state.mints.length} mints)`);
  console.log(`treasury: ${explorer("address", treasury.publicKey.toBase58())}`);
}

main()
  .then(() => process.exit(0)) // devnet websocket subscriptions keep the loop alive otherwise
  .catch((err) => {
    console.error(`\n${err?.message ?? err}`);
    console.error("\nre-run `pnpm mint-tickers` to resume from where it stopped.");
    process.exit(1);
  });
