const value = (base, exponent) => Math.pow(base, exponent).toLocaleString('en-US');

const recalled = (base, exponent, technique, label) => ({
  technique,
  label,
  steps: [
    `${base}^${exponent} is an anchor worth recalling`,
    `${base}^${exponent} = ${value(base, exponent)}`,
  ],
  fallback: false,
});

/** Return a deterministic fast-math lesson for one supported powers pair. */
export function powersBreakdown(base, exponent) {
  if (base === 2 && exponent >= 2 && exponent <= 10) {
    return recalled(base, exponent, 'recall-2', 'Powers of 2 — recall table');
  }
  if ((base === 3 && exponent >= 2 && exponent <= 5)
    || (base === 5 && exponent >= 2 && exponent <= 4)
    || ((base === 7 || base === 9) && exponent === 2)) {
    return recalled(base, exponent, 'recall-small', 'Small squares & cubes');
  }
  if (base === 2 && exponent >= 11 && exponent <= 16) {
    const steps = ['2^10 = 1,024'];
    for (let power = 11; power <= exponent; power += 1) {
      steps.push(`× 2 → 2^${power} = ${value(2, power)}`);
    }
    return { technique: 'double-chain', label: 'Double up from 2^10', steps, fallback: false };
  }
  if (base === 5 && exponent >= 5 && exponent <= 7) {
    return {
      technique: 'halve-shift',
      label: 'Use 5^n = 10^n / 2^n',
      steps: [
        `5^${exponent} = 10^${exponent} ÷ 2^${exponent}`,
        `${value(10, exponent)} ÷ ${value(2, exponent)} = ${value(5, exponent)}`,
      ],
      fallback: false,
    };
  }
  if (base === 3 && exponent >= 6 && exponent <= 9) {
    const anchor = exponent >= 8 ? 4 : 3;
    const remainder = exponent - anchor;
    return {
      technique: 'split-exponent',
      label: 'Split the exponent from an anchor',
      steps: [
        `3^${exponent} = 3^${anchor} × 3^${remainder}`,
        `${value(3, anchor)} × ${value(3, remainder)} = ${value(3, exponent)}`,
      ],
      fallback: false,
    };
  }
  if (base === 5 && exponent >= 8 && exponent <= 10) {
    const remainder = exponent - 8;
    const steps = [
      '5^4 = 625 (anchor)',
      '5^8 = 625 × 625 = 390,625',
    ];
    if (remainder > 0) {
      steps.push(`5^${exponent} = 390,625 × ${value(5, remainder)} = ${value(5, exponent)}`);
    }
    return { technique: 'split-exponent', label: 'Split the exponent from an anchor', steps, fallback: false };
  }
  return {
    technique: null,
    label: 'No fast path is defined',
    steps: [`${base}^${exponent} = ${value(base, exponent)}`],
    fallback: true,
  };
}

export function powersBreakdownFromPrompt(prompt) {
  const match = typeof prompt === 'string' ? prompt.match(/^(\d+)\^(\d+)$/) : null;
  return match ? powersBreakdown(Number(match[1]), Number(match[2])) : null;
}
