// well-known score values for availability/preference rules.  since all
// rules return numbers in the range [0,1], these constants make it easier to
// give meaningful names to common values and improve readability in examples
// and application code.

export const Score = {
  Infeasible: 0 as const,    // slot must not be chosen
  Neutral: 0.5 as const,     // slot is allowed but not especially desired
  Preferred: 1 as const,     // slot is maximally preferred
};
