import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/shared/errors.ts';
import {
  dependencySatisfied,
  publicSchemaFields,
  validateAttributeValues,
  validateSchemaDefinition,
} from '../../src/modules/attributes/validate.ts';
import type { AttributeField } from '../../src/modules/attributes/models.ts';

function field(partial: Partial<AttributeField> & { key: string; type: AttributeField['type'] }): AttributeField {
  return {
    labelEn: `Label ${partial.key}`,
    labelAr: null,
    helpEn: null,
    unit: null,
    required: false,
    filterable: false,
    publicDisplay: true,
    adminOnly: false,
    order: 0,
    options: [],
    constraints: {},
    dependsOn: null,
    ...partial,
  };
}

const vehicleFields: AttributeField[] = [
  field({ key: 'make', type: 'select', options: [{ key: 'toyota', labelEn: 'Toyota' }, { key: 'nissan', labelEn: 'Nissan' }], required: true, filterable: true }),
  field({ key: 'model', type: 'text', constraints: { minLength: 2, maxLength: 40 }, required: true }),
  field({ key: 'mileage_km', type: 'number', constraints: { min: 0, max: 2_000_000, integer: true }, unit: 'km' }),
  field({ key: 'is_hybrid', type: 'boolean' }),
  field({
    key: 'battery_kwh',
    type: 'number',
    constraints: { min: 0, max: 200 },
    dependsOn: { field: 'is_hybrid', equals: true },
    required: true,
  }),
  field({ key: 'inspection_notes', type: 'text', adminOnly: true }),
];

test('a valid schema passes and returns the fields', () => {
  assert.equal(validateSchemaDefinition(vehicleFields).length, 6);
});

test('duplicate field keys and unknown option comparisons are rejected', () => {
  assert.throws(
    () => validateSchemaDefinition([field({ key: 'make', type: 'text' }), field({ key: 'make', type: 'text' })]),
    /Duplicate field key/,
  );
  assert.throws(
    () =>
      validateSchemaDefinition([
        field({ key: 'make', type: 'select', options: [{ key: 'kia', labelEn: 'Kia' }] }),
        field({ key: 'trim', type: 'text', dependsOn: { field: 'make', equals: 'toyota' } }),
      ]),
    /unknown option/,
  );
});

test('type-specific constraint rules are enforced', () => {
  assert.throws(
    () => validateSchemaDefinition([field({ key: 'name', type: 'text', constraints: { min: 1 } })]),
    /numeric constraints/,
  );
  assert.throws(
    () => validateSchemaDefinition([field({ key: 'price', type: 'number', constraints: { pattern: '^\\d+$' } })]),
    /text constraints/,
  );
  assert.throws(
    () => validateSchemaDefinition([field({ key: 'price', type: 'number', constraints: { min: 10, max: 5 } })]),
    /min greater than max/,
  );
  assert.throws(
    () => validateSchemaDefinition([field({ key: 'note', type: 'text', constraints: { pattern: '([unclosed' } })]),
    /invalid pattern/,
  );
  // Options are only meaningful for select/multiselect.
  assert.throws(
    () => validateSchemaDefinition([field({ key: 'note', type: 'text', options: [{ key: 'a', labelEn: 'A' }] })]),
    /cannot have options/,
  );
});

test('dependency targets must be declarative and comparable', () => {
  assert.throws(
    () => validateSchemaDefinition([field({ key: 'note', type: 'text', dependsOn: { field: 'missing', equals: 'x' } })]),
    /unknown field/,
  );
  assert.throws(
    () =>
      validateSchemaDefinition([
        field({ key: 'note', type: 'text' }),
        field({ key: 'other', type: 'text', dependsOn: { field: 'note', equals: 'x' } }),
      ]),
    /depends on a text field/,
  );
  assert.throws(
    () =>
      validateSchemaDefinition([
        field({ key: 'is_hybrid', type: 'boolean' }),
        field({ key: 'battery', type: 'number', dependsOn: { field: 'is_hybrid', in: ['yes'] } }),
      ]),
    /must use equals against a boolean/,
  );
  assert.throws(
    () =>
      validateSchemaDefinition([
        field({ key: 'secret_flag', type: 'boolean', adminOnly: true }),
        field({ key: 'public_note', type: 'text', dependsOn: { field: 'secret_flag', equals: true } }),
      ]),
    /admin-only/,
  );
});

test('dependency cycles are rejected, including indirect ones', () => {
  assert.throws(
    () =>
      validateSchemaDefinition([
        field({ key: 'flag_a', type: 'select', options: [{ key: 'on', labelEn: 'On' }], dependsOn: { field: 'flag_a', equals: 'on' } }),
      ]),
    /cannot depend on itself/,
  );
  assert.throws(
    () =>
      validateSchemaDefinition([
        field({ key: 'flag_a', type: 'boolean', dependsOn: { field: 'flag_b', equals: true } }),
        field({ key: 'flag_b', type: 'boolean', dependsOn: { field: 'flag_a', equals: true } }),
      ]),
    /cycle/i,
  );
});

test('dependency visibility follows the declared condition', () => {
  const byKey = (key: string) => vehicleFields.find((f) => f.key === key)!;
  assert.equal(dependencySatisfied(byKey('model'), {}), true, 'a field without a dependency is always visible');
  assert.equal(dependencySatisfied(byKey('battery_kwh'), { is_hybrid: false }), false);
  assert.equal(dependencySatisfied(byKey('battery_kwh'), { is_hybrid: true }), true);
  assert.equal(dependencySatisfied(byKey('battery_kwh'), {}), false, 'an unanswered dependency hides the field');
  assert.equal(dependencySatisfied(byKey('make'), {}), true);
});

test('values are validated per type, including required-when-visible', () => {
  const ok = validateAttributeValues(vehicleFields, { make: 'toyota', model: 'Corolla', is_hybrid: false }, 'admin');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, {});

  // A hidden required field is not required.
  assert.equal(ok.values.battery_kwh, undefined);

  // Visible and required: must be present and within range.
  const missing = validateAttributeValues(vehicleFields, { make: 'toyota', model: 'Corolla', is_hybrid: true }, 'admin');
  assert.equal(missing.ok, false);
  assert.equal(missing.errors.battery_kwh, 'required');

  const badType = validateAttributeValues(
    vehicleFields,
    { make: 'toyota', model: 'Corolla', mileage_km: 'lots', is_hybrid: false },
    'admin',
  );
  assert.equal(badType.errors.mileage_km, 'must be a number');

  const badOption = validateAttributeValues(vehicleFields, { make: 'kia', model: 'Sorento', is_hybrid: false }, 'admin');
  assert.equal(badOption.errors.make, 'not one of the allowed options');

  const tooLong = validateAttributeValues(
    vehicleFields,
    { make: 'nissan', model: 'x', is_hybrid: false },
    'admin',
  );
  assert.equal(tooLong.errors.model, 'at least 2 characters');
});

test('unknown and admin-only attribute keys are refused for a public audience', () => {
  const injected = validateAttributeValues(
    vehicleFields,
    { make: 'toyota', model: 'Corolla', is_hybrid: false, inspection_notes: 'internal', rogue_field: 'x' },
    'public',
  );
  assert.equal(injected.ok, false);
  assert.equal(injected.errors.inspection_notes, 'this attribute is admin-only');
  assert.equal(injected.errors.rogue_field, 'unknown attribute for this category');
  assert.equal(injected.values.inspection_notes, undefined, 'rejected values must never be returned');
  assert.equal(injected.values.rogue_field, undefined);

  // The same payload is fine for an admin audience.
  const asAdmin = validateAttributeValues(
    vehicleFields,
    { make: 'toyota', model: 'Corolla', is_hybrid: false, inspection_notes: 'internal', rogue_field: 'x' },
    'admin',
  );
  assert.equal(asAdmin.errors.rogue_field, 'unknown attribute for this category');
  assert.equal(asAdmin.values.inspection_notes, 'internal');
});

test('a value on a hidden field is ignored rather than trusted', () => {
  const result = validateAttributeValues(
    vehicleFields,
    { make: 'toyota', model: 'Corolla', is_hybrid: false, battery_kwh: 999 },
    'admin',
  );
  assert.equal(result.ok, true);
  assert.equal(result.values.battery_kwh, undefined, 'a hidden field must not persist a value');
});

test('numeric coercion and integer rules are applied', () => {
  const numeric = validateAttributeValues(
    vehicleFields,
    { make: 'toyota', model: 'Corolla', mileage_km: '12345', is_hybrid: false },
    'admin',
  );
  assert.equal(numeric.values.mileage_km, 12345);
  const fractional = validateAttributeValues(
    vehicleFields,
    { make: 'toyota', model: 'Corolla', mileage_km: 12.5, is_hybrid: false },
    'admin',
  );
  assert.equal(fractional.errors.mileage_km, 'must be a whole number');
  const outOfRange = validateAttributeValues(
    vehicleFields,
    { make: 'toyota', model: 'Corolla', mileage_km: -1, is_hybrid: false },
    'admin',
  );
  assert.equal(outOfRange.errors.mileage_km, 'must be at least 0');
});

test('the public schema view never exposes admin-only fields', () => {
  const visible = publicSchemaFields(vehicleFields);
  assert.deepEqual(visible.map((f) => f.key), ['make', 'model', 'mileage_km', 'is_hybrid', 'battery_kwh']);
});

test('schema errors are AppErrors with a 422 status', () => {
  try {
    validateSchemaDefinition([]);
    assert.fail('expected a validation error');
  } catch (err) {
    assert.ok(err instanceof AppError);
    assert.equal(err.status, 422);
  }
});
