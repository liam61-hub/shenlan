import { describe, it, expect, beforeEach } from 'vitest';
import { storeRef, retrieveRef, listRefs, cleanupRefs } from '../ref-store.js';

describe('ref-store', () => {
  beforeEach(() => {
    cleanupRefs();
  });

  it('stores and retrieves ref', () => {
    const { refId, summary } = storeRef('hello world', 'test summary');
    expect(refId).toBeTruthy();
    expect(summary).toContain('test summary');
    const content = retrieveRef(refId);
    expect(content).toBe('hello world');
  });

  it('listRefs returns stored refs', () => {
    storeRef('content 1', 'summary 1');
    storeRef('content 2', 'summary 2');
    const refs = listRefs();
    expect(refs.length).toBe(2);
  });

  it('retrieveRef returns null for unknown id', () => {
    const content = retrieveRef('nonexistent');
    expect(content).toBeNull();
  });

  it('cleanupRefs removes all', () => {
    storeRef('content', 'summary');
    const count = cleanupRefs();
    expect(count).toBe(1);
    expect(listRefs().length).toBe(0);
  });

  it('handles empty content', () => {
    const { refId } = storeRef('', 'empty');
    expect(retrieveRef(refId)).toBe('');
  });
});
