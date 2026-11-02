require("dotenv").config();

const fs = require("fs");

const {
  OPPORTUNITY_TYPES,
  createOpportunity
} = require("./opportunity-schema");


const SEARCH_URL =
  "https://api.github.com/search/issues?q=is%3Aopen+is%3Aissue+%28bounty+OR+%22bounty%22+OR+%22cash+reward%22+OR+%22cash%22%29+-repo%3Azhangjiayang6835-cyber%2Fbounty-plaza";
const GITHUB_API = "https://api.github.com";
const CACHE_FILE = ".verification-cache.json";
const MAX_CANDIDATES = 15;
const GITHUB_RATE_LIMIT_FILE = ".github-rate-limit.json";
const MAX_GITHUB_VERIFICATIONS = 10;
const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const QUEUE_FILE = ".opportunity-queue.json";
const VERIFIED_QUEUE_FILE = ".verified-opportunity-queue.json";
const MAX_REASONABLE_REWARD = 1_000_000;
function isReasonableReward(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_REASONABLE_REWARD;
}


const VALID_QUEUE_STATUSES = new Set([
  "NEW",
  "VERIFY_PAYMENT",
  "REVIEWED",
  "SKIP",
  "EXPIRED"
]);

function headers() {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "opportunity-scout",
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
  };
}

function githubRateLimitReset() {
  try {
    const data = JSON.parse(fs.readFileSync(GITHUB_RATE_LIMIT_FILE, "utf8"));
    return Number(data.resetAt);
  } catch {
    return null;
  }
}

function saveGithubRateLimitReset(resetAt) {
  if (!Number.isFinite(resetAt)) return;
  fs.writeFileSync(
    GITHUB_RATE_LIMIT_FILE,
    JSON.stringify({ resetAt }, null, 2)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForGithubRetry() {
  const resetAt = githubRateLimitReset();

  if (!Number.isFinite(resetAt)) {
    return false;
  }

  const waitMs = resetAt - Date.now();

  if (waitMs <= 0) {
    return false;
  }

  if (waitMs > 60000) {
    return false;
  }

  console.log(
    `GitHub rate limit reset soon. Waiting ${Math.ceil(waitMs / 1000)} seconds...`
  );

  await sleep(waitMs + 1000);

  return true;
}

async function github(url) {
  const knownReset = githubRateLimitReset();

  if (Number.isFinite(knownReset) && Date.now() < knownReset) {
    throw new Error(
      `GitHub rate limit exhausted; resets at ${new Date(knownReset).toISOString()}`
    );
  }

  const response = await fetch(url, { headers: headers() });

  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");

    if (remaining === "0" || response.status === 429) {
      const resetAt = reset ? Number(reset) * 1000 : null;
      saveGithubRateLimitReset(resetAt);

      const resetText = Number.isFinite(resetAt)
        ? new Date(resetAt).toISOString()
        : "unknown";

      if (await waitForGithubRetry()) {
        return github(url);
      }

      throw new Error(`GitHub rate limit exhausted; resets at ${resetText}`);
    }
  }

  if (!response.ok) {
    throw new Error(`GitHub HTTP ${response.status}`);
  }

  return response.json();
}

async function inspectRepositoryFunding(repo) {
  const result = {
    checked: false,
    repo,
    signals: [],
    fundingUrls: [],
    paymentPolicyFound: false,
    paymentPolicyUrls: [],
    paymentPolicyEvidence: [],
    verified: false,
    error: null
  };

  try {
    const repository = await github(
      `${GITHUB_API}/repos/${repo}`
    );

    result.checked = true;

    const bountyConfig = await github(
      `${GITHUB_API}/repos/${repo}/contents/BOUNTY_CONFIG.json`
    );

    if (bountyConfig?.content) {
      try {
        const configText = Buffer.from(
          bountyConfig.content,
          bountyConfig.encoding || "base64"
        ).toString("utf8");

        result.signals.push("BOUNTY_CONFIG.json found");

        if (/\btreasury\b/i.test(configText)) {
          result.signals.push("bounty treasury configured");
        }

        if (/\bpayout\b/i.test(configText)) {
          result.signals.push("payout conditions configured");
        }

        result.fundingUrls.push(
          `${GITHUB_API}/repos/${repo}/contents/BOUNTY_CONFIG.json`
        );
      } catch {
        result.signals.push("BOUNTY_CONFIG.json unreadable");
      }
    }

    const policyCandidates = [
      "REWARD_POLICY.md",
      "REWARD_POLICY.en.md"
    ];

    for (const policyFile of policyCandidates) {
      try {
        const policy = await github(
          `${GITHUB_API}/repos/${repo}/contents/${policyFile}`
        );

        if (!policy?.content) {
          continue;
        }

        const policyText = Buffer.from(
          policy.content,
          policy.encoding || "base64"
        ).toString("utf8");

        result.paymentPolicyFound = true;

        const policyUrl =
          `${GITHUB_API}/repos/${repo}/contents/${policyFile}`;

        result.paymentPolicyUrls.push(policyUrl);

        const policyLines = policyText
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean);

        const evidenceLines = policyLines.filter(line =>
          /(?:cash|redeem|reward|bounty|payment|payout|withdraw)/i.test(line)
        );

        result.paymentPolicyEvidence.push(
          ...evidenceLines.slice(0, 12)
        );
      } catch (error) {
        result.signals.push(
          `${policyFile} lookup failed: ${error.message}`
        );
      }
    }

    if (result.paymentPolicyFound) {
      result.paymentPolicyEvidence = [
        ...new Set(result.paymentPolicyEvidence)
      ];
    }

    const fundingUrls = [
      ...(Array.isArray(repository?.funding_links)
        ? repository.funding_links
        : []),
      ...(Array.isArray(repository?.topics)
        ? repository.topics
            .filter(topic =>
              /fund|bounty|sponsor|payment|escrow/i.test(topic)
            )
            .map(topic => `topic:${topic}`)
        : [])
    ];

    if (repository?.has_discussions) {
      result.signals.push("github discussions enabled");
    }

    if (repository?.homepage) {
      result.fundingUrls.push(repository.homepage);
    }

    result.fundingUrls.push(...fundingUrls);

    result.signals.push(
      ...detectFundingSources(
        JSON.stringify(repository)
      )
    );

    result.signals = [...new Set(result.signals)];
    result.fundingUrls = [...new Set(result.fundingUrls)];
    result.paymentPolicyUrls = [
      ...new Set(result.paymentPolicyUrls)
    ];

    return result;
  } catch (error) {
    result.error = error.message;
    return result;
  }
}
function moneyFromText(text) {
  const matches = [...String(text || "").matchAll(/\$(\d+(?:,\d{3})*(?:\.\d+)?)/g)];

  if (!matches.length) return null;

const values = matches
    .map(m => m[1])
    .filter(Boolean)
    .map(value => Number(value.replace(/,/g, "")))
    .filter(value => Number.isFinite(value) && value <= 1_000_000);

  if (!values.length) return null;

  return Math.max(...values);
}

function currencyFromText(text, amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const source = String(text || "");
  const amountPattern = /\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g;
  const currencies = new Set();

  const codes = [
    ["USD", /\bUSD\b|US\$/i],
    ["CAD", /\bCAD\b|C\$/i],
    ["AUD", /\bAUD\b|A\$/i],
    ["NZD", /\bNZD\b|NZ\$/i],
    ["SGD", /\bSGD\b|(?<![A-Z])S\$/i],
    ["HKD", /\bHKD\b|HK\$/i]
  ];

  for (const match of source.matchAll(amountPattern)) {
    const foundAmount = Number(match[1].replace(/,/g, ""));

    if (foundAmount !== amount) {
      continue;
    }

    const before = source.slice(
  Math.max(0, match.index - 12),
  match.index + 1
);
    const after = source.slice(
      match.index + match[0].length,
      match.index + match[0].length + 12
    );

    const context = `${before} ${after}`;

    const found = codes
      .filter(([, pattern]) => pattern.test(context))
      .map(([code]) => code);

    if (found.length !== 1) {
      return null;
    }

    currencies.add(found[0]);
  }

  return currencies.size === 1
    ? [...currencies][0]
    : null;
}
function repoFromIssue(issue) {
  if (!issue?.repository_url) {
    throw new Error(
      `Missing repository_url for issue: ${issue?.title || "UNKNOWN"}`
    );
  }

  return issue.repository_url.replace(
    "https://api.github.com/repos/",
    ""
  );
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function criteria(body) {
  return body
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x =>
      /acceptance|criteria|must|should|require|deliver|implementation|test|performance/i.test(
        x
      )
    )
    .slice(0, 10);
}

function parseRadar(body) {
  const match = body.match(/New SN OPEN_BOUNTY detected:\s*```[\r\n]+([^\r\n]+)[\r\n]+```/i);
  if (!match) return null;
  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 12) return null;
  return {
    bountyId: parts[0],
    community: parts[1],
    type: parts[2],
    difficulty: Number(parts[3]),
    valueSats: Number(parts[4]),
    activity: Number(parts[5]),
    score: Number(parts[6]),
    sourceId: parts[7],
    age: Number(parts[8]),
    feed: parts[9],
    signals: parts[10],
    title: parts.slice(11).join(" ")
  };
}
function initialState(body, reward) {
  const t = body.toLowerCase();

  if (/dry[- ]run|test fixture|fixture|demo|simulation|no paid offer|not a paid offer|no monetary payment|points only|non[- ]monetary|reputation only/.test(t)) {
    return "NO_MONEY";
  }

  if (/fund your own|must fund|pay upfront|purchase required|buy first/.test(t)) {
    return "UPFRONT_COST";
  }

  if (/signups?\s+closed|applications?\s+closed|claim(?:s)?\s+closed|capacity\s+full|no longer accepting/.test(t)) {
    return "BLOCKED";
  }

  if (!reward) {
    return "VERIFY_PAYMENT";
  }

  return "VERIFY";
}

function collectPaymentEvidence(title, body) {
  const text = String(title || '') + '\n' + String(body || '');

  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const looksLikePatternCatalog = line => {
    const quotedTerms = (line.match(/["ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½][^"ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½]+["ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½]/g) || []).length;
    const commaCount = (line.match(/,/g) || []).length;
    const pipeCount = (line.match(/\|/g) || []).length;

    const catalogMarkers = [
      /\bpattern(?:s)?\b/i,
      /\bexample(?:s)?\b/i,
      /\bkeywords?\b/i,
      /\bsearch\s+terms?\b/i,
      /\bmatch(?:es|ing)?\b/i,
      /\bregex(?:es)?\b/i,
      /\bvocabulary\b/i,
      /\bpossible\s+phrases?\b/i
    ];

    if (catalogMarkers.some(pattern => pattern.test(line))) return true;
    if (quotedTerms >= 3) return true;
    if (commaCount >= 4 && quotedTerms >= 1) return true;
    if (pipeCount >= 2) return true;

    return false;
  };

  const usableLines = lines.filter(line => !looksLikePatternCatalog(line));

  const patterns = {
    funding: [
      /\b(?:this\s+)?(?:bounty|issue|task)\s+is\s+funded\b/i,
      /\bfunds?\s+(?:are|is)\s+(?:reserved|available|deposited|secured)\b/i,
      /\b(?:payment|reward|bounty)\s+(?:is|will be)\s+(?:guaranteed|funded)\b/i,
      /\bpayment\s+guaranteed\b/i,
      /\bguaranteed\s+payment\b/i,
      /\b(?:funded|reserved|deposited)\s+(?:in|via|through)\b/i,
      /\bescrow\b.*\b(?:payment|reward|bounty)\b/i,
      /\b(?:payment|reward|bounty)\b.*\bescrow\b/i,
      /\bprize\s+pool\b.*\b(?:funded|available|secured)\b/i,
      /\btreasury\b.*\b(?:funded|payment|reward)\b/i
    ],

    paymentTerms: [
      /\b(?:reward|bounty|payment)\b.*\bpaid\s+(?:via|through|in)\b/i,
      /\b(?:reward|bounty|payment)\b.*\bpayout\b/i,
      /\bpayment\s+method\b/i,
      /\bpayment\s+instructions?\b/i,
      /\b(?:reward|bounty)\s+will\s+be\b/i,
      /\bpayment\s+(?:will\s+be|is)\s+(?:made|sent|paid)\b/i,
      /\bpaid\s+(?:upon|after|on)\s+(?:acceptance|merge|completion)\b/i
    ],

    eligibility: [
      /\bopen\s+to\s+anyone\b/i,
      /\bopen\s+to\s+all\s+contributors\b/i,
      /\bany\s+contributor\s+(?:can|may)\s+(?:claim|work|submit|participate)\b/i,
      /\banyone\s+(?:can|may)\s+(?:claim|work|submit|participate)\b/i,
      /\bfirst\s+(?:accepted|merged)\b/i,
      /\bfirst\s+(?:valid\s+)?(?:submission|pr|pull\s+request)\b/i,
            /\bclaimable\s+by\s+anyone\b/i,
      /\bno\s+assignment\s+(?:is\s+)?required\b/i,
      /\bno\s+need\s+to\s+be\s+assigned\b/i,
           /\/claim\b/i,
      /\bclaim(?:ed|ing)?\b.*\b(?:24|48|72)\s*(?:hour|hours|h)\b/i
    ],

    deadline: [
      /\bdeadline\b/i,
      /\bdue date\b/i,
      /\bexpires?\b/i,
      /\bexpiration\b/i
    ],

    acceptance: [
      /\bacceptance\s+(?:criteria|requirements?|conditions?)\b/i,
      /\b(?:will be|is)\s+accepted\b/i,
      /\baccepted\s+(?:when|if|after|upon)\b/i,
      /\breview(?:ed)?\s+(?:by|after|upon)\b/i,
      /\bapproval\s+(?:is|by|from|required)\b/i,
     /\b(?:merged|merge)\s+(?:PR|pull request)\b/i,
                 /constant-time\b/i,
      /Bleichenbacher\b/i,
      /\btest\s+(?:vectors?|cases?)\b/i
    ]
  };

  const evidence = [];

  for (const [category, categoryPatterns] of Object.entries(patterns)) {
    for (const line of usableLines) {
      if (categoryPatterns.some(pattern => pattern.test(line))) {
        evidence.push({ category, line });

        if (evidence.filter(x => x.category === category).length >= 3) {
          break;
        }
      }
    }
  }

  const categories = {};

  for (const category of Object.keys(patterns)) {
    const matches = evidence.filter(x => x.category === category);

    categories[category] = {
      found: matches.length > 0,
      count: matches.length,
      evidence: matches
    };
  }

  const hasPaymentTerms = categories.paymentTerms.found;

  const fundingSignals = detectFundingSources(text);

  const hasFunding = categories.funding.found;

  let status = 'NO_PAYMENT_LANGUAGE';

  if (hasFunding || hasPaymentTerms) {
    status = 'PAYMENT_TERMS_FOUND';
  }

  return {
    status,
    paymentVerified: false,
    fundingEvidenceFound: hasFunding,
    fundingSignals,
    fundingStatus: hasFunding ? 'FOUND' : 'NOT_FOUND',
    paymentTermsStatus: hasPaymentTerms ? 'FOUND' : 'NOT_FOUND',
    eligibilityStatus: categories.eligibility.found ? 'FOUND' : 'NOT_FOUND',
    deadlineStatus: categories.deadline.found ? 'FOUND' : 'NOT_FOUND',
    acceptanceStatus: categories.acceptance.found ? 'FOUND' : 'NOT_FOUND',
    categories,
    evidence
  };
}
function extractEvidenceLinks(title, body) {
  const text = `${title || ""}\n${body || ""}`;

  const matches = text.match(
    /https?:\/\/[^\s<>"'`\]\)]+/gi
  ) || [];

  const links = [...new Set(
    matches.map(link =>
      link.replace(/[.,;:!?]+$/, "")
    )
  )];

  const categories = {
    payment: [],
    funding: [],
    eligibility: [],
    acceptance: [],
    documentation: [],
    other: []
  };

  for (const link of links) {
    const lower = link.toLowerCase();

    if (
      /payment|payout|reward|bounty|fund|escrow|sponsor|grant/.test(lower)
    ) {
      categories.payment.push(link);
      continue;
    }

    if (
      /eligib|requirement|contribut|participat|apply|claim/.test(lower)
    ) {
      categories.eligibility.push(link);
      continue;
    }

    if (
      /accept|review|merge|pull|pr\b|submission/.test(lower)
    ) {
      categories.acceptance.push(link);
      continue;
    }

    if (
      /docs?|documentation|readme|guide|wiki/.test(lower)
    ) {
      categories.documentation.push(link);
      continue;
    }


const fundingSignals = detectFundingSources(
  links.join("\n")
);

const hasFunding =
  categories.funding.length > 0 ||
  fundingSignals.length > 0;

    categories.other.push(link);
  }

  return {
    count: links.length,
    links,
    categories
  };
}

function buildHumanReviewSummary(state, reward, issueState, assignee, criteriaList, paymentEvidence, relatedWork, body) {
  const summary = [];

  if (typeof reward === "number" && reward > 0) {
    summary.push(`Declared reward: $${reward.toLocaleString()}`);
  } else {
    summary.push("Declared reward: NOT FOUND");
  }

  summary.push(`Issue: ${issueState === "open" ? "OPEN" : "CLOSED"}`);
  summary.push(`Assignment: ${assignee || "NONE"}`);

const workReady =
  (Array.isArray(criteriaList) && criteriaList.length > 0) ||
  /漏洞描述|要求|验收标准|constant-time|test vectors?|pull request|fix|implement|acceptance/i.test(
    String(body || "")
  );
summary.push(`Work scope: ${workReady ? "FOUND" : "UNCLEAR"}`);

  if (relatedWork) {
    summary.push(`Implementation: ${relatedWork.implementationStatus || "UNKNOWN"}`);
    summary.push(`Active PRs: ${relatedWork.activePullRequests?.length ?? 0}`);
    summary.push(`Assigned active PRs: ${relatedWork.activeAssignedPullRequests?.length ?? 0}`);
  }

  summary.push(`Payment evidence: ${paymentEvidence.status || "UNKNOWN"}`);
  summary.push(`Funding: ${paymentEvidence.fundingStatus || "UNKNOWN"}`);
  summary.push(`Eligibility: ${paymentEvidence.eligibilityStatus || "UNKNOWN"}`);
  summary.push(`Acceptance: ${paymentEvidence.acceptanceStatus || "UNKNOWN"}`);

  let recommendation = "DO NOT PURSUE YET";

  if (state === "PAYABLE" &&
      issueState === "open" &&
      !assignee &&
      workReady &&
      (!relatedWork || relatedWork.activePullRequests?.length === 0)) {
    recommendation = "HUMAN REVIEW: VERIFY FUNDING AND ELIGIBILITY";
  }

  if (paymentEvidence.paymentVerified === true) {
    recommendation = "HUMAN REVIEW: PAYMENT VERIFIED; CONFIRM ELIGIBILITY AND ACCEPTANCE";
  }

  return {
    summary,
    recommendation,
    humanGate: true
  };
}

function buildReviewPacket(state, reward, issueState, assignee, criteriaList, url, title, body) {
  const checks = {
    monetaryRewardDetected: typeof reward === "number" && reward > 0,
    issueOpen: issueState === "open",
    unassigned: !assignee,
    criteriaPresent: Array.isArray(criteriaList) && criteriaList.length > 0,
    sourceAvailable: Boolean(url)
  };

  const paymentEvidence = collectPaymentEvidence(title, body);

  const paymentEvidenceStatus = checks.monetaryRewardDetected
    ? paymentEvidence.status === "PAYMENT_TERMS_FOUND"
      ? "PAYMENT_TERMS_FOUND"
      : "DECLARED_REWARD_ONLY"
    : "NOT_FOUND";

const workScopePatterns = [
  /\btests?\b/i,
  /\btest(?:ing)?\b/i,
  /\bimplement(?:ation)?\b/i,
  /\bfix\b/i,
  /\badd\b/i,
  /\bupdate\b/i,
  /\bdocument(?:ation)?\b/i,
  /\bperformance\b/i,
  /\bregression\b/i,
  /\bPR\b/i,
  /\bpull request\b/i,
  /漏洞描述/i,
  /要求/i,
  /验收标准/i,
  /解密失败/i,
  /constant-time/i,
  /test vectors?/i
];

 const workScopeSource = [
  ...(Array.isArray(criteriaList) ? criteriaList : []),
  ...String(body || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
];

const workScopeEvidence = workScopeSource
  .filter(line =>
    workScopePatterns.some(pattern => pattern.test(line))
  )
  .filter((line, index, array) => array.indexOf(line) === index)
  .slice(0, 8);

  const workScopeFound = workScopeEvidence.length > 0;

  let readiness = "NOT_READY";

  if (state === "PAYABLE") {
    if (paymentEvidence.paymentVerified) {
      readiness = workScopeFound
        ? "PAYMENT_VERIFIED_WORK_SCOPE_READY"
        : "PAYMENT_VERIFIED_SCOPE_UNCLEAR";
    } else if (workScopeFound) {
      readiness = "PAYMENT_UNVERIFIED_WORK_SCOPE_READY";
    } else {
      readiness = "PAYMENT_UNVERIFIED_SCOPE_UNCLEAR";
    }
  }

  const humanReviewSummary = buildHumanReviewSummary(
    state,
    reward,
    issueState,
    assignee,
    criteriaList,
    paymentEvidence,
    null,
    body
  );

  const decisionPacket = {
    reward: typeof reward === "number" && reward > 0 ? reward : null,
    issue: issueState === "open" ? "OPEN" : "CLOSED",
    assignment: assignee ? assignee : "NONE",
    workScope: workScopeFound ? "FOUND" : "NOT_FOUND",
    payment: paymentEvidenceStatus,
    funding: paymentEvidence.fundingStatus,
    eligibility: paymentEvidence.eligibilityStatus,
    deadline: paymentEvidence.deadlineStatus,
    acceptance: paymentEvidence.acceptanceStatus,
    humanGate: true
  };

const actionPacket = {
  target: `${url || "UNKNOWN"}`,
  reward: reward || null,

  missing: [
    ...(paymentEvidence.fundingStatus !== "FOUND"
      ? ["funding proof"]
      : []),
    ...(paymentEvidence.eligibilityStatus !== "FOUND"
      ? ["eligibility rules"]
      : [])
  ],

  evidenceFound: [
    ...(paymentEvidence.acceptanceStatus === "FOUND"
      ? ["acceptance criteria"]
      : []),
    ...(paymentEvidence.status === "PAYMENT_TERMS_FOUND"
      ? ["payment language"]
      : []),
    ...(issueState === "open"
      ? ["open issue"]
      : [])
  ],

  nextChecks: [
    "Search repository funding wallet/sponsor info",
    "Search bounty platform terms",
    "Check issue author history",
    "Confirm payout mechanism"
  ]
};

 return {
    humanReviewSummary,
    decisionPacket,
    actionPacket,

    reviewStatus:
      state === "PAYABLE" ? "PAYMENT_EVIDENCE_REQUIRED" : "NOT_READY",

    readiness,

    paymentEvidenceStatus,
    paymentVerified: false,
    paymentEvidence,

      workScope: {
    status: workScopeFound ? "FOUND" : "NOT_FOUND",
    evidenceCount: workScopeEvidence.length,
    evidence: workScopeEvidence
  },



    checks,

    nextAction:
      state === "PAYABLE"
        ? "Verify actual funding/payment mechanism, eligibility, and acceptance criteria before doing work."
        : "Do not pursue until payment and eligibility are verified."
  };
}
function buildPaymentTruth(verification) {
  const linkedIssues = Array.isArray(verification.relatedWork?.related)
    ? verification.relatedWork.related.filter(item => item.kind === "issue")
    : [];

  const sourceTexts = [
    `${verification.title || ""}\n${verification.body || ""}`,
    ...linkedIssues.map(item => `${item.title || ""}\n${item.body || ""}`)
  ].filter(Boolean);

    // Reward truth:
  // The current/root issue is the strongest source. Linked issues are
  // supporting/contextual evidence. Repeated identical claims are
  // corroboration, not ambiguity. A genuinely different reward remains
  // a conflict and keeps the verification conservative.

  const extractRewards = text => [
    ...String(text || "").matchAll(
      /\$(\d+(?:,\d{3})*(?:\.\d+)?)/g
    )
  ]
    .filter(match => {
      const before = String(match.input || "")
        .slice(0, match.index);

      const lineStart = before.lastIndexOf("\n") + 1;
      const currentLine = before.slice(lineStart);

      return !(
        match[1] === "2" &&
        /Decryption\s*$/i.test(currentLine)
      );
    })
    .map(match => Number(match[1].replace(/,/g, "")))
    .filter(value => Number.isFinite(value));

  const rootText =
    `${verification.title || ""}\n${verification.body || ""}`;

  const rootRewardMatches = [
    ...String(rootText).matchAll(
      /\$(\d+(?:,\d{3})*(?:\.\d+)?)/g
    )
  ];

  const rootRewards = [
    ...new Set(
      rootRewardMatches
        .filter(match => {
          const before = String(match.input || "")
            .slice(0, match.index);

          const lineStart = before.lastIndexOf("\n") + 1;
          const currentLine = before.slice(lineStart);

          return !(
            match[1] === "2" &&
            /Decryption\s*$/i.test(currentLine)
          );
        })
        .map(match =>
          Number(match[1].replace(/,/g, ""))
        )
        .filter(value => Number.isFinite(value))
    )
  ];

  const linkedRewards = [
    ...new Set(
      linkedIssues.flatMap(item =>
        extractRewards(
          `${item.title || ""}\n${item.body || ""}`
        )
      )
    )
  ];

  const allSourceRewards = [
    ...new Set([...rootRewards, ...linkedRewards])
  ];

  let rewardStatus = "NOT_FOUND";
  let sourceReward = null;

  if (verification.reward != null) {
    // Prefer the authoritative reward already parsed from the current issue.
    sourceReward = verification.reward;

    const conflictingRootRewards = rootRewards.filter(
      value => value !== verification.reward
    );

    const conflictingLinkedRewards = linkedRewards.filter(
      value => value !== verification.reward
    );

    if (
      conflictingRootRewards.length === 0 &&
      conflictingLinkedRewards.length === 0
    ) {
      rewardStatus = "MATCH";
    } else {
      // Preserve fail-closed behavior when another actual numeric reward
      // conflicts with the authoritative reward.
      rewardStatus = "MISMATCH";
    }
  } else if (allSourceRewards.length === 1) {
    sourceReward = allSourceRewards[0];
    rewardStatus = "FOUND";
  } else if (allSourceRewards.length > 1) {
    rewardStatus = "AMBIGUOUS";
  }

  // Reward-integrity check:
  // Inspect raw claims separately so suspicious giant amounts are never
  // silently discarded by the reasonable-reward parser ceiling.
  const rawSourceRewards = [
    ...new Set([
      ...extractRewards(rootText),
      ...linkedIssues.flatMap(item =>
        extractRewards(
          `${item.title || ""}\n${item.body || ""}`
        )
      )
    ])
  ];

  const suspiciousRawRewards = rawSourceRewards.filter(
    value => value > MAX_REASONABLE_REWARD
  );

  let rewardIntegrityStatus = "CLEAN";

  if (
    suspiciousRawRewards.length > 0 &&
    verification.reward != null
  ) {
    rewardIntegrityStatus = "SUSPICIOUS_MISMATCH";
  } else if (
    verification.reward != null &&
    rawSourceRewards.some(
      value =>
        value !== verification.reward &&
        value <= MAX_REASONABLE_REWARD
    )
  ) {
    rewardIntegrityStatus = "MULTIPLE_SOURCE_CLAIMS";
  } else {
    rewardIntegrityStatus = "CLEAN";
  }

  const allSourceText = sourceTexts.join("\n");

  const normalizedLines = allSourceText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const fundingPositivePatterns = [
    /\b(?:this\s+)?(?:bounty|issue|task)\s+is\s+funded\b/i,
    /\bfunds?\s+(?:are|is)\s+(?:reserved|available|deposited|secured)\b/i,
    /\b(?:payment|reward|bounty)\s+(?:is|will be)\s+(?:guaranteed|funded)\b/i,
    /\bpayment\s+guaranteed\b/i,
    /\bguaranteed\s+payment\b/i,
    /\b(?:funded|reserved|deposited)\s+(?:in|via|through)\b/i,
    /\bescrow\b.*\b(?:payment|reward|bounty)\b/i,
    /\b(?:payment|reward|bounty)\b.*\bescrow\b/i,
    /\bprize\s+pool\b.*\b(?:funded|available|secured)\b/i,
    /\btreasury\b.*\b(?:funded|payment|reward)\b/i
  ];

  const fundingNegativePatterns = [
    /\bnot\s+funded\b/i,
    /\bno\s+fund(?:ing|s)?\b/i,
    /\bunfunded\b/i,
    /\bpayment\s+(?:is\s+)?not\s+guaranteed\b/i,
    /\bpayment\s+not\s+guaranteed\b/i,
    /\bno\s+guaranteed\s+payment\b/i,
    /\bfunding\s+(?:is\s+)?(?:not|un)?confirmed\b/i,
    /\b(?:funding|payment|reward)\s+(?:has\s+)?not\s+been\s+(?:secured|deposited|funded)\b/i
  ];

  const eligibilityPositivePatterns = [
    /\bopen\s+to\s+anyone\b/i,
    /\bopen\s+to\s+all\s+contributors\b/i,
    /\bany\s+contributor\s+(?:can|may)\s+(?:claim|work|submit|participate)\b/i,
    /\banyone\s+(?:can|may)\s+(?:claim|work|submit|participate)\b/i,
    /\bfirst\s+(?:accepted|merged)\b/i,
    /\bfirst\s+(?:valid\s+)?(?:submission|pr|pull\s+request)\b/i,
    /\bclaimable\s+by\s+anyone\b/i,
    /\bno\s+assignment\s+(?:is\s+)?required\b/i,
    /\bno\s+need\s+to\s+be\s+assigned\b/i,
      ];

  const eligibilityNegativePatterns = [
    /\bnot\s+eligible\b/i,
    /\bineligible\b/i,
    /\bonly\s+(?:assigned|selected|approved)\s+(?:contributors?|developers?|users?)\b/i,
    /\bmust\s+be\s+(?:assigned|approved|selected)\b/i,
    /\bassignment\s+(?:is\s+)?required\b/i,
    /\bonly\s+(?:the\s+)?assignee\b/i,
    /\bexclusive(?:ly)?\s+to\b/i
  ];

  const looksLikePatternCatalog = line => {
    const quotedTerms = (line.match(/["ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½][^"ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½]+["ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¿ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â½]/g) || []).length;
    const commaCount = (line.match(/,/g) || []).length;
    const pipeCount = (line.match(/\|/g) || []).length;

    const catalogMarkers = [
      /\bpattern(?:s)?\b/i,
      /\bexample(?:s)?\b/i,
      /\bkeywords?\b/i,
      /\bsearch\s+terms?\b/i,
      /\bmatch(?:es|ing)?\b/i,
      /\bregex(?:es)?\b/i,
      /\bvocabulary\b/i,
      /\bpossible\s+phrases?\b/i
    ];

    if (catalogMarkers.some(pattern => pattern.test(line))) return true;
    if (quotedTerms >= 3) return true;
    if (commaCount >= 4 && quotedTerms >= 1) return true;
    if (pipeCount >= 2) return true;

    return false;
  };

  const usableLines = normalizedLines.filter(
    line => !looksLikePatternCatalog(line)
  );

  const fundingEvidence = [];
  const eligibilityEvidence = [];

  for (const line of usableLines) {
    const fundingPositive = fundingPositivePatterns.some(
      pattern => pattern.test(line)
    );

    const fundingNegative = fundingNegativePatterns.some(
      pattern => pattern.test(line)
    );

    if (fundingPositive && !fundingNegative) {
      fundingEvidence.push(line);
    }

    const eligibilityPositive = eligibilityPositivePatterns.some(
      pattern => pattern.test(line)
    );

    const eligibilityNegative = eligibilityNegativePatterns.some(
      pattern => pattern.test(line)
    );

    if (eligibilityPositive && !eligibilityNegative) {
      eligibilityEvidence.push(line);
    }
  }

    const fundingFound = fundingEvidence.length > 0;
  const eligibilityFound = eligibilityEvidence.length > 0;

  const repositoryFunding = verification.repositoryFunding || null;
  const fundingMechanismFound =
    repositoryFunding?.checked === true &&
    Array.isArray(repositoryFunding.signals) &&
    repositoryFunding.signals.length > 0;
  const activePrs = Array.isArray(verification.relatedWork?.activePullRequests)
    ? verification.relatedWork.activePullRequests.length
    : Number(verification.activePrs || 0);
  const issueOpen =
    String(verification.issueState || "").toLowerCase() === "open";
  const unassigned = !verification.assignee;

  const paymentReady =
    verification.state === "PAYABLE" &&
    issueOpen &&
    unassigned &&
    activePrs === 0 &&
    rewardStatus === "MATCH" &&
    rewardIntegrityStatus === "CLEAN" &&
    fundingFound &&
    eligibilityFound;

  return {
    declaredReward: verification.reward ?? null,
    sourceReward,
    rewardStatus,
    rewardIntegrityStatus,
    suspiciousRawRewards,
fundingStatus:
  fundingFound
    ? "FOUND"
    : "NOT_FOUND",

fundingEvidence,

fundingMechanismStatus:
  fundingMechanismFound
    ? "FOUND"
    : "NOT_FOUND",

fundingMechanismEvidence:
  Array.isArray(repositoryFunding?.signals)
    ? repositoryFunding.signals
    : [],

    eligibilityStatus:
  eligibilityFound
    ? "FOUND"
    : "NOT_FOUND",

eligibilityEvidence,

paymentReady
  };
}
async function inspectLinkedWork(evidenceLinks, rootIssue = null) {
  const links = Array.isArray(evidenceLinks?.links)
    ? evidenceLinks.links
    : [];

  const githubRefs = [];

  for (const link of links) {
    const match = link.match(
      /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/(issues|pull)\/(\d+)/i
    );

    if (!match) {
      continue;
    }

    githubRefs.push({
      url: link,
      owner: match[1],
      repo: match[2],
      kind: match[3].toLowerCase(),
      number: Number(match[4])
    });
  }

  if (rootIssue?.number && rootIssue?.repository_url) {
    const repoMatch = rootIssue.repository_url.match(
      /\/repos\/([^\/]+)\/([^\/]+)$/i
    );

    if (repoMatch) {
      githubRefs.push({
        url:
          rootIssue.html_url ||
          `${GITHUB_API}/repos/${repoMatch[1]}/${repoMatch[2]}/issues/${rootIssue.number}`,
        owner: repoMatch[1],
        repo: repoMatch[2],
        kind: "issues",
        number: Number(rootIssue.number),
        root: true
      });
    }
  }

  const uniqueRefs = [
    ...new Map(
      githubRefs.map(ref => [
        `${ref.owner}/${ref.repo}/${ref.kind}/${ref.number}`,
        ref
      ])
    ).values()
  ];

  const related = [];

  const evidenceRetrieval = {
    attempted: [],
    succeeded: [],
    failed: []
  };

  for (const ref of uniqueRefs) {
    try {
      if (ref.kind === "pull") {
        const pr = await github(
          `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`
        );

        related.push({
          kind: "pull_request",
          repo: `${ref.owner}/${ref.repo}`,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: Boolean(pr.draft),
          author: pr.user?.login || null,
          assignee: pr.assignee?.login || null,
          merged: Boolean(pr.merged_at),
          mergedAt: pr.merged_at || null,
          url: pr.html_url,
          body: pr.body || ""
        });

        continue;
      }

      evidenceRetrieval.attempted.push({
        url: ref.url,
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        kind: "issue"
      });

      const linkedIssue = await github(
        `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`
      );

      evidenceRetrieval.succeeded.push({
        url: ref.url,
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        kind: "issue"
      });

      const linkedAssignee =
        linkedIssue.assignee?.login ||
        (linkedIssue.assignees?.length
          ? linkedIssue.assignees[0]?.login
          : null);

      related.push({
        kind: "issue",
        repo: `${ref.owner}/${ref.repo}`,
        number: linkedIssue.number,
        title: linkedIssue.title,
        state: linkedIssue.state,
        author: linkedIssue.user?.login || null,
        assignee: linkedAssignee,
        url: linkedIssue.html_url,
        body: linkedIssue.body || ""
      });

      if (ref.kind === "issues") {
        try {
          const timeline = await github(
            `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/timeline`
          );

          for (const event of Array.isArray(timeline) ? timeline : []) {
            if (
              event.event !== "cross-referenced" ||
              !event.source?.issue?.pull_request
            ) {
              continue;
            }

            const pr = event.source.issue;

            let authoritativePr = null;

            try {
              authoritativePr = await github(
                `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/pulls/${pr.number}`
              );
            } catch (error) {
              authoritativePr = null;
            }

            const prData = authoritativePr || pr;

            const prRef = {
              kind: "pull_request",
              repo: ref.repo,
              number: prData.number,
              title: prData.title,
              state: prData.state,
              draft: Boolean(prData.draft),
              author: prData.user?.login || null,
              assignee: prData.assignee?.login || null,
              merged: Boolean(
                authoritativePr
                  ? authoritativePr.merged_at
                  : prData.pull_request?.merged_at
              ),
              mergedAt:
                authoritativePr
                  ? authoritativePr.merged_at || null
                  : prData.pull_request?.merged_at || null,
              url: prData.html_url,
              body: prData.body || "",
              createdAt: prData.created_at || null,
              updatedAt: prData.updated_at || null,
              ageHours: prData.created_at
                ? Math.max(
                    0,
                    (Date.now() - Date.parse(prData.created_at)) / 3600000
                  )
                : null,
              inactiveHours: prData.updated_at
                ? Math.max(
                    0,
                    (Date.now() - Date.parse(prData.updated_at)) / 3600000
                  )
                : null,
              commits: authoritativePr?.commits ?? null,
              reviewComments: authoritativePr?.review_comments ?? null,
              changedFiles: authoritativePr?.changed_files ?? null,
              additions: authoritativePr?.additions ?? null,
              deletions: authoritativePr?.deletions ?? null,
              linkedIssue: `${ref.repo}#${ref.number}`,
              authoritative: Boolean(authoritativePr)
            };

            if (
              !related.some(
                item =>
                  item.kind === "pull_request" &&
                  item.repo === prRef.repo &&
                  item.number === prRef.number
              )
            ) {
              related.push(prRef);
            }
          }
        } catch (error) {
          related.push({
            kind: "timeline",
            repo: ref.repo,
            number: ref.number,
            fetchError: error.message
          });
        }
      }
    } catch (error) {
      evidenceRetrieval.failed.push({
        url: ref.url,
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        kind: ref.kind === "pull" ? "pull_request" : "issue",
        error: error.message
      });

      related.push({
        kind: ref.kind === "pull" ? "pull_request" : "issue",
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        url: ref.url,
        fetchError: error.message
      });
    }
  }


  const linkedIssues = related.filter(
    item => item.kind === "issue"
  );

  const assignedContributors = new Set(
    linkedIssues
      .map(item => item.assignee)
      .filter(Boolean)
  );

  const activePullRequests = related.filter(item =>
    item.kind === "pull_request" &&
    item.state === "open" &&
    !item.draft
  );

  const activeAssignedPullRequests = activePullRequests.filter(item =>
    assignedContributors.has(item.author) ||
    assignedContributors.has(item.assignee)
  );

  let implementationStatus = "NO_ACTIVE_PR";

  if (activeAssignedPullRequests.length > 0) {
    implementationStatus = "IN_PROGRESS_ASSIGNED";
  } else if (activePullRequests.length > 0) {
    implementationStatus = "IN_PROGRESS";
  }

  return {
    implementationStatus,
    linkedIssues,
    related,
    activePullRequests,
    activeAssignedPullRequests,
    assignedContributors: [...assignedContributors],
    evidenceRetrieval,
    humanGate: true
  };
}
function payableState(state, reward, issueState, assignee) {
  if (issueState !== "open") {
    return state;
  }

  if (assignee) {
    return "ASSIGNED";
  }

  if (typeof reward === "number" && reward > 0) {
    return "PAYABLE";
  }

  return state;
}

async function verifyCandidate(issue, cache, forceRefresh = false) {

  const repo = repoFromIssue(issue);
  const key = `${repo}#${issue.number}`;

  if (!forceRefresh && cache[key]?.assignmentChecked) {
    const verifiedAt = Date.parse(cache[key].verifiedAt || "");
    const age = Date.now() - verifiedAt;

    if (Number.isFinite(verifiedAt) && age < VERIFICATION_TTL_MS) {
   return {
  ...cache[key],
  currency: currencyFromText(
    `${cache[key].title || ""}\n${cache[key].body || ""}`,
    cache[key].reward
  ),
  cached: true,
  verificationMode: "CACHED"
};
    }
  }

  // Authoritative upstream issue.
  const fullIssue = await github(
    `${GITHUB_API}/repos/${repo}/issues/${issue.number}`
  );

  const body = fullIssue.body || "";
const combined = `${fullIssue.title}\n${body}`;
const reward = moneyFromText(combined);
const currency = currencyFromText(combined, reward);
const radar = parseRadar(body);

  let state = initialState(combined, reward);

  const assigneeCount = Array.isArray(fullIssue.assignees)
    ? fullIssue.assignees.length
    : 0;

  const assigned =
    assigneeCount > 0 ||
    Boolean(fullIssue.assignee);

  if (fullIssue.state !== "open") {
    state = "BLOCKED";
  } else if (assigned) {
    state = "ASSIGNED";
  } else {
    state = payableState(state, reward, fullIssue.state, null);
  }

const result = {
  assignmentChecked: true,
  repo,
  number: fullIssue.number,
title: fullIssue.title,
body,
url: fullIssue.html_url,
state,
reward,
currency,
radar,
    issueState: fullIssue.state,
    assignee:
      fullIssue.assignee?.login ||
      (fullIssue.assignees?.length
        ? fullIssue.assignees.map(x => x.login).join(", ")
        : null),
    comments: fullIssue.comments,
    criteria: criteria(body),
    evidenceLinks: extractEvidenceLinks(fullIssue.title, body),
    relatedWork: null,
    verifiedAt: new Date().toISOString()
  };

  result.relatedWork = await inspectLinkedWork(result.evidenceLinks, fullIssue);
  result.repositoryFunding = await inspectRepositoryFunding(repo);
  result.roi = calculateROI(result);

  if (
    result.state === "PAYABLE" &&
    (
      result.relatedWork.implementationStatus === "IN_PROGRESS_ASSIGNED" ||
      result.relatedWork.implementationStatus === "IN_PROGRESS"
    )
  ) {
    result.state = result.relatedWork.implementationStatus;
  }

  result.review = buildReviewPacket(
    result.state,
    result.reward,
    result.issueState,
    result.assignee,
    result.criteria,
    result.url,
    result.title,
    body
  );

  result.paymentTruth = buildPaymentTruth(result);

  cache[key] = result;
  saveCache(cache);

  return result;
}

function discoveryScore(issue) {
  const text = `${issue.title || ""}\n${issue.body || ""}`.toLowerCase();
  let score = 0;

  const reward = moneyFromText(text);

  if (reward) {
    score += Math.min(30, Math.log10(reward + 1) * 10);
  }

  if (/acceptance|criteria|must|deliver|implementation|test/.test(text)) {
    score += 25;
  }

  if (/payment|paid|payout|reward|bounty/.test(text)) {
    score += 15;
  }

  if (/fix|implement|improve|add|update|documentation|bug/.test(text)) {
    score += 15;
  }

  if (/demo|fixture|simulation|test fixture|no monetary payment|points only/.test(text)) {
    score -= 40;
  }

  if (/fund your own|pay upfront|purchase required|buy first/.test(text)) {
    score -= 40;
  }
 return score;
}


function detectFundingSources(text) {
  const lower = String(text || "").toLowerCase();

  const signals = [
    "funding.yml",
    "github sponsors",
    "sponsor",
    "opencollective",
    "wallet",
    "treasury",
    "escrow",
    "payment address",
    "bounty pool",
    "funded by"
  ];

  return signals.filter(signal =>
    lower.includes(signal)
  );
}



function cachedOpportunityCandidates(cache) {
  const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

  const now = Date.now();

  return Object.values(cache || {})
    .filter(item => {
      if (!item?.assignmentChecked) return false;
      if (item.state !== "PAYABLE") return false;
      if (!isReasonableReward(item.reward)) return false;

      const verifiedAt = Date.parse(item.verifiedAt || "");
      if (!Number.isFinite(verifiedAt)) return false;

      return now - verifiedAt >= 0 &&
        now - verifiedAt <= MAX_CACHE_AGE_MS;
    })
    .map(item => ({
      verification: {
        ...item,
        cached: true,
        verificationMode: "CACHED_FALLBACK"
      }
    }))
    .map(item => ({
      ...item,
      verification: {
        ...item.verification,
        priority: buildOpportunityPriority(item.verification)
      }
    }))
    .filter(item => item.verification.priority?.score != null)
    .sort(
      (a, b) =>
        b.verification.priority.score -
        a.verification.priority.score
    );
}
function githubVerificationToOpportunity(verification) {
  const paymentTruth = verification.paymentTruth || {};
  const review = verification.review || {};
  const workScope = review.workScope || {};

  return createOpportunity({
    id: `${verification.repo}#${verification.number}`,
    source: "GitHub",
    sourceType: "GITHUB_BOUNTY",

    title: verification.title,
    url: verification.url,

  amount: verification.reward,
currency: verification.currency || null,
valueType: OPPORTUNITY_TYPES.CASH_REWARD,

    maximum: verification.reward,
    guaranteed: false,

  paymentStatus:
  paymentTruth.paymentReady
    ? "VERIFIED"
    : paymentTruth.fundingStatus === "FOUND"
      ? "FUNDING_SIGNAL_FOUND"
      : "DECLARED_REWARD_ONLY",

fundingVerified:
  paymentTruth.fundingStatus === "FOUND",

paymentMechanismVerified:
  paymentTruth.fundingMechanismStatus === "FOUND",
paymentTermsVerified: false,

eligibilityStatus:
  paymentTruth.eligibilityStatus ||
  "UNKNOWN",

    eligibilityEvidence:
      paymentTruth.eligibilityEvidence || [],

    acceptanceStatus:
      paymentTruth.acceptance ||
      "UNKNOWN",

    acceptanceEvidence:
      paymentTruth.acceptanceEvidence || [],

    scope:
      workScope.description ||
      workScope.status ||
      "GitHub bounty work",

    estimatedHours: null,
activeCompetitors:
  Array.isArray(verification.relatedWork?.activePullRequests)
    ? verification.relatedWork.activePullRequests.length
    : null,

    freshness:
      verification.issueState === "open"
        ? "OPEN"
        : verification.issueState,

    evidence: [
      ...(Array.isArray(verification.evidenceLinks)
        ? verification.evidenceLinks
        : verification.evidenceLinks
          ? [verification.evidenceLinks]
          : []),
      ...(Array.isArray(paymentTruth.evidence)
        ? paymentTruth.evidence
        : paymentTruth.evidence
          ? [paymentTruth.evidence]
          : [])
    ],

     status:
      verification.decision?.decision === "PURSUE_NOW"
        ? "ACTIONABLE"
        : verification.decision?.decision === "VERIFY_FIRST"
          ? "HUMAN_REVIEW"
          : "REJECTED",

    hunterDecision:
      verification.decision?.decision || "DO_NOT_PURSUE",

    hunterConfidence:
      verification.decision?.confidence || "UNKNOWN",

    hunterReasons:
      verification.decision?.reasons || [],

    rewardStatus:
      paymentTruth.rewardStatus || "UNKNOWN",

    rewardIntegrityStatus:
      paymentTruth.rewardIntegrityStatus || "UNKNOWN",

    fundingStatus:
      paymentTruth.fundingStatus || "UNKNOWN",

    fundingMechanismStatus:
      paymentTruth.fundingMechanismStatus || "UNKNOWN",

    paymentPolicyStatus:
      paymentTruth.paymentPolicyStatus || "UNKNOWN",

    paymentReady:
      paymentTruth.paymentReady === true,

    scoutDecision:
      verification.decision?.decision || "DO_NOT_PURSUE"
  });
}
async function main() {
  const {
    rankEvaluatedOpportunities
  } = require("./opportunity-pipeline.js");

  console.log("\n=== ASSIGNMENT-AWARE BOUNTY SCOUT ===\n");

  const cache = loadCache();
  const statusIndex = process.argv.indexOf("--status");

  if (statusIndex !== -1) {
    const bountyId = process.argv[statusIndex + 1];
    const status = process.argv[statusIndex + 2];

    if (!bountyId || !status) {
      console.error(
        "Usage: node .\scout.js --status <bountyId> <STATUS>"
      );
      process.exitCode = 1;
      return;
    }

    try {
      const updated = setOpportunityStatus(bountyId, status);

      console.log("STATUS UPDATED");
      console.log(`Bounty ID: ${updated.bountyId}`);
      console.log(`Status: ${updated.status}`);
      console.log(`Updated: ${updated.statusUpdated}`);
      return;
    } catch (error) {
      console.error(`Status update failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }
  const reviewMode = process.argv.includes("--review");

  if (reviewMode) {
    const queue = loadVerifiedOpportunityQueue();
    const opportunities = Object.values(queue)
      .filter(item => item?.state === "PAYABLE")
      .sort((a, b) => {
        const aScore = a?.priority?.score ?? -Infinity;
        const bScore = b?.priority?.score ?? -Infinity;
        return bScore - aScore;
      });

    console.log("========================================");
    console.log("VERIFIED OPPORTUNITY REVIEW QUEUE");
    console.log("========================================");
    console.log(`PAYABLE OPPORTUNITIES: ${opportunities.length}`);
    console.log("READ-ONLY: no claims, comments, PRs, submissions, or payments");
    console.log("");

    if (opportunities.length === 0) {
      console.log("No persisted PAYABLE opportunities.");
      return;
    }

    for (const opportunity of opportunities) {
      const review = opportunity.review || {};
      const packet = opportunity.decisionPacket || review.decisionPacket || {};
      const priority = opportunity.priority || {};
      const workScope = review.workScope || {};

      console.log("----------------------------------------");
      console.log(`${opportunity.repo}#${opportunity.number}`);
      console.log(`TITLE: ${opportunity.title}`);
      console.log(`REWARD: ${opportunity.reward ?? "NOT FOUND"}`);
      console.log(`PRIORITY: ${priority.score ?? "NOT SCORED"}`);
      console.log(`PAYMENT: ${packet.payment || "NOT_VERIFIED"}`);
      console.log(`FUNDING: ${packet.funding || "NOT_VERIFIED"}`);
      console.log(`WORK SCOPE: ${workScope.status || packet.workScope || "NOT_FOUND"}`);
      console.log(`ELIGIBILITY: ${packet.eligibility || "NOT_VERIFIED"}`);
      console.log(`DEADLINE: ${packet.deadline || "NOT_VERIFIED"}`);
      console.log(`ACCEPTANCE: ${packet.acceptance || "NOT_VERIFIED"}`);
      console.log(`HUMAN REVIEW: ${packet.humanGate ? "REQUIRED" : "NOT REQUIRED"}`);
      console.log(`NEXT ACTION: ${review.nextAction || "Manual review required."}`);
      console.log(`URL: ${opportunity.url}`);
      if (review.actionPacket) {
        console.log("");
        console.log("ACTION PACKET");
        console.log("");

        console.log(`Target:`);
        console.log(review.actionPacket.target);

        console.log("");
        console.log(`Reward:`);
        console.log(review.actionPacket.reward ?? "UNKNOWN");

        console.log("");
        console.log("Missing:");
        for (const item of review.actionPacket.missing) {
          console.log(`- ${item}`);
        }

        console.log("");
        console.log("Evidence found:");
        for (const item of review.actionPacket.evidenceFound) {
          console.log(`ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ ${item}`);
        }

        console.log("");
        console.log("Next checks:");
        review.actionPacket.nextChecks.forEach((item, i) => {
          console.log(`${i + 1}. ${item}`);
        });
      }
    }

    console.log("----------------------------------------");
    console.log("========================================");
    return;
  }



  const availableIndex = process.argv.indexOf("--available");

  if (availableIndex !== -1) {
    const queue = loadVerifiedOpportunityQueue();

    const opportunities = Object.values(queue)
      .filter(item => item?.availability?.status === "AVAILABLE")
      .sort((a, b) => {
        const aScore = a?.priority?.score ?? -Infinity;
        const bScore = b?.priority?.score ?? -Infinity;
        return bScore - aScore;
      });

    console.log("========================================");
    console.log("AVAILABLE OPPORTUNITIES");
    console.log("========================================");
    console.log(`AVAILABLE: ${opportunities.length}`);
    console.log("READ-ONLY: no claims, comments, PRs, submissions, or payments");
    console.log("HUMAN REVIEW: REQUIRED");
    console.log("");

    if (opportunities.length === 0) {
      console.log("No persisted opportunities currently meet the AVAILABLE criteria.");
      console.log("");
      console.log("Criteria:");
      console.log("  - PAYABLE state");
      console.log("  - issue open");
      console.log("  - unassigned");
      console.log("  - no active non-draft implementation PR");
      console.log("");
      return;
    }

    for (const opportunity of opportunities) {
      const review = opportunity.review || {};
      const packet =
        opportunity.decisionPacket ||
        review.decisionPacket ||
        {};
      const priority = opportunity.priority || {};
      const availability = opportunity.availability || {};

      console.log("----------------------------------------");
      console.log(`${opportunity.repo}#${opportunity.number}`);
      console.log(`TITLE: ${opportunity.title}`);
      console.log(`REWARD: ${opportunity.reward ?? "NOT FOUND"}`);
      console.log(`AVAILABILITY: ${availability.status}`);
      console.log(`PRIORITY: ${priority.score ?? "NOT SCORED"}`);
      console.log(`PAYMENT: ${packet.payment || "NOT_VERIFIED"}`);
      console.log(`FUNDING: ${packet.funding || "NOT_VERIFIED"}`);
      console.log(`ELIGIBILITY: ${packet.eligibility || "NOT_VERIFIED"}`);
      console.log(`ACCEPTANCE: ${packet.acceptance || "NOT_VERIFIED"}`);
      console.log(`HUMAN REVIEW: REQUIRED`);
      console.log(`URL: ${opportunity.url}`);
    }

    console.log("----------------------------------------");
    console.log("========================================");
    return;
  }
  const inspectGithubIndex = process.argv.indexOf("--inspect-github");

  if (inspectGithubIndex !== -1) {
    const repoArg = process.argv[inspectGithubIndex + 1];
    const issueNumber = process.argv[inspectGithubIndex + 2];

    if (
      !repoArg ||
      !/^[^\/\s]+\/[^\/\s]+$/.test(repoArg) ||
      !issueNumber ||
      !/^\d+$/.test(issueNumber)
    ) {
      console.error(
        "Usage: node .\scout.js --inspect-github <owner/repo> <githubIssueNumber>"
      );
      process.exitCode = 1;
      return;
    }

    const issue = {
      number: Number(issueNumber),
      repository_url: `${GITHUB_API}/repos/${repoArg}`,
      title: `GitHub issue #${issueNumber}`,
      html_url:
        `${GITHUB_API}/repos/${repoArg}/issues/${issueNumber}`
    };

    console.log("========================================");
    console.log("FRESH GITHUB ISSUE INSPECTION");
    console.log("========================================");
    console.log(`ISSUE: ${repoArg}#${issueNumber}`);
    console.log("MODE: FRESH AUTHORITATIVE GITHUB FETCH");
    console.log("CACHE: BYPASSED");
    console.log("QUEUE REQUIREMENT: NONE");
    console.log("");

    try {
      const verification = await verifyCandidate(
        issue,
        cache,
        true
      );

      verification.priority =
        buildOpportunityPriority(verification);

      updateQueueFromVerification(verification);
      updateVerifiedOpportunityQueue(verification);

      displayVerification(verification);

      console.log("PERSISTENCE");
      console.log("  Verification cache: UPDATED");
      console.log("  Opportunity queue: UPDATED IF MATCHED");
      console.log("  Verified queue: UPDATED BY PAYABLE STATE");
      console.log("========================================");

      return;
    } catch (error) {
      console.error(
        `Fresh GitHub inspection failed: ${error.message}`
      );
      process.exitCode = 1;
      return;
    }
  }
  const inspectIndex = process.argv.indexOf("--inspect");

  if (inspectIndex !== -1) {
    const issueNumber = process.argv[inspectIndex + 1];

    if (!issueNumber || !/^\d+$/.test(issueNumber)) {
      console.error(
        "Usage: node .\scout.js --inspect <githubIssueNumber>"
      );
      process.exitCode = 1;
      return;
    }

    const queue = loadVerifiedOpportunityQueue();
    const matches = Object.values(queue).filter(
      item => String(item?.number) === String(issueNumber)
    );

    if (matches.length === 0) {
      console.error(
        `No persisted PAYABLE opportunity found for GitHub issue #${issueNumber}.`
      );
      process.exitCode = 1;
      return;
    }

    const opportunity = matches[0];

    const issue = {
      number: opportunity.number,
      repository_url:
        `${GITHUB_API}/repos/${opportunity.repo}`,
      title: opportunity.title,
      html_url: opportunity.url
    };

    console.log("========================================");
    console.log("FRESH OPPORTUNITY INSPECTION");
    console.log("========================================");
    console.log(`ISSUE: ${opportunity.repo}#${opportunity.number}`);
    console.log("MODE: FRESH AUTHORITATIVE GITHUB FETCH");
    console.log("CACHE: BYPASSED");
    console.log("");

    try {
      const verification = await verifyCandidate(
        issue,
        cache,
        true
      );

      verification.priority =
        buildOpportunityPriority(verification);

      updateQueueFromVerification(verification);
      updateVerifiedOpportunityQueue(verification);

      displayVerification(verification);

      console.log("PERSISTENCE");
      console.log("  Opportunity queue: UPDATED");
      console.log("  Verified queue: UPDATED");
      console.log("========================================");

      return;
    } catch (error) {
      console.error(
        `Fresh inspection failed: ${error.message}`
      );
      process.exitCode = 1;
      return;
    }
  }
  const localMode = process.argv.includes("--local");

  const minSatsArg = process.argv.find(arg => arg.startsWith("--min-sats="));
  const minSats = minSatsArg
    ? Number(minSatsArg.split("=")[1])
    : 0;

  if (!Number.isFinite(minSats) || minSats < 0) {
    console.error("Invalid --min-sats value. Use a non-negative number.");
    process.exitCode = 1;
    return;
  }

  if (localMode) {
    console.log(`MODE: LOCAL RADAR (MIN SATS: ${minSats})\n`);

    try {
      const candidates = localRadarCandidates(minSats);
      const queue = updateOpportunityQueue(candidates);

      console.log("SOURCE: LOCAL RADAR");
      console.log(`Queue entries: ${Object.keys(queue).length}`);
      console.log(`Candidates loaded: ${candidates.length}\n`);

     const rankedRadar = candidates.map(item => {
  const roi = calculateLocalRadarROI(item);
  const decision = calculateLocalRadarDecision(item, roi);
  const ranking = calculateLocalRadarRank(item, roi, decision);

  return {
    item,
    roi,
    decision,
    ranking
  };
});

rankedRadar.sort((a, b) => {
  return b.ranking.score - a.ranking.score;
});

console.log("=== TOP OPPORTUNITIES ===\n");

rankedRadar.forEach((entry, index) => {
  console.log(`#${index + 1} ${entry.item.title || "UNTITLED"}`);
  console.log(`  VALUE: ${entry.item.valueSats ?? "UNKNOWN"} sats`);
  console.log(`  RANK: ${entry.ranking.score}`);
  console.log(`  ACTION: ${entry.decision.action}`);
  console.log("");
});

console.log("==========================\n");

console.log("=== AGENT RECOMMENDATION ===\n");

const best = rankedRadar[0];

if (best) {
  console.log(`BEST OPPORTUNITY: ${best.item.title || "UNTITLED"}`);
  console.log(`VALUE: ${best.item.valueSats ?? "UNKNOWN"} sats`);
  console.log(`RANK: ${best.ranking.score}`);
  console.log(`DECISION: ${best.decision.action}`);
console.log("\nWHY IT WON:");

for (const reason of best.ranking.reasons) {
  console.log(`  + ${reason}`);
}

console.log("\nRISKS:");

const risks = [];

if (!best.item.paymentVerified) {
  risks.push("payment verification required");
}

if (!best.item.fundingVerified) {
  risks.push("funding verification required");
}

if (!best.item.eligibilityVerified) {
  risks.push("eligibility verification required");
}

if (risks.length === 0) {
  console.log("  NONE DETECTED");
} else {
  for (const risk of risks) {
    console.log(`  ! ${risk}`);
  }
}

console.log("STATUS: WAITING FOR HUMAN APPROVAL");
  console.log("NEXT ACTION: HUMAN VERIFICATION REQUIRED");
}

console.log("\n============================\n");

for (const entry of rankedRadar) {
  displayLocalRadar(entry.item);
}

      console.log(
        "Safety: local radar is discovery-only; no payment, submission, claim, comment, or other external action executed."
      );
      return;
    } catch (error) {
      console.error(`Local radar unavailable: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  try {
    console.log("MODE: GITHUB-FIRST\n");

    const data = await github(SEARCH_URL);
   const issues = (data.items || []).filter(
  item =>
    !item.pull_request &&
    item.repository_url
);

    console.log(`SOURCE: GITHUB`);
    console.log(`Search results: ${issues.length}`);

    const seenRadar = new Set();

    const candidates = issues
      .map(issue => {
        const radar = parseRadar(issue.body || "");
        return { issue, radar };
      })
      .filter(({ issue, radar }) => {
        const key = radar?.bountyId || `issue:${issue.id}`;

        if (seenRadar.has(key)) return false;
        seenRadar.add(key);

        return true;
      })
      .sort((a, b) => {
        return discoveryScore(b.issue) - discoveryScore(a.issue);
      })
      .slice(0, MAX_GITHUB_VERIFICATIONS);

    console.log(`Candidates selected: ${candidates.length}\n`);

        const evaluatedInputs = [];

    for (const candidate of candidates) {
      const verification = await verifyCandidate(
        candidate.issue,
        cache,
        true
      );

      verification.priority = buildOpportunityPriority(verification);
      verification.decision = buildOpportunityDecision(verification);

      const opportunity =
        githubVerificationToOpportunity(verification);

      evaluatedInputs.push({
        opportunity,
        verification
      });

      displayVerification(verification);
      updateQueueFromVerification(verification);
      updateVerifiedOpportunityQueue(verification);
    }

    const rankedEvaluatedOpportunities =
      rankEvaluatedOpportunities(evaluatedInputs);

    console.log("\n=== SAFETY-FIRST OPPORTUNITY RANKING ===\n");

    rankedEvaluatedOpportunities.forEach((result, index) => {
      const opportunity = result.opportunity;

      console.log(
        `#${index + 1} ${opportunity.title || "UNTITLED"}`
      );
      console.log(`  NEXT ACTION: ${result.nextAction}`);
      console.log(`  SCOUT DECISION: ${result.scoutDecision}`);
      console.log(`  CONFIDENCE: ${result.confidence ?? "UNKNOWN"}`);
      console.log(`  SOURCE: ${opportunity.source || "UNKNOWN"}`);
      console.log(
        `  VALUE: ${opportunity.value.amount ?? "UNKNOWN"} ${opportunity.value.currency || ""}`
      );
      console.log(`  HUNTER SCORE: ${result.hunterScore}`);
      console.log(
        `  EXPECTED VALUE: ${opportunity.scores.expectedValue}`
      );
      console.log(`  SPEED: ${opportunity.scores.speed}`);
      console.log(`  ROI: ${opportunity.scores.roi ?? "UNKNOWN"}`);
      console.log(`  FRICTION: ${opportunity.scores.friction}`);
      console.log(`  RISK: ${opportunity.scores.risk}`);

      if (result.reasons?.length) {
        console.log("  SCOUT REASONS:");
        result.reasons.forEach((reason) => {
          console.log(`    - ${reason}`);
        });
      }

      console.log("");
    });
    saveCache(cache);

    console.log(
      "\nSafety: no claims, comments, stars, PRs, submissions, or payments executed."
    );
  } catch (error) {
   console.error(error);

    console.log("\n=== VERIFIED CACHE FALLBACK ===\n");

    const cachedCandidates = cachedOpportunityCandidates(cache);

    if (cachedCandidates.length) {
      console.log("SOURCE: VERIFIED CACHE");
      console.log(`Candidates available: ${cachedCandidates.length}\n`);

      for (const item of cachedCandidates) {
        const verification = item.verification;
        displayVerification(verification);
        updateQueueFromVerification(verification);
        updateVerifiedOpportunityQueue(verification);
        console.log("---");
      }

      console.log(
        "Safety: cached fallback is discovery/review-only; no claims, comments, stars, PRs, submissions, or payments executed."
      );
    } else {
      console.log("No recent PAYABLE cached opportunities found.");
      console.log("\n=== LOCAL RADAR FALLBACK ===\n");

      try {
        const candidates = localRadarCandidates(minSats);
        const queue = updateOpportunityQueue(candidates);

        console.log("SOURCE: LOCAL RADAR");
        console.log(`Queue entries: ${Object.keys(queue).length}`);
        console.log(`Candidates loaded: ${candidates.length}\n`);

        for (const item of candidates) {
          displayLocalRadar(item);
        }

        console.log(
          "Safety: local radar is discovery-only; no payment, submission, claim, comment, or other external action executed."
        );
      } catch (localError) {
        console.error(`Local radar fallback failed: ${localError.message}`);
        process.exitCode = 1;
      }
    }
  }
}











function safeRadarValueSats(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (numeric < 0) {
    return null;
  }

  if (!Number.isSafeInteger(numeric)) {
    return null;
  }

  return numeric;
}


function localRadarCandidates(minSats = 0) {
  try {
    const raw = fs.readFileSync("./radar-feed.json", "utf8");
    const feed = JSON.parse(raw);

    if (!Array.isArray(feed)) {
      throw new Error("radar-feed.json must contain an array");
    }

    const seen = new Set();

    return feed
      .map(item => {
        const valueSats = safeRadarValueSats(item.valueSats);

        return {
          ...item,
          reward: valueSats,
          valueSats,
          issueState: "open",
          assignee: null
        };
      })
      .filter(item => item && item.bountyId)
      .filter(item => item.valueSats !== null)
      .filter(item => item.valueSats >= minSats)
      .filter(item => {
        const value = Number(item.valueSats) || 0;
        return value >= minSats;
      })
      .filter(item => {
        const key = String(item.bountyId);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const scoreA = Number(a.score) || 0;
        const scoreB = Number(b.score) || 0;
        return scoreB - scoreA;
      })
      .slice(0, MAX_CANDIDATES);
  } catch (error) {
    throw new Error(`Local radar feed failed: ${error.message}`);
  }
}


function loadOpportunityQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(QUEUE_FILE, "utf8");
    const queue = JSON.parse(raw);

    if (!queue || typeof queue !== "object" || Array.isArray(queue)) {
      throw new Error("queue must be a JSON object");
    }

    return queue;
  } catch (error) {
    throw new Error(`Opportunity queue failed to load: ${error.message}`);
  }
}

function saveOpportunityQueue(queue) {
  try {
    fs.writeFileSync(
      QUEUE_FILE,
      JSON.stringify(queue, null, 2),
      "utf8"
    );
  } catch (error) {
    throw new Error(`Opportunity queue failed to save: ${error.message}`);
  }
}


function normalizeQueueStatus(status) {
  const value = String(status || "NEW").toUpperCase();

  if (!VALID_QUEUE_STATUSES.has(value)) {
    throw new Error(
      `Invalid queue status "${status}". Valid statuses: ${[VALID_QUEUE_STATUSES].join(", ")}`
    );
  }

  return value;
}

function setOpportunityStatus(bountyId, status) {
  const queue = loadOpportunityQueue();
  const id = String(bountyId);

  if (!queue[id]) {
    throw new Error(`Opportunity ${id} is not in the queue.`);
  }

  queue[id].status = normalizeQueueStatus(status);
  queue[id].statusUpdated = new Date().toISOString();

  saveOpportunityQueue(queue);
  return queue[id];
}
function updateOpportunityQueue(candidates) {
  const queue = loadOpportunityQueue();
  const now = new Date().toISOString();

  for (const item of candidates) {
    const id = String(item.bountyId);

    if (!queue[id]) {
      queue[id] = {
        bountyId: id,
        firstSeen: now,
        lastSeen: now,
        timesSeen: 1,
        status: "NEW",
        valueSats: Number(item.valueSats) || 0,
        score: Number(item.score) || 0,
        title: item.title || "UNTITLED",
        community: item.community || "UNKNOWN",
        signals: item.signals || "",
        feed: item.feed || "UNKNOWN"
      };
    } else {
      queue[id].lastSeen = now;
      queue[id].timesSeen += 1;
      queue[id].valueSats = Number(item.valueSats) || queue[id].valueSats;
      queue[id].score = Number(item.score) || queue[id].score;
      queue[id].title = item.title || queue[id].title;
      queue[id].signals = item.signals || queue[id].signals;
    }
  }

  saveOpportunityQueue(queue);
  return queue;
}
function calculateLocalRadarROI(item) {
  const value = Number(item.valueSats || 0);
  const score = Number(item.score || 0);

  const paymentEvidence = collectPaymentEvidence(
    item.title,
    `${item.body || ""}\n${item.description || ""}\n${item.acceptance || ""}`
  );

  let attention = "LOW";

  if (score >= 50 && value >= 10000) {
    attention = "HIGH";
  } else if (score >= 30 || value >= 5000) {
    attention = "MEDIUM";
  }

   return {
    value,
    score,
    attention,

paymentEvidence,

    paymentVerified: paymentEvidence.paymentVerified,
    fundingFound: paymentEvidence.fundingEvidenceFound,
    paymentTermsFound: paymentEvidence.paymentTermsFound,
    acceptanceFound: paymentEvidence.acceptanceStatus === "FOUND",
    workScopeFound: Boolean(item.criteria || item.description || item.body),

    signals: item.signals || "",
    active: String(item.signals || "").includes("ACTIVE"),
    hot: String(item.signals || "").includes("HOT")
  };
}
function calculateLocalRadarDecision(item, roi) {
  const reasons = [];

  let action = "WAIT";
  let confidence = "LOW";

  const value = Number(item.valueSats) || 0;

  if (value >= 10000) {
    reasons.push("high value bounty");
  }

  if (roi.active) {
    reasons.push("active signal detected");
  }

  if (roi.hot) {
    reasons.push("hot signal detected");
  }

  if (roi.attention === "HIGH" && roi.active && roi.hot) {
    action = "INVESTIGATE_FIRST";
    confidence = "HIGH";
  } else if (roi.attention === "MEDIUM" || roi.hot) {
    action = "VERIFY_FIRST";
    confidence = "MEDIUM";
  }

  return {
    action,
    confidence,
    reasons
  };
}function calculateLocalRadarRank(item, roi, decision) {
  let score = 0;
  const reasons = [];
const payabilityReasons = [];
let payability = 0;
roi.payability = 0;

  const value = Number(item.valueSats) || 0;

  if (value >= 10000) {
    score += 40;
    reasons.push("high reward value");
  } else if (value >= 5000) {
    score += 25;
    reasons.push("good reward value");
  } else if (value > 0) {
    score += 10;
    reasons.push("reward detected");
  }

  if (roi.active) {
    score += 25;
    reasons.push("active signal");
  }

  if (roi.hot) {
    score += 15;
    reasons.push("hot signal");
  }

  if (decision.action === "INVESTIGATE_FIRST") {
    score += 20;
    reasons.push("priority decision");
  }


  if (item.paymentEvidence) {
    payability += 30;
    payabilityReasons.push("payment evidence found");
  } else {
    payabilityReasons.push("payment not verified");
  }

  if (item.criteria || item.acceptance) {
    payability += 20;
    payabilityReasons.push("acceptance evidence found");
  } else {
    payabilityReasons.push("acceptance unclear");
  }

  if (item.description || item.body) {
    payability += 20;
    payabilityReasons.push("work scope available");
  } else {
    payabilityReasons.push("work scope unclear");
  }

if (payability >= 60) {
  score += 30;
  reasons.push("high payability");
} else if (payability >= 30) {
  score += 15;
  reasons.push("medium payability");
}

 roi.payability = payability;

return {
  score,
  reasons,
  payability,
  payabilityReasons
};

  }
function displayLocalRadar(item) {
  const roi = calculateLocalRadarROI(item);
  const decision = calculateLocalRadarDecision(item, roi);
  const ranking = calculateLocalRadarRank(item, roi, decision);

if (ranking.payability !== undefined) {
  roi.payability = ranking.payability;
}

  console.log("STATE: VERIFY_PAYMENT");
  console.log("REWARD: UNVERIFIED");
  console.log(`RADAR BOUNTY ID: ${item.bountyId}`);
  console.log(`RADAR VALUE: ${item.valueSats ?? "UNKNOWN"} sats (UNVERIFIED)`);
  console.log(`RADAR SIGNALS: ${item.signals || "NONE"}`);
  console.log(`RADAR FEED: ${item.feed || "UNKNOWN"}`);
  console.log(`RADAR TITLE: ${item.title || "UNTITLED"}`);
  console.log(`RADAR COMMUNITY: ${item.community || "UNKNOWN"}`);
  console.log(`RADAR SCORE: ${item.score ?? "UNKNOWN"}`);
console.log(`ROI VALUE: ${roi.value} sats`);
  console.log(`ROI SCORE: ${roi.score}`);
  console.log(`ROI ATTENTION: ${roi.attention}`);
  console.log(`ROI ACTIVE: ${roi.active ? "YES" : "NO"}`);
  console.log(`ROI HOT: ${roi.hot ? "YES" : "NO"}`);

  console.log("OPPORTUNITY DECISION:");
  console.log(`  ACTION: ${decision.action}`);
  console.log(`  CONFIDENCE: ${decision.confidence}`);

  console.log("  REASONS:");
  for (const reason of decision.reasons) {
    console.log(`    + ${reason}`);
  }

  console.log("OPPORTUNITY RANK:");
  console.log(`  SCORE: ${ranking.score}`);

console.log(`  PAYABILITY: ${ranking.payability}`);
console.log("  PAYMENT REASONS:");

for (const reason of ranking.payabilityReasons) {
  console.log(`    + ${reason}`);
}

  console.log("  REASONS:");
  for (const reason of ranking.reasons) {
    console.log(`    + ${reason}`);
  }

  console.log("ACTION: HUMAN REVIEW REQUIRED");
  console.log("PAYMENT STATUS: VERIFY_PAYMENT");
  console.log("\n---\n");
}










function loadVerifiedOpportunityQueue() {
  try {
    if (!fs.existsSync(VERIFIED_QUEUE_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(VERIFIED_QUEUE_FILE, "utf8");
    const queue = JSON.parse(raw);

    if (!queue || typeof queue !== "object" || Array.isArray(queue)) {
      throw new Error("verified queue must be a JSON object");
    }

    const sanitizedQueue = {};

    for (const [key, item] of Object.entries(queue)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      if (!isReasonableReward(item.reward)) {
        continue;
      }

      sanitizedQueue[key] = item;
    }

    return sanitizedQueue;
  } catch (error) {
    throw new Error(`Verified opportunity queue failed to load: ${error.message}`);
  }
}

function saveVerifiedOpportunityQueue(queue) {
  try {
    fs.writeFileSync(
      VERIFIED_QUEUE_FILE,
      JSON.stringify(queue, null, 2),
      "utf8"
    );
  } catch (error) {
    throw new Error(`Verified opportunity queue failed to save: ${error.message}`);
  }
}

function buildOpportunityPriority(verification) {
  const review = verification?.review || {};
  const packet = review.decisionPacket || {};

  let score = 0;
  const reasons = [];

  if (verification.state !== "PAYABLE") {
    return {
      score: null,
      reasons: [`state is ${verification.state}; paid priority not applicable`],
      basis: "PAYABLE_ONLY",
      humanGate: true
    };
  }

  if (typeof verification.reward === "number" && verification.reward > 0) {
    score += 30;
    reasons.push("+30 reward declared");
  }

  if (verification.issueState === "open") {
    score += 20;
    reasons.push("+20 issue open");
  }

  if (!verification.assignee) {
    score += 15;
    reasons.push("+15 unassigned");
  } else {
    score -= 30;
    reasons.push("-30 already assigned");
  }

  if (packet.workScope === "FOUND") {
    score += 15;
    reasons.push("+15 work scope found");
  } else {
    score -= 10;
    reasons.push("-10 work scope unclear");
  }

  if (packet.funding === "FOUND") {
    score += 15;
    reasons.push("+15 funding evidence found");
  } else {
    score -= 5;
    reasons.push("-5 funding not verified");
  }

  if (packet.payment === "PAYMENT_TERMS_FOUND") {
    score += 10;
    reasons.push("+10 payment terms found");
  } else if (packet.payment === "DECLARED_REWARD_ONLY") {
    reasons.push("reward is declared only");
  }

  if (packet.eligibility === "FOUND") {
    score += 5;
    reasons.push("+5 eligibility evidence found");
  } else {
    reasons.push("eligibility not verified");
  }

  if (packet.acceptance === "FOUND") {
    score += 5;
    reasons.push("+5 acceptance evidence found");
  } else {
    reasons.push("acceptance not verified");
  }

  return {
    score,
    reasons,
    basis: "EXPLICIT_VERIFICATION_SIGNALS_ONLY",
    humanGate: true
  };
}

function buildAvailabilityAssessment(verification) {
  const reasons = [];

  const scoutDecision =
    verification.decision || buildOpportunityDecision(verification);

  if (scoutDecision.decision !== "PURSUE_NOW") {
    return {
      status: "NOT_AVAILABLE",
      reasons: [
        "Scout decision is " + scoutDecision.decision,
        ...(scoutDecision.reasons || [])
      ],
      scoutDecision: scoutDecision.decision,
      humanGate: true
    };
  }

  if (verification.state !== "PAYABLE") {
    return {
      status: "NOT_AVAILABLE",
      reasons: ["state is " + verification.state],
      scoutDecision: scoutDecision.decision,
      humanGate: true
    };
  }

  if (verification.issueState !== "open") {
    return {
      status: "NOT_AVAILABLE",
      reasons: ["issue is not open"],
      scoutDecision: scoutDecision.decision,
      humanGate: true
    };
  }

  if (verification.assignee) {
    return {
      status: "NOT_AVAILABLE",
      reasons: ["already assigned to " + verification.assignee],
      scoutDecision: scoutDecision.decision,
      humanGate: true
    };
  }

  const activePrs =
    verification.relatedWork?.activePullRequests || [];

  if (activePrs.length > 0) {
    return {
      status: "NOT_AVAILABLE",
      reasons: [
        activePrs.length + " active non-draft PR(s) already exist"
      ],
      activePrCount: activePrs.length,
      scoutDecision: scoutDecision.decision,
      humanGate: true
    };
  }

  reasons.push("reward declared");
  reasons.push("issue open");
  reasons.push("unassigned");
  reasons.push("no active implementation PR");
  reasons.push("Scout decision is PURSUE_NOW");

  return {
    status: "AVAILABLE",
    reasons,
    activePrCount: 0,
    scoutDecision: scoutDecision.decision,
    humanGate: true
  };
}
function updateVerifiedOpportunityQueue(verification) {
  const queue = loadVerifiedOpportunityQueue();

  const key = `${verification.repo}#${verification.number}`;

  const decision =
    verification.decision || buildOpportunityDecision(verification);

  const assessedVerification = {
    ...verification,
    decision
  };

  if (
    verification.state === "PAYABLE" &&
    isReasonableReward(verification.reward)
  ) {
    queue[key] = {
      repo: verification.repo,
      number: verification.number,
      title: verification.title,
      reward: verification.reward,
      state: verification.state,
      issueState: verification.issueState,
      assignee: verification.assignee,
      url: verification.url,
      criteria: verification.criteria,
      verifiedAt: verification.verifiedAt,
      review: verification.review,
      decisionPacket: verification.review.decisionPacket,
      decision,
      priority: buildOpportunityPriority(verification),
      availability: buildAvailabilityAssessment(assessedVerification),
    };
  } else {
    delete queue[key];
  }

  saveVerifiedOpportunityQueue(queue);
  return queue;
}
function updateQueueFromVerification(verification) {
  const queue = loadOpportunityQueue();

  if (!verification?.radar?.bountyId) {
    return queue;
  }

  const id = String(verification.radar.bountyId);

  if (!queue[id]) {
    return queue;
  }

  queue[id].verified = {
    source: "GITHUB",
    state: verification.state,
    reward: verification.reward,
    issueState: verification.issueState,
    assignee: verification.assignee,
    url: verification.url,
    title: verification.title,
    criteria: verification.criteria,
      verifiedAt: verification.verifiedAt,
      review: verification.review,
      decisionPacket: verification.review.decisionPacket,
  };

  queue[id].lastVerified = verification.verifiedAt;

  saveOpportunityQueue(queue);
  return queue;
}

function calculateROI(verification) {
  const reward = typeof verification.reward === "number"
    ? verification.reward
    : 0;

  const criteriaCount = verification.criteria?.length || 0;
  const activePRs = verification.relatedWork?.activePullRequests?.length || 0;

  const fundingFound = verification.review?.paymentEvidence?.fundingStatus === "FOUND";
  const paymentReady = verification.review?.paymentVerified === true;

  let score = 0;

  if (reward > 0) score += 40;
  if (fundingFound) score += 20;
  if (paymentReady) score += 20;
  if (criteriaCount > 0) score += 10;
  if (activePRs === 0) score += 10;

  if (activePRs > 0) score -= activePRs * 15;

  let label = "LOW";

  if (score >= 70) {
    label = "HIGH";
  } else if (score >= 40) {
    label = "MEDIUM";
  }

  return {
    score,
    label,
    reward,
    criteriaCount,
    activePRs
  };
}

function buildOpportunityDecision(verification) {
  const review = verification.review || {};
  const evidence = review.paymentEvidence || {};
  const relatedWork = verification.relatedWork || {};
  const paymentTruth = verification.paymentTruth || {};

  const workScope =
  verification.criteria?.length > 0 ||
  review.workScope?.status === "FOUND";
  const activePRs = relatedWork.activePullRequests?.length || 0;
  const assignedActivePRs = relatedWork.activeAssignedPullRequests?.length || 0;
  const implementationStatus = relatedWork.implementationStatus || "UNKNOWN";

  let decision = "DO_NOT_PURSUE";
  let confidence = "MEDIUM";
  const reasons = [];

  if (verification.state === "PAYABLE") {
    reasons.push("reward detected");
  }

  if (verification.issueState === "open") {
    reasons.push("issue open");
  }

  if (!verification.assignee) {
    reasons.push("unassigned");
  }

  if (workScope) {
    reasons.push("work scope found");
  }

  if (review.paymentEvidenceStatus === "PAYMENT_TERMS_FOUND") {
    reasons.push("payment language detected");
  }

  const fundingMissing = evidence.fundingStatus === "NOT_FOUND";
  const eligibilityMissing = evidence.eligibilityStatus === "NOT_FOUND";
  const rewardIntegrityStatus =
    paymentTruth.rewardIntegrityStatus ||
    evidence.rewardIntegrityStatus ||
    "UNKNOWN";

  if (rewardIntegrityStatus !== "CLEAN") {
    reasons.push(`reward integrity: ${rewardIntegrityStatus}`);
  }

  if (fundingMissing) {
    reasons.push("funding not verified");
  }

  if (eligibilityMissing) {
    reasons.push("eligibility not verified");
  }

  if (implementationStatus === "IN_PROGRESS") {
    reasons.push("existing implementation underway");
  }

  if (activePRs > 0) {
    reasons.push(`${activePRs} active PR(s) detected`);
  }

  if (assignedActivePRs > 0) {
    reasons.push("assigned contributor already implementing");
  }

  if (
    rewardIntegrityStatus === "SUSPICIOUS_MISMATCH" ||
    rewardIntegrityStatus === "MULTIPLE_SOURCE_CLAIMS"
  ) {
    decision = "DO_NOT_PURSUE";
    confidence = "HIGH";
  } else if (activePRs > 0 || assignedActivePRs > 0) {
    decision = "DO_NOT_PURSUE";
    confidence = "HIGH";
  } else if (
    verification.state === "PAYABLE" &&
    workScope &&
    review.paymentVerified === true &&
    rewardIntegrityStatus === "CLEAN" &&
    !fundingMissing &&
    !eligibilityMissing
  ) {
    decision = "PURSUE_NOW";
    confidence = "HIGH";
  } else if (verification.state === "PAYABLE" && workScope) {
    decision = "VERIFY_FIRST";
    confidence = "HIGH";
  }

  if (!workScope) {
    decision = "DO_NOT_PURSUE";
    confidence = "HIGH";
  }

  return {
    decision,
    confidence,
    reasons
  };
}

function displayVerification(verification) {
  console.log(`VERIFICATION: ${verification.cached ? "CACHED" : (verification.verificationMode || "FRESH")}`);
  console.log(`VERIFIED ISSUE: ${verification.repo}#${verification.number}`);
  console.log(`TITLE: ${verification.title || "UNTITLED"}`);
console.log(`STATE: ${verification.state}`);
  console.log(`REWARD: ${verification.reward ?? "NOT FOUND"}`);
  console.log(`ISSUE STATE: ${verification.issueState}`);
  console.log(`ASSIGNEE: ${verification.assignee || "NONE"}`);
  console.log(`URL: ${verification.url}`);

  const relatedWork = verification.relatedWork || null;

  if (relatedWork) {
    console.log(`IMPLEMENTATION STATUS: ${relatedWork.implementationStatus || "UNKNOWN"}`);
    console.log(`LINKED ISSUES: ${relatedWork.linkedIssues?.length || 0}`);
    console.log(`ACTIVE PRS: ${relatedWork.activePullRequests?.length || 0}`);
    console.log(`ACTIVE ASSIGNED PRS: ${relatedWork.activeAssignedPullRequests?.length || 0}`);

    for (const pr of relatedWork.activePullRequests || []) {
      console.log(`  PR #${pr.number}: ${pr.title}`);
      console.log(`    AUTHOR: ${pr.author || "UNKNOWN"}`);
      console.log(`    STATE: ${pr.state}`);
      console.log(`    DRAFT: ${pr.draft ? "YES" : "NO"}`);
      console.log(`    URL: ${pr.url}`);
    }
  }

    console.log('PR FRESHNESS:');

    for (const pr of relatedWork.activePullRequests || []) {
      const inactiveHours = typeof pr.inactiveHours === 'number' ? pr.inactiveHours : null;
      const freshness = inactiveHours === null ? 'UNKNOWN' : inactiveHours >= 48 ? 'ACTIVE_STALE' : 'ACTIVE_RECENT';
      const assigned = relatedWork.assignedContributors?.includes(pr.author) || relatedWork.assignedContributors?.includes(pr.assignee);
      const assignmentLabel = assigned ? ' | ASSIGNED_ACTIVE' : '';
      const inactiveLabel = inactiveHours === null ? 'UNKNOWN' : inactiveHours.toFixed(1) + 'h';
      console.log('  #' + pr.number + ' ' + freshness + assignmentLabel + ' | INACTIVE: ' + inactiveLabel + ' | COMMITS: ' + (pr.commits ?? '?') + ' | REVIEW COMMENTS: ' + (pr.reviewComments ?? '?'));
    }

  const evidenceLinks = verification.evidenceLinks || {};
  const links = Array.isArray(evidenceLinks.links)
    ? evidenceLinks.links
    : [];

  console.log(`EVIDENCE LINKS: ${links.length}`);

  const evidenceRetrieval = verification.relatedWork?.evidenceRetrieval || {};
  const attemptedEvidence = Array.isArray(evidenceRetrieval.attempted)
    ? evidenceRetrieval.attempted
    : [];
  const succeededEvidence = Array.isArray(evidenceRetrieval.succeeded)
    ? evidenceRetrieval.succeeded
    : [];
  const failedEvidence = Array.isArray(evidenceRetrieval.failed)
    ? evidenceRetrieval.failed
    : [];

  console.log(`EVIDENCE RETRIEVAL: attempted=${attemptedEvidence.length} succeeded=${succeededEvidence.length} failed=${failedEvidence.length}`);

  for (const failure of failedEvidence) {
    console.log(`  FAILED: ${failure.url} | ${failure.error}`);
  }

  for (const link of links) {
    console.log(`  ${link}`);
  }
  console.log(`CRITERIA: ${verification.criteria?.length || 0} items`);
  console.log(`VERIFIED AT: ${verification.verifiedAt}`);

  const humanReview =
    verification.review?.humanReviewSummary ||
    buildHumanReviewSummary(
      verification.state,
      verification.reward,
      verification.issueState,
      verification.assignee,
      verification.criteria,
      verification.review?.paymentEvidence,
      verification.relatedWork
    );

  if (humanReview) {
    console.log("HUMAN REVIEW:");
    for (const line of humanReview.summary || []) {
      console.log(`  ${line}`);
    }
    console.log(`  RECOMMENDATION: ${humanReview.recommendation || "DO NOT PURSUE YET"}`);
    console.log(`  HUMAN GATE: ${humanReview.humanGate ? "REQUIRED" : "NOT REQUIRED"}`);


  const paymentTruth = verification.paymentTruth || {};
  console.log("PAYMENT TRUTH:");
  console.log(`  Declared reward: ${paymentTruth.declaredReward != null ? "$" + paymentTruth.declaredReward : "NOT_FOUND"}`);
  console.log(`  Source reward: ${paymentTruth.sourceReward != null ? "$" + paymentTruth.sourceReward : "NOT_FOUND"}`);
  console.log(`  Reward verification: ${paymentTruth.rewardStatus || "NOT_FOUND"}`);
  console.log(`  Reward integrity: ${paymentTruth.rewardIntegrityStatus || "NOT_FOUND"}`);
  console.log(
    `  Suspicious raw rewards: ${
      Array.isArray(paymentTruth.suspiciousRawRewards) &&
      paymentTruth.suspiciousRawRewards.length
        ? paymentTruth.suspiciousRawRewards.map(value => "$" + value).join(", ")
        : "NONE"
    }`
  );
 console.log(`  Funding: ${paymentTruth.fundingStatus || "NOT_FOUND"}`);
console.log(`  Funding mechanism: ${paymentTruth.fundingMechanismStatus || "NOT_FOUND"}`);
    console.log(`  Payment policy: ${paymentTruth.paymentPolicyStatus || "NOT_FOUND"}`);
    console.log(
      `  Repository signals: ${
        Array.isArray(paymentTruth.fundingMechanismEvidence) &&
        paymentTruth.fundingMechanismEvidence.length
          ? paymentTruth.fundingMechanismEvidence.join(" | ")
          : "NONE"
      }`
    );
    console.log(
      `  Payment policy evidence: ${
        Array.isArray(paymentTruth.paymentPolicyEvidence) &&
        paymentTruth.paymentPolicyEvidence.length
          ? paymentTruth.paymentPolicyEvidence.length + " lines"
          : "NONE"
      }`
    );
console.log(`  Eligibility: ${paymentTruth.eligibilityStatus || "NOT_FOUND"}`);
  console.log(`  Payment ready: ${paymentTruth.paymentReady === true ? "YES" : "NO"}`);

  if (verification.roi) {
    console.log("ROI ANALYSIS:");
    console.log(`  SCORE: ${verification.roi.score}`);
    console.log(`  RATING: ${verification.roi.label}`);
    console.log(`  REWARD: $${verification.roi.reward}`);
    console.log(`  CRITERIA COUNT: ${verification.roi.criteriaCount}`);
    console.log(`  ACTIVE PRS: ${verification.roi.activePRs}`);
  }
  }


  const decision = buildOpportunityDecision(verification);

  console.log("OPPORTUNITY DECISION:");
  console.log(`  DECISION: ${decision.decision}`);
  console.log(`  CONFIDENCE: ${decision.confidence}`);

  for (const reason of decision.reasons || []) {
    console.log(`  ${reason}`);
  }

  const priority = verification.review?.priority ||
    verification.priority ||
    null;

  if (priority) {
    console.log(`PRIORITY: ${priority.score}`);
    console.log("WHY:");
    for (const reason of priority.reasons || []) {
      console.log(`  ${reason}`);
    }
    console.log(`PRIORITY BASIS: ${priority.basis}`);
    console.log(`HUMAN GATE: ${priority.humanGate ? "REQUIRED" : "NOT REQUIRED"}`);
  }

  console.log("---");
}




































function isPullRequestLinkedToIssue(pr, issue) {
  if (!pr || !issue) {
    return false;
  }

  if (
    !pr.repo ||
    !issue.repo ||
    pr.repo.toLowerCase() !== issue.repo.toLowerCase()
  ) {
    return false;
  }

  if (
    !Number.isInteger(Number(pr.number)) ||
    !Number.isInteger(Number(issue.number))
  ) {
    return false;
  }

  return (
    pr.linkedIssue === `${issue.repo}#${issue.number}` &&
    pr.relationshipVerified === true
  );
}

module.exports = {
  buildOpportunityDecision,
  buildPaymentTruth,
  isPullRequestLinkedToIssue,
  currencyFromText
};
if (require.main === module) {
  main();
}
