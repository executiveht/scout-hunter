const {
  buildOpportunityDecision
} = require("./scout.js");

const {
  scoreOpportunity
} = require("./hunter.js");

const {
  isCashOpportunity
} = require("./opportunity-schema.js");

const FINANCIAL_TARGET_USD = 100;

function classifyFinancialTarget(opportunity) {
  if (!isCashOpportunity(opportunity)) {
    return {
      financialStatus: "NON_CASH",
      meetsFinancialTarget: false
    };
  }

  const amount = opportunity.value?.amount;

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      financialStatus: "INVALID_OR_MISSING",
      meetsFinancialTarget: false
    };
  }

  const currency = opportunity.value?.currency;

  if (currency !== "USD") {
    return {
      financialStatus: "CURRENCY_UNSUPPORTED",
      meetsFinancialTarget: false
    };
  }

  const meetsFinancialTarget = amount >= FINANCIAL_TARGET_USD;

  return {
    financialStatus: meetsFinancialTarget
      ? "MEETS_TARGET"
      : "BELOW_TARGET",
    meetsFinancialTarget
  };
}

function evaluateOpportunity(opportunityInput, verification) {
  if (!opportunityInput || typeof opportunityInput !== "object") {
    throw new TypeError("opportunityInput must be an object");
  }

  if (!verification || typeof verification !== "object") {
    throw new TypeError("verification must be an object");
  }

  // Scout owns the verification and safety decision.
  const scoutDecision = buildOpportunityDecision(verification);

  // Hunter scores the opportunity independently.
  const opportunity = scoreOpportunity(opportunityInput);

  // Financial classification is informational only.
  const financialEligibility =
    classifyFinancialTarget(opportunity);

  // A score can never override Scout's safety decision.
  let nextAction;

  if (scoutDecision.decision === "DO_NOT_PURSUE") {
    nextAction = "DO_NOT_PURSUE";
  } else if (scoutDecision.decision === "VERIFY_FIRST") {
    nextAction = "VERIFY_FIRST";
  } else if (scoutDecision.decision === "PURSUE_NOW") {
    // Human review is still required before taking action.
    nextAction = "HUMAN_REVIEW";
  } else {
    // Fail closed if Scout returns an unexpected decision.
    nextAction = "DO_NOT_PURSUE";
  }

  return {
    opportunity,
    scoutDecision: scoutDecision.decision,
    confidence: scoutDecision.confidence,
    reasons: scoutDecision.reasons,
    hunterScore: opportunity.scores.hunter,
    hunterRecommendation: opportunity.actionRecommendation,
    financialStatus: financialEligibility.financialStatus,
    meetsFinancialTarget: financialEligibility.meetsFinancialTarget,
    nextAction
  };
}

function rankEvaluatedOpportunities(items = []) {
  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        throw new TypeError("Each item must be an object");
      }

      return evaluateOpportunity(
        item.opportunity,
        item.verification
      );
    })
    .sort((a, b) => {
      // Safety decisions take priority over numerical ranking.
      const priority = {
        HUMAN_REVIEW: 3,
        VERIFY_FIRST: 2,
        DO_NOT_PURSUE: 1
      };

      const actionDifference =
        priority[b.nextAction] - priority[a.nextAction];

      if (actionDifference !== 0) {
        return actionDifference;
      }

      return b.hunterScore - a.hunterScore;
    });
}

module.exports = {
  evaluateOpportunity,
  rankEvaluatedOpportunities,
  classifyFinancialTarget
};