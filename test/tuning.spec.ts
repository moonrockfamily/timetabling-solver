import { expect } from 'chai';
import { addMinutes } from 'date-fns/fp';
import {
  defaultFeatureExtractor,
  tuneGAOptions,
  adaptGAOptions,
  buildTuningModel,
  GARunOptions,
  Rule,
} from '../src/index';

// the solver functions imported for convenience
import { runGenetic, preferenceScore } from '../src/index';

// helper for creating small minute-based dates
const minutesSinceEpoch = (n: number) => addMinutes(n)(new Date(0));

// minimal stub used by several tests
const slots3 = [
  { start: minutesSinceEpoch(0), end: minutesSinceEpoch(1) },
  { start: minutesSinceEpoch(1), end: minutesSinceEpoch(2) },
  { start: minutesSinceEpoch(2), end: minutesSinceEpoch(3) },
];
const participantPrefersFirst: any = { name: 'P', preference: (s: any) => (s.start.getTime() === minutesSinceEpoch(0).getTime() ? 1 : 0) };

describe('tuning helpers', () => {
  it('defaultFeatureExtractor counts slots, participants, rules and rule hints', () => {
    const slots = [{ start: new Date(0), end: new Date(1) }];
    const participant: any = {
      name: 'C',
      // a single constant rule; inference should mark it as not depending on
      // slot or now.
      rules: [() => 1],
      bookedSlots: [{ start: new Date(5), end: new Date(6) }],
    };
    const feat = defaultFeatureExtractor({ slots, participant: [participant] });
    // slots, participants, rules, slotDeps, nowDeps, booked, pref, hard,
    // notice
    expect(feat).to.have.length(9);
    expect(feat[0]).to.equal(1); // slots
    expect(feat[1]).to.equal(1); // participant
    expect(feat[2]).to.equal(1); // rule count
    expect(feat[3]).to.equal(0); // slot-dependent rules
    expect(feat[4]).to.equal(0); // now-dependent rules
    expect(feat[5]).to.equal(1); // booked
    expect(feat[6]).to.equal(0); // preference
    expect(feat[7]).to.equal(0); // hardAvailability
    expect(feat[8]).to.equal(0); // noticeRequired
  });

  it('recognizes rule counts and dependency hints', () => {
    const slots = [{ start: new Date(0), end: new Date(1) }];
    // build a variety of rules so we can test hint counting
    const slotRule = new Rule((ctx: any) =>
      ctx.start ? 1 : 0
    );
    const nowRule = new Rule((ctx: any) =>
      ctx.now ? 1 : 0
    );
    const bothRule = new Rule((ctx: any) =>
      ctx.start && ctx.now ? 1 : 0
    );
    const plainRule = () => 1; // no hints
    const participant: any = {
      name: 'C',
      rules: [slotRule, nowRule, bothRule, plainRule],
    };
    const feat = defaultFeatureExtractor({ slots, participant: [participant] });
    expect(feat[2]).to.equal(4); // total rule count
    expect(feat[3]).to.equal(2); // slot-dependent rules (slotRule + bothRule)
    expect(feat[4]).to.equal(2); // now-dependent rules (nowRule + bothRule)
  });

  it('runMetaGA can tune GA options for a trivial scheduling problem', function() {
    // this operation may take slightly longer on CI; allow more time
    this.timeout(5000);
    const tuned = tuneGAOptions(
      [
        { slots: slots3, participant: [participantPrefersFirst] },
        { slots: slots3, participant: [participantPrefersFirst] },
      ],
      { size: [5, 50], iterations: [5, 100], restarts: [1, 5] },
      { populationSize: 10, iterations: 20 }
    );
    expect(tuned.size).to.be.within(5, 50);
    expect(tuned.iterations).to.be.within(5, 100);
    expect(tuned.restarts).to.be.within(1, 5);
    expect(tuned.score).to.be.greaterThan(0);
  });

  it('adaptGAOptions tweaks a base configuration for a single problem', () => {
    const base: GARunOptions = { size: 10, iterations: 10, restarts: 1 };
    const adapted = adaptGAOptions(slots3, [participantPrefersFirst], base, 10, 0.5);
    expect(adapted.size).to.be.within(10, 500);
    expect(adapted.iterations).to.be.within(1, 2000);
    expect(adapted.restarts).to.be.within(1, 20);
  });

  it('buildTuningModel returns a simple nearest-neighbour predictor', function() {
    // the model construction can be slightly slow in CI; allow more time
    this.timeout(5000);
    const slots1 = [{ start: new Date(0), end: new Date(1) }];
    const slots2 = [{ start: new Date(0), end: new Date(1) }, { start: new Date(1), end: new Date(2) }];
    const participant: any = { name: 'X', preference: () => 1 };
    const problems = [
      { slots: slots1, participant: [participant] },
      { slots: slots2, participant: [participant] },
    ];

    // build model from training problems
    const model = buildTuningModel(problems);

    // entries should be exposed for testing purposes; there must be one entry
    // per training problem.
    expect(model.entries).to.exist;
    const tunedOptions = model.entries!;
    expect(tunedOptions).to.have.length(2);

    // features corresponding to the first problem should predict the first set
    const features1 = defaultFeatureExtractor(problems[0]);
    const features2 = defaultFeatureExtractor(problems[1]);
    expect(model.predict(features1)).to.deep.equal(tunedOptions[0].opts);
    expect(model.predict(features2)).to.deep.equal(tunedOptions[1].opts);

    // slightly perturbed feature (closer to problem1) should still give opts[0]
    const near1 = features1.map(f => f + 0.1);
    expect(model.predict(near1)).to.deep.equal(tunedOptions[0].opts);

    // assert return objects at least contain expected keys
    const opt1 = model.predict(features1);
    const opt2 = model.predict(features2);
    expect(opt1).to.have.keys(['size', 'iterations', 'restarts']);
    expect(opt2).to.have.keys(['size', 'iterations', 'restarts']);
  });
});