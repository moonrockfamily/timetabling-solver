import { runMetaGA, ParamSpec, ParamSet, MetaOptions, MetaResult } from './metaOptimizer';
import { runGenetic, fitness, estimateOptions, GARunOptions, Slot, Participant } from './index';

// --- adaptive/bulk tuning helpers ------------------------------------------------

/**
 * Automatically tune GA parameters based on a suite of representative
 * scheduling problems.  This is essentially a convenience wrapper around
 * `runMetaGA` that knows about the shape of `GARunOptions` and how to
 * evaluate them.
 */
export function tuneGAOptions(
  trainingProblems: { slots: Slot[]; participant: Participant[] }[],
  ranges: {
    size?: [number, number];
    iterations?: [number, number];
    restarts?: [number, number];
  } = {},
  metaOpts: MetaOptions = {}
): GARunOptions & { score: number } {
  const sizeRange = ranges.size ?? [10, 200];
  const iterRange = ranges.iterations ?? [10, 1000];
  const restRange = ranges.restarts ?? [1, 10];

  const specs: ParamSpec[] = [
    { name: 'size', min: sizeRange[0], max: sizeRange[1] },
    { name: 'iterations', min: iterRange[0], max: iterRange[1] },
    { name: 'restarts', min: restRange[0], max: restRange[1] },
  ];

  const evalFn = (p: ParamSet): number => {
    const opts: GARunOptions = {
      size: Math.round(p.size),
      iterations: Math.round(p.iterations),
      restarts: Math.round(p.restarts),
    };
    let total = 0;
    for (const prob of trainingProblems) {
      const best = runGenetic(prob.slots, prob.participant, opts);
      if (best) {
        total += fitness(best, prob.slots, prob.participant);
      }
    }
    return total / trainingProblems.length;
  };

  const result = runMetaGA(specs, evalFn, metaOpts);
  const tuned: GARunOptions = {
    size: Math.round(result.params.size),
    iterations: Math.round(result.params.iterations),
    restarts: Math.round(result.params.restarts),
  };
  return { ...tuned, score: result.score };
}

/**
 * Quickly adapt GA options for a single problem by sampling nearby values.
 * This is intended for real‑time, per‑instance tuning: it takes a base
 * configuration (or defaults) and evaluates a handful of perturbations,
 * returning the best performer.  It's much cheaper than running a full
 * meta‑GA and can be invoked on every scheduling request if desired.
 */
export function adaptGAOptions(
  slots: Slot[],
  participant: Participant[],
  baseOptions: GARunOptions = {},
  trials = 5,
  radius = 0.3
): GARunOptions {
  const base = { ...estimateOptions(slots, [{ participant }]), ...baseOptions };

  function perturb(value: number, min: number, max: number): number {
    const span = max - min;
    const delta = (Math.random() * 2 - 1) * span * radius;
    return Math.round(Math.min(max, Math.max(min, value + delta)));
  }

  let best = base;
  let bestScore = -Infinity;

  const minMax = {
    size: [10, 500],
    iterations: [1, 2000],
    restarts: [1, 20],
  };

  for (let i = 0; i < trials; i++) {
    const candidate: GARunOptions = {
      size: perturb(base.size ?? minMax.size[0], minMax.size[0], minMax.size[1]),
      iterations: perturb(base.iterations ?? minMax.iterations[0], minMax.iterations[0], minMax.iterations[1]),
      restarts: perturb(base.restarts ?? minMax.restarts[0], minMax.restarts[0], minMax.restarts[1]),
    };
    const sol = runGenetic(slots, participant, candidate);
    const score = sol ? fitness(sol, slots, participant) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

// --- feature extraction + modelling ---------------------------------------

export type FeatureExtractor = (
  problem: { slots: Slot[]; participant: Participant[] }
) => number[];

export const defaultFeatureExtractor: FeatureExtractor = problem => {
  const slotCount = problem.slots.length;
  const participantCount = problem.participant.length;

  // count constraints by kind so the model can distinguish, for example, a lot
  // of `NoticeConstraint` entries from a lot of `LocationConstraint` ones.
  const constraintCounts: Record<string, number> = {};
  for (const p of problem.participant) {
    const list = p.availability?.constraints ?? [];
    for (const c of list) {
      constraintCounts[c.kind] = (constraintCounts[c.kind] || 0) + 1;
    }
  }
  const timeConstraints = constraintCounts['time'] || 0;
  const noticeConstraints = constraintCounts['notice'] || 0;
  const activityConstraints = constraintCounts['activity'] || 0;
  const locationConstraints = constraintCounts['location'] || 0;
  const compositeConstraints = constraintCounts['composite'] || 0;
  const otherConstraints = Object.entries(constraintCounts)
    .filter(([k]) =>
      ![
        'time',
        'notice',
        'activity',
        'location',
        'composite',
      ].includes(k)
    )
    .reduce((acc, [,v]) => acc + v, 0);

  const bookedCount = problem.participant.reduce(
    (acc, p) => acc + (p.bookedSlots?.length ?? 0),
    0
  );
  const prefCount = problem.participant.reduce(
    (acc, p) => acc + (p.preference ? 1 : 0),
    0
  );
  const hardCount = problem.participant.reduce(
    (acc, p) => acc + (p.hardAvailability ? 1 : 0),
    0
  );
  const noticeCount = problem.participant.reduce(
    (acc, p) => acc + (p.noticeRequired ? 1 : 0),
    0
  );

  return [
    slotCount,
    participantCount,
    timeConstraints,
    noticeConstraints,
    activityConstraints,
    locationConstraints,
    compositeConstraints,
    otherConstraints,
    bookedCount,
    prefCount,
    hardCount,
    noticeCount,
  ];
};

export interface TuningModel {
  predict: (features: number[]) => GARunOptions;
  /**
   * Optional debugging information capturing the feature vector and tuned
   * options used during training.  This is primarily useful for testing and
   * diagnostics; consumers may ignore it.
   */
  entries?: { features: number[]; opts: GARunOptions }[];
}

export function buildTuningModel(
  problems: { slots: Slot[]; participant: Participant[] }[],
  featureExtractor: FeatureExtractor = defaultFeatureExtractor,
  metaOpts: MetaOptions = {}
): TuningModel {
  const entries: { features: number[]; opts: GARunOptions }[] = [];

  for (const prob of problems) {
    const tuned = tuneGAOptions([prob], {}, metaOpts);
    const { score, ...opts } = tuned as any;
    entries.push({ features: featureExtractor(prob), opts });
  }

  return {
    predict(features: number[]) {
      let best: GARunOptions = entries[0].opts;
      let bestDist = Infinity;
      for (const e of entries) {
        const dist = Math.sqrt(
          e.features.reduce((acc, v, i) => acc + Math.pow(v - (features[i] ?? 0), 2), 0)
        );
        if (dist < bestDist) {
          bestDist = dist;
          best = e.opts;
        }
      }
      return best;
    },
    // expose entries for testing/inspection
    entries,
  };
}
