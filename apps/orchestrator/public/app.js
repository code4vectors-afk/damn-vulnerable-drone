(() => {
  const state = {
    user: null,
    lab: null,
    runtime: null,
    activeSlotCount: 0,
    ai: null,
    health: null,
    view: "console", // "console" | "dossier" | "admin"
    targetTab: "sim", // "sim" | "admin" | "gcs"
    drawerTab: "mission", // "mission" | "ai"
    drawerOpen: true,
    termCollapsed: false,
    resolveIps: true,
    scenarios: [],
    progress: {},
    activeScenarioId: null,
    phaseFilter: "ALL",
    searchQuery: "",
    aiMessages: [],
    aiTier: "fast",
    aiBusy: false,
    adminState: null,
    authErr: "",
    mountedLabId: null,
  };

  const PHASES = [
    "ALL",
    "PART 1",
    "RECON",
    "LINK-LAYER WI-FI",
    "COMPANION EXPLOIT",
    "CAMERA / ROS DoS",
    "MAVLINK INJECTION",
    "GPS / GEOFENCE",
    "EXFILTRATION",
    "TAMPERING",
    "FIRMWARE",
  ];

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  async function copyText(txt, label = "Copied to clipboard") {
    try {
      await navigator.clipboard.writeText(txt);
      toast(label);
    } catch {
      toast("Clipboard unavailable — select and copy manually");
    }
  }

  async function api(path, body, method) {
    const res = await fetch("/api/" + path, {
      method: method || (body !== undefined ? "POST" : "GET"),
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function resolveVars(text) {
    if (!state.resolveIps || !state.lab?.ips) return text;
    const ips = state.lab.ips;
    return String(text || "")
      .replace(/\$DRONE_FC_IP/g, ips.fc)
      .replace(/\$DRONE_COMPANION_IP/g, ips.companion)
      .replace(/\$DRONE_GCS_IP/g, ips.gcs)
      .replace(/\$DRONE_SIM_IP/g, ips.sim)
      .replace(/\$DRONE_SUBNET/g, ips.subnet);
  }

  function formatCountdown(deadlineMs) {
    if (!deadlineMs) return "--:--";
    const diff = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function zuluNow() {
    return new Date().toISOString().slice(11, 19) + " Z";
  }

  function getActiveScenario() {
    if (!state.scenarios.length) return null;
    return (
      state.scenarios.find((s) => s.id === state.activeScenarioId) ||
      state.scenarios.find((s) => s.slug === "camera-feed-ros-topic-flooding") ||
      state.scenarios[0]
    );
  }

  // --- Data Sync ---
  async function loadMe() {
    try {
      const data = await api("me");
      state.user = data.user;
      state.lab = data.lab;
      state.runtime = data.runtime;
      state.activeSlotCount = data.activeSlotCount;
      state.ai = data.ai;
      if (!state.scenarios.length) await loadScenarios();
      render();
      if (state.lab?.status === "healthy") pollHealth();
    } catch {
      state.user = null;
      state.lab = null;
      render();
    }
  }

  async function loadScenarios() {
    const data = await api("scenarios");
    state.scenarios = data.scenarios || [];
    state.progress = data.progress || {};
    if (!state.activeScenarioId && state.scenarios.length) {
      const part1 = state.scenarios.find((s) => s.slug === "drone-discovery") || state.scenarios[0];
      state.activeScenarioId = part1.id;
    }
  }

  async function pollHealth() {
    if (!state.user || !state.lab) return;
    try {
      const h = await api("lab/health");
      state.health = h.health;
      if (h.status && h.status !== state.lab.status) {
        await loadMe();
        return;
      }
      updateTelemetryPills();
    } catch {}
  }

  async function loadAdmin() {
    if (!state.user?.is_admin) return;
    state.adminState = await api("admin/state");
    renderMainView();
  }

  // --- Lightweight live header updates (no iframe reload!) ---
  function updateTelemetryPills() {
    const clock = document.getElementById("zulu-clock");
    if (clock) clock.textContent = zuluNow();
    const timer = document.getElementById("idle-timer");
    if (timer && state.lab) timer.textContent = "IDLE " + formatCountdown(state.lab.idleDeadline);
    if (!state.health) return;
    for (const [k, ok] of Object.entries(state.health)) {
      const dot = document.getElementById("dot-" + k);
      if (dot) dot.className = "dot " + (ok ? "ok" : "warn");
    }
  }

  setInterval(() => {
    updateTelemetryPills();
  }, 1000);

  setInterval(() => {
    if (state.user && state.lab) {
      if (state.lab.status === "booting" || state.lab.status === "stopping") loadMe();
      else pollHealth();
    }
  }, 4000);

  // --- Actions ---
  async function doAuth(kind) {
    state.authErr = "";
    const username = document.getElementById("auth-u")?.value.trim();
    const password = document.getElementById("auth-pw")?.value;
    const invite = document.getElementById("auth-inv")?.value.trim();
    const tos = document.getElementById("auth-tos")?.checked;
    try {
      await api(kind, { username, password, invite, tos });
      await loadMe();
    } catch (e) {
      state.authErr = e.message;
      const errEl = document.getElementById("auth-err");
      if (errEl) errEl.textContent = e.message;
    }
  }

  async function labAction(endpoint, label) {
    try {
      toast(label + "…");
      await api(endpoint, {});
      state.mountedLabId = null;
      await loadMe();
      toast(label + " complete");
    } catch (e) {
      toast("Error: " + e.message);
    }
  }

  async function toggleStep(scenarioId, stepIdx) {
    const sc = state.scenarios.find((s) => s.id === scenarioId);
    const cur = state.progress[scenarioId] || { steps: [], completedAt: null };
    const set = new Set(cur.steps || []);
    if (set.has(stepIdx)) set.delete(stepIdx);
    else set.add(stepIdx);
    const steps = [...set].sort((a, b) => a - b);
    const completed = sc && sc.steps.length > 0 && steps.length >= sc.steps.length;
    await api("progress", { scenarioId, steps, completed });
    state.progress[scenarioId] = { steps, completedAt: completed ? Date.now() : null };
    renderDrawerBody();
  }

  async function sendAi(customPrompt) {
    const input = document.getElementById("ai-prompt");
    const text = (customPrompt ?? input?.value ?? "").trim();
    if (!text || state.aiBusy) return;
    if (input && !customPrompt) input.value = "";
    state.aiMessages.push({ role: "user", text });
    state.aiBusy = true;
    renderDrawerBody();
    try {
      const sc = getActiveScenario();
      const res = await api("ai/chat", {
        message: text,
        scenarioId: sc?.id || null,
        modelTier: state.aiTier,
      });
      state.ai = res.quota || state.ai;
      state.aiMessages.push({
        role: "bot",
        text: res.reply,
        model: res.model,
        citations: res.citations || [],
      });
    } catch (e) {
      state.aiMessages.push({ role: "bot", text: "Error: " + e.message, citations: [] });
    } finally {
      state.aiBusy = false;
      renderDrawerBody();
      const box = document.getElementById("ai-msgs");
      if (box) box.scrollTop = box.scrollHeight;
    }
  }

  // --- Renderers ---
  function render() {
    const app = document.getElementById("app");
    if (!state.user) {
      state.mountedLabId = null;
      app.innerHTML = renderAuthGate();
      bindAuthEvents();
      return;
    }

    // Preserve live console iframes if already mounted on the same view & lab
    const existingConsole = document.getElementById("console-shell");
    if (
      state.view === "console" &&
      existingConsole &&
      state.lab?.status === "healthy" &&
      state.mountedLabId === state.lab.id
    ) {
      renderTopBar();
      renderDrawerBody();
      return;
    }

    app.innerHTML = `<header id="top-bar" class="cmd-bar"></header><div id="main-slot" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;"></div>`;
    renderTopBar();
    renderMainView();
  }

  function renderAuthGate() {
    return `
      <header class="cmd-bar">
        <div class="cmd-left"><span class="brand"><span class="brand-dot"></span>DVDRONE // CYBER RANGE</span></div>
        <div class="cmd-right"><span class="zulu-clock" id="zulu-clock">${zuluNow()}</span></div>
      </header>
      <div class="gate-wrap">
        <div class="gate-card reticle">
          <h1 class="gate-title">Operational Clearance</h1>
          <p class="gate-sub">Authorized Drone Security Training Range</p>
          <div id="auth-err" class="err-msg">${esc(state.authErr)}</div>
          <div class="field"><label>Callsign</label><input id="auth-u" type="text" placeholder="operator-01" autocomplete="username" /></div>
          <div class="field"><label>Passphrase</label><input id="auth-pw" type="password" placeholder="min 10 characters" autocomplete="current-password" /></div>
          <div class="field"><label>Invite Token (New Registration Only)</label><input id="auth-inv" type="text" placeholder="leave blank if returning" /></div>
          <div class="roe-box">
            <label>
              <input id="auth-tos" type="checkbox" />
              <span><strong>Rules of Engagement:</strong> I accept the Authorized Training &amp; Acceptable Use Agreement. I will restrict all offensive techniques exclusively to my assigned, egress-isolated simulator slot.</span>
            </label>
          </div>
          <div class="gate-actions">
            <button id="btn-login" class="btn-emerald">Authenticate</button>
            <button id="btn-register" class="btn-cyan">Register Token</button>
          </div>
        </div>
      </div>`;
  }

  function bindAuthEvents() {
    document.getElementById("btn-login")?.addEventListener("click", () => doAuth("login"));
    document.getElementById("btn-register")?.addEventListener("click", () => doAuth("register"));
    document.getElementById("auth-pw")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doAuth("login");
    });
  }

  function renderTopBar() {
    const bar = document.getElementById("top-bar");
    if (!bar) return;
    const lab = state.lab;
    const h = state.health || {};
    const statusClass = lab?.status === "healthy" ? "ok" : lab?.status === "error" ? "err" : "warn";

    bar.innerHTML = `
      <div class="cmd-left">
        <span class="brand"><span class="brand-dot"></span>DVDRONE // C2</span>
        <nav class="nav-tabs">
          <button class="nav-tab ${state.view === "console" ? "active" : ""}" data-nav="console">OPERATOR CONSOLE</button>
          <button class="nav-tab ${state.view === "dossier" ? "active" : ""}" data-nav="dossier">MISSIONS (${state.scenarios.length})</button>
          ${state.user.is_admin ? `<button class="nav-tab ${state.view === "admin" ? "active" : ""}" data-nav="admin">ADMIN C2</button>` : ""}
        </nav>
      </div>

      <div class="cmd-center">
        ${
          lab
            ? `
          <span class="pill"><span class="dot ${statusClass}"></span>SLOT-0${lab.slot} // ${esc(lab.status.toUpperCase())}</span>
          ${
            lab.status === "healthy"
              ? `
            <span class="pill"><span id="dot-sim" class="dot ${h.sim ? "ok" : "warn"}"></span>SIM :8000</span>
            <span class="pill"><span id="dot-admin" class="dot ${h.admin ? "ok" : "warn"}"></span>COMP :3000</span>
            <span class="pill"><span id="dot-gcs" class="dot ${h.gcs ? "ok" : "warn"}"></span>QGC :6080</span>
            <span class="pill"><span id="dot-term" class="dot ${h.term ? "ok" : "warn"}"></span>SHELL</span>
            <span class="pill" id="idle-timer">IDLE ${formatCountdown(lab.idleDeadline)}</span>
          `
              : ""
          }
        `
            : `<span class="pill"><span class="dot"></span>NO ACTIVE SLOT (${state.activeSlotCount}/${state.runtime?.maxSlots ?? 5} USED)</span>`
        }
      </div>

      <div class="cmd-right">
        <span class="zulu-clock" id="zulu-clock">${zuluNow()}</span>
        ${
          !lab
            ? `<button id="cmd-start" class="btn-emerald btn-sm">Launch Lab</button>`
            : `
          ${lab.status === "healthy" ? `<button id="cmd-reset-air" class="btn-amber btn-sm" title="Fast reset flight controller">Reset Airframe</button>` : ""}
          <button id="cmd-rebuild" class="btn-sm" title="Tear down and recreate slot containers">Rebuild</button>
          <button id="cmd-stop" class="btn-red btn-sm">Terminate</button>
        `
        }
        <span class="pill">${esc(state.user.username)}</span>
        <button id="cmd-logout" class="btn-sm">Logout</button>
      </div>`;

    bar.querySelectorAll("[data-nav]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.view = btn.dataset.nav;
        state.mountedLabId = null;
        renderTopBar();
        renderMainView();
        if (state.view === "admin") loadAdmin();
      })
    );
    document.getElementById("cmd-start")?.addEventListener("click", () => labAction("lab/start", "Provisioning lab slot"));
    document.getElementById("cmd-reset-air")?.addEventListener("click", () => labAction("lab/reset-airframe", "Resetting airframe"));
    document.getElementById("cmd-rebuild")?.addEventListener("click", () => {
      if (confirm("Rebuild this lab slot from scratch? Active terminal processes will stop.")) {
        labAction("lab/reset", "Rebuilding slot");
      }
    });
    document.getElementById("cmd-stop")?.addEventListener("click", () => {
      if (confirm("Terminate your active lab slot?")) labAction("lab/stop", "Terminating slot");
    });
    document.getElementById("cmd-logout")?.addEventListener("click", async () => {
      await api("logout", {});
      state.user = null;
      state.lab = null;
      render();
    });
  }

  function renderMainView() {
    const slot = document.getElementById("main-slot");
    if (!slot) return;
    if (state.view === "dossier") {
      slot.innerHTML = renderDossier();
      bindDossierEvents();
    } else if (state.view === "admin") {
      slot.innerHTML = renderAdmin();
      bindAdminEvents();
    } else {
      slot.innerHTML = renderConsole();
      bindConsoleEvents();
      renderDrawerBody();
    }
  }

  // --- Dossier View ---
  function renderDossier() {
    const part1List = state.scenarios
      .filter((s) => s.part1Track)
      .sort((a, b) => a.part1Order - b.part1Order);
    const completedCount = state.scenarios.filter((s) => state.progress[s.id]?.completedAt).length;

    const filtered = state.scenarios.filter((s) => {
      if (state.phaseFilter === "PART 1" && !s.part1Track) return false;
      if (state.phaseFilter !== "ALL" && state.phaseFilter !== "PART 1" && s.phase !== state.phaseFilter) return false;
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        if (!s.title.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q) && !s.phase.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });

    return `
      <div class="dossier-wrap">
        <div class="dossier-inner">
          <div class="part1-banner reticle">
            <div>
              <div class="tag cyan" style="display:inline-block;margin-bottom:6px;">FEATURED OPERATION // FIELD MANUAL PART 1</div>
              <h2>Damn Vulnerable Drone — Part 1 Guided Track</h2>
              <p>Follow the Field Manual progression: Recon &amp; Discovery → Companion Web/API → Track B ROS 2 Camera Flood DoS → MAVLink Command Injection → Track C Grounded AI Copilot (${part1List.length} core missions · ${completedCount}/${state.scenarios.length} total completed).</p>
            </div>
            <button id="btn-start-part1" class="btn-cyan">Open Part 1 Track</button>
          </div>

          <div class="filter-bar">
            ${PHASES.map(
              (p) => `<button class="chip-filter ${state.phaseFilter === p ? "active" : ""}" data-phase="${esc(p)}">${esc(p)}</button>`
            ).join("")}
            <input id="mission-search" type="text" placeholder="Filter 42 scenarios..." value="${esc(state.searchQuery)}" />
          </div>

          <div class="mission-grid">
            ${filtered
              .map((s) => {
                const prog = state.progress[s.id];
                const total = Math.max(s.steps.length, 1);
                const done = prog?.steps?.length || 0;
                const pct = prog?.completedAt ? 100 : Math.min(100, Math.round((done / total) * 100));
                const isWifi = s.runtime === "wifi-linux";
                return `
                  <div class="m-card ${prog?.completedAt ? "done" : ""}" data-open-scenario="${esc(s.id)}">
                    <div class="m-meta">
                      <span class="tag cyan">${esc(s.phase)}</span>
                      <span class="tag ${isWifi ? "amber" : "emerald"}">${isWifi ? "LINUX WI-FI" : "LITE READY"}</span>
                      <span class="tag">${esc(s.difficulty)}</span>
                    </div>
                    ${s.part1Track ? `<div style="font-size:10px;color:var(--cyan);letter-spacing:.08em;">★ ${esc(s.part1Track)}</div>` : ""}
                    <h3 class="m-title">${esc(s.title)}</h3>
                    <p class="m-desc">${esc(s.description)}</p>
                    <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted);">
                      <span>${done}/${s.steps.length} steps</span>
                      <span>${prog?.completedAt ? "COMPLETED" : pct + "%"}</span>
                    </div>
                    <div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>
                  </div>`;
              })
              .join("")}
          </div>
        </div>
      </div>`;
  }

  function bindDossierEvents() {
    document.querySelectorAll("[data-phase]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.phaseFilter = btn.dataset.phase;
        renderMainView();
      })
    );
    document.getElementById("mission-search")?.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      renderMainView();
      const inp = document.getElementById("mission-search");
      if (inp) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    });
    document.getElementById("btn-start-part1")?.addEventListener("click", () => {
      state.phaseFilter = "PART 1";
      renderMainView();
    });
    document.querySelectorAll("[data-open-scenario]").forEach((card) =>
      card.addEventListener("click", () => {
        state.activeScenarioId = card.dataset.openScenario;
        state.view = "console";
        state.drawerOpen = true;
        state.drawerTab = "mission";
        state.mountedLabId = null;
        renderTopBar();
        renderMainView();
      })
    );
  }

  // --- Operator Console View ---
  function renderConsole() {
    const lab = state.lab;
    const healthy = lab?.status === "healthy";
    if (healthy) state.mountedLabId = lab.id;
    const ips = lab?.ips;
    const activeUrl = healthy ? lab.urls[state.targetTab] || lab.urls.sim : "";

    return `
      <div id="console-shell" class="console-wrap">
        <div class="console-main">
          <div class="viewport-pane">
            <div class="pane-bar">
              <div class="tab-group">
                <button class="tab-btn ${state.targetTab === "sim" ? "active" : ""}" data-target="sim">SIMULATOR :8000</button>
                <button class="tab-btn ${state.targetTab === "admin" ? "active" : ""}" data-target="admin">COMPANION :3000</button>
                <button class="tab-btn ${state.targetTab === "gcs" ? "active" : ""}" data-target="gcs">QGROUNDCONTROL (noVNC)</button>
              </div>
              <div class="ip-chips">
                ${
                  ips
                    ? `
                  <span class="ip-chip" data-copy="${ips.fc}" title="Copy Flight Controller IP">FC <b>${ips.fc}</b></span>
                  <span class="ip-chip" data-copy="${ips.companion}" title="Copy Companion IP">COMP <b>${ips.companion}</b></span>
                  <span class="ip-chip" data-copy="${ips.gcs}" title="Copy GCS IP">GCS <b>${ips.gcs}</b></span>
                  <span class="ip-chip" data-copy="${ips.sim}" title="Copy Simulator IP">SIM <b>${ips.sim}</b></span>
                  <span class="ip-chip" data-copy="${ips.subnet}" title="Copy Subnet">NET <b>${ips.subnet}</b></span>
                `
                    : ""
                }
                ${healthy ? `<button id="btn-reload-target" class="btn-sm" title="Reload active target frame">↻</button>` : ""}
                ${healthy ? `<a href="${esc(activeUrl)}" target="_blank"><button class="btn-sm" title="Open in new tab">↗</button></a>` : ""}
                <button id="btn-toggle-drawer" class="btn-sm btn-cyan">${state.drawerOpen ? "Hide Drawer" : "Missions & AI"}</button>
              </div>
            </div>
            <div class="frame-host">
              ${
                healthy
                  ? `<iframe id="target-frame" src="${esc(activeUrl)}"></iframe>`
                  : `<div class="empty-state">
                      <h3>${lab?.status === "booting" ? "Provisioning Isolated Drone Stack…" : lab?.status === "error" ? "Slot Provisioning Failed" : "No Active Lab Slot"}</h3>
                      <p style="max-width:460px;">
                        ${
                          lab?.status === "booting"
                            ? `Booting Slot-0${lab.slot} (Flight Controller SITL, Companion Computer, QGroundControl noVNC, Simulator, and ROS 2 AttackBox). Typically ready in 30–60 seconds.`
                            : "Launch an isolated Damn Vulnerable Drone slot to access the live Simulator, Companion Panel, QGroundControl, and pre-baked ROS 2 AttackBox terminal."
                        }
                      </p>
                      ${!lab ? `<button id="empty-launch" class="btn-emerald">Launch Isolated Lab Slot</button>` : ""}
                    </div>`
              }
            </div>
          </div>

          <div id="h-resizer" class="h-resizer" title="Drag to resize terminal"></div>

          <div id="term-pane" class="term-pane ${state.termCollapsed ? "collapsed" : ""}">
            <div class="pane-bar">
              <div class="tab-group" style="align-items:center;gap:8px;">
                <span style="font-size:11px;letter-spacing:.1em;color:var(--emerald);">● ATTACKBOX TERMINAL (ROS 2 HUMBLE // ZERO EGRESS)</span>
                ${
                  ips
                    ? `
                  <button class="btn-sm" data-copy="nmap -sn ${ips.subnet}">Copy Recon</button>
                  <button class="btn-sm" data-copy="mavproxy.py --master=tcp:${ips.companion}:5760">Copy MAVProxy</button>
                  <button class="btn-sm" data-copy="ros2 topic list">Copy ROS2 List</button>
                `
                    : ""
                }
              </div>
              <div style="display:flex;gap:6px;">
                ${healthy ? `<a href="${esc(lab.urls.term)}" target="_blank"><button class="btn-sm">Popout ↗</button></a>` : ""}
                <button id="btn-toggle-term" class="btn-sm">${state.termCollapsed ? "Expand" : "Collapse"}</button>
              </div>
            </div>
            <div class="frame-host">
              ${
                healthy
                  ? `<iframe id="term-frame" src="${esc(lab.urls.term)}"></iframe>`
                  : `<div class="empty-state" style="font-size:12px;">Terminal attaches automatically once your lab slot is healthy.</div>`
              }
            </div>
          </div>
        </div>

        <div id="v-resizer" class="v-resizer ${state.drawerOpen ? "" : "hidden"}"></div>

        <aside id="right-drawer" class="drawer ${state.drawerOpen ? "" : "hidden"}">
          <div class="pane-bar">
            <div class="tab-group">
              <button class="tab-btn ${state.drawerTab === "mission" ? "active" : ""}" data-dtab="mission">MISSION BRIEF</button>
              <button class="tab-btn ${state.drawerTab === "ai" ? "active" : ""}" data-dtab="ai">TACTICAL AI (TRACK C)</button>
            </div>
            <button id="btn-browse-missions" class="btn-sm">All 42</button>
          </div>
          <div id="drawer-body" class="drawer-body"></div>
        </aside>
      </div>`;
  }

  function bindConsoleEvents() {
    document.querySelectorAll("[data-target]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.targetTab = btn.dataset.target;
        document.querySelectorAll("[data-target]").forEach((b) => b.classList.toggle("active", b.dataset.target === state.targetTab));
        const frame = document.getElementById("target-frame");
        if (frame && state.lab?.urls) frame.src = state.lab.urls[state.targetTab];
      })
    );

    document.getElementById("btn-reload-target")?.addEventListener("click", () => {
      const frame = document.getElementById("target-frame");
      if (frame) frame.src = frame.src;
    });

    document.getElementById("empty-launch")?.addEventListener("click", () => labAction("lab/start", "Provisioning lab slot"));

    document.querySelectorAll("[data-copy]").forEach((el) =>
      el.addEventListener("click", () => copyText(el.dataset.copy, "Copied: " + el.dataset.copy))
    );

    document.getElementById("btn-toggle-drawer")?.addEventListener("click", () => {
      state.drawerOpen = !state.drawerOpen;
      document.getElementById("right-drawer")?.classList.toggle("hidden", !state.drawerOpen);
      document.getElementById("v-resizer")?.classList.toggle("hidden", !state.drawerOpen);
      const b = document.getElementById("btn-toggle-drawer");
      if (b) b.textContent = state.drawerOpen ? "Hide Drawer" : "Missions & AI";
    });

    document.getElementById("btn-toggle-term")?.addEventListener("click", () => {
      state.termCollapsed = !state.termCollapsed;
      document.getElementById("term-pane")?.classList.toggle("collapsed", state.termCollapsed);
      const b = document.getElementById("btn-toggle-term");
      if (b) b.textContent = state.termCollapsed ? "Expand" : "Collapse";
    });

    document.querySelectorAll("[data-dtab]").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.drawerTab = btn.dataset.dtab;
        document.querySelectorAll("[data-dtab]").forEach((b) => b.classList.toggle("active", b.dataset.dtab === state.drawerTab));
        renderDrawerBody();
      })
    );

    document.getElementById("btn-browse-missions")?.addEventListener("click", () => {
      state.view = "dossier";
      state.mountedLabId = null;
      renderTopBar();
      renderMainView();
    });

    // Drag resize handlers (with iframe pointer-events shield)
    const shieldIframes = (on) => document.querySelectorAll("iframe").forEach((f) => (f.style.pointerEvents = on ? "none" : ""));
    const hRes = document.getElementById("h-resizer");
    if (hRes) {
      hRes.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        shieldIframes(true);
        const term = document.getElementById("term-pane");
        const startY = ev.clientY;
        const startH = term.getBoundingClientRect().height;
        const onMove = (e) => {
          const next = Math.max(110, Math.min(window.innerHeight - 240, startH + (startY - e.clientY)));
          term.style.height = next + "px";
        };
        const onUp = () => {
          shieldIframes(false);
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    }

    const vRes = document.getElementById("v-resizer");
    if (vRes) {
      vRes.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        shieldIframes(true);
        const drawer = document.getElementById("right-drawer");
        const startX = ev.clientX;
        const startW = drawer.getBoundingClientRect().width;
        const onMove = (e) => {
          const next = Math.max(280, Math.min(680, startW + (startX - e.clientX)));
          drawer.style.width = next + "px";
        };
        const onUp = () => {
          shieldIframes(false);
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    }
  }

  function renderDrawerBody() {
    const body = document.getElementById("drawer-body");
    if (!body) return;

    if (state.drawerTab === "ai") {
      body.style.padding = "0";
      body.innerHTML = renderAiPanel();
      bindAiEvents();
      return;
    }

    body.style.padding = "14px";
    const sc = getActiveScenario();
    if (!sc) {
      body.innerHTML = `<p style="color:var(--muted)">No scenarios loaded.</p>`;
      return;
    }

    const prog = state.progress[sc.id] || { steps: [], completedAt: null };
    const doneSet = new Set(prog.steps || []);

    body.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;">
        <select id="scenario-select" style="flex:1;padding:6px;">
          ${state.scenarios
            .map(
              (s) =>
                `<option value="${esc(s.id)}" ${s.id === sc.id ? "selected" : ""}>[${esc(s.phase)}] ${esc(s.title)}</option>`
            )
            .join("")}
        </select>
        <button id="btn-toggle-ipmode" class="btn-sm" title="Toggle $DRONE_*_IP vs live slot IPs">${state.resolveIps ? "Live IPs" : "Raw Vars"}</button>
      </div>

      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
        <span class="tag cyan">${esc(sc.phase)}</span>
        <span class="tag ${sc.runtime === "wifi-linux" ? "amber" : "emerald"}">${sc.runtime === "wifi-linux" ? "LINUX WI-FI ONLY" : "LITE READY"}</span>
        <span class="tag">${esc(sc.difficulty)}</span>
        ${sc.part1Track ? `<span class="tag cyan">★ ${esc(sc.part1Track)}</span>` : ""}
      </div>

      <h3 style="font-family:var(--font-sans);margin:6px 0;font-size:15px;">${esc(sc.title)}</h3>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px;white-space:pre-wrap;">${esc(resolveVars(sc.overview))}</div>

      ${sc.steps
        .map((st, idx) => {
          const checked = doneSet.has(idx);
          const resolvedDesc = resolveVars(st.description).replace(/```[\s\S]*?```/g, "").trim();
          const cmds = (st.commands || []).map((c) => resolveVars(c));
          return `
            <div class="step-card">
              <label class="step-head">
                <input type="checkbox" data-step="${idx}" ${checked ? "checked" : ""} />
                <span class="step-title" style="${checked ? "text-decoration:line-through;color:var(--muted);" : ""}">${esc(st.title)}</span>
              </label>
              <div class="step-body">${esc(resolvedDesc)}</div>
              ${cmds
                .map(
                  (cmd, cIdx) => `
                  <div class="cmd-block">
                    <button class="cmd-copy" data-cmd-copy="${idx}-${cIdx}">Copy</button>${esc(cmd)}
                  </div>`
                )
                .join("")}
            </div>`;
        })
        .join("")}

      <div class="defense-box">
        <b>Defensive Takeaway</b>
        ${esc(sc.defensiveTakeaway)}
      </div>
    `;

    document.getElementById("scenario-select")?.addEventListener("change", (e) => {
      state.activeScenarioId = e.target.value;
      renderDrawerBody();
    });
    document.getElementById("btn-toggle-ipmode")?.addEventListener("click", () => {
      state.resolveIps = !state.resolveIps;
      renderDrawerBody();
    });
    body.querySelectorAll("[data-step]").forEach((cb) =>
      cb.addEventListener("change", () => toggleStep(sc.id, Number(cb.dataset.step)))
    );
    body.querySelectorAll("[data-cmd-copy]").forEach((btn) => {
      const [sIdx, cIdx] = btn.dataset.cmdCopy.split("-").map(Number);
      const rawCmd = resolveVars(sc.steps[sIdx]?.commands?.[cIdx] || "");
      btn.addEventListener("click", () => copyText(rawCmd, "Command copied — paste into AttackBox terminal"));
    });
  }

  function renderAiPanel() {
    const ai = state.ai || { configured: false, models: { fast: "deepseek-chat", pro: "deepseek-reasoner" }, remainingToday: 0, limitToday: 40, indexedChunks: 0 };
    const sc = getActiveScenario();
    return `
      <div class="ai-wrap">
        <div class="ai-bar">
          <div>
            <span class="dot ${ai.configured ? "ok" : "warn"}"></span>
            ${ai.configured ? `DEEPSEEK // ${ai.remainingToday}/${ai.limitToday} LEFT` : `LOCAL BM25 RAG (${ai.indexedChunks} DOCS)`}
          </div>
          <select id="ai-tier" style="padding:2px 6px;font-size:11px;">
            <option value="fast" ${state.aiTier === "fast" ? "selected" : ""}>FAST (${esc(ai.models.fast)})</option>
            <option value="pro" ${state.aiTier === "pro" ? "selected" : ""}>PRO (${esc(ai.models.pro)})</option>
          </select>
        </div>

        <div id="ai-msgs" class="ai-msgs">
          ${
            !state.aiMessages.length
              ? `<div class="msg bot"><strong>Tactical AI Copilot (Track C)</strong>\nGrounded in all 42 DVD scenarios + Part 1 Field Manual + your live slot IPs.${
                  !ai.configured
                    ? "\n\nNote: Set <code>AI_API_KEY</code> in <code>.env</code> to enable DeepSeek synthesis. Until then, queries search the local BM25 knowledge base."
                    : ""
                }</div>`
              : state.aiMessages
                  .map(
                    (m) => `
                  <div class="msg ${m.role}">
                    <div>${esc(m.text)}</div>
                    ${
                      m.citations?.length
                        ? `<div class="cites">${m.citations
                            .map((c) => `<span class="cite-chip" title="${esc(c.excerpt)}">[${c.index}] ${esc(c.source)}</span>`)
                            .join("")}</div>`
                        : ""
                    }
                  </div>`
                  )
                  .join("")
          }
          ${state.aiBusy ? `<div class="msg bot" style="color:var(--cyan);">Querying knowledge base &amp; model…</div>` : ""}
        </div>

        <div class="ai-quick">
          <button data-q="Explain the active scenario (${esc(sc?.title || "Drone Discovery")}) and exact commands for my slot">Explain Active</button>
          <button data-q="Why are there 4 different drone IPs in my subnet and what runs on each?">Why these IPs?</button>
          <button data-q="How do I run the Track B ROS 2 camera topic flood attack in my AttackBox?">Track B Camera DoS</button>
          <button data-q="What defensive controls stop ${esc(sc?.title || "MAVLink injection")}?">Defenses</button>
        </div>

        <div class="ai-input">
          <textarea id="ai-prompt" placeholder="Ask grounded question about DVD, your slot IPs, or next move…"></textarea>
          <button id="ai-send" class="btn-emerald" ${state.aiBusy ? "disabled" : ""}>Send</button>
        </div>
      </div>`;
  }

  function bindAiEvents() {
    document.getElementById("ai-tier")?.addEventListener("change", (e) => {
      state.aiTier = e.target.value;
    });
    document.getElementById("ai-send")?.addEventListener("click", () => sendAi());
    document.getElementById("ai-prompt")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendAi();
      }
    });
    document.querySelectorAll("[data-q]").forEach((btn) =>
      btn.addEventListener("click", () => sendAi(btn.dataset.q))
    );
  }

  // --- Admin C2 View ---
  function renderAdmin() {
    const a = state.adminState;
    if (!a) return `<div class="admin-wrap"><p style="color:var(--muted);">Loading Admin C2 telemetry…</p></div>`;
    return `
      <div class="admin-wrap">
        <div class="admin-grid">
          <div class="card reticle">
            <h3>Invite Tokens</h3>
            <div style="display:flex;gap:8px;margin-bottom:12px;">
              <input id="inv-uses" type="number" min="1" max="50" value="1" style="width:70px;padding:5px;" />
              <button id="btn-mint-inv" class="btn-emerald">Mint Invite</button>
            </div>
            <table>
              <thead><tr><th>Code</th><th>Uses</th><th>State</th><th></th></tr></thead>
              <tbody>
                ${a.invites
                  .map(
                    (i) => `
                  <tr>
                    <td><code style="color:var(--cyan);cursor:pointer;" data-copy="${esc(i.code)}">${esc(i.code)}</code></td>
                    <td>${i.uses}/${i.max_uses}</td>
                    <td>${i.revoked ? "REVOKED" : i.uses >= i.max_uses ? "EXHAUSTED" : "ACTIVE"}</td>
                    <td>${!i.revoked ? `<button class="btn-sm btn-red" data-revoke="${esc(i.code)}">Revoke</button>` : ""}</td>
                  </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>

          <div class="card reticle">
            <h3>Active Lab Slots (${a.labs.length}/${state.runtime?.maxSlots ?? 5})</h3>
            <table>
              <thead><tr><th>Slot</th><th>Operator</th><th>Status</th><th></th></tr></thead>
              <tbody>
                ${
                  a.labs.length
                    ? a.labs
                        .map(
                          (l) => `
                      <tr>
                        <td>SLOT-0${l.slot}</td>
                        <td>${esc(l.username || l.user_id)}</td>
                        <td>${esc(l.status)}</td>
                        <td><button class="btn-sm btn-red" data-kill="${esc(l.id)}">Force Kill</button></td>
                      </tr>`
                        )
                        .join("")
                    : `<tr><td colspan="4" style="color:var(--muted);">No active slots.</td></tr>`
                }
              </tbody>
            </table>
          </div>

          <div class="card reticle" style="grid-column:1 / -1;">
            <h3>Recent Audit Log</h3>
            <table>
              <thead><tr><th>Time (UTC)</th><th>Operator</th><th>Event</th><th>Detail</th></tr></thead>
              <tbody>
                ${a.audit
                  .map(
                    (ev) => `
                  <tr>
                    <td>${new Date(ev.ts).toISOString().replace("T", " ").slice(0, 19)}</td>
                    <td>${esc(ev.username || ev.user_id || "-")}</td>
                    <td>${esc(ev.event)}</td>
                    <td style="color:var(--muted);">${esc(ev.detail)}</td>
                  </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  function bindAdminEvents() {
    document.getElementById("btn-mint-inv")?.addEventListener("click", async () => {
      const maxUses = Number(document.getElementById("inv-uses")?.value || 1);
      const { code } = await api("admin/invites", { maxUses });
      await copyText(code, "Minted & copied invite: " + code);
      loadAdmin();
    });
    document.querySelectorAll("[data-revoke]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await api("admin/invites/" + btn.dataset.revoke, undefined, "DELETE");
        loadAdmin();
      })
    );
    document.querySelectorAll("[data-kill]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await api("admin/labs/" + btn.dataset.kill + "/kill", {});
        toast("Slot terminated");
        loadAdmin();
        loadMe();
      })
    );
    document.querySelectorAll("[data-copy]").forEach((el) =>
      el.addEventListener("click", () => copyText(el.dataset.copy, "Copied invite: " + el.dataset.copy))
    );
  }

  loadMe();
})();
