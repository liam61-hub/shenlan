import type { JsonSchema } from './index.js';

export interface ArgumentValidationResult {
  valid: boolean;
  error?: string;
}

/** Validate parsed tool arguments against the JSON schema subset used by core tools. */
export function validateToolArguments(schema: JsonSchema, value: unknown): ArgumentValidationResult {
  return validateValue(schema, value, 'arguments');
}

function validateValue(schema: JsonSchema, value: unknown, path: string): ArgumentValidationResult {
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    return invalid(path, 'value is outside the allowed set');
  }

  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return invalid(path, 'expected an object');
      }
      const objectValue = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(objectValue, key)) return invalid(`${path}.${key}`, 'required property is missing');
      }
      for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        if (!Object.hasOwn(objectValue, key)) continue;
        const result = validateValue(propertySchema, objectValue[key], `${path}.${key}`);
        if (!result.valid) return result;
      }
      return { valid: true };
    }
    case 'array': {
      if (!Array.isArray(value)) return invalid(path, 'expected an array');
      if (!schema.items) return { valid: true };
      for (let index = 0; index < value.length; index++) {
        const result = validateValue(schema.items, value[index], `${path}[${index}]`);
        if (!result.valid) return result;
      }
      return { valid: true };
    }
    case 'string':
      return typeof value === 'string' ? { valid: true } : invalid(path, 'expected a string');
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { valid: true }
        : invalid(path, 'expected a finite number');
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? { valid: true }
        : invalid(path, 'expected an integer');
    case 'boolean':
      return typeof value === 'boolean' ? { valid: true } : invalid(path, 'expected a boolean');
    default:
      return invalid(path, `unsupported schema type "${schema.type}"`);
  }
}

function invalid(path: string, reason: string): ArgumentValidationResult {
  return { valid: false, error: `Invalid tool arguments at ${path}: ${reason}` };
}
