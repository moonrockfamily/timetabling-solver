import ical from 'node-ical';
import { createEvents } from 'ics';
import { Slot } from './constraints';

// ICS/calendar helpers using external libraries for robustness
export function importICS(icsText: string): Slot[] {
  const data = ical.parseICS(icsText);
  const slots: Slot[] = [];
  for (const key in data) {
    const raw = data[key] as unknown;
    if (raw && typeof raw === 'object') {
      const maybe = raw as { type?: unknown; start?: unknown; end?: unknown };
      if (
        maybe.type === 'VEVENT' &&
        maybe.start instanceof Date &&
        maybe.end instanceof Date
      ) {
        slots.push({ start: maybe.start, end: maybe.end });
      }
    }
  }
  return slots;
}

export function exportICS(slots: Slot[]): string {
  const evts = slots.map(s => ({
    start: [
      s.start.getFullYear(),
      s.start.getMonth() + 1,
      s.start.getDate(),
      s.start.getHours(),
      s.start.getMinutes(),
    ] as number[],
    end: [
      s.end.getFullYear(),
      s.end.getMonth() +1,
      s.end.getDate(),
      s.end.getHours(),
      s.end.getMinutes(),
    ] as number[],
  }));
  // the `ics` library uses a rather permissive EventAttributes type; we
  // intentionally bypass it rather than duplicating the definitions here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { value, error } = createEvents(evts as any);
  if (error) {
    throw new Error(`ICS export failure: ${error}`);
  }
  return value ?? '';
}
