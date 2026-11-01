import { expect, it, vi } from 'vitest';

it('stops once and cannot stop again from a stale timer after SIGCONT', async () => {
  const previousTstp = new Set(process.listeners('SIGTSTP'));
  const previousCont = new Set(process.listeners('SIGCONT'));
  const globals = globalThis as typeof globalThis & { __shenlanDispatch?: (action: unknown) => void };
  const previousDispatch = globals.__shenlanDispatch;
  const dispatch = vi.fn();
  globals.__shenlanDispatch = dispatch;
  vi.useFakeTimers();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const { installSuspendHandlers } = await import('../signals.js');
    installSuspendHandlers();
    process.emit('SIGTSTP');
    expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGSTOP');
    process.emit('SIGCONT');
    vi.runAllTimers();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'ADD_SYSTEM_MSG' }));
  } finally {
    for (const listener of process.listeners('SIGTSTP')) if (!previousTstp.has(listener)) process.removeListener('SIGTSTP', listener);
    for (const listener of process.listeners('SIGCONT')) if (!previousCont.has(listener)) process.removeListener('SIGCONT', listener);
    globals.__shenlanDispatch = previousDispatch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
