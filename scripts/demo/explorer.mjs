// A stand-in for Etherscan's account API over a local chain, for the demo
// only. It answers `txlist` from the chain's own blocks: every transaction
// that moved native value, in or out of the address. Internal and token
// transfers are answered empty, which Etherscan does for a wallet with none.
//
//   RPC=http://localhost:8545 PORT=8081 node scripts/demo/explorer.mjs
import { createServer } from 'node:http';

const RPC = process.env.RPC ?? 'http://localhost:8545';
const PORT = Number(process.env.PORT ?? 8081);

/** Every value-moving transaction read so far, and the next block to read. */
const seen = [];
let next = 0;

async function rpc(method, params) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function catchUp() {
  const head = Number(await rpc('eth_blockNumber', []));
  for (; next <= head; next++) {
    const block = await rpc('eth_getBlockByNumber', [`0x${next.toString(16)}`, true]);
    for (const tx of block.transactions) {
      if (BigInt(tx.value) === 0n || tx.to === null) continue;
      const receipt = await rpc('eth_getTransactionReceipt', [tx.hash]);
      seen.push({
        hash: tx.hash, from: tx.from, to: tx.to, value: BigInt(tx.value).toString(),
        blockNumber: String(Number(block.number)), timeStamp: String(Number(block.timestamp)),
        isError: receipt.status === '0x1' ? '0' : '1',
      });
    }
  }
}

let reading = Promise.resolve();

createServer(async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    reading = reading.then(catchUp, catchUp);
    await reading;
    const address = (q.get('address') ?? '').toLowerCase();
    const rows = q.get('action') === 'txlist'
      ? seen.filter((t) => t.from.toLowerCase() === address || t.to.toLowerCase() === address)
      : [];
    const page = Number(q.get('page') ?? 1);
    const offset = Number(q.get('offset') ?? 1000);
    const slice = rows.slice((page - 1) * offset, page * offset);
    send(slice.length === 0 ? { status: '0', message: 'No transactions found', result: [] } : { status: '1', message: 'OK', result: slice });
  } catch (err) {
    send({ status: '0', message: 'NOTOK', result: String(err.message ?? err) });
  }
}).listen(PORT, () => console.log(`[explorer] answering txlist from ${RPC} on :${PORT}`));
