(() => {
  const state = {
    veiculos: [],
    localizacao: [],
    kpis: {},
    sondaMeta: null,
    tempoMeta: null,
    markers: {},
    map: null,
    layer: null,
    selected: null,
    currentModule: "mapa",
    authUser: null,
    acessoLivre: true,
    /** ms desde epoch; texto “há Xs” no topo */
    lastSyncAt: null,
    /** Evita `fitBounds` a cada poll (causava sensação de “página a recarregar”). */
    mapInitialFitDone: false,
    /** Evita reescrever tbody do módulo de quebras (manutenção) quando nada mudou (poll). */
    criticosTableSig: null,
    quebrasTableSig: null,
    quebraMotivos: [],
    quebraPrefixoMap: new Map(),
  };

  const fetchOpts = { cache: "no-store", credentials: "same-origin" };

  const POLL_MS = 10000;
  const BASE_HEALTH_WARN_MIN = 30;
  const BASE_HEALTH_CRIT_MIN = 120;
  const FILTERS_KEY = "soltura_localizacao_filters_v2";
  const UI_KEY = "soltura_ui_state_v2";
  const MODULE_KEY = "ssov_module_v1";
  const SIDEBAR_EXPAND_KEY = "ssov_sidebar_expand_v1";
  const ACK_KEY = "soltura_ciente_prefixos_v1";
  const ACK_SEL_KEY = "soltura_ciente_selected_v1";

  /** Incrementa a cada `selectVehicle`; respostas assíncronas obsoletas não sobrescrevem o drawer. */
  let _vehicleDetailSeq = 0;

  function truncHint(s, maxLen) {
    const n = maxLen || 220;
    if (!s || s.length <= n) return s || "";
    return s.slice(0, n) + "…";
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    const t = document.createElement("textarea");
    t.textContent = String(s);
    return t.innerHTML;
  }

  /** Soltura em linguagem LIBERAR / RETER / AVALIAR (console operacional). */
  function decisaoOperacionalBinaria(v) {
    const st = String(v.status_soltura || "");
    if (st.includes("Pode liberar")) return { acao: "LIBERAR", cls: "op-decis--liberar" };
    if (st.includes("Não liberar")) return { acao: "RETER", cls: "op-decis--reter" };
    return { acao: "AVALIAR", cls: "op-decis--avaliar" };
  }

  function computeLiveOperationalCounts() {
    const vs = state.veiculos || [];
    const k = state.kpis || {};
    let online = 0;
    let preventivas = 0;
    for (const v of vs) {
      if (String(v.status_comunicacao || "") !== "SEM_ATUALIZACAO") online += 1;
      const cat = String(v.ssov_categoria || "").toLowerCase();
      const prev = String(v.preventiva_situacao || "").toLowerCase();
      if (v.ssov_preventiva_hoje === true || cat === "preventiva_dia" || prev === "vencida" || prev === "proxima") {
        preventivas += 1;
      }
    }
    return {
      online,
      criticos: k.criticos || 0,
      offline: k.sem_gps || 0,
      preventivas,
      recolhimento: k.aguardando_recolhimento || 0,
    };
  }

  function renderLiveOperationalBar() {
    const c = computeLiveOperationalCounts();
    const ids = ["liveOnline", "liveCriticos", "liveOffline", "livePreventivas", "liveRecolhimento"];
    const vals = [c.online, c.criticos, c.offline, c.preventivas, c.recolhimento];
    for (let i = 0; i < ids.length; i++) {
      const n = el(ids[i]);
      const next = String(vals[i]);
      if (n && n.textContent !== next) n.textContent = next;
    }
  }

  function refreshOperationalMode() {
    const c = computeLiveOperationalCounts();
    const total = Math.max(state.veiculos.length || 0, 1);
    const critRatio = c.criticos / total;
    const offRatio = c.offline / total;
    let mode = "normal";
    if (
      c.criticos >= 8 ||
      critRatio >= 0.06 ||
      c.offline >= 15 ||
      offRatio >= 0.06 ||
      c.recolhimento >= 6
    ) {
      mode = "critico";
    }
    document.body.setAttribute("data-op-mode", mode);
    const pill = el("topModoOperacional");
    if (!pill) return;
    if (!state.lastSyncAt) {
      pill.textContent = "Modo operacional: —";
      pill.title = "Aguardando sincronização com a API.";
      return;
    }
    pill.textContent =
      mode === "critico"
        ? "Modo operacional: muitas quebras por manutenção"
        : "Modo operacional: normal";
    pill.title =
      mode === "critico"
        ? "Frota com muitas unidades em quebra por conta da manutenção, sem GPS ou em recolhimento — revisar decisões."
        : "Operação dentro da faixa habitual.";
  }

  function tickUltimaSyncRelativa() {
    const tu = el("topUltimaAtualizacao");
    if (!tu || !state.lastSyncAt) return;
    const sec = Math.floor((Date.now() - state.lastSyncAt) / 1000);
    tu.textContent = "Última atualização: há " + sec + "s";
  }

  function el(id) {
    return document.getElementById(id);
  }

  let _opFlashTimer = null;
  function showOpFlash(msg, kind) {
    const k = kind === "err" ? "err" : "ok";
    const box = el("opFlash");
    const text = String(msg || "").trim() || "—";
    if (!box) {
      window.alert(text);
      return;
    }
    box.textContent = text;
    box.classList.remove("op-flash--hidden", "op-flash--ok", "op-flash--err");
    box.classList.add(k === "err" ? "op-flash--err" : "op-flash--ok");
    if (_opFlashTimer) clearTimeout(_opFlashTimer);
    _opFlashTimer = setTimeout(() => {
      box.classList.add("op-flash--hidden");
      box.textContent = "";
      box.classList.remove("op-flash--ok", "op-flash--err");
    }, k === "err" ? 9000 : 5200);
  }

  async function loadAuditoriaPanel() {
    const body = el("auditoriaBody");
    if (!body) return;
    body.innerHTML = "<p class='hint'>A carregar…</p>";
    try {
      const r = await fetch("/api/auditoria?limite=40", fetchOpts);
      if (r.status === 401) {
        body.innerHTML = "<p class='hint'>Inicie sessão para consultar a auditoria.</p>";
        showOpFlash("Auditoria: inicie sessão em Configurações.", "err");
        return;
      }
      const d = await r.json();
      if (!d.ok) {
        body.innerHTML = `<p class="hint">${escapeHtml(String(d.erro || "Erro"))}</p>`;
        showOpFlash(String(d.erro || "Auditoria indisponível."), "err");
        return;
      }
      const rows = d.itens || [];
      if (!rows.length) {
        body.innerHTML = "<p class='hint'>Sem registos de ações.</p>";
        showOpFlash("Auditoria: sem registos.", "ok");
        return;
      }
      const lines = rows
        .map(
          (it) =>
            `<tr><td class="op-td-mono">${escapeHtml(fmt(it.data_hora))}</td><td>${escapeHtml(fmt(it.usuario))}</td><td>${escapeHtml(fmt(it.prefixo))}</td><td>${escapeHtml(fmt(it.tipo_acao))}</td><td>${escapeHtml(truncHint(it.descricao, 96))}</td></tr>`
        )
        .join("");
      body.innerHTML = `<div class="table-scroll"><table class="grid op-table-terminal"><thead><tr><th>Data/hora</th><th>Utilizador</th><th>Prefixo</th><th>Tipo</th><th>Descrição</th></tr></thead><tbody>${lines}</tbody></table></div>`;
      showOpFlash("Auditoria atualizada.", "ok");
    } catch (e) {
      body.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
      showOpFlash("Falha ao carregar auditoria.", "err");
    }
  }

  function fmt(v) {
    if (v === null || v === undefined || v === "") return "—";
    return String(v);
  }

  function shortMotivo(v) {
    const s = String(v || "").trim();
    if (!s) return "—";
    const low = s.toLowerCase();
    if (low.includes("sem gps")) return "Sem GPS";
    if (low.includes("dados desatualizados")) return "Base desatualizada";
    if (low.includes("preventiva vencida")) return "Preventiva vencida";
    if (low.includes("o.s aberta")) return "O.S aberta";
    if (low.includes("atraso")) return "GPS atrasado";
    return s.length > 48 ? s.slice(0, 48) + "…" : s;
  }

  function abreviarTexto(s, maxLen) {
    const t = String(s || "").trim();
    if (!t) return "—";
    const n = maxLen || 48;
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  function rotuloEstadoMapa(v) {
    const cat = categoriaEntidade(v);
    const map = {
      disponivel: { label: "Normal (em viagem)", entity: "disponivel" },
      critico: { label: "Quebra (manutenção)", entity: "critico" },
      preventiva_dia: { label: "Preventiva", entity: "preventiva_dia" },
      sem_gps: { label: "Sem GPS", entity: "sem_gps" },
      recolhimento: { label: "Recolhimento", entity: "recolhimento" },
      atencao: { label: "Atenção", entity: "atencao" },
      neutral: { label: "Outros", entity: "neutral" },
    };
    return map[cat] || map.atencao;
  }

  function formatLinhaSentido(v) {
    const linha = String(v.linha ?? "").trim();
    const sentido = String(v.sentido ?? "").trim();
    if (!linha || linha === "0" || linha === "---" || linha === "—") return "Sem linha";
    if (!sentido || sentido === "0" || sentido === "---" || sentido === "—") return linha;
    return `${linha} · ${sentido}`;
  }

  function resumoLiberacaoMecanica(v) {
    const lib = v.liberacao_mecanica;
    const est = lib && String(lib.estado || "").toLowerCase();
    if (est === "liberado") {
      const who = String(lib.usuario || "").trim();
      return who ? `Liberado pela manutenção (${who})` : "Liberado pela manutenção";
    }
    if (est === "retido") {
      const who = String(lib.usuario || "").trim();
      return who ? `Retido pela manutenção (${who})` : "Retido pela manutenção";
    }
    return "Automático (regras do painel)";
  }

  function textoGpsOperacional(sc) {
    if (sc === "SEM_ATUALIZACAO") return "OFFLINE";
    if (sc === "ATRASO_LEVE") return "INSTÁVEL";
    return "ATIVO";
  }

  function linhasHistoricoDrawer(hist, maxRows) {
    const max = maxRows || 8;
    const out = [];
    let prevKey = "";
    for (const h of hist || []) {
      const st = h._status || {};
      const sit = String(st.operacional || "").trim();
      const sol = String(st.soltura || "").trim();
      const key = `${sit}|${sol}`;
      if (key === prevKey) continue;
      prevKey = key;
      const ts =
        h._normalizado?.hora_posicao ?? h[Object.keys(h).find((k) => k.toLowerCase().includes("hora"))];
      out.push({ ts, situacao: abreviarTexto(sit, 48), soltura: sol || "—" });
      if (out.length >= max) break;
    }
    return out;
  }

  function linhaApoioDecisao(v) {
    const sol = String(v.status_soltura || "").trim();
    const acao = String(v.acao_localizacao || "").trim();
    if (acao && acao !== "Aguardar" && sol.toLowerCase() !== acao.toLowerCase()) {
      return `Ação sugerida: ${acao}`;
    }
    return sol || "—";
  }

  function situacaoResumoOperacional(v) {
    const sit = String(v.status_operacional || "").trim();
    if (!sit) return "";
    if (v.em_viagem_linha_identificada && /^Em operação$/i.test(sit)) return "";
    return sit;
  }

  function htmlResumoOperacional(v, gpsTxt) {
    const linhaTxt = formatLinhaSentido(v);
    const sit = situacaoResumoOperacional(v);
    const ultima = fmtDataHoraManaus(v.ultima_atualizacao || v.hora_posicao);
    let rows =
      `<div class="op-console-block__kv"><span class="kv-k">Linha</span><span class="kv-v">${escapeHtml(linhaTxt)}</span></div>`;
    if (sit) {
      rows +=
        `<div class="op-console-block__kv"><span class="kv-k">Situação</span><span class="kv-v kv-v--loud">${escapeHtml(abreviarTexto(sit, 48))}</span></div>`;
    }
    rows +=
      `<div class="op-console-block__kv"><span class="kv-k">GPS</span><span class="kv-v kv-v--loud">${gpsTxt}</span></div>` +
      `<div class="op-console-block__kv"><span class="kv-k">Última posição</span><span class="kv-v kv-v--mono">${escapeHtml(ultima)}</span></div>`;
    return rows;
  }

  function htmlPendenciasContexto(v, osTop) {
    const parts = [];
    if (osTop) parts.push(`O.S. #${fmt(osTop.id)} · ${fmt(osTop.defeito)} · ${fmt(osTop.situacao)}`);
    if (v.ssov_preventiva_hoje) parts.push("Preventiva programada para hoje");
    if (v.ssov_recolhimento_ativo) parts.push("Recolhimento ativo");
    if (!parts.length) {
      return `<p class="op-decis-hint">Sem pendências de manutenção ou recolhimento.</p>`;
    }
    return `<ul class="op-context-pendencias">${parts
      .map((p) => `<li>${escapeHtml(p)}</li>`)
      .join("")}</ul>`;
  }

  function htmlHistoricoDrawer(hist, histErr) {
    let inner;
    if (histErr) {
      inner = `<p class="op-terminal-err op-hist-drawer__err">${escapeHtml(histErr)}</p>`;
    } else {
      const rows = linhasHistoricoDrawer(hist, 8);
      if (!rows.length) {
        inner = `<p class="op-decis-hint">Sem registos recentes.</p>`;
      } else {
        const tbody = rows
          .map(
            (r) =>
              `<tr><td class="op-td-mono">${escapeHtml(fmtDataHoraManaus(r.ts))}</td><td>${escapeHtml(r.situacao)}</td><td>${escapeHtml(r.soltura)}</td></tr>`
          )
          .join("");
        inner = `<div class="table-scroll op-table-wrap op-hist-drawer__scroll"><table class="grid op-table-terminal"><thead><tr><th>Data/hora</th><th>Situação</th><th>Soltura</th></tr></thead><tbody>${tbody}</tbody></table></div>`;
      }
    }
    return `<details class="op-hist-drawer op-terminal__section op-terminal__section--timeline"><summary class="op-hist-drawer__summary">Histórico recente</summary>${inner}</details>`;
  }

  /** Alerta operacional em caixa alta — linguagem de centro de controle. */
  function rotuloAlertaPrincipal(v) {
    const cat = String(v.ssov_categoria || "").toLowerCase();
    const sc = String(v.status_comunicacao || "");
    const prio = String(v.prioridade_localizacao || "").toLowerCase();
    const motivo = String(v.motivo_localizacao || v.motivo_soltura || v.observacao || "").trim();

    if (v.ssov_recolhimento_ativo || cat === "recolhimento") {
      return {
        headline: "RECOLHIMENTO NECESSÁRIO",
        tagline: motivo || "Priorizar deslocamento e decisão de campo.",
        severity: "critical",
        code: "REC",
      };
    }
    if (cat === "sem_gps" || sc === "SEM_ATUALIZACAO") {
      return {
        headline: "GPS OFFLINE",
        tagline: motivo || "Sem rastreio em tempo real para esta unidade.",
        severity: "critical",
        code: "GPS",
      };
    }
    if (cat === "critico" || prio === "alta") {
      return {
        headline: "QUEBRA POR CONTA DA MANUTENÇÃO",
        tagline: motivo || "Priorizar decisão de soltura ou retenção.",
        severity: "critical",
        code: "CRT",
      };
    }
    if (v.ssov_preventiva_hoje || cat === "preventiva_dia") {
      return {
        headline: "PREVENTIVA DO DIA",
        tagline: motivo || "Intervenção programada — verificar chegada e baixa.",
        severity: "info",
        code: "PRV",
      };
    }
    if (cat === "disponivel" && v.em_viagem_linha_identificada) {
      return {
        headline: "EM VIAGEM",
        tagline: motivo || "Em viagem com linha identificada.",
        severity: "ok",
        code: "LIN",
      };
    }
    if (sc === "ATRASO_LEVE" || cat === "atencao") {
      if (sc !== "SEM_ATUALIZACAO" && !v.em_viagem_linha_identificada) {
        return {
          headline: "SEM LINHA",
          tagline: motivo || "GPS ativo — sem serviço de linha no painel.",
          severity: "warn",
          code: "S/L",
        };
      }
      return {
        headline: "ATENÇÃO OPERACIONAL",
        tagline: motivo || "Conferir GPS e contexto antes de liberar.",
        severity: "warn",
        code: "ATN",
      };
    }
    if (cat === "disponivel") {
      return {
        headline: "SITUAÇÃO ESTÁVEL",
        tagline: motivo || "Sem linha identificada — avaliar soltura.",
        severity: "ok",
        code: "OK",
      };
    }
    const op = String(v.status_operacional || "MONITORAR").trim();
    return {
      headline: op.length > 32 ? op.slice(0, 30).toUpperCase() + "…" : op.toUpperCase(),
      tagline: motivo || "Acompanhar evolução no mapa.",
      severity: "neutral",
      code: "OP",
    };
  }

  function badgeAlertaHtml(v) {
    const a = rotuloAlertaPrincipal(v);
    return `<span class="op-alert-chip op-alert-chip--${a.severity}" title="${fmt(a.tagline)}">${a.headline}</span>`;
  }

  function categoriaEntidade(v) {
    const cat = String(v.ssov_categoria || "atencao").toLowerCase();
    if (["recolhimento", "sem_gps", "critico", "preventiva_dia", "atencao", "disponivel"].includes(cat)) return cat;
    return "neutral";
  }

  function situacaoResumida(v) {
    return badgeAlertaHtml(v);
  }

  function ultimaAtual(v) {
    return v.ultima_atualizacao || v.hora_posicao;
  }

  function tzExibicao() {
    return (state.tempoMeta && state.tempoMeta.assume_timezone_naive_mysql) || "America/Manaus";
  }

  function fmtDataHoraManaus(isoOuStr) {
    if (isoOuStr === null || isoOuStr === undefined || isoOuStr === "") return "—";
    const s = String(isoOuStr);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        timeZone: tzExibicao(),
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d);
    } catch {
      return s;
    }
  }

  async function fetchMetaTabela() {
    const mh = el("metaTabelaHealth");
    if (!mh) return;
    try {
      const res = await fetch("/api/meta/ultima_linha_tabela", fetchOpts);
      const d = await res.json();
      if (!d.ok) {
        mh.className = "meta-health meta-health-bad";
        mh.textContent = "Saúde da tabela: " + (d.erro || "indisponível");
        return;
      }
      const ult = d.ultima_data_tabela_iso ? fmtDataHoraManaus(d.ultima_data_tabela_iso) : "—";
      const mins =
        d.minutos_desde_ultimo_evento_global != null
          ? Math.round(d.minutos_desde_ultimo_evento_global)
          : "—";
      let status = "OK";
      let klass = "meta-health meta-health-ok";
      if (typeof mins === "number" && mins >= BASE_HEALTH_CRIT_MIN) {
        status = "Crítico";
        klass = "meta-health meta-health-bad";
      } else if (typeof mins === "number" && mins >= BASE_HEALTH_WARN_MIN) {
        status = "Atenção";
        klass = "meta-health meta-health-warn";
      }
      mh.className = klass;
      mh.textContent = "Saúde da base [" + status + "]: último evento " + ult + " · há ~" + mins + " min";
    } catch {
      mh.className = "meta-health";
      mh.textContent = "";
    }
  }

  function agoraRelogioManaus() {
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        timeZone: tzExibicao(),
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date());
    } catch {
      return new Date().toLocaleTimeString("pt-BR");
    }
  }

  function flagsAtivas(f) {
    if (!f || typeof f !== "object") return [];
    return Object.entries(f)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  }

  function fmtFlags(f) {
    const a = flagsAtivas(f);
    return a.length ? a.join(", ") : "—";
  }

  function badgeClass(soltura) {
    const s = String(soltura || "");
    if (s.includes("Pode liberar")) return "badge badge-ok";
    if (s.includes("Não liberar")) return "badge badge-bad";
    return "badge badge-warn";
  }

  function decisionClass(soltura) {
    const s = String(soltura || "");
    if (s.includes("Não liberar")) return "decision-block decision-block-bad";
    if (s.includes("Pode liberar")) return "decision-block decision-block-ok";
    return "decision-block decision-block-warn";
  }

  function prioridadeClass(v) {
    const p = String(v || "").toLowerCase();
    if (p === "alta") return "badge badge-bad";
    if (p === "media") return "badge badge-warn";
    return "badge badge-ok";
  }

  function prioridadeRowClass(v) {
    const p = String(v || "").toLowerCase();
    if (p === "alta") return "prio-row-alta";
    if (p === "media") return "prio-row-media";
    return "prio-row-baixa";
  }

  function getLocalizacaoFilters() {
    return {
      criticos: !!el("filtroCriticos")?.checked,
      comOs: !!el("filtroComOs")?.checked,
      preventiva: !!el("filtroPreventiva")?.checked,
      semGps: !!el("filtroSemGps")?.checked,
      aguardandoRecolhimento: !!el("filtroAguardandoRecolhimento")?.checked,
      disponiveis: !!el("filtroDisponiveis")?.checked,
    };
  }

  function persistFilters() {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(getLocalizacaoFilters()));
    } catch {}
  }

  function restoreFilters() {
    try {
      const raw = localStorage.getItem(FILTERS_KEY);
      if (!raw) return;
      const f = JSON.parse(raw);
      if (el("filtroCriticos")) el("filtroCriticos").checked = !!f.criticos;
      if (el("filtroComOs")) el("filtroComOs").checked = !!f.comOs;
      if (el("filtroPreventiva")) el("filtroPreventiva").checked = !!f.preventiva;
      if (el("filtroSemGps")) el("filtroSemGps").checked = !!f.semGps;
      if (el("filtroAguardandoRecolhimento")) el("filtroAguardandoRecolhimento").checked = !!f.aguardandoRecolhimento;
      if (el("filtroDisponiveis")) el("filtroDisponiveis").checked = !!f.disponiveis;
    } catch {}
  }

  function getAckSet() {
    try {
      const raw = localStorage.getItem(ACK_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  }

  function setAckSet(s) {
    try {
      localStorage.setItem(ACK_KEY, JSON.stringify([...s]));
    } catch {}
  }

  function getSelSet() {
    try {
      const raw = localStorage.getItem(ACK_SEL_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  }

  function setSelSet(s) {
    try {
      localStorage.setItem(ACK_SEL_KEY, JSON.stringify([...s]));
    } catch {}
  }

  function syncChipsFromFilters() {
    const f = getLocalizacaoFilters();
    const anyFilter =
      f.criticos || f.comOs || f.preventiva || f.semGps || f.aguardandoRecolhimento || f.disponiveis;
    document.querySelectorAll(".chip-filter").forEach((btn) => {
      const k = btn.getAttribute("data-filter");
      btn.classList.remove("chip-active");
      if (k === "todos" && !anyFilter) btn.classList.add("chip-active");
      if (k === "criticos" && f.criticos) btn.classList.add("chip-active");
      if (k === "comOs" && f.comOs) btn.classList.add("chip-active");
      if (k === "preventiva" && f.preventiva) btn.classList.add("chip-active");
      if (k === "semGps" && f.semGps) btn.classList.add("chip-active");
      if (k === "aguardandoRecolhimento" && f.aguardandoRecolhimento) btn.classList.add("chip-active");
      if (k === "disponiveis" && f.disponiveis) btn.classList.add("chip-active");
    });
  }

  function setFilters(partial) {
    if (el("filtroCriticos")) el("filtroCriticos").checked = !!partial.criticos;
    if (el("filtroComOs")) el("filtroComOs").checked = !!partial.comOs;
    if (el("filtroPreventiva")) el("filtroPreventiva").checked = !!partial.preventiva;
    if (el("filtroSemGps")) el("filtroSemGps").checked = !!partial.semGps;
    if (el("filtroAguardandoRecolhimento")) el("filtroAguardandoRecolhimento").checked = !!partial.aguardandoRecolhimento;
    if (el("filtroDisponiveis")) el("filtroDisponiveis").checked = !!partial.disponiveis;
    persistFilters();
    syncChipsFromFilters();
    renderTables(state.veiculos);
    upsertMarkers(filteredVehiclesForMap(), true);
  }

  function clearFilters() {
    setFilters({
      criticos: false,
      comOs: false,
      preventiva: false,
      semGps: false,
      aguardandoRecolhimento: false,
      disponiveis: false,
    });
  }

  function matchesFilterVeiculo(v, filters, texto) {
    if (texto) {
      const hay = (
        String(v.prefixo || "") +
        String(v.linha || "") +
        String(v.status_operacional || "") +
        String(v.status_soltura || "")
      ).toLowerCase();
      if (!hay.includes(texto)) return false;
    }
    const cat = String(v.ssov_categoria || "").toLowerCase();
    const sol = String(v.status_soltura || "");
    const prio = String(v.prioridade_localizacao || "").toLowerCase();
    const hasOs = (v.os_abertas || []).length > 0;
    const prevSit = String(v.preventiva_situacao || "em_dia").toLowerCase();
    const osOpen = hasOs;
    const foraGaragem = v.na_garagem === false;
    const acao = String(v.acao_localizacao || "");

    if (filters.criticos && prio !== "alta") return false;
    if (filters.comOs && !hasOs) return false;
    if (filters.preventiva && prevSit === "em_dia") return false;
    if (filters.semGps && String(v.status_comunicacao || "") !== "SEM_ATUALIZACAO") return false;
    if (filters.disponiveis) {
      if (cat && cat !== "disponivel") return false;
      if (!cat && !sol.includes("Pode liberar")) return false;
    }
    if (filters.aguardandoRecolhimento) {
      const rec = cat === "recolhimento";
      const legacy = osOpen && (prio === "alta" || prio === "media") && foraGaragem && (acao === "Recolher" || acao === "Localizar");
      if (!rec && !legacy) return false;
    }
    return true;
  }

  function filteredVehiclesForMap() {
    const texto = (el("filtroPrefixo")?.value || "").trim().toLowerCase();
    const filters = getLocalizacaoFilters();
    return state.veiculos.filter((v) => matchesFilterVeiculo(v, filters, texto));
  }

  function updateFiltersStatus(filters) {
    const node = el("filtrosAtivosLocalizacao");
    if (!node) return;
    const labels = [];
    if (filters.criticos) labels.push("Quebras");
    if (filters.comOs) labels.push("Com O.S.");
    if (filters.preventiva) labels.push("Preventiva");
    if (filters.semGps) labels.push("Sem GPS");
    if (filters.aguardandoRecolhimento) labels.push("Recolhimento");
    if (filters.disponiveis) labels.push("Disponíveis");
    const text = labels.length ? "Filtros ativos: " + labels.join(", ") : "Sem filtros ativos";
    if (state._filtersStatusText === text) return;
    state._filtersStatusText = text;
    node.textContent = text;
  }

  function initMap() {
    state.map = L.map("map", { preferCanvas: true }).setView([-3.119, -60.021], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(state.map);

    if (typeof L.markerClusterGroup === "function") {
      state.layer = L.markerClusterGroup({
        maxClusterRadius: 56,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        chunkedLoading: true,
        disableClusteringAtZoom: 17,
        animate: false,
        iconCreateFunction(cluster) {
          const n = cluster.getChildCount();
          const mass = n >= 14;
          return L.divIcon({
            html: `<div class="op-cluster${mass ? " op-cluster--mass" : ""}"><span class="op-cluster__count">${n}</span><span class="op-cluster__lbl">un.</span></div>`,
            className: "op-cluster-outer",
            iconSize: L.point(48, 48),
          });
        },
      });
    } else {
      state.layer = L.layerGroup();
    }
    state.layer.addTo(state.map);
  }

  function clearMarkers() {
    if (state.layer) {
      state.layer.clearLayers();
    }
    state.markers = {};
  }

  function isDrawerOpen() {
    const d = el("vehicleDrawer");
    return !!(d && !d.classList.contains("drawer--closed"));
  }

  /**
   * Atualiza marcadores sem limpar o cluster inteiro a cada tick.
   * @param {boolean|string} refitMap - false: não mexer na vista; true: fitBounds; "first": só se ainda não houve encaixe inicial
   */
  function upsertMarkers(list, refitMap) {
    if (!state.map || !state.layer) return;
    const bounds = [];
    const seen = new Set();
    const wantRefit =
      refitMap === true || (refitMap === "first" && !state.mapInitialFitDone);

    function makeIcon(cat) {
      return L.divIcon({
        className: "op-entity-anchor",
        html: `<div class="op-entity op-entity--${cat}"><span class="op-entity__core"></span></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });
    }

    for (const v of list) {
      const lat = parseFloat(v.latitude);
      const lon = parseFloat(v.longitude);
      if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
      const pfx = prefixoRowKey(v);
      if (!pfx) continue;
      seen.add(pfx);
      const cat = categoriaEntidade(v);
      const icon = makeIcon(cat);
      const alerta = rotuloAlertaPrincipal(v);
      const popupHtml =
        `<div class="op-popup"><strong class="op-popup__pfx">${fmt(v.prefixo)}</strong>` +
        `<div class="op-popup__alert op-popup__alert--${alerta.severity}">${alerta.headline}</div>` +
        `<div class="op-popup__time">${fmtDataHoraManaus(ultimaAtual(v))}</div></div>`;

      let m = state.markers[pfx];
      if (m) {
        const ll = m.getLatLng();
        if (Math.abs(ll.lat - lat) > 1e-6 || Math.abs(ll.lng - lon) > 1e-6) {
          m.setLatLng([lat, lon]);
        }
        if (m._ssovCat !== cat) {
          m.setIcon(icon);
          m._ssovCat = cat;
        }
        if (m._ssovPopupHtml !== popupHtml) {
          m.bindPopup(popupHtml, { className: "op-popup-leaflet", maxWidth: 280 });
          m._ssovPopupHtml = popupHtml;
        }
      } else {
        m = L.marker([lat, lon], { icon });
        m.bindPopup(popupHtml, { className: "op-popup-leaflet", maxWidth: 280 });
        m.on("click", () => selectVehicle(pfx));
        m._ssovCat = cat;
        m._ssovPopupHtml = popupHtml;
        m.addTo(state.layer);
        state.markers[pfx] = m;
      }
      bounds.push([lat, lon]);
    }

    for (const id of Object.keys(state.markers)) {
      if (!seen.has(id)) {
        const old = state.markers[id];
        if (old && state.layer) state.layer.removeLayer(old);
        delete state.markers[id];
      }
    }

    if (bounds.length && wantRefit) {
      state.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
      state.mapInitialFitDone = true;
    }
  }

  function renderKpis() {
    const kp = el("kpis");
    if (!kp) return;
    const k = state.kpis || {};
    kp.innerHTML = [
      kpiOperacional("Frota total", state.veiculos.length, "Na base", "kpi-total"),
      kpiOperacional("O.S abertas", k.os_abertas || 0, "Ordens", "kpi-os"),
      kpiOperacional("Preventivas vencidas", k.preventivas_vencidas || 0, "Ação", "kpi-prev-venc"),
      kpiOperacional("Quebras", k.criticos || 0, "Prioridade alta", "kpi-crit", "Quebras"),
      kpiOperacional("Sem GPS", k.sem_gps || 0, "Comunicação", "kpi-sem-gps"),
    ].join("");
    const kx = el("kpisExtra");
    if (kx) {
      kx.innerHTML = [
        kpiOperacional("Recolhimento", k.aguardando_recolhimento || 0, "Campo + O.S", "kpi-recolher"),
        kpiOperacional("Preventiva próxima", k.preventivas_proximas || 0, "Janela", "kpi-prev-prox"),
        kpiOperacional("Garagem pendência", k.garagem_com_pendencia || 0, "Oficina", "kpi-gar-pend"),
      ].join("");
    }
    wireKpiActions();
  }

  function kpiOperacional(label, val, subtitle, klass, titleAttr) {
    const titlePart = titleAttr ? ` title="${escapeHtml(String(titleAttr))}"` : "";
    return `<button type="button" class="kpi ${klass}" data-kpi="${klass}"${titlePart}><span>${escapeHtml(String(label))}</span><strong>${escapeHtml(String(val))}</strong><small>${escapeHtml(String(subtitle))}</small></button>`;
  }

  function wireKpiActions() {
    const map = {
      "kpi-total": () => {
        clearFilters();
        setModule("mapa");
      },
      "kpi-os": () => setFilters({ comOs: true }),
      "kpi-prev-venc": () => setFilters({ preventiva: true }),
      "kpi-crit": () => setFilters({ criticos: true }),
      "kpi-sem-gps": () => setFilters({ semGps: true }),
      "kpi-recolher": () => setFilters({ aguardandoRecolhimento: true }),
      "kpi-prev-prox": () => setFilters({ preventiva: true }),
      "kpi-gar-pend": () => setFilters({ comOs: true, preventiva: true }),
    };
    document.querySelectorAll(".kpi[data-kpi]").forEach((node) => {
      node.addEventListener("click", () => {
        const fn = map[node.getAttribute("data-kpi") || ""];
        if (fn) {
          fn();
          setModule("mapa");
        }
      });
    });
  }

  /** Chave estável do prefixo = atributo `data-pfx` na linha (evita falha no patch fmt vs raw). */
  function prefixoRowKey(v) {
    return String(v.prefixo != null ? v.prefixo : "").trim();
  }

  /** Estrutura = conjunto de prefixos + ciente + filtros; demais campos vão no patch. */
  function criticosTableSignature(locRows, filters, filtro, ackSet, selSet) {
    const sorted = [...locRows].sort((a, b) => prefixoRowKey(a).localeCompare(prefixoRowKey(b)));
    const rowPart = sorted
      .map((v) => {
        const pfx = prefixoRowKey(v);
        return pfx + (ackSet.has(pfx) ? "*" : "");
      })
      .join(",");
    const fk = JSON.stringify(filters) + "|" + filtro + "|" + [...selSet].sort().join(",");
    return rowPart + "||" + fk;
  }

  /** Um repaint por frame ao entrar em Críticos ou ao concluir poll. */
  function scheduleCriticosTableRender(needForce) {
    if (needForce) state._criticosRenderForce = true;
    if (state._criticosRenderRaf) return;
    state._criticosRenderRaf = requestAnimationFrame(() => {
      state._criticosRenderRaf = 0;
      const force = !!state._criticosRenderForce;
      state._criticosRenderForce = false;
      renderTables(state.veiculos, force ? { force: true } : undefined);
    });
  }

  /** Atualiza só células que mudam entre polls sem alterar a assinatura (idade GPS, chip de alerta). */
  function patchCriticosTableLiveCells(tbLb, locRows) {
    let changes = 0;
    const byPfx = new Map(
      locRows.map((v) => {
        const pfx = prefixoRowKey(v);
        const alert = rotuloAlertaPrincipal(v);
        return [
          pfx,
          {
            mins: v.minutos_sem_atualizacao != null ? String(Math.round(Number(v.minutos_sem_atualizacao))) : "—",
            alertHtml: situacaoResumida(v),
            alertHeadline: alert.headline,
            alertSeverity: alert.severity,
            alertTagline: fmt(alert.tagline),
            motivoTitle: fmt(v.motivo_localizacao),
            motivoText: shortMotivo(v.motivo_localizacao),
            prioClass: prioridadeClass(v.prioridade_localizacao),
            prioText: fmt(v.prioridade_localizacao),
            solturaClass: decisionClass(v.status_soltura),
            solturaText: fmt(v.status_soltura),
          },
        ];
      })
    );
    tbLb.querySelectorAll("tr[data-pfx]").forEach((tr) => {
      const pfx = String(tr.getAttribute("data-pfx") || "").trim();
      const row = byPfx.get(pfx);
      if (!row) return;
      const tds = tr.querySelectorAll("td");
      if (tds.length < 6) return;
      const tdPrio = tds[1];
      const tdMotivo = tds[3];
      const tdAlerta = tds[4];
      const tdMins = tds[5];
      const tdDec = tds[6];
      const prioSpan = tdPrio && tdPrio.querySelector("span");
      if (prioSpan) {
        if (prioSpan.className !== row.prioClass) {
          prioSpan.className = row.prioClass;
          changes += 1;
        }
        if (prioSpan.textContent !== row.prioText) {
          prioSpan.textContent = row.prioText;
          changes += 1;
        }
      }
      if (tdMins.textContent !== row.mins) {
        tdMins.textContent = row.mins;
        changes += 1;
      }
      const prevTitle = tdMotivo.getAttribute("title") || "";
      if (prevTitle !== row.motivoTitle) {
        tdMotivo.setAttribute("title", row.motivoTitle);
        changes += 1;
      }
      if (tdMotivo.textContent !== row.motivoText) {
        tdMotivo.textContent = row.motivoText;
        changes += 1;
      }
      const chip = tdAlerta.querySelector(".op-alert-chip");
      if (chip) {
        const cls = "op-alert-chip op-alert-chip--" + row.alertSeverity;
        if (chip.className !== cls) {
          chip.className = cls;
          changes += 1;
        }
        if (chip.textContent !== row.alertHeadline) {
          chip.textContent = row.alertHeadline;
          changes += 1;
        }
        if (chip.getAttribute("title") !== row.alertTagline) {
          chip.setAttribute("title", row.alertTagline);
          changes += 1;
        }
      } else if (tdAlerta.innerHTML !== row.alertHtml) {
        tdAlerta.innerHTML = row.alertHtml;
        changes += 1;
      }
      const decSpan = tdDec && tdDec.querySelector("span");
      if (decSpan) {
        if (decSpan.className !== row.solturaClass) {
          decSpan.className = row.solturaClass;
          changes += 1;
        }
        if (decSpan.textContent !== row.solturaText) {
          decSpan.textContent = row.solturaText;
          changes += 1;
        }
      }
    });
    return changes;
  }

  function wireCriticosTable() {
    const tbL = el("tblLocalizacao");
    if (!tbL || tbL.dataset.wiredCriticos === "1") return;
    tbL.dataset.wiredCriticos = "1";
    tbL.addEventListener("click", (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest(".chk-row-localizacao")) return;
      const btn = ev.target && ev.target.closest ? ev.target.closest(".btn-link-map") : null;
      if (btn) {
        ev.stopPropagation();
        focusOnMap(btn.getAttribute("data-pfx"));
        return;
      }
      const tr = ev.target && ev.target.closest ? ev.target.closest("tr[data-pfx]") : null;
      if (tr) selectVehicle(tr.getAttribute("data-pfx"));
    });
    tbL.addEventListener("change", (ev) => {
      const chk = ev.target && ev.target.closest ? ev.target.closest(".chk-row-localizacao") : null;
      if (!chk) return;
      const s = getSelSet();
      const pfx = chk.getAttribute("data-pfx");
      if (chk.checked) s.add(String(pfx));
      else s.delete(String(pfx));
      setSelSet(s);
      state.criticosTableSig = null;
    });
  }

  function renderTables(list, opts) {
    const force = !!(opts && opts.force);
    if (state.currentModule !== "criticos" && !force) return;

    const filtro = (el("filtroPrefixo")?.value || "").trim().toLowerCase();
    const filters = getLocalizacaoFilters();
    const rows = list.filter((v) =>
      filtro ? String(v.prefixo || "").toLowerCase().includes(filtro) : true
    );
    let locSource = state.localizacao.filter((v) =>
      filtro ? String(v.prefixo || "").toLowerCase().includes(filtro) : true
    );
    if (state.currentModule === "criticos") {
      locSource = locSource.filter((v) => String(v.prioridade_localizacao || "").toLowerCase() === "alta");
    }
    const locRows = locSource
      .filter((v) => (!filters.criticos ? true : String(v.prioridade_localizacao || "").toLowerCase() === "alta"))
      .filter((v) => (!filters.comOs ? true : (v.os_abertas || []).length > 0))
      .filter((v) => (!filters.preventiva ? true : String(v.preventiva_situacao || "") !== "em_dia"))
      .filter((v) => (!filters.semGps ? true : String(v.status_comunicacao || "") === "SEM_ATUALIZACAO"))
      .filter((v) => {
        if (!filters.aguardandoRecolhimento) return true;
        const cat = String(v.ssov_categoria || "").toLowerCase();
        if (cat === "recolhimento") return true;
        const osOpen = (v.os_abertas || []).length > 0;
        const prio = String(v.prioridade_localizacao || "").toLowerCase();
        const foraGaragem = v.na_garagem === false;
        const acao = String(v.acao_localizacao || "");
        return osOpen && (prio === "alta" || prio === "media") && foraGaragem && (acao === "Recolher" || acao === "Localizar");
      })
      .filter((v) => {
        if (!filters.disponiveis) return true;
        const cat = String(v.ssov_categoria || "").toLowerCase();
        if (cat) return cat === "disponivel";
        return String(v.status_soltura || "").includes("Pode liberar");
      });
    updateFiltersStatus(filters);

    const tbL = el("tblLocalizacao");
    if (tbL) {
      const tbLb = tbL.querySelector("tbody");
      const ackSet = getAckSet();
      const selSet = getSelSet();
      const rowCount = tbLb.querySelectorAll("tr[data-pfx]").length;
      if (!force) {
        const nextSig = criticosTableSignature(locRows, filters, filtro, ackSet, selSet);
        if (nextSig === state.criticosTableSig && rowCount === locRows.length) {
          if (locRows.length === 0 && rowCount === 0) {
            const chkAllEmpty = el("chkSelecionarTodosLocalizacao");
            if (chkAllEmpty) chkAllEmpty.checked = false;
            return;
          }
          const changed = patchCriticosTableLiveCells(tbLb, locRows);
          const chkAll = el("chkSelecionarTodosLocalizacao");
          if (chkAll) {
            chkAll.checked = locRows.length > 0 && locRows.every((v) => selSet.has(prefixoRowKey(v)));
          }
          if (!changed) return;
          // #region agent log
          fetch("http://127.0.0.1:7755/ingest/4511f7d6-1495-403a-84fa-42dc2268828b", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "22aab0" },
            body: JSON.stringify({
              sessionId: "22aab0",
              runId: "criticos-v4",
              hypothesisId: "H-prefix",
              location: "dashboard.js:renderTables:patch",
              message: "criticos tbody patch only",
              data: { rows: locRows.length, changed },
              timestamp: Date.now(),
            }),
          }).catch(() => {});
          // #endregion
          return;
        }
        state.criticosTableSig = nextSig;
      } else {
        state.criticosTableSig = criticosTableSignature(locRows, filters, filtro, ackSet, selSet);
      }
      tbLb.innerHTML = locRows
        .map((v) => {
          const pfxKey = prefixoRowKey(v);
          const pfx = escapeHtml(pfxKey);
          const checked = selSet.has(pfxKey) ? "checked" : "";
          const ciente = ackSet.has(pfxKey) ? "row-ciente" : "";
          return `
      <tr data-pfx="${pfx}" class="${prioridadeRowClass(v.prioridade_localizacao)} ${ciente}">
        <td><input type="checkbox" class="chk-row-localizacao" data-pfx="${pfx}" ${checked} /></td>
        <td><span class="${prioridadeClass(v.prioridade_localizacao)}">${fmt(v.prioridade_localizacao)}</span></td>
        <td>${pfx}</td>
        <td class="cell-motivo" title="${fmt(v.motivo_localizacao)}">${shortMotivo(v.motivo_localizacao)}</td>
        <td>${situacaoResumida(v)}</td>
        <td>${v.minutos_sem_atualizacao != null ? Math.round(v.minutos_sem_atualizacao) : "—"}</td>
        <td>
          <span class="${decisionClass(v.status_soltura)}">${fmt(v.status_soltura)}</span><br/>
          <button type="button" class="btn-link-map" data-pfx="${pfx}">Abrir no mapa</button>
        </td>
      </tr>`;
        })
        .join("");
      // #region agent log
      fetch("http://127.0.0.1:7755/ingest/4511f7d6-1495-403a-84fa-42dc2268828b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "22aab0" },
        body: JSON.stringify({
          sessionId: "22aab0",
          runId: "criticos-v4",
          hypothesisId: "H-prefix",
          location: "dashboard.js:renderTables:rebuild",
          message: "criticos tbody innerHTML rebuild",
          data: { rows: locRows.length, force, rowCountBefore: rowCount },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      const chkAll = el("chkSelecionarTodosLocalizacao");
      if (chkAll) {
        chkAll.checked = locRows.length > 0 && locRows.every((v) => selSet.has(prefixoRowKey(v)));
      }
    }
  }

  function openDrawer() {
    const d = el("vehicleDrawer");
    const b = el("drawerBackdrop");
    if (d) {
      d.classList.remove("drawer--closed");
      d.setAttribute("aria-hidden", "false");
    }
    if (b) b.classList.remove("drawer-backdrop--hidden");
  }

  function closeDrawer() {
    const d = el("vehicleDrawer");
    const b = el("drawerBackdrop");
    if (d) {
      d.classList.add("drawer--closed");
      d.setAttribute("aria-hidden", "true");
    }
    if (b) b.classList.add("drawer-backdrop--hidden");
  }

  function focusOnMap(prefixo) {
    setModule("mapa");
    setTimeout(() => {
      const mk = state.markers[prefixo];
      if (mk && state.map) {
        state.map.setView(mk.getLatLng(), Math.max(state.map.getZoom(), 14));
        mk.openPopup();
      }
      selectVehicle(prefixo);
    }, 80);
  }

  /** Carrega dados específicos do módulo (URL/hash, refresh, menu). */
  function onModuleEnter(name) {
    if (name === "preventivas") {
      loadPreventivasTable();
    } else if (name === "recolhimento") {
      loadRecolhimentosTable();
    } else if (name === "criticos") {
      loadQuebrasTable();
    } else if (name === "historico" && state.selected) {
      loadHistoricoModule(state.selected);
    }
  }

  function setModule(name) {
    const prev = state.currentModule;
    const sameModule = prev === name;
    state.currentModule = name;
    try {
      localStorage.setItem(MODULE_KEY, name);
    } catch {}
    if (location.hash.replace("#", "") !== name) {
      history.replaceState(null, "", "#" + name);
    }
    document.querySelectorAll(".module-view").forEach((sec) => {
      const m = sec.getAttribute("data-module");
      sec.classList.toggle("module-view--active", m === name);
      sec.classList.toggle("module-view--hidden", m !== name);
    });
    document.querySelectorAll(".nav-item").forEach((a) => {
      a.classList.toggle("active", a.getAttribute("data-module") === name);
    });
    setTimeout(() => {
      if (state.map) state.map.invalidateSize();
    }, 200);
    if (name === "criticos" && !sameModule) {
      state.criticosTableSig = null;
      scheduleCriticosTableRender(true);
    }
    if (name === "mapa" && !sameModule) {
      upsertMarkers(filteredVehiclesForMap(), false);
    }
    if (name === "operacao" && !sameModule) {
      renderKpis();
    }
    if (!sameModule) {
      onModuleEnter(name);
    }
  }

  function restoreModule() {
    let m = "mapa";
    try {
      const h = (location.hash || "").replace("#", "").trim();
      if (h) m = h;
      else {
        const s = localStorage.getItem(MODULE_KEY);
        if (s) m = s;
      }
    } catch {}
    setModule(m);
  }

  const quebraCombos = {};

  function normComboText(value) {
    return String(value || "").trim();
  }

  function uniqComboSorted(values) {
    return [...new Set(values.map(normComboText).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }

  function snapshotQuebraComboData() {
    const prefixoMap = new Map();
    const linhas = [];
    const motoristas = [];
    for (const v of state.veiculos || []) {
      const pfx = normComboText(v.prefixo);
      if (pfx) prefixoMap.set(pfx, v);
      const linha = normComboText(v.linha);
      if (linha) linhas.push(linha);
      const motorista = normComboText(v.motorista);
      if (motorista) motoristas.push(motorista);
    }
    return {
      prefixoMap,
      prefixos: uniqComboSorted([...prefixoMap.keys()]),
      linhas: uniqComboSorted(linhas),
      motoristas: uniqComboSorted(motoristas),
    };
  }

  function refreshQuebraComboOptions() {
    const snap = snapshotQuebraComboData();
    const motivos = state.quebraMotivos || [];
    const sig =
      snap.prefixos.join("\u0001") +
      "|" +
      snap.linhas.join("\u0001") +
      "|" +
      snap.motoristas.join("\u0001") +
      "|" +
      motivos.join("\u0001");
    if (state._quebraComboSig === sig) return;
    state._quebraComboSig = sig;
    state.quebraPrefixoMap = snap.prefixoMap;
    quebraCombos.prefixo?.setOptions(snap.prefixos);
    quebraCombos.linha?.setOptions(snap.linhas);
    quebraCombos.motorista?.setOptions(snap.motoristas);
    quebraCombos.motivo?.setOptions(motivos);
    quebraCombos.relPrefixo?.setOptions(snap.prefixos);
    quebraCombos.relMotivo?.setOptions(motivos);
  }

  async function loadQuebraMotivoCatalog() {
    try {
      const r = await fetch("/api/quebras", fetchOpts);
      const d = await r.json();
      state.quebraMotivos = uniqComboSorted((d.itens || []).map((it) => it.motivo));
      refreshQuebraComboOptions();
    } catch {
      /* mantém catálogo anterior */
    }
  }

  function resetQuebraDialogCombos() {
    ["prefixo", "linha", "motorista", "motivo"].forEach((key) => quebraCombos[key]?.reset());
  }

  function resetQuebraRelatorioCombos() {
    quebraCombos.relPrefixo?.reset();
    quebraCombos.relMotivo?.reset();
  }

  function closeModuleDialog(dlgId) {
    const dlg = el(dlgId);
    if (dlg && typeof dlg.close === "function") dlg.close();
  }

  function wireModuleDialog(dlgId, closeButtonIds) {
    const dlg = el(dlgId);
    if (!dlg) return;
    (closeButtonIds || []).forEach((id) => {
      el(id)?.addEventListener("click", () => closeModuleDialog(dlgId));
    });
    dlg.addEventListener("click", (ev) => {
      if (ev.target === dlg) closeModuleDialog(dlgId);
    });
  }

  function autofillQuebraFromPrefixo(pfx) {
    const v = state.quebraPrefixoMap?.get(normComboText(pfx));
    if (!v) return;
    const linha = normComboText(v.linha);
    const motorista = normComboText(v.motorista);
    if (linha) quebraCombos.linha?.commit(linha);
    if (motorista) quebraCombos.motorista?.commit(motorista);
  }

  function wireComboBox(container, opts) {
    const search = container.querySelector(".op-combo__search");
    const value = container.querySelector(".op-combo__value");
    const list = container.querySelector(".op-combo__list");
    if (!search || !value || !list) return null;
    const allowCustom = !!opts?.allowCustom;
    let options = Array.isArray(opts?.options) ? opts.options.slice() : [];
    let activeIdx = -1;

    function filteredOptions() {
      const q = normComboText(search.value).toLowerCase();
      const base = options.slice();
      const out = q ? base.filter((item) => item.toLowerCase().includes(q)) : base;
      return out.slice(0, 40);
    }

    function renderList() {
      const items = filteredOptions();
      if (!items.length) {
        list.hidden = true;
        list.innerHTML = "";
        activeIdx = -1;
        return;
      }
      if (activeIdx >= items.length) activeIdx = items.length - 1;
      list.innerHTML = items
        .map(
          (item, idx) =>
            `<li class="op-combo__item${idx === activeIdx ? " op-combo__item--active" : ""}" role="option" data-value="${escapeHtml(item)}">${escapeHtml(item)}</li>`
        )
        .join("");
      list.hidden = false;
    }

    function commit(nextValue) {
      const picked = normComboText(nextValue);
      if (!picked) return;
      value.value = picked;
      search.value = picked;
      list.hidden = true;
      activeIdx = -1;
      opts?.onCommit?.(picked);
    }

    function reset() {
      value.value = "";
      search.value = "";
      list.hidden = true;
      activeIdx = -1;
    }

    function setOptions(next) {
      options = Array.isArray(next) ? next.slice() : [];
    }

    search.addEventListener("input", () => {
      value.value = "";
      activeIdx = -1;
      renderList();
    });

    search.addEventListener("focus", () => {
      activeIdx = -1;
      renderList();
    });

    search.addEventListener("keydown", (ev) => {
      const items = filteredOptions();
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (!items.length) return;
        activeIdx = activeIdx < 0 ? 0 : Math.min(activeIdx + 1, items.length - 1);
        renderList();
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (!items.length) return;
        activeIdx = activeIdx < 0 ? items.length - 1 : Math.max(activeIdx - 1, 0);
        renderList();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) {
          commit(items[activeIdx]);
          return;
        }
        const typed = normComboText(search.value);
        const exact = items.find((item) => item.toLowerCase() === typed.toLowerCase());
        if (exact) {
          commit(exact);
          return;
        }
        if (allowCustom && typed) {
          commit(typed);
          return;
        }
        if (items[0]) commit(items[0]);
        return;
      }
      if (ev.key === "Escape") {
        list.hidden = true;
        activeIdx = -1;
      }
    });

    list.addEventListener("mousedown", (ev) => {
      const item = ev.target.closest(".op-combo__item");
      if (!item) return;
      ev.preventDefault();
      commit(item.getAttribute("data-value"));
    });

    search.addEventListener("blur", () => {
      window.setTimeout(() => {
        list.hidden = true;
        activeIdx = -1;
        if (!value.value) search.value = "";
      }, 120);
    });

    return { setOptions, reset, commit };
  }

  function wireQuebraCombos() {
    const dlg = el("dlgQuebra");
    if (!dlg) return;
    quebraCombos.prefixo = wireComboBox(dlg.querySelector('[data-combo-kind="prefixo"]'), {
      allowCustom: false,
      onCommit: autofillQuebraFromPrefixo,
    });
    quebraCombos.linha = wireComboBox(dlg.querySelector('[data-combo-kind="linha"]'), { allowCustom: true });
    quebraCombos.motorista = wireComboBox(dlg.querySelector('[data-combo-kind="motorista"]'), { allowCustom: true });
    quebraCombos.motivo = wireComboBox(dlg.querySelector('[data-combo-kind="motivo"]'), { allowCustom: true });
    const relDlg = el("dlgQuebrasRelatorio");
    if (relDlg) {
      quebraCombos.relPrefixo = wireComboBox(relDlg.querySelector('[data-combo-kind="rel-prefixo"]'), { allowCustom: false });
      quebraCombos.relMotivo = wireComboBox(relDlg.querySelector('[data-combo-kind="rel-motivo"]'), { allowCustom: true });
    }
    refreshQuebraComboOptions();
  }

  function applyAuthPolicy(payload) {
    if (payload && typeof payload.acesso_livre === "boolean") state.acessoLivre = payload.acesso_livre;
  }

  function canWriteOperacional() {
    if (state.acessoLivre) return true;
    const p = String(state.authUser && state.authUser.perfil ? state.authUser.perfil : "").toLowerCase();
    return state.authUser && (p === "admin" || p === "operador");
  }

  function authWriteBlockReason() {
    if (state.acessoLivre) return null;
    if (!state.authUser) return "login";
    const p = String(state.authUser.perfil || "").toLowerCase();
    if (p !== "admin" && p !== "operador") return "perfil";
    return null;
  }

  async function submitOperadorLogin(login, senha) {
    const j = await apiPost("/api/auth/login", { login, senha });
    if (!j.ok) return j;
    await fetchAuthMe();
    return j;
  }

  function closeDlgQuebra() {
    closeModuleDialog("dlgQuebra");
  }

  function openDlgQuebrasRelatorioGeral() {
    const dlg = el("dlgQuebrasRelatorioGeral");
    if (dlg && typeof dlg.showModal === "function") dlg.showModal();
  }

  function openDlgExportLocalizacao() {
    const dlg = el("dlgExportLocalizacao");
    if (dlg && typeof dlg.showModal === "function") dlg.showModal();
  }

  function openDlgExportFrota() {
    const dlg = el("dlgExportFrota");
    if (dlg && typeof dlg.showModal === "function") dlg.showModal();
  }

  async function openDlgQuebrasRelatorio() {
    const dlg = el("dlgQuebrasRelatorio");
    const form = el("formQuebrasRelatorio");
    if (!dlg || !form || typeof dlg.showModal !== "function") return;
    await loadQuebraMotivoCatalog();
    refreshQuebraComboOptions();
    form.reset();
    resetQuebraRelatorioCombos();
    dlg.showModal();
    form.querySelector('[data-combo-kind="rel-prefixo"] .op-combo__search')?.focus();
  }

  async function openDlgQuebra() {
    const dlg = el("dlgQuebra");
    const form = el("formQuebra");
    if (!dlg || typeof dlg.showModal !== "function") return;
    await fetchAuthMe();
    syncQuebrasWriteAccess();
    await loadQuebraMotivoCatalog();
    refreshQuebraComboOptions();
    form?.reset();
    resetQuebraDialogCombos();
    dlg.showModal();
    const first = form?.querySelector('[data-combo-kind="prefixo"] .op-combo__search');
    if (first) first.focus();
  }

  function syncQuebrasWriteAccess() {
    const canW = canWriteOperacional();
    const block = authWriteBlockReason();
    const btn = el("btnAbrirDlgQuebra");
    if (btn) {
      btn.disabled = false;
      btn.title = canW ? "" : "Abre o formulário; a confirmação exige sessão de operador ou admin.";
    }
    const submit = el("btnLancarQuebra");
    if (submit) {
      submit.disabled = !canW;
      submit.title = canW
        ? ""
        : block === "perfil"
          ? "O perfil atual não pode lançar quebra. Use operador ou admin."
          : "Inicie sessão para confirmar o lançamento.";
    }
    const authBox = el("dlgQuebraAuth");
    if (authBox) authBox.hidden = !!canW;
    const hint = el("dlgQuebraAuthHint");
    if (hint) {
      hint.textContent =
        block === "perfil"
          ? "O perfil atual não pode confirmar lançamentos. Use operador ou admin."
          : "Inicie sessão com perfil operador ou admin para confirmar o lançamento.";
    }
    const authFields = authBox?.querySelector(".op-quebra-dialog__auth-fields");
    if (authFields) authFields.hidden = block === "perfil";
    const authStatus = el("dlgQuebraAuthStatus");
    if (authStatus && canW) authStatus.textContent = "";
  }

  function readReportFormatFromForm(form) {
    if (!form) return "csv";
    const picked = form.querySelector('input[name="formato"]:checked');
    const value = picked ? String(picked.value || "").trim().toLowerCase() : "csv";
    if (value === "xlsx" || value === "pdf") return value;
    return "csv";
  }

  function openReportExport(reportId, query) {
    const q = Object.assign({}, query || {});
    const formato = q.formato || "csv";
    delete q.formato;
    const qs = new URLSearchParams();
    Object.keys(q).forEach((key) => {
      const value = q[key];
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        qs.set(key, String(value).trim());
      }
    });
    qs.set("formato", formato);
    const url = "/api/export/" + encodeURIComponent(reportId) + "?" + qs.toString();
    window.open(url, "_blank");
  }

  function openQuebrasExport(query, formato) {
    const q = Object.assign({}, query || {});
    if (formato) q.formato = formato;
    openReportExport("quebras", q);
  }

  async function fetchAuthMe() {
    try {
      const r = await fetch("/api/auth/me", fetchOpts);
      const d = await r.json();
      applyAuthPolicy(d);
      if (d.ok && d.autenticado && d.usuario) {
        state.authUser = d.usuario;
        const tu = el("topUsuario");
        if (tu) tu.textContent = "Usuário: " + fmt(d.usuario.nome || d.usuario.login);
        const loginStatus = el("loginStatus");
        if (loginStatus) loginStatus.textContent = "Sessão: " + fmt(d.usuario.perfil);
        const btnS = el("btnSair");
        if (btnS) btnS.disabled = false;
      } else {
        state.authUser = null;
        const tu = el("topUsuario");
        if (tu) tu.textContent = "Usuário: —";
        const btnS = el("btnSair");
        if (btnS) btnS.disabled = true;
      }
    } catch {
      state.authUser = null;
    }
    syncQuebrasWriteAccess();
  }

  async function fetchFrota(options) {
    const opts = options || {};
    const userRefresh = !!opts.userRefresh;
    if (state._frotaFetchInFlight) {
      if (userRefresh) state._frotaFetchPendingRefresh = true;
      // #region agent log
      fetch("http://127.0.0.1:7755/ingest/4511f7d6-1495-403a-84fa-42dc2268828b", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "22aab0" },
        body: JSON.stringify({
          sessionId: "22aab0",
          runId: "post-fix-v5",
          hypothesisId: "H-overlap",
          location: "dashboard.js:fetchFrota:skipInflight",
          message: "fetchFrota skipped while in flight",
          data: { userRefresh, pendingRefresh: !!state._frotaFetchPendingRefresh },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      return;
    }
    state._frotaFetchInFlight = true;
    try {
    let data;
    let locData;
    let resFrotaOk = false;
    let resLocOk = false;
    try {
      const [resFrota, resLoc] = await Promise.all([
        fetch("/api/frota", fetchOpts),
        fetch("/api/localizacao", fetchOpts),
      ]);
      resFrotaOk = resFrota.ok;
      resLocOk = resLoc.ok;
      try {
        data = await resFrota.json();
        locData = await resLoc.json();
      } catch {
        throw new Error("Resposta inválida (servidor não é o Flask deste projeto?)");
      }
      if (!resFrota.ok && data && typeof data.ok === "undefined") {
        throw new Error("HTTP " + resFrota.status);
      }
    } catch (e) {
      state.veiculos = [];
      state.localizacao = [];
      state.sondaMeta = null;
      state.tempoMeta = { assume_timezone_naive_mysql: "America/Manaus" };
      state.kpis = {};
      renderKpis();
      renderTables([]);
      clearMarkers();
      state.mapInitialFitDone = false;
      state.criticosTableSig = null;
      state.lastSyncAt = null;
      const sync =
        "Sem conexão com o servidor. Rode python app.py — " + (e.message || "");
      const us = el("ultimaSyncConfig");
      if (us) us.textContent = sync;
      const tu = el("topUltimaAtualizacao");
      if (tu) tu.textContent = "Última atualização: —";
      const ta = el("topApiStatus");
      if (ta) ta.textContent = "API: Offline";
      renderLiveOperationalBar();
      refreshOperationalMode();
      return;
    }

    state.veiculos = data.veiculos || [];
    refreshQuebraComboOptions();
    const locPayloadOk =
      resLocOk &&
      !!(locData && locData.ok) &&
      Array.isArray(locData.veiculos) &&
      locData.veiculos.length > 0;
    if (locPayloadOk) {
      state.localizacao = locData.veiculos;
      state.kpis = locData.kpis && typeof locData.kpis === "object" ? locData.kpis : {};
    } else if (state.localizacao.length) {
      state.kpis = state.kpis && typeof state.kpis === "object" ? state.kpis : {};
    } else {
      state.localizacao = state.veiculos.length ? state.veiculos.slice() : [];
      state.kpis = {};
      if (state.localizacao.length > 0) {
        try {
          const rk = await fetch("/api/kpis", fetchOpts);
          const kj = await rk.json();
          if (kj && kj.ok && kj.kpis && typeof kj.kpis === "object") state.kpis = kj.kpis;
        } catch (_) {
          /* KPIs ficam vazios; contagens derivadas continuam onde possível */
        }
      }
    }
    state.sondaMeta = data.sonda || null;
    state.tempoMeta = data.tempo || null;
    if (state.currentModule === "operacao") {
      renderKpis();
    }
    if (state.currentModule === "criticos") {
      scheduleCriticosTableRender(false);
    }
    const refitArg = userRefresh ? true : state.mapInitialFitDone ? false : "first";
    if (state.currentModule === "mapa" || userRefresh) {
      upsertMarkers(filteredVehiclesForMap(), refitArg);
    }

    const ta = el("topApiStatus");
    const tuClock = el("topUltimaAtualizacao");
    if (data.ok) {
      state.lastSyncAt = Date.now();
      tickUltimaSyncRelativa();
      if (ta) ta.textContent = "API: Online";
    } else {
      state.lastSyncAt = null;
      if (tuClock) tuClock.textContent = "Última atualização: —";
      if (ta) ta.textContent = "API: Erro";
    }

    let sync = "Atualizado (" + tzExibicao() + "): " + agoraRelogioManaus();
    if (!data.ok) {
      sync = "Frota indisponível: " + (data.erro || "erro desconhecido") + " · " + sync;
    }
    if (state.sondaMeta && state.sondaMeta.erro) {
      sync += " · Sonda: " + state.sondaMeta.erro;
    } else if (state.sondaMeta && !state.sondaMeta.configurada) {
      sync += " · Sonda desativada";
    }
    const us = el("ultimaSyncConfig");
    if (us) us.textContent = sync;

    const base = el("linhaBaseCritica");
    const sondaStatus = state.sondaMeta && state.sondaMeta.configurada ? "Sonda on" : "Sonda off";
    const fpTxt = state.tempoMeta && state.tempoMeta.fonte_principal_frota ? state.tempoMeta.fonte_principal_frota : "mysql";
    const ultGps = state.veiculos && state.veiculos.length ? fmtDataHoraManaus(ultimaAtual(state.veiculos[0])) : "—";
    if (base) {
      base.textContent = "Base · Último GPS: " + ultGps + " · " + sondaStatus + " · Fonte: " + String(fpTxt).toUpperCase();
    }
    const bl = el("bottomLineBase");
    if (bl) {
      bl.textContent = "Último GPS exibido: " + ultGps + " · " + sondaStatus;
    }
    const tBase = el("topoBaseCritica");
    if (tBase) tBase.textContent = "Base";
    const tSonda = el("topoSonda");
    if (tSonda) tSonda.textContent = sondaStatus;
    const tUlt = el("topoUltimoGps");
    if (tUlt) tUlt.textContent = "Último GPS: " + ultGps;

    const fp = data.tempo && data.tempo.fonte_principal_frota;
    const thGps = el("thUltimaGpsFrota");
    if (thGps) {
      thGps.textContent = fp === "sonda" ? "Última GPS (Sonda)" : "Última GPS (MySQL)";
    }
    renderLiveOperationalBar();
    refreshOperationalMode();
    if (userRefresh && state.selected) {
      const still = state.veiculos.find((x) => String(x.prefixo) === String(state.selected));
      if (still) selectVehicle(state.selected);
    }
    // #region agent log
    fetch("http://127.0.0.1:7755/ingest/4511f7d6-1495-403a-84fa-42dc2268828b", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "22aab0" },
      body: JSON.stringify({
        sessionId: "22aab0",
        runId: "post-fix-v6",
        hypothesisId: "H-overlap",
        location: "dashboard.js:fetchFrota:done",
        message: "fetchFrota completed",
        data: {
          userRefresh,
          module: state.currentModule,
          nVeiculos: (state.veiculos || []).length,
          nLocalizacao: (state.localizacao || []).length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    fetchMetaTabela();
    } finally {
      state._frotaFetchInFlight = false;
      if (state._frotaFetchPendingRefresh) {
        state._frotaFetchPendingRefresh = false;
        fetchFrota({ userRefresh: true }).catch(() => {});
      }
    }
  }

  async function apiPost(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  async function apiPut(url, body) {
    const r = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  async function selectVehicle(prefixo, opts) {
    const opt = opts || {};
    const silent = !!opt.silent;
    if (!prefixo || prefixo === "—") return;
    const card = el("detalheCard");
    if (!card) return;
    const reqId = ++_vehicleDetailSeq;
    state.selected = prefixo;
    const dr = el("vehicleDrawer");
    const dtp = el("drawerTitlePrefix");
    if (silent) {
      if (!isDrawerOpen()) return;
    } else {
      openDrawer();
      if (dtp) dtp.textContent = "PRF · " + fmt(prefixo);
      if (dr) dr.setAttribute("data-severity", "neutral");
      card.classList.remove("empty");
      card.innerHTML = "<p class=\"op-terminal-loading\">Carregando dados do veículo…</p>";
      const mk = state.markers[prefixo];
      if (mk && state.map) {
        state.map.setView(mk.getLatLng(), Math.max(state.map.getZoom(), 14));
        mk.openPopup();
      }
    }
    try {
      const [rDet, rHist] = await Promise.all([
        fetch("/api/veiculo/" + encodeURIComponent(prefixo), fetchOpts),
        fetch("/api/veiculo/" + encodeURIComponent(prefixo) + "/historico?limite=30", fetchOpts),
      ]);
      const det = await rDet.json();
      const data = await rHist.json();
      if (reqId !== _vehicleDetailSeq) return;
      if (!det.ok || !det.veiculo) {
        if (reqId !== _vehicleDetailSeq) return;
        card.innerHTML = `<p class="op-terminal-err">${fmt(det.erro || "Não foi possível carregar o veículo.")}</p>`;
        return;
      }
      if (reqId !== _vehicleDetailSeq) return;
      const v = det.veiculo;
      const hero = rotuloAlertaPrincipal(v);
      if (dr) dr.setAttribute("data-severity", hero.severity);
      const hist = data.ok ? data.historico || [] : [];
      const histErr = data.ok ? null : data.erro || "Histórico indisponível.";
      const sc = String(v.status_comunicacao || "");
      const osAbertas = Array.isArray(v.os_abertas) ? v.os_abertas : [];
      const osTop = osAbertas.length ? osAbertas[0] : null;
      const gpsTxt = textoGpsOperacional(sc);
      const estadoMapa = rotuloEstadoMapa(v);
      const decisao = decisaoOperacionalBinaria(v);
      const apoioDecisao = linhaApoioDecisao(v);
      const mecTitle =
        "Com GPS ativo e sem linha identificada, use Liberado ou Retido; Automático remove o registo manual e volta às regras do painel.";
      if (reqId !== _vehicleDetailSeq) return;
      card.innerHTML =
        `<div class="op-terminal">` +
        `<header class="op-terminal__hero op-terminal__hero--${hero.severity}">` +
        `<div class="op-terminal__hero-status">` +
        `<span class="op-entity op-entity--${estadoMapa.entity} op-terminal__hero-dot" aria-hidden="true"><span class="op-entity__core"></span></span>` +
        `<span class="op-terminal__stamp">${escapeHtml(estadoMapa.label)}</span>` +
        `</div>` +
        `<p class="op-terminal__headline">${escapeHtml(hero.headline)}</p>` +
        `<p class="op-terminal__tagline">${escapeHtml(hero.tagline)}</p>` +
        `</header>` +
        `<section class="op-console-block op-console-block--resumo">` +
        `<h3 class="op-console-block__label">Resumo operacional</h3>` +
        `<div class="op-console-block__grid op-console-block__grid--dense">` +
        htmlResumoOperacional(v, gpsTxt) +
        `</div></section>` +
        `<section class="op-console-block op-console-block--mecanica" id="blocoLiberacaoMecanica" title="${escapeHtml(mecTitle)}">` +
        `<h3 class="op-console-block__label">Manutenção — soltura</h3>` +
        `<p class="op-decis-hint">Registo manual quando não há linha no painel.</p>` +
        `<p class="op-decis-meta" id="liberacaoMecanicaResumo">${escapeHtml(resumoLiberacaoMecanica(v))}</p>` +
        `<div class="op-mecanica-btns">` +
        `<button type="button" class="btn-toolbar btn-toolbar-ghost op-mec-btn" data-lib="liberado">Liberado</button>` +
        `<button type="button" class="btn-toolbar btn-toolbar-ghost op-mec-btn" data-lib="retido">Retido</button>` +
        `<button type="button" class="btn-toolbar btn-toolbar-ghost op-mec-btn" data-lib="auto">Automático</button>` +
        `</div></section>` +
        `<section class="op-console-block op-console-block--decision">` +
        `<h3 class="op-console-block__label">Decisão: liberar ou reter</h3>` +
        `<p class="op-decis ${decisao.cls}">${decisao.acao}</p>` +
        `<p class="op-decis-hint">${escapeHtml(apoioDecisao)}</p>` +
        `</section>` +
        `<section class="op-console-block op-console-block--context">` +
        `<h3 class="op-console-block__label">Pendências</h3>` +
        htmlPendenciasContexto(v, osTop) +
        `</section>` +
        htmlHistoricoDrawer(hist, histErr) +
        `<footer class="op-terminal__cmd"><span class="op-terminal__cmd-label">Ações rápidas</span>` +
        `<div class="quick-actions quick-actions--terminal">` +
        `<button type="button" class="qa qa--pri" data-qa="mapa">Mapa</button>` +
        `<button type="button" class="qa qa--pri" data-qa="os">O.S.</button>` +
        (osTop ? `<button type="button" class="qa" data-qa="closeos">Encerrar O.S</button>` : ``) +
        `<button type="button" class="qa" data-qa="prev">Preventiva</button>` +
        `<button type="button" class="qa" data-qa="recolher">Recolher</button>` +
        `<button type="button" class="qa" data-qa="copy">Copiar</button>` +
        `</div></footer>` +
        `</div>`;
      const canW = canWriteOperacional();
      card.querySelectorAll(".qa").forEach((b) => {
        const k = b.getAttribute("data-qa");
        if (k !== "mapa" && k !== "copy" && !canW) {
          b.disabled = true;
          b.title = "Faça login como operador ou administrador";
        }
        b.addEventListener("click", () => onQuickAction(k, prefixo, v, osTop));
      });
      card.querySelectorAll(".op-mec-btn").forEach((b) => {
        const k = b.getAttribute("data-lib");
        if (!canW) {
          b.disabled = true;
          b.title = "Faça login como operador ou administrador";
        }
        b.addEventListener("click", () => onLiberacaoMecanica(prefixo, k));
      });
    } catch (e) {
      if (reqId !== _vehicleDetailSeq) return;
      card.innerHTML = `<p class="hint">${e.message}</p>`;
    }
  }

  async function onQuickAction(kind, prefixo, v, osTop) {
    if (kind === "mapa") {
      focusOnMap(prefixo);
      return;
    }
    if (kind === "copy") {
      const txt = `${prefixo} | ${fmt(v.latitude)}, ${fmt(v.longitude)} | ${fmtDataHoraManaus(v.ultima_atualizacao || v.hora_posicao)}`;
      try {
        await navigator.clipboard.writeText(txt);
        showOpFlash("Localização copiada para a área de transferência.", "ok");
      } catch {
        showOpFlash(txt, "ok");
      }
      return;
    }
    if (kind === "os") {
      const defeito = prompt("Descreva o defeito da O.S:");
      if (!defeito) return;
      const j = await apiPost("/api/os", { prefixo, defeito, situacao: "aberta", prioridade: "media" });
      if (!j.ok) {
        showOpFlash("Falha: " + (j.erro || "sem permissão ou rede — faça login como operador/admin."), "err");
        return;
      }
      await fetchFrota();
      selectVehicle(prefixo);
      return;
    }
    if (kind === "closeos" && osTop) {
      const obs = prompt("Observação de encerramento (opcional):") || "";
      const j = await apiPut("/api/os/" + encodeURIComponent(osTop.id), {
        situacao: "finalizada",
        observacao_encerramento: obs,
      });
      if (!j.ok) {
        showOpFlash("Falha: " + (j.erro || ""), "err");
        return;
      }
      await fetchFrota();
      selectVehicle(prefixo);
      return;
    }
    if (kind === "prev") {
      const d = prompt("Data da preventiva (YYYY-MM-DD):");
      if (!d) return;
      const j = await apiPost("/api/preventivas/agenda", {
        prefixo,
        data_preventiva: d,
        tipo: "geral",
        status: "pendente",
      });
      if (!j.ok) {
        showOpFlash("Falha: " + (j.erro || ""), "err");
        return;
      }
      await fetchFrota();
      selectVehicle(prefixo);
      loadPreventivasTable();
      return;
    }
    if (kind === "recolher") {
      const motivo = prompt("Motivo do recolhimento:");
      if (!motivo) return;
      const j = await apiPost("/api/recolhimentos", { prefixo, motivo, status: "aguardando" });
      if (!j.ok) {
        showOpFlash("Falha: " + (j.erro || ""), "err");
        return;
      }
      await fetchFrota();
      selectVehicle(prefixo);
      loadRecolhimentosTable();
      return;
    }
    if (kind === "liberar") {
      await onLiberacaoMecanica(prefixo, "liberado");
      return;
    }
    if (kind === "bloquear") {
      await onLiberacaoMecanica(prefixo, "retido");
      return;
    }
  }

  async function onLiberacaoMecanica(prefixo, estado) {
    const j = await apiPost("/api/liberacao-mecanica", { prefixo, estado: estado || "auto" });
    if (!j.ok) {
      showOpFlash("Falha: " + (j.erro || "sem permissão ou rede."), "err");
      return;
    }
    showOpFlash(estado === "auto" ? "Painel volta ao automático." : "Registo da manutenção gravado.", "ok");
    await fetchFrota();
    selectVehicle(prefixo);
  }

  async function loadPreventivasTable() {
    const tb = el("tblPreventivasAgenda");
    if (!tb) return;
    const body = tb.querySelector("tbody");
    try {
      const r = await fetch("/api/preventivas/agenda", fetchOpts);
      const d = await r.json();
      const rows = d.itens || [];
      body.innerHTML = rows
        .map(
          (it) => `
        <tr data-id="${it.id}">
          <td>${fmt(it.prefixo)}</td>
          <td>${fmt(it.data_preventiva)}</td>
          <td>${fmt(it.tipo)}</td>
          <td>${fmt(it.status)}</td>
          <td>${fmt(it.observacao)}</td>
          <td>
            <button type="button" class="btn-link-map" data-pfx="${fmt(it.prefixo)}">Mapa</button>
            <button type="button" class="btn-sm-baixa" data-id="${it.id}">Baixa</button>
            <button type="button" class="btn-sm-cancel" data-id="${it.id}">Cancelar</button>
          </td>
        </tr>`
        )
        .join("");
      body.querySelectorAll(".btn-sm-baixa").forEach((b) => {
        b.addEventListener("click", async () => {
          const j = await apiPut("/api/preventivas/agenda/" + b.getAttribute("data-id") + "/baixa", {});
          if (!j.ok) showOpFlash(j.erro || "Falha na baixa.", "err");
          loadPreventivasTable();
          fetchFrota();
        });
      });
      body.querySelectorAll(".btn-sm-cancel").forEach((b) => {
        b.addEventListener("click", async () => {
          const j = await apiPut("/api/preventivas/agenda/" + b.getAttribute("data-id") + "/cancelar", {});
          if (!j.ok) showOpFlash(j.erro || "Falha ao cancelar.", "err");
          loadPreventivasTable();
          fetchFrota();
        });
      });
      body.querySelectorAll(".btn-link-map").forEach((b) => {
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          focusOnMap(b.getAttribute("data-pfx"));
        });
      });
    } catch {
      body.innerHTML = "<tr><td colspan='6'>Erro ao carregar.</td></tr>";
    }
  }

  async function loadQuebrasTable() {
    const tb = el("tblQuebras");
    if (!tb) return;
    const body = tb.querySelector("tbody");
    const incluirEncerradas = !!el("chkQuebrasEncerradas")?.checked;
    const qs = incluirEncerradas ? "" : "?status=ativa";
    loadQuebraMotivoCatalog();
    try {
      const r = await fetch("/api/quebras" + qs, fetchOpts);
      const d = await r.json();
      const rows = d.itens || [];
      const sig =
        (incluirEncerradas ? "1" : "0") +
        "|" +
        rows
          .map((it) => String(it.id != null ? it.id : it.prefixo) + "|" + String(it.status || "") + "|" + String(it.os_id || ""))
          .join(",");
      if (sig === state.quebrasTableSig) return;
      state.quebrasTableSig = sig;
      if (!rows.length) {
        body.innerHTML = "<tr><td colspan='8'>Sem quebras registradas.</td></tr>";
        return;
      }
      body.innerHTML = rows
        .map(
          (it) => `
        <tr>
          <td>${fmt(it.prefixo)}</td>
          <td>${fmt(it.linha)}</td>
          <td>${fmt(it.motorista)}</td>
          <td>${fmt(it.motivo)}</td>
          <td>${fmt(it.status)}</td>
          <td>${it.os_id ? "#" + fmt(it.os_id) : "—"}</td>
          <td>${fmtDataHoraManaus(it.data_criacao)}</td>
          <td>
            <button type="button" class="btn-link-map" data-pfx="${fmt(it.prefixo)}">Mapa</button>
            <button type="button" class="btn-link-drawer" data-pfx="${fmt(it.prefixo)}">Detalhe</button>
          </td>
        </tr>`
        )
        .join("");
      body.querySelectorAll(".btn-link-map").forEach((b) => {
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          focusOnMap(b.getAttribute("data-pfx"));
        });
      });
      body.querySelectorAll(".btn-link-drawer").forEach((b) => {
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          selectVehicle(b.getAttribute("data-pfx"));
        });
      });
    } catch {
      body.innerHTML = "<tr><td colspan='8'>Erro ao carregar.</td></tr>";
    }
  }

  async function loadRecolhimentosTable() {
    const tb = el("tblRecolhimentos");
    if (!tb) return;
    const body = tb.querySelector("tbody");
    try {
      const r = await fetch("/api/recolhimentos", fetchOpts);
      const d = await r.json();
      const rows = d.itens || [];
      body.innerHTML = rows
        .map(
          (it) => `
        <tr>
          <td>${fmt(it.prefixo)}</td>
          <td>${fmt(it.motivo)}</td>
          <td>${fmt(it.solicitante)}</td>
          <td>${fmt(it.status)}</td>
          <td>${fmt(it.data_criacao)}</td>
          <td>
            <button type="button" class="btn-link-map" data-pfx="${fmt(it.prefixo)}">Mapa</button>
            <button type="button" class="btn-rec-st" data-id="${it.id}" data-st="em_deslocamento">Em desloc.</button>
            <button type="button" class="btn-rec-st" data-id="${it.id}" data-st="recolhido">Recolhido</button>
          </td>
        </tr>`
        )
        .join("");
      body.querySelectorAll(".btn-rec-st").forEach((b) => {
        b.addEventListener("click", async () => {
          const j = await apiPut("/api/recolhimentos/" + b.getAttribute("data-id") + "/status", {
            status: b.getAttribute("data-st"),
          });
          if (!j.ok) showOpFlash(j.erro || "Falha ao atualizar recolhimento.", "err");
          loadRecolhimentosTable();
          fetchFrota();
        });
      });
      body.querySelectorAll(".btn-link-map").forEach((b) => {
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          focusOnMap(b.getAttribute("data-pfx"));
        });
      });
    } catch {
      body.innerHTML = "<tr><td colspan='6'>Erro ao carregar.</td></tr>";
    }
  }

  async function loadHistoricoModule(prefixo) {
    const box = el("historicoModuleBody");
    if (!box || !prefixo) return;
    box.innerHTML = "<p class='hint'>Carregando…</p>";
    try {
      const r = await fetch("/api/veiculo/" + encodeURIComponent(prefixo) + "/historico?limite=50", fetchOpts);
      const d = await r.json();
      if (!d.ok) {
        box.innerHTML = `<p class="hint">${fmt(d.erro)}</p>`;
        return;
      }
      const hist = d.historico || [];
      const lines = hist
        .map((h) => {
          const ts = h._normalizado?.hora_posicao;
          const lat = h[Object.keys(h).find((k) => k.toLowerCase().includes("lat"))] || "";
          const lon = h[Object.keys(h).find((k) => k.toLowerCase().includes("lon"))] || "";
          return `<tr><td>${fmtDataHoraManaus(ts)}</td><td>${fmt(h.linha)}</td><td>${fmt(h.sentido)}</td><td>${fmt(lat)}</td><td>${fmt(lon)}</td><td>${fmt(h._status && h._status.operacional)}</td></tr>`;
        })
        .join("");
      box.innerHTML = `<div class="table-scroll"><table class="grid"><thead><tr><th>Data/hora</th><th>Linha</th><th>Sentido</th><th>Lat</th><th>Lon</th><th>Status</th></tr></thead><tbody>${lines}</tbody></table></div>`;
    } catch (e) {
      box.innerHTML = `<p class="hint">${e.message}</p>`;
    }
  }

  function wire() {
    wireCriticosTable();
    const upd = el("btnAtualizar");
    if (upd) upd.addEventListener("click", () => fetchFrota({ userRefresh: true }).catch((e) => showOpFlash(e.message, "err")));

    el("filtroPrefixo")?.addEventListener("input", () => {
      renderTables(state.veiculos);
      upsertMarkers(filteredVehiclesForMap(), false);
    });

    ["filtroCriticos", "filtroComOs", "filtroPreventiva", "filtroSemGps", "filtroAguardandoRecolhimento", "filtroDisponiveis"].forEach((id) => {
      el(id)?.addEventListener("change", () => {
        persistFilters();
        syncChipsFromFilters();
        renderTables(state.veiculos);
        upsertMarkers(filteredVehiclesForMap(), true);
      });
    });

    document.querySelectorAll(".chip-filter").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.getAttribute("data-filter");
        if (k === "todos") {
          clearFilters();
          return;
        }
        const map = {
          criticos: "filtroCriticos",
          comOs: "filtroComOs",
          preventiva: "filtroPreventiva",
          semGps: "filtroSemGps",
          aguardandoRecolhimento: "filtroAguardandoRecolhimento",
          disponiveis: "filtroDisponiveis",
        };
        const id = map[k];
        if (id && el(id)) {
          el(id).checked = !el(id).checked;
          persistFilters();
          syncChipsFromFilters();
          renderTables(state.veiculos);
          upsertMarkers(filteredVehiclesForMap(), true);
        }
      });
    });

    el("btnFiltrarAvancado")?.addEventListener("click", () => {
      el("filtroPrefixo")?.focus();
    });

    el("btnLimparFiltros")?.addEventListener("click", () => clearFilters());

    el("btnAbrirDlgExportLocalizacao")?.addEventListener("click", () => openDlgExportLocalizacao());
    el("btnAbrirDlgExportFrota")?.addEventListener("click", () => openDlgExportFrota());

    el("btnToggleTema")?.addEventListener("click", () => {
      document.body.classList.toggle("light-mode");
      const b = el("btnToggleTema");
      if (b) b.textContent = document.body.classList.contains("light-mode") ? "Modo escuro" : "Modo claro";
    });

    el("btnVerDiagnostico")?.addEventListener("click", () => {
      const meta = el("metaTabelaHealth");
      const sync = el("ultimaSyncConfig");
      const t =
        (meta && meta.textContent ? meta.textContent : "") +
        " · " +
        (sync && sync.textContent ? sync.textContent : "");
      showOpFlash(truncHint(t.replace(/^ · | · $/g, "").trim(), 420), "ok");
    });

    el("btnCarregarAuditoria")?.addEventListener("click", () => loadAuditoriaPanel());

    el("btnCloseDrawer")?.addEventListener("click", () => closeDrawer());
    el("drawerBackdrop")?.addEventListener("click", () => closeDrawer());

    el("btnToggleSidebarExpand")?.addEventListener("click", () => {
      const sb = el("sidebar");
      if (!sb) return;
      sb.classList.toggle("sidebar--compact");
      const btn = el("btnToggleSidebarExpand");
      if (btn) btn.setAttribute("aria-expanded", sb.classList.contains("sidebar--compact") ? "false" : "true");
      try {
        localStorage.setItem(SIDEBAR_EXPAND_KEY, sb.classList.contains("sidebar--compact") ? "0" : "1");
      } catch {}
      setTimeout(() => state.map && state.map.invalidateSize(), 200);
    });

    document.querySelectorAll("#navSsov .nav-item").forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        const m = a.getAttribute("data-module");
        if (m) setModule(m);
      });
    });

    window.addEventListener("hashchange", () => {
      const h = (location.hash || "").replace("#", "").trim();
      if (h && h !== state.currentModule) setModule(h);
    });
    window.addEventListener("popstate", () => {
      const h = (location.hash || "").replace("#", "").trim();
      if (h && h !== state.currentModule) setModule(h);
    });

    el("formPreventiva")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const j = await apiPost("/api/preventivas/agenda", {
        prefixo: fd.get("prefixo"),
        data_preventiva: fd.get("data_preventiva"),
        tipo: fd.get("tipo") || "geral",
        observacao: fd.get("observacao"),
        status: "pendente",
      });
      if (!j.ok) showOpFlash(j.erro || "Falha ao cadastrar preventiva.", "err");
      else {
        ev.target.reset();
        loadPreventivasTable();
        fetchFrota();
        showOpFlash("Preventiva cadastrada.", "ok");
      }
    });

    el("formRecolhimento")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const j = await apiPost("/api/recolhimentos", {
        prefixo: fd.get("prefixo"),
        motivo: fd.get("motivo"),
        solicitante: fd.get("solicitante"),
        observacao: fd.get("observacao"),
        status: "aguardando",
      });
      if (!j.ok) showOpFlash(j.erro || "Falha ao registar recolhimento.", "err");
      else {
        ev.target.reset();
        loadRecolhimentosTable();
        fetchFrota();
        showOpFlash("Recolhimento registado.", "ok");
      }
    });

    wireQuebraCombos();

    el("btnAbrirDlgQuebra")?.addEventListener("click", () => {
      openDlgQuebra().catch(() => {});
    });
    el("btnDlgQuebraLogin")?.addEventListener("click", async () => {
      const login = String(el("dlgQuebraLogin")?.value || "").trim();
      const senha = String(el("dlgQuebraSenha")?.value || "");
      const status = el("dlgQuebraAuthStatus");
      if (!login || !senha) {
        if (status) status.textContent = "Informe login e senha.";
        return;
      }
      const j = await submitOperadorLogin(login, senha);
      if (!j.ok) {
        if (status) status.textContent = j.erro || "Falha no login.";
        return;
      }
      if (status) status.textContent = "";
      const senhaEl = el("dlgQuebraSenha");
      if (senhaEl) senhaEl.value = "";
      syncQuebrasWriteAccess();
      showOpFlash("Sessão iniciada. Pode confirmar o lançamento.", "ok");
    });
    wireModuleDialog("dlgQuebra", ["btnFecharDlgQuebra", "btnCancelarDlgQuebra"]);
    wireModuleDialog("dlgQuebrasRelatorioGeral", ["btnFecharDlgQuebrasRelGeral", "btnCancelarDlgQuebrasRelGeral"]);
    wireModuleDialog("dlgQuebrasRelatorio", ["btnFecharDlgQuebrasRelatorio", "btnCancelarDlgQuebrasRelatorio"]);
    wireModuleDialog("dlgExportLocalizacao", ["btnFecharDlgExportLocalizacao", "btnCancelarDlgExportLocalizacao"]);
    wireModuleDialog("dlgExportFrota", ["btnFecharDlgExportFrota", "btnCancelarDlgExportFrota"]);

    el("formQuebra")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!canWriteOperacional()) {
        showOpFlash("Inicie sessão em Configurações (operador ou admin) para lançar quebra.", "err");
        return;
      }
      const fd = new FormData(ev.target);
      const j = await apiPost("/api/quebras", {
        prefixo: fd.get("prefixo"),
        linha: fd.get("linha"),
        motorista: fd.get("motorista"),
        motivo: fd.get("motivo"),
        descricao: fd.get("descricao"),
      });
      if (!j.ok) showOpFlash(j.erro || "Falha ao lançar quebra.", "err");
      else {
        ev.target.reset();
        resetQuebraDialogCombos();
        closeDlgQuebra();
        loadQuebrasTable();
        scheduleCriticosTableRender(true);
        fetchFrota();
        showOpFlash("Quebra lançada.", "ok");
      }
    });

    el("btnAbrirDlgQuebrasRelGeral")?.addEventListener("click", () => openDlgQuebrasRelatorioGeral());
    el("btnAbrirDlgQuebrasRelatorio")?.addEventListener("click", () => {
      openDlgQuebrasRelatorio().catch(() => {});
    });

    el("formQuebrasRelatorioGeral")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      openQuebrasExport({}, readReportFormatFromForm(ev.target));
      closeModuleDialog("dlgQuebrasRelatorioGeral");
    });

    el("formQuebrasRelatorio")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const q = { formato: readReportFormatFromForm(ev.target) };
      const pfx = String(fd.get("prefixo") || "").trim();
      const de = String(fd.get("de") || "").trim();
      const ate = String(fd.get("ate") || "").trim();
      const motivo = String(fd.get("motivo") || "").trim();
      if (pfx) q.prefixo = pfx;
      if (de) q.de = de;
      if (ate) q.ate = ate;
      if (motivo) q.motivo = motivo;
      openQuebrasExport(q);
      closeModuleDialog("dlgQuebrasRelatorio");
    });

    el("formExportLocalizacao")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      openReportExport("localizacao", { formato: readReportFormatFromForm(ev.target) });
      closeModuleDialog("dlgExportLocalizacao");
    });

    el("formExportFrota")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      openReportExport("frota", { formato: readReportFormatFromForm(ev.target) });
      closeModuleDialog("dlgExportFrota");
    });

    el("chkQuebrasEncerradas")?.addEventListener("change", () => loadQuebrasTable());

    syncQuebrasWriteAccess();

    function historicoBuscarSubmit() {
      const p = (el("historicoPrefixoInput")?.value || "").trim();
      if (p) loadHistoricoModule(p);
    }
    el("btnHistoricoBuscar")?.addEventListener("click", historicoBuscarSubmit);
    el("historicoPrefixoInput")?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        historicoBuscarSubmit();
      }
    });

    el("formLogin")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const j = await submitOperadorLogin(String(fd.get("login") || "").trim(), String(fd.get("senha") || ""));
      if (!j.ok) {
        const st = el("loginStatus");
        if (st) st.textContent = j.erro || "Falha no login";
        return;
      }
    });

    el("btnSair")?.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      fetchAuthMe();
    });

    el("chkSelecionarTodosLocalizacao")?.addEventListener("change", () => {
      const s = getSelSet();
      const filters = getLocalizacaoFilters();
      const filtro = (el("filtroPrefixo")?.value || "").trim().toLowerCase();
      let current = state.localizacao
        .filter((v) => (filtro ? String(v.prefixo || "").toLowerCase().includes(filtro) : true))
        .map((v) => String(v.prefixo));
      if (state.currentModule === "criticos") {
        current = current.filter((pfx) => {
          const x = state.localizacao.find((l) => String(l.prefixo) === pfx);
          return x && String(x.prioridade_localizacao || "").toLowerCase() === "alta";
        });
      }
      const chk = el("chkSelecionarTodosLocalizacao");
      current.forEach((p) => {
        if (chk && chk.checked) s.add(p);
        else s.delete(p);
      });
      setSelSet(s);
      renderTables(state.veiculos);
    });

    el("btnMarcarCiente")?.addEventListener("click", () => {
      const s = getSelSet();
      if (s.size === 0) return;
      const ack = getAckSet();
      s.forEach((p) => ack.add(String(p)));
      setAckSet(ack);
      setSelSet(new Set());
      renderTables(state.veiculos);
    });

    setInterval(() => tickUltimaSyncRelativa(), 1000);
    setInterval(() => fetchFrota().catch(() => {}), POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        fetchFrota().catch(() => {});
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    restoreFilters();
    syncChipsFromFilters();
    try {
      const se = localStorage.getItem(SIDEBAR_EXPAND_KEY);
      const sb = el("sidebar");
      if (sb && se === "0") {
        sb.classList.add("sidebar--compact");
        const btn = el("btnToggleSidebarExpand");
        if (btn) btn.setAttribute("aria-expanded", "false");
      }
    } catch {}
    initMap();
    wire();
    restoreModule();
    fetchAuthMe();
    fetchFrota().catch(() => {});
    fetch("/api/health", fetchOpts)
      .then((r) => r.json())
      .then((d) => {
        applyAuthPolicy(d);
        syncQuebrasWriteAccess();
        const sp = el("statusServicos");
        if (!sp) return;
        const mysql = d && d.servicos && d.servicos.mysql && d.servicos.mysql.ok ? "MySQL OK" : "MySQL erro";
        const sonda = d && d.sonda_configurada ? "Sonda cfg" : "Sonda off";
        sp.textContent = `${mysql} · ${sonda}`;
      })
      .catch(() => {
        const sp = el("statusServicos");
        if (sp) sp.textContent = "Serviços: indisponível";
      });
  });
})();
