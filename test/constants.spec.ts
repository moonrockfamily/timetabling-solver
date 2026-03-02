import { expect } from 'chai';
import { Score } from '../src/index';

describe('exported constants', () => {
  it('Score object contains sensible values', () => {
    expect(Score).to.have.property('Infeasible', 0);
    expect(Score).to.have.property('Neutral', 0.5);
    expect(Score).to.have.property('Preferred', 1);
  });
});
