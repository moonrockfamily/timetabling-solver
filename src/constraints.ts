import { RRuleSet } from 'rrule';
import { AvailabilityRule, evaluateRule, availabilityToRule } from './rules';

// constraints.ts - availability/constraint ontology and helpers

// a single time slot that may carry arbitrary metadata used by
// activity/location constraints and preference functions.  callers
// (like `generateSlots`) create the slots; they can annotate each
// slot with `activity`, `location` or any other custom fields the
// application requires (e.g. "room", "zoom", "priceTier", etc.).
// whenever the scheduler builds an EvaluationContext it simply spreads the
// slot object into the context, so *any* extra properties automatically
// become available to rules and preferences.  this is the core of the
// extensibility model: add whatever you need to slots, and your rules can
// read them without further plumbing.
// slot objects are otherwise pure time intervals.  metadata is kept on the
// slot so that the rule dependency detector can focus only on data the
// scheduler actually controls (start, end, now, plus whatever you choose
// to attach).
export type Slot = { start: Date; end: Date };

// example usage:
//   const slots: Slot[] = generateSlots(now, later, 30)
//     .map(s => ({ ...s, activity: 'zoom' }));
//   // later, fitness() will create contexts that include `activity` and any
//   // other fields you added.  a preference rule may then read ctx.activity.
//
// the scheduler itself never inspects the metadata; it simply copies the
// slot object verbatim into the context before running rules:
//     const ctx = makeContext({ ...s, now: new Date() });
// this makes adding new dimensions as easy as annotating slots before
// passing them to `runGenetic`.

// --- constraint ontology --------------------------------------------------
// Availability no longer carries a status flag; rules express all
// feasibility/preference information.  The legacy type previously defined
// 'available' | 'unavailable' | 'preferred', but that behaviour has been
// removed in favour of rule functions.
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
  // Additional dimensions the scheduler supplies when evaluating a rule.
  // `activity`/`location` are examples of metadata copied from the slot by
  // the caller.  `now` is injected to make notice constraints deterministic.
  activity?: string;
  location?: string;
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

// legacy availability type retained only for backwards compatibility in
// a few helpers; status is ignored and constraints are simply concatenated.
export interface Availability {
  constraints: Constraint[];
}


/**
 * The original availability evaluator is retained for compatibility; it simply
 * delegates to `evaluateRule` after converting the old type.
 */
export function evaluateAvailability(
  av: Availability,
  ctx: EvaluationContext
): boolean {
  // simply delegate to the rule adapter; the adapter itself ignores any
  // status information that may be present on the legacy object.
  return evaluateRule(availabilityToRule(av), ctx);
}

export function intersectAvailability(
  a: Availability,
  b: Availability
): Availability {
  // status no longer exists; intersection simply concatenates constraints.
  return {
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
