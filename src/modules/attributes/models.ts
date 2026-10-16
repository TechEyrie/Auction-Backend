import type { ObjectId } from 'mongodb';

export const ATTRIBUTE_TYPES = ['text', 'number', 'select', 'multiselect', 'boolean', 'date'] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export type AttributeOption = { key: string; labelEn: string; labelAr?: string | null };

export type AttributeConstraints = {
  min?: number | null;
  max?: number | null;
  integer?: boolean | null;
  minLength?: number | null;
  maxLength?: number | null;
  pattern?: string | null;
  unit?: string | null;
};

/**
 * Declarative visibility only. There is deliberately no expression language: a dependency
 * is "show this field when that field equals one of these values", nothing more, so an
 * admin can never inject executable logic into a form or a query.
 */
export type AttributeDependency = {
  field: string;
  equals?: string | number | boolean | null;
  in?: Array<string | number> | null;
};

export type AttributeField = {
  key: string;
  type: AttributeType;
  labelEn: string;
  labelAr?: string | null;
  helpEn?: string | null;
  unit?: string | null;
  required: boolean;
  filterable: boolean;
  publicDisplay: boolean;
  adminOnly: boolean;
  order: number;
  options: AttributeOption[];
  constraints: AttributeConstraints;
  dependsOn: AttributeDependency | null;
};

export type AttributeSchemaStatus = 'draft' | 'published' | 'archived';

export type AttributeSchemaDoc = {
  categoryId: ObjectId;
  /** Stable category key, denormalized for reads and audit entries. */
  categoryKey: string;
  version: number;
  status: AttributeSchemaStatus;
  fields: AttributeField[];
  notes: string | null;
  createdBy: string;
  publishedBy: string | null;
  publishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AttributeSchemaWithId = AttributeSchemaDoc & { _id: ObjectId };
