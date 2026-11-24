const CURRENCY_EXPONENT = Object.freeze({ USD: 2, CDF: 0 });

function parseMoney(value, currency) {
  const exponent = CURRENCY_EXPONENT[currency];
  if (exponent === undefined || typeof value !== "string") {
    throw new Error("Devise ou montant invalide.");
  }

  const pattern = exponent === 2 ? /^\d{1,12}(?:[.,]\d{1,2})?$/ : /^\d{1,12}$/;
  const normalized = value.trim().replace(",", ".");
  if (!pattern.test(normalized)) {
    throw new Error(currency === "USD"
      ? "Saisissez un montant USD valide (maximum 2 décimales)."
      : "Saisissez un montant CDF valide en nombre entier.");
  }

  const [whole, fraction = ""] = normalized.split(".");
  const minor = Number(whole) * (exponent === 2 ? 100 : 1)
    + Number(fraction.padEnd(exponent, "0") || 0);
  if (!Number.isSafeInteger(minor)) {
    throw new Error("Le montant dépasse la limite autorisée.");
  }
  return minor;
}

function parseQuantity(value) {
  if (typeof value !== "string" || !/^\d{1,8}(?:[.,]\d{1,3})?$/.test(value.trim())) {
    throw new Error("Saisissez une quantité positive (maximum 3 décimales).");
  }
  const [whole, fraction = ""] = value.trim().replace(",", ".").split(".");
  const quantityMilli = Number(whole) * 1000 + Number(fraction.padEnd(3, "0") || 0);
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0) {
    throw new Error("Saisissez une quantité positive valide.");
  }
  return quantityMilli;
}

function calculateLineTotal(quantityMilli, unitPriceMinor) {
  const total = Math.round((quantityMilli * unitPriceMinor) / 1000);
  if (!Number.isSafeInteger(total)) {
    throw new Error("Le montant de la ligne dépasse la limite autorisée.");
  }
  return total;
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

module.exports = { calculateLineTotal, isIsoDate, parseMoney, parseQuantity };
