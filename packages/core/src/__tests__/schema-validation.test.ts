import { describe, expect, it } from 'vitest';
import { validateToolArguments } from '../tools/schema-validation.js';

describe('validateToolArguments', () => {
  const schema = {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'integer' },
      options: {
        type: 'array',
        items: { type: 'string', enum: ['fast', 'safe'] },
      },
    },
    required: ['command'],
  };

  it('accepts valid nested tool arguments', () => {
    expect(validateToolArguments(schema, {
      command: 'git status', timeout: 10, options: ['fast', 'safe'],
    })).toEqual({ valid: true });
  });

  it('rejects non-object arguments and missing required properties', () => {
    expect(validateToolArguments(schema, [])).toMatchObject({ valid: false, error: expect.stringContaining('expected an object') });
    expect(validateToolArguments(schema, { timeout: 10 })).toMatchObject({ valid: false, error: expect.stringContaining('required property is missing') });
  });

  it('rejects invalid nested types and enum values without echoing argument values', () => {
    const wrongType = validateToolArguments(schema, { command: 42 });
    expect(wrongType).toMatchObject({ valid: false, error: expect.stringContaining('arguments.command') });
    expect(wrongType.error).not.toContain('42');

    expect(validateToolArguments(schema, { command: 'x', options: ['unsafe'] }))
      .toMatchObject({ valid: false, error: expect.stringContaining('allowed set') });
  });

  it('fails closed on schema types outside the supported subset', () => {
    expect(validateToolArguments({ type: 'nullable-string' }, 'value'))
      .toMatchObject({ valid: false, error: expect.stringContaining('unsupported schema type') });
  });
});
