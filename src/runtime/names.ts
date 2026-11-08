/**
 * The one name rule.
 *
 * A name is three things at once: a document key, part of a submission request
 * id, and an attribute value inside a rendered tag. The charset keeps those
 * three uses honest without escaping games, so it is the same rule for a
 * background call title, a subagent name, a vmodel key, and a role name.
 *
 * A single copy lives here because two copies of a validation rule drift, and
 * the drift is invisible until a name that one of them accepts reaches storage.
 */
export const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeName(value: string): boolean {
  return SAFE_NAME_PATTERN.test(value);
}

/** What a rejected name should be told: the rule, in one line. */
export const SAFE_NAME_RULE =
  "1 to 64 characters of letters, digits, dot, dash or underscore, starting with a letter or digit";
