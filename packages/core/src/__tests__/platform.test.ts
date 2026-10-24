import { describe, it, expect } from 'vitest';
import { configDir, dataDir, platformId } from '../platform.js';

describe('platform', () => {
  it('configDir returns a path ending with shenlan', () => {
    expect(configDir()).toMatch(/shenlan/);
  });

  it('dataDir returns a path ending with shenlan', () => {
    expect(dataDir()).toMatch(/shenlan/);
  });

  it('platformId returns current platform', () => {
    expect(['win32', 'darwin', 'linux']).toContain(platformId());
  });

  it('configDir and dataDir are different paths', () => {
    expect(configDir()).not.toBe(dataDir());
  });
});
