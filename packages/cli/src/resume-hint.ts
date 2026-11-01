import chalk from 'chalk';

/** Format the command shown after exit so it stands out from surrounding status text. */
export function formatResumeCommand(sessionId: string): string {
  return chalk.cyan.bold(`shenlan --resume ${sessionId}`);
}
