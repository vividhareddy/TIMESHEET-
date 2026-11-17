/** Work calendars and their holidays. */
import { Schema, model, type InferSchemaType } from 'mongoose';
import { CASE_INSENSITIVE, COUNTRIES, isoDate, js, jsonSchema, uuidId } from './common.js';

export const HOLIDAY_TYPES = ['public', 'state', 'company'] as const;

const calendarSchema = new Schema(
  {
    _id: uuidId,
    organisationId: { type: String, required: true, ref: 'Organisation' },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    country: { type: String, required: true, enum: COUNTRIES },
    timezone: { type: String, required: true, maxlength: 64 },
    /** Weekdays that are worked: 0 = Sunday … 6 = Saturday. */
    workingDays: {
      type: [Number],
      required: true,
      validate: {
        validator: (days: number[]) => days.length > 0 && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        message: 'workingDays must contain weekdays between 0 and 6.',
      },
    },
    hoursPerDay: { type: Number, required: true, min: [0.01, 'hoursPerDay must be above 0.'], max: 12 },
  },
  { collection: 'calendars', timestamps: { createdAt: true, updatedAt: false } },
);
calendarSchema.index({ organisationId: 1, name: 1 }, { name: 'calendars_name_key', unique: true, collation: CASE_INSENSITIVE });

export type CalendarDoc = InferSchemaType<typeof calendarSchema>;
export const Calendar = model('Calendar', calendarSchema);
export const calendarValidator = jsonSchema(['organisationId', 'name', 'country', 'timezone', 'workingDays', 'hoursPerDay'], {
  organisationId: js.string,
  name: { bsonType: 'string', minLength: 1, maxLength: 100 },
  country: js.enum(COUNTRIES),
  timezone: js.string,
  workingDays: { bsonType: 'array', minItems: 1, maxItems: 7, items: { bsonType: 'number', minimum: 0, maximum: 6 } },
  hoursPerDay: { bsonType: 'number', minimum: 0, exclusiveMinimum: true, maximum: 12 },
});

/** Kept in its own collection so "one holiday per calendar per date" is enforced by a unique index. */
const holidaySchema = new Schema(
  {
    _id: uuidId,
    calendarId: { type: String, required: true, ref: 'Calendar' },
    date: isoDate(),
    name: { type: String, required: true, trim: true, maxlength: 100 },
    type: { type: String, required: true, enum: HOLIDAY_TYPES },
  },
  { collection: 'holidays' },
);
holidaySchema.index({ calendarId: 1, date: 1 }, { name: 'holidays_calendar_id_date_key', unique: true });

export type HolidayDoc = InferSchemaType<typeof holidaySchema>;
export const Holiday = model('Holiday', holidaySchema);
export const holidayValidator = jsonSchema(['calendarId', 'date', 'name', 'type'], {
  calendarId: js.string,
  date: js.isoDate,
  name: { bsonType: 'string', minLength: 1, maxLength: 100 },
  type: js.enum(HOLIDAY_TYPES),
});
