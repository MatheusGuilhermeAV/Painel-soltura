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
    /** ms desde epoch; texto “há Xs” no topo */
    lastSyncAt: null,
    /** Evita `fitBounds` a cada poll (causava sensação de “página a recarregar”). */
    mapInitialFitDone: false,
    /** Evita reescrever tbody de Críticos quando nada mudou (poll). */
    criticosTableSig: null,
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
      if (n) n.textContent = String(vals[i]);
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
    pill.textContent = mode === "critico" ? "Modo operacional: crítico" : "Modo operacional: normal";
    pill.title =
      mode === "critico"
        ? "Frota com muitas unidades críticas, sem GPS ou em recolhimento — revisar decisões."
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

  /** Alerta operacional em caixa alta — linguagem de centro de controle. */
  function rotuloAlertaPrincipal(v) {
    const cat = String(v.ssov_categoria || "").toLowerCase();
    const sc = String(v.status_comunicacao || "");
    const prio = String(v.prioridade_localizacao || "").toLowerCase();
    const motivo = String(v.motivo_localizacao || v.motivo_soltura || v.observacao || "").trim();

    if (v.ssov_recolhimento_ativo || cat === "recolhimento") {
      return {
        headline: "RECOLHIMENTO NECESSÁRIO",
        tagline: motivo || "Unidade sob fluxo de recolhimento — priorizar deslocamento e decisão de campo.",
        severity: "critical",
        code: "REC",
      };
    }
    if (cat === "sem_gps" || sc === "SEM_ATUALIZACAO") {
      return {
        headline: "GPS OFFLINE",
        tagline: motivo || "Sem posição atualizada — não há rastreio em tempo real para esta unidade.",
        severity: "critical",
        code: "GPS",
      };
    }
    if (cat === "critico" || prio === "alta") {
      return {
        headline: "VEÍCULO CRÍTICO",
        tagline: motivo || "Prioridade máxima — exige decisão imediata de soltura ou retenção.",
        severity: "critical",
        code: "CRT",
      };
    }
    if (v.ssov_preventiva_hoje || cat === "preventiva_dia") {
      return {
        headline: "PREVENTIVA DO DIA",
        tagline: "Programada para intervenção hoje — verificar chegada e baixa.",
        severity: "info",
        code: "PRV",
      };
    }
    if (sc === "ATRASO_LEVE" || cat === "atencao") {
      return {
        headline: "ATENÇÃO OPERACIONAL",
        tagline: motivo || "GPS ou contexto instável — conferir antes de liberar.",
        severity: "warn",
        code: "ATN",
      };
    }
    if (cat === "disponivel") {
      return {
        headline: "SITUAÇÃO ESTÁVEL",
        tagline: "Parâmetros operacionais dentro da faixa para avaliação de soltura.",
        severity: "ok",
        code: "OK",
      };
    }
    const op = String(v.status_operacional || "MONITORAR").trim();
    return {
      headline: op.length > 32 ? op.slice(0, 30).toUpperCase() + "…" : op.toUpperCase(),
      tagline: motivo || "Monitoramento contínuo.",
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
    if (filters.criticos) labels.push("Críticos");
    if (filters.comOs) labels.push("Com O.S.");
    if (filters.preventiva) labels.push("Preventiva");
    if (filters.semGps) labels.push("Sem GPS");
    if (filters.aguardandoRecolhimento) labels.push("Recolhimento");
    if (filters.disponiveis) labels.push("Disponíveis");
    node.textContent = labels.length ? "Filtros ativos: " + labels.join(", ") : "Sem filtros ativos";
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
      const pfx = String(v.prefixo);
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
        m.setLatLng([lat, lon]);
        m.setIcon(icon);
        m.off("click");
        m.on("click", () => selectVehicle(pfx));
        m.bindPopup(popupHtml, { className: "op-popup-leaflet", maxWidth: 280 });
      } else {
        m = L.marker([lat, lon], { icon });
        m.bindPopup(popupHtml, { className: "op-popup-leaflet", maxWidth: 280 });
        m.on("click", () => selectVehicle(pfx));
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
      kpiOperacional("Críticos", k.criticos || 0, "Prioridade alta", "kpi-crit"),
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

  function kpiOperacional(label, val, subtitle, klass) {
    return `<button type="button" class="kpi ${klass}" data-kpi="${klass}"><span>${label}</span><strong>${val}</strong><small>${subtitle}</small></button>`;
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

  function criticosTableSignature(locRows, filters, filtro, ackSet, selSet) {
    const rowPart = locRows
      .map((v) =>
        [
          v.prefixo,
          v.prioridade_localizacao,
          v.minutos_sem_atualizacao,
          shortMotivo(v.motivo_localizacao),
          v.status_soltura,
          v.status_comunicacao,
          String(v.ssov_categoria || ""),
        ].join(":")
      )
      .join(";");
    const fk =
      JSON.stringify(filters) +
      "|" +
      filtro +
      "|" +
      [...ackSet].sort().join(",") +
      "|" +
      [...selSet].sort().join(",");
    return rowPart + "||" + fk;
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
      if (!force) {
        const nextSig = criticosTableSignature(locRows, filters, filtro, ackSet, selSet);
        if (nextSig === state.criticosTableSig) return;
        state.criticosTableSig = nextSig;
      } else {
        state.criticosTableSig = criticosTableSignature(locRows, filters, filtro, ackSet, selSet);
      }
      tbLb.innerHTML = locRows
        .map((v) => {
          const pfx = fmt(v.prefixo);
          const checked = selSet.has(String(v.prefixo)) ? "checked" : "";
          const ciente = ackSet.has(String(v.prefixo)) ? "row-ciente" : "";
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
      tbLb.querySelectorAll("tr").forEach((tr) => {
        tr.addEventListener("click", (ev) => {
          if (ev.target && ev.target.closest && ev.target.closest(".chk-row-localizacao")) return;
          if (ev.target && ev.target.classList && ev.target.classList.contains("btn-link-map")) return;
          selectVehicle(tr.getAttribute("data-pfx"));
        });
      });
      tbLb.querySelectorAll(".chk-row-localizacao").forEach((chk) => {
        chk.addEventListener("change", () => {
          const s = getSelSet();
          const pfx = chk.getAttribute("data-pfx");
          if (chk.checked) s.add(String(pfx));
          else s.delete(String(pfx));
          setSelSet(s);
        });
      });
      tbLb.querySelectorAll(".btn-link-map").forEach((b) => {
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          focusOnMap(b.getAttribute("data-pfx"));
        });
      });
      const chkAll = el("chkSelecionarTodosLocalizacao");
      if (chkAll) {
        chkAll.checked = locRows.length > 0 && locRows.every((v) => selSet.has(String(v.prefixo)));
      }
    }

    const tbF = el("tblFrota");
    if (tbF) {
      const tbFb = tbF.querySelector("tbody");
      tbFb.innerHTML = rows
        .map(
          (v) => `
      <tr data-pfx="${fmt(v.prefixo)}">
        <td><span class="pill" style="background:${v.mapa_cor || "#888"}"></span>${fmt(v.prefixo)}</td>
        <td>${fmt(v.linha)}</td>
        <td>${fmt(v.sentido)}</td>
        <td>${fmt(v.motorista)}</td>
        <td>${fmt(v.status_operacional)}</td>
        <td><span class="${badgeClass(v.status_soltura)}">${fmt(v.status_soltura)}</span></td>
        <td>${fmtDataHoraManaus(ultimaAtual(v))}</td>
      </tr>`
        )
        .join("");
      tbFb.querySelectorAll("tr").forEach((tr) => {
        tr.addEventListener("click", () => selectVehicle(tr.getAttribute("data-pfx")));
      });
    }

    const tbS = el("tblSoltura");
    if (tbS) {
      const tbSb = tbS.querySelector("tbody");
      tbSb.innerHTML = rows
        .map(
          (v) => `
      <tr data-pfx="${fmt(v.prefixo)}">
        <td>${fmt(v.prefixo)}</td>
        <td>${fmt(v.status_operacional)}</td>
        <td>${fmt(v.linha)}</td>
        <td>${fmt(v.motorista)}</td>
        <td>${fmt(v.latitude)}, ${fmt(v.longitude)}</td>
        <td>${v.minutos_sem_atualizacao != null ? Math.round(v.minutos_sem_atualizacao) : "—"}</td>
        <td>${v.na_garagem === true ? "Sim" : v.na_garagem === false ? "Não" : "—"}</td>
        <td>${v.em_viagem_inferido === true ? "Sim" : v.em_viagem_inferido === false ? "Não" : "—"}</td>
        <td class="cell-motivo">${fmt(v.motivo_soltura || v.observacao)}</td>
        <td class="cell-flags"><span class="flags-inline">${fmtFlags(v.flags)}</span></td>
        <td><span class="${badgeClass(v.status_soltura)}">${fmt(v.status_soltura)}</span></td>
      </tr>`
        )
        .join("");
      tbSb.querySelectorAll("tr").forEach((tr) => {
        tr.addEventListener("click", () => selectVehicle(tr.getAttribute("data-pfx")));
      });
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
    } else if (name === "historico" && state.selected) {
      loadHistoricoModule(state.selected);
    }
  }

  function setModule(name) {
    state.currentModule = name;
    try {
      localStorage.setItem(MODULE_KEY, name);
    } catch {}
    if (location.hash.replace("#", "") !== name) {
      location.hash = name;
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
    if (name === "criticos") {
      state.criticosTableSig = null;
      renderTables(state.veiculos, { force: true });
    }
    if (name === "operacao") {
      renderKpis();
    }
    onModuleEnter(name);
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

  async function fetchAuthMe() {
    try {
      const r = await fetch("/api/auth/me", fetchOpts);
      const d = await r.json();
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
  }

  async function fetchFrota(options) {
    const opts = options || {};
    const userRefresh = !!opts.userRefresh;
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
    const locPayloadOk =
      resLocOk &&
      !!(locData && locData.ok) &&
      Array.isArray(locData.veiculos) &&
      locData.veiculos.length > 0;
    if (locPayloadOk) {
      state.localizacao = locData.veiculos;
      state.kpis = locData.kpis && typeof locData.kpis === "object" ? locData.kpis : {};
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
      renderTables(state.veiculos);
    }
    const refitArg = userRefresh ? true : state.mapInitialFitDone ? false : "first";
    upsertMarkers(filteredVehiclesForMap(), refitArg);

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
    if (state.selected) {
      const still = state.veiculos.find((x) => String(x.prefixo) === String(state.selected));
      if (still) {
        if (userRefresh) selectVehicle(state.selected);
        else if (isDrawerOpen()) selectVehicle(state.selected, { silent: true });
      }
    }
    fetchMetaTabela();
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
      if (!data.ok) {
        if (reqId !== _vehicleDetailSeq) return;
        card.innerHTML = `<p class="op-terminal-err">${fmt(data.erro || "Histórico indisponível.")}</p>`;
        return;
      }
      if (reqId !== _vehicleDetailSeq) return;
      const v = det.veiculo;
      const hero = rotuloAlertaPrincipal(v);
      if (dr) dr.setAttribute("data-severity", hero.severity);
      const hist = data.historico || [];
      const lines = hist
        .map((h, i) => {
          const st = h._status || {};
          const ts = h._normalizado?.hora_posicao ?? h[Object.keys(h).find((k) => k.toLowerCase().includes("hora"))];
          return `<tr><td>${i + 1}</td><td class="op-td-mono">${fmtDataHoraManaus(ts)}</td><td>${fmt(st.operacional)}</td><td>${fmt(st.soltura)}</td></tr>`;
        })
        .join("");
      const sc = String(v.status_comunicacao || "");
      const osAbertas = Array.isArray(v.os_abertas) ? v.os_abertas : [];
      const osTop = osAbertas.length ? osAbertas[0] : null;
      const osInfoRaw = osTop ? `#${fmt(osTop.id)} · ${fmt(osTop.defeito)} · ${fmt(osTop.situacao)}` : "Sem O.S. aberta";
      const osInfo = escapeHtml(osInfoRaw);
      const prevHoje = v.ssov_preventiva_hoje ? "SIM — HOJE" : "NÃO";
      const recAt = v.ssov_recolhimento_ativo ? "SIM — EM FILA" : "NÃO";
      const gpsTxt =
        sc === "SEM_ATUALIZACAO" ? "OFFLINE" : sc === "ATRASO_LEVE" ? "INSTÁVEL" : "ATIVO";
      const decisao = decisaoOperacionalBinaria(v);
      if (reqId !== _vehicleDetailSeq) return;
      card.innerHTML =
        `<div class="op-terminal">` +
        `<header class="op-terminal__hero op-terminal__hero--${hero.severity}">` +
        `<span class="op-terminal__stamp">ALERTA PRINCIPAL · ${hero.code}</span>` +
        `<p class="op-terminal__headline">${escapeHtml(hero.headline)}</p>` +
        `<p class="op-terminal__tagline">${escapeHtml(hero.tagline)}</p>` +
        `</header>` +
        `<section class="op-console-block">` +
        `<h3 class="op-console-block__label">Unidade e classificação</h3>` +
        `<div class="op-console-block__grid">` +
        `<div class="op-console-block__kv"><span class="kv-k">Prefixo</span><span class="kv-v">${escapeHtml(fmt(prefixo))}</span></div>` +
        `<div class="op-console-block__kv"><span class="kv-k">Situação no painel</span><span class="kv-v kv-v--loud">${escapeHtml(fmt(v.status_operacional))}</span></div>` +
        `<div class="op-console-block__kv"><span class="kv-k">Classificação (SSOV)</span><span class="kv-v">${escapeHtml(fmt(v.ssov_categoria))}</span></div>` +
        `</div></section>` +
        `<section class="op-console-block op-console-block--decision">` +
        `<h3 class="op-console-block__label">Decisão: liberar ou reter</h3>` +
        `<p class="op-decis ${decisao.cls}">${decisao.acao}</p>` +
        `<p class="op-decis-hint">${escapeHtml(fmt(v.status_soltura))}</p>` +
        `<p class="op-decis-meta"><strong>Ação sugerida</strong> — ${escapeHtml(fmt(v.acao_localizacao))}</p>` +
        `</section>` +
        `<section class="op-terminal__section op-terminal__section--context">` +
        `<h3 class="op-terminal__sec-title">Contexto <span class="op-terminal__sec-hint">linha, GPS e ordens</span></h3>` +
        `<div class="op-terminal__rack op-terminal__rack--dense">` +
        `<div class="op-terminal__slot"><span class="op-terminal__k">Sinal GPS</span><span class="op-terminal__v op-terminal__v--loud">${gpsTxt}</span></div>` +
        `<div class="op-terminal__slot"><span class="op-terminal__k">Linha</span><span class="op-terminal__v">${escapeHtml(fmt(v.linha) + " · " + fmt(v.sentido))}</span></div>` +
        `<div class="op-terminal__slot"><span class="op-terminal__k">Última posição</span><span class="op-terminal__v op-terminal__v--mono">${escapeHtml(fmtDataHoraManaus(v.ultima_atualizacao || v.hora_posicao))}</span></div>` +
        `<div class="op-terminal__slot"><span class="op-terminal__k">Preventiva hoje</span><span class="op-terminal__v op-terminal__v--loud">${prevHoje}</span></div>` +
        `<div class="op-terminal__slot"><span class="op-terminal__k">Recolhimento</span><span class="op-terminal__v op-terminal__v--loud">${recAt}</span></div>` +
        `<div class="op-terminal__slot op-terminal__slot--wide"><span class="op-terminal__k">Ordens de serviço (O.S.)</span><span class="op-terminal__v">${osInfo}</span></div>` +
        `</div></section>` +
        `<section class="op-terminal__section op-terminal__section--timeline">` +
        `<h3 class="op-terminal__sec-title">Histórico recente <span class="op-terminal__sec-hint">últimos registros</span></h3>` +
        `<div class="table-scroll op-table-wrap"><table class="grid op-table-terminal"><thead><tr><th>#</th><th>Data/hora</th><th>Situação painel</th><th>Soltura</th></tr></thead><tbody>${lines}</tbody></table></div>` +
        `</section>` +
        `<footer class="op-terminal__cmd"><span class="op-terminal__cmd-label">Ações rápidas</span>` +
        `<div class="quick-actions quick-actions--terminal">` +
        `<button type="button" class="qa qa--pri" data-qa="mapa">Mapa</button>` +
        `<button type="button" class="qa qa--pri" data-qa="os">O.S.</button>` +
        (osTop ? `<button type="button" class="qa" data-qa="closeos">Encerrar O.S</button>` : ``) +
        `<button type="button" class="qa" data-qa="prev">Preventiva</button>` +
        `<button type="button" class="qa" data-qa="recolher">Recolher</button>` +
        `<button type="button" class="qa" data-qa="liberar">Liberar</button>` +
        `<button type="button" class="qa" data-qa="bloquear">Bloquear</button>` +
        `<button type="button" class="qa" data-qa="copy">Copiar</button>` +
        `</div></footer>` +
        `</div>`;
      const canW = (() => {
        const p = String(state.authUser && state.authUser.perfil ? state.authUser.perfil : "").toLowerCase();
        return state.authUser && (p === "admin" || p === "operador");
      })();
      card.querySelectorAll(".qa").forEach((b) => {
        const k = b.getAttribute("data-qa");
        if (k !== "mapa" && k !== "copy" && !canW) {
          b.disabled = true;
          b.title = "Faça login como operador ou administrador";
        }
        b.addEventListener("click", () => onQuickAction(k, prefixo, v, osTop));
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
        alert("Localização copiada.");
      } catch {
        alert(txt);
      }
      return;
    }
    if (kind === "os") {
      const defeito = prompt("Descreva o defeito da O.S:");
      if (!defeito) return;
      const j = await apiPost("/api/os", { prefixo, defeito, situacao: "aberta", prioridade: "media" });
      if (!j.ok) {
        alert("Falha: " + (j.erro || "sem permissão ou rede — faça login como operador/admin."));
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
        alert("Falha: " + (j.erro || ""));
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
        alert("Falha: " + (j.erro || ""));
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
        alert("Falha: " + (j.erro || ""));
        return;
      }
      await fetchFrota();
      selectVehicle(prefixo);
      loadRecolhimentosTable();
      return;
    }
    if (kind === "liberar") {
      const j = await apiPost("/api/acoes", {
        prefixo,
        tipo_acao: "liberar_soltura",
        descricao: "Operador indicou liberação para soltura",
      });
      if (!j.ok) {
        alert("Falha: " + (j.erro || ""));
        return;
      }
      alert("Ação registrada.");
      return;
    }
    if (kind === "bloquear") {
      const j = await apiPost("/api/acoes", {
        prefixo,
        tipo_acao: "bloquear_soltura",
        descricao: "Operador bloqueou soltura",
      });
      if (!j.ok) {
        alert("Falha: " + (j.erro || ""));
        return;
      }
      alert("Ação registrada.");
    }
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
          if (!j.ok) alert(j.erro || "falha");
          loadPreventivasTable();
          fetchFrota();
        });
      });
      body.querySelectorAll(".btn-sm-cancel").forEach((b) => {
        b.addEventListener("click", async () => {
          const j = await apiPut("/api/preventivas/agenda/" + b.getAttribute("data-id") + "/cancelar", {});
          if (!j.ok) alert(j.erro || "falha");
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
          if (!j.ok) alert(j.erro || "falha");
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
    const upd = el("btnAtualizar");
    if (upd) upd.addEventListener("click", () => fetchFrota({ userRefresh: true }).catch((e) => alert(e.message)));

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

    el("btnExportarLocalizacao")?.addEventListener("click", () => {
      window.open("/api/export/localizacao.csv", "_blank");
    });
    el("btnExportarFrota")?.addEventListener("click", () => {
      window.open("/api/export/frota.csv", "_blank");
    });

    el("btnToggleTema")?.addEventListener("click", () => {
      document.body.classList.toggle("light-mode");
      const b = el("btnToggleTema");
      if (b) b.textContent = document.body.classList.contains("light-mode") ? "Modo escuro" : "Modo claro";
    });

    el("btnVerDiagnostico")?.addEventListener("click", () => {
      const meta = el("metaTabelaHealth");
      const sync = el("ultimaSyncConfig");
      alert((meta && meta.textContent ? meta.textContent : "") + "\n\n" + (sync && sync.textContent ? sync.textContent : ""));
    });

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
      if (h) setModule(h);
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
      if (!j.ok) alert(j.erro || "falha");
      else {
        ev.target.reset();
        loadPreventivasTable();
        fetchFrota();
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
      if (!j.ok) alert(j.erro || "falha");
      else {
        ev.target.reset();
        loadRecolhimentosTable();
        fetchFrota();
      }
    });

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
      const j = await apiPost("/api/auth/login", { login: fd.get("login"), senha: fd.get("senha") });
      if (!j.ok) {
        const st = el("loginStatus");
        if (st) st.textContent = j.erro || "Falha no login";
        return;
      }
      fetchAuthMe();
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
