const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateLineTotal, isIsoDate, parseMoney, parseQuantity } = require("./validation");

test("parses USD decimals and rounds CDF to whole francs", () => {
  assert.equal(parseMoney("125.40", "USD"), 12540);
  assert.equal(parseMoney("2,5", "USD"), 250);
  assert.equal(parseMoney("125", "CDF"), 125);
});

test("rejects fractional CDF and malformed monetary values", () => {
  assert.throws(() => parseMoney("10.50", "CDF"), /CDF valide/);
  assert.throws(() => parseMoney("-1", "USD"), /USD valide/);
});

test("calculates quantities in thousandths without floating-point currency totals", () => {
  assert.equal(parseQuantity("1.250"), 1250);
  assert.equal(calculateLineTotal(1250, 199), 249);
  assert.throws(() => parseQuantity("0"), /positive/);
});

test("accepts only real ISO calendar dates", () => {
  assert.equal(isIsoDate("2026-11-24"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
});
