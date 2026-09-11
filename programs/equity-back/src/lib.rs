//! Equity-Back Card — "Spend at a company, own a piece of it."
//!
//! The on-chain surface is deliberately narrow — it records ownership, nothing else:
//!   - accrue_reward     : book the USD reward for one card authorization, exactly once
//!   - settle_distribute : keeper deposits the converted ticker tokens, credits the position
//!   - claim             : user withdraws to their own ATA
//!
//! Card authorization itself is off-chain (it always will be — Visa is not a
//! blockchain), so the program's job is to be the tamper-proof ledger of
//! *ownership*, with idempotency enforced by a PDA per card transaction.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("BuM8wmDCcUu3uJwphiN5vBEMxGPggL1Kui9greZaHK4");

/// USD amounts are carried as integer micro-dollars (1_000_000 == $1.00),
/// matching USDC's 6 decimals so the production swap path needs no rescaling.
pub const USD_DECIMALS: u8 = 6;
/// Hard ceiling on the reward rate so a compromised authority cannot set 100%.
pub const MAX_REWARD_BPS: u16 = 2_000; // 20%

#[program]
pub mod equity_back {
    use super::*;

    /// One-time program setup. `reward_bps` is the headline cashback rate
    /// (300 == 3%).
    pub fn initialize_config(ctx: Context<InitializeConfig>, reward_bps: u16) -> Result<()> {
        require!(
            reward_bps > 0 && reward_bps <= MAX_REWARD_BPS,
            EquityBackError::InvalidRewardBps
        );

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.oracle_signer = ctx.accounts.oracle_signer.key();
        config.treasury = ctx.accounts.treasury.key();
        config.reward_bps = reward_bps;
        config.total_spent_usd = 0;
        config.total_accrued_usd = 0;
        config.total_settled_usd = 0;
        config.accrual_count = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Re-point the off-chain signers without redeploying.
    pub fn set_signers(
        ctx: Context<SetSigners>,
        oracle_signer: Pubkey,
        treasury: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.oracle_signer = oracle_signer;
        config.treasury = treasury;
        Ok(())
    }

    /// A cardholder opts in. Signed by the user, so the position is
    /// unambiguously theirs.
    pub fn open_user(ctx: Context<OpenUser>) -> Result<()> {
        let user = &mut ctx.accounts.user_account;
        user.owner = ctx.accounts.owner.key();
        user.total_spent_usd = 0;
        user.total_rewarded_usd = 0;
        user.tx_count = 0;
        user.bump = ctx.bumps.user_account;
        Ok(())
    }

    /// Record the reward owed for one card authorization.
    ///
    /// The `Accrual` PDA is seeded by `card_tx_id`, so a webhook delivered
    /// twice (which card networks absolutely do) cannot double-pay: the second
    /// `init` fails. This is the single most important property of the whole
    /// program — do not move de-duplication off-chain.
    pub fn accrue_reward(
        ctx: Context<AccrueReward>,
        card_tx_id: [u8; 16],
        spend_usd: u64,
        symbol: String,
        merchant: String,
        mcc: u16,
    ) -> Result<()> {
        require!(spend_usd > 0, EquityBackError::ZeroAmount);
        require!(symbol.len() <= MAX_SYMBOL_LEN, EquityBackError::SymbolTooLong);
        require!(
            merchant.len() <= MAX_MERCHANT_LEN,
            EquityBackError::MerchantTooLong
        );

        let config = &ctx.accounts.config;
        let reward_usd = (spend_usd as u128)
            .checked_mul(config.reward_bps as u128)
            .ok_or(EquityBackError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(EquityBackError::MathOverflow)? as u64;
        require!(reward_usd > 0, EquityBackError::RewardDustOnly);

        let position = &mut ctx.accounts.reward_position;
        if position.user == Pubkey::default() {
            position.user = ctx.accounts.user_account.key();
            position.ticker_mint = ctx.accounts.ticker_mint.key();
            position.symbol = symbol.clone();
            position.bump = ctx.bumps.reward_position;
        }
        position.accrued_usd = position
            .accrued_usd
            .checked_add(reward_usd)
            .ok_or(EquityBackError::MathOverflow)?;

        let accrual = &mut ctx.accounts.accrual;
        accrual.user_account = ctx.accounts.user_account.key();
        accrual.ticker_mint = ctx.accounts.ticker_mint.key();
        accrual.card_tx_id = card_tx_id;
        accrual.spend_usd = spend_usd;
        accrual.reward_usd = reward_usd;
        accrual.symbol = symbol.clone();
        accrual.merchant = merchant.clone();
        accrual.mcc = mcc;
        accrual.ts = Clock::get()?.unix_timestamp;

        let user = &mut ctx.accounts.user_account;
        user.total_spent_usd = user
            .total_spent_usd
            .checked_add(spend_usd)
            .ok_or(EquityBackError::MathOverflow)?;
        user.total_rewarded_usd = user
            .total_rewarded_usd
            .checked_add(reward_usd)
            .ok_or(EquityBackError::MathOverflow)?;
        user.tx_count = user.tx_count.saturating_add(1);

        let config = &mut ctx.accounts.config;
        config.total_spent_usd = config.total_spent_usd.saturating_add(spend_usd);
        config.total_accrued_usd = config.total_accrued_usd.saturating_add(reward_usd);
        config.accrual_count = config.accrual_count.saturating_add(1);

        emit!(RewardAccrued {
            user: ctx.accounts.owner.key(),
            ticker_mint: ctx.accounts.ticker_mint.key(),
            symbol,
            merchant,
            mcc,
            spend_usd,
            reward_usd,
            card_tx_id,
        });
        Ok(())
    }

    /// The keeper has converted `usd_amount` of accrued rewards into
    /// `token_amount` of the ticker (via Jupiter in production; via the mock
    /// treasury here) and moves those tokens into the program vault.
    pub fn settle_distribute(
        ctx: Context<SettleDistribute>,
        usd_amount: u64,
        token_amount: u64,
    ) -> Result<()> {
        require!(
            usd_amount > 0 && token_amount > 0,
            EquityBackError::ZeroAmount
        );
        let position = &mut ctx.accounts.reward_position;
        require!(
            position.accrued_usd >= usd_amount,
            EquityBackError::InsufficientAccrual
        );

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.treasury_token_account.to_account_info(),
                    mint: ctx.accounts.ticker_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.treasury.to_account_info(),
                },
            ),
            token_amount,
            ctx.accounts.ticker_mint.decimals,
        )?;

        position.accrued_usd -= usd_amount;
        position.settled_usd = position.settled_usd.saturating_add(usd_amount);
        position.distributed_tokens = position
            .distributed_tokens
            .checked_add(token_amount)
            .ok_or(EquityBackError::MathOverflow)?;

        let config = &mut ctx.accounts.config;
        config.total_settled_usd = config.total_settled_usd.saturating_add(usd_amount);

        emit!(RewardDistributed {
            user: ctx.accounts.user_account.key(),
            ticker_mint: ctx.accounts.ticker_mint.key(),
            symbol: position.symbol.clone(),
            usd_amount,
            token_amount,
        });
        Ok(())
    }

    /// Withdraw everything credited but not yet withdrawn into the user's own
    /// ATA. Tokens sit in a program vault until claimed so a batch of 5,000
    /// rewards doesn't have to create 5,000 ATAs up front.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let position = &mut ctx.accounts.reward_position;
        let claimable = position
            .distributed_tokens
            .checked_sub(position.claimed_tokens)
            .ok_or(EquityBackError::MathOverflow)?;
        require!(claimable > 0, EquityBackError::NothingToClaim);

        let bump = ctx.accounts.config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[bump]]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.ticker_mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            claimable,
            ctx.accounts.ticker_mint.decimals,
        )?;

        position.claimed_tokens = position
            .claimed_tokens
            .checked_add(claimable)
            .ok_or(EquityBackError::MathOverflow)?;

        emit!(RewardClaimed {
            user: ctx.accounts.owner.key(),
            ticker_mint: ctx.accounts.ticker_mint.key(),
            symbol: position.symbol.clone(),
            token_amount: claimable,
        });
        Ok(())
    }
}

pub const CONFIG_SEED: &[u8] = b"config";
pub const USER_SEED: &[u8] = b"user";
pub const POSITION_SEED: &[u8] = b"position";
pub const ACCRUAL_SEED: &[u8] = b"accrual";

pub const MAX_SYMBOL_LEN: usize = 12;
pub const MAX_MERCHANT_LEN: usize = 32;

// ---------------------------------------------------------------- accounts --

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    /// Backend key allowed to record accruals. Compromise costs fake rewards,
    /// not funds — it can never move tokens.
    pub oracle_signer: Pubkey,
    /// Holds the ticker inventory and signs settlement transfers.
    pub treasury: Pubkey,
    pub reward_bps: u16,
    pub total_spent_usd: u64,
    pub total_accrued_usd: u64,
    pub total_settled_usd: u64,
    pub accrual_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    pub owner: Pubkey,
    pub total_spent_usd: u64,
    pub total_rewarded_usd: u64,
    pub tx_count: u32,
    pub bump: u8,
}

/// One per (user, ticker). This is the user's cap-table row.
#[account]
#[derive(InitSpace)]
pub struct RewardPosition {
    pub user: Pubkey,
    pub ticker_mint: Pubkey,
    #[max_len(12)]
    pub symbol: String,
    /// USD owed but not yet converted to stock (e.g. earned over the weekend).
    pub accrued_usd: u64,
    pub settled_usd: u64,
    pub distributed_tokens: u64,
    pub claimed_tokens: u64,
    pub bump: u8,
}

/// Existence == "this card transaction has been paid out". Never closed.
#[account]
#[derive(InitSpace)]
pub struct Accrual {
    pub user_account: Pubkey,
    pub ticker_mint: Pubkey,
    pub card_tx_id: [u8; 16],
    pub spend_usd: u64,
    pub reward_usd: u64,
    #[max_len(12)]
    pub symbol: String,
    #[max_len(32)]
    pub merchant: String,
    pub mcc: u16,
    pub ts: i64,
}

// ------------------------------------------------------------- ix contexts --

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: stored as a pubkey only.
    pub oracle_signer: UncheckedAccount<'info>,
    /// CHECK: stored as a pubkey only.
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetSigners<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct OpenUser<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub user_account: Account<'info, UserAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(card_tx_id: [u8; 16])]
pub struct AccrueReward<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Only the backend may record spend. It pays rent for the new PDAs.
    #[account(mut, address = config.oracle_signer @ EquityBackError::UnauthorizedOracle)]
    pub oracle_signer: Signer<'info>,

    /// CHECK: keyed into the user PDA below; never written to.
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump = user_account.bump,
        has_one = owner,
    )]
    pub user_account: Account<'info, UserAccount>,

    pub ticker_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = oracle_signer,
        space = 8 + RewardPosition::INIT_SPACE,
        seeds = [POSITION_SEED, user_account.key().as_ref(), ticker_mint.key().as_ref()],
        bump,
    )]
    pub reward_position: Account<'info, RewardPosition>,

    /// Seeded by the card transaction id: this is the replay guard.
    #[account(
        init,
        payer = oracle_signer,
        space = 8 + Accrual::INIT_SPACE,
        seeds = [ACCRUAL_SEED, card_tx_id.as_ref()],
        bump,
    )]
    pub accrual: Account<'info, Accrual>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleDistribute<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, address = config.treasury @ EquityBackError::UnauthorizedTreasury)]
    pub treasury: Signer<'info>,

    /// CHECK: keyed into the user PDA below.
    pub owner: UncheckedAccount<'info>,

    #[account(
        seeds = [USER_SEED, owner.key().as_ref()],
        bump = user_account.bump,
        has_one = owner,
    )]
    pub user_account: Account<'info, UserAccount>,

    pub ticker_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [POSITION_SEED, user_account.key().as_ref(), ticker_mint.key().as_ref()],
        bump = reward_position.bump,
    )]
    pub reward_position: Account<'info, RewardPosition>,

    #[account(
        mut,
        associated_token::mint = ticker_mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program,
    )]
    pub treasury_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Custody until the user claims. Authority is the config PDA.
    #[account(
        init_if_needed,
        payer = treasury,
        associated_token::mint = ticker_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [USER_SEED, owner.key().as_ref()],
        bump = user_account.bump,
        has_one = owner,
    )]
    pub user_account: Account<'info, UserAccount>,

    pub ticker_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [POSITION_SEED, user_account.key().as_ref(), ticker_mint.key().as_ref()],
        bump = reward_position.bump,
    )]
    pub reward_position: Account<'info, RewardPosition>,

    #[account(
        mut,
        associated_token::mint = ticker_mint,
        associated_token::authority = config,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = ticker_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ------------------------------------------------------------------ events --

#[event]
pub struct RewardAccrued {
    pub user: Pubkey,
    pub ticker_mint: Pubkey,
    pub symbol: String,
    pub merchant: String,
    pub mcc: u16,
    pub spend_usd: u64,
    pub reward_usd: u64,
    pub card_tx_id: [u8; 16],
}

#[event]
pub struct RewardDistributed {
    pub user: Pubkey,
    pub ticker_mint: Pubkey,
    pub symbol: String,
    pub usd_amount: u64,
    pub token_amount: u64,
}

#[event]
pub struct RewardClaimed {
    pub user: Pubkey,
    pub ticker_mint: Pubkey,
    pub symbol: String,
    pub token_amount: u64,
}

// ------------------------------------------------------------------ errors --

#[error_code]
pub enum EquityBackError {
    #[msg("reward_bps must be in (0, 2000]")]
    InvalidRewardBps,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("reward rounds to zero at this spend level")]
    RewardDustOnly,
    #[msg("symbol exceeds 12 bytes")]
    SymbolTooLong,
    #[msg("merchant name exceeds 32 bytes")]
    MerchantTooLong,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("settlement exceeds the accrued balance")]
    InsufficientAccrual,
    #[msg("nothing available to claim")]
    NothingToClaim,
    #[msg("signer is not the configured oracle")]
    UnauthorizedOracle,
    #[msg("signer is not the configured treasury")]
    UnauthorizedTreasury,
}
