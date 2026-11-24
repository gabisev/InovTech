CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS clients (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  organization TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id BIGSERIAL PRIMARY KEY,
  invoice_number TEXT UNIQUE,
  client_id BIGINT NOT NULL REFERENCES clients(id),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'CDF')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'cancelled')),
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoices_client_idx ON invoices(client_id);
CREATE INDEX IF NOT EXISTS invoices_due_idx ON invoices(due_date) WHERE status = 'issued';

CREATE TABLE IF NOT EXISTS invoice_counters (
  invoice_year INTEGER PRIMARY KEY,
  next_value BIGINT NOT NULL CHECK (next_value > 0)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  quantity_milli BIGINT NOT NULL CHECK (quantity_milli > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor >= 0)
);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES invoices(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  payment_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash', 'mobile_money', 'bank_transfer', 'other')),
  reference TEXT NOT NULL DEFAULT '',
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments(invoice_id);
