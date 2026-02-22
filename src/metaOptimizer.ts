import Genetic from 'genetic-js-no-ww';

/**
 * A single tunable parameter, defined by a numeric range.  The meta‑optimizer
 * works with *normalized* genomes (arrays of numbers in [0,1]); the helper
 * below converts back and forth between that representation and a named set
 * of concrete values.
 */
export interface ParamSpec {
  /** short identifier for the parameter */
  name: string;
  /** inclusive lower bound */
  min: number;
  /** inclusive upper bound */
  max: number;
}

/**
 * A concrete assignment of parameter values.
 */
export type ParamSet = Record<string, number>;

/**
 * Options controlling the meta‑GA itself.  By default it uses a very small GA
 * (population 20, iterations 20) since tuning runs are typically expensive.
 */
export interface MetaOptions {
  populationSize?: number;
  iterations?: number;
  /** probability that a given gene is perturbed when mutating */
  mutationRate?: number;
  /** probability of swapping each gene during crossover */
  crossoverRate?: number;
}

/**
 * Result returned by the meta‑optimizer after evolving.
 */
export interface MetaResult {
  params: ParamSet;
  score: number;
}

// helpers ---------------------------------------------------------------

function denormalize(genome: number[], specs: ParamSpec[]): ParamSet {
  const result: ParamSet = {};
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    result[s.name] = s.min + genome[i] * (s.max - s.min);
  }
  return result;
}

function randomGenome(length: number): number[] {
  const g: number[] = [];
  for (let i = 0; i < length; i++) g.push(Math.random());
  return g;
}

/**
 * A generic meta‑genetic optimizer.  You supply a set of parameter
 * specifications and an evaluation function that maps a concrete `ParamSet`
 * to a numeric score (higher is considered "better").  The function returns
 * the best parameter set found after the specified number of iterations.
 *
 * The implementation is deliberately minimal; the `MetaOptions` allow you to
 * control population size, number of generations and simple mutation/crossover
 * rates.  Because the exact nature of the parameters varies by application,
 * the only thing the meta‑GA knows about is how to convert a normalized
 * genome into real parameter values using `ParamSpec`.
 *
 * This module is intended as a clean foundation upon which you could build
 * more sophisticated tuning workflows (training on a problem suite, logging
 * history, adaptive mutation schedules, etc.) while keeping the core logic
 * DRY.  The same pattern can also be reused to tune non-GA parameters such as
 * slot generation intervals, preference weightings, or anything else that can
 * be represented with numeric ranges.
 */
export function runMetaGA(
  specs: ParamSpec[],
  evaluate: (params: ParamSet) => number,
  options: MetaOptions = {}
): MetaResult {
  const popSize = options.populationSize ?? 20;
  const iters = options.iterations ?? 20;
  const mutRate = options.mutationRate ?? 0.1;
  const crossRate = options.crossoverRate ?? 0.5;

  const genetic = Genetic.create<number[], {}>();
  genetic.optimize = Genetic.Optimize.Maximize;
  // ensure selection functions exist so we don't crash when crossover/mutation
  genetic.select1 = Genetic.Select1.Tournament2;
  genetic.select2 = Genetic.Select2.Tournament2;

  genetic.seed = (): number[] => randomGenome(specs.length);

  genetic.mutate = (g: number[]): number[] => {
    // defensive: if we somehow receive a non‑iterable (null, number, etc.)
    // just return it unchanged.  The library occasionally passes weird
    // values during certain operations, and we don’t want a crash.
    if (!g || typeof (g as any)[Symbol.iterator] !== 'function') {
      return g as any;
    }
    const out = [...g];
    for (let i = 0; i < out.length; i++) {
      if (Math.random() < mutRate) {
        // small perturbation around current value
        out[i] = Math.min(1, Math.max(0, out[i] + (Math.random() - 0.5) * 0.2));
      }
    }
    return out;
  };

  genetic.crossover = (
    a: number[] | undefined,
    b: number[] | undefined
  ): number[][] => {
    // return two children; handle missing parents gracefully
    if (!Array.isArray(a)) return [a ?? [], a ?? []];
    if (!Array.isArray(b)) return [a, a];
    const child1 = [...a];
    const child2 = [...b];
    for (let i = 0; i < child1.length; i++) {
      if (Math.random() < crossRate) {
        // swap genes
        child1[i] = b[i];
        child2[i] = a[i];
      }
    }
    return [child1, child2];
  };

  genetic.fitness = (g: number[] | undefined): number => {
    if (!g || g.length !== specs.length) {
      // malformed genome; treat as worst possible
      return -Infinity;
    }
    const params = denormalize(g, specs);
    return evaluate(params);
  };

  genetic.evolve({ size: popSize, iterations: iters }, {});

  // pick best entity
  let best: number[] | null = null;
  let bestScore = -Infinity;
  for (const e of genetic.entities) {
    const score = genetic.fitness(e);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  if (!best) {
    throw new Error('meta‑optimizer produced no candidates');
  }
  return { params: denormalize(best, specs), score: bestScore };
}
