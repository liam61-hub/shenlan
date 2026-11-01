import { describe, expect, it } from 'vitest';
import { continuesToolGroup } from '../tool-group.js';

describe('consecutive tool groups', () => {
  it('keeps different read targets in one group', () => {
    const files = ['proxy_resilience.rs', 'integration.rs', 'body_limit.rs', 'metrics.rs'];
    for (let i = 1; i < files.length; i++) {
      expect(continuesToolGroup({ name: 'read', detail: files[i - 1]! }, 'read', files[i]!)).toBe(true);
    }
  });
  it('ends a read group when the tool changes and preserves other argument boundaries', () => {
    expect(continuesToolGroup({ name: 'read', detail: 'a' }, 'glob', 'a')).toBe(false);
    expect(continuesToolGroup({ name: 'search', detail: 'a' }, 'search', 'b')).toBe(false);
    expect(continuesToolGroup({ name: 'search', detail: 'a' }, 'search', ' a ')).toBe(true);
  });
});
