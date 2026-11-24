const loginView = document.querySelector("#login-view");
const appView = document.querySelector("#app-view");
const loginForm = document.querySelector("#login-form");
const invoiceDialog = document.querySelector("#invoice-dialog");
const detailDialog = document.querySelector("#detail-dialog");
const invoiceForm = document.querySelector("#invoice-form");
const invoiceItems = document.querySelector("#invoice-items");
const toast = document.querySelector("#toast");

let currentUser = null;
let clients = [];
let invoices = [];
let toastTimer;

const statusLabels = {
  draft: "Brouillon",
  issued: "Émise",
  unpaid: "À payer",
  partial: "Partiellement payée",
  paid: "Payée",
  overdue: "En retard",
  cancelled: "Annulée",
};
const paymentLabels = {
  cash: "Espèces",
  mobile_money: "Mobile Money",
  bank_transfer: "Virement bancaire",
  other: "Autre",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function formatMoney(minor, currency) {
  const exponent = currency === "USD" ? 2 : 0;
  return new Intl.NumberFormat("fr-CD", {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(Number(minor) / (exponent === 2 ? 100 : 1));
}

function amountToMinor(value, currency) {
  const normalized = String(value).trim().replace(",", ".");
  const pattern = currency === "USD" ? /^\d{1,12}(?:\.\d{1,2})?$/ : /^\d{1,12}$/;
  if (!pattern.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const minor = Number(whole) * (currency === "USD" ? 100 : 1)
    + Number(fraction.padEnd(currency === "USD" ? 2 : 0, "0") || 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

function quantityToMilli(value) {
  const normalized = String(value).trim().replace(",", ".");
  if (!/^\d{1,8}(?:\.\d{1,3})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const quantity = Number(whole) * 1000 + Number(fraction.padEnd(3, "0") || 0);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let body = {};
  try {
    body = await response.json();
  } catch (error) {
    if (response.ok) throw new Error("Réponse serveur illisible.");
  }
  if (!response.ok) throw new Error(body.error || "La requête a échoué.");
  return body;
}

function notify(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function showLogin() {
  currentUser = null;
  appView.hidden = true;
  loginView.hidden = false;
}

function showApp(user) {
  currentUser = user;
  loginView.hidden = true;
  appView.hidden = false;
  document.querySelector("#current-user").textContent = user.name;
  document.querySelectorAll(".admin-only").forEach((element) => {
    element.hidden = user.role !== "admin";
  });
  navigate("dashboard");
  loadEverything().catch((error) => notify(error.message, true));
}

function navigate(page) {
  if (page === "team" && currentUser?.role !== "admin") page = "dashboard";
  document.querySelectorAll(".page-section").forEach((section) => {
    const active = section.id === `page-${page}`;
    section.hidden = !active;
    section.classList.toggle("is-visible", active);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.page === page);
  });
  const title = { dashboard: "Vue d’ensemble", invoices: "Factures", clients: "Clients", team: "Équipe" };
  document.querySelector("#page-title").textContent = title[page];
  if (page === "team") loadUsers().catch((error) => notify(error.message, true));
}

function statusBadge(status) {
  return `<span class="status status-${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status)}</span>`;
}

function invoiceRows(data) {
  if (!data.length) return '<p class="empty-state">Aucune facture pour le moment.</p>';
  return `<table><thead><tr><th>Numéro</th><th>Client</th><th>Échéance</th><th>Total</th><th>Reste à payer</th><th>État</th></tr></thead><tbody>
    ${data.map((invoice) => `<tr>
      <td><button class="table-link" data-invoice-id="${escapeHtml(invoice.id)}">${escapeHtml(invoice.invoiceNumber || "Brouillon")}</button></td>
      <td>${escapeHtml(invoice.clientName)}</td>
      <td>${escapeHtml(invoice.dueDate)}</td>
      <td>${formatMoney(invoice.totalMinor, invoice.currency)}</td>
      <td>${formatMoney(invoice.balanceMinor, invoice.currency)}</td>
      <td>${statusBadge(invoice.status)}</td>
    </tr>`).join("")}</tbody></table>`;
}

function renderInvoices() {
  document.querySelector("#invoice-list").innerHTML = invoiceRows(invoices);
  document.querySelector("#recent-invoices").innerHTML = invoiceRows(invoices.slice(0, 5));
}

function renderClients() {
  const target = document.querySelector("#client-list");
  if (!clients.length) {
    target.innerHTML = '<p class="empty-state">Aucun client enregistré.</p>';
  } else {
    target.innerHTML = `<table><thead><tr><th>Nom</th><th>Entreprise</th><th>E-mail</th><th>Téléphone</th></tr></thead><tbody>
      ${clients.map((client) => `<tr><td>${escapeHtml(client.name)}</td><td>${escapeHtml(client.organization || "—")}</td><td>${escapeHtml(client.email || "—")}</td><td>${escapeHtml(client.phone || "—")}</td></tr>`).join("")}
    </tbody></table>`;
  }
  const select = invoiceForm.elements.clientId;
  const selected = select.value;
  select.innerHTML = '<option value="">Choisir un client…</option>'
    + clients.map((client) => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}${client.organization ? ` — ${escapeHtml(client.organization)}` : ""}</option>`).join("");
  if (clients.some((client) => client.id === selected)) select.value = selected;
}

async function loadEverything() {
  const [summary, clientData, invoiceData] = await Promise.all([
    api("/api/summary"),
    api("/api/clients"),
    api("/api/invoices"),
  ]);
  clients = clientData;
  invoices = invoiceData;
  document.querySelector("#summary-clients").textContent = summary.clients;
  document.querySelector("#summary-invoices").textContent = summary.invoices;
  document.querySelector("#summary-overdue").textContent = summary.overdue;
  document.querySelector("#summary-usd").textContent = formatMoney(summary.outstanding.USD, "USD");
  document.querySelector("#summary-cdf").textContent = formatMoney(summary.outstanding.CDF, "CDF");
  renderClients();
  renderInvoices();
}

function addInvoiceItem(item = {}) {
  const row = document.createElement("div");
  row.className = "invoice-item";
  row.innerHTML = `
    <label>Description<input name="description" maxlength="240" required value="${escapeHtml(item.description || "")}" placeholder="Ex. Création de site web" /></label>
    <label>Quantité<input name="quantity" inputmode="decimal" required value="${escapeHtml(item.quantity || "1")}" /></label>
    <label>Prix unitaire<input name="unitPrice" inputmode="decimal" required value="${escapeHtml(item.unitPrice || "")}" placeholder="0" /></label>
    <button class="remove-item" type="button" aria-label="Retirer cette ligne">×</button>`;
  invoiceItems.append(row);
  row.querySelector(".remove-item").addEventListener("click", () => {
    if (invoiceItems.children.length > 1) row.remove();
    else row.querySelectorAll("input").forEach((input) => { input.value = ""; });
    updateInvoiceTotal();
  });
  row.querySelectorAll("input").forEach((input) => input.addEventListener("input", updateInvoiceTotal));
}

function updateInvoiceTotal() {
  const currency = invoiceForm.elements.currency.value;
  let total = 0;
  let valid = true;
  invoiceItems.querySelectorAll(".invoice-item").forEach((row) => {
    const quantity = quantityToMilli(row.querySelector('[name="quantity"]').value);
    const price = amountToMinor(row.querySelector('[name="unitPrice"]').value, currency);
    if (quantity === null || price === null) {
      valid = false;
      return;
    }
    total += Math.round((quantity * price) / 1000);
  });
  document.querySelector("#invoice-total").textContent = valid
    ? formatMoney(total, currency)
    : `Vérifiez les lignes (${currency})`;
}

function setInvoiceDialogDefaults() {
  invoiceForm.reset();
  invoiceForm.elements.issueDate.value = todayLocal();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14);
  invoiceForm.elements.dueDate.value = todayLocalFor(dueDate);
  invoiceItems.replaceChildren();
  addInvoiceItem();
  renderClients();
  updateInvoiceTotal();
  invoiceDialog.showModal();
}

function todayLocalFor(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderInvoiceDetail(invoice) {
  const itemRows = invoice.items.map((item) => {
    const quantity = (item.quantityMilli / 1000).toLocaleString("fr-CD", { maximumFractionDigits: 3 });
    return `<tr><td>${escapeHtml(item.description)}</td><td>${quantity}</td><td>${formatMoney(item.unitPriceMinor, invoice.currency)}</td><td>${formatMoney(item.lineTotalMinor, invoice.currency)}</td></tr>`;
  }).join("");
  const paymentRows = invoice.payments.length
    ? invoice.payments.map((payment) => `<li><span>${escapeHtml(payment.date)} · ${escapeHtml(paymentLabels[payment.method])}${payment.reference ? ` · ${escapeHtml(payment.reference)}` : ""}<br><span class="muted">Enregistré par ${escapeHtml(payment.recordedBy)}</span></span><strong>${formatMoney(payment.amountMinor, invoice.currency)}</strong></li>`).join("")
    : '<li class="muted">Aucun paiement enregistré.</li>';
  const canPay = invoice.status !== "draft" && invoice.status !== "cancelled" && invoice.balanceMinor > 0;
  const actions = `<div class="invoice-actions hide-on-print">
    ${invoice.status === "draft" ? '<button class="button button-primary" id="issue-invoice" type="button">Émettre la facture</button>' : ""}
    ${invoice.status !== "cancelled" && invoice.paidMinor === 0 ? '<button class="button button-quiet" id="cancel-invoice" type="button">Annuler la facture</button>' : ""}
    ${invoice.status !== "draft" && invoice.status !== "cancelled" ? '<button class="button button-quiet" id="print-invoice" type="button">Imprimer / PDF</button>' : ""}
    <button class="button button-quiet" type="button" data-close-dialog>Fermer</button>
  </div>`;
  document.querySelector("#invoice-detail").innerHTML = `
    <div class="dialog-heading hide-on-print">
      <div><p class="eyebrow">DÉTAIL DE LA FACTURE</p><h2>${escapeHtml(invoice.invoiceNumber || "Brouillon")}</h2></div>
      <button class="icon-button" type="button" data-close-dialog aria-label="Fermer">×</button>
    </div>
    <div class="invoice-paper">
      <p class="eyebrow">INOVTECH · FACTURATION</p>
      <h2>${escapeHtml(invoice.invoiceNumber || "Facture brouillon")}</h2>
      <p>${statusBadge(invoice.status)}</p>
      <div class="invoice-meta">
        <div>FACTURÉ À<strong>${escapeHtml(invoice.client.name)}${invoice.client.organization ? `<br>${escapeHtml(invoice.client.organization)}` : ""}</strong>${invoice.client.email ? `<br>${escapeHtml(invoice.client.email)}` : ""}${invoice.client.phone ? `<br>${escapeHtml(invoice.client.phone)}` : ""}${invoice.client.address ? `<br>${escapeHtml(invoice.client.address)}` : ""}</div>
        <div>DATE D’ÉMISSION<strong>${escapeHtml(invoice.issueDate)}</strong>ÉCHÉANCE<strong>${escapeHtml(invoice.dueDate)}</strong></div>
      </div>
      <div class="table-wrap"><table class="invoice-lines"><thead><tr><th>Prestation</th><th>Qté</th><th>Prix unitaire</th><th>Total</th></tr></thead><tbody>${itemRows}</tbody></table></div>
      <p class="total-line">Total <strong>${formatMoney(invoice.totalMinor, invoice.currency)}</strong></p>
      <p class="total-line">Déjà payé <strong>${formatMoney(invoice.paidMinor, invoice.currency)}</strong></p>
      <p class="total-line">Reste à payer <strong>${formatMoney(invoice.balanceMinor, invoice.currency)}</strong></p>
      ${invoice.notes ? `<p><strong>Notes :</strong> ${escapeHtml(invoice.notes)}</p>` : ""}
    </div>
    ${actions}
    ${canPay ? `<section class="payment-panel hide-on-print"><h3>Enregistrer un paiement</h3>
      <form id="payment-form" class="payment-form">
        <label>Montant (${escapeHtml(invoice.currency)})<input name="amount" inputmode="decimal" required placeholder="${invoice.currency === "USD" ? "0.00" : "0"}" /></label>
        <label>Date<input name="date" type="date" value="${todayLocal()}" required /></label>
        <label>Mode<select name="method"><option value="mobile_money">Mobile Money</option><option value="cash">Espèces</option><option value="bank_transfer">Virement bancaire</option><option value="other">Autre</option></select></label>
        <label>Référence (facultatif)<input name="reference" maxlength="120" /></label>
        <button class="button button-primary" type="submit">Enregistrer le paiement</button>
      </form>
    </section>` : ""}
    <section class="payment-history-section hide-on-print"><h3>Historique des paiements</h3><ul class="payment-history">${paymentRows}</ul></section>`;

  document.querySelectorAll("#invoice-detail [data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => detailDialog.close());
  });
  document.querySelector("#print-invoice")?.addEventListener("click", () => window.print());
  document.querySelector("#issue-invoice")?.addEventListener("click", async () => {
    try {
      await api(`/api/invoices/${encodeURIComponent(invoice.id)}/issue`, { method: "POST", body: "{}" });
      notify("Facture émise.");
      await openInvoice(invoice.id);
      await loadEverything();
    } catch (error) {
      notify(error.message, true);
    }
  });
  document.querySelector("#cancel-invoice")?.addEventListener("click", async () => {
    if (!window.confirm("Annuler cette facture ? Elle sera conservée dans l’historique.")) return;
    try {
      await api(`/api/invoices/${encodeURIComponent(invoice.id)}/cancel`, { method: "POST", body: "{}" });
      notify("Facture annulée.");
      await openInvoice(invoice.id);
      await loadEverything();
    } catch (error) {
      notify(error.message, true);
    }
  });
  document.querySelector("#payment-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      await api(`/api/invoices/${encodeURIComponent(invoice.id)}/payments`, {
        method: "POST",
        body: JSON.stringify({ ...data, currency: invoice.currency }),
      });
      notify("Paiement enregistré.");
      await openInvoice(invoice.id);
      await loadEverything();
    } catch (error) {
      notify(error.message, true);
    }
  });
}

async function openInvoice(id) {
  const invoice = await api(`/api/invoices/${encodeURIComponent(id)}`);
  renderInvoiceDetail(invoice);
  if (!detailDialog.open) detailDialog.showModal();
}

async function loadUsers() {
  const users = await api("/api/users");
  const target = document.querySelector("#user-list");
  if (!users.length) {
    target.innerHTML = '<p class="empty-state">Aucun compte disponible.</p>';
    return;
  }
  target.innerHTML = `<table><thead><tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>État</th><th>Action</th></tr></thead><tbody>
    ${users.map((user) => `<tr>
      <td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${user.role === "admin" ? "Administrateur" : "Membre"}</td>
      <td>${user.is_active ? "Actif" : "Désactivé"}</td>
      <td>${user.id === currentUser.id ? "—" : `<button class="text-button" data-toggle-user="${escapeHtml(user.id)}" data-active="${user.is_active}">${user.is_active ? "Désactiver" : "Réactiver"}</button> <button class="text-button" data-reset-user="${escapeHtml(user.id)}">Réinitialiser le mot de passe</button>`}</td>
    </tr>`).join("")}
  </tbody></table>`;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorTarget = document.querySelector("#login-error");
  errorTarget.textContent = "";
  const button = loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(loginForm));
    const result = await api("/api/login", { method: "POST", body: JSON.stringify(data) });
    loginForm.reset();
    showApp(result.user);
  } catch (error) {
    errorTarget.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    showLogin();
  } catch (error) {
    notify(error.message, true);
  }
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => navigate(button.dataset.page));
});
document.querySelectorAll("[data-page-link]").forEach((button) => {
  button.addEventListener("click", () => navigate(button.dataset.pageLink));
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
document.querySelector("#new-invoice").addEventListener("click", setInvoiceDialogDefaults);
document.querySelector("#new-invoice-top").addEventListener("click", setInvoiceDialogDefaults);
document.querySelector("#add-item").addEventListener("click", () => addInvoiceItem());
invoiceForm.elements.currency.addEventListener("change", updateInvoiceTotal);
invoiceItems.addEventListener("input", updateInvoiceTotal);

document.querySelector("#invoice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const items = [...invoiceItems.querySelectorAll(".invoice-item")].map((row) => ({
    description: row.querySelector('[name="description"]').value,
    quantity: row.querySelector('[name="quantity"]').value,
    unitPrice: row.querySelector('[name="unitPrice"]').value,
  }));
  const body = Object.fromEntries(new FormData(form));
  body.items = items;
  try {
    const result = await api("/api/invoices", { method: "POST", body: JSON.stringify(body) });
    invoiceDialog.close();
    await loadEverything();
    notify("Brouillon de facture créé.");
    await openInvoice(result.id);
  } catch (error) {
    notify(error.message, true);
  }
});

document.querySelector("#client-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/clients", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    await loadEverything();
    notify("Client enregistré.");
  } catch (error) {
    notify(error.message, true);
  }
});

document.querySelector("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/users", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    await loadUsers();
    notify("Compte d’équipe créé.");
  } catch (error) {
    notify(error.message, true);
  }
});

document.addEventListener("click", async (event) => {
  const invoiceButton = event.target.closest("[data-invoice-id]");
  if (invoiceButton) {
    try {
      await openInvoice(invoiceButton.dataset.invoiceId);
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  const toggleButton = event.target.closest("[data-toggle-user]");
  if (toggleButton) {
    try {
      await api(`/api/users/${encodeURIComponent(toggleButton.dataset.toggleUser)}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: toggleButton.dataset.active !== "true" }),
      });
      await loadUsers();
      notify("Accès d’équipe mis à jour.");
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  const resetButton = event.target.closest("[data-reset-user]");
  if (resetButton) {
    const password = window.prompt("Saisissez un nouveau mot de passe temporaire (12 caractères minimum).");
    if (password === null) return;
    try {
      await api(`/api/users/${encodeURIComponent(resetButton.dataset.resetUser)}`, {
        method: "PATCH",
        body: JSON.stringify({ password }),
      });
      notify("Mot de passe réinitialisé. La personne devra se reconnecter.");
    } catch (error) {
      notify(error.message, true);
    }
  }
});

async function initialize() {
  try {
    const result = await api("/api/me");
    showApp(result.user);
  } catch (error) {
    showLogin();
  }
}

initialize();
