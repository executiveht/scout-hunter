"use strict";

const {
  OPPORTUNITY_TYPES,
  createOpportunity,
  isCashOpportunity,
  isLeverageOpportunity
} = require("./opportunity-schema");

/**
 * Generalized Opportunity Hunter
 *
 * READ-ONLY.
 * No claims, comments, PRs, submissions, purchases,
 * payments, exploitation, or external mutations.
 */

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function calculateExpectedValue(opportunity) {
  const amount = opportunity?.value?.amount;

  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }

  let probability = 0.10;

  if (opportunity.payment?.fundingVerified) {
    probability += 0.30;
  }

  if (opportunity.payment?.mechanismVerified) {
    probability += 0.20;
  }

  if (opportunity.eligibility?.status === "FOUND") {
    probability += 0.10;
  }

  if (opportunity.acceptance?.status === "FOUND") {
    probability += 0.10;
  }

  if (opportunity.value?.guaranteed) {
    probability += 0.10;
  }

  if (opportunity.value?.type === OPPORTUNITY_TYPES.CREDIT) {
    probability *= 0.15;
  }

  if (opportunity.value?.type === OPPORTUNITY_TYPES.VOUCHER) {
    probability *= 0.35;
  }

  if (opportunity.value?.type === OPPORTUNITY_TYPES.GRANT) {
    probability *= 0.25;
  }

  if (opportunity.value?.type === OPPORTUNITY_TYPES.EQUITY) {
    probability *= 0.10;
  }

  return Math.round(amount * clamp(probability, 0, 1));
}

function calculateSpeed(opportunity) {
  let score = 50;

  if (isCashOpportunity(opportunity)) {
    if (opportunity.payment?.mechanismVerified) score += 30;
    else score += 10;
  }

  if (opportunity.value?.guaranteed) score += 10;

  if (opportunity.payment?.fundingVerified) score += 10;
  else score -= 10;

  if (opportunity.work?.estimatedHours != null) {
    if (opportunity.work.estimatedHours <= 4) score += 10;
    else if (opportunity.work.estimatedHours >= 40) score -= 15;
  }

  if (opportunity.value?.type === OPPORTUNITY_TYPES.CREDIT) score -= 35;
  if (opportunity.value?.type === OPPORTUNITY_TYPES.GRANT) score -= 20;
  if (opportunity.value?.type === OPPORTUNITY_TYPES.EQUITY) score -= 30;

  return clamp(score);
}

function calculateFriction(opportunity) {
  let score = 0;

  if (!opportunity.url) score += 20;
  if (!opportunity.eligibility?.status ||
      opportunity.eligibility.status === "UNKNOWN") {
    score += 15;
  }

  if (!opportunity.acceptance?.status ||
      opportunity.acceptance.status === "UNKNOWN") {
    score += 15;
  }

  if (!opportunity.payment?.fundingVerified) score += 20;
  if (!opportunity.payment?.mechanismVerified) score += 15;
  if (!opportunity.payment?.termsVerified) score += 10;

const competitors =
  opportunity.competition?.activeCompetitors ??
  opportunity.activeCompetitors;

  if (Number.isFinite(competitors)) {
    if (competitors >= 20) score += 40;
    else if (competitors >= 11) score += 30;
    else if (competitors >= 6) score += 20;
    else if (competitors >= 3) score += 10;
  }
  return clamp(score);
}

function calculateRisk(opportunity) {
  let score = 0;

  if (!opportunity.payment?.fundingVerified) score += 30;
  if (!opportunity.payment?.mechanismVerified) score += 20;
  if (!opportunity.payment?.termsVerified) score += 15;

  if (opportunity.value?.maximum &&
      opportunity.value.maximum !== opportunity.value.amount) {
    score += 10;
  }

  if (opportunity.value?.type === OPPORTUNITY_TYPES.CREDIT) {
    score += 20;
  }

  if (opportunity.value?.type === OPPORTUNITY_TYPES.EQUITY) {
    score += 30;
  }

  return clamp(score);
}

function calculatePaymentConfidence(opportunity) {
  const payment = opportunity?.payment;

  if (!payment) {
    return "UNVERIFIED";
  }

  // An explicit unverified status must not be overridden.
  if (payment.status === "UNVERIFIED") {
    return "UNVERIFIED";
  }

  const checks = [
    payment.fundingVerified,
    payment.mechanismVerified,
    payment.termsVerified
  ];

  const verifiedCount = checks.filter(value => value === true).length;

  if (verifiedCount === 3) {
    return "VERIFIED";
  }

  if (verifiedCount > 0) {
    return "PARTIAL";
  }

  return "UNVERIFIED";
}

function calculateCashPriority(opportunity) {
  const amount = opportunity?.value?.amount;

  if (!Number.isFinite(amount) || amount <= 0) {
    return -30;
  }

  // Our current hunting floor:
  // $100+ = primary target
  // $50-$99 = only worth considering if exceptionally fast/easy
  // under $50 = ignore
  if (amount >= 100) {
    if (amount >= 500) return 25;
    if (amount >= 250) return 20;
    return 15;
  }

  if (amount >= 50) {
    return -10;
  }

  return -35;
}
function calculateROI(opportunity) {
  const value = opportunity?.value?.amount || 0;
  const hours = opportunity?.work?.estimatedHours;

  if (!value || !hours || hours <= 0) {
    return null;
  }

  return Math.round(value / hours);
}

function calculateHunterScore(opportunity, unclamped = false) {
 if (opportunity.status === "REJECTED") {
    return 0;
  }
  const expectedValue = calculateExpectedValue(opportunity);
  const speed = calculateSpeed(opportunity);
  const friction = calculateFriction(opportunity);
  const risk = calculateRisk(opportunity);
  const roi = calculateROI(opportunity);
const cashPriority = calculateCashPriority(opportunity);

  /*
   * Deliberately asymmetric:
   * verified cash + speed beats flashy theoretical value.
   */
let score =
    Math.min(expectedValue / 20, 20) +
    speed * 0.20 +
    Math.min(Math.log10(1 + (roi || 0)) * 15, 35) +
    cashPriority -
    friction * 0.20 -
    risk * 0.25;

  if (opportunity.value?.type === OPPORTUNITY_TYPES.CASH_REWARD) {
    score += 10;
  }

  if (opportunity.value?.type === OPPORTUNITY_TYPES.CONTRACT_VALUE) {
    score += 5;
  }

  if (isLeverageOpportunity(opportunity)) {
    score -= 5;
  }

  return unclamped
  ? Math.round(score)
  : Math.round(clamp(score));
}

function calculateActionRecommendation(opportunity) {
  const paymentConfidence = calculatePaymentConfidence(opportunity);

  if (paymentConfidence !== "VERIFIED") {
    return "VERIFY_PAYMENT";
  }

  if (
    opportunity.eligibility?.status !== "FOUND" ||
    opportunity.acceptance?.status !== "FOUND"
  ) {
    return "INVESTIGATE";
  }

  return "REVIEW";
}

function scoreOpportunity(input) {
  const opportunity =
    input?.value && input?.payment
      ? { ...input }
      : createOpportunity(input);

  opportunity.scores = {
    expectedValue: calculateExpectedValue(opportunity),
    speed: calculateSpeed(opportunity),
    roi: calculateROI(opportunity),
    friction: calculateFriction(opportunity),
    risk: calculateRisk(opportunity),
    hunter: 0
  };

  opportunity.scores.hunterRaw = calculateHunterScore(opportunity, true);
opportunity.scores.hunter = calculateHunterScore(opportunity);
opportunity.actionRecommendation =
  calculateActionRecommendation(opportunity);
  opportunity.updatedAt = new Date().toISOString();

  return opportunity;
}


function rankOpportunities(opportunities = []) {
  return [...opportunities]
    .map(scoreOpportunity)
    .sort((a, b) => {
      const hunterDifference =
        (b.scores?.hunter ?? 0) -
        (a.scores?.hunter ?? 0);

      if (hunterDifference !== 0) {
        return hunterDifference;
      }

      const rawDifference =
        (b.scores?.hunterRaw ?? 0) -
        (a.scores?.hunterRaw ?? 0);

      if (rawDifference !== 0) {
        return rawDifference;
      }

      const aROI = a.scores?.roi;
      const bROI = b.scores?.roi;

      if (Number.isFinite(aROI) && Number.isFinite(bROI)) {
        return bROI - aROI;
      }

      if (Number.isFinite(bROI)) return 1;
      if (Number.isFinite(aROI)) return -1;

      return 0;
    });
}


module.exports = {
  calculateActionRecommendation,
  calculateExpectedValue,
  calculateSpeed,
  calculateFriction,
  calculatePaymentConfidence,
  calculateRisk,
  calculateROI,
  calculateHunterScore,
  scoreOpportunity,
  rankOpportunities
};


if (require.main === module) {
  const tests = [
    {
      source: "test",
      url: "https://example.com/test",
      title: "$500 / 4 hours",
      amount: 500,
      currency: "USD",
      valueType: OPPORTUNITY_TYPES.CASH_REWARD,
      guaranteed: true,
      paymentStatus: "VERIFIED",
      fundingVerified: true,
      paymentMechanismVerified: true,
      paymentTermsVerified: true,
      eligibilityStatus: "FOUND",
      acceptanceStatus: "FOUND",
      scope: "Simple bug fix",
      estimatedHours: 4,
      activeCompetitors: 1
    },

    {
      source: "test",
      url: "https://example.com/test",
      title: "$200 / 2 hours",
      amount: 200,
      currency: "USD",
      valueType: OPPORTUNITY_TYPES.CASH_REWARD,
      guaranteed: true,
      paymentStatus: "VERIFIED",
      fundingVerified: true,
      paymentMechanismVerified: true,
      paymentTermsVerified: true,
      eligibilityStatus: "FOUND",
      acceptanceStatus: "FOUND",
      scope: "Very small bug fix",
      estimatedHours: 2,
      activeCompetitors: 1
    },


    {
      source: "test",
      url: "https://example.com/test",
      title: "$500 / 40 hours",
      amount: 500,
      currency: "USD",
      valueType: OPPORTUNITY_TYPES.CASH_REWARD,
      guaranteed: true,
      paymentStatus: "VERIFIED",
      fundingVerified: true,
      paymentMechanismVerified: true,
      paymentTermsVerified: true,
      eligibilityStatus: "FOUND",
      acceptanceStatus: "FOUND",
      scope: "Large feature",
      estimatedHours: 40,
      activeCompetitors: 1
    },

    {
      source: "test",
      url: "https://example.com/test",
      title: "$200 / 10 hours",
      amount: 200,
      currency: "USD",
      valueType: OPPORTUNITY_TYPES.CASH_REWARD,
      guaranteed: true,
      paymentStatus: "VERIFIED",
      fundingVerified: true,
      paymentMechanismVerified: true,
      paymentTermsVerified: true,
      eligibilityStatus: "FOUND",
      acceptanceStatus: "FOUND",
      scope: "Moderate feature",
      estimatedHours: 10,
      activeCompetitors: 1
    },


    {
      source: "test",
      url: "https://example.com/unverified",
      title: "$2,000 / payment unverified",
      amount: 2000,
      currency: "USD",
      valueType: OPPORTUNITY_TYPES.CASH_REWARD,
      guaranteed: false,
      paymentStatus: "UNVERIFIED",
      fundingVerified: false,
      paymentMechanismVerified: false,
      paymentTermsVerified: false,
      eligibilityStatus: "FOUND",
      acceptanceStatus: "FOUND",
      scope: "Large integration project",
      estimatedHours: 20,
      activeCompetitors: 1
    },
    {
      source: "test",
      url: "https://example.com/competition",
      title: "$750 / heavy competition",
      amount: 750,
      currency: "USD",
      valueType: OPPORTUNITY_TYPES.CASH_REWARD,
      guaranteed: true,
      paymentStatus: "VERIFIED",
      fundingVerified: true,
      paymentMechanismVerified: true,
      paymentTermsVerified: true,
      eligibilityStatus: "FOUND",
      acceptanceStatus: "FOUND",
      scope: "API integration",
      estimatedHours: 8,
      activeCompetitors: 12
    },
    {
      source: "test",
      url: "https://example.com/contract",
      title: "$1,000 / verified contract",
      amount: 1000,
      currency: "USD",
      valueType: OPPORTUNITY_TYPES.CONTRACT_VALUE,
      guaranteed: true,
      paymentStatus: "VERIFIED",
      fundingVerified: true,
      paymentMechanismVerified: true,
      paymentTermsVerified: true,
      eligibilityStatus: "FOUND",
      acceptanceStatus: "FOUND",
      scope: "Node.js API automation",
      estimatedHours: 10,
      activeCompetitors: 2
    }
  ];


  console.log("\n=== HUNTER HOURS / ROI TEST ===\n");

  const ranked = rankOpportunities(tests);

  ranked.forEach((opportunity, index) => {
    console.log(
      `${index + 1}. ${opportunity.title} | ` +
      `Hunter=${opportunity.scores.hunter} | ` +
      `Raw=${opportunity.scores.hunterRaw} | ` +
      `EV=${opportunity.scores.expectedValue} | ` +
      `ROI=${opportunity.scores.roi} | ` +
      `Speed=${opportunity.scores.speed} | ` +
      `Risk=${opportunity.scores.risk} | ` +
      `Payment=${calculatePaymentConfidence(opportunity)} | ` +
`Action=${opportunity.actionRecommendation}`
    );
  });

}
