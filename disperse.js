import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import { ethers } from 'ethers';

const DISPERSE = '0xD152f549545093347A162Dce210e7293f1452150';
const DISPERSE_ABI = [
  'function disperseEther(address[] recipients, uint256[] values) payable',
];

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const gwei = (n) => ethers.parseUnits(String(n), 'gwei');
const envOr = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

function loadAddresses(file) {
  if (!fs.existsSync(file)) throw new Error(`File ${file} gak ketemu`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      out.push(ethers.getAddress(line));
    } catch {
      throw new Error(`Address tidak valid: ${line}`);
    }
  }
  if (out.length === 0) throw new Error('address.txt kosong');
  return out;
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

async function main() {
  const RPC = envOr('PUBLIC_RPC_URL');
  const SENDER_KEY = envOr('SENDER_KEY') || envOr('FUNDER_KEY');
  if (!SENDER_KEY) {
    throw new Error('SENDER_KEY belum di-set di .env (private key wallet pengirim)');
  }
  const FILE = envOr('ADDRESS_FILE', './address.txt');
  const BUMP_PCT = BigInt(envOr('GAS_BUMP_PERCENT', '50'));
  const BUFFER_PCT = BigInt(envOr('GAS_BUFFER_PERCENT', '20'));
  const MIN_PRIORITY = gwei(envOr('MIN_PRIORITY_GWEI', '1'));
  const CEILING = gwei(envOr('MAX_GAS_CEILING_GWEI', '50'));

  const provider = new ethers.JsonRpcProvider(RPC);
  const signer = new ethers.Wallet(SENDER_KEY.startsWith('0x') ? SENDER_KEY : '0x' + SENDER_KEY, provider);

  const recipients = loadAddresses(FILE);
  const balance = await provider.getBalance(signer.address);

  log(`Sender   : ${signer.address}`);
  log(`Balance  : ${ethers.formatEther(balance)} ETH`);
  log(`Recipient: ${recipients.length} address dari ${FILE}`);

  const amountStr = await prompt('Mau kirim berapa ETH per wallet? (contoh 0.001): ');
  const amount = ethers.parseEther(amountStr);
  if (amount <= 0n) throw new Error('Amount harus > 0');

  const totalValue = amount * BigInt(recipients.length);

  const iface = new ethers.Interface(DISPERSE_ABI);
  const values = recipients.map(() => amount);
  const data = iface.encodeFunctionData('disperseEther', [recipients, values]);

  const gas = await getDynamicGas(provider, BUMP_PCT, BUFFER_PCT, MIN_PRIORITY, CEILING);
  let gasLimit;
  try {
    const est = await provider.estimateGas({
      from: signer.address, to: DISPERSE, data, value: totalValue,
    });
    gasLimit = (est * 130n) / 100n;
  } catch (e) {
    gasLimit = 21000n + 35000n * BigInt(recipients.length);
    log(`estimateGas gagal (${e.shortMessage || e.message}), pakai fallback ${gasLimit}`);
  }

  const maxGasCost = gasLimit * gas.maxFee;
  const grandTotal = totalValue + maxGasCost;

  log('===== KONFIRMASI =====');
  log(`  Per wallet      : ${ethers.formatEther(amount)} ETH`);
  log(`  Recipients      : ${recipients.length}`);
  log(`  Total transfer  : ${ethers.formatEther(totalValue)} ETH`);
  log(`  maxFee          : ${ethers.formatUnits(gas.maxFee, 'gwei')} gwei`);
  log(`  maxPriority     : ${ethers.formatUnits(gas.maxPriority, 'gwei')} gwei`);
  log(`  gasLimit        : ${gasLimit}`);
  log(`  Max biaya gas   : ${ethers.formatEther(maxGasCost)} ETH`);
  log(`  GRAND TOTAL     : ${ethers.formatEther(grandTotal)} ETH`);
  log(`  Saldo sender    : ${ethers.formatEther(balance)} ETH`);

  if (balance < grandTotal) {
    throw new Error(`Saldo gak cukup. Butuh ${ethers.formatEther(grandTotal)} ETH, ada ${ethers.formatEther(balance)} ETH`);
  }

  const ok = await prompt('Lanjut kirim? (y/N): ');
  if (ok.toLowerCase() !== 'y' && ok.toLowerCase() !== 'yes') {
    log('Dibatalkan.');
    return;
  }

  const chainId = (await provider.getNetwork()).chainId;
  const nonce = await provider.getTransactionCount(signer.address, 'pending');

  const tx = {
    to: DISPERSE,
    data,
    value: totalValue,
    gasLimit,
    maxFeePerGas: gas.maxFee,
    maxPriorityFeePerGas: gas.maxPriority,
    nonce,
    type: 2,
    chainId,
  };

  log('Broadcasting...');
  const sent = await signer.sendTransaction(tx);
  log(`🚀 sent: ${sent.hash}`);
  log(`   https://etherscan.io/tx/${sent.hash}`);
  const rcpt = await sent.wait(1);
  log(`🎉 mined block=${rcpt.blockNumber} status=${rcpt.status} gasUsed=${rcpt.gasUsed}`);
  if (rcpt.status === 1) {
    const realGasCost = rcpt.gasUsed * (rcpt.gasPrice || gas.maxFee);
    log(`   Biaya gas real: ${ethers.formatEther(realGasCost)} ETH`);
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
