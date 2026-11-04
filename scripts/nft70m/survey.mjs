// Runs Round trips (SCC A) over every collection in the NFT-70M sales extract
// and writes survey.csv and summary.md beside it.
// Needs the extract from extract.py and a built detect package:
//   npm run --workspace @washtrace/detect build && node scripts/nft70m/survey.mjs
// Data lives in $NFT70M_DIR (default ~/washtrace-data/nft70m), never in the repo.
import { analyze } from '@washtrace/detect';
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { byCollection, markdown, summarize, surveyInput, surveyRow } from './rows.mjs';

const DIR = process.env.NFT70M_DIR ?? join(homedir(), 'washtrace-data', 'nft70m');

async function main() {
  const lines = createInterface({ input: createReadStream(join(DIR, 'sales.csv.gz')).pipe(createGunzip()), crlfDelay: Infinity });
  const out = createWriteStream(join(DIR, 'survey.csv'));
  const rows = [];
  let ties = 0;
  let skipped = 0;
  let peak = 0;

  for await (const g of byCollection(lines)) {
    const t0 = performance.now();
    let analysis;
    try {
      analysis = analyze(surveyInput(g.transfers));
    } catch (e) {
      throw new Error(`analyze failed for contract ${g.contract}: ${e.message}`, { cause: e });
    }
    const row = surveyRow(g.contract, g.transfers, analysis, performance.now() - t0);
    if (!rows.length) out.write(`${Object.keys(row).join(',')}\n`);
    out.write(`${Object.values(row).join(',')}\n`);
    rows.push(row);
    ties += g.ties;
    skipped += g.skipped;
    peak = Math.max(peak, process.memoryUsage().rss);
    if (rows.length % 1000 === 0) console.error(`${rows.length} collections, peak ${Math.round(peak / 1e6)} MB`);
  }
  await new Promise((done) => out.end(done));

  const text = markdown({ ...summarize(rows), ties }, peak / 1e6);
  writeFileSync(join(DIR, 'summary.md'), text);
  console.log(text);
  if (skipped) console.error(`skipped ${skipped} rows with no token, seller, buyer or time`);
}

main().catch((e) => { console.error(e); process.exit(1); });
