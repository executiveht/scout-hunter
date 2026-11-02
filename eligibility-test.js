const assert = require("assert");
const { buildPaymentTruth } = require("./scout.js");

function test(name, verification, expected) {
  const result = buildPaymentTruth(verification);

  assert.strictEqual(
    result.eligibilityStatus,
    expected,
    `${name}: expected ${expected}, got ${result.eligibilityStatus}`
  );

  console.log(`PASS: ${name} -> ${result.eligibilityStatus}`);
}

const base = {
  reward: 100,
  state: "PAYABLE",
  issueState: "open",
  assignee: null,
  title: "Test bounty",
  body: "Reward: $100",
  relatedWork: {
    related: []
  }
};

// 1. A claim command alone is not eligibility proof.
test(
  "claim command alone",
  {
    ...base,
    body: "Reward: $100\nComment /claim to lock this task for 24 hours."
  },
  "NOT_FOUND"
);

// 2. Explicit open eligibility is valid evidence.
test(
  "open to anyone",
  {
    ...base,
    body: "Reward: $100\nThis bounty is open to anyone."
  },
  "FOUND"
);

const evidenceResult = buildPaymentTruth({
  ...base,
  body: "Reward: $100\nThis bounty is open to anyone."
});

assert(
  evidenceResult.eligibilityEvidence.includes(
    "This bounty is open to anyone."
  ),
  "Eligibility evidence should be returned"
);

console.log("PASS: eligibility evidence is preserved");


// 3. A linked issue containing only /claim is not eligibility proof.
test(
  "linked issue claim command alone",
  {
    ...base,
    relatedWork: {
      related: [
        {
          kind: "issue",
          title: "Claim instructions",
          body: "Comment /claim to lock the task for 24 hours."
        }
      ]
    }
  },
  "NOT_FOUND"
);

// 4. Explicit eligibility in a linked issue is valid evidence.
test(
  "linked issue open eligibility",
  {
    ...base,
    relatedWork: {
      related: [
        {
          kind: "issue",
          title: "Eligibility",
          body: "Any contributor may participate."
        }
      ]
    }
  },
  "FOUND"
);

console.log("\nALL ELIGIBILITY TESTS PASSED");