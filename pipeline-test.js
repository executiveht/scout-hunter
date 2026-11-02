
const assert = require("assert");

const {
  evaluateOpportunity
} = require("./opportunity-pipeline.js");

function makeOpportunity(overrides = {}) {
  return {
    title: "Test API automation opportunity",
    url: "https://example.com/opportunity",
    source: "test",
    amount: 500,
    currency: "USD",
    valueType: "CASH_REWARD",
    guaranteed: true,
    paymentStatus: "VERIFIED",
    fundingVerified: true,
    paymentMechanismVerified: true,
    paymentTermsVerified: true,
    eligibilityStatus: "FOUND",
    acceptanceStatus: "FOUND",
    scope: "API automation",
    estimatedHours: 4,
    activeCompetitors: 0,
    ...overrides
  };
}

function makeVerification(overrides = {}) {
  return {
    state: "PAYABLE",
    issueState: "open",
    assignee: null,
    criteria: ["Implement API automation"],
    review: {
      workScope: { status: "FOUND" },
      paymentEvidence: {
        fundingStatus: "FOUND",
        eligibilityStatus: "FOUND"
      },
      paymentEvidenceStatus: "PAYMENT_TERMS_FOUND",
      paymentVerified: true
    },
    paymentTruth: {
      rewardIntegrityStatus: "CLEAN"
    },
    relatedWork: {
      activePullRequests: [],
      activeAssignedPullRequests: [],
      implementationStatus: "NOT_STARTED"
    },
    ...overrides
  };
}

function test(name, opportunity, verification, expected) {
  const result = evaluateOpportunity(opportunity, verification);

  assert.strictEqual(
    result.nextAction,
    expected,
    `${name}: expected ${expected}, got ${result.nextAction}`
  );

  console.log(`PASS: ${name} -> ${result.nextAction}`);
}

// 1. Clean verification reaches human review, never automatic action.
test(
  "verified opportunity requires human review",
  makeOpportunity(),
  makeVerification(),
  "HUMAN_REVIEW"
);

// 2. An active PR blocks pursuit even when Hunter's score is high.
test(
  "active PR cannot be overridden by Hunter",
  makeOpportunity(),
  makeVerification({
    relatedWork: {
      activePullRequests: [{ number: 123 }],
      activeAssignedPullRequests: [],
      implementationStatus: "IN_PROGRESS"
    }
  }),
  "DO_NOT_PURSUE"
);

// 3. Missing payment verification must remain verify-first.
test(
  "unverified payment remains verify-first",
  makeOpportunity(),
  makeVerification({
    review: {
      workScope: { status: "FOUND" },
      paymentEvidence: {
        fundingStatus: "NOT_FOUND",
        eligibilityStatus: "FOUND"
      },
      paymentEvidenceStatus: "PAYMENT_TERMS_FOUND",
      paymentVerified: false
    }
  }),
  "VERIFY_FIRST"
);

// 4. Suspicious reward integrity blocks pursuit.
test(
  "suspicious reward is blocked",
  makeOpportunity(),
  makeVerification({
    paymentTruth: {
      rewardIntegrityStatus: "SUSPICIOUS_MISMATCH"
    }
  }),
  "DO_NOT_PURSUE"
);

// 5. Unknown currency cannot qualify for USD target.
{
  const result = evaluateOpportunity(
    makeOpportunity({
      amount: 250,
      currency: null
    }),
    makeVerification()
  );

  assert.strictEqual(result.financialStatus, "CURRENCY_UNSUPPORTED");
  assert.strictEqual(result.meetsFinancialTarget, false);
  assert.strictEqual(result.nextAction, "HUMAN_REVIEW");

  console.log("PASS: unknown currency cannot qualify for USD target");
}

console.log("\nALL PIPELINE TESTS PASSED");
