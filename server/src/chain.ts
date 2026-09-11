/**
 * Solana client: PDA derivation and the four program calls.
 *
 * Key layout for the PoC — all three roles are the local CLI wallet:
 *   authority = oracle_signer = treasury
 * In production these are three different keys in three different places: the
 * authority in a multisig, the oracle in the card-webhook service (it can only
 * create fake accruals, never move tokens), the treasury wherever the ticker
 * inventory actually lives.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
// @coral-xyz/anchor is CJS. A namespace import reaches its classes from ESM,
// but `anchor.BN` is undefined under a real ESM loader (it resolves only when
// the package is required from CJS) — so take BN from bn.js directly, which is
// the same constructor anchor re-exports.
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
const { AnchorProvider, Program, Wallet } = anchor;
type Idl = anchor.Idl;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  type Commitment,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IDL_PATH = path.join(ROOT, "target/idl/equity_back.json");

export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const CLUSTER = process.env.CLUSTER ?? "devnet";
const COMMITMENT: Commitment = "confirmed";

export const USD_UNIT = 1_000_000; // micro-dollars, matching USDC decimals

function readKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file.replace(/^~/, process.env.HOME!), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export const WALLET_PATH =
  process.env.WALLET ?? path.join(process.env.HOME!, "my-solana-keypair.json");

export const wallet = readKeypair(WALLET_PATH);
/** Same key wearing three hats in the PoC — see the module comment. */
export const authority = wallet;
export const oracleSigner = wallet;
export const treasury = wallet;

/**
 * Public devnet RPC answers 429 under even modest bursts, and a failed RPC
 * call in the middle of a settlement batch looks exactly like a bug. So every
 * request goes through a single-file queue with a minimum spacing and
 * exponential backoff on 429/5xx.
 *
 * Point RPC_URL at a paid endpoint and set RPC_MIN_INTERVAL_MS=0 to remove the
 * spacing entirely.
 */
const RPC_MIN_INTERVAL_MS = Number(process.env.RPC_MIN_INTERVAL_MS ?? 110);
const RPC_MAX_RETRIES = Number(process.env.RPC_MAX_RETRIES ?? 6);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let rpcQueue: Promise<unknown> = Promise.resolve();

const throttledFetch = ((input: any, init?: any) => {
  const run = async (): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(input, init);
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt >= RPC_MAX_RETRIES) return res;
      await sleep(Math.min(4_000, 250 * 2 ** attempt) + Math.random() * 120);
    }
  };
  const scheduled = rpcQueue
    .then(() => (RPC_MIN_INTERVAL_MS > 0 ? sleep(RPC_MIN_INTERVAL_MS) : undefined))
    .then(run);
  rpcQueue = scheduled.catch(() => undefined);
  return scheduled;
}) as typeof fetch;

export const connection = new Connection(RPC_URL, {
  commitment: COMMITMENT,
  fetch: throttledFetch,
  // Devnet confirmation can lag well past the default when the RPC is busy.
  confirmTransactionInitialTimeout: 90_000,
});

let _program: anchor.Program | null = null;

export function program(): anchor.Program {
  if (_program) return _program;
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(`IDL missing at ${IDL_PATH} — run \`anchor build\` first.`);
  }
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as Idl;
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: COMMITMENT,
  });
  _program = new Program(idl, provider);
  return _program;
}

export function programId(): PublicKey {
  return program().programId;
}

// -------------------------------------------------------------------- PDAs --

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId())[0];
}

export function userPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), owner.toBuffer()],
    programId(),
  )[0];
}

export function positionPda(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), userPda(owner).toBuffer(), mint.toBuffer()],
    programId(),
  )[0];
}

export function accrualPda(cardTxId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("accrual"), cardTxIdBytes(cardTxId)],
    programId(),
  )[0];
}

/**
 * Card transaction ids are arbitrary strings; the PDA seed is 16 bytes. A
 * truncated SHA-256 keeps the seed fixed-width while staying deterministic, so
 * the same webhook always maps to the same PDA — which is what makes replay
 * impossible.
 */
export function cardTxIdBytes(cardTxId: string): Buffer {
  return createHash("sha256").update(cardTxId).digest().subarray(0, 16);
}

export function vaultAta(mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, configPda(), true);
}

export function explorer(kind: "tx" | "address", id: string): string {
  const suffix = CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`;
  return `https://explorer.solana.com/${kind}/${id}${suffix}`;
}

// ------------------------------------------------------------ instructions --

export async function initializeConfig(rewardBps: number): Promise<string> {
  return program()
    .methods.initializeConfig(rewardBps)
    .accountsPartial({
      config: configPda(),
      authority: authority.publicKey,
      oracleSigner: oracleSigner.publicKey,
      treasury: treasury.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function fetchConfig(): Promise<any | null> {
  try {
    return await (program().account as any).config.fetch(configPda());
  } catch {
    return null;
  }
}

export async function openUser(user: Keypair): Promise<string> {
  return program()
    .methods.openUser()
    .accountsPartial({
      userAccount: userPda(user.publicKey),
      owner: user.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();
}

export async function userAccountExists(owner: PublicKey): Promise<boolean> {
  return (await connection.getAccountInfo(userPda(owner))) !== null;
}

export interface AccrueArgs {
  owner: PublicKey;
  cardTxId: string;
  /** Dollars. Converted to micro-dollars here so callers never juggle units. */
  spendUsd: number;
  mint: PublicKey;
  symbol: string;
  merchant: string;
  mcc: number;
}

export async function accrueReward(a: AccrueArgs): Promise<string> {
  return program()
    .methods.accrueReward(
      Array.from(cardTxIdBytes(a.cardTxId)),
      new BN(Math.round(a.spendUsd * USD_UNIT)),
      a.symbol.slice(0, 12),
      a.merchant.slice(0, 32),
      a.mcc,
    )
    .accountsPartial({
      config: configPda(),
      oracleSigner: oracleSigner.publicKey,
      owner: a.owner,
      userAccount: userPda(a.owner),
      tickerMint: a.mint,
      rewardPosition: positionPda(a.owner, a.mint),
      accrual: accrualPda(a.cardTxId),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function settleDistribute(args: {
  owner: PublicKey;
  mint: PublicKey;
  /** Integer micro-dollars — must equal what accrue_reward booked. */
  usdMicro: number;
  /** Base units, already scaled by the mint's decimals. */
  tokenAmount: bigint;
}): Promise<string> {
  return program()
    .methods.settleDistribute(
      new BN(args.usdMicro),
      new BN(args.tokenAmount.toString()),
    )
    .accountsPartial({
      config: configPda(),
      treasury: treasury.publicKey,
      owner: args.owner,
      userAccount: userPda(args.owner),
      tickerMint: args.mint,
      rewardPosition: positionPda(args.owner, args.mint),
      treasuryTokenAccount: getAssociatedTokenAddressSync(args.mint, treasury.publicKey),
      vault: vaultAta(args.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function claim(user: Keypair, mint: PublicKey): Promise<string> {
  return program()
    .methods.claim()
    .accountsPartial({
      config: configPda(),
      owner: user.publicKey,
      userAccount: userPda(user.publicKey),
      tickerMint: mint,
      rewardPosition: positionPda(user.publicKey, mint),
      vault: vaultAta(mint),
      userTokenAccount: getAssociatedTokenAddressSync(mint, user.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();
}

// ----------------------------------------------------------------- reads ---

export interface OnChainPosition {
  mint: string;
  symbol: string;
  accruedUsd: number;
  settledUsd: number;
  distributedTokens: bigint;
  claimedTokens: bigint;
  address: string;
}

export async function fetchPositions(owner: PublicKey): Promise<OnChainPosition[]> {
  const user = userPda(owner);
  const rows = await (program().account as any).rewardPosition.all([
    { memcmp: { offset: 8, bytes: user.toBase58() } },
  ]);
  return rows.map((r: any) => ({
    mint: r.account.tickerMint.toBase58(),
    symbol: r.account.symbol,
    accruedUsd: Number(r.account.accruedUsd) / USD_UNIT,
    settledUsd: Number(r.account.settledUsd) / USD_UNIT,
    distributedTokens: BigInt(r.account.distributedTokens.toString()),
    claimedTokens: BigInt(r.account.claimedTokens.toString()),
    address: r.publicKey.toBase58(),
  }));
}

export async function fetchUserAccount(owner: PublicKey): Promise<any | null> {
  try {
    return await (program().account as any).userAccount.fetch(userPda(owner));
  } catch {
    return null;
  }
}

export async function ensureFunded(pubkey: PublicKey, minSol: number): Promise<void> {
  const balance = await connection.getBalance(pubkey);
  if (balance >= minSol * LAMPORTS_PER_SOL) return;
  const { SystemProgram: SP, Transaction, sendAndConfirmTransaction } = await import(
    "@solana/web3.js"
  );
  const tx = new Transaction().add(
    SP.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: pubkey,
      lamports: Math.ceil(minSol * LAMPORTS_PER_SOL) - balance,
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: COMMITMENT });
}

export { Keypair, PublicKey };
