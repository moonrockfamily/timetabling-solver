import { expect } from 'chai';
import { runMetaGA, ParamSpec } from '../src/index';

describe('meta-optimizer helpers', () => {
  it('runMetaGA can tune a simple one-dimensional problem', () => {
    const specs: ParamSpec[] = [{ name: 'x', min: 0, max: 10 }];
    // our `evaluate` function defines the objective that the meta‑GA will
    // maximise.  here we use a downward‑opening parabola centred at 5, so the
    // best parameter is x=5.  the sign is flipped since runMetaGA always
    // maximises the returned score.
    const result = runMetaGA(
      specs,
      /* evaluate */ (p: any) => {
        // note: p.x is guaranteed to be between 0 and 10
        return -Math.pow(p.x - 5, 2);
      },
      {
        populationSize: 10,
        iterations: 20,
      }
    );
    // result may vary due to randomness; expect it to be in the central
    // portion of the range rather than at one extreme.
    expect(result.params.x).to.be.within(2, 8);
    expect(result.score).to.be.a('number');
  });

  it('runMetaGA can also optimise a two-parameter quadratic', () => {
    const specs: ParamSpec[] = [
      { name: 'x', min: 0, max: 10 },
      { name: 'y', min: -5, max: 5 },
    ];
    // this evaluate callback combines two independent parabolas: the x-term
    // is centred at 3, the y-term at -1.  the meta‑GA searches the 2‑D box of
    // possible (x,y) values to find the maximum of the negative sum, which
    // occurs at (3, -1).
    const result = runMetaGA(
      specs,
      /* evaluate */ (p: any) => {
        return -Math.pow(p.x - 3, 2) - Math.pow(p.y + 1, 2);
      },
      {
        populationSize: 20,
        iterations: 30,
      }
    );
    expect(result.params.x).to.be.closeTo(3, 1);
    expect(result.params.y).to.be.closeTo(-1, 1);
  });
});