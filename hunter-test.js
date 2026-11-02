
const assert = require("assert");

const {
  calculatePaymentConfidence,
  calculateActionRecommendation
} = require("./hunter.js");

function makeOpportunity(overrides = {}) {
  return {
    payment: {
      fundingVerified: false,
      mechanismVerified: false,
      termsVerified: false
    },
    eligibility: { status: "FOUND" },
    acceptance: { status: "FOUND" },
    ...overrides
  };
}

function run(name, opportunity, expected) {
  const actual = calculateActionRecommendation(opportunity);

  assert.strictEqual(
    actual,
    expected,
    `${name}: expected ${expected}, got ${actual}`
  );

  console.log(`PASS: ${name} -> ${actual}`);
}

// 1. No verified payment evidence.
const unverified = makeOpportunity();

assert.strictEqual(
  calculatePaymentConfidence(unverified),
  "UNVERIFIED"
);

run(
  "unverified payment requires verification",
  unverified,
  "VERIFY_PAYMENT"
);

// 2. Verified payment, but eligibility is incomplete.
const incompleteEligibility = makeOpportunity({
  payment: {
    fundingVerified: true,
    mechanismVerified: true,
    termsVerified: true
  },
  eligibility: { status: "UNKNOWN" }
});

assert.strictEqual(
  calculatePaymentConfidence(incompleteEligibility),
  "VERIFIED"
);

run(
  "incomplete eligibility requires investigation",
  incompleteEligibility,
  "INVESTIGATE"
);

// 3. Payment and eligibility verified, but acceptance is incomplete.
const incompleteAcceptance = makeOpportunity({
  payment: {
    fundingVerified: true,
    mechanismVerified: true,
    termsVerified: true
  },
  acceptance: { status: "UNKNOWN" }
});

run(
  "incomplete acceptance requires investigation",
  incompleteAcceptance,
  "INVESTIGATE"
);

// 4. All three evidence groups meet the current function's criteria.
const readyForReview = makeOpportunity({
  payment: {
    fundingVerified: true,
    mechanismVerified: true,
    termsVerified: true
  }
});

run(
  "verified evidence proceeds to human review",
  readyForReview,
  "REVIEW"
);

console.log("\nALL HUNTER TESTS PASSED");
