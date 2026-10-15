const API = "/api";
let token = localStorage.getItem("sf_token");
let currentUser = JSON.parse(localStorage.getItem("sf_user") || "null");
let currentPage = "dashboard";
let cache = { clientes: [], produtos: [], ciots: [] };

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmt(val, type = "str") {
  if (val === null || val === undefined || val === "") return "—";
  if (type === "money") return esc("R$ " + Number(val).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
  if (type === "date") {
    const d = String(val).slice(0, 10);
    return esc(d.split("-").reverse().join("/"));
  }
  return esc(val);
}

function badgeStatus(s) {
  const map = {
    autorizada: "green", autorizado: "green", emitido: "green",
    rejeitada: "red", cancelada: "red", cancelado: "red",
    encerrada: "blue", rascunho: "amber", processando: "blue",
  };
  const cls = map[s] || "amber";
  return `<span class="badge ${cls}">${esc(s || "pendente")}</span>`;
}

let pollTimer = null;
let detailTimer = null;
function pollLista(page, rows, reload) {
  clearTimeout(pollTimer);
  if (!rows.some((r) => r.status === "processando")) return;
  pollTimer = setTimeout(() => { if (currentPage === page) reload(); }, 5000);
}
function watchDetail(status, reload) {
  clearTimeout(detailTimer);
  if (status !== "processando") return;
  detailTimer = setTimeout(() => {
    if (document.getElementById("detail-panel").classList.contains("open")) reload();
  }, 5000);
}
function motivoHtml(d) {
  const cs = d.cstat ? `[${esc(d.cstat)}] ` : "";
  return `<p style="font-size:12px;color:var(--text-muted);margin-top:4px">${cs}${fmt(d.motivo)}</p>`;
}

function showToast(msg, type = "success") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => { t.className = "toast"; }, 3500);
}

async function apiFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch(API + path, { ...opts, headers });
  if (r.status === 401) { logout(); throw new Error("Sessão expirada"); }
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("xml") || ct.includes("octet-stream") || ct.includes("pdf")) {
    if (!r.ok) throw new Error("Falha no download");
    return r.blob();
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Erro na API");
  return data;
}

function logout() {
  token = null; currentUser = null;
  localStorage.removeItem("sf_token");
  localStorage.removeItem("sf_user");
  showApp(false);
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  const err = document.getElementById("login-error");
  btn.disabled = true;
  err.style.display = "none";
  try {
    const data = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        usuario: document.getElementById("login-user").value,
        senha: document.getElementById("login-pass").value,
      }),
    });
    token = data.token;
    currentUser = data.usuario;
    localStorage.setItem("sf_token", token);
    localStorage.setItem("sf_user", JSON.stringify(currentUser));
    showApp(true);
    navigateTo("dashboard");
  } catch (ex) {
    err.textContent = ex.message;
    err.style.display = "block";
  } finally {
    btn.disabled = false;
  }
});

function showApp(logged) {
  document.getElementById("login-page").style.display = logged ? "none" : "flex";
  document.getElementById("app").style.display = logged ? "flex" : "none";
  if (logged && currentUser) {
    document.getElementById("user-avatar").textContent = currentUser.nome.slice(0, 2).toUpperCase();
    document.getElementById("user-name").textContent = currentUser.nome;
    document.getElementById("user-role").textContent = currentUser.perfil === "admin" ? "Administrador" : "Operador";
  }
}

const titles = {
  dashboard: "Dashboard",
  nfe: "NF-e — Nota Fiscal Eletrônica",
  cte: "CT-e — Conhecimento de Transporte",
  mdfe: "MDF-e — Manifesto",
  ciot: "CIOT — Operação de transporte",
  clientes: "Clientes",
  produtos: "Combustíveis",
  empresa: "Dados da empresa",
};

function navigateTo(page) {
  currentPage = page;
  clearTimeout(pollTimer);
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById("view-" + page)?.classList.add("active");
  document.getElementById("page-title").textContent = titles[page] || page;
  const bar = document.getElementById("topbar-actions");
  const actions = {
    nfe: `<button class="btn btn-primary" id="btn-nova-nfe">Nova NF-e</button>`,
    cte: `<button class="btn btn-primary" id="btn-nova-cte">Novo CT-e</button>`,
    mdfe: `<button class="btn btn-primary" id="btn-novo-mdfe">Novo MDF-e</button>`,
    ciot: `<button class="btn btn-primary" id="btn-novo-ciot">Emitir CIOT</button>`,
    clientes: `<button class="btn btn-primary" id="btn-novo-cli">Novo cliente</button>`,
    produtos: `<button class="btn btn-primary" id="btn-novo-prod">Novo produto</button>`,
  };
  bar.innerHTML = (actions[page] || "") + ` <button class="btn btn-ghost btn-sm" id="btn-refresh">Atualizar</button>`;
  bar.querySelector("#btn-refresh")?.addEventListener("click", () => loadPage(page));
  bar.querySelector("#btn-nova-nfe")?.addEventListener("click", openNfeForm);
  bar.querySelector("#btn-nova-cte")?.addEventListener("click", openCteForm);
  bar.querySelector("#btn-novo-mdfe")?.addEventListener("click", openMdfeForm);
  bar.querySelector("#btn-novo-ciot")?.addEventListener("click", openCiotForm);
  bar.querySelector("#btn-novo-cli")?.addEventListener("click", openCliForm);
  bar.querySelector("#btn-novo-prod")?.addEventListener("click", openProdForm);
  loadPage(page);
}

document.querySelectorAll(".nav-item").forEach((el) => el.addEventListener("click", () => navigateTo(el.dataset.page)));
document.getElementById("logout-btn").addEventListener("click", logout);

function loadPage(page) {
  if (page === "dashboard") return loadDashboard();
  if (page === "nfe") return loadNfe();
  if (page === "cte") return loadCte();
  if (page === "mdfe") return loadMdfe();
  if (page === "ciot") return loadCiot();
  if (page === "clientes") return loadClientes();
  if (page === "produtos") return loadProdutos();
  if (page === "empresa") return loadEmpresa();
}

async function loadDashboard() {
  try {
    const d = await apiFetch("/cadastros/dashboard");
    document.getElementById("dash-nfe-auth").textContent = d.nfe.autorizadas || 0;
    document.getElementById("dash-nfe-canc").textContent = d.nfe.canceladas || 0;
    document.getElementById("dash-nfe-total").textContent = fmt(d.nfe.valor_total, "money");
    document.getElementById("dash-cte-auth").textContent = d.cte.autorizados || 0;
    document.getElementById("dash-cte-total").textContent = fmt(d.cte.valor_total, "money");
    document.getElementById("dash-mdfe-ativos").textContent = d.mdfe.ativos || 0;
    document.getElementById("dash-mdfe-ciot").textContent = d.mdfe.com_ciot || 0;
    if (d.porDia?.length) drawChart(d.porDia);
  } catch (ex) { showToast(ex.message, "error"); }
}

function drawChart(data) {
  const canvas = document.getElementById("nfe-chart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width = canvas.offsetWidth || 600;
  const h = canvas.height = 160;
  ctx.clearRect(0, 0, w, h);
  const values = data.map((d) => parseFloat(d.valor));
  const max = Math.max(...values, 1);
  const barW = Math.max(6, Math.floor((w - 40) / data.length) - 4);
  data.forEach((d, i) => {
    const x = 20 + i * (barW + 4);
    const barH = (parseFloat(d.valor) / max) * (h - 30) || 2;
    const y = h - barH - 20;
    const grad = ctx.createLinearGradient(0, y, 0, h - 20);
    grad.addColorStop(0, "rgba(59,130,246,0.7)");
    grad.addColorStop(1, "rgba(59,130,246,0.1)");
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, barW, barH);
  });
}

function emptyRow(cols, msg) {
  return `<tr><td colspan="${cols}" style="text-align:center;padding:40px;color:var(--text-muted)">${esc(msg)}</td></tr>`;
}

let nfeFilters = {};
async function loadNfe(page = 1, silent = false) {
  const tbody = document.getElementById("nfe-tbody");
  if (!silent) tbody.innerHTML = emptyRow(6, "Carregando...");
  try {
    const params = new URLSearchParams({ page, limit: 50, ...nfeFilters });
    const data = await apiFetch("/nfe?" + params);
    tbody.innerHTML = data.data.map((n) => `
      <tr data-open="nfe" data-id="${esc(n.id)}">
        <td><strong>${fmt(n.numero)}</strong></td><td>${fmt(n.serie)}</td>
        <td>${fmt(n.emitido_em || n.created_at, "date")}</td>
        <td>${fmt(n.dest_nome)}</td><td>${fmt(n.total_nota, "money")}</td>
        <td>${badgeStatus(n.status)}</td>
      </tr>`).join("") || emptyRow(6, "Nenhuma NF-e");
    paginate("nfe-pagination", data, loadNfe);
    pollLista("nfe", data.data, () => loadNfe(page, true));
    tbody.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openNfeDetail(tr.dataset.id)));
  } catch (ex) { tbody.innerHTML = emptyRow(6, ex.message); }
}
document.getElementById("nfe-search-btn").addEventListener("click", () => {
  nfeFilters = pickFilled({
    data_ini: "nfe-data-ini", data_fim: "nfe-data-fim", documento: "nfe-doc",
    status: "nfe-status", cliente: "nfe-cliente",
  });
  loadNfe(1);
});

let cteFilters = {};
async function loadCte(page = 1, silent = false) {
  const tbody = document.getElementById("cte-tbody");
  if (!silent) tbody.innerHTML = emptyRow(7, "Carregando...");
  try {
    const params = new URLSearchParams({ page, limit: 50, ...cteFilters });
    const data = await apiFetch("/cte?" + params);
    tbody.innerHTML = data.data.map((c) => `
      <tr data-id="${esc(c.id)}">
        <td><strong>${fmt(c.numero)}</strong></td><td>${fmt(c.serie)}</td>
        <td>${fmt(c.emitido_em || c.created_at, "date")}</td>
        <td>${fmt(c.rem_nome)}</td><td>${fmt(c.dest_nome)}</td>
        <td>${fmt(c.valor_servico, "money")}</td><td>${badgeStatus(c.status)}</td>
      </tr>`).join("") || emptyRow(7, "Nenhum CT-e");
    paginate("cte-pagination", data, loadCte);
    pollLista("cte", data.data, () => loadCte(page, true));
    tbody.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openCteDetail(tr.dataset.id)));
  } catch (ex) { tbody.innerHTML = emptyRow(7, ex.message); }
}
document.getElementById("cte-search-btn").addEventListener("click", () => {
  cteFilters = pickFilled({ data_ini: "cte-data-ini", data_fim: "cte-data-fim", documento: "cte-doc", status: "cte-status" });
  loadCte(1);
});

async function loadMdfe(page = 1, silent = false) {
  const tbody = document.getElementById("mdfe-tbody");
  const filters = pickFilled({ data_ini: "mdfe-data-ini", data_fim: "mdfe-data-fim", status: "mdfe-status" });
  if (!silent) tbody.innerHTML = emptyRow(6, "Carregando...");
  try {
    const data = await apiFetch("/mdfe?" + new URLSearchParams({ page, limit: 50, ...filters }));
    tbody.innerHTML = data.data.map((m) => `
      <tr data-id="${esc(m.id)}">
        <td><strong>${fmt(m.numero)}</strong></td><td>${fmt(m.serie)}</td>
        <td>${fmt(m.placa)}</td><td>${fmt(m.valor_carga, "money")}</td>
        <td>${m.ciot_numero ? `<span class="badge purple">${esc(m.ciot_numero)}</span>` : '<span class="badge amber">Sem CIOT</span>'}</td>
        <td>${badgeStatus(m.status)}</td>
      </tr>`).join("") || emptyRow(6, "Nenhum MDF-e");
    paginate("mdfe-pagination", data, loadMdfe);
    pollLista("mdfe", data.data, () => loadMdfe(page, true));
    tbody.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openMdfeDetail(tr.dataset.id)));
  } catch (ex) { tbody.innerHTML = emptyRow(6, ex.message); }
}
document.getElementById("mdfe-search-btn").addEventListener("click", () => loadMdfe(1));

async function loadCiot() {
  const tbody = document.getElementById("ciot-tbody");
  try {
    const data = await apiFetch("/ciot");
    cache.ciots = data.data;
    tbody.innerHTML = data.data.map((c) => `
      <tr>
        <td><strong>${esc(c.numero)}</strong></td><td>${fmt(c.placa)}</td>
        <td>${fmt(c.contratante_nome)}</td><td>${fmt(c.motorista_nome)}</td>
        <td>${fmt(c.valor_contrato, "money")}</td>
        <td>${fmt(c.forma_pagto)}</td><td>${badgeStatus(c.status)}</td>
      </tr>`).join("") || emptyRow(7, "Nenhum CIOT");
  } catch (ex) { tbody.innerHTML = emptyRow(7, ex.message); }
}

async function loadClientes() {
  const q = document.getElementById("cli-q").value;
  const data = await apiFetch("/cadastros/clientes?q=" + encodeURIComponent(q || ""));
  cache.clientes = data.data;
  document.getElementById("cli-tbody").innerHTML = data.data.map((c) =>
    `<tr><td>${esc(c.nome)}</td><td>${esc(c.tipo)}</td><td>${esc(c.cpf_cnpj)}</td><td>${fmt(c.municipio)}</td><td>${fmt(c.uf)}</td></tr>`
  ).join("") || emptyRow(5, "Nenhum cliente");
}
document.getElementById("cli-search-btn").addEventListener("click", loadClientes);

async function loadProdutos() {
  const data = await apiFetch("/cadastros/produtos");
  cache.produtos = data.data;
  document.getElementById("prod-tbody").innerHTML = data.data.map((p) =>
    `<tr><td>${esc(p.codigo)}</td><td>${esc(p.descricao)}</td><td>${fmt(p.anp)}</td><td>${fmt(p.ncm)}</td><td>${fmt(p.cfop)}</td><td>${esc(p.unidade)}</td><td>${fmt(p.preco, "money")}</td></tr>`
  ).join("") || emptyRow(7, "Nenhum produto");
}

async function loadEmpresa() {
  const e = await apiFetch("/cadastros/empresa");
  const form = document.getElementById("empresa-form");
  [...form.elements].forEach((el) => {
    if (el.name && e[el.name] != null) el.value = e[el.name];
  });
}
document.getElementById("empresa-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  try {
    await apiFetch("/cadastros/empresa", { method: "PUT", body: JSON.stringify(body) });
    showToast("Empresa salva");
  } catch (ex) { showToast(ex.message, "error"); }
});

function pickFilled(map) {
  const o = {};
  Object.entries(map).forEach(([k, id]) => {
    const v = document.getElementById(id).value;
    if (v) o[k] = v;
  });
  return o;
}

function paginate(id, data, fn) {
  const el = document.getElementById(id);
  const { page, pages, total } = data;
  el.innerHTML = `<span>${esc(total)} registros — página ${esc(page)} de ${esc(pages)}</span>`;
  const prev = document.createElement("button");
  prev.className = "page-btn"; prev.textContent = "‹ Anterior"; prev.disabled = page <= 1;
  prev.onclick = () => fn(page - 1);
  const next = document.createElement("button");
  next.className = "page-btn"; next.textContent = "Próxima ›"; next.disabled = page >= pages;
  next.onclick = () => fn(page + 1);
  el.append(prev, next);
}

function openPanel(title, html) {
  document.getElementById("detail-title").textContent = title;
  document.getElementById("detail-body").innerHTML = html;
  document.getElementById("detail-panel").classList.add("open");
  document.getElementById("panel-overlay").classList.add("open");
}
function closePanel() {
  clearTimeout(detailTimer);
  document.getElementById("detail-panel").classList.remove("open");
  document.getElementById("panel-overlay").classList.remove("open");
}
document.getElementById("close-panel").addEventListener("click", closePanel);
document.getElementById("panel-overlay").addEventListener("click", closePanel);

function openModal(title, html) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = html;
  document.getElementById("modal").classList.add("open");
  document.getElementById("modal-overlay").classList.add("open");
}
function closeModal() {
  document.getElementById("modal").classList.remove("open");
  document.getElementById("modal-overlay").classList.remove("open");
}
document.getElementById("close-modal").addEventListener("click", closeModal);
document.getElementById("modal-overlay").addEventListener("click", closeModal);

function actionsDoc(tipo, id, status, doc = {}) {
  let html = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">`;
  if (status === "processando") html += `<button class="btn btn-primary" data-sync="${esc(tipo)}:${esc(id)}">Consultar SEFAZ</button>`;
  html += `<button class="btn btn-ghost" data-xml="${esc(tipo)}:${esc(id)}">Baixar XML</button>`;
  if (doc.caminho_pdf) {
    const nome = { nfe: "DANFE", cte: "DACTE", mdfe: "DAMDFE" }[tipo];
    html += `<button class="btn btn-ghost" data-pdf="${esc(tipo)}:${esc(id)}">${nome} (PDF)</button>`;
  }
  if (tipo === "mdfe" && status === "autorizada") {
    html += `<button class="btn btn-primary" data-encerrar="${esc(id)}" data-uf="${esc(doc.uf_fim || "")}" data-mun="${esc(doc.descarregamento_municipio || "")}">Encerrar</button>`;
  }
  if (status === "autorizada") {
    html += `<button class="btn btn-ghost" data-cancel="${esc(tipo)}:${esc(id)}">Cancelar</button>`;
  }
  html += "</div>";
  return html;
}

async function openNfeDetail(id) {
  const d = await apiFetch("/nfe/" + id);
  const n = d.nota;
  openPanel(`NF-e ${n.numero}/${n.serie}`, `
    <div class="detail-section"><h3>Status</h3>${badgeStatus(n.status)}<p style="font-size:12px;margin-top:8px;word-break:break-all">${fmt(n.chave)}</p>${motivoHtml(n)}</div>
    <div class="detail-section"><h3>Destinatário</h3>
      <div class="detail-grid">
        <div class="detail-field"><label>Nome</label><span>${fmt(n.dest_nome)}</span></div>
        <div class="detail-field"><label>Documento</label><span>${fmt(n.dest_doc)}</span></div>
        <div class="detail-field"><label>UF</label><span>${fmt(n.dest_uf)}</span></div>
        <div class="detail-field"><label>Total</label><span>${fmt(n.total_nota, "money")}</span></div>
      </div>
    </div>
    <div class="detail-section"><h3>Itens</h3>
      <table style="font-size:12px"><thead><tr><th>Produto</th><th>Qtd</th><th>Unit.</th><th>Total</th></tr></thead>
      <tbody>${d.itens.map((i) => `<tr><td>${esc(i.descricao)}</td><td>${esc(i.quantidade)}</td><td>${fmt(i.valor_unitario, "money")}</td><td>${fmt(i.valor_total, "money")}</td></tr>`).join("")}</tbody>
      </table>
    </div>
    ${actionsDoc("nfe", n.id, n.status, n)}`);
  bindDocActions();
  watchDetail(n.status, () => openNfeDetail(id));
}

async function openCteDetail(id) {
  const d = await apiFetch("/cte/" + id);
  const c = d.cte;
  openPanel(`CT-e ${c.numero}/${c.serie}`, `
    <div class="detail-section">${badgeStatus(c.status)}<p style="font-size:12px;margin-top:8px;word-break:break-all">${fmt(c.chave)}</p>${motivoHtml(c)}</div>
    <div class="detail-grid">
      <div class="detail-field"><label>Remetente</label><span>${fmt(c.rem_nome)}</span></div>
      <div class="detail-field"><label>Destinatário</label><span>${fmt(c.dest_nome)}</span></div>
      <div class="detail-field"><label>Carga</label><span>${fmt(c.carga)}</span></div>
      <div class="detail-field"><label>Serviço</label><span>${fmt(c.valor_servico, "money")}</span></div>
    </div>
    ${actionsDoc("cte", c.id, c.status, c)}`);
  bindDocActions();
  watchDetail(c.status, () => openCteDetail(id));
}

async function openMdfeDetail(id) {
  const d = await apiFetch("/mdfe/" + id);
  const m = d.mdfe;
  openPanel(`MDF-e ${m.numero}/${m.serie}`, `
    ${d.ciot ? `<div class="ciot-card"><div class="ciot-header"><span class="ciot-badge">CIOT</span><strong>${esc(d.ciot.numero)}</strong></div>
      <div class="detail-grid">
        <div class="detail-field"><label>Contratante</label><span>${esc(d.ciot.contratante_nome)}</span></div>
        <div class="detail-field"><label>Valor</label><span>${fmt(d.ciot.valor_contrato, "money")}</span></div>
      </div></div>` : ""}
    <div class="detail-section">${badgeStatus(m.status)}<p style="font-size:12px;margin-top:8px;word-break:break-all">${fmt(m.chave)}</p>${motivoHtml(m)}</div>
    <div class="detail-grid">
      <div class="detail-field"><label>Placa</label><span>${fmt(m.placa)}</span></div>
      <div class="detail-field"><label>Percurso</label><span>${fmt(m.uf_ini)} → ${fmt(m.uf_fim)}</span></div>
    </div>
    <p style="margin-top:12px;font-size:13px">${d.condutores.map((c) => esc(c.nome) + " (" + esc(c.cpf) + ")").join("<br>")}</p>
    ${actionsDoc("mdfe", m.id, m.status, m)}`);
  bindDocActions();
  watchDetail(m.status, () => openMdfeDetail(id));
}

function bindDocActions() {
  document.querySelector("[data-xml]")?.addEventListener("click", async (e) => {
    const [tipo, id] = e.currentTarget.dataset.xml.split(":");
    try {
      const blob = await apiFetch(`/${tipo}/${id}/xml`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${tipo}-${id}.xml`; a.click();
      URL.revokeObjectURL(url);
    } catch (ex) { showToast(ex.message, "error"); }
  });
  document.querySelector("[data-pdf]")?.addEventListener("click", async (e) => {
    const [tipo, id] = e.currentTarget.dataset.pdf.split(":");
    try {
      const blob = await apiFetch(`/${tipo}/${id}/pdf`);
      const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (ex) { showToast(ex.message, "error"); }
  });
  document.querySelector("[data-sync]")?.addEventListener("click", async (e) => {
    const [tipo, id] = e.currentTarget.dataset.sync.split(":");
    try {
      const r = await apiFetch(`/${tipo}/${id}/sincronizar`, { method: "POST" });
      showToast(`Status: ${r.status}`);
      loadPage(currentPage);
      ({ nfe: openNfeDetail, cte: openCteDetail, mdfe: openMdfeDetail })[tipo](id);
    } catch (ex) { showToast(ex.message, "error"); }
  });
  document.querySelector("[data-cancel]")?.addEventListener("click", (e) => {
    const [tipo, id] = e.currentTarget.dataset.cancel.split(":");
    openModal("Cancelar documento", `
      <form id="form-cancel" class="form-grid">
        <div class="form-group span-2"><label>Justificativa (15 a 255 caracteres)</label>
          <textarea id="cancel-just" rows="4" maxlength="255" required style="width:100%;background:var(--bg-base);color:inherit;border:1px solid var(--border-light);border-radius:8px;padding:8px"></textarea>
          <small id="cancel-err" style="color:#ef4444;display:none"></small>
        </div>
        <button class="btn btn-primary span-2" type="submit">Confirmar cancelamento</button>
      </form>`);
    document.getElementById("form-cancel").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const justificativa = val("cancel-just").trim();
      const err = document.getElementById("cancel-err");
      if (justificativa.length < 15 || justificativa.length > 255) {
        err.textContent = `Justificativa deve ter de 15 a 255 caracteres (atual: ${justificativa.length})`;
        err.style.display = "block";
        return;
      }
      try {
        await apiFetch(`/${tipo}/${id}/cancelar`, { method: "POST", body: JSON.stringify({ justificativa }) });
        showToast("Documento cancelado");
        closeModal();
        closePanel();
        loadPage(currentPage);
      } catch (ex) { showToast(ex.message, "error"); }
    });
  });
  document.querySelector("[data-encerrar]")?.addEventListener("click", (e) => {
    const { encerrar: id, uf, mun } = e.currentTarget.dataset;
    openModal("Encerrar MDF-e", `
      <form id="form-encerrar" class="form-grid">
        <div class="form-group"><label>UF</label><input id="enc-uf" maxlength="2" value="${esc(uf)}"></div>
        <div class="form-group"><label>Município</label><input id="enc-mun" value="${esc(mun)}"></div>
        <div class="form-group span-2"><label>Data (opcional)</label><input id="enc-data" type="date"></div>
        <button class="btn btn-primary span-2" type="submit">Encerrar</button>
      </form>`);
    document.getElementById("form-encerrar").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = {};
      if (val("enc-uf")) body.uf = val("enc-uf");
      if (val("enc-mun")) body.municipio = val("enc-mun");
      if (val("enc-data")) body.data = val("enc-data");
      try {
        await apiFetch(`/mdfe/${id}/encerrar`, { method: "POST", body: JSON.stringify(body) });
        showToast("MDF-e encerrado");
        closeModal();
        closePanel();
        loadMdfe();
      } catch (ex) { showToast(ex.message, "error"); }
    });
  });
}

async function ensureCadastros() {
  if (!cache.produtos.length) cache.produtos = (await apiFetch("/cadastros/produtos")).data;
  if (!cache.clientes.length) cache.clientes = (await apiFetch("/cadastros/clientes")).data;
  if (!cache.ciots.length) cache.ciots = (await apiFetch("/ciot")).data;
}

function optClientes() {
  return cache.clientes.map((c) => `<option value="${esc(c.id)}" data-doc="${esc(c.cpf_cnpj)}" data-uf="${esc(c.uf || "")}" data-mun="${esc(c.municipio || "")}">${esc(c.nome)}</option>`).join("");
}

function toastEmissao(nome, r) {
  if (r.status === "processando") showToast(`${nome} enviado, aguardando SEFAZ`);
  else if (r.status === "rejeitada") showToast(`${nome} rejeitado: ${r.motivo || ""}`, "error");
  else showToast(`${nome} ${r.numero} ${r.status}`);
}

async function openNfeForm() {
  await ensureCadastros();
  openModal("Emitir NF-e de combustível", `
    <form id="form-nfe" class="form-grid">
      <div class="form-group span-2"><label>Destinatário</label>
        <select id="nfe-cli"><option value="">Informar manualmente</option>${optClientes()}</select>
      </div>
      <div class="form-group"><label>Nome</label><input id="nfe-dest-nome" required></div>
      <div class="form-group"><label>CPF/CNPJ</label><input id="nfe-dest-doc" required></div>
      <div class="form-group"><label>UF</label><input id="nfe-dest-uf" maxlength="2" required></div>
      <div class="form-group"><label>Município</label><input id="nfe-dest-mun"></div>
      <div class="form-group"><label>Natureza</label><input id="nfe-nat" value="VENDA DE COMBUSTIVEL"></div>
      <div class="form-group"><label>Forma de pagamento</label>
        <select id="nfe-fp">${["DINHEIRO", "PIX", "CARTAO", "DEBITO", "BOLETO", "PRAZO", "OUTROS"].map((f) => `<option>${f}</option>`).join("")}</select>
      </div>
      <div class="span-2" id="nfe-itens"></div>
      <button type="button" class="btn btn-ghost" id="add-item">+ Item</button>
      <button class="btn btn-primary" type="submit">Emitir e autorizar</button>
    </form>`);
  const addItem = (prod) => {
    const wrap = document.getElementById("nfe-itens");
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <div class="form-group"><label>Produto</label>
        <select class="it-prod">${cache.produtos.map((p) => `<option value="${esc(p.id)}">${esc(p.descricao)}</option>`).join("")}</select>
      </div>
      <div class="form-group"><label>Litros</label><input class="it-qtd" type="number" step="0.001" min="0.001" value="1" required></div>
      <div class="form-group"><label>R$/L</label><input class="it-vu" type="number" step="0.001" min="0" required></div>
      <div class="form-group"><label>CST ICMS</label>
        <select class="it-cst"><option value="60">60 ST</option><option value="61">61 Monofásico</option><option value="00">00</option></select>
      </div>
      <button type="button" class="btn btn-ghost btn-sm it-del">✕</button>`;
    wrap.appendChild(row);
    const fill = (id) => {
      const p = cache.produtos.find((x) => x.id === id);
      if (p) {
        row.querySelector(".it-vu").value = p.preco;
        row.querySelector(".it-cst").value = p.cst_icms || "60";
      }
    };
    row.querySelector(".it-prod").addEventListener("change", (e) => fill(e.target.value));
    if (prod || cache.produtos[0]) fill((prod && prod.id) || cache.produtos[0].id);
    row.querySelector(".it-del").addEventListener("click", () => row.remove());
  };
  document.getElementById("add-item").addEventListener("click", () => addItem());
  addItem(cache.produtos[0]);
  document.getElementById("nfe-cli").addEventListener("change", (e) => {
    const opt = e.target.selectedOptions[0];
    if (!opt.value) return;
    document.getElementById("nfe-dest-nome").value = opt.textContent;
    document.getElementById("nfe-dest-doc").value = opt.dataset.doc;
    document.getElementById("nfe-dest-uf").value = opt.dataset.uf;
    document.getElementById("nfe-dest-mun").value = opt.dataset.mun;
  });
  document.getElementById("form-nfe").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const itens = [...document.querySelectorAll("#nfe-itens .item-row")].map((row) => {
      const p = cache.produtos.find((x) => x.id === row.querySelector(".it-prod").value);
      return {
        codigo: p.codigo, descricao: p.descricao, ncm: p.ncm, cfop: p.cfop, unidade: p.unidade,
        quantidade: row.querySelector(".it-qtd").value, valor_unitario: row.querySelector(".it-vu").value,
        anp: p.anp, desc_anp: p.desc_anp, icms_cst: row.querySelector(".it-cst").value, icms_aliq: p.aliq_icms,
      };
    });
    try {
      const r = await apiFetch("/nfe", {
        method: "POST",
        body: JSON.stringify({
          cliente_id: document.getElementById("nfe-cli").value || null,
          dest_nome: document.getElementById("nfe-dest-nome").value,
          dest_doc: document.getElementById("nfe-dest-doc").value,
          dest_uf: document.getElementById("nfe-dest-uf").value,
          dest_municipio: document.getElementById("nfe-dest-mun").value,
          natureza: document.getElementById("nfe-nat").value,
          forma_pagamento: val("nfe-fp"),
          itens,
        }),
      });
      toastEmissao("NF-e", r);
      closeModal();
      loadNfe();
    } catch (ex) { showToast(ex.message, "error"); }
  });
}

async function openCteForm() {
  await ensureCadastros();
  openModal("Emitir CT-e", `
    <form id="form-cte" class="form-grid">
      <div class="form-group span-2"><label>Remetente (cadastro)</label>
        <select id="cte-rem-cli"><option value="">Informar manualmente</option>${optClientes()}</select></div>
      <div class="form-group"><label>Remetente</label><input id="cte-rem-nome"></div>
      <div class="form-group"><label>CNPJ remetente</label><input id="cte-rem-doc"></div>
      <div class="form-group"><label>UF remetente</label><input id="cte-rem-uf" maxlength="2"></div>
      <div class="form-group"><label>Mun. remetente</label><input id="cte-rem-mun"></div>
      <div class="form-group span-2"><label>Destinatário (cadastro)</label>
        <select id="cte-dest-cli"><option value="">Informar manualmente</option>${optClientes()}</select></div>
      <div class="form-group"><label>Destinatário</label><input id="cte-dest-nome"></div>
      <div class="form-group"><label>CNPJ destinatário</label><input id="cte-dest-doc"></div>
      <div class="form-group"><label>UF dest.</label><input id="cte-dest-uf" maxlength="2"></div>
      <div class="form-group"><label>Mun. dest.</label><input id="cte-dest-mun"></div>
      <div class="form-group"><label>Tomador</label>
        <select id="cte-tomador"><option value="0">0 - Remetente</option><option value="3">3 - Destinatário</option></select></div>
      <div class="form-group"><label>RNTRC</label><input id="cte-rntrc"></div>
      <div class="form-group"><label>Carga</label><input id="cte-carga" value="COMBUSTIVEL"></div>
      <div class="form-group"><label>Valor da carga</label><input id="cte-valor-carga" type="number" step="0.01" value="0"></div>
      <div class="form-group"><label>Peso (kg)</label><input id="cte-peso" type="number" step="0.001" value="0"></div>
      <div class="form-group"><label>Valor serviço</label><input id="cte-valor" type="number" step="0.01" required></div>
      <div class="form-group"><label>Alíquota ICMS %</label><input id="cte-aliq" type="number" step="0.01" value="12"></div>
      <div class="form-group"><label>CFOP</label><input id="cte-cfop" value="5353"></div>
      <div class="form-group span-2"><label>Chaves NF-e transportadas (44 dígitos, uma por linha)</label>
        <textarea id="cte-chaves" rows="3" style="width:100%;background:var(--bg-base);color:inherit;border:1px solid var(--border-light);border-radius:8px;padding:8px"></textarea>
      </div>
      <button class="btn btn-primary span-2" type="submit">Emitir e autorizar</button>
    </form>`);
  document.getElementById("form-cte").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const remCli = val("cte-rem-cli"), destCli = val("cte-dest-cli");
    if (!remCli && !(val("cte-rem-nome") && val("cte-rem-doc"))) return showToast("Informe o remetente", "error");
    if (!destCli && !(val("cte-dest-nome") && val("cte-dest-doc"))) return showToast("Informe o destinatário", "error");
    const chaves = val("cte-chaves").split(/\s+/).filter(Boolean);
    if (chaves.some((c) => !/^\d{44}$/.test(c))) return showToast("Cada chave de NF-e deve ter 44 dígitos", "error");
    try {
      const r = await apiFetch("/cte", {
        method: "POST",
        body: JSON.stringify({
          rem_cliente_id: remCli || undefined, dest_cliente_id: destCli || undefined,
          tomador: Number(val("cte-tomador")), rntrc: val("cte-rntrc"), chaves_nfe: chaves,
          valor_carga: val("cte-valor-carga"), peso_kg: val("cte-peso"),
          rem_nome: val("cte-rem-nome"), rem_doc: val("cte-rem-doc"), rem_uf: val("cte-rem-uf"), rem_municipio: val("cte-rem-mun"),
          dest_nome: val("cte-dest-nome"), dest_doc: val("cte-dest-doc"), dest_uf: val("cte-dest-uf"), dest_municipio: val("cte-dest-mun"),
          carga: val("cte-carga"), valor_servico: val("cte-valor"), icms_aliq: val("cte-aliq"), cfop: val("cte-cfop"),
        }),
      });
      toastEmissao("CT-e", r);
      closeModal();
      loadCte();
    } catch (ex) { showToast(ex.message, "error"); }
  });
}

async function openMdfeForm() {
  await ensureCadastros();
  const ciotOpts = cache.ciots.filter((c) => c.status === "emitido" && !c.mdfe_id)
    .map((c) => `<option value="${esc(c.id)}">${esc(c.numero)} — ${esc(c.placa)}</option>`).join("");
  openModal("Emitir MDF-e", `
    <form id="form-mdfe" class="form-grid">
      <div class="form-group"><label>UF início</label><input id="mdfe-ufini" maxlength="2" required></div>
      <div class="form-group"><label>UF fim</label><input id="mdfe-uffim" maxlength="2" required></div>
      <div class="form-group"><label>Placa</label><input id="mdfe-placa" required></div>
      <div class="form-group"><label>RNTRC</label><input id="mdfe-rntrc"></div>
      <div class="form-group"><label>Tipo emitente</label>
        <select id="mdfe-tipo-emit"><option value="1">1 - Prestador de serviço</option><option value="2">2 - Carga própria</option></select></div>
      <div class="form-group"><label>Tara (kg)</label><input id="mdfe-tara" type="number" step="1" min="0"></div>
      <div class="form-group"><label>Peso bruto (kg)</label><input id="mdfe-peso" type="number" step="0.001" min="0"></div>
      <div class="form-group"><label>Valor da carga</label><input id="mdfe-valor" type="number" step="0.01" value="0"></div>
      <div class="form-group"><label>Município descarregamento</label><input id="mdfe-desc-mun"></div>
      <div class="form-group"><label>IBGE descarregamento (7 dígitos)</label><input id="mdfe-desc-cmun" maxlength="7"></div>
      <div class="form-group"><label>Percurso (UFs, vírgula)</label><input id="mdfe-perc" placeholder="MG,RJ"></div>
      <div class="form-group"><label>Condutor</label><input id="mdfe-cond-nome" required></div>
      <div class="form-group"><label>CPF condutor</label><input id="mdfe-cond-cpf" required></div>
      <div class="form-group span-2"><label>CIOT (opcional)</label>
        <select id="mdfe-ciot"><option value="">Sem CIOT</option>${ciotOpts}</select>
      </div>
      <div class="form-group span-2"><label>Chave NF-e/CT-e vinculados (44 dígitos, um por linha; prefixo "cte:" para CT-e)</label>
        <textarea id="mdfe-docs" rows="3" style="width:100%;background:var(--bg-base);color:inherit;border:1px solid var(--border-light);border-radius:8px;padding:8px"></textarea>
      </div>
      <button class="btn btn-primary span-2" type="submit">Emitir e autorizar</button>
    </form>`);
  document.getElementById("form-mdfe").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const docs = val("mdfe-docs").split(/\s+/).filter(Boolean).map((l) => ({
      tipo: /^cte:/i.test(l) ? "cte" : "nfe", chave: l.replace(/^(cte|nfe):/i, ""),
    }));
    if (docs.some((d) => !/^\d{44}$/.test(d.chave))) return showToast("Cada chave deve ter 44 dígitos", "error");
    try {
      const r = await apiFetch("/mdfe", {
        method: "POST",
        body: JSON.stringify({
          uf_ini: val("mdfe-ufini"), uf_fim: val("mdfe-uffim"), placa: val("mdfe-placa"),
          rntrc: val("mdfe-rntrc"), valor_carga: val("mdfe-valor"),
          tara_kg: val("mdfe-tara"), peso_kg: val("mdfe-peso"), tipo_emitente: val("mdfe-tipo-emit"),
          descarregamento_municipio: val("mdfe-desc-mun"), descarregamento_cmun: val("mdfe-desc-cmun"),
          percurso: val("mdfe-perc").split(",").map((s) => s.trim()).filter(Boolean),
          condutores: [{ nome: val("mdfe-cond-nome"), cpf: val("mdfe-cond-cpf") }],
          ciot_id: val("mdfe-ciot") || null,
          documentos: docs,
        }),
      });
      toastEmissao("MDF-e", r);
      closeModal();
      loadMdfe();
    } catch (ex) { showToast(ex.message, "error"); }
  });
}

function openCiotForm() {
  openModal("Emitir CIOT", `
    <form id="form-ciot" class="form-grid">
      <div class="form-group"><label>Contratante</label><input id="ciot-nome" required></div>
      <div class="form-group"><label>CNPJ contratante</label><input id="ciot-doc" required></div>
      <div class="form-group"><label>Motorista</label><input id="ciot-mot" required></div>
      <div class="form-group"><label>CPF motorista</label><input id="ciot-cpf" required></div>
      <div class="form-group"><label>Placa</label><input id="ciot-placa" required></div>
      <div class="form-group"><label>Administradora</label><input id="ciot-adm" value="INTERNA"></div>
      <div class="form-group"><label>Valor contrato</label><input id="ciot-valor" type="number" step="0.01" required></div>
      <div class="form-group"><label>Adiantamento</label><input id="ciot-ad" type="number" step="0.01" value="0"></div>
      <div class="form-group"><label>Forma pagto</label>
        <select id="ciot-fp"><option>PIX</option><option>TED</option><option>CARTAO</option><option>DINHEIRO</option></select>
      </div>
      <div class="form-group"><label>Chave PIX</label><input id="ciot-pix"></div>
      <button class="btn btn-primary span-2" type="submit">Emitir CIOT</button>
    </form>`);
  document.getElementById("form-ciot").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await apiFetch("/ciot", {
        method: "POST",
        body: JSON.stringify({
          contratante_nome: val("ciot-nome"), contratante_doc: val("ciot-doc"),
          motorista_nome: val("ciot-mot"), motorista_cpf: val("ciot-cpf"),
          placa: val("ciot-placa"), administradora: val("ciot-adm"),
          valor_contrato: val("ciot-valor"), valor_adiantamento: val("ciot-ad"),
          forma_pagto: val("ciot-fp"), chave_pix: val("ciot-pix"),
        }),
      });
      showToast("CIOT " + r.numero);
      closeModal();
      loadCiot();
    } catch (ex) { showToast(ex.message, "error"); }
  });
}

function openCliForm() {
  openModal("Novo cliente", `
    <form id="form-cli" class="form-grid">
      <div class="form-group"><label>Nome</label><input name="nome" required></div>
      <div class="form-group"><label>Tipo</label><select name="tipo"><option value="J">Jurídica</option><option value="F">Física</option></select></div>
      <div class="form-group"><label>CPF/CNPJ</label><input name="cpf_cnpj" required></div>
      <div class="form-group"><label>UF</label><input name="uf" maxlength="2"></div>
      <div class="form-group"><label>Município</label><input name="municipio"></div>
      <div class="form-group"><label>IE</label><input name="ie"></div>
      <div class="form-group"><label>cMun (IBGE)</label><input name="cmun" maxlength="7"></div>
      <div class="form-group"><label>CEP</label><input name="cep"></div>
      <div class="form-group"><label>Logradouro</label><input name="logradouro"></div>
      <div class="form-group"><label>Número</label><input name="numero"></div>
      <div class="form-group"><label>Bairro</label><input name="bairro"></div>
      <div class="form-group"><label>E-mail</label><input name="email"></div>
      <button class="btn btn-primary span-2" type="submit">Salvar</button>
    </form>`);
  document.getElementById("form-cli").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await apiFetch("/cadastros/clientes", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(ev.target))) });
      showToast("Cliente salvo"); closeModal(); cache.clientes = []; loadClientes();
    } catch (ex) { showToast(ex.message, "error"); }
  });
}

function openProdForm() {
  openModal("Novo combustível", `
    <form id="form-prod" class="form-grid">
      <div class="form-group"><label>Código</label><input name="codigo" required></div>
      <div class="form-group"><label>Descrição</label><input name="descricao" required></div>
      <div class="form-group"><label>Código ANP</label><input name="anp"></div>
      <div class="form-group"><label>Desc. ANP</label><input name="desc_anp"></div>
      <div class="form-group"><label>NCM</label><input name="ncm"></div>
      <div class="form-group"><label>CFOP</label><input name="cfop" value="5656"></div>
      <div class="form-group"><label>Unidade</label><input name="unidade" value="LT"></div>
      <div class="form-group"><label>Preço</label><input name="preco" type="number" step="0.001" required></div>
      <div class="form-group"><label>CST ICMS</label><input name="cst_icms" value="60"></div>
      <div class="form-group"><label>Alíq. ICMS</label><input name="aliq_icms" type="number" step="0.01" value="0"></div>
      <button class="btn btn-primary span-2" type="submit">Salvar</button>
    </form>`);
  document.getElementById("form-prod").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await apiFetch("/cadastros/produtos", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(ev.target))) });
      showToast("Produto salvo"); closeModal(); cache.produtos = []; loadProdutos();
    } catch (ex) { showToast(ex.message, "error"); }
  });
}

function val(id) { return document.getElementById(id).value; }

(function init() {
  if (token) { showApp(true); navigateTo("dashboard"); }
})();
