import { expect } from 'chai';
import { weightedMeanAggregator } from '../src/scheduler';

describe('weightedMeanAggregator', () => {
  it('returns the mean when all weights are 1', () => {
    const agg = weightedMeanAggregator([1, 1, 1]);
    expect(agg([1, 2, 3])).to.equal(2);
  });

  it('returns the weighted mean for different weights', () => {
    const agg = weightedMeanAggregator([2, 1, 1]);
    expect(agg([1, 2, 3])).to.be.closeTo((1*2 + 2*1 + 3*1) / (2+1+1), 0.0001);
  });

  it('returns 0 for empty scores', () => {
    const agg = weightedMeanAggregator([1, 1, 1]);
    expect(agg([])).to.equal(0);
  });

  it('handles zero weights gracefully', () => {
    const agg = weightedMeanAggregator([1, .5, 0]);
    expect(agg([1, 2, 3])).to.be.closeTo(1.33, .01);
  });
});
