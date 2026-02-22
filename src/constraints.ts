// constraints.ts - availability/constraint ontology and helpers

export type Slot = { start: Date; end: Date };

// --- constraint ontology --------------------------------------------------
export type AvailabilityStatus =
  | 'available'
  | 'unavailable'
  | 'preferred';

export interface EvaluationContext {
  slot: Slot;
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
    return ctx.slot.start >= this.start && ctx.slot.end <= this.end;
  }
}

export class NoticeConstraint implements Constraint {
  kind = 'notice';
  constructor(public noticeMs: number) {}
  satisfies(ctx: EvaluationContext): boolean {
    const now = ctx.now ?? new Date();
    return ctx.slot.start.getTime() - now.getTime() >= this.noticeMs;
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

export function evaluateAvailability(
  av: Availability,
  ctx: EvaluationContext
): boolean {
  if (av.status === 'unavailable') return false;
  for (const c of av.constraints) {
    if (!c.satisfies(ctx)) return false;
  }
  return true;
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
