import { expect } from 'chai';
import {
  defaultFeatureExtractor,
  tuneGAOptions,
  adaptGAOptions,
  buildTuningModel,
  GARunOptions,
} from '../src/index';

// the solver functions imported for convenience
import { runGenetic, preferenceScore } from '../src/index';

// minimal stub used by several tests
const slots3 = [
  { start: new Date(0), end: new Date(1) },
  { start: new Date(1), end: new Date(2) },
  { start: new Date(2), end: new Date(3) },
];
const personPrefersFirst: any = { name: 'P', preference: (s: any) => (s.start.getTime() === 0 ? 1 : 0) };

describe('tuning helpers', () => {
  it('defaultFeatureExtractor counts slots, people, constraint types and bookings', () => {
    const slots = [{ start: new Date(0), end: new Date(1) }];
    const person: any = {
      name: 'C',
      availability: { status: 'available', constraints: [{ kind: 'time', satisfies: () => true }] },
      bookedSlots: [{ start: new Date(5), end: new Date(6) }],
    };
    const feat = defaultFeatureExtractor({ slots, people: [person] });
    // slot count, people count, then five specific constraint kinds,
    // a catch-all "other" count, then booked/pref/hard/notice counts
    expect(feat).to.have.length(12);
    expect(feat[0]).to.equal(1); // slots
    expect(feat[1]).to.equal(1); // people
    expect(feat[2]).to.equal(1); // time constraints
    expect(feat[3]).to.equal(0); // notice constraints
    expect(feat[4]).to.equal(0); // activity
    expect(feat[5]).to.equal(0); // location
    expect(feat[6]).to.equal(0); // composite
    expect(feat[7]).to.equal(0); // other
    expect(feat[8]).to.equal(1); // booked
    expect(feat[9]).to.equal(0); // preference
    expect(feat[10]).to.equal(0); // hardAvailability
    expect(feat[11]).to.equal(0); // noticeRequired
  });

  it('recognizes multiple constraint kinds in feature vector', () => {
    const slots = [{ start: new Date(0), end: new Date(1) }];
    const person: any = {
      name: 'C',
      availability: {
        status: 'available',
        constraints: [
          { kind: 'time', satisfies: () => true },
          { kind: 'location', satisfies: () => true },
          { kind: 'activity', satisfies: () => true },
          { kind: 'composite', satisfies: () => true },
          { kind: 'notice', satisfies: () => true },
          { kind: 'x-custom', satisfies: () => true },
        ],
      },
    };
    const feat = defaultFeatureExtractor({ slots, people: [person] });
    expect(feat[2]).to.equal(1); // time
    expect(feat[3]).to.equal(1); // notice
    expect(feat[4]).to.equal(1); // activity
    expect(feat[5]).to.equal(1); // location
    expect(feat[6]).to.equal(1); // composite
    expect(feat[7]).to.equal(1); // other (x-custom)
  });

  it('runMetaGA can tune GA options for a trivial scheduling problem', () => {
    const tuned = tuneGAOptions(
      [
        { slots: slots3, people: [personPrefersFirst] },
        { slots: slots3, people: [personPrefersFirst] },
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
    const adapted = adaptGAOptions(slots3, [personPrefersFirst], base, 10, 0.5);
    expect(adapted.size).to.be.within(10, 500);
    expect(adapted.iterations).to.be.within(1, 2000);
    expect(adapted.restarts).to.be.within(1, 20);
  });

  it('buildTuningModel returns a simple nearest-neighbour predictor', () => {
    const slots1 = [{ start: new Date(0), end: new Date(1) }];
    const slots2 = [{ start: new Date(0), end: new Date(1) }, { start: new Date(1), end: new Date(2) }];
    const person: any = { name: 'X', preference: () => 1 };
    const problems = [
      { slots: slots1, people: [person] },
      { slots: slots2, people: [person] },
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