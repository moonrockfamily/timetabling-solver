declare module 'genetic-js-no-ww' {
  /**
   * Comparison helpers provided by the library.  Users pick the one matching
   * their goal and assign it to `genetic.optimize`.
   */
  export interface OptimizeFns {
    /** return `true` when `a` is better than `b` for maximization problems */
    Maximize: (a: number, b: number) => boolean;
    /** return `true` when `a` is better than `b` for minimization problems */
    Minimize: (a: number, b: number) => boolean;
  }

  /**
   * statistics object passed to the generation/notification callbacks
   */
  export interface GenerationStats {
    /** highest fitness value in the current population */
    maximum: number;
    /** lowest fitness value in the current population */
    minimum: number;
    /** arithmetic mean fitness among members */
    mean: number;
    /** sample standard deviation of fitness values */
    stdev: number;
    // additional stats may be added by the library; use unknown for safety
    [key: string]: unknown;
  }

  /**
   * Callback invoked at the end of every generation.  Returning `false`
   * terminates the evolution prematurely, `true` continues.  The `pop` array
   * contains the current population, `gen` is the generation index, and
   * `stats` offers summary statistics for the population.
   */
  export type GenerationFn<T> = (pop: T[], gen: number, stats: GenerationStats) => boolean;

  /**
   * Notification callback similar to `GenerationFn` but with a final `finished`
   * flag to indicate whether the run has completed.  Useful for logging or
   * UI updates.
   */
  export type NotificationFn<T> = (pop: T[], gen: number, stats: GenerationStats, finished: boolean) => void;

  /**
   * Options passed to `genetic.evolve`.  In addition to `size` and
   * `iterations` this object may carry any user-defined fields which are
   * propagated to callbacks via `userData`.
   */
  export interface RunOptions {
    /** population size */
    size?: number;
    /** maximum number of generations */
    iterations?: number;
    /** not used by library; exported for shuttle compatibility */
    maxDurationSlots?: number;
    // allow extras without permitting arbitrary `any`
    [key: string]: unknown;
  }

  export interface Genetic<T, U> {
    /**
     * Comparison function used to decide whether a candidate is 'better' than
     * another.  `Maximize` yields `true` when the first argument exceeds the
     * second; `Minimize` does the opposite.  This is assigned directly to
     * `genetic.optimize` by users wishing to control the optimisation goal.
     */
    optimize: (a: number, b: number) => boolean;

    /**
     * Produce a fresh random genome of type `T`.  Called once per entity when
     * the population is seeded at the start of a run.
     */
    seed: () => T;

    /**
     * Introduce random variation into a chromosome.  Given an existing genome
     * `g`, return a new genome that is a (typically small) modification of it.
     * The implementation is entirely application-specific.
     */
    mutate: (g: T) => T;

    /**
     * Combine two parent genomes into one or two offspring.  The library
     * expects either a single child or an array of two children; internally it
     * will call `.map` on the result, hence the union type.
     */
    crossover: (a: T, b: T) => T | T[];

    /**
     * Compute the fitness value of a genome.  Must return a numeric score
     * (typically in [0,1]) indicating how 'good' the candidate is.  Higher is
     * better when using `Optimize.Maximize`.
     */
    fitness: (g: T) => number;

    /**
     * Generation callback invoked at the end of each generation.  Return
     * `true` to continue evolving, or `false` to terminate early.  Receives the
     * current population, generation number, and summary statistics.
     */
    generation: GenerationFn<T>;

    /**
     * Notification callback called every generation as well, the difference
     * being that it has an additional `finished` flag indicating whether the
     * run has completed.  Often used for logging or UI updates.
     */
    notification: NotificationFn<T>;

    /**
     * Kick off evolution.  Accepts a `RunOptions` object as defined above,
     * plus optional user data that will be made available to callbacks via the
     * `userData` argument.
     */
    evolve: (options: RunOptions, userData?: U) => void;

    /**
* Optional selection function invoked when the engine needs **one** genome
   * from the current population.  If you supply `select1`, its return value
   * will typically be used as one of the inputs to `crossover`, but the
   * library does not guarantee whether it is the "first" or "second" parent.
   * This hook is simply a way to override the default selection mechanism.
   */
    select1?: (pop: any) => T;

    /**
   * Optional selector that returns a **pair** of genomes.  When provided the
   * library will call this function once and use both returned individuals for
   * crossover.  It is therefore more convenient when you want to choose
   * parents jointly (e.g. ensuring they are distinct).
     */
    select2?: (pop: any) => [T, T];

    /**
     * Current population of genomes.  Exposed primarily for testing or
     * inspection; typically users do not manipulate this directly.
     */
    entities: T[];
  }
  export function create<T, U>(): Genetic<T, U>;
  /**
   * Predefined selection strategies supplied by the library.  Each function
   * accepts the current population (`pop`) and returns one or two selected
   * individuals depending on context.
   */
  interface SelectFunctions {
    /**
     * Perform a two‑way tournament: randomly sample two members of the
     * population, compare their `.fitness` values using the current
     * `optimize` function, and return the associated `.entity` of the winner.
     * Because it samples each parent independently it can return the same
     * individual twice.
     */
    Tournament2: (pop: any) => any;
    /**
     * Three‑way tournament: sample three members, pick the best of the first
     * two, then compare that winner against the third.  Returns the `.entity`
     * of the overall winner.  Provides stronger selection pressure than
     * `Tournament2`.
     */
    Tournament3: (pop: any) => any;
    /**
     * Return the first entry in `pop`, which is assumed to be the fittest
     * (the library sorts the population before selection).  Useful for
     * elitism or debugging, but if used for every parent the population will
     * quickly converge prematurely.
     */
    Fittest: (pop: any) => any;
    /**
     * Uniform random selection: choose an element from the array entirely at
     * random, ignoring fitness.  This can be paired with a stronger second
     * selector to maintain diversity.
     */
    Random: (pop: any) => any;
    /**
     * Random selection with a slowly increasing upper bound.  The first call
     * is restricted to the first element, the second call can choose among
     * the first two, and so on, up to the full population.  This gives early
     * iterations a stronger bias toward high‑fitness individuals while still
     * allowing random picks later.
     */
    RandomLinearRank: (pop: any) => any;
    /**
     * Deterministic round‑robin selection: cycles through the population in
     * order, returning a different entity each time (wrapping when it reaches
     * the end).  Handy for reproducible tests.
     */
    Sequential: (pop: any) => any;
  }
  const Genetic: {
    create: typeof create;
    Optimize: OptimizeFns;
    Select1: SelectFunctions;
    Select2: SelectFunctions;
  };
  export default Genetic;
}