const assert = require("assert");

const {
  currencyFromText
} = require("./scout.js");

// Explicit USD
assert.strictEqual(currencyFromText("Reward: $250 USD", 250), "USD");
assert.strictEqual(currencyFromText("USD $250", 250), "USD");
assert.strictEqual(currencyFromText("US$250", 250), "USD");

// Explicit CAD
assert.strictEqual(currencyFromText("Reward: $250 CAD", 250), "CAD");
assert.strictEqual(currencyFromText("C$250", 250), "CAD");

// Explicit AUD
assert.strictEqual(currencyFromText("Reward: $250 AUD", 250), "AUD");
assert.strictEqual(currencyFromText("A$250", 250), "AUD");

// Unknown currency
assert.strictEqual(currencyFromText("Reward: $250", 250), null);

// Conflicting currency markers
assert.strictEqual(
  currencyFromText("Reward: $250 USD or $250 CAD", 250),
  null
);

// Comma-formatted amount
assert.strictEqual(currencyFromText("Reward: $2,500 USD", 2500), "USD");

// Unrelated currency must not identify the reward
assert.strictEqual(
  currencyFromText("USD is accepted. Reward: $250", 250),
  null
);

console.log("ALL CURRENCY TESTS PASSED");