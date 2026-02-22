import { RRuleSet } from 'rrule';
import Genetic, { GenerationStats } from 'genetic-js-no-ww';
import {
  Slot,
  evaluateAvailability,
} from './constraints';

// --- utilities -----------------------------------------------------------
export interface Person {
  name: string;
  hardAvailability?: (slot: Slot) => boolean; // returns false if slot is disallowed
  preference?: (slot: Slot) => number; // [0,1]
  rruleSet?: RRuleSet; // recurrence set for "available when"
  noticeRequired?: number; // milliseconds of advance notice
  availability?: {
    status: 'available' | 'unavailable' | 'preferred';
    constraints: any[];
  }; // high‑level status/constraints
  bookedSlots?: Slot[]; // pre-existing meetings / reservations
  minGapMs?: number; // required gap before/after any booked slot
}

export interface Chromosome {
  slotIndex: number;
  durationSlots?: number; // if provided, spans multiple consecutive slots
}

// Multi-objective genome: each meeting chooses an index
export interface MultiChromosome {
  slotIndices: number[];
  durationSlots?: number[]; // parallel array if each meeting needs a duration
}

// --- scheduling helpers --------------------------------------------------
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

export function assembleGroups(
  buyersList: Person[][],
  agent: Person,
  homeowner: Person
): Person[][] {
  return buyersList.map(buyers => [...buyers, agent, homeowner]);
}

export function weightedScalariser(weights: number[]): (scores: number[]) => number {
  return scores => {
    let tot = 0;
    for (let i = 0; i < scores.length; i++) {
      tot += scores[i] * (weights[i] ?? 1);
    }
    return tot;
  };
}

function evalTimeConstraint(slot: Slot, person: Person): boolean {
  if (!person.hardAvailability) return true;
  return person.hardAvailability(slot);
}

function evalRecurrence(slot: Slot, person: Person): boolean {
  if (!person.rruleSet) return true;
  const hits = person.rruleSet.between(slot.start, slot.end, true);
  return hits.length > 0;
}

function evalConditions(slot: Slot, person: Person): boolean {
  if (!person.noticeRequired) return true;
  const now = new Date();
  return slot.start.getTime() - now.getTime() >= person.noticeRequired;
}

function overlaps(a: Slot, b: Slot): boolean {
  return a.start < b.end && b.start < a.end;
}

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

export function getFeasibilityDetail(
  slot: Slot | Slot[],
  person: Person
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
    if (person.bookedSlots) {
      for (const b of person.bookedSlots) {
        if (overlaps(s, b)) add('overlaps booked slot');
        if (person.minGapMs) {
          if (
            s.end.getTime() > b.start.getTime() - person.minGapMs &&
            s.start.getTime() < b.end.getTime() + person.minGapMs
          ) {
            add('insufficient gap around booked slot');
          }
        }
      }
    }
    if (person.availability) {
      const ctx: any = { slot: s };
      if (!evaluateAvailability(person.availability, ctx)) {
        if (person.availability.status === 'unavailable') {
          add('unavailable status');
        } else {
          add('availability constraint');
        }
      }
    }
    if (!evalTimeConstraint(s, person)) {
      add('hard availability rejection');
    }
    if (!evalRecurrence(s, person)) {
      add('rrule mismatch');
    }
    if (!evalConditions(s, person)) {
      add('notice requirement');
    }
  }
  return { feasible: reasons.length === 0, reasons };
}

export function isFeasible(slot: Slot | Slot[], person: Person): boolean {
  return getFeasibilityDetail(slot, person).feasible;
}

export function preferenceScore(slot: Slot, person: Person): number {
  let base = person.preference ? Math.max(0, Math.min(1, person.preference(slot))) : 1;
  if (person.availability?.status === 'preferred') {
    base = Math.min(1, base + 0.1);
  }
  return base;
}

// --- GA-specific glue ----------------------------------------------------
export function fitnessMulti(
  genome: MultiChromosome,
  slots: Slot[],
  peopleGroups: Person[][]
): number[] {
  return genome.slotIndices.map((idx, i) => {
    const group = peopleGroups[i] || [];
    const chrom: Chromosome = { slotIndex: idx };
    if (genome.durationSlots && genome.durationSlots[i]) {
      chrom.durationSlots = genome.durationSlots[i];
    }
    return fitness(chrom, slots, group);
  });
}

function runSingleGeneticMulti(
  slots: Slot[],
  peopleGroups: Person[][],
  options: GARunOptions,
  scalariser: (scores: number[]) => number,
  _trace?: GenerationStats[]
): MultiChromosome | null {
  const n = peopleGroups.length;
  const genetic = Genetic.create<MultiChromosome, { slots: Slot[]; peopleGroups: Person[][] }>();
  genetic.optimize = Genetic.Optimize.Maximize;

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
  ): MultiChromosome => {
    const child: MultiChromosome = { slotIndices: [] };
    for (let i = 0; i < n; i++) {
      child.slotIndices.push(Math.random() < 0.5 ? a.slotIndices[i] : b.slotIndices[i]);
    }
    return child;
  };
  genetic.fitness = (g: MultiChromosome): number => {
    const vec = fitnessMulti(g, slots, peopleGroups);
    return scalariser(vec);
  };
  genetic.generation = (_pop: any, gen: number, stats: any): boolean =>
    gen < (options.iterations ?? 500) && stats.max < 1;
  genetic.notification = (_pop: any, gen: number, stats: any, finished: boolean): void => {
    if (options.notification) options.notification(_pop, gen, stats, finished);
  };

  genetic.evolve(
    {
      size: options.size ?? 100,
      iterations: options.iterations ?? 500,
    },
    { slots, peopleGroups }
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

export function runGeneticMulti(
  slots: Slot[],
  peopleGroups: Person[][],
  options: GARunOptions = {},
  scalariser: (scores: number[]) => number = scores => {
    if (scores.length === 0) return 0;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }
): MultiChromosome | null {
  const feasible = slots.filter(s =>
    peopleGroups.every(pg => pg.every(p => isFeasible(s, p)))
  );
  if (feasible.length === 0) return null;

  const runs = options.restarts && options.restarts > 1 ? options.restarts : 1;
  let bestResult: MultiChromosome | null = null;
  let bestFitness: number | null = null;

  for (let i = 0; i < runs; i++) {
    const candidate = runSingleGeneticMulti(slots, peopleGroups, options, scalariser);
    if (!candidate) continue;
    const score = scalariser(fitnessMulti(candidate, slots, peopleGroups));
    if (bestFitness === null || score > bestFitness) {
      bestFitness = score;
      bestResult = candidate;
    }
    if (bestFitness === 1) break;
  }

  return bestResult;
}

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

export function crossoverGenome(
  a: Chromosome,
  b: Chromosome
): Chromosome {
  const parent = Math.random() < 0.5 ? a : b;
  return { ...parent };
}

export function filterFeasibleSlots(slots: Slot[], people: Person[]): Slot[] {
  return slots.filter(s => people.every(p => isFeasible(s, p)));
}

export type Aggregator = (scores: number[]) => number;

export function defaultAggregator(scores: number[]): number {
  if (scores.length === 0) return 1;
  return Math.min(...scores);
}

export function fitness(
  genome: Chromosome,
  slots: Slot[],
  people: Person[],
  aggregator: Aggregator = defaultAggregator
): number {
  const range = slotRange(genome, slots);
  const prefs: number[] = [];
  for (const p of people) {
    if (!isFeasible(range, p)) {
      return 0;
    }
    const scores = range.map(s => preferenceScore(s, p));
    prefs.push(scores.reduce((a,b)=>a+b,0)/scores.length);
  }
  const result = aggregator(prefs);
  return Math.max(0, Math.min(1, result));
}

export interface GARunOptions {
  size?: number;
  iterations?: number;
  maxDurationSlots?: number; // if provided, solutions may span multiple slots
  restarts?: number;
  notification?: (pop: unknown[], gen: number, stats: GenerationStats, finished: boolean) => void;
}

export function estimateOptions(
  slots: Slot[],
  meetings: { people: Person[] }[] = []
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
function runSingleGenetic(
  slots: Slot[],
  people: Person[],
  options: GARunOptions,
  aggregator: Aggregator,
  _trace?: GenerationStats[]
): Chromosome | null {
  const genetic = Genetic.create<Chromosome, { slots: Slot[]; people: Person[] }>();
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
  genetic.crossover = (a: Chromosome, b: Chromosome): Chromosome => {
    return Math.random() < 0.5 ? a : b;
  };
  genetic.fitness = (g: Chromosome): number => fitness(g, slots, people, aggregator);
  genetic.generation = (
    pop: Chromosome[],
    gen: number,
    stats: GenerationStats
  ): boolean => {
    if (options.notification) options.notification(pop, gen, stats, false);
    return gen < (options.iterations ?? 500) && stats.max < 1;
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
    { slots, people }
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

export function runGenetic(
  slots: Slot[],
  people: Person[],
  options: GARunOptions = {},
  aggregator: Aggregator = defaultAggregator
): Chromosome | null {
  const feasible = filterFeasibleSlots(slots, people);
  if (feasible.length === 0) return null;

  const runs = options.restarts && options.restarts > 1 ? options.restarts : 1;
  let bestResult: Chromosome | null = null;
  let bestFitness: number | null = null;

  for (let i = 0; i < runs; i++) {
    const candidate = runSingleGenetic(slots, people, options, aggregator);
    if (!candidate) continue;
    const score = fitness(candidate, slots, people, aggregator);
    if (bestFitness === null || score > bestFitness) {
      bestFitness = score;
      bestResult = candidate;
    }
    if (bestFitness === 1) break;
  }

  return bestResult;
}

export interface Diagnostic {
  person: string;
  reason: string;
}

export function runGeneticDiagnostics(
  slots: Slot[],
  people: Person[],
  options: GARunOptions = {},
  aggregator: Aggregator = defaultAggregator
): { result: Chromosome | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];

  if (people.length === 0) {
    diagnostics.push({ person: 'none', reason: 'no participants provided' });
    return { result: null, diagnostics };
  }

  if (slots.length === 0) {
    diagnostics.push({ person: 'none', reason: 'no slots provided' });
    return { result: null, diagnostics };
  }

  const result = runGenetic(slots, people, options, aggregator) as Chromosome | null;
  if (result === null) {
    for (const p of people) {
      const slotReasons: Set<string> = new Set();
      for (const s of slots) {
        const det = getFeasibilityDetail(s, p);
        det.reasons.forEach(r => slotReasons.add(r));
      }
      if (slotReasons.size === 0) continue;
      if (slots.every(s => !getFeasibilityDetail(s, p).feasible)) {
        diagnostics.push({
          person: p.name,
          reason: `all slots fail for ${p.name}; reasons: ${[...slotReasons].join(', ')}`,
        });
      }
    }

    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const pa = people[i];
        const pb = people[j];
        const ok = slots.some(s =>
          getFeasibilityDetail(s, pa).feasible &&
          getFeasibilityDetail(s, pb).feasible
        );
        if (!ok) {
          diagnostics.push({
            person: `${pa.name}&${pb.name}`,
            reason: 'pairwise incompatibility',
          });
        }
      }
    }

    diagnostics.push({ person: 'all', reason: 'no slot satisfies everyone simultaneously' });
  }
  return { result, diagnostics };
}

export interface Meeting {
  slots: Slot[];
  people: Person[];
}

export function runBatch(
  meetings: Meeting[],
  options: GARunOptions = {},
  aggregator: Aggregator = defaultAggregator
): (Chromosome | null)[] {
  const results: (Chromosome | null)[] = [];
  for (const m of meetings) {
    const r = runGenetic(m.slots, m.people, options, aggregator) as Chromosome | null;
    results.push(r);
    if (r) {
      const chosen = slotRange(r, m.slots);
      for (const p of m.people) {
        p.bookedSlots = p.bookedSlots ? [...p.bookedSlots, ...chosen] : [...chosen];
      }
    }
  }
  return results;
}
