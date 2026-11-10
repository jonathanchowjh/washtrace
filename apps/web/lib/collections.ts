import { RULES, type Configure, type Rules } from '@washtrace/detect';

/**
 * A collection's rules: the body of a change to them, the sentence that says
 * what is wrong with one, and how a reader is told which differ from the
 * defaults. Here, not in format.ts: the values come from the detect package,
 * which the client components that import format.ts must not pull in.
 */

const RULE_NAMES = Object.keys(RULES) as (keyof Rules)[];

/** A key left out is left alone; a rule set to null goes back to its default. */
export function configChange(body: Record<string, unknown>): Configure | string {
  const unknown = Object.keys(body).find((k) => k !== 'name' && k !== 'rules' && k !== 'priority');
  if (unknown) return `Unknown field '${unknown}'. Send name, rules, priority, or any of them.`;
  const change: Configure = {};
  if ('name' in body) {
    if (body.name !== null && typeof body.name !== 'string') return 'name must be a string, or null to clear it.';
    change.name = body.name;
  }
  if ('priority' in body) {
    if (typeof body.priority !== 'boolean') return 'priority must be true or false.';
    change.priority = body.priority;
  }
  if ('rules' in body) {
    const rules = body.rules;
    if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) return `rules must be an object of ${RULE_NAMES.join(', ')}.`;
    for (const [k, v] of Object.entries(rules)) {
      if (!RULE_NAMES.includes(k as keyof Rules)) return `Unknown rule '${k}'. Rules: ${RULE_NAMES.join(', ')}.`;
      if (v !== null && (!Number.isSafeInteger(v) || (v as number) <= 0)) return `${k} must be a positive whole number, or null for the default (${RULES[k as keyof Rules]}).`;
    }
    change.rules = rules as Configure['rules'];
  }
  return change;
}

/** Each rule as a reader names it, from what the rule's doc in detect's methods.ts says it limits. */
export const RULE_LABELS: Record<keyof Rules, string> = {
  minCycles: 'times round a pattern needs',
  reachDepth: 'longest money path followed',
  hubDegree: 'most wallets one wallet may link before it counts as an exchange or router',
  visitCap: 'wallets one money search may visit',
};

/** Which of a collection's rules differ from the defaults, said with each default; null when none does. */
export function rulesNote(rules: Partial<Rules>): string | null {
  const changed = RULE_NAMES.filter((k) => rules[k] !== undefined && rules[k] !== RULES[k]);
  if (changed.length === 0) return null;
  const list = changed.map((k) => `${RULE_LABELS[k]} ${rules[k]} (default ${RULES[k]})`).join(', ');
  return `Rules changed for this collection: ${list}. Analyses from the change on run under them, so their numbers are not the built-in lenses' numbers.`;
}

/** The rules a collection's analysis runs under. */
export function effectiveRules(overrides: Partial<Rules>): Rules {
  return { ...RULES, ...overrides };
}
