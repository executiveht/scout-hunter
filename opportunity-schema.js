"use strict";

/**
 * Common opportunity model.
 *
 * This layer is intentionally source-agnostic.
 * Existing scout.js remains untouched.
 */

const OPPORTUNITY_TYPES = Object.freeze({
  CASH_REWARD: "CASH_REWARD",
  CONTRACT_VALUE: "CONTRACT_VALUE",
  PARTNER_INCENTIVE: "PARTNER_INCENTIVE",
  VOUCHER: "VOUCHER",
  CREDIT: "CREDIT",
  GRANT: "GRANT",
  EQUITY: "EQUITY",
  PRIZE: "PRIZE"
});

const OPPORTUNITY_STATUSES = Object.freeze({
  DISCOVERED: "DISCOVERED",
  VERIFYING: "VERIFYING",
  VERIFIED: "VERIFIED",
  ACTIONABLE: "ACTIONABLE",
  HUMAN_REVIEW: "HUMAN_REVIEW",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED"
});

function createOpportunity(input = {}) {
  return {
    id: input.id || null,

    source: input.source || null,
    sourceType: input.sourceType || null,

    title: input.title || null,
    url: input.url || null,

    value: {
      amount: Number.isFinite(input.amount) ? input.amount : null,
      currency: input.currency || null,
      type: input.valueType || null,
      maximum: Number.isFinite(input.maximum) ? input.maximum : null,
      guaranteed: input.guaranteed === true
    },

    payment: {
      status: input.paymentStatus || "UNKNOWN",
      fundingVerified: input.fundingVerified === true,
      mechanismVerified: input.paymentMechanismVerified === true,
      termsVerified: input.paymentTermsVerified === true
    },

    eligibility: {
      status: input.eligibilityStatus || "UNKNOWN",
      evidence: input.eligibilityEvidence || []
    },

    acceptance: {
      status: input.acceptanceStatus || "UNKNOWN",
      evidence: input.acceptanceEvidence || []
    },

    work: {
      scope: input.scope || null,
      estimatedHours: Number.isFinite(input.estimatedHours)
        ? input.estimatedHours
        : null,
      skills: Array.isArray(input.skills) ? input.skills : []
    },

    competition: {
      activeCompetitors: Number.isFinite(input.activeCompetitors)
        ? input.activeCompetitors
        : null,
      freshness: input.freshness || null
    },

    evidence: Array.isArray(input.evidence) ? input.evidence : [],

    scores: {
      expectedValue: null,
      speed: null,
      roi: null,
      friction: null,
      risk: null,
      hunter: null
    },

    status: input.status || OPPORTUNITY_STATUSES.DISCOVERED,

    discoveredAt: input.discoveredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function isCashOpportunity(opportunity) {
  return opportunity?.value?.type === OPPORTUNITY_TYPES.CASH_REWARD ||
         opportunity?.value?.type === OPPORTUNITY_TYPES.CONTRACT_VALUE;
}

function isLeverageOpportunity(opportunity) {
  return [
    OPPORTUNITY_TYPES.PARTNER_INCENTIVE,
    OPPORTUNITY_TYPES.VOUCHER,
    OPPORTUNITY_TYPES.CREDIT,
    OPPORTUNITY_TYPES.GRANT,
    OPPORTUNITY_TYPES.EQUITY,
    OPPORTUNITY_TYPES.PRIZE
  ].includes(opportunity?.value?.type);
}

module.exports = {
  OPPORTUNITY_TYPES,
  OPPORTUNITY_STATUSES,
  createOpportunity,
  isCashOpportunity,
  isLeverageOpportunity
};
