const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const express = require("express");
const { Pool } = require("pg");
const { calculateLineTotal, isIsoDate, parseMoney, parseQuantity } = require("./lib/validation");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "inovtech_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAFE_MINOR = Number.MAX_SAFE_INTEGER;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL doit être défini.");
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET doit contenir au moins 32 caractères.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false,
});
pool.on("error", (error) => console.error("Erreur PostgreSQL inattendue :", error.message));

const app = express();
const isProduction = process.env.NODE_ENV === "production";
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(isProduction ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  });
  next();
});
app.use(express.json({ limit: "100kb" }));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function text(value, label, maxLength, { required = false } = {}) {
  if (typeof value !== "string") throw new HttpError(400, `${label} est invalide.`);
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > maxLength) {
    throw new HttpError(400, `${label} est obligatoire et ne doit pas dépasser ${maxLength} caractères.`);
  }
  return cleaned;
}

function parseId(value, label = "Identifiant") {
  if (!/^[1-9]\d{0,14}$/.test(String(value))) throw new HttpError(400, `${label} invalide.`);
  return String(value);
}

function parseDate(value, label) {
  if (!isIsoDate(value)) throw new HttpError(400, `${label} doit être une date valide.`);
  return value;
}

function getCookie(req, name) {
  const prefix = `${name}=`;
  const entry = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}

function sha256(value) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET).update(value).digest("hex");
}

function todayInKinshasa() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kinshasa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function requireSameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  const expected = `${req.protocol}://${req.get("host")}`;
  if (!origin || origin !== expected) return res.status(403).json({ error: "Origine de la requête refusée." });
  next();
}

async function authenticate(req, res, next) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: "Connexion requise." });
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE`,
      [sha256(token)],
    );
    if (!result.rowCount) return res.status(401).json({ error: "Session expirée. Reconnectez-vous." });
    req.user = result.rows[0];
    next();
  } catch (error) {
    next(error);
  }
}

const loginAttempts = new Map();
function rateLimitLogin(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const record = loginAttempts.get(key) || { count: 0, resetAt: now + 60_000 };
  if (record.resetAt <= now) {
    record.count = 0;
    record.resetAt = now + 60_000;
  }
  record.count += 1;
  loginAttempts.set(key, record);
  if (record.count > 10) return res.status(429).json({ error: "Trop de tentatives. Réessayez dans une minute." });
  next();
}

async function verifyPassword(password, storedHash) {
  const [algorithm, saltHex, hashHex] = storedHash.split("$");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(hashHex)) {
    throw new Error("Format de mot de passe stocké invalide.");
  }
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function inTransaction(action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const invoiceSelect = `
  SELECT i.id, i.invoice_number, i.client_id, i.currency, i.status, i.issue_date, i.due_date, i.notes,
         i.created_at, c.name AS client_name, c.organization AS client_organization,
         COALESCE((SELECT SUM(ii.line_total_minor) FROM invoice_items ii WHERE ii.invoice_id = i.id), 0)::text AS total_minor,
         COALESCE((SELECT SUM(p.amount_minor) FROM payments p WHERE p.invoice_id = i.id), 0)::text AS paid_minor
  FROM invoices i JOIN clients c ON c.id = i.client_id`;

function publicInvoice(row) {
  const totalMinor = Number(row.total_minor);
  const paidMinor = Number(row.paid_minor);
  const dueDate = String(row.due_date).slice(0, 10);
  let state = row.status;
  if (row.status === "issued") {
    if (paidMinor >= totalMinor) state = "paid";
    else if (dueDate < todayInKinshasa()) state = "overdue";
    else if (paidMinor > 0) state = "partial";
    else state = "unpaid";
  }
  return {
    id: String(row.id),
    invoiceNumber: row.invoice_number,
    clientId: String(row.client_id),
    clientName: row.client_name,
    clientOrganization: row.client_organization,
    currency: row.currency,
    status: state,
    issueDate: String(row.issue_date).slice(0, 10),
    dueDate,
    notes: row.notes,
    totalMinor,
    paidMinor,
    balanceMinor: Math.max(0, totalMinor - paidMinor),
    createdAt: row.created_at,
  };
}

app.get("/api/healthz", route(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
}));

app.use("/api", requireSameOrigin);

app.post("/api/login", rateLimitLogin, route(async (req, res) => {
  const email = text(req.body?.email, "Adresse e-mail", 254).toLowerCase();
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const result = await pool.query(
    "SELECT id, name, email, role, password_hash FROM users WHERE email = $1 AND is_active = TRUE",
    [email],
  );
  const user = result.rows[0];
  const validPassword = user
    ? await verifyPassword(password, user.password_hash)
    : (await scrypt(password, Buffer.alloc(16), 64), false);
  if (!validPassword) {
    return res.status(401).json({ error: "Adresse e-mail ou mot de passe incorrect." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [sha256(token), user.id, expiresAt],
  );
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
  res.json({ user: { id: String(user.id), name: user.name, email: user.email, role: user.role } });
}));

app.post("/api/logout", authenticate, route(async (req, res) => {
  const token = getCookie(req, SESSION_COOKIE);
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: isProduction, sameSite: "strict", path: "/" });
  res.json({ ok: true });
}));

app.get("/api/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/summary", authenticate, route(async (_req, res) => {
  const result = await pool.query(`${invoiceSelect} ORDER BY i.created_at DESC`);
  const invoices = result.rows.map(publicInvoice);
  const summary = {
    clients: (await pool.query("SELECT COUNT(*)::int AS count FROM clients")).rows[0].count,
    invoices: invoices.filter((invoice) => invoice.status !== "draft" && invoice.status !== "cancelled").length,
    overdue: invoices.filter((invoice) => invoice.status === "overdue").length,
    outstanding: {
      USD: invoices.filter((invoice) => invoice.currency === "USD" && ["unpaid", "partial", "overdue"].includes(invoice.status))
        .reduce((sum, invoice) => sum + invoice.balanceMinor, 0),
      CDF: invoices.filter((invoice) => invoice.currency === "CDF" && ["unpaid", "partial", "overdue"].includes(invoice.status))
        .reduce((sum, invoice) => sum + invoice.balanceMinor, 0),
    },
  };
  res.json(summary);
}));

app.get("/api/clients", authenticate, route(async (_req, res) => {
  const result = await pool.query(
    "SELECT id, name, organization, email, phone, address, created_at FROM clients ORDER BY name",
  );
  res.json(result.rows.map((client) => ({ ...client, id: String(client.id) })));
}));

app.post("/api/clients", authenticate, route(async (req, res) => {
  const body = req.body || {};
  const name = text(body.name, "Nom du client", 160, { required: true });
  const organization = text(body.organization ?? "", "Entreprise", 160);
  const email = text(body.email ?? "", "E-mail", 254);
  const phone = text(body.phone ?? "", "Téléphone", 40);
  const address = text(body.address ?? "", "Adresse", 500);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Adresse e-mail invalide.");
  const result = await pool.query(
    `INSERT INTO clients (name, organization, email, phone, address, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, organization, email, phone, address, created_at`,
    [name, organization, email, phone, address, req.user.id],
  );
  res.status(201).json({ ...result.rows[0], id: String(result.rows[0].id) });
}));

app.get("/api/invoices", authenticate, route(async (_req, res) => {
  const result = await pool.query(`${invoiceSelect} ORDER BY i.created_at DESC`);
  res.json(result.rows.map(publicInvoice));
}));

app.post("/api/invoices", authenticate, route(async (req, res) => {
  const body = req.body || {};
  const clientId = parseId(body.clientId, "Client");
  const currency = body.currency;
  if (!["USD", "CDF"].includes(currency)) throw new HttpError(400, "Choisissez USD ou CDF.");
  const issueDate = parseDate(body.issueDate, "La date d’émission");
  const dueDate = parseDate(body.dueDate, "La date d’échéance");
  if (dueDate < issueDate) throw new HttpError(400, "L’échéance ne peut pas précéder la date d’émission.");
  const notes = text(body.notes ?? "", "Notes", 2000);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    throw new HttpError(400, "Ajoutez de 1 à 50 lignes à la facture.");
  }
  const items = body.items.map((item) => {
    const description = text(item.description, "Description de ligne", 240, { required: true });
    let quantityMilli;
    let unitPriceMinor;
    try {
      quantityMilli = parseQuantity(item.quantity);
      unitPriceMinor = parseMoney(item.unitPrice, currency);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    return { description, quantityMilli, unitPriceMinor, lineTotalMinor: calculateLineTotal(quantityMilli, unitPriceMinor) };
  });
  const totalMinor = items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  if (totalMinor <= 0) throw new HttpError(400, "Le total de la facture doit être supérieur à zéro.");
  if (!Number.isSafeInteger(totalMinor) || totalMinor > MAX_SAFE_MINOR) {
    throw new HttpError(400, "Le total de la facture dépasse la limite autorisée.");
  }

  const invoiceId = await inTransaction(async (client) => {
    const clientResult = await client.query("SELECT id FROM clients WHERE id = $1", [clientId]);
    if (!clientResult.rowCount) throw new HttpError(404, "Client introuvable.");
    const invoice = await client.query(
      `INSERT INTO invoices (client_id, currency, status, issue_date, due_date, notes, created_by)
       VALUES ($1, $2, 'draft', $3, $4, $5, $6) RETURNING id`,
      [clientId, currency, issueDate, dueDate, notes, req.user.id],
    );
    for (const item of items) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, description, quantity_milli, unit_price_minor, line_total_minor)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoice.rows[0].id, item.description, item.quantityMilli, item.unitPriceMinor, item.lineTotalMinor],
      );
    }
    return invoice.rows[0].id;
  });
  res.status(201).json({ id: String(invoiceId) });
}));

app.get("/api/invoices/:id", authenticate, route(async (req, res) => {
  const invoiceId = parseId(req.params.id, "Facture");
  const result = await pool.query(`${invoiceSelect} WHERE i.id = $1`, [invoiceId]);
  if (!result.rowCount) throw new HttpError(404, "Facture introuvable.");
  const invoice = publicInvoice(result.rows[0]);
  const [items, payments, client] = await Promise.all([
    pool.query(
      "SELECT description, quantity_milli::text, unit_price_minor::text, line_total_minor::text FROM invoice_items WHERE invoice_id = $1 ORDER BY id",
      [invoiceId],
    ),
    pool.query(
      `SELECT p.id, p.amount_minor::text, p.payment_date, p.method, p.reference, u.name AS recorded_by
       FROM payments p JOIN users u ON u.id = p.created_by WHERE p.invoice_id = $1 ORDER BY p.payment_date, p.id`,
      [invoiceId],
    ),
    pool.query(
      "SELECT name, organization, email, phone, address FROM clients WHERE id = $1",
      [invoice.clientId],
    ),
  ]);
  res.json({
    ...invoice,
    items: items.rows.map((item) => ({
      description: item.description,
      quantityMilli: Number(item.quantity_milli),
      unitPriceMinor: Number(item.unit_price_minor),
      lineTotalMinor: Number(item.line_total_minor),
    })),
    payments: payments.rows.map((payment) => ({
      id: String(payment.id),
      amountMinor: Number(payment.amount_minor),
      date: String(payment.payment_date).slice(0, 10),
      method: payment.method,
      reference: payment.reference,
      recordedBy: payment.recorded_by,
    })),
    client: client.rows[0],
  });
}));

app.post("/api/invoices/:id/issue", authenticate, route(async (req, res) => {
  const invoiceId = parseId(req.params.id, "Facture");
  const invoiceNumber = await inTransaction(async (client) => {
    const locked = await client.query(
      "SELECT id, status, issue_date FROM invoices WHERE id = $1 FOR UPDATE",
      [invoiceId],
    );
    if (!locked.rowCount) throw new HttpError(404, "Facture introuvable.");
    if (locked.rows[0].status !== "draft") throw new HttpError(409, "Cette facture n’est plus un brouillon.");
    const year = Number(String(locked.rows[0].issue_date).slice(0, 4));
    const counter = await client.query(
      `INSERT INTO invoice_counters (invoice_year, next_value) VALUES ($1, 2)
       ON CONFLICT (invoice_year) DO UPDATE SET next_value = invoice_counters.next_value + 1
       RETURNING next_value - 1 AS issued_number`,
      [year],
    );
    const number = Number(counter.rows[0].issued_number);
    const formatted = `INV-${year}-${String(number).padStart(5, "0")}`;
    await client.query("UPDATE invoices SET status = 'issued', invoice_number = $1 WHERE id = $2", [formatted, invoiceId]);
    return formatted;
  });
  res.json({ invoiceNumber });
}));

app.post("/api/invoices/:id/cancel", authenticate, route(async (req, res) => {
  const invoiceId = parseId(req.params.id, "Facture");
  await inTransaction(async (client) => {
    const invoice = await client.query("SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
    if (!invoice.rowCount) throw new HttpError(404, "Facture introuvable.");
    if (invoice.rows[0].status === "cancelled") throw new HttpError(409, "Cette facture est déjà annulée.");
    const payments = await client.query("SELECT COUNT(*)::int AS count FROM payments WHERE invoice_id = $1", [invoiceId]);
    if (payments.rows[0].count > 0) throw new HttpError(409, "Une facture avec des paiements ne peut pas être annulée ici.");
    await client.query("UPDATE invoices SET status = 'cancelled' WHERE id = $1", [invoiceId]);
  });
  res.json({ ok: true });
}));

app.post("/api/invoices/:id/payments", authenticate, route(async (req, res) => {
  const invoiceId = parseId(req.params.id, "Facture");
  const body = req.body || {};
  const paymentDate = parseDate(body.date, "La date du paiement");
  const methods = ["cash", "mobile_money", "bank_transfer", "other"];
  if (!methods.includes(body.method)) throw new HttpError(400, "Choisissez un mode de paiement valide.");
  const reference = text(body.reference ?? "", "Référence", 120);
  const amountMinor = (() => {
    try {
      return parseMoney(body.amount, body.currency);
    } catch (error) {
      throw new HttpError(400, error.message);
    }
  })();
  if (amountMinor <= 0) throw new HttpError(400, "Le paiement doit être supérieur à zéro.");

  const paymentId = await inTransaction(async (client) => {
    const locked = await client.query(
      "SELECT id, status, currency FROM invoices WHERE id = $1 FOR UPDATE",
      [invoiceId],
    );
    if (!locked.rowCount) throw new HttpError(404, "Facture introuvable.");
    const invoice = locked.rows[0];
    if (invoice.status !== "issued") throw new HttpError(409, "Seules les factures émises peuvent recevoir un paiement.");
    if (body.currency !== invoice.currency) throw new HttpError(400, "La devise du paiement doit correspondre à celle de la facture.");
    const totals = await client.query(
      `SELECT
         COALESCE((SELECT SUM(line_total_minor) FROM invoice_items WHERE invoice_id = $1), 0)::text AS total_minor,
         COALESCE((SELECT SUM(amount_minor) FROM payments WHERE invoice_id = $1), 0)::text AS paid_minor`,
      [invoiceId],
    );
    const total = Number(totals.rows[0].total_minor);
    const paid = Number(totals.rows[0].paid_minor);
    if (amountMinor > total - paid) throw new HttpError(400, "Le paiement dépasse le reste à payer.");
    const result = await client.query(
      `INSERT INTO payments (invoice_id, amount_minor, payment_date, method, reference, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [invoiceId, amountMinor, paymentDate, body.method, reference, req.user.id],
    );
    return result.rows[0].id;
  });
  res.status(201).json({ id: String(paymentId) });
}));

app.get("/api/users", authenticate, route(async (req, res) => {
  if (req.user.role !== "admin") throw new HttpError(403, "Action réservée à l’administrateur.");
  const result = await pool.query("SELECT id, name, email, role, is_active FROM users ORDER BY name");
  res.json(result.rows.map((user) => ({ ...user, id: String(user.id) })));
}));

app.post("/api/users", authenticate, route(async (req, res) => {
  if (req.user.role !== "admin") throw new HttpError(403, "Action réservée à l’administrateur.");
  const body = req.body || {};
  const name = text(body.name, "Nom", 160, { required: true });
  const email = text(body.email, "Adresse e-mail", 254, { required: true }).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const role = body.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Adresse e-mail invalide.");
  if (password.length < 12 || password.length > 200) throw new HttpError(400, "Le mot de passe doit contenir entre 12 et 200 caractères.");
  if (!["admin", "member"].includes(role)) throw new HttpError(400, "Rôle utilisateur invalide.");
  const passwordHash = await hashPassword(password);
  const result = await pool.query(
    "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role, is_active",
    [name, email, passwordHash, role],
  );
  res.status(201).json({ ...result.rows[0], id: String(result.rows[0].id) });
}));

app.patch("/api/users/:id", authenticate, route(async (req, res) => {
  if (req.user.role !== "admin") throw new HttpError(403, "Action réservée à l’administrateur.");
  const userId = parseId(req.params.id, "Utilisateur");
  const body = req.body || {};
  const hasActive = typeof body.isActive === "boolean";
  const hasPassword = typeof body.password === "string" && body.password.length > 0;
  if (!hasActive && !hasPassword) throw new HttpError(400, "Aucune modification à enregistrer.");
  if (hasPassword && (body.password.length < 12 || body.password.length > 200)) {
    throw new HttpError(400, "Le mot de passe doit contenir entre 12 et 200 caractères.");
  }
  if (hasActive && !body.isActive && userId === String(req.user.id)) {
    throw new HttpError(400, "Vous ne pouvez pas désactiver votre propre compte.");
  }

  await inTransaction(async (client) => {
    const user = await client.query("SELECT id, role, is_active FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!user.rowCount) throw new HttpError(404, "Utilisateur introuvable.");
    if (hasActive && !body.isActive && user.rows[0].role === "admin") {
      const admins = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND is_active = TRUE");
      if (admins.rows[0].count <= 1) throw new HttpError(409, "Il doit rester au moins un administrateur actif.");
    }
    if (hasActive) await client.query("UPDATE users SET is_active = $1 WHERE id = $2", [body.isActive, userId]);
    if (hasPassword) {
      await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword(body.password), userId]);
      await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    } else if (hasActive && !body.isActive) {
      await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    }
  });
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, "public"), { index: "index.html", etag: true, maxAge: isProduction ? "1h" : 0 }));
app.use("/api", (_req, res) => res.status(404).json({ error: "Route API introuvable." }));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error.code === "23505") return res.status(409).json({ error: "Cette adresse e-mail existe déjà." });
  if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Corps JSON invalide." });
  console.error("Erreur serveur :", error);
  res.status(500).json({ error: "Une erreur interne est survenue." });
});

async function start() {
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => console.log(`InovTech Gestion écoute sur le port ${port}.`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Démarrage impossible :", error);
    process.exitCode = 1;
  });
}

module.exports = { app, publicInvoice };
