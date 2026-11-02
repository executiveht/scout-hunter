const assert = require("assert");
const { buildOpportunityDecision } = require("./scout.js");

function baseVerification(overrides = {}) {
  return {
    state: "PAYABLE",
    issueState: "open",
    assignee: null,
    criteria: ["Complete the requested implementation"],
    relatedWork: {
      activePullRequests: [],
      activeAssignedPullRequests: [],
      implementationStatus: "NO_ACTIVE_PR"
    },
    review: {
      paymentVerified: false,
      paymentEvidenceStatus: "NO_PAYMENT_LANGUAGE",
      paymentEvidence: {
        fundingStatus: "NOT_FOUND",
        eligibilityStatus: "NOT_FOUND"
      }
    },
    ...overrides
  };
}

function run(name, verification, expected) {
  const result = buildOpportunityDecision(verification);

  assert.strictEqual(
    result.decision,
    expected,
    `${name}: expected ${expected}, got ${result.decision}`
  );

  console.log(`PASS: ${name} -> ${result.decision}`);
}

// 1. Active PRs must block pursuit.
run(
  "active PRs block pursuit",
  baseVerification({
    relatedWork: {
      activePullRequests: [
        { number: 1234, state: "open", draft: false }
      ],
      activeAssignedPullRequests: [],
      implementationStatus: "IN_PROGRESS"
    }
  }),
  "DO_NOT_PURSUE"
);

// 2. Assigned active PRs must block pursuit.
run(
  "assigned active PR blocks pursuit",
  baseVerification({
    relatedWork: {
      activePullRequests: [
        { number: 1234, state: "open", draft: false }
      ],
      activeAssignedPullRequests: [
        { number: 1234, state: "open", draft: false }
      ],
      implementationStatus: "IN_PROGRESS"
    }
  }),
  "DO_NOT_PURSUE"
);

// 3. No PRs + missing payment verification must remain VERIFY_FIRST.
run(
  "unverified payment remains verify-first",
  baseVerification(),
  "VERIFY_FIRST"
);

// 4. Even apparently complete evidence cannot bypass the human payment gate.
run(
  "human payment gate blocks automatic pursuit",
  baseVerification({
    review: {
      paymentVerified: false,
      paymentEvidenceStatus: "PAYMENT_TERMS_FOUND",
      paymentEvidence: {
        fundingStatus: "FOUND",
        eligibilityStatus: "FOUND"
      }
    }
  }),
  "VERIFY_FIRST"
);

// 5. Only an explicitly human-verified opportunity can reach PURSUE_NOW.
run(
  "fully verified opportunity can pursue",
  baseVerification({
    review: {
      paymentVerified: true,
      paymentEvidenceStatus: "PAYMENT_TERMS_FOUND",
      paymentEvidence: {
        fundingStatus: "FOUND",
        eligibilityStatus: "FOUND",
        rewardIntegrityStatus: "CLEAN"
      }
    }
  }),
  "PURSUE_NOW"
);

// 6. Suspicious reward integrity must block pursuit even when every
// other payment and eligibility gate is satisfied.
run(
  "suspicious reward integrity blocks pursuit",
  baseVerification({
    review: {
      paymentVerified: true,
      paymentEvidenceStatus: "PAYMENT_TERMS_FOUND",
      paymentEvidence: {
        fundingStatus: "FOUND",
        eligibilityStatus: "FOUND",
        rewardIntegrityStatus: "SUSPICIOUS_MISMATCH"
      }
    }
  }),
  "DO_NOT_PURSUE"
);

console.log("\nALL REGRESSION TESTS PASSED");
