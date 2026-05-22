# OpenSea SeaDrop Public Mint Bot

> Built by **Airdrop Dxns** — follow updates on Telegram: [t.me/airdropdxns](https://t.me/airdropdxns)

Auto-mint bot for **public stage** of any OpenSea SeaDrop collection. Auto-detects price, schedule, fee recipient, and supply directly from on-chain state. Just plug in the NFT contract address and go.

Includes a bonus disperse script for fanning out gas to multiple wallets in a single transaction.

## Features

- **Universal SeaDrop support** — works on any project using OpenSea's SeaDrop contract
- **Auto-detect everything** — mint price, start time, fee recipient, supply pulled from on-chain
- **Pre-flight check** — simulates mint with `eth_simulateV1` (timestamp override) before broadcasting; catches SOLD OUT, wallet limits, payment errors
- **Decoded errors** — human-readable messages for `MintQuantityExceedsMaxSupply`, `NotActive`, etc. Never see "unknown custom error" again.
- **Dynamic gas tuning** — reads live base fee, applies configurable bump + buffer, capped by ceiling. Refreshes again right before broadcast.
- **Flashbots Protect by default** — uses private mempool to avoid frontrunning
- **Pre-sign + scheduled broadcast** — sleeps until target time, fires `LEAD_TIME_MS` early to compensate for network latency
- **Multi-wallet parallel** — broadcast all wallets concurrently via `Promise.all`
- **Per-wallet balance check** — wallets with insufficient ETH for `(price + gas)` are skipped, not blindly broadcast
- **Interactive menu** — just run `node mint.js` and pick an option

## Limitations

- **Public stage only** (`mintPublic`). FCFS / WL / GTD / token-gated stages use `mintSigned` and require a signature from OpenSea's private API per wallet, which cannot be automated without an authenticated session.
- **Ethereum mainnet by default**. The SeaDrop contract address is the same across mainnet, so for L2s update `SEADROP_CONTRACT` and `PUBLIC_RPC_URL` accordingly.

## Requirements

- **Node.js 18+** (LTS recommended: 20 or 22)
- An RPC endpoint (Alchemy, Infura, QuickNode, etc.)
- One or more funded wallets
- The target NFT contract address

## Setup

```bash
git clone <this-repo>
cd <this-repo>
npm install
cp .env.example .env
```

Edit `.env`:

```ini
PUBLIC_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_RPC_URL=https://rpc.flashbots.net/fast

PRIVATE_KEYS=0xkey1,0xkey2,0xkey3
NFT_CONTRACT=0x...

QUANTITY=1
GAS_BUMP_PERCENT=200
GAS_BUFFER_PERCENT=20
GAS_LIMIT_MULTIPLIER=1.3
MIN_PRIORITY_GWEI=1
MAX_GAS_CEILING_GWEI=50
LEAD_TIME_MS=200
```

Minimum required: `PUBLIC_RPC_URL`, `PRIVATE_KEYS`, `NFT_CONTRACT`. Everything else has sane defaults.

## Usage

Run the bot:

```bash
node mint.js
```

You'll see an interactive menu:

```
╔═══════════════════════════════════════════════╗
║       OpenSea SeaDrop Public Mint Bot         ║
╚═══════════════════════════════════════════════╝
  1) Run simulation now
  2) Schedule mint (uses on-chain startTime)
  3) Schedule mint at custom time
  4) Mint immediately
  0) Exit
```

| Option | What it does |
|---|---|
| **1** | Reads drop config, simulates mint with timestamp override, prints expected gas + cost per wallet. Does **not** broadcast. Use this first to verify everything looks right. |
| **2** | Sleeps until `startTime` from the on-chain drop config, then auto-broadcasts. Simplest path. |
| **3** | Same as 2 but you provide the target time manually (ISO 8601 format, e.g. `2026-05-23T00:00:00+07:00`). |
| **4** | Broadcasts immediately, no waiting. Only useful if the public stage is already active. |

Menu language is currently Indonesian; UI strings are isolated and easy to translate.

## How Auto-Detection Works

When you run the bot, it queries the SeaDrop contract:

1. `nft.name()`, `nft.symbol()`, `nft.totalSupply()`, `nft.maxSupply()` → collection metadata + supply
2. `seadrop.getPublicDrop(NFT_CONTRACT)` → mint price, start/end time, max per wallet, fee bps
3. `seadrop.getAllowedFeeRecipients(NFT_CONTRACT)` → fee recipient (when restricted)
4. `eth_simulateV1` with `blockOverrides.time = startTime + 60` → tests the mint as if the stage were live, even before it actually opens. Returns expected `gasUsed` or decoded revert reason.

If `totalSupply >= maxSupply`, the bot prints `💀 SOLD OUT` and aborts before sending any transaction. No wasted gas.

## Gas Strategy

```
maxFeePerGas = currentBaseFee × (1 + BUMP%) × (1 + BUFFER%)
maxPriorityFeePerGas = max(currentPriority, MIN_PRIORITY) × (1 + BUMP%)
```

Capped by `MAX_GAS_CEILING_GWEI` to prevent runaway costs.

Defaults: 200% bump + 20% buffer + 1 gwei priority floor + 50 gwei ceiling.

Examples (with defaults):
- Network at 0.3 gwei → maxFee 1.08 gwei, priority 3 gwei
- Network at 1 gwei → maxFee 3.6 gwei, priority 3 gwei
- Network at 5 gwei → maxFee 18 gwei, priority dynamic × 3 (capped at 50)

Gas is sampled twice: at simulation time, and again right before broadcast for accuracy.

## Decoded Errors

| Selector | Meaning |
|---|---|
| `0xe12d2314` | `MintQuantityExceedsMaxSupply` — sold out |
| `0x13da22f2` | `NotActive` — stage is not live yet (or has ended) |
| `0xedc01273` | `MintQuantityExceedsMaxMintedPerWallet` — wallet already minted |
| `0x0d35e921` | `IncorrectPayment` — `value` sent doesn't match `mintPrice × qty` |
| `0xf477d26f` | `FeeRecipientNotAllowed` — invalid fee recipient (auto-fixed by reading on-chain) |
| `0x9f8129d1` | `OnlyEOA` — must call from an externally-owned account |

## Bonus: Disperse Gas Script

`disperse.js` is a small companion script for funding many wallets in one transaction using the [disperse.app](https://disperse.app) contract.

```ini
# In .env
SENDER_KEY=0xprivkey_of_funder
ADDRESS_FILE=./address.txt
```

Create `address.txt` with one address per line:

```
0xWallet1...
0xWallet2...
0xWallet3...
```

Run:

```bash
node disperse.js
```

The script will:
1. Load addresses from `address.txt`
2. Show your sender balance
3. Ask how much ETH to send per wallet
4. Print total cost (transfer + gas)
5. Ask for confirmation
6. Broadcast a single `disperseEther()` call

Cheaper than sending N separate transfers. ~21k base + ~35k per recipient.

## Project Structure

```
.
├── mint.js              # main mint bot with interactive menu
├── disperse.js          # bonus: bulk gas distribution
├── address.txt          # recipients for disperse (gitignored)
├── .env                 # secrets (gitignored)
├── .env.example         # template
├── package.json
└── README.md
```

## Security Notes

- **Never commit `.env`** — already in `.gitignore`. Don't paste private keys anywhere.
- **Verify contract addresses** before running on a new project. Cross-check the NFT contract from the official project source.
- **Test on testnet first** if you want to be safe (deploy a test SeaDrop or use a known testnet collection).
- **Flashbots Protect** prevents your transaction from being seen in the public mempool, which mitigates frontrunning bots — but it does not guarantee inclusion. For very competitive drops, consider a Flashbots searcher setup.
- This bot interacts with **OpenSea's official SeaDrop contract** (`0x00005EA00Ac477B1030CE78506496e8C2dE24bf5`). Always confirm via Etherscan before sending real funds.

## License

MIT

## Credits

Built by **Airdrop Dxns**.

- Telegram Channel: [t.me/airdropdxns](https://t.me/airdropdxns)

If this bot helps you snag a mint, drop by the channel and say hi.

## Disclaimer

This software is provided as-is, with no warranty of any kind. You are responsible for the consequences of running it. NFT minting is risky — supplies can sell out, gas markets can spike, and bugs in any code (including this one) can lose funds. Test thoroughly and never mint with money you can't afford to lose.
