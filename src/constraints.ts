import { RRuleSet } from 'rrule';

// constraints.ts - availability/constraint ontology and helpers

// a single time slot that may carry arbitrary metadata used by
// activity/location constraints and preference functions.  callers
// (like `generateSlots`) create the slots; they can annotate each
// slot with `activity`, `location` or any other fields the application
// needs.  the solver will automatically copy those properties into the
// evaluation context when checking constraints.
export type Slot = { start: Date; end: Date; activity?: string; location?: string };

// --- constraint ontology --------------------------------------------------
export type AvailabilityStatus =
  | 'available'
  | 'unavailable'
  | 'preferred';

// when a constraint is asked whether a slot is acceptable it receives an
// EvaluationContext.  the context bundles not only the time interval being
// evaluated, but any ancillary data that constraints or preferences might
// need.  fields are all optional so new dimensions can be added over time
// without breaking existing code.
//
// * `slot` – the primary time interval under consideration
// * `activity` / `location` – metadata copied from the slot itself (see the
//   recent change where slots may carry arbitrary tags); used by
//   ActivityConstraint/LocationConstraint, or by user‑supplied preference
//   functions
// * `now` – a clock reading representing "the current moment".  this is
//   supplied automatically by the scheduler and is mainly used by
//   NoticeConstraint to check lead‑time requirements.  having an explicit
//   field makes the behaviour deterministic in tests, since callers can
//   inject a fake `now` value.
export interface EvaluationContext extends Slot {
  // `EvaluationContext` bundles a slot with additional dimensions that are
  // only meaningful while performing a feasibility or preference check.  The
  // slot fields (`start`, `end`, plus any arbitrary metadata) are copied
  // directly from the `Slot` object being examined, so callers can pass a
  // `Slot` wherever an `EvaluationContext` is expected.  The sole extra field
  // today is `now`, used by notice constraints, but new properties may be
  // added in the future (e.g. meeting type, organizer, etc.) without
  // changing the basic model.
  now?: Date;
}

export interface Constraint {
  kind: string;
  satisfies(ctx: EvaluationContext): boolean;
}

export class TimeConstraint implements Constraint {
  kind = 'time';
  constructor(public start: Date, public end: Date) {}
  satisfies(ctx: EvaluationContext): boolean {
    return ctx.start >= this.start && ctx.end <= this.end;
  }
}

export class NoticeConstraint implements Constraint {
  kind = 'notice';
  constructor(public noticeMs: number) {}
  satisfies(ctx: EvaluationContext): boolean {
    const now = ctx.now ?? new Date();
    return ctx.start.getTime() - now.getTime() >= this.noticeMs;
  }
}

export class ActivityConstraint implements Constraint {
  kind = 'activity';
  constructor(public activity: string) {}
  satisfies(ctx: EvaluationContext): boolean {
    return ctx.activity === this.activity;
  }
}

export class LocationConstraint implements Constraint {
  kind = 'location';
  constructor(public location: string) {}
  satisfies(ctx: EvaluationContext): boolean {
    return ctx.location === this.location;
  }
}

export class CompositeConstraint implements Constraint {
  kind = 'composite';
  constructor(
    public operator: 'and' | 'or' | 'not',
    public constraints: Constraint[]
  ) {}

  satisfies(ctx: EvaluationContext): boolean {
    switch (this.operator) {
      case 'and':
        return this.constraints.every(c => c.satisfies(ctx));
      case 'or':
        return this.constraints.some(c => c.satisfies(ctx));
      case 'not':
        // expect single constraint
        return !this.constraints[0].satisfies(ctx);
    }
  }
}

export interface Availability {
  status: AvailabilityStatus;
  constraints: Constraint[];
}

// --- rule support --------------------------------------------------------

/**
 * A single availability rule: a (possibly preferred) set of constraints plus
 * optional notice, recurrence and other modifiers.  A participant may supply
 * zero or more rules; the overall participant is considered available if any
 * one rule is satisfied.  This structure makes it easy to express complex
 * combinations such as “remote anytime with 5 h notice” and “in‑person after
 * 4 pm weekdays with 24 h notice”, etc.
 */
export interface AvailabilityRule {
  status?: AvailabilityStatus;          // default is 'available'
  constraints?: Constraint[];           // all must be satisfied
  noticeMs?: number;                    // lead time required
  rruleSet?: RRuleSet;                  // recurrence-based availability
  preference?: (ctx: EvaluationContext) => number; // optional per-rule preference
}

/**
 * Evaluate a single availability rule against a context.  Returns `true` if
 * the rule does not block the context; a missing rule is considered
 * permissive.
 */
export function evaluateRule(rule: AvailabilityRule | undefined, ctx: EvaluationContext): boolean {
  if (!rule) return true;
  if (rule.status === 'unavailable') return false;
  if (rule.rruleSet) {
    const hits = rule.rruleSet.between(ctx.start, ctx.end, true);
    if (hits.length === 0) return false;
  }
  if (rule.noticeMs) {
    const now = ctx.now ?? new Date();
    if (ctx.start.getTime() - now.getTime() < rule.noticeMs) return false;
  }
  if (rule.constraints) {
    for (const c of rule.constraints) {
      if (!c.satisfies(ctx)) return false;
    }
  }
  return true;
}

/**
 * Backwards-compatible helper for the legacy `Availability` type.  An
 * `Availability` object is treated as an `AvailabilityRule` with a defined
 * status and constraints.  This conversion keeps existing code working while
 * allowing new callers to use the richer rule API.
 */
export function availabilityToRule(av: Availability): AvailabilityRule {
  return { status: av.status, constraints: av.constraints };
}

/**
 * The original availability evaluator is retained for compatibility; it simply
 * delegates to `evaluateRule` after converting the old type.
 */
export function evaluateAvailability(
  av: Availability,
  ctx: EvaluationContext
): boolean {
  return evaluateRule(availabilityToRule(av), ctx);
}

export function intersectAvailability(
  a: Availability,
  b: Availability
): Availability {
  const status:
    | AvailabilityStatus
    | 'unavailable' =
    a.status === 'unavailable' || b.status === 'unavailable'
      ? 'unavailable'
      : a.status === 'preferred' || b.status === 'preferred'
      ? 'preferred'
      : 'available';
  return {
    status: status as AvailabilityStatus,
    constraints: [...a.constraints, ...b.constraints],
  };
}

export function isCompatible(
  a: Availability,
  b: Availability,
  sampleCtxs: EvaluationContext[]
): boolean {
  for (const ctx of sampleCtxs) {
    if (evaluateAvailability(a, ctx) && evaluateAvailability(b, ctx)) {
      return true;
    }
  }
  return false;
}
