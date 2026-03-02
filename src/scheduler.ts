/**
 * Aggregator that computes the weighted mean of scores.
 * @param weights - array of weights for each score
 * @returns Aggregator function
 */
export function weightedMeanAggregator(weights: number[]): Aggregator {
  return scores => {
    if (scores.length === 0) return 0;
    let total = 0, weightSum = 0;
    for (let i = 0; i < scores.length; i++) {
      const w = weights[i] ?? 1;
      if (w === 0) continue;
      total += scores[i] * w;
      weightSum += w;
    }
    return weightSum ? total / weightSum : NaN;
  };
}
import { RRuleSet } from 'rrule';
import Genetic, {
  GenerationStats,
} from 'genetic-js-no-ww';

// Generational statistics type is exported so tests and consumers can inspect
// evolutionary progress without pulling in the entire library API.
export type { GenerationStats };
import {
  Constraint,
  Slot,
  evaluateAvailability,
  EvaluationContext,
} from './constraints';
import {
  evaluateRule,
  AvailabilityRule,
  makeContext,
  TrackedEvaluationContext,
  inferRuleDependencies,
} from './rules';

// --- utilities -----------------------------------------------------------
/**
 * Create a reusable notification handler for GA runs.
 *
 * @param label  short description printed alongside each line
 * @param showPop  include population size in per-gen log (default false)
 * @param showStartFinish  emit "started"/"finished" messages (default true)
 * @returns Notification handler function for genetic algorithm runs
 */
export function makeNotifier(
  label: string,
  showPop = false,
  showStartFinish = true
): (pop: unknown[], gen: number, stats: any, finished: boolean) => void {
  return (pop, gen, stats, finished) => {
    if (showStartFinish && gen === 0) console.log(`  ${label} started`);
    const maxVal = stats?.maximum?.toFixed(3) || 'n/a';
    let msg = `  ${label} gen=${gen}`;
    if (showPop) msg += `, pop=${JSON.stringify(pop)}`;
    msg += `, maxFitness=${maxVal}`;
    console.log(msg);

    // warn if the very first generation contained a perfect individual
    if (gen === 0 && stats && stats.maximum === 1) {
      console.warn(`  >>> early termination: initial population already maxed`);
    }

    if (showStartFinish && finished) console.log(`  ${label} finished`);
  };
}
export interface Participant {
  name: string;
  // legacy single-predicate availability; preserved for backwards
  // compatibility but most users should prefer `rules` below.
  hardAvailability?: (slot: Slot) => boolean; // returns false if slot is disallowed

  /**
   * Global preference function invoked when no rule-specific preference is
   * provided.  Receives the full evaluation context and returns a score in
   * [0,1]; a higher value indicates greater desirability.
   */
  preference?: (ctx: EvaluationContext) => number; // [0,1]

  /**
   * A set of detailed availability rules.  If provided, the solver treats the
   * participant as available for a slot if **any** rule evaluates to true.
   * Rules may impose constraints on time, location, notice period, recurrence,
   * etc., allowing the rich scenarios described by users.  When `rules` is
   * omitted the older combination of fields (`availability`, `rruleSet`,
   * `noticeRequired`, etc.) is used instead.  Individual rules may also
   * specify their own `preference` function.
   *
   * **Extensibility note:** rules receive an `EvaluationContext` that is
   * constructed by copying the slot object verbatim (see the comment in
   * `fitness()` below).  this means you can annotate slots with arbitrary
   * extra properties (`room`, `provider`, `priceTier`, etc.) and then read
   * them directly inside your rule or preference callback.  the scheduler
   * itself never needs to know about these fields – it merely passes them
   * through.
   *
   * Example:
   * ```ts
   * const slots: (Slot & { room?: string })[] = [
   *   { start: d1, end: d2, room: 'A' },
   *   { start: d2, end: d3, room: 'B' },
   * ];
   * const participant: Participant = {
   *   name: 'Alice',
   *   rules: [ctx => ctx.room === 'A' ? 1 : 0], // reads custom field
   * };
   * runGenetic(slots, [[participant]]);
   * ```
   */
  rules?: AvailabilityRule[];

  rruleSet?: RRuleSet; // legacy recurrence set for "available when"
  noticeRequired?: number; // legacy milliseconds of advance notice
  // the old `availability` object has been retired; use `rules` instead.
  bookedSlots?: Slot[]; // pre-existing meetings / reservations
  minGapMs?: number; // required gap before/after any booked slot
}

/**
 * Single-meeting chromosome used by the genetic algorithm.  When we call
 * `Genetic.create<Chromosome, { slots: Slot[]; participant: Participant[] }>()`
 * this is the type of individual that is evolved.  the GA library itself
 * treats the genome as an opaque object; all knowledge of `slotIndex` and
 * `durationSlots` lives in our own `seed`, `mutate`, `crossover`, and
 * `fitness` callbacks below.
 */
export interface Chromosome {
  slotIndex: number;
  durationSlots?: number; // if provided, spans multiple consecutive slots
}

// Multi-objective genome: each meeting chooses an index
// the GA still views the chromosome as a generic payload; we merely
// interpret `slotIndices` and `durationSlots` when computing fitness.
export interface MultiChromosome {
  slotIndices: number[];
  durationSlots?: number[]; // parallel array if each meeting needs a duration
}


// --- scheduling helpers --------------------------------------------------

// helpers for availability rules ------------------------------------------------

/**
 * Convert a participant's legacy availability/rrule/notice/hardAvailability
 * fields into a single `AvailabilityRule` function.  Returns `undefined` if
 * the participant had no legacy data at all.
 */
function legacyRuleFromParticipant(p: Participant): AvailabilityRule | undefined {
  if (!p.rruleSet && p.noticeRequired === undefined && !p.hardAvailability) {
    return undefined;
  }

  const rule: AvailabilityRule = ctx => {
    // enforce high‑level availability object
    // legacy availability object is no longer supported; skip this step.
    // recurrence set
    if (p.rruleSet) {
      const hits = p.rruleSet.between(ctx.start, ctx.end, true);
      if (hits.length === 0) return 0;
    }
    // notice requirement
    if (p.noticeRequired !== undefined) {
      const now = ctx.now ?? new Date();
      if (ctx.start.getTime() - now.getTime() < p.noticeRequired) return 0;
    }
    // hard availability predicate (slot-only)
    if (p.hardAvailability) {
      if (!p.hardAvailability({ start: ctx.start, end: ctx.end } as Slot)) return 0;
    }
    return 1;
  };
  return rule;
}

/**
 * Return the set of availability rules that apply to a participant, defaulting
 * to legacy fields when `rules` is not provided.
 */
function attachDeps(rule: AvailabilityRule): AvailabilityRule {
  if (rule.dependsOnSlot !== undefined || rule.dependsOnNow !== undefined) {
    return rule;
  }
  const { usesSlot, usesNow } = inferRuleDependencies(rule);
  rule.dependsOnSlot = usesSlot;
  rule.dependsOnNow = usesNow;
  return rule;
}

function participantRules(p: Participant): AvailabilityRule[] {
  let rules: AvailabilityRule[] = [];
  if (p.rules && p.rules.length) {
    rules = [...p.rules];
  } else {
    const r = legacyRuleFromParticipant(p);
    if (r) rules = [r];
  }
  // attachDeps once per rule rather than twice
  return rules.map(attachDeps);
}

/**
 * Generate an array of time slots covering the interval from `start` up to
 * (but not including) `end`, each slot having duration specified by
 * `intervalMinutes`.
 *
 * @param start - inclusive start date/time for the slot sequence
 * @param end - exclusive end date/time for the slot sequence
 * @param intervalMinutes - length of each slot in minutes
 * @returns array of contiguous `Slot` objects
 */
export function generateSlots(start: Date, end: Date, intervalMinutes: number): Slot[] {
  const slots: Slot[] = [];
  let cur = new Date(start);
  while (cur < end) {
    const nxt = new Date(cur.getTime() + intervalMinutes * 60_000);
    slots.push({ start: new Date(cur), end: nxt });
    cur = nxt;
  }
  return slots;
}

/**
 * Append one or more common participants to each group of participant.  Useful for
 * any domain in which you have a set of primary groups and need to tack on
 * shared members (e.g. buyers+agent+homeowner, interview panels + facilitator,
 * etc.).
 *
 * The helper is intentionally generic: you supply the base `groups` and then
 * zero or more `common` participants.  The latter are concatenated onto every
 * group.  When no `common` arguments are given the input groups are returned
 * as shallow copies.
 *
 * @param groups - array of participant arrays representing separate meeting groups
 * @param common - zero or more `Participant` objects to append to every group
 * @returns new array where each entry is a concatenation of the original
 *   group with the common participants
 */
export function assembleGroups(
  groups: Participant[][],
  ...common: Participant[]
): Participant[][] {
  if (common.length === 0) return groups.map(g => [...g]);
  return groups.map(g => [...g, ...common]);
}

/**
 * Produce a scalariser function that computes a weighted sum of a score
 * vector using the provided `weights`.
 *
 * @param weights - array of weights corresponding to each score index; if a
 *   weight is undefined, it defaults to 1
 * @returns function which accepts an array of numbers and returns the
 *   weighted total
 */
export function weightedScalariser(weights: number[]): (scores: number[]) => number {
  return scores => {
    let tot = 0;
    for (let i = 0; i < scores.length; i++) {
      tot += scores[i] * (weights[i] ?? 1);
    }
    return tot;
  };
}

/**
 * Check a participant's hard availability function against a single slot.
 *
 * @param slot - the time slot under consideration
 * @param participant - participant whose availability is checked
 * @returns `true` if either the participant has no hardAvailability or the
 *   function allows the slot
 */
function evalTimeConstraint(slot: Slot, participant: Participant): boolean {
  if (!participant.hardAvailability) return true;
  return participant.hardAvailability(slot);
}

/**
 * Verify that a slot falls within a participant's recurring availability set.
 *
 * @param slot - time interval being tested
 * @param participant - participant with optional `rruleSet` of allowed times
 * @returns `true` if no recurrence rules exist or the slot intersects the
 *   rrule set
 */
/**
 * Determine whether two slots overlap in time.
 *
 * @param a - first slot
 * @param b - second slot
 * @returns `true` if the intervals intersect (strict overlap)
 */
function overlaps(a: Slot, b: Slot): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Expand a chromosome into the actual time slots it represents.  Supports
 * multi-slot meetings when `durationSlots` is set.
 *
 * @param chrom - chromosome indicating starting index (and optional
 *   duration in number of slots)
 * @param slots - full slot array from which indices are drawn
 * @returns array of one or more consecutive slots corresponding to the
 *   chromosome
 */
function slotRange(chrom: Chromosome, slots: Slot[]): Slot[] {
  if (chrom.durationSlots && chrom.durationSlots > 1) {
    return slots.slice(chrom.slotIndex, chrom.slotIndex + chrom.durationSlots);
  }
  return [slots[chrom.slotIndex]];
}

export interface FeasibilityDetail {
  feasible: boolean;
  reasons: string[];
}

/**
 * Determine whether a given slot (or sequence of slots) is compatible with
 * a participant's constraints and, if not, accumulate human-readable reasons.
 *
 * @param slot - single slot or array of slots to evaluate
 * @param participant - participant whose restrictions are tested
 * @returns object containing `feasible` boolean and array of `reasons`
 */
export function getFeasibilityDetail(
  slot: Slot | Slot[],
  participant: Participant
): FeasibilityDetail {
  const slotsToTest: Slot[] = Array.isArray(slot) ? slot : [slot];
  if (slotsToTest.length === 0) {
    return { feasible: true, reasons: [] };
  }

  const reasons: string[] = [];
  const add = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  for (const s of slotsToTest) {
    if (s.start > s.end) {
      add('invalid slot interval');
      continue;
    }
    if (participant.bookedSlots) {
      for (const b of participant.bookedSlots) {
        if (overlaps(s, b)) add('overlaps booked slot');
        if (participant.minGapMs) {
          if (
            s.end.getTime() > b.start.getTime() - participant.minGapMs &&
            s.start.getTime() < b.end.getTime() + participant.minGapMs
          ) {
            add('insufficient gap around booked slot');
          }
        }
      }
    }
    // evaluate any availability rules (new API) or legacy fields
    // create evaluation context; any fields carried on the slot (e.g.
    // activity/location/room/customTags) are copied verbatim and therefore
    // influence rule evaluation.  this is the other half of the
    // extensibility story – you can tack arbitrary metadata onto slots and
    // it will be available whenever the scheduler asks a rule about that
    // slot.
    const ctx: EvaluationContext = {
      ...s,
      now: new Date(),
    };
    const rules = participantRules(participant);
    if (rules.length > 0) {
      const matched = rules.some(r => evaluateRule(r, ctx));
      if (!matched) {
        add('availability constraint');
      }
    }
    // still enforce hardAvailability predicate and bookedSlots/
    // minGapMs exactly as before
    if (!evalTimeConstraint(s, participant)) {
      add('hard availability rejection');
    }
  }
  return { feasible: reasons.length === 0, reasons };
}

/**
 * Quick boolean wrapper around `getFeasibilityDetail`.
 *
 * @param slot - slot or slots to check
 * @param participant - participant being evaluated
 * @returns `true` when all constraints are satisfied
 */
export function isFeasible(slot: Slot | Slot[], participant: Participant): boolean {
  return getFeasibilityDetail(slot, participant).feasible;
}

/**
 * Compute a normalized preference score for a slot for a given participant.
 * Scores are clamped to [0,1]; if the participant has a `preference` callback it is
 * invoked, otherwise a default of 1 is assumed.  A small bonus is applied if
 * the participant's availability status is explicitly marked `preferred`.
 *
 * @param ctx - evaluation context containing slot plus any metadata
 * @param participant - participant whose preferences are used
 * @returns score in the range 0..1
 */
export function preferenceScore(ctx: EvaluationContext, participant: Participant): number {
  // preferenceScore is intended to measure a participant's *desire* for a slot,
  // not their basic availability.  Legacy availability rules (created when a
  // participant uses the old `availability` field instead of `rules`) always
  // return `1` for feasible slots and therefore would swamp any explicit
  // preferences.  To keep behaviour intuitive we only consider user-supplied
  // `rules` here; availability still influences feasibility via
  // `isFeasible`.
  const scores: number[] = [];

  if (participant.rules && participant.rules.length) {
    const rules = participantRules(participant);
    for (const r of rules) {
      const v = Math.max(0, Math.min(1, (r as any)(ctx)));
      scores.push(v);
    }
  }

  if (participant.preference) {
    scores.push(Math.max(0, Math.min(1, participant.preference(ctx))));
  }

  if (scores.length === 0) {
    // no explicit preference at all; neutral baseline
    scores.push(.5);
  }

  let result = Math.max(...scores);

  // status field has been removed; preferences are now determined solely
  // by rules and callbacks.
  
  return result;
}

// --- GA-specific glue ----------------------------------------------------
/**
 * Evaluate each sub-chromosome in a multi-objective genome separately.
 * The returned array contains one fitness score per meeting group.
 *
 * @param genome - multi-objective chromosome encoding slot indices (and
 *   possibly durations) for multiple meetings
 * @param slots - pool of candidate time slots
 * @param participantGroups - array of participant arrays corresponding to each meeting
 * @returns fitness vector where element i is the fitness for group i
 */
export function fitnessMulti(
  genome: MultiChromosome,
  slots: Slot[],
  participantGroups: Participant[][]
): number[] {
  return genome.slotIndices.map((idx, i) => {
    const group = participantGroups[i] || [];
    const chrom: Chromosome = { slotIndex: idx };
    if (genome.durationSlots && genome.durationSlots[i]) {
      chrom.durationSlots = genome.durationSlots[i];
    }
    return fitness(chrom, slots, group);
  });
}

/**
 * Internal helper to perform a single genetic algorithm run for a
 * multi-objective scheduling problem.  It configures the GA, including
 * seeding, mutation, crossover, and fitness calculation, then evolves a
 * population and returns the best found genome.
 *
 * @param slots - available time slots
 * @param participantGroups - meeting groups to schedule concurrently
 * @param options - GA tuning parameters
 * @param scalariser - function to collapse fitness vector to a single
 *   scalar for the multi-objective optimizer
 * @param _trace - optional array to collect generation statistics (unused)
 * @returns best chromosome found or `null` if none
 */
function runSingleGeneticMulti(
  slots: Slot[],
  participantGroups: Participant[][],
  options: GARunOptions,
  scalariser: (scores: number[]) => number,
  _trace?: GenerationStats[]
): MultiChromosome | null {
  const n = participantGroups.length;
  const genetic = Genetic.create<MultiChromosome, { slots: Slot[]; participantGroups: Participant[][] }>();
  genetic.optimize = Genetic.Optimize.Maximize;
  // use a simple tournament selection for both parents
  genetic.select1 = Genetic.Select1.Tournament2;
  genetic.select2 = Genetic.Select2.Tournament2;

  genetic.seed = (): MultiChromosome => {
    const base: MultiChromosome = { slotIndices: [] };
    for (let i = 0; i < n; i++) {
      base.slotIndices.push(Math.floor(Math.random() * slots.length));
    }
    if (options.maxDurationSlots && options.maxDurationSlots > 1) {
      base.durationSlots = [];
      for (let i = 0; i < n; i++) {
        base.durationSlots.push(1 + Math.floor(Math.random() * options.maxDurationSlots));
      }
    }
    return base;
  };
  genetic.mutate = (g: MultiChromosome): MultiChromosome => {
    const copy: MultiChromosome = { ...g, slotIndices: [...g.slotIndices] };
    const idx = Math.floor(Math.random() * n);
    copy.slotIndices[idx] = Math.floor(Math.random() * slots.length);
    if (options.maxDurationSlots && options.maxDurationSlots > 1) {
      if (!copy.durationSlots) copy.durationSlots = [];
      const newDur = 1 + Math.floor(Math.random() * options.maxDurationSlots);
      copy.durationSlots[idx] = newDur;
    }
    return copy;
  };
  genetic.crossover = (
    a: MultiChromosome,
    b: MultiChromosome
  ): MultiChromosome[] => {
    const makeChild = (): MultiChromosome => {
      const child: MultiChromosome = { slotIndices: [] };
      for (let i = 0; i < n; i++) {
        child.slotIndices.push(Math.random() < 0.5 ? a.slotIndices[i] : b.slotIndices[i]);
      }
      return child;
    };
    return [makeChild(), makeChild()];
  };
  genetic.fitness = (g: MultiChromosome): number => {
    const vec = fitnessMulti(g, slots, participantGroups);
    return scalariser(vec);
  };
  genetic.generation = (_pop: any, gen: number, stats: any): boolean =>
    gen < (options.iterations ?? 500) && stats.maximum < 1;
  genetic.notification = (_pop: any, gen: number, stats: any, finished: boolean): void => {
    if (options.notification) options.notification(_pop, gen, stats, finished);
  };

  genetic.evolve(
    {
      size: options.size ?? 100,
      iterations: options.iterations ?? 500,
    },
    { slots, participantGroups }
  );

  let best: MultiChromosome | null = null;
  let bestFit: number | null = null;
  for (const e of genetic.entities) {
    const f = genetic.fitness(e);
    if (bestFit === null || genetic.optimize(f, bestFit)) {
      bestFit = f;
      best = e;
    }
  }
  return best;
}

/**
 * High‑level API for running a genetic algorithm on multiple parallel
 * meetings.  It filters slots to those feasible for all participants, then
 * executes one or more runs (restarts) to seek an optimal multi-chromosome.
 *
 * @param slots - candidate time slots
 * @param participantGroups - array of participant arrays representing the meetings to
 *   schedule simultaneously
 * @param options - GA configuration options such as population size,
 *   iterations, restarts, and max durations
 * @param scalariser - function to convert a vector of per-meeting fitness
 *   scores to a single scalar (default averages them)
 * @returns best found `MultiChromosome`, or `null` when no feasible slot
 *   exists for all meetings
 */
export interface RankedMultiChromosome {
  chromosome: MultiChromosome;
  fitness: number;
}

function collectMultiGeneticPopulation(
  slots: Slot[],
  participantGroups: Participant[][],
  options: GARunOptions,
  scalariser: (scores: number[]) => number
): RankedMultiChromosome[] {
  const n = participantGroups.length;
  const genetic = Genetic.create<MultiChromosome, { slots: Slot[]; participantGroups: Participant[][] }>();
  genetic.optimize = Genetic.Optimize.Maximize;
  genetic.select1 = Genetic.Select1.Tournament2;
  genetic.select2 = Genetic.Select2.Tournament2;

  genetic.seed = (): MultiChromosome => {
    const base: MultiChromosome = { slotIndices: [] };
    for (let i = 0; i < n; i++) {
      base.slotIndices.push(Math.floor(Math.random() * slots.length));
    }
    if (options.maxDurationSlots && options.maxDurationSlots > 1) {
      base.durationSlots = [];
      for (let i = 0; i < n; i++) {
        base.durationSlots.push(1 + Math.floor(Math.random() * options.maxDurationSlots));
      }
    }
    return base;
  };
  genetic.mutate = (g: MultiChromosome): MultiChromosome => {
    const copy: MultiChromosome = { ...g, slotIndices: [...g.slotIndices] };
    const idx = Math.floor(Math.random() * n);
    copy.slotIndices[idx] = Math.floor(Math.random() * slots.length);
    if (options.maxDurationSlots && options.maxDurationSlots > 1) {
      if (!copy.durationSlots) copy.durationSlots = [];
      const newDur = 1 + Math.floor(Math.random() * options.maxDurationSlots);
      copy.durationSlots[idx] = newDur;
    }
    return copy;
  };
  // crossover must return two offspring
  genetic.crossover = (
    a: MultiChromosome,
    b: MultiChromosome
  ): MultiChromosome[] => {
    const makeChild = (): MultiChromosome => {
      const child: MultiChromosome = { slotIndices: [] };
      for (let i = 0; i < n; i++) {
        child.slotIndices.push(Math.random() < 0.5 ? a.slotIndices[i] : b.slotIndices[i]);
      }
      return child;
    };
    return [makeChild(), makeChild()];
  };
  genetic.fitness = (g: MultiChromosome): number => {
    const vec = fitnessMulti(g, slots, participantGroups);
    return scalariser(vec);
  };
  genetic.generation = (_pop: any, gen: number, stats: any): boolean =>
    gen < (options.iterations ?? 500) && stats.maximum < 1;
  genetic.notification = (_pop: any, gen: number, stats: any, finished: boolean): void => {
    if (options.notification) options.notification(_pop, gen, stats, finished);
  };

  genetic.evolve(
    {
      size: options.size ?? 100,
      iterations: options.iterations ?? 500,
    },
    { slots, participantGroups }
  );

  const results: RankedMultiChromosome[] = [];
  for (const e of genetic.entities) {
    results.push({ chromosome: e, fitness: genetic.fitness(e) });
  }
  return results;
}

export function runGeneticMulti(
  slots: Slot[],
  participantGroups: Participant[][],
  options: GARunOptions = {},
  scalariser: (scores: number[]) => number = scores => {
    if (scores.length === 0) return 0;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }
): MultiChromosome | null {
  const feasible = slots.filter(s =>
    participantGroups.every(pg => pg.every(p => isFeasible(s, p)))
  );
  if (feasible.length === 0) return null;

  const runs = options.restarts && options.restarts > 1 ? options.restarts : 1;
  let bestResult: MultiChromosome | null = null;
  let bestFitness: number | null = null;

  for (let i = 0; i < runs; i++) {
    const candidate = runSingleGeneticMulti(slots, participantGroups, options, scalariser);
    if (!candidate) continue;
    const score = scalariser(fitnessMulti(candidate, slots, participantGroups));
    if (bestFitness === null || score > bestFitness) {
      bestFitness = score;
      bestResult = candidate;
    }
    if (bestFitness === 1) break;
  }

  return bestResult;
}

/**
 * Return the top‑N multi‑chromosomes sorted by fitness.
 */
export function runGeneticMultiTopN(
  slots: Slot[],
  participantGroups: Participant[][],
  n: number = 10,
  options: GARunOptions = {},
  scalariser: (scores: number[]) => number = scores => {
    if (scores.length === 0) return 0;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }
): RankedMultiChromosome[] {
  const feasible = slots.filter(s =>
    participantGroups.every(pg => pg.every(p => isFeasible(s, p)))
  );
  if (feasible.length === 0) return [];

  const runs = options.restarts && options.restarts > 1 ? options.restarts : 1;
  const seen = new Set<string>();
  const collected: RankedMultiChromosome[] = [];

  for (let i = 0; i < runs; i++) {
    const pop = collectMultiGeneticPopulation(slots, participantGroups, options, scalariser);
    for (const entry of pop) {
      const sig = JSON.stringify(entry.chromosome);
      if (!seen.has(sig)) {
        seen.add(sig);
        collected.push(entry);
      }
    }
  }

  collected.sort((a, b) => b.fitness - a.fitness);
  return collected.slice(0, n);
}

/**
 * Randomly perturb a chromosome by choosing a new slot index (and adjusting
 * duration if present).  Used as the GA mutation operator.
 *
 * @param genome - original chromosome to mutate
 * @param slots - slot pool from which a new index is drawn
 * @returns mutated chromosome copy
 */
export function mutateGenome(genome: Chromosome, slots: Slot[]): Chromosome {
  const copy: Chromosome = { ...genome };
  copy.slotIndex = Math.floor(Math.random() * slots.length);
  if (genome.durationSlots) {
    const maxDur = slots.length - copy.slotIndex;
    let d = genome.durationSlots + (Math.random() < 0.5 ? -1 : 1);
    if (d < 1) d = 1;
    if (d > maxDur) d = maxDur;
    copy.durationSlots = d;
  }
  return copy;
}

/**
 * Simple crossover operator for two chromosomes: randomly selects one of the
 * parents and returns a shallow copy.  This is effectively a no-op but kept
 * for API consistency with genetic-js.
 *
 * @param a - first parent chromosome
 * @param b - second parent chromosome
 * @returns chosen parent copy
 */
export function crossoverGenome(
  a: Chromosome,
  b: Chromosome
): Chromosome {
  const parent = Math.random() < 0.5 ? a : b;
  return { ...parent };
}

/**
 * Return a subset of slots that are simultaneously feasible for all
 * specified participant.
 *
 * @param slots - pool of slots to filter
 * @param participant - participants whose constraints must all be met
 * @returns array of slots that pass every participant's feasibility check
 */
export function filterFeasibleSlots(slots: Slot[], participant: Participant[]): Slot[] {
  return slots.filter(s => participant.every(p => isFeasible(s, p)));
}

export type Aggregator = (scores: number[]) => number;

/**
 * Default aggregation strategy for combining multiple preference scores:
 * returns the minimum (i.e. worst) score, or 1 if the array is empty.
 *
 * @param scores - array of numeric scores
 * @returns aggregated value in [0,1]
 */

/**
 * Default aggregation strategy: mean of scores, or 1 if empty.
 */
export function meanAggregator(scores: number[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((a, b) => a + b, 0);
  return sum / scores.length;
}

/**
 * Optional min aggregator: returns the minimum score, or 1 if empty.
 */
export function minAggregator(scores: number[]): number {
  if (scores.length === 0) return 0;
  return Math.min(...scores);
}

/**
 * Optional max aggregator: returns the maximum score, or 1 if empty.
 */
export function maxAggregator(scores: number[]): number {
  if (scores.length === 0) return 0;
  return Math.max(...scores);
}

/**
 * Compute the fitness of a chromosome with respect to a set of participant.
 * The fitness is the aggregated preference score across all participants,
 * but any infeasibility causes a zero score.
 *
 * @param genome - chromosome encoding a slot selection (and optional
 *   duration)
 * @param slots - available slot list
 * @param participants - participants to evaluate
 * @param aggregator - function to combine individual preference numbers
 *   into a single fitness value (defaults to `defaultAggregator`)
 * @returns normalized fitness value between 0 and 1
 */
export function fitness(
  genome: Chromosome,
  slots: Slot[],
  participants: Participant[],
  aggregator: Aggregator = meanAggregator // now mean by default
): number {
  const range = slotRange(genome, slots);
  const prefs: number[] = [];
  for (const p of participants) {
    if (!isFeasible(range, p)) {
      return 0;
    }
    const scores = range.map(s => {
      // propagate any metadata fields carried on the slot into the
      // evaluation context via object spread.  `activity`/`location` etc
      // are copied automatically, and we append `now` separately for
      // notice checks.
      // build the evaluation context for this slot before asking
      // preferences.  the `...s` spread is what makes the system
      // extensible: any extra properties you have added to the slot
      // (activity, location, room, priceTier, etc.) are copied verbatim
      // into the context and therefore become visible to `rules` and
      // `preference` callbacks.  the scheduler code itself never
      // inspects or enumerates these fields – it simply hands them off.
      // The `makeContext` wrapper used here also tracks which properties
      // the rule actually reads (see `inferRuleDependencies`); it was
      // recently fixed to retain all metadata fields rather than only the
      // handful of known ones, which prevented custom tags from being
      // visible inside tracked contexts.
      const ctx: TrackedEvaluationContext = makeContext({
        ...s,
        now: new Date(),
      });
      const val = preferenceScore(ctx, p);
      // optional: cache dependency information from ctx.accessed here
      return val;
    });
    // multiple slots: average the preference across them; this is a design choice and can be changed if desired
    prefs.push(scores.reduce((a,b)=>a+b,0)/scores.length);
  }
  const result = aggregator(prefs);
  return Math.max(0, Math.min(1, result));
}

/**
 * Configuration passed through to the underlying genetic-js library.  The
 * meaning matches the `options` object accepted by
 * `genetic.evolve({ size, iterations }, context)`; we merely expose a
 * simplified subset plus a couple of convenience fields used by our helpers.
 *
 * <ul>
 * <li>`size` – population size.</li>
 * <li>`iterations` – maximum number of generations before stopping.</li>
 * <li>`restarts` – number of independent GA runs to perform (best result wins).</li>
 * <li>`maxDurationSlots` – when non‑undefined, chromosomes may store a
 *     `durationSlots` value; used to model meetings spanning several slots.</li>
 * <li>`notification` – callback invoked on each generation (forwarded directly
 *     from genetic-js notification parameter).</li>
 * </ul>
 *
 * These fields overlap with the upstream `RunOptions` type exported by the
 * `genetic-js-no-ww` library (also re-exported here as
 * `GARunOptionsFromLib`).  For full details consult the declaration file
 * `src/genetic-js-no-ww.d.ts` or the original project docs.
 *
 * Consumers familiar with `genetic-js-no-ww` can refer to its documentation
 * for additional configuration details if they need to drop to a lower level.
 */
export interface GARunOptions {
  size?: number;
  iterations?: number;
  maxDurationSlots?: number; // if provided, solutions may span multiple slots
  restarts?: number;
  notification?: (pop: unknown[], gen: number, stats: GenerationStats, finished: boolean) => void;
}

/**
 * Heuristically derive reasonable GA options based on problem size.
 *
 * @param slots - available slots for scheduling
 * @param meetings - array of meeting objects (only their `participant` property
 *   is considered here)
 * @returns a `GARunOptions` object with `size`, `iterations`, and `restarts`
 *   calculated
 */
export function estimateOptions(
  slots: Slot[],
  meetings: { participant: Participant[] }[] = []
): GARunOptions {
  const slotCount = slots.length;
  const meetingCount = meetings.length;

  const size = Math.min(200, Math.max(10, Math.floor(slotCount * Math.log2(slotCount + 2) / 4)));
  const iterations = size * 2;
  const restarts = Math.max(1, Math.ceil(meetingCount / 5));

  return { size, iterations, restarts };
}

// helper for doing one execution of the GA; the outer wrapper can call
// this multiple times when the `restarts` option is set.
// internal helper that optionally records generation statistics
/**
 * Internal utility to run the genetic algorithm once for a single meeting.
 * Configures population operators, evolves the population, and returns the
 * best chromosome.
 *
 * @param slots - candidate slots
 * @param participant - participants in the meeting
 * @param options - GA parameters such as size, iterations, etc.
 * @param aggregator - fitness aggregation function
 * @param _trace - optional stats trace collector (unused)
 * @returns best chromosome or `null` if none found
 */
function runSingleGenetic(
  slots: Slot[],
  participant: Participant[],
  options: GARunOptions,
  aggregator: Aggregator,
  _trace?: GenerationStats[]
): Chromosome | null {
  const genetic = Genetic.create<Chromosome, { slots: Slot[]; participant: Participant[] }>();
  genetic.optimize = Genetic.Optimize.Maximize;
  genetic.select1 = Genetic.Select1.Tournament2;
  genetic.select2 = Genetic.Select2.Tournament2;

  genetic.seed = (): Chromosome => {
    const base: Chromosome = { slotIndex: Math.floor(Math.random() * slots.length) };
    if (options.maxDurationSlots && options.maxDurationSlots > 1) {
      base.durationSlots = 1 + Math.floor(Math.random() * options.maxDurationSlots);
    }
    return base;
  };
  genetic.mutate = (g: Chromosome): Chromosome => {
    const copy: Chromosome = { ...g };
    copy.slotIndex = Math.floor(Math.random() * slots.length);
    if (options.maxDurationSlots && options.maxDurationSlots > 1) {
      copy.durationSlots = 1 + Math.floor(Math.random() * options.maxDurationSlots);
    }
    return copy;
  };
  // crossover returns two offspring
  genetic.crossover = (a: Chromosome, b: Chromosome): Chromosome[] => {
    const c1 = Math.random() < 0.5 ? a : b;
    const c2 = Math.random() < 0.5 ? a : b;
    return [c1, c2];
  };
  genetic.fitness = (g: Chromosome): number => fitness(g, slots, participant, aggregator);
  genetic.generation = (
    pop: Chromosome[],
    gen: number,
    stats: GenerationStats
  ): boolean => {
    return gen < (options.iterations ?? 500) && stats.maximum < 1;
  };
  genetic.notification = (
    pop: Chromosome[],
    gen: number,
    stats: GenerationStats,
    finished: boolean
  ): void => {
    if (options.notification) options.notification(pop, gen, stats, finished);
  };

  genetic.evolve(
    {
      size: options.size ?? 100,
      iterations: options.iterations ?? 500,
    },
    { slots, participant }
  );

  let bestEntity: Chromosome | null = null;
  let bestFitness: number | null = null;
  for (const e of genetic.entities) {
    const f = genetic.fitness(e);
    if (bestFitness === null || genetic.optimize(f, bestFitness)) {
      bestFitness = f;
      bestEntity = e;
    }
  }
  return bestEntity;
}

/**
 * Public wrapper to schedule a single meeting via genetic algorithm.
 * It first eliminates impossible slots before performing one or more GA runs
 * (according to `restarts`) and returns the best found chromosome.
 *
 * @param slots - available time slots
 * @param participant - participants to include in the meeting
 * @param options - optional GA configuration
 * @param aggregator - how individual preference scores are reduced to a
 *   single fitness value
 * @returns chosen `Chromosome` or `null` if no feasible time exists
 */
export interface RankedChromosome {
  chromosome: Chromosome;
  fitness: number;
}

/**
 * Perform a genetic run and collect all entities along with their fitness
 * values.  Used internally by the `TopN` helpers.
 */
function collectSingleGeneticPopulation(
  slots: Slot[],
  participant: Participant[],
  options: GARunOptions,
  aggregator: Aggregator
): RankedChromosome[] {
  const genetic = Genetic.create<Chromosome, { slots: Slot[]; participant: Participant[] }>();
  genetic.optimize = Genetic.Optimize.Maximize;
  genetic.select1 = Genetic.Select1.Tournament2;
  genetic.select2 = Genetic.Select2.Tournament2;

  genetic.seed = (): Chromosome => {
    const base: Chromosome = { slotIndex: Math.floor(Math.random() * slots.length) };
    if (options.maxDurationSlots && options.maxDurationSlots > 1) {
      base.durationSlots = 1 + Math.floor(Math.random() * options.maxDurationSlots);
    }
    return base;
  };
  genetic.mutate = (g: Chromosome): Chromosome => {
    const copy: Chromosome = { ...g };
    copy.slotIndex = Math.floor(Math.random() * slots.length);
    if (options.maxDurationSlots && options.maxDurationSlots > 1) {
      copy.durationSlots = 1 + Math.floor(Math.random() * options.maxDurationSlots);
    }
    return copy;
  };
  // ensure crossover returns a pair
  genetic.crossover = (a: Chromosome, b: Chromosome): Chromosome[] => {
    const c1 = Math.random() < 0.5 ? a : b;
    const c2 = Math.random() < 0.5 ? a : b;
    return [c1, c2];
  };
  genetic.fitness = (g: Chromosome): number => fitness(g, slots, participant, aggregator);
  genetic.generation = (
    pop: Chromosome[],
    gen: number,
    stats: GenerationStats
  ): boolean => {
    // notifications are already forwarded later
    return gen < (options.iterations ?? 500) && stats.maximum < 1;
  };
  genetic.notification = (
    pop: Chromosome[],
    gen: number,
    stats: GenerationStats,
    finished: boolean
  ): void => {
    if (options.notification) options.notification(pop, gen, stats, finished);
  };

  genetic.evolve(
    {
      size: options.size ?? 100,
      iterations: options.iterations ?? 500,
    },
    { slots, participant }
  );

  const results: RankedChromosome[] = [];
  for (const e of genetic.entities) {
    results.push({ chromosome: e, fitness: genetic.fitness(e) });
  }
  return results;
}

export function runGenetic(
  slots: Slot[],
  participant: Participant[],
  options: GARunOptions = {},
  aggregator: Aggregator = meanAggregator
): Chromosome | null {
  const feasible = filterFeasibleSlots(slots, participant);
  if (feasible.length === 0) return null;

  const runs = options.restarts && options.restarts > 1 ? options.restarts : 1;
  let bestResult: Chromosome | null = null;
  let bestFitness: number | null = null;

  for (let i = 0; i < runs; i++) {
    const candidate = runSingleGenetic(slots, participant, options, aggregator);
    if (!candidate) continue;
    const score = fitness(candidate, slots, participant, aggregator);
    // ignore infeasible (zero) results so we don't accidentally return a
    // blocked slot when a feasible one exists.
    if (score === 0) continue;
    if (bestFitness === null || score > bestFitness) {
      bestFitness = score;
      bestResult = candidate;
    }
    if (bestFitness === 1) break;
  }

  return bestResult;
}

/**
 * Return the top‑N chromosomes sorted by fitness.  Useful for generating a
 * ranked list of suggestions rather than just a single best choice.
 *
 * @param slots - candidate slots
 * @param participant - meeting participants
 * @param n - number of results desired (defaults to 10)
 * @param options - GA configuration options
 * @param aggregator - fitness aggregation function
 * @returns array of objects containing `chromosome` and its `fitness`, sorted
 *   in descending order; may return fewer than `n` if there are not enough
 *   distinct candidates
 */
export function runGeneticTopN(
  slots: Slot[],
  participant: Participant[],
  n: number = 10,
  options: GARunOptions = {},
  aggregator: Aggregator = meanAggregator
): RankedChromosome[] {
  const feasible = filterFeasibleSlots(slots, participant);
  if (feasible.length === 0) return [];

  const runs = options.restarts && options.restarts > 1 ? options.restarts : 1;
  const seen = new Set<string>();
  const collected: RankedChromosome[] = [];

  for (let i = 0; i < runs; i++) {
    const pop = collectSingleGeneticPopulation(slots, participant, options, aggregator);
    for (const entry of pop) {
      const sig = JSON.stringify(entry.chromosome);
      if (!seen.has(sig)) {
        seen.add(sig);
        collected.push(entry);
      }
    }
  }

  collected.sort((a, b) => b.fitness - a.fitness);
  return collected.slice(0, n);
}

export interface Diagnostic {
  participant: string;
  reason: string;
}

/**
 * Run the genetic scheduler and, in case of failure, provide diagnostic
 * information explaining why no meeting time could be found.
 *
 * @param slots - candidate slots
 * @param participant - meeting participants
 * @param options - GA run options
 * @param aggregator - fitness aggregation function
 * @returns object containing the `result` chromosome (or null) and a list of
 *   `diagnostics` describing infeasibilities
 */
export function runGeneticDiagnostics(
  slots: Slot[],
  participant: Participant[],
  options: GARunOptions = {},
  aggregator: Aggregator = meanAggregator
): { result: Chromosome | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];

  if (participant.length === 0) {
    diagnostics.push({ participant: 'none', reason: 'no participants provided' });
    return { result: null, diagnostics };
  }

  if (slots.length === 0) {
    diagnostics.push({ participant: 'none', reason: 'no slots provided' });
    return { result: null, diagnostics };
  }

  const result = runGenetic(slots, participant, options, aggregator) as Chromosome | null;
  if (result === null) {
    for (const p of participant) {
      const slotReasons: Set<string> = new Set();
      for (const s of slots) {
        const det = getFeasibilityDetail(s, p);
        det.reasons.forEach(r => slotReasons.add(r));
      }
      if (slotReasons.size === 0) continue;
      if (slots.every(s => !getFeasibilityDetail(s, p).feasible)) {
        diagnostics.push({
          participant: p.name,
          reason: `all slots fail for ${p.name}; reasons: ${[...slotReasons].join(', ')}`,
        });
      }
    }

    for (let i = 0; i < participant.length; i++) {
      for (let j = i + 1; j < participant.length; j++) {
        const pa = participant[i];
        const pb = participant[j];
        const ok = slots.some(s =>
          getFeasibilityDetail(s, pa).feasible &&
          getFeasibilityDetail(s, pb).feasible
        );
        if (!ok) {
          diagnostics.push({
            participant: `${pa.name}&${pb.name}`,
            reason: 'pairwise incompatibility',
          });
        }
      }
    }

    diagnostics.push({ participant: 'all', reason: 'no slot satisfies everyone simultaneously' });
  }
  return { result, diagnostics };
}

export interface Meeting {
  slots: Slot[];
  participant: Participant[];
}

/**
 * Schedule a batch of meetings sequentially, updating each participant's
 * `bookedSlots` when a meeting is successfully placed.  Utilises
 * `runGenetic` for each individual meeting.
 *
 * @param meetings - array of meeting objects containing `slots` and `participant`
 * @param options - GA configuration options applied to every meeting
 * @param aggregator - fitness aggregation function
 * @returns array of results corresponding to each meeting (chromosome or
 *   null)
 */
export function runBatch(
  meetings: Meeting[],
  options: GARunOptions = {},
  aggregator: Aggregator = meanAggregator
): (Chromosome | null)[] {
  const results: (Chromosome | null)[] = [];
  for (const m of meetings) {
    const r = runGenetic(m.slots, m.participant, options, aggregator) as Chromosome | null;
    results.push(r);
    if (r) {
      const chosen = slotRange(r, m.slots);
      for (const p of m.participant) {
        p.bookedSlots = p.bookedSlots ? [...p.bookedSlots, ...chosen] : [...chosen];
      }
    }
  }
  return results;
}
