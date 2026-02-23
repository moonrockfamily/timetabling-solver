import { EvaluationContext, Availability } from './constraints';

// --- rule support --------------------------------------------------------

/**
 * A context wrapper that records which properties get accessed during rule
 * evaluation.  The scheduler can provide this to a rule and later inspect
 * the accessed set to determine slot/now dependencies.
 */
export interface TrackedEvaluationContext extends EvaluationContext {
  accessed: Set<string>;
}

/**
 * Construct a tracked evaluation context.  Any property read through the
 * proxy will be logged in the `accessed` set.
 */
export function makeContext(base: Partial<EvaluationContext> = {}): TrackedEvaluationContext {
  const accessed = new Set<string>();
  const target: any = {
    start: base.start || new Date(0),
    end: base.end || new Date(0),
    activity: base.activity,
    location: base.location,
    now: base.now,
  };
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      accessed.add(String(prop));
      return Reflect.get(obj, prop, receiver);
    },
  });
  (proxy as any).accessed = accessed;
  return proxy as TrackedEvaluationContext;
}

/**
 * Retrieve the set of properties a tracked context recorded being accessed.
 */
export function getAccessed(ctx: TrackedEvaluationContext): Set<string> {
  return ctx.accessed;
}

/**
 * Infer which general dimensions a rule depends on by executing it once
 * with a tracked context and inspecting which properties were touched.
 */
export function inferRuleDependencies(fn: (ctx: EvaluationContext) => number): { usesSlot: boolean; usesNow: boolean } {
  const ctx = makeContext();
  try { fn(ctx); } catch { /* ignore exceptions */ }
  const acc = getAccessed(ctx);
  const usesSlot = acc.has('start') || acc.has('end') || acc.has('activity') || acc.has('location');
  const usesNow = acc.has('now');
  return { usesSlot, usesNow };
}

/**
 * A single availability rule: a (possibly preferred) set of constraints plus
 * optional notice, recurrence and other modifiers.  A participant may supply
 * zero or more rules; the overall participant is considered available if any
 * one rule is satisfied.  This structure makes it easy to express complex
 * combinations such as “remote anytime with 5 h notice” and “in‑person after
 * 4 pm weekdays with 24 h notice”, etc.
 */
export interface AvailabilityRule {
  /**
   * Evaluate the rule.  `0` means infeasible; any value in (0,1] is a
   * preference score, with larger values indicating a stronger preference.
   */
  (ctx: EvaluationContext): number;

  /**
   * optimization hints.  consumers may inspect these and avoid re‑evaluating
   * the rule when the hint indicates the value cannot change.
   */
  dependsOnSlot?: boolean; // defaults to true
  dependsOnNow?: boolean; // defaults to true
}

/**
 * Small utility that wraps a function and automatically infers or accepts
 * dependency hints.  Since the object returned is a `Proxy` around the
 * underlying function it implements `AvailabilityRule` directly and can be
 * used anywhere a rule is expected.
 */
export class Rule {
  dependsOnSlot: boolean;
  dependsOnNow: boolean;
  private fn: (ctx: EvaluationContext) => number;

  constructor(
    fn: (ctx: EvaluationContext) => number,
    opts: { dependsOnSlot?: boolean; dependsOnNow?: boolean } = {}
  ) {
    this.fn = fn;
    const inferred = inferRuleDependencies(fn);
    this.dependsOnSlot =
      opts.dependsOnSlot !== undefined ? opts.dependsOnSlot : inferred.usesSlot;
    this.dependsOnNow =
      opts.dependsOnNow !== undefined ? opts.dependsOnNow : inferred.usesNow;

    const proxy = new Proxy(this.fn as Function, {
      apply: (_target, _thisArg, args: any[]) => {
        return this.fn(args[0]);
      },
      get: (target, prop, receiver) => {
        if (prop === 'dependsOnSlot') return this.dependsOnSlot;
        if (prop === 'dependsOnNow') return this.dependsOnNow;
        return Reflect.get(target, prop, receiver);
      },
      set: (target, prop, value, receiver) => {
        if (prop === 'dependsOnSlot') {
          this.dependsOnSlot = value;
          return true;
        }
        if (prop === 'dependsOnNow') {
          this.dependsOnNow = value;
          return true;
        }
        return Reflect.set(target, prop, value, receiver);
      },
    });

    return proxy as unknown as Rule;
  }

}

/**
 * Testable helper invoked by `evaluateAvailability` to convert the older
 * `Availability` object into a rule function.  The adapter also sets the
 * optimisation hints based on what was supplied.
 */
export function evaluateRule(rule: AvailabilityRule | undefined, ctx: EvaluationContext): boolean {
  if (!rule) return true;
  return rule(ctx) > 0;
}

export function availabilityToRule(av: Availability): AvailabilityRule {
  const fn: AvailabilityRule = ctx => {
    if (av.status === 'unavailable') return 0;
    for (const c of av.constraints) {
      if (!c.satisfies(ctx)) return 0;
    }
    return av.status === 'preferred' ? 1 : 1;
  };
  fn.dependsOnSlot = av.constraints.length === 0;
  fn.dependsOnNow = false;
  return fn;
}
