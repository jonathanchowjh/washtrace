// Plays out a small NFT market on a local chain, with wash trading of each
// kind the paper describes hidden in honest trading, then asks washtrace to
// watch it. Run by `docker compose -f docker-compose.yml -f docker-compose.demo.yml up`.
//
// Every scenario names what washtrace should conclude, so the demo doubles
// as a check of the whole path: ingest, receipts, Seaport pricing, funding
// through an Etherscan-shaped API, and the three methods.
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseEther, toHex } from 'viem';
import { foundry } from 'viem/chains';
import { readFileSync } from 'node:fs';

const RPC = process.env.RPC ?? 'http://localhost:8545';
const API = process.env.API ?? 'http://localhost:8080';
const SEAPORT_16 = '0x0000000000000068F116a894984e2DB1123eB395';
const BLEND = '0x29469395eAf6f95920E59F858042f0e28D98a20B';
const ZERO = '0x0000000000000000000000000000000000000000';

const contracts = JSON.parse(readFileSync(new URL('./contracts.json', import.meta.url), 'utf8'));
const pub = createPublicClient({ chain: foundry, transport: http(RPC), cacheTime: 0 });
const wallet = createWalletClient({ chain: foundry, transport: http(RPC) });

/** A wallet per name, so a run reads the same every time. anvil --auto-impersonate lets any of them send. */
const w = (name) => `0x${keccak256(toHex(name)).slice(-40)}`;

async function send(from, to, data, value = 0n) {
  const hash = await wallet.sendTransaction({ account: from, to, data, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${hash}`);
}

await waitFor(() => pub.getBlockNumber(), 'the chain');
const deployer = w('deployer');
const everyone = new Set();
const rich = async (a) => {
  if (everyone.has(a)) return;
  everyone.add(a);
  // Balance by fiat, not by transfer: a transfer would be a money edge the scenario did not ask for.
  await pub.request({ method: 'anvil_setBalance', params: [a, toHex(parseEther('1000'))] });
};
await rich(deployer);

const deployed = await wallet.deployContract({ account: deployer, abi: contracts.DemoNFT.abi, bytecode: contracts.DemoNFT.bytecode });
const nft = (await pub.waitForTransactionReceipt({ hash: deployed })).contractAddress;
await pub.request({ method: 'anvil_setCode', params: [SEAPORT_16, contracts.DemoSeaport.runtime] });
console.log(`[seed] Demo Apes at ${nft}; Seaport 1.6 stand-in at ${SEAPORT_16}`);

const move = (from, to, id) => send(deployer, nft, encodeFunctionData({ abi: contracts.DemoNFT.abi, functionName: 'move', args: [from, to, BigInt(id)] }));
const mint = (id, to) => move(ZERO, to, id);
const give = async (id, from, to) => { await rich(from); await move(from, to, id); };
const sell = async (id, seller, buyer, eth) => {
  await rich(seller); await rich(buyer);
  await send(buyer, SEAPORT_16, encodeFunctionData({ abi: contracts.DemoSeaport.abi, functionName: 'sale', args: [nft, seller, BigInt(id)] }), parseEther(eth));
};
const pay = async (from, to, eth) => { await rich(from); await send(from, to, '0x', parseEther(eth)); };

// Honest trading: forty collectors, each funded by one exchange's hot wallet.
// The exchange touches every buyer, so it is a hub and joins none of them.
const exchange = w('exchange-hot-wallet');
for (let i = 1; i <= 40; i++) await mint(i, w(`collector-${i}`));
for (let i = 1; i <= 30; i++) {
  await pay(exchange, w(`buyer-${i}`), '3');
  await sell(i, w(`collector-${i}`), w(`buyer-${i}`), (0.4 + i / 50).toFixed(2));
}
for (let i = 1; i <= 8; i++) await sell(i, w(`buyer-${i}`), w(`buyer-${i + 10}`), '0.9');

// SCC A: two wallets passing a token back and forth (three cycles), and a
// three-wallet ring traded around twice.
await mint(101, w('ring-a'));
await sell(101, w('ring-a'), w('ring-b'), '5');
await sell(101, w('ring-b'), w('ring-a'), '5.5');
await sell(101, w('ring-a'), w('ring-b'), '6');
await sell(101, w('ring-b'), w('ring-a'), '6.5');
await mint(102, w('trio-1'));
for (const [s, b] of [[1, 2], [2, 3], [3, 1], [1, 2], [2, 3], [3, 1]]) await sell(102, w(`trio-${s}`), w(`trio-${b}`), '2');

// Figure 8, cycle 1 (AU and AC): the buyer pays the seller back.
await mint(111, w('f8-1-seller'));
await sell(111, w('f8-1-seller'), w('f8-1-buyer'), '8');
await pay(w('f8-1-buyer'), w('f8-1-seller'), '8');

// Cycle 2 (AU and AC): the payment back goes through a third wallet.
await mint(112, w('f8-2-seller'));
await sell(112, w('f8-2-seller'), w('f8-2-buyer'), '7');
await pay(w('f8-2-buyer'), w('f8-2-mule'), '7');
await pay(w('f8-2-mule'), w('f8-2-seller'), '6.9');

// Money back through four wallets, past AC's two hops. AU would find it with
// the middles' history, but washtrace reads the money of the collection's own
// wallets only, as the paper's dataset 3 did: buyer → hop 1 and hop 3 →
// seller are read, hop 1 → hop 2 → hop 3 is not. So nothing flags it. This
// is the scope limit that keeps AU's thirty hops mostly inside the collection.
await mint(113, w('chain-seller'));
await sell(113, w('chain-seller'), w('chain-buyer'), '4');
await pay(w('chain-buyer'), w('chain-hop-1'), '4');
await pay(w('chain-hop-1'), w('chain-hop-2'), '4');
await pay(w('chain-hop-2'), w('chain-hop-3'), '4');
await pay(w('chain-hop-3'), w('chain-seller'), '3.9');

// Cycle 4 (AC only): one funder set up both sides. Dune's filter 4.
await mint(114, w('f8-4-seller'));
await pay(w('f8-4-funder'), w('f8-4-seller'), '1');
await pay(w('f8-4-funder'), w('f8-4-buyer'), '10');
await sell(114, w('f8-4-seller'), w('f8-4-buyer'), '9');

// Cycle 6 (AC only): both sides pay out to the same wallet.
await mint(116, w('f8-6-seller'));
await sell(116, w('f8-6-seller'), w('f8-6-buyer'), '3');
await pay(w('f8-6-seller'), w('f8-6-sink'), '2.9');
await pay(w('f8-6-buyer'), w('f8-6-sink'), '0.5');

// Not wash trading: two loans through Blend, A → Blend → A, then a sale.
// The 2023 method reads the loans as a back-and-forth trade.
await mint(120, w('borrower'));
for (let i = 0; i < 2; i++) { await give(120, w('borrower'), BLEND); await give(120, BLEND, w('borrower')); }
await sell(120, w('borrower'), w('blend-buyer'), '2');

// Not wash trading: one sale and one buy-back is one cycle; it takes two.
await mint(130, w('regretful'));
await sell(130, w('regretful'), w('second-owner'), '1');
await sell(130, w('second-owner'), w('regretful'), '1.2');

// Finality: anvil finalizes 64 blocks behind its head, and washtrace reads finalized blocks only.
await pub.request({ method: 'anvil_mine', params: [toHex(100)] });
console.log(`[seed] ${await pub.getBlockNumber()} blocks; asking washtrace to watch the collection`);

const auth = process.env.WASHTRACE_USERNAME ? { authorization: `Basic ${btoa(`${process.env.WASHTRACE_USERNAME}:${process.env.WASHTRACE_PASSWORD}`)}` } : {};
await waitFor(async () => { const r = await fetch(`${API}/api/health`); if (!r.ok) throw new Error(String(r.status)); }, 'washtrace');
const res = await fetch(`${API}/api/collections`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ chainId: 31337, address: nft, name: 'Demo Apes' }),
});
console.log(`[seed] POST /api/collections: ${res.status} ${await res.text()}`);
console.log(`[seed] Expect flagged: #101 #102 by every method; #111 #112 by AU and AC; #114 #116 by AC only.`);
console.log(`[seed] Expect clean: #1–#40 (one exchange funds every buyer), #120 (loans through Blend), #130 (one buy-back), and #113, whose money path runs outside the collection.`);

async function waitFor(probe, what) {
  for (let i = 0; ; i++) {
    try { return await probe(); } catch (err) {
      if (i === 60) throw new Error(`${what} did not come up: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}
