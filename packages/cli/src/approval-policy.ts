import type { Lang } from '@shenlan/core';

export function approvalLanguage(input: string, fallback: Lang = 'en'): Lang {
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(input)) return 'zh-CN';
  if (/^(?:npm|npx|git|node|python|python3|cargo|go)\s+[\w./:-]+(?:\s+[\w./:-]+)*$/i.test(input.trim())) return fallback;
  if (/[a-z]/i.test(input) && !/^(?:[\w./:-]+\s*)+$/u.test(input.trim())) return 'en';
  if (/^[a-z][a-z -]*[.!?]?$/i.test(input.trim())) return 'en';
  return fallback;
}

export interface CommandGrant {
  key: string;
  label: string;
  family: boolean;
}

/** A family grant is only offered for a small set of stable command forms. */
export function commandGrant(command: string): CommandGrant {
  const exact = command.trim();
  const stable = /^(?:git (?:status|diff|log)(?: (?:--short|--stat|--oneline|--name-only|--name-status|--porcelain(?:=v1)?))*|npm test|npm run [a-z0-9:_-]+)$/i;
  if (stable.test(exact)) {
    const base = /^(git (?:status|diff|log)|npm test|npm run [a-z0-9:_-]+)/i.exec(exact)![1]!;
    return { key: base.toLowerCase(), label: base, family: true };
  }
  return { key: exact, label: exact, family: false };
}

export function commandMatchesGrant(command: string, grant: CommandGrant): boolean {
  const current = commandGrant(command);
  return grant.family ? current.family && current.key === grant.key : current.key === grant.key;
}
