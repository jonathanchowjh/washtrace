import { RULES, type Configure, type Rules } from '@washtrace/detect';

/**
 * The body of a change to a collection's settings: what to store, or the
 * sentence that says what is wrong with it, which the route answers as a 400.
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

/** The rules a collection's analysis runs under. */
export function effectiveRules(overrides: Partial<Rules>): Rules {
  return { ...RULES, ...overrides };
}
