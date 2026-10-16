import { AppError } from '../../shared/errors.ts';
import type { AttributeDependency, AttributeField, AttributeType } from './models.ts';

const FIELD_KEY = /^[a-z][a-z0-9_]{1,39}$/;
const OPTION_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const DEPENDABLE_TYPES: AttributeType[] = ['select', 'multiselect', 'boolean'];

/**
 * Validate a schema *definition* (what the admin editor submitted).
 *
 * Everything here is structural: field keys, per-type option/constraint rules, dependency
 * targets and dependency cycles. It never evaluates any submitted expression, because the
 * format has no expressions to evaluate.
 */
export function validateSchemaDefinition(fields: AttributeField[]): AttributeField[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'A schema needs at least one field', {
      fieldErrors: { fields: 'required' },
    });
  }
  if (fields.length > 60) {
    throw new AppError('VALIDATION_ERROR', 'A schema is limited to 60 fields', {
      fieldErrors: { fields: 'too many fields' },
    });
  }

  const byKey = new Map<string, AttributeField>();
  for (const field of fields) {
    if (!FIELD_KEY.test(field.key)) {
      throw new AppError('VALIDATION_ERROR', `Invalid field key "${field.key}"`, {
        fieldErrors: { [`fields.${field.key}`]: 'lowercase snake_case, 2-40 characters' },
      });
    }
    if (byKey.has(field.key)) {
      throw new AppError('VALIDATION_ERROR', `Duplicate field key "${field.key}"`, {
        fieldErrors: { [`fields.${field.key}`]: 'duplicate key' },
      });
    }
    if (!field.labelEn || field.labelEn.trim().length < 2) {
      throw new AppError('VALIDATION_ERROR', `Field "${field.key}" needs an English label`, {
        fieldErrors: { [`fields.${field.key}`]: 'label required' },
      });
    }
    byKey.set(field.key, field);
  }

  for (const field of fields) {
    const usesOptions = field.type === 'select' || field.type === 'multiselect';
    if (usesOptions) {
      if (field.options.length === 0) {
        throw new AppError('VALIDATION_ERROR', `Field "${field.key}" needs at least one option`, {
          fieldErrors: { [`fields.${field.key}`]: 'options required' },
        });
      }
      const seen = new Set<string>();
      for (const option of field.options) {
        if (!OPTION_KEY.test(option.key)) {
          throw new AppError('VALIDATION_ERROR', `Invalid option key "${option.key}" in "${field.key}"`, {
            fieldErrors: { [`fields.${field.key}`]: `invalid option key ${option.key}` },
          });
        }
        if (seen.has(option.key)) {
          throw new AppError('VALIDATION_ERROR', `Duplicate option "${option.key}" in "${field.key}"`, {
            fieldErrors: { [`fields.${field.key}`]: `duplicate option ${option.key}` },
          });
        }
        seen.add(option.key);
      }
    } else if (field.options.length > 0) {
      // A text/number field with options is a modelling mistake that would silently do nothing.
      throw new AppError('VALIDATION_ERROR', `Field "${field.key}" cannot have options`, {
        fieldErrors: { [`fields.${field.key}`]: 'options are only valid for select/multiselect' },
      });
    }

    const c = field.constraints;
    if (field.type !== 'number' && (c.min !== null && c.min !== undefined || c.max !== null && c.max !== undefined || c.integer)) {
      throw new AppError('VALIDATION_ERROR', `Field "${field.key}" has numeric constraints it cannot use`, {
        fieldErrors: { [`fields.${field.key}`]: 'min/max/integer are only valid for number fields' },
      });
    }
    if (field.type !== 'text' && (c.minLength !== null && c.minLength !== undefined || c.maxLength || c.pattern)) {
      throw new AppError('VALIDATION_ERROR', `Field "${field.key}" has text constraints it cannot use`, {
        fieldErrors: { [`fields.${field.key}`]: 'minLength/maxLength/pattern are only valid for text fields' },
      });
    }
    if (c.min !== null && c.min !== undefined && c.max !== null && c.max !== undefined && c.min > c.max) {
      throw new AppError('VALIDATION_ERROR', `Field "${field.key}" has min greater than max`, {
        fieldErrors: { [`fields.${field.key}`]: 'min must be <= max' },
      });
    }
    if (c.minLength !== null && c.minLength !== undefined && c.maxLength !== null && c.maxLength !== undefined && c.minLength > c.maxLength) {
      throw new AppError('VALIDATION_ERROR', `Field "${field.key}" has minLength greater than maxLength`, {
        fieldErrors: { [`fields.${field.key}`]: 'minLength must be <= maxLength' },
      });
    }
    if (c.pattern) {
      try {
        new RegExp(c.pattern);
      } catch {
        throw new AppError('VALIDATION_ERROR', `Field "${field.key}" has an invalid pattern`, {
          fieldErrors: { [`fields.${field.key}`]: 'invalid regular expression' },
        });
      }
    }

    const dependency = field.dependsOn;
    if (dependency) {
      if (dependency.field === field.key) {
        throw new AppError('VALIDATION_ERROR', `Field "${field.key}" cannot depend on itself`, {
          fieldErrors: { [`fields.${field.key}`]: 'self dependency' },
        });
      }
      const target = byKey.get(dependency.field);
      if (!target) {
        throw new AppError('VALIDATION_ERROR', `Field "${field.key}" depends on an unknown field`, {
          fieldErrors: { [`fields.${field.key}`]: `unknown dependency ${dependency.field}` },
        });
      }
      if (!DEPENDABLE_TYPES.includes(target.type)) {
        throw new AppError('VALIDATION_ERROR', `Field "${field.key}" depends on a ${target.type} field`, {
          fieldErrors: { [`fields.${field.key}`]: 'dependency must target select, multiselect or boolean' },
        });
      }
      if (target.adminOnly && !field.adminOnly) {
        // A public field can never be gated on something a public form is not allowed to see.
        throw new AppError('VALIDATION_ERROR', `Field "${field.key}" depends on an admin-only field`, {
          fieldErrors: { [`fields.${field.key}`]: 'dependency target is admin-only' },
        });
      }
      const hasEquals = dependency.equals !== undefined && dependency.equals !== null;
      const hasIn = Array.isArray(dependency.in) && dependency.in.length > 0;
      if (!hasEquals && !hasIn) {
        throw new AppError('VALIDATION_ERROR', `Field "${field.key}" needs a dependency condition`, {
          fieldErrors: { [`fields.${field.key}`]: 'provide equals or in' },
        });
      }
      if (target.type === 'boolean' && !hasEquals) {
        throw new AppError('VALIDATION_ERROR', `Field "${field.key}" must use equals against a boolean`, {
          fieldErrors: { [`fields.${field.key}`]: 'boolean dependencies require equals' },
        });
      }
      if (target.type === 'boolean' && typeof dependency.equals !== 'boolean') {
        throw new AppError('VALIDATION_ERROR', `Field "${field.key}" has a non-boolean comparison`, {
          fieldErrors: { [`fields.${field.key}`]: 'equals must be true or false' },
        });
      }
      if (target.type === 'select' || target.type === 'multiselect') {
        const allowed = new Set(target.options.map((o) => o.key));
        const referenced = [...(hasIn ? (dependency.in as Array<string | number>) : []), ...(hasEquals ? [dependency.equals as string | number] : [])];
        for (const value of referenced) {
          if (typeof value !== 'string' || !allowed.has(value)) {
            throw new AppError('VALIDATION_ERROR', `Field "${field.key}" compares against an unknown option`, {
              fieldErrors: { [`fields.${field.key}`]: `unknown option ${String(value)}` },
            });
          }
        }
      }
    }
  }

  // Dependency graph must be acyclic, otherwise a form can never decide what to show.
  const visiting = new Set<string>();
  const settled = new Set<string>();
  const walk = (key: string, path: string[]): void => {
    if (settled.has(key)) return;
    if (visiting.has(key)) {
      throw new AppError('VALIDATION_ERROR', `Dependency cycle: ${[...path, key].join(' → ')}`, {
        fieldErrors: { fields: `cycle ${[...path, key].join(' -> ')}` },
      });
    }
    visiting.add(key);
    const dependency = byKey.get(key)?.dependsOn;
    if (dependency) walk(dependency.field, [...path, key]);
    visiting.delete(key);
    settled.add(key);
  };
  for (const key of byKey.keys()) walk(key, []);

  return fields;
}

export type AttributeAudience = 'public' | 'admin';

export type AttributeValidationResult = {
  ok: boolean;
  errors: Record<string, string>;
  /** Values after coercion; only the keys the schema accepts. */
  values: Record<string, unknown>;
};

/** Is this field's dependency satisfied by the given values? */
export function dependencySatisfied(field: AttributeField, values: Record<string, unknown>): boolean {
  const dependency: AttributeDependency | null = field.dependsOn;
  if (!dependency) return true;
  const current = values[dependency.field];
  if (dependency.equals !== undefined && dependency.equals !== null && typeof dependency.equals !== 'object') {
    if (Array.isArray(current)) {
      if (current.includes(dependency.equals as never)) return true;
    } else if (current === dependency.equals) {
      return true;
    }
  }
  if (Array.isArray(dependency.in) && dependency.in.length > 0) {
    if (Array.isArray(current)) return current.some((value) => (dependency.in as Array<string | number>).includes(value as string | number));
    return (dependency.in as Array<string | number>).includes(current as string | number);
  }
  return false;
}

/**
 * Validate submitted values against a schema version.
 *
 * Rejects unknown keys, rejects admin-only keys for a public audience, enforces required
 * (including "required only when its dependency is satisfied"), types, constraints and
 * option membership. Returns only accepted keys, so nothing extra can be persisted.
 */
export function validateAttributeValues(
  fields: AttributeField[],
  input: Record<string, unknown>,
  audience: AttributeAudience,
): AttributeValidationResult {
  const submitted = input && typeof input === 'object' ? input : {};
  const errors: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const known = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(submitted)) {
    const field = known.get(key);
    if (!field) {
      errors[key] = 'unknown attribute for this category';
      continue;
    }
    if (field.adminOnly && audience === 'public') {
      errors[key] = 'this attribute is admin-only';
    }
  }

  for (const field of fields) {
    if (field.adminOnly && audience === 'public') continue;
    const present = Object.prototype.hasOwnProperty.call(submitted, field.key) && submitted[field.key] !== null && submitted[field.key] !== '';
    const visible = dependencySatisfied(field, submitted);
    if (!visible) {
      // A value for a hidden field is ignored rather than trusted.
      continue;
    }
    if (!present) {
      if (field.required) errors[field.key] = 'required';
      continue;
    }
    const raw = submitted[field.key];

    switch (field.type) {
      case 'text': {
        const value = String(raw);
        const { minLength, maxLength, pattern } = field.constraints;
        if (minLength != null && value.length < minLength) errors[field.key] = `at least ${minLength} characters`;
        else if (maxLength != null && value.length > maxLength) errors[field.key] = `at most ${maxLength} characters`;
        else if (pattern && !new RegExp(pattern).test(value)) errors[field.key] = 'invalid format';
        else values[field.key] = value;
        break;
      }
      case 'number': {
        const value = typeof raw === 'number' ? raw : Number(String(raw));
        const { min, max, integer } = field.constraints;
        if (!Number.isFinite(value)) errors[field.key] = 'must be a number';
        else if (integer && !Number.isInteger(value)) errors[field.key] = 'must be a whole number';
        else if (min != null && value < min) errors[field.key] = `must be at least ${min}`;
        else if (max != null && value > max) errors[field.key] = `must be at most ${max}`;
        else values[field.key] = value;
        break;
      }
      case 'select': {
        const value = String(raw);
        if (!field.options.some((option) => option.key === value)) errors[field.key] = 'not one of the allowed options';
        else values[field.key] = value;
        break;
      }
      case 'multiselect': {
        const list = Array.isArray(raw) ? raw.map((v) => String(v)) : [String(raw)];
        const allowed = new Set(field.options.map((option) => option.key));
        if (list.some((value) => !allowed.has(value))) errors[field.key] = 'contains an option that is not allowed';
        else if (new Set(list).size !== list.length) errors[field.key] = 'contains duplicates';
        else values[field.key] = list;
        break;
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') errors[field.key] = 'must be true or false';
        else values[field.key] = raw;
        break;
      }
      case 'date': {
        const value = String(raw);
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) errors[field.key] = 'must be an ISO date';
        else values[field.key] = parsed.toISOString();
        break;
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, values };
}

/** Public view of a schema: admin-only fields never leave the server. */
export function publicSchemaFields(fields: AttributeField[]): AttributeField[] {
  return fields.filter((field) => !field.adminOnly);
}
