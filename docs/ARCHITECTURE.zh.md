# Owys 技术说明

面向工程师。产品层面的说明见 [OVERVIEW.zh.md](OVERVIEW.zh.md)。

全栈 3,900 行左右：Anchor 程序 561 行，TypeScript 后端约 1,700 行，单文件前端 713 行。

---

## 1. 整体数据流

```
                  ┌─────────────────────────────────────────────┐
 卡组织（模拟）    │  POST /webhook/card-authorization           │
                  │  Stripe Issuing 形态的 payload              │
                  └──────────────────┬──────────────────────────┘
                                     │  约 2 秒内必须给出 approve/decline
                  ┌──────────────────▼──────────────────────────┐
                  │  余额校验 → 不足则 declined，不记账不返点     │
                  └──────────────────┬──────────────────────────┘
                                     │
                  ┌──────────────────▼──────────────────────────┐
                  │  MerchantResolver    ← 产品真正的难点        │
                  │  描述符 + MCC + network_id → 上市母公司       │
                  │  → 选发行方 → 具体代币                       │
                  └──────────────────┬──────────────────────────┘
                                     │
                  ┌──────────────────▼──────────────────────────┐
                  │  RewardLedger（链下，整数微美元）            │
                  └──────────────────┬──────────────────────────┘
                                     │  同步返回决策后，异步上链
                  ┌──────────────────▼──────────────────────────┐
                  │  equity_back::accrue_reward                 │
                  │  Accrual PDA 以 card_tx_id 为种子 ← 防重放   │
                  └──────────────────┬──────────────────────────┘
                                     │  按 ticker 聚合批处理
                  ┌──────────────────▼──────────────────────────┐
                  │  SettlementKeeper → 换汇 → settle_distribute│
                  │  （此处 mock；生产接 Jupiter）               │
                  └──────────────────┬──────────────────────────┘
                                     │  用户签名
                  ┌──────────────────▼──────────────────────────┐
                  │  equity_back::claim → 用户自己的 ATA         │
                  └─────────────────────────────────────────────┘
```

**为什么授权决策和上链是分开的**：真实的实时授权 webhook 只有约 2 秒预算来批准或拒绝，不够再等一次链上写入。所以决策和链下记账是同步的，链上 accrual 异步补，签名落地后推给前端（SSE）。`sync=1` 参数可以强制等待，供脚本化 demo 使用。

---

## 2. 链上程序

`programs/equity-back/src/lib.rs` · 程序 ID `BuM8wmDCcUu3uJwphiN5vBEMxGPggL1Kui9greZaHK4`（devnet）

链上只做一件事：**成为所有权的不可篡改记录**。卡授权本身是中心化的，也永远会是 —— Visa 不是区块链 —— 所以不假装把它塞上链。

### 指令

```rust
initialize_config(reward_bps)                                // authority 签
set_signers(oracle_signer, treasury)                         // authority 签
open_user()                                                  // 用户签
accrue_reward(card_tx_id, spend_usd, symbol, merchant, mcc)  // oracle 签
settle_distribute(usd_amount, token_amount)                  // treasury 签
claim()                                                      // 用户签
```

### 账户

| 账户 | seeds | 作用 |
| --- | --- | --- |
| `Config` | `["config"]` | 费率、三个角色密钥、全局统计 |
| `UserAccount` | `["user", owner]` | 单用户累计消费/返点/笔数 |
| `RewardPosition` | `["position", user, mint]` | 用户在某只股票上的持仓行 |
| `Accrual` | `["accrual", card_tx_id]` | **存在即已支付**，永不关闭 |

### 三个值得辩护的设计

**① 防重放在链上，不在应用层。**
`Accrual` 的 seed 是卡交易 ID 的 SHA-256 截断 16 字节。卡组织重复投递 webhook 是常态，第二次 `init` 直接失败。不要把这个去重挪到链下。

```rust
#[account(init, payer = oracle_signer, space = 8 + Accrual::INIT_SPACE,
          seeds = [ACCRUAL_SEED, card_tx_id.as_ref()], bump)]
pub accrual: Account<'info, Accrual>,
```

**② oracle 密钥动不了代币。**
`accrue_reward` 只写美元计价的记账条目；任何代币移动都需要 treasury 或用户签名。webhook 服务被攻破，只能凭空造出「索赔」，造不出「股份」。

**③ 代币在程序金库里等着被 claim。**
一批 5,000 笔返点不必预先创建并充值 5,000 个 ATA。`settle_distribute` 把代币转进 Config PDA 的 ATA 并记账，用户自己 `claim` 时才创建自己的 ATA。

### 事件

`RewardAccrued` / `RewardDistributed` / `RewardClaimed` —— 供索引器和前端订阅。

---

## 3. 商户解析管道

`server/src/merchantResolver.ts` + `server/src/brands.ts`

### 归一化必须排在最前

否则后面全错。`PAYPAL *NIKESTORE` 不剥前缀就会把返点记到 PayPal 头上。

```
1. 转大写
2. 剥处理商前缀（以 * 分隔居多）：SQ、TST、TOAST、CLOVER、STRIPE、PAYPAL、PP…
3. 去标点
4. 去掉残留的前导处理商词
5. 去掉 3 位以上数字串（门店号、电话、订单号）和纯数字 token
6. 压缩空白
```

`SQ *BLUE BOTTLE COFFEE` → `BLUE BOTTLE COFFEE`
`NIKE.COM 8006536453` → `NIKE COM`
`MCDONALD'S F12345` → `MCDONALD S F12345`

### 六级阶梯

见 OVERVIEW。实现上的几个要点：

- **精确匹配取最长命中**，所以 `UBER EATS` 赢过 `UBER`
- **模糊匹配**用 Levenshtein 相似度，阈值 0.82，同时比较描述符头部和整体
- **MCC 佐证**会提升置信度（0.90 → 0.98），不佐证则打折
- **代理敞口**（如 OPENAI → MSFT）置信度硬顶在 0.55，并单独打标
- **识别成功但买不到**时，把识别结果带着往下走，UI 才能解释「认出来了但这家发行方没有」

每次解析返回一个 `trace: string[]`，这是可解释性的基础，也是规模化之后唯一能排障的手段。

### LLM 钩子

`ResolveContext.llmFallback` 是留给模型的插入点，**故意没有启用**。前三级已经覆盖了绝大部分消费额，模型的成本只应该花在长尾上。

---

## 4. 多发行方 universe

`server/src/tickers.ts`

三份目录（xStocks / Sunrise / Ondo）在构建时按偏好顺序去重：

```ts
export const ISSUER_PREFERENCE: Issuer[] = ["xStocks", "Sunrise", "Ondo"];
```

每个 `TickerDef` 记录 `issuer`（实际结算走谁）和 `alsoOn`（还有谁也有，即路由备选）。符号规则各不相同：

| 发行方 | 后缀 | 示例 |
| --- | --- | --- |
| xStocks | `x` | `AAPLx` |
| Sunrise | 无 | `COST`、`SPCX` |
| Ondo | `on` | `NKEon` |

**这里的偏好顺序是硬编码的，生产环境不应该是。** 真实场景下这是**按笔的流动性路由决策** —— 深度和价差按发行方不同，而对一笔 $0.20 的返点来说，价差就是全部成本。当前只有 3 个标的重叠（IBM、JNJ、PFE），真实目录里重叠会大得多。

另外 Ondo 那块是**代表性子集**，不是完整 200+：只包含本仓商户表需要、而前两家没有的标的。所以覆盖率数字对 Ondo 是**下限**不是上限。

---

## 5. 结算 keeper

`server/src/keeper.ts`

**按 ticker 批量，不按笔。** 一杯 $4 的咖啡返 $0.12 —— Solana 上单独换汇的手续费可以忽略，但 $0.12 订单的滑点和 `minOut` 保护不行。批量是 3% 返一杯咖啡在经济上成立的前提。

流程：
1. 取出所有 `accrued` 状态的记账，按 payout ticker 分组
2. 每组低于 `MIN_BATCH_USD` 则跳过（等更多消费）
3. 换汇（此处 mock 固定报价；生产是 Jupiter quote + swap）
4. 按每个用户在本批中的占比分配代币，**取整误差归给最后一条腿**，避免凭空造币
5. 逐腿调用 `settle_distribute` 上链

生产还需要一个**周末队列**：代币化股票 24/5 交易，周六的返点必须以 USDC 挂着等周一 —— 而且 UI 应该明说，不要藏。

### 一个真实踩过的坑：整数算术

链下曾把每笔返点四舍五入到分（$0.2175 → $0.22），链上用精确 bps 整数运算（$0.2175）。三笔 XLY 累加后链下比链上多 $0.0075，结算直接报 `InsufficientAccrual`。

现在链下全程走**整数微美元、向下取整**，与程序逐位一致：

```ts
const spendMicro  = Math.round(amountUsd * 1_000_000);
const rewardMicro = Math.floor((spendMicro * REWARD_BPS) / 10_000);
```

这类误差在任何真实支付系统里都会咬人。

---

## 6. 链下账本与余额

`server/src/ledger.ts` —— 一个 JSON 文件。PoC 量级足够，且避免了原生 SQLite 依赖。所有访问都经过这个模块，换 Postgres 只改一个文件。

真正重要的性质不是存储引擎，而是：**卡交易 ID 在任何地方都是主键**，和链上 `Accrual` PDA 的 seed 完全一致 —— 链上链下用同一个键去重。

余额是链下的（本 PoC 没有链上 USDC 金库），但**会真的拦截授权**：

```ts
if (incoming.amountUsd > user.availableUsd) {
  // 记为 declined，不返点，返回 approved: false
}
```

⚠️ **已知限制：JSON 账本没有锁。** server 和 `pnpm demo` 各自持有内存副本，同时跑会互相覆盖写入（表现为用户重复、交易翻倍、商户缓存莫名其妙已经热了）。`pnpm demo` 现在会检测 4000 端口并拒绝启动，`ALLOW_CONCURRENT=1` 可覆盖。换 Postgres 即消失。

---

## 7. HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/webhook/card-authorization` | **唯一有架构意义的端点**。接受本仓形态或原生 Stripe Issuing payload，返回 `{approved, declineReason?}`。换成真沙箱＝改调用方，不改 handler |
| POST | `/api/users` · GET `/api/users` | 持卡人 |
| POST | `/api/topup` | 充值（代替 USDC 存入） |
| POST | `/api/simulate` | 触发模拟授权（指定商户或随机 N 笔） |
| GET | `/api/merchants` | 商户 fixture 列表 |
| GET | `/api/resolve?descriptor=&mcc=` | **解析器 playground** —— 任意描述符进去，完整 trace 出来 |
| POST | `/api/keeper/run` | 手动触发结算 |
| POST | `/api/claim` | 提币到用户 ATA |
| GET | `/api/portfolio/:userId` | 链上读回的持仓 + 交易记录 |
| GET | `/api/state` | 全局状态、发行方、统计、结算批次 |
| GET | `/api/stream` | SSE 实时事件流 |

---

## 8. 代码地图

```
programs/equity-back/src/lib.rs   链上程序（561 行）
server/src/brands.ts              62 个品牌，母公司映射，MCC 表
server/src/merchantResolver.ts    六级解析阶梯
server/src/tickers.ts             三家发行方的 universe，去重与路由
server/src/pipeline.ts            解析 → 记账 → 上链（server 与 CLI 共用）
server/src/keeper.ts              批量结算
server/src/chain.ts               PDA、指令、限流 RPC
server/src/ledger.ts              链下账本、余额
server/src/cardSim.ts             模拟卡组织，35 个脏描述符
server/public/index.html          前端（单文件，无构建步骤）
scripts/demo.ts                   命令行端到端演示
scripts/resolver-report.ts        覆盖率报告 —— 调商户表的主循环
scripts/mint-mock-tickers.ts      铸造 mock 标的（可断点续跑）
```

---

## 9. 环境坑（已解决，记录备查）

**① 这台 Mac 的 `cc` 是坏的。**
`xcode-select` 指向的 Xcode 里 `USDKit` 加载失败，宿主链接器跑不起来，`anchor build` 在 build script 阶段挂掉，`git` 也报同样的错。不需要 sudo 的绕法：

```bash
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
```

永久修复需要密码：`sudo xcode-select --switch /Library/Developer/CommandLineTools`

**② Cargo 依赖漂移。**
Solana platform-tools v1.48 自带 rustc/cargo **1.84**，既不支持 `edition2024` 也不支持 MSRV ≥1.85。全新解析会拉进它解析不了的包。而且 **`anchor build` 在底层 cargo 失败时仍然返回退出码 0** —— 必须检查 `target/deploy/*.so` 和 IDL 是否真的生成。

排查方法不要一个个试编译错误，直接扫锁文件里所有已下载包的 manifest，找 `edition = "2024"` 和 `rust-version > 1.84`，一次性拿到全表。已固定：

```
blake3 1.5.5 · proc-macro-crate 3.2.0 · indexmap 2.9.0
zeroize 1.8.1 · zeroize_derive 1.4.2 · unicode-segmentation 1.12.0
```

**`Cargo.lock` 必须提交。**

**③ ESM 下 `@coral-xyz/anchor` 的 `BN` 是 undefined。**
`AnchorProvider` / `Program` / `Wallet` 都能拿到，唯独 `BN` 拿不到。直接从 `bn.js` 导入。注意用 `tsx -e` 测试会跑在 CJS 下，**看起来是好的**，很容易误判。

**④ 公共 devnet RPC 限流很凶。**
`chain.ts` 把所有请求排进单队列，最小间隔 + 429/5xx 指数退避；铸造脚本可断点续跑。接付费节点后：

```bash
RPC_URL=https://... RPC_MIN_INTERVAL_MS=0 pnpm demo
```

---

## 10. 从 mock 走向真实，按信息量排序

1. **真实 swap** —— 主网上拿一个标的、极小金额走一遍 Jupiter。验证 $0.20–$50 量级的真实滑点和流动性。**这是信息量最大的单一动作。**
2. **逐发行方核实资产端** —— xStocks / Ondo / Sunrise 的代币是不是 Token-2022？有没有 transfer hook 或白名单限制向任意钱包分发？小数位是多少？这决定自由分发能否成立，而且**答案可能因发行方而异** —— 那样的话发行方路由就不只是流动性决策，还是合规决策。
3. **接真实发卡沙箱** —— Stripe Issuing 测试模式指向 `/webhook/card-authorization`，返回真实 approve/decline。
4. **嵌入式钱包** —— Privy 或 Turnkey 加 fee payer，用户永远不用见到密钥对。
5. **测真实命中率** —— 把 `pnpm resolver-report` 指向脱敏的真实描述符样本。35 个手挑样本上的 80% 不是预测；真实数字是这个产品的天花板，所有测算都建立在它上面。

---

## 11. 其他已知限制

- **单钱包身兼三职**：本 PoC 中 `authority = oracle_signer = treasury`。生产环境应是三把钥匙、三个地方（authority 进多签，oracle 在 webhook 服务里，treasury 在库存实际所在处）。
- **keeper 逐腿串行上链**，demo 规模够用；生产应该一笔交易多条腿。
- **`DOORDASH*BURGER KING`** —— 一个描述符两个品牌。解析器取最长命中（Burger King → RBI），即「用户实际在哪吃」而不是「记录商户是谁」。站得住，但这是产品决策，应该是有意识做出的。
- **链上 crate 仍叫 `equity_back`** —— 项目改名 Owys 在部署之后，改 crate 名需要重新编译并部署（program ID 不受影响）。
