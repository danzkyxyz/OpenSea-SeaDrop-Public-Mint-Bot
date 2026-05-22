import 'dotenv/config';
import readline from 'node:readline';
import { ethers } from 'ethers';

const SEADROP_DEFAULT = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
  'function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address) view returns (address[])',
  'function getMintStats(address nftContract, address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)',
];

const NFT_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
];

const SEADROP_ERRORS = {
  '0x13da22f2': (a) => `NotActive (now=${a[0]} start=${a[1]} end=${a[2]}) — stage belum/tidak aktif`,
  '0xe12d2314': (a) => `MintQuantityExceedsMaxSupply (total=${a[0]} max=${a[1]}) — SOLD OUT`,
  '0xedc01273': (a) => `MintQuantityExceedsMaxMintedPerWallet (total=${a[0]} allowed=${a[1]}) — wallet sudah mint`,
  '0xb98dabea': (a) => `MintQuantityExceedsMaxTokenSupplyForStage (total=${a[0]} max=${a[1]})`,
  '0x0d35e921': (a) => `IncorrectPayment (got=${a[0]} want=${a[1]}) — value yang dikirim salah`,
  '0xf477d26f': () => `FeeRecipientNotAllowed — fee recipient tidak allowed`,
  '0x198441cb': () => `MintQuantityCannotBeZero`,
  '0x9f8129d1': () => `OnlyEOA — gak boleh dari contract`,
};

function decodeError(returnData) {
  if (!returnData || returnData === '0x') return 'no return data';
  const sel = returnData.slice(0, 10);
  const handler = SEADROP_ERRORS[sel];
  if (!handler) return `unknown error ${sel}`;
  const argsHex = returnData.slice(10);
  const args = [];
  for (let i = 0; i < argsHex.length; i += 64) {
    args.push(BigInt('0x' + argsHex.slice(i, i + 64)).toString());
  }
  return handler(args);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gwei = (n) => ethers.parseUnits(String(n), 'gwei');
const envOr = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

function parseKeys(raw) {
  return (raw || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => (k.startsWith('0x') ? k : '0x' + k));
}

function parseDateMs(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new Error(`Tanggal tidak valid: ${raw}`);
  return t;
}

function prompt(q, rl = null) {
  const ownRl = !rl;
  if (ownRl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => {
    if (ownRl) rl.close();
    res(a.trim());
  }));
}

async function getDynamicGas(provider, BUMP_PCT, BUFFER_PCT, MIN_PRIORITY, CEILING) {
  const fee = await provider.getFeeData();
  const block = await provider.getBlock('latest');
  const baseFee = block.baseFeePerGas || 0n;
  const mult = (100n + BUMP_PCT) * (100n + BUFFER_PCT);
  const bumpedBaseFee = (baseFee * mult) / 10000n;
  let priority = fee.maxPriorityFeePerGas || 0n;
  if (priority < MIN_PRIORITY) priority = MIN_PRIORITY;
  priority = (priority * (100n + BUMP_PCT)) / 100n;
  let maxFee = bumpedBaseFee + priority;
  if (maxFee > CEILING) maxFee = CEILING;
  if (priority > maxFee) priority = maxFee;
  return { baseFee, maxFee, maxPriority: priority };
}

async function showMenu(rl) {
  console.log('\n╔═════════════════════════════════════════════════════╗');
  console.log('║  OpenSea SeaDrop Public Mint Bot - By Airdrop Dxns  ║');
  console.log('╚═════════════════════════════════════════════════════╝');
  console.log('  1) Cek konfig & simulasi sekarang');
  console.log('  2) Schedule mint (otomatis di startTime on-chain)');
  console.log('  3) Schedule mint dengan jam custom');
  console.log('  4) Mint langsung sekarang (tanpa nunggu)');
  console.log('  0) Keluar');
  return prompt('\nPilih [1-4, 0]: ', rl);
}

async function run({ doSimulateOnly, doSchedule, atOverride }) {
  const PUBLIC_RPC_URL = envOr('PUBLIC_RPC_URL');
  const PRIVATE_RPC_URL = envOr('PRIVATE_RPC_URL', 'https://rpc.flashbots.net/fast');
  const NFT = ethers.getAddress(process.env.NFT_CONTRACT);
  const SEADROP = ethers.getAddress(envOr('SEADROP_CONTRACT', SEADROP_DEFAULT));
  const QUANTITY = BigInt(envOr('QUANTITY', '1'));
  const GAS_MULT = Number(envOr('GAS_LIMIT_MULTIPLIER', '1.3'));
  const BUMP_PCT = BigInt(envOr('GAS_BUMP_PERCENT', '200'));
  const BUFFER_PCT = BigInt(envOr('GAS_BUFFER_PERCENT', '20'));
  const MIN_PRIORITY = gwei(envOr('MIN_PRIORITY_GWEI', '1'));
  const CEILING = gwei(envOr('MAX_GAS_CEILING_GWEI', '50'));
  const LEAD_MS = Number(envOr('LEAD_TIME_MS', '200'));
  const KEYS = parseKeys(process.env.PRIVATE_KEYS);
  if (KEYS.length === 0) throw new Error('PRIVATE_KEYS belum di-set di .env');

  const publicProvider = new ethers.JsonRpcProvider(PUBLIC_RPC_URL);
  const privateProvider = new ethers.JsonRpcProvider(PRIVATE_RPC_URL);

  const seadrop = new ethers.Contract(SEADROP, SEADROP_ABI, publicProvider);
  const nft = new ethers.Contract(NFT, NFT_ABI, publicProvider);

  let collName = '?', collSymbol = '?', totalSupply = 0n, maxSupply = 0n;
  try { collName = await nft.name(); } catch {}
  try { collSymbol = await nft.symbol(); } catch {}
  try { totalSupply = await nft.totalSupply(); } catch {}
  try { maxSupply = await nft.maxSupply(); } catch {}

  log(`Collection: ${collName} (${collSymbol}) — ${NFT}`);
  log(`Supply    : ${totalSupply}/${maxSupply}`);

  if (maxSupply > 0n && totalSupply >= maxSupply) {
    log(`💀 SOLD OUT — gak ada slot tersisa.`);
    if (!doSimulateOnly) throw new Error('Sold out, batal mint.');
  }

  let drop;
  try {
    drop = await seadrop.getPublicDrop(NFT);
  } catch (e) {
    throw new Error(`Public drop belum di-set on-chain untuk ${NFT}.`);
  }
  const mintPrice = drop.mintPrice;
  const startTime = Number(drop.startTime);
  const endTime = Number(drop.endTime);
  const restrictFee = drop.restrictFeeRecipients;

  log(`Public drop config:`);
  log(`  price          : ${ethers.formatEther(mintPrice)} ETH`);
  log(`  startTime      : ${new Date(startTime * 1000).toISOString()} (${startTime})`);
  log(`  endTime        : ${new Date(endTime * 1000).toISOString()}`);
  log(`  maxPerWallet   : ${drop.maxTotalMintableByWallet}`);
  log(`  feeBps         : ${drop.feeBps}`);
  log(`  restrictFeeRcv : ${restrictFee}`);

  let feeRecipient;
  const FEE_OVERRIDE = process.env.FEE_RECIPIENT;
  if (FEE_OVERRIDE) {
    feeRecipient = ethers.getAddress(FEE_OVERRIDE);
    log(`Fee recipient (env): ${feeRecipient}`);
  } else {
    const allowed = await seadrop.getAllowedFeeRecipients(NFT);
    if (restrictFee) {
      if (allowed.length === 0) throw new Error('restrictFeeRecipients=true tapi tidak ada allowed recipient');
      feeRecipient = allowed[0];
      log(`Fee recipient (auto): ${feeRecipient}`);
    } else {
      feeRecipient = ethers.ZeroAddress;
      log(`Fee recipient (unrestricted)`);
    }
  }

  const iface = new ethers.Interface(SEADROP_ABI);
  const wallets = KEYS.map((pk) => new ethers.Wallet(pk));

  const data = iface.encodeFunctionData('mintPublic', [
    NFT, feeRecipient, ethers.ZeroAddress, QUANTITY,
  ]);
  const value = mintPrice * QUANTITY;

  const simGas = await getDynamicGas(publicProvider, BUMP_PCT, BUFFER_PCT, MIN_PRIORITY, CEILING);
  log(`Gas snapshot: baseFee=${ethers.formatUnits(simGas.baseFee, 'gwei')} gwei → maxFee=${ethers.formatUnits(simGas.maxFee, 'gwei')} gwei | priority=${ethers.formatUnits(simGas.maxPriority, 'gwei')} gwei`);

  const simAtTs = startTime + 60;
  const sims = [];
  let totalCost = 0n;

  for (const w of wallets) {
    try {
      const simFrom = ethers.Wallet.createRandom().address;
      const callObj = { from: simFrom, to: SEADROP, data, value: '0x' + value.toString(16) };
      const blockOverrides = { time: '0x' + simAtTs.toString(16) };
      const stateOverrides = { [simFrom]: { balance: '0x21e19e0c9bab2400000' } };

      const r = await publicProvider.send('eth_simulateV1', [{
        blockStateCalls: [{ blockOverrides, stateOverrides, calls: [callObj] }],
        traceTransfers: false, validation: false,
      }, 'latest']);
      const c = r[0].calls[0];
      if (c.status !== '0x1') throw new Error(decodeError(c.returnData));
      const gasUsed = BigInt(c.gasUsed);
      const gasLimit = (gasUsed * BigInt(Math.floor(GAS_MULT * 1000))) / 1000n;
      const cost = gasLimit * simGas.maxFee + value;

      const balance = await publicProvider.getBalance(w.address);
      const enough = balance >= cost;
      const status = enough ? '✅' : '⚠️ ';
      log(`${status} ${w.address} | gasLimit=${gasLimit} | maxCost=${ethers.formatEther(cost)} ETH | balance=${ethers.formatEther(balance)} ETH${enough ? '' : ' (INSUFFICIENT)'}`);
      if (!enough) {
        log(`   ↳ butuh tambahan: ${ethers.formatEther(cost - balance)} ETH`);
        continue;
      }
      sims.push({ wallet: w, gasLimit });
      totalCost += cost;
    } catch (err) {
      log(`❌ ${w.address} SIM FAIL: ${err.message}`);
    }
  }

  if (sims.length === 0) {
    log('Tidak ada wallet yang siap. Stop.');
    return;
  }

  log('===== RINGKASAN =====');
  log(`  Wallet siap : ${sims.length}/${wallets.length}`);
  log(`  Mint price  : ${ethers.formatEther(mintPrice)} ETH × ${QUANTITY} = ${ethers.formatEther(value)} ETH per wallet`);
  log(`  MAX cost    : ${ethers.formatEther(totalCost)} ETH (semua wallet)`);
  log(`  Per wallet  : ~${ethers.formatEther((totalCost / BigInt(sims.length)) * 12n / 10n)} ETH (sudah +20% buffer)`);

  if (doSimulateOnly && !doSchedule) return;

  let targetMs = null;
  if (doSchedule) {
    if (atOverride) {
      targetMs = parseDateMs(atOverride);
    } else if (envOr('PUBLIC_AT')) {
      targetMs = parseDateMs(envOr('PUBLIC_AT'));
    } else {
      targetMs = startTime * 1000;
      log(`Pakai startTime on-chain: ${new Date(targetMs).toISOString()}`);
    }
    const fireAt = targetMs - LEAD_MS;
    const wait = fireAt - Date.now();
    log(`Target = ${new Date(targetMs).toISOString()} | fire ${new Date(fireAt).toISOString()} | wait ${wait}ms`);
    if (wait > 0) await sleep(wait);
  }

  const chainId = (await publicProvider.getNetwork()).chainId;
  const liveGas = await getDynamicGas(publicProvider, BUMP_PCT, BUFFER_PCT, MIN_PRIORITY, CEILING);
  log(`Gas live: maxFee=${ethers.formatUnits(liveGas.maxFee, 'gwei')} gwei | priority=${ethers.formatUnits(liveGas.maxPriority, 'gwei')} gwei`);
  log(`Broadcast paralel ke ${PRIVATE_RPC_URL} (chainId=${chainId})`);

  const tasks = sims.map(async ({ wallet, gasLimit }) => {
    const signer = wallet.connect(privateProvider);
    const nonce = await publicProvider.getTransactionCount(wallet.address, 'pending');
    const tx = {
      to: SEADROP, data, value, gasLimit,
      maxFeePerGas: liveGas.maxFee,
      maxPriorityFeePerGas: liveGas.maxPriority,
      nonce, type: 2, chainId,
    };
    try {
      const sent = await signer.sendTransaction(tx);
      log(`🚀 ${wallet.address} sent: ${sent.hash}`);
      const rcpt = await sent.wait(1);
      log(`🎉 ${wallet.address} mined block=${rcpt.blockNumber} status=${rcpt.status} gasUsed=${rcpt.gasUsed}`);
      return { wallet: wallet.address, hash: sent.hash, status: rcpt.status };
    } catch (err) {
      log(`💥 ${wallet.address} error: ${err.shortMessage || err.message}`);
      return { wallet: wallet.address, error: err.shortMessage || err.message };
    }
  });

  const results = await Promise.all(tasks);
  log('Selesai.');
  for (const r of results) {
    if (r.hash) console.log(`  ${r.wallet} -> https://etherscan.io/tx/${r.hash}`);
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let choice;
  try {
    choice = await showMenu(rl);
  } catch (e) {
    rl.close();
    throw e;
  }

  switch (choice) {
    case '1':
      rl.close();
      console.log('\n>>> Mode: Simulasi sekarang\n');
      await run({ doSimulateOnly: true, doSchedule: false });
      break;
    case '2':
      rl.close();
      console.log('\n>>> Mode: Schedule mint (auto pakai startTime on-chain)\n');
      await run({ doSimulateOnly: false, doSchedule: true });
      break;
    case '3': {
      console.log('');
      const at = await prompt('Jam target (contoh "2026-05-23T00:00:00+07:00"): ', rl);
      rl.close();
      if (!at) { console.log('Dibatalkan.'); return; }
      console.log(`\n>>> Mode: Schedule mint @ ${at}\n`);
      await run({ doSimulateOnly: false, doSchedule: true, atOverride: at });
      break;
    }
    case '4':
      rl.close();
      console.log('\n>>> Mode: Mint langsung sekarang\n');
      await run({ doSimulateOnly: false, doSchedule: false });
      break;
    case '0':
    case '':
      rl.close();
      console.log('Bye.');
      break;
    default:
      rl.close();
      console.log('Pilihan tidak valid.');
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
