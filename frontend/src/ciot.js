// Lógica pura do CIOT no frontend (sem DOM): montagem do corpo do POST /api/ciot
// (mesmos nomes de campo de dadosAntt no ciotController), validação de ajuda,
// ações permitidas por estado e HTML do formulário/painel. A autoridade das
// regras é o backend (DCS PEF v1.1); aqui a validação só poupa idas e voltas.
// Todo valor vindo do servidor ou do usuário passa por esc() antes de ir ao HTML.
(function (g) {
  const E = typeof module !== "undefined" && module.exports ? require("./esc.js") : g;
  const { esc, fmt } = E;

  // ---------- util ----------
  const vazio = (x) => x === undefined || x === null || String(x).trim() === "";
  const txt = (x) => (vazio(x) ? undefined : String(x).trim());
  const num = (x) => (vazio(x) ? undefined : Number(String(x).replace(",", ".")));
  const digitos = (x) => String(x ?? "").replace(/\D/g, "");

  // Data de hoje em America/Sao_Paulo (yyyy-MM-dd): o DCS compara com esse fuso (B6/B22).
  function hojeSP(agora = new Date()) {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(agora);
    const g1 = (t) => p.find((x) => x.type === t).value;
    return `${g1("year")}-${g1("month")}-${g1("day")}`;
  }
  function somarDias(iso, n) {
    const [a, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
  }
  const diasEntre = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  // Idempotency-Key: o servidor aceita [A-Za-z0-9-]{8,100}. randomUUID só existe em
  // contexto seguro (https/localhost); acesso pelo IP da rede local cai no fallback.
  function novaChaveIdempotencia(c = typeof crypto !== "undefined" ? crypto : undefined) {
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
    else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  // Mantém a chave só quando a resposta é indefinida (falha de rede do navegador,
  // pendente ou 5xx sem status no corpo): reenviar devolve a mesma operação. Após
  // resposta definitiva (201, 400, rejeitado, nao_enviado) a chave deve ser nova,
  // senão o reenvio corrigido devolveria a linha rejeitada antiga (reaproveitado).
  function deveRegenerarChave(ex) {
    if (!ex || ex.status === undefined || ex.status === null) return false;
    const st = ex.data && ex.data.status;
    if (st === "pendente") return false;
    if (ex.status >= 500 && !st) return false;
    return true;
  }

  // ---------- status / textos ----------
  const ROTULOS = {
    pendente: "Pendente (sem CIOT)",
    emitido: "Emitido",
    rejeitado: "Rejeitado",
    nao_enviado: "Não enviado",
    nao_registrado: "Não registrado",
    cancelado: "Cancelado",
    encerrado: "Encerrado",
  };
  const rotuloStatusCiot = (s) => ROTULOS[s] || String(s || "Pendente (sem CIOT)");
  const CLASSE = { emitido: "green", rejeitado: "red", nao_enviado: "red", nao_registrado: "red", cancelado: "red", encerrado: "blue", pendente: "amber" };
  const classeStatusCiot = (s) => CLASSE[s] || "amber";

  // Tabela de estados do docs/CIOT-STATUS.md.
  const EXPLICA = {
    pendente: "Enviado à ANTT sem confirmação. Ainda NÃO é CIOT: use Consultar na ANTT. O ID da operação não pode ser reutilizado antes da consulta.",
    emitido: "Confirmado pela ANTT. O número tem 16 caracteres (ID + dígito verificador).",
    rejeitado: "A ANTT recusou a declaração. O mesmo ID pode ser reenviado depois de corrigir os dados.",
    nao_enviado: "Certificado, TLS ou acesso recusado; a ANTT não processou nada. O mesmo ID pode ser reenviado.",
    nao_registrado: "A consulta confirmou que a ANTT não registrou este ID. Reenvie com o MESMO ID.",
    cancelado: "Cancelamento confirmado pela ANTT.",
    encerrado: "Encerramento confirmado pela ANTT.",
  };
  const explicacaoStatusCiot = (s) => EXPLICA[s] || "";

  const PROXIMA = {
    consultar: "Consultar na ANTT para saber se a declaração foi registrada.",
    aguardar_resposta: "Aguardar a resposta da ANTT.",
    consultar_novamente: "Consultar de novo mais tarde.",
    confirmar_com_antt: "Conferir na ANTT se o CIOT encontrado é desta operação e confirmar.",
    verificar_com_antt: "Verificar a operação diretamente na ANTT.",
    verificar_mensagem_antt: "Ler a mensagem da ANTT e corrigir.",
    corrigir_e_reenviar: "Corrigir os dados e reenviar com o mesmo ID.",
    corrigir_configuracao: "Corrigir a configuração (certificado/acesso) e reenviar.",
    reenviar_mesmo_id: "Reenviar a declaração com o MESMO ID.",
    repetir_cancelamento: "Repetir o cancelamento.",
    repetir_encerramento: "Repetir o encerramento.",
  };
  const textoProximaAcao = (p) => (p ? PROXIMA[p] || String(p) : "");

  // ---------- ações ----------
  // Cancelar fica oculto só com MDF-e vinculado autorizado (o backend barra nesse caso).
  function acoesCiot(c) {
    if (!c) return [];
    const mdfe = c.mdfe_status === "autorizada";
    if (c.provider !== "antt") {
      return c.status === "emitido" && !mdfe ? [{ id: "cancelar", rotulo: "Cancelar" }] : [];
    }
    const op = c.operacao_pendente && c.operacao_pendente.tipo;
    if (c.status === "pendente") return [{ id: "consultar", rotulo: "Consultar na ANTT" }];
    if (c.status === "emitido") {
      const a = [{ id: "consultar", rotulo: "Consultar na ANTT" }];
      if (op === "encerramento") a.push({ id: "encerrar", rotulo: "Repetir encerramento" });
      else if (op === "cancelamento") a.push({ id: "cancelar", rotulo: "Repetir cancelamento" });
      else {
        a.push({ id: "encerrar", rotulo: "Encerrar" });
        if (!mdfe) a.push({ id: "cancelar", rotulo: "Cancelar" });
      }
      return a;
    }
    if (c.status === "rejeitado" || c.status === "nao_enviado" || c.status === "nao_registrado") {
      return [{ id: "reenviar", rotulo: "Reenviar com o mesmo ID" }];
    }
    return [];
  }

  // ---------- corpo do POST /api/ciot ----------
  const FORMA_POR_TIPO = { 2: "TED", 3: "TED", 4: "TED", 5: "OUTROS", 6: "PIX" };

  function limpa(o) {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  }
  function pontoDe(l, tipo) {
    l = l || {};
    if (tipo === "cep") return { cep: txt(l.cep) };
    if (tipo === "coordenadas") return { latitude: num(l.latitude), longitude: num(l.longitude) };
    return { municipio: txt(l.municipio) };
  }

  // c: valores planos do formulário (nomes em camposDeEntrada).
  // B111: UM tipo de localização (c.tipo_localizacao) vale para origem e destino de
  // todas as linhas — a ANTT recusa tipos diferentes no mesmo par.
  function montarCorpoCiotAntt(c) {
    const tipo = Number(c.tipo_operacao ?? 1);
    const loc = c.tipo_localizacao || "municipio";
    const tp = Number(c.tipo_pagamento ?? 6);
    const veiculos = (c.veiculos || []).map((v) => limpa({ placa: txt(v.placa), eixos: num(v.eixos), rntrc: txt(v.rntrc) }));
    const b = limpa({
      id_operacao: vazio(c.id_operacao) ? undefined : String(c.id_operacao).trim().toUpperCase(),
      tipo_operacao: tipo,
      contratante_nome: txt(c.contratante_nome),
      contratante_doc: txt(c.contratante_doc),
      contratante_rntrc: txt(c.contratante_rntrc),
      contratado_doc: txt(c.contratado_doc),
      contratado_rntrc: txt(c.contratado_rntrc),
      destinatario_doc: tipo === 3 ? undefined : txt(c.destinatario_doc),
      motorista_nome: txt(c.motorista_nome),
      motorista_cpf: txt(c.motorista_cpf),
      // placa legada: o MDF-e e a lista usam a 1ª placa declarada
      placa: veiculos[0] && veiculos[0].placa,
      valor_contrato: num(c.valor_contrato),
      valor_adiantamento: num(c.valor_adiantamento) ?? 0,
      veiculos,
      data_inicio_viagem: tipo === 3 ? undefined : txt(c.data_inicio_viagem),
      data_fim_viagem: txt(c.data_fim_viagem),
      forma_pagto: FORMA_POR_TIPO[tp] || "PIX",
      tipo_pagamento: tp,
      creditado_doc: txt(c.creditado_doc),
      ind_pagamento: Number(c.ind_pagamento ?? 0),
    });
    if ([2, 3, 4].includes(tp)) Object.assign(b, limpa({ banco: txt(c.banco), agencia: txt(c.agencia), conta: txt(c.conta) }));
    if (tp === 6) Object.assign(b, limpa({ chave_pix: txt(c.chave_pix), identificador_pix: txt(c.identificador_pix) }));
    if (b.ind_pagamento === 1) {
      Object.assign(b, limpa({ numero_parcela: num(c.numero_parcela), data_vencimento: txt(c.data_vencimento), valor_parcela: num(c.valor_parcela) }));
    }
    if (tipo === 1 || tipo === 2) {
      b.origem_destino = (c.trechos || []).map((t) => limpa({
        origem: limpa(pontoDe(t.origem, loc)),
        destino: limpa(pontoDe(t.destino, loc)),
        distancia: num(t.distancia),
      }));
      const carga = limpa({ natureza: txt(c.carga_natureza), tipo: num(c.carga_tipo), peso: num(c.carga_peso) });
      if (tipo === 2) {
        const lista = Array.isArray(c.contratantes_frac) ? c.contratantes_frac : String(c.contratantes_frac || "").split(/[\s,;]+/);
        carga.contratantes_frac = lista.map((x) => String(x).trim()).filter(Boolean);
      }
      b.carga = carga;
    }
    // indicadores só existem na operação padrão (tipo 1)
    if (tipo === 1) {
      b.indicadores = {
        alto_desempenho: !!c.alto_desempenho,
        retorno_vazio: !!c.retorno_vazio,
        composicao_veicular: !!c.composicao_veicular,
      };
    }
    if (c.contingencia) {
      b.contingencia = true;
      b.justificativa_contingencia = txt(c.justificativa_contingencia);
    }
    return b;
  }

  // Inverso: entrada_antt (guardada pelo servidor) -> campos do formulário, para
  // "Reenviar com o mesmo ID". Datas fora da janela de hoje são limpas (B6/B22/B21).
  function camposDeEntrada(e, { agora = new Date() } = {}) {
    e = e || {};
    const p = e.pagamento || {};
    const od = Array.isArray(e.origem_destino) ? e.origem_destino : [];
    const o0 = (od[0] && od[0].origem) || {};
    const tipoLoc = o0.latitude !== undefined || o0.longitude !== undefined ? "coordenadas" : o0.cep ? "cep" : "municipio";
    const carga = e.carga || {};
    const ind = e.indicadores || {};
    const mun = (x) => ({ ...x, municipio: x && (x.municipio ?? x.codigo_municipio) });
    const c = {
      id_operacao: e.id_operacao,
      tipo_operacao: e.tipo_operacao ?? 1,
      contratante_nome: e.contratante_nome,
      contratante_doc: e.contratante_doc,
      contratante_rntrc: e.contratante_rntrc,
      contratado_doc: e.contratado_doc,
      contratado_rntrc: e.contratado_rntrc,
      destinatario_doc: e.destinatario_doc,
      motorista_nome: e.motorista_nome,
      motorista_cpf: e.motorista_cpf,
      valor_contrato: e.valor_contrato ?? e.valor_frete,
      valor_adiantamento: e.valor_adiantamento,
      veiculos: (e.veiculos || []).map((v) => ({ placa: v.placa, eixos: v.eixos, rntrc: v.rntrc })),
      tipo_localizacao: tipoLoc,
      trechos: od.map((t) => ({ origem: mun(t.origem), destino: mun(t.destino), distancia: t.distancia })),
      carga_natureza: carga.natureza,
      carga_tipo: carga.tipo,
      carga_peso: carga.peso,
      contratantes_frac: (carga.contratantes_frac || []).join("\n"),
      tipo_pagamento: p.tipo_pagamento ?? 6,
      banco: p.banco, agencia: p.agencia, conta: p.conta,
      chave_pix: p.chave_pix, identificador_pix: p.identificador_pix,
      creditado_doc: p.creditado_doc,
      ind_pagamento: p.ind_pagamento ?? 0,
      numero_parcela: p.numero_parcela, data_vencimento: p.data_vencimento, valor_parcela: p.valor_parcela,
      alto_desempenho: !!ind.alto_desempenho, retorno_vazio: !!ind.retorno_vazio, composicao_veicular: !!ind.composicao_veicular,
      contingencia: !!e.contingencia,
      justificativa_contingencia: e.justificativa_contingencia,
      data_inicio_viagem: e.data_inicio_viagem,
      data_fim_viagem: e.data_fim_viagem,
    };
    const avisos = [];
    const hoje = hojeSP(agora);
    if (!c.contingencia && c.data_inicio_viagem && (c.data_inicio_viagem < hoje || diasEntre(hoje, c.data_inicio_viagem) > 30)) {
      c.data_inicio_viagem = "";
      avisos.push("Data de início anterior a hoje ou além de 30 dias: informe de novo.");
    }
    if (c.data_fim_viagem) {
      const ini = c.data_inicio_viagem || hoje;
      if (c.data_fim_viagem < ini || diasEntre(ini, c.data_fim_viagem) > 90) {
        c.data_fim_viagem = "";
        avisos.push("Data de fim fora da janela permitida: informe de novo.");
      }
    }
    return { campos: c, avisos };
  }

  // Ajuda no cliente; o backend continua sendo a autoridade (mensagens dele vêm como vieram).
  function validarCiotAntt(c, { agora = new Date(), idModo = "manual" } = {}) {
    const er = [];
    const tipo = Number(c.tipo_operacao ?? 1);
    if (tipo === 3) er.push("TAC-Agregado exige Instituição de Pagamento (B27/B115): indisponível neste sistema.");
    if (idModo !== "sequencial_experimental" && !/^[0-9A-Za-z]{12}$/.test(String(c.id_operacao || "").trim())) {
      er.push("id_operacao deve ter 12 caracteres [0-9A-Z], gerado no executável oficial da ANTT (regra B4).");
    }
    if (!/^\d{8,9}$/.test(digitos(c.contratado_rntrc))) er.push("RNTRC do contratado deve ter 8 ou 9 dígitos.");
    const vs = c.veiculos || [];
    if (!vs.length) er.push("Informe ao menos um veículo.");
    if (vs.length > 5) er.push("Máximo de 5 veículos (B49).");
    const vistas = new Set();
    vs.forEach((v) => {
      const pl = String(v.placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (vistas.has(pl)) er.push(`Placa repetida: ${pl} (B5).`);
      vistas.add(pl);
      const ex = Number(v.eixos);
      if (!Number.isInteger(ex) || ex < 1 || ex > 4) er.push(`Veículo ${pl || "?"}: eixos de 1 a 4.`);
    });
    const hoje = hojeSP(agora);
    if (tipo !== 3) {
      const ini = c.data_inicio_viagem;
      if (!ini) er.push("Informe a data de início da viagem.");
      else if (!c.contingencia && ini < hoje) er.push("Início da viagem não pode ser anterior a hoje (B6).");
      else if (!c.contingencia && diasEntre(hoje, ini) > 30) er.push("Início da viagem além de 30 dias de hoje (B22).");
    }
    const ini = c.data_inicio_viagem || hoje;
    if (!c.data_fim_viagem) er.push("Informe a data de fim da viagem.");
    else if (c.data_fim_viagem < ini) er.push("Fim da viagem deve ser maior ou igual ao início (B13).");
    else if (diasEntre(ini, c.data_fim_viagem) > 90) er.push("Intervalo entre início e fim acima de 90 dias (B21).");
    if (tipo !== 3 && !(c.trechos || []).length) er.push("Informe ao menos um trecho (origem/destino).");
    if (tipo === 2) {
      const cf = (Array.isArray(c.contratantes_frac) ? c.contratantes_frac : String(c.contratantes_frac || "").split(/[\s,;]+/)).map(digitos).filter(Boolean);
      if (!cf.length) er.push("Informe os contratantes da carga fracionada.");
      if (cf.includes(digitos(c.contratante_doc))) er.push("Contratante da carga fracionada não pode repetir o contratante (B119).");
    }
    if (c.contingencia) {
      if (vazio(c.justificativa_contingencia)) er.push("Justificativa da contingência é obrigatória.");
      else if (String(c.justificativa_contingencia).length > 255) er.push("Justificativa da contingência: máximo 255 caracteres.");
    }
    if (Number(c.tipo_pagamento) === 6 && String(c.identificador_pix || "").length > 32) er.push("Identificador Pix: máximo 32 caracteres.");
    if (Number(c.valor_adiantamento || 0) > Number(c.valor_contrato || 0)) er.push("Adiantamento não pode exceder o valor do contrato.");
    return er;
  }

  // ---------- HTML ----------
  function faixaCiot(cfg) {
    cfg = cfg || {};
    let bloqueio = null;
    const amb = cfg.ambiente === "producao"
      ? `<span class="badge red">PRODUÇÃO</span>`
      : `<span class="badge amber">HOMOLOGAÇÃO</span> <span>sem validade jurídica</span>`;
    let cert;
    const ct = cfg.certificado;
    if (cfg.erro_config) {
      bloqueio = cfg.erro_config;
      cert = `<span class="ciot-faixa-erro">${esc(cfg.erro_config)}</span>`;
    } else if (ct && ct.ok) {
      cert = `Certificado: CNPJ ${esc(ct.cnpj)}, válido até ${fmt(ct.valido_ate, "date")}${ct.icp_brasil === false ? ' <span class="badge amber">não ICP-Brasil</span>' : ""}`;
    } else {
      bloqueio = (ct && ct.erro) || "Certificado indisponível";
      cert = `<span class="ciot-faixa-erro">Certificado: ${esc(bloqueio)}</span>`;
    }
    return { html: `<div class="ciot-faixa">${amb}<span>${cert}</span></div>`, bloqueio };
  }

  const opt = (v, l, cur, extra = "") => `<option value="${esc(v)}"${String(cur) === String(v) ? " selected" : ""}${extra}>${esc(l)}</option>`;
  const inp = (name, v, attrs = "") => `<input name="${esc(name)}" value="${esc(v ?? "")}" ${attrs}>`;
  const grupo = (label, inner, { span, show, cls } = {}) =>
    `<div class="form-group${span ? " span-2" : ""}${cls ? " " + cls : ""}"${show ? ` data-show-if="${esc(show)}"` : ""}><label>${label}</label>${inner}</div>`;
  const sec = (t) => `<h4 class="ciot-sec span-2">${esc(t)}</h4>`;

  function veiculoRowHtml(v = {}) {
    return `<div class="vei-row">
      <div class="form-group"><label>Placa</label><input class="v-placa" value="${esc(v.placa ?? "")}" maxlength="8" required style="text-transform:uppercase"></div>
      <div class="form-group"><label>Eixos (1 a 4)</label><input class="v-eixos" type="number" min="1" max="4" step="1" value="${esc(v.eixos ?? "")}" required></div>
      <div class="form-group"><label>RNTRC (opcional)</label><input class="v-rntrc" value="${esc(v.rntrc ?? "")}" inputmode="numeric" pattern="[0-9]{8,9}"></div>
      <button type="button" class="btn btn-ghost btn-sm vei-del" title="Remover veículo">✕</button>
    </div>`;
  }
  function locInputs(lado, l = {}) {
    const k = (n) => `data-k="${lado}.${n}"`;
    const nome = lado === "origem" ? "Origem" : "Destino";
    return `
      <div class="form-group" data-show-if="tipo_localizacao=municipio"><label>${nome}: município IBGE (7 dígitos)</label><input ${k("municipio")} value="${esc(l.municipio ?? "")}" inputmode="numeric" pattern="[0-9]{7}" data-req></div>
      <div class="form-group" data-show-if="tipo_localizacao=cep"><label>${nome}: CEP (8 dígitos)</label><input ${k("cep")} value="${esc(l.cep ?? "")}" inputmode="numeric" pattern="[0-9]{8}" data-req></div>
      <div class="form-group" data-show-if="tipo_localizacao=coordenadas"><label>${nome}: latitude</label><input ${k("latitude")} value="${esc(l.latitude ?? "")}" type="number" step="any" min="-90" max="90" data-req></div>
      <div class="form-group" data-show-if="tipo_localizacao=coordenadas"><label>${nome}: longitude</label><input ${k("longitude")} value="${esc(l.longitude ?? "")}" type="number" step="any" min="-180" max="180" data-req></div>`;
  }
  function trechoRowHtml(t = {}) {
    return `<div class="trecho-row">
      ${locInputs("origem", t.origem)}
      ${locInputs("destino", t.destino)}
      <div class="form-group"><label>Distância (km)</label><input data-k="distancia" type="number" min="1" step="1" value="${esc(t.distancia ?? "")}" required></div>
      <button type="button" class="btn btn-ghost btn-sm trecho-del" title="Remover trecho">✕</button>
    </div>`;
  }

  // Formulário ANTT. v = campos pré-preenchidos (ver camposDeEntrada); reenvio = id_operacao
  // reaproveitado (campo travado).
  function formCiotAnttHtml(cfg, v = {}, { agora = new Date(), reenvio = false, avisos = [] } = {}) {
    cfg = cfg || {};
    const hoje = hojeSP(agora);
    const vc = { tipo_operacao: 1, tipo_localizacao: "municipio", tipo_pagamento: 6, ind_pagamento: 0, ...v };
    const veic = (vc.veiculos && vc.veiculos.length ? vc.veiculos : [{}]).map(veiculoRowHtml).join("");
    const trechos = (vc.trechos && vc.trechos.length ? vc.trechos : [{}]).map(trechoRowHtml).join("");
    const experimental = cfg.id_modo === "sequencial_experimental";
    const idCampo = experimental
      ? `<div class="aviso-amarelo span-2">Modo ID sequencial EXPERIMENTAL: o ID é gerado localmente e a ANTT o rejeita (205). Use apenas em teste.</div>`
      : grupo("id_operacao (12 caracteres, gerado no executável oficial da ANTT — regra B4)",
        inp("id_operacao", vc.id_operacao, `required maxlength="12" pattern="[0-9A-Za-z]{12}" style="text-transform:uppercase"${reenvio ? " readonly" : ""}`)
        + (reenvio ? `<small>Reenvio com o mesmo ID: o campo não pode mudar.</small>` : ""), { span: true });
    return `
      ${avisos.length ? `<div class="aviso-amarelo">${avisos.map(esc).join("<br>")}</div>` : ""}
      <form id="form-ciot-antt" class="form-grid form-antt">
        ${sec("Operação")}
        ${grupo("Tipo de operação",
          `<select name="tipo_operacao">${opt(1, "1 — Padrão (lotação)", vc.tipo_operacao)}${opt(2, "2 — Carga fracionada", vc.tipo_operacao)}${opt(3, "3 — TAC-Agregado (indisponível)", vc.tipo_operacao, " disabled")}</select>
           <small>TAC-Agregado exige Instituição de Pagamento (B27/B115).</small>`)}
        ${idCampo}
        ${sec("Contratado (a empresa) e contratante")}
        ${grupo("CNPJ contratado (empresa)", inp("contratado_doc", cfg.empresa_cnpj || vc.contratado_doc, "readonly"))}
        ${grupo("RNTRC do contratado (8 a 9 dígitos)", inp("contratado_rntrc", vc.contratado_rntrc, `required inputmode="numeric" pattern="[0-9]{8,9}"`))}
        ${grupo("Contratante (nome)", inp("contratante_nome", vc.contratante_nome, "required"))}
        ${grupo("CPF/CNPJ contratante", inp("contratante_doc", vc.contratante_doc, "required"))}
        ${grupo("RNTRC do contratante (opcional)", inp("contratante_rntrc", vc.contratante_rntrc, `inputmode="numeric" pattern="[0-9]{8,9}"`))}
        ${grupo("CPF/CNPJ destinatário", inp("destinatario_doc", vc.destinatario_doc, "data-req"), { show: "tipo_operacao=1,2" })}
        ${grupo("Motorista", inp("motorista_nome", vc.motorista_nome, "required"))}
        ${grupo("CPF do motorista", inp("motorista_cpf", vc.motorista_cpf, "required"))}
        ${sec("Veículos (1 a 5)")}
        <div class="span-2"><div id="vei-lista">${veic}</div>
          <button type="button" class="btn btn-ghost btn-sm" id="vei-add">+ veículo</button></div>
        ${sec("Viagem")}
        ${grupo("Início da viagem", inp("data_inicio_viagem", vc.data_inicio_viagem, `type="date" min="${hoje}" max="${somarDias(hoje, 30)}" data-min="${hoje}" data-max="${somarDias(hoje, 30)}" data-req`), { show: "tipo_operacao=1,2" })}
        ${grupo("Fim da viagem (até 90 dias do início)", inp("data_fim_viagem", vc.data_fim_viagem, `type="date" required`))}
        ${grupo("Tipo de localização (vale para origem e destino — B111)",
          `<select name="tipo_localizacao">${opt("municipio", "Município (IBGE)", vc.tipo_localizacao)}${opt("cep", "CEP", vc.tipo_localizacao)}${opt("coordenadas", "Latitude/longitude", vc.tipo_localizacao)}</select>`, { span: true })}
        <div class="span-2"><div id="trecho-lista">${trechos}</div>
          <button type="button" class="btn btn-ghost btn-sm" id="trecho-add">+ trecho</button></div>
        <div class="span-2 ciot-bloco" data-show-if="tipo_operacao=1,2">
          ${sec("Carga")}
          <div class="form-grid">
          ${grupo("Natureza da carga (até 4 dígitos)", inp("carga_natureza", vc.carga_natureza, `inputmode="numeric" pattern="[0-9]{1,4}" maxlength="4" data-req`))}
          ${grupo("Tipo de carga (1 a 12)", inp("carga_tipo", vc.carga_tipo, `type="number" min="1" max="12" step="1" data-req`))}
          ${grupo("Peso (kg)", inp("carga_peso", vc.carga_peso, `type="number" min="0.01" step="0.01" data-req`))}
          ${grupo("Contratantes da carga fracionada (um CPF/CNPJ por linha; diferentes do contratante — B119)",
            `<textarea name="contratantes_frac" rows="3" data-req>${esc(vc.contratantes_frac ?? "")}</textarea>`, { span: true, show: "tipo_operacao=2" })}
          </div>
        </div>
        ${sec("Pagamento")}
        ${grupo("Valor do contrato (ValorFrete, R$)", inp("valor_contrato", vc.valor_contrato, `type="number" min="0.01" step="0.01" required`))}
        ${grupo("Adiantamento (R$)", inp("valor_adiantamento", vc.valor_adiantamento ?? 0, `type="number" min="0" step="0.01"`))}
        ${grupo("Tipo de pagamento",
          `<select name="tipo_pagamento">${opt(2, "2 — Conta corrente", vc.tipo_pagamento)}${opt(3, "3 — Poupança", vc.tipo_pagamento)}${opt(4, "4 — Conta pagamento", vc.tipo_pagamento)}${opt(5, "5 — Outros", vc.tipo_pagamento)}${opt(6, "6 — Pix", vc.tipo_pagamento)}</select>`)}
        ${grupo("CPF/CNPJ creditado (opcional; padrão: contratado)", inp("creditado_doc", vc.creditado_doc))}
        ${grupo("Banco (até 3 dígitos)", inp("banco", vc.banco, `inputmode="numeric" maxlength="3" pattern="[0-9]{1,3}" data-req`), { show: "tipo_pagamento=2,3,4" })}
        ${grupo("Agência", inp("agencia", vc.agencia, `maxlength="10" data-req`), { show: "tipo_pagamento=2,3,4" })}
        ${grupo("Conta", inp("conta", vc.conta, `maxlength="20" data-req`), { show: "tipo_pagamento=2,3,4" })}
        ${grupo("Chave Pix", inp("chave_pix", vc.chave_pix, `maxlength="77" data-req`), { show: "tipo_pagamento=6" })}
        ${grupo("Identificador Pix (até 32)", inp("identificador_pix", vc.identificador_pix, `maxlength="32" data-req`), { show: "tipo_pagamento=6" })}
        ${grupo("Forma",
          `<select name="ind_pagamento">${opt(0, "0 — À vista", vc.ind_pagamento)}${opt(1, "1 — A prazo (parcela)", vc.ind_pagamento)}</select>`)}
        ${grupo("Nº da parcela", inp("numero_parcela", vc.numero_parcela, `type="number" min="1" step="1" data-req`), { show: "ind_pagamento=1" })}
        ${grupo("Vencimento", inp("data_vencimento", vc.data_vencimento, `type="date" data-req`), { show: "ind_pagamento=1" })}
        ${grupo("Valor da parcela (R$)", inp("valor_parcela", vc.valor_parcela, `type="number" min="0.01" step="0.01" data-req`), { show: "ind_pagamento=1" })}
        <div class="span-2 ciot-bloco" data-show-if="tipo_operacao=1">
          ${sec("Indicadores operacionais")}
          <label class="chk"><input type="checkbox" name="alto_desempenho"${vc.alto_desempenho ? " checked" : ""}> Alto desempenho</label>
          <label class="chk"><input type="checkbox" name="retorno_vazio"${vc.retorno_vazio ? " checked" : ""}> Retorno vazio</label>
          <label class="chk"><input type="checkbox" name="composicao_veicular"${vc.composicao_veicular ? " checked" : ""}> Composição veicular</label>
        </div>
        <div class="span-2">
          <label class="chk"><input type="checkbox" name="contingencia"${vc.contingencia ? " checked" : ""}> Contingência</label>
        </div>
        ${grupo("Justificativa da contingência (até 255)", `<textarea name="justificativa_contingencia" rows="2" maxlength="255" data-req>${esc(vc.justificativa_contingencia ?? "")}</textarea>`, { span: true, show: "contingencia=on" })}
        <div class="span-2 ciot-erro" id="ciot-erro" hidden></div>
        <button class="btn btn-primary span-2" type="submit" id="ciot-enviar">Emitir CIOT na ANTT</button>
      </form>`;
  }

  // ---------- painel de detalhe ----------
  const TIPOS_OP = { 1: "Padrão (lotação)", 2: "Carga fracionada", 3: "TAC-Agregado" };
  const campoDet = (l, v) => `<div class="detail-field"><label>${esc(l)}</label><span>${v}</span></div>`;
  // O servidor grava ISO em UTC; o operador lê no horário de Brasília.
  const dataHora = (v) => {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return esc(String(v));
    return esc(d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }));
  };
  const jsonPre = (titulo, o) =>
    o === undefined || o === null || o === ""
      ? ""
      : `<details class="ciot-evid"><summary>${esc(titulo)}</summary><pre>${esc(typeof o === "string" ? o : JSON.stringify(o, null, 2))}</pre></details>`;

  function detalheCiotHtml(c) {
    c = c || {};
    const antt = c.provider === "antt";
    let numero;
    if (c.numero && (c.oficial || c.simulado || (c.provider === "antt" && ["cancelado", "encerrado"].includes(c.status)))) {
      numero = `<strong>${esc(c.numero)}</strong> ${c.simulado ? '<span class="badge amber">SIMULADO</span>' : '<span class="badge green">ANTT</span>'}`;
    } else if (c.id_operacao) {
      numero = `<strong>ID op. ${esc(c.id_operacao)}</strong> <span class="badge amber">não é CIOT</span>`;
    } else numero = "—";
    const hml = antt && c.ambiente === "homologacao" ? ' <span class="badge amber" title="Homologação: sem validade jurídica">HML</span>' : "";
    const op = c.operacao_pendente;
    const veic = (c.veiculos || []).map((v) => `${esc(v.placa)}${v.eixos ? ` (${esc(v.eixos)} eixos)` : ""}`).join(", ") || fmt(c.placa);
    const acoes = acoesCiot(c)
      .map((a) => `<button class="btn ${a.id === "cancelar" ? "btn-ghost" : "btn-primary"}" data-ciot-acao="${esc(a.id)}">${esc(a.rotulo)}</button>`)
      .join("");
    return `
      <div class="detail-section"><h3>CIOT</h3>
        <p>${numero}${hml}</p>
        <p style="margin-top:8px"><span class="badge ${classeStatusCiot(c.status)}">${esc(rotuloStatusCiot(c.status))}</span></p>
        <p class="ciot-expl">${esc(antt ? explicacaoStatusCiot(c.status) : "Registro SIMULADO (modo local): não foi enviado à ANTT e não tem validade legal.")}</p>
        ${c.proxima_acao ? `<p class="ciot-expl">${esc(textoProximaAcao(c.proxima_acao))}</p>` : ""}
      </div>
      ${op ? `<div class="aviso-amarelo"><strong>Operação pendente: ${esc(op.tipo)}.</strong> ${esc(op.mensagem || "")} Sem confirmação da ANTT; o status foi mantido. Verifique e repita.</div>` : ""}
      <div class="detail-section"><h3>ANTT</h3><div class="detail-grid">
        ${campoDet("Ambiente", antt ? fmt(c.ambiente) : "local (simulado)")}
        ${campoDet("Código ANTT", fmt(c.codigo_antt))}
        ${campoDet("Mensagem ANTT", fmt(c.mensagem_antt))}
        ${campoDet("Tipo de operação", fmt(TIPOS_OP[c.tipo_operacao] || c.tipo_operacao))}
        ${campoDet("Protocolo da declaração", fmt(c.protocolo))}
        ${campoDet("Protocolo do cancelamento", fmt(c.protocolo_cancelamento))}
        ${campoDet("Protocolo do encerramento", fmt(c.protocolo_encerramento))}
        ${campoDet("Declarado em", dataHora(c.declarado_em || c.created_at))}
      </div></div>
      <div class="detail-section"><h3>Operação</h3><div class="detail-grid">
        ${campoDet("Contratado", fmt(c.contratado_doc))}
        ${campoDet("Contratante", fmt(c.contratante_nome))}
        ${campoDet("Documento do contratante", fmt(c.contratante_doc))}
        ${campoDet("Motorista", fmt(c.motorista_nome))}
        ${campoDet("Veículos", veic)}
        ${campoDet("Valor", fmt(c.valor_contrato, "money"))}
        ${campoDet("Início da viagem", fmt(c.data_inicio_viagem, "date"))}
        ${campoDet("Fim da viagem", fmt(c.data_fim_viagem, "date"))}
        ${campoDet("MDF-e vinculado", c.mdfe_id ? esc(c.mdfe_id) : "—")}
      </div></div>
      ${jsonPre("Declaração enviada (payload)", c.payload_declaracao)}
      ${jsonPre("Resposta da ANTT à declaração", c.resposta_antt)}
      ${jsonPre("Resposta da última consulta", c.resposta_consulta)}
      <div class="ciot-acoes">${acoes}</div>`;
  }

  const api = {
    hojeSP, somarDias, novaChaveIdempotencia, deveRegenerarChave,
    rotuloStatusCiot, classeStatusCiot, explicacaoStatusCiot, textoProximaAcao,
    acoesCiot, montarCorpoCiotAntt, camposDeEntrada, validarCiotAntt,
    faixaCiot, formCiotAnttHtml, veiculoRowHtml, trechoRowHtml, detalheCiotHtml,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(g, api);
})(this);
