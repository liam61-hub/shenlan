import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { formatResumeCommand } from '../resume-hint.js';

describe('formatResumeCommand', () => {
  it('highlights the complete resume command in cyan bold', () => {
    const previousLevel = chalk.level;
    chalk.level = 1;
    try {
      expect(formatResumeCommand('12345678-abcd-1234-abcd-123456789012')).toBe(
        '\x1b[36m\x1b[1mshenlan --resume 12345678-abcd-1234-abcd-123456789012\x1b[22m\x1b[39m',
      );
    } finally {
      chalk.level = previousLevel;
    }
  });
});
