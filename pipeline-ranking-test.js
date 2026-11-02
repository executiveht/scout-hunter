
const assert = require("assert");

const {
  rankEvaluatedOpportunities
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

const ranked = rankEvaluatedOpportunities([
  {
    // High-value opportunity, but an active PR blocks pursuit.
    opportunity: makeOpportunity({
      title: "High-value blocked opportunity",
      amount: 5000,
      estimatedHours: 1
    }),
    verification: makeVerification({
      relatedWork: {
        activePullRequests: [{ number: 123 }],
        activeAssignedPullRequests: [],
        implementationStatus: "IN_PROGRESS"
      }
    })
  },
  {
    // Verified opportunity: human review is still required.
    opportunity: makeOpportunity({
      title: "Verified opportunity",
      amount: 100,
      estimatedHours: 40
    }),
    verification: makeVerification()
  },
  {
    // Payment evidence is incomplete.
    opportunity: makeOpportunity({
      title: "Payment verification needed",
      amount: 1000
    }),
    verification: makeVerification({
      review: {
        workScope: { status: "FOUND" },
        paymentEvidence: {
          fundingStatus: "NOT_FOUND",
          eligibilityStatus: "FOUND"
        },
        paymentEvidenceStatus: "PAYMENT_TERMS_FOUND",
        paymentVerified: false
      }
    })
  }
]);

const actions = ranked.map(item => item.nextAction);

assert.deepStrictEqual(
  actions,
  ["HUMAN_REVIEW", "VERIFY_FIRST", "DO_NOT_PURSUE"],
  `Unexpected ranking order: ${actions.join(", ")}`
);

const blocked = ranked.find(
  item => item.opportunity.title === "High-value blocked opportunity"
);

assert.strictEqual(
  blocked.nextAction,
  "DO_NOT_PURSUE"
);

console.log("Ranking order:");
ranked.forEach((item, index) => {
  console.log(
    `${index + 1}. ${item.opportunity.title} | ` +
    `Hunter=${item.hunterScore} | ${item.nextAction}`
  );
});

console.log("\nPASS: Scout safety decisions control ranking priority");
console.log("ALL PIPELINE RANKING TESTS PASSED");
