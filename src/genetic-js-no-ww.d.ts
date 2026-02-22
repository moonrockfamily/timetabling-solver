declare module 'genetic-js-no-ww' {
  export interface OptimizeFns {
    Maximize: (a: number, b: number) => boolean;
    Minimize: (a: number, b: number) => boolean;
  }

  /**
   * statistics object passed to the generation/notification callbacks
   */
  export interface GenerationStats {
    max: number;
    min: number;
    average: number;
    // additional stats may be added by the library; use unknown for safety
    [key: string]: unknown;
  }

  export type GenerationFn<T> = (pop: T[], gen: number, stats: GenerationStats) => boolean;
  export type NotificationFn<T> = (pop: T[], gen: number, stats: GenerationStats, finished: boolean) => void;

  export interface RunOptions {
    size?: number;
    iterations?: number;
    maxDurationSlots?: number;
    // allow extras without permitting arbitrary `any`
    [key: string]: unknown;
  }

  export interface Genetic<T, U> {
    optimize: (a: number, b: number) => boolean;
    seed: () => T;
    mutate: (g: T) => T;
    // crossover should return one or two offspring; the library maps over the
    // results, expecting an array when "size" > 1.
    crossover: (a: T, b: T) => T | T[];
    fitness: (g: T) => number;
    generation: GenerationFn<T>;
    notification: NotificationFn<T>;
    evolve: (options: RunOptions, userData?: U) => void;
    // selection helpers; library will call these if provided
    select1?: (pop: any) => T;
    select2?: (pop: any) => [T, T];
    // internal state exposed for convenience tests
    entities: T[];
  }
  export function create<T, U>(): Genetic<T, U>;
  interface SelectFunctions {
    Tournament2: (pop: any) => any;
    Tournament3: (pop: any) => any;
    Fittest: (pop: any) => any;
    Random: (pop: any) => any;
    RandomLinearRank: (pop: any) => any;
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