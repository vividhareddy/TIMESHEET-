/** Building blocks shared by every Mongoose schema. */
import { randomUUID } from 'node:crypto';

/**
 * Documents keep the UUID string ids used by the original PostgreSQL schema as `_id`, so migrated
 * records, relationships, issued JWTs and ids held by the frontend all stay valid.
 */
export const uuidId = { type: String, default: () => randomUUID() } as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODateString(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

/**
 * Calendar dates (no time of day) are stored as 'YYYY-MM-DD' strings: they sort and compare
 * correctly as text and cannot shift across time zones the way a Date at midnight can.
 */
export const isoDate = (required = true) =>
  ({
    type: String,
    required,
    validate: { validator: (v: unknown) => v == null || isISODateString(v), message: '{PATH} must be a date (YYYY-MM-DD).' },
  }) as const;

/** A week-start date: an ISO date that falls on a Monday. */
export const mondayDate = {
  type: String,
  required: true,
  validate: {
    validator: (v: unknown) => isISODateString(v) && new Date(`${v}T00:00:00Z`).getUTCDay() === 1,
    message: '{PATH} must be a Monday (YYYY-MM-DD).',
  },
} as const;

/** Case-insensitive collation, used for unique names (the equivalent of a unique index on lower(name)). */
export const CASE_INSENSITIVE = { locale: 'en', strength: 2 } as const;

export const COUNTRIES = ['US', 'IN'] as const;
export type Country = (typeof COUNTRIES)[number];

/** JSON-schema fragments for the collection-level ($jsonSchema) validators. */
export const js = {
  string: { bsonType: 'string' },
  nullableString: { bsonType: ['string', 'null'] },
  isoDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  nullableIsoDate: { bsonType: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  date: { bsonType: 'date' },
  nullableDate: { bsonType: ['date', 'null'] },
  bool: { bsonType: 'bool' },
  number: (minimum?: number, maximum?: number) => ({ bsonType: 'number', ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) }),
  enum: (values: readonly string[]) => ({ enum: [...values] }),
};

/** Wraps properties into a `$jsonSchema` validator document. */
export const jsonSchema = (required: string[], properties: Record<string, unknown>) => ({
  $jsonSchema: { bsonType: 'object', required: ['_id', ...required], properties: { _id: js.string, ...properties } },
});
