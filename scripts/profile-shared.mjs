// What the profile scripts share. The defaults are the worker's: follow.hops
// 3 and tokens.payees off (env.ts), which the requests and Store.analysisInput now take.
import { readFileSync } from 'node:fs';
import { COPIES, DEFAULT_RULE, checkRule } from '../packages/detect/dist/lens-rule.js';

export const FOLLOW_HOPS = 3;
export const PAYEES = false;

export function ruleFor(arg) {
  if (arg === 'default') return DEFAULT_RULE;
  if (COPIES[arg]) return COPIES[arg].rule;
  const checked = checkRule(JSON.parse(readFileSync(arg, 'utf8')));
  if ('error' in checked) throw new Error(`${arg}: ${checked.error}`);
  return checked.rule;
}

export function readOnly(raw) {
  const url = new URL(raw);
  const options = url.searchParams.get('options');
  url.searchParams.set('options', `${options ? `${options} ` : ''}-c default_transaction_read_only=on`);
  return url.toString();
}
