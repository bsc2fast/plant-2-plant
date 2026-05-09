// plant-2-plant studio — frontend.
// All rendering imperative; state in module-globals; no framework.

// ─── State ──────────────────────────────────────────────────────────────
const State = {
  plants: [],
  currentId: null,
  tab: 'conversation',
  listening: false,
  status: 'idle',                 // idle | listening | thinking | speaking | error
  sensors: { temp_c: 22, humidity_pct: 55 },
  interim: '',                    // live STT interim transcription
  recognition: null,
  health: null,
};

const TABS = [
  { id: 'conversation', label: 'Conversation', icon: 'fa-comment-dots' },
  { id: 'biology',      label: 'Biology',      icon: 'fa-dna' },
  { id: 'personality',  label: 'Personality',  icon: 'fa-mask' },
  { id: 'memory',       label: 'Memory',       icon: 'fa-brain' },
  { id: 'sensors',      label: 'Sensors',      icon: 'fa-temperature-half' },
  { id: 'deploy',       label: 'Deploy',       icon: 'fa-raspberry-pi' },
];

// ─── API ─────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const url = method === 'GET' ? `${path}${path.includes('?') ? '&' : '?'}t=${Date.now()}` : path;
  const r = await fetch(url, opts);
  let json;
  try { json = await r.json(); } catch { json = {}; }
  if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
  return json;
}

// ─── Toasts ──────────────────────────────────────────────────────────────
function toast(msg, kind = 'info', ms = 3000) {
  const rail = document.getElementById('toastRail');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  rail.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ─── Health / boot ───────────────────────────────────────────────────────
async function loadHealth() {
  try {
    State.health = await api('GET', '/api/health');
  } catch (e) {
    State.health = { ok: false };
  }
  const el = document.getElementById('keyStatus');
  if (State.health?.anthropic_key) {
    el.className = 'key-status ok';
    el.innerHTML = `<i class="fa-solid fa-key"></i> LLM key set · ${State.health.model}`;
  } else {
    el.className = 'key-status bad';
    el.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ANTHROPIC_API_KEY not set`;
  }
}

async function loadPlants() {
  try {
    const { plants } = await api('GET', '/api/plants');
    State.plants = plants;
  } catch (e) {
    toast(`failed to load plants: ${e.message}`, 'error');
    State.plants = [];
  }
  renderSidebar();
  if (State.plants.length === 0) {
    State.currentId = null;
  } else if (!State.currentId || !State.plants.find(p => p.id === State.currentId)) {
    State.currentId = State.plants[0].id;
  }
  renderMain();
}

function getPlant() {
  return State.plants.find(p => p.id === State.currentId);
}

function selectPlant(id) {
  State.currentId = id;
  State.interim = '';
  setStatus('idle');
  history.replaceState(null, '', `#${id}`);
  renderSidebar();
  renderMain();
}

function setTab(id) {
  State.tab = id;
  renderMain();
}

function setStatus(s) {
  State.status = s;
  const strip = document.querySelector('.status-strip');
  if (strip) {
    strip.dataset.status = s;
    strip.querySelector('.status-text').textContent = statusLabel(s);
  }
  // sidebar card
  document.querySelectorAll('.plant-card').forEach(c => {
    c.classList.toggle('live', c.dataset.id === State.currentId && s !== 'idle');
    const dot = c.querySelector('.status-dot');
    if (dot) dot.className = `status-dot ${s}`;
  });
}

function statusLabel(s) {
  return ({
    idle: 'idle',
    listening: 'listening…',
    thinking: 'thinking…',
    speaking: 'speaking…',
    error: 'error',
  })[s] || s;
}

// ─── Sidebar render ─────────────────────────────────────────────────────
function renderSidebar() {
  const cards = document.getElementById('plantCards');
  if (State.plants.length === 0) {
    cards.innerHTML = `<div class="muted" style="padding:14px;font-size:13px;text-align:center">no plants yet</div>`;
    return;
  }
  cards.innerHTML = State.plants.map(p => `
    <button class="plant-card ${p.id === State.currentId ? 'active' : ''}" data-id="${p.id}" onclick="selectPlant('${p.id}')">
      <i class="fa-solid fa-leaf pleaf"></i>
      <span class="status-dot"></span>
      <div class="row1">
        <div class="pname">${escapeHtml(p.biology.common_name)}</div>
      </div>
      <div class="pspecies">${escapeHtml(p.biology.species || '—')}</div>
      <div class="pmood">${escapeHtml(p.mood?.current || 'unknown')}</div>
    </button>
  `).join('');
}

// ─── Main render ────────────────────────────────────────────────────────
function renderMain() {
  const root = document.getElementById('mainContent');
  const p = getPlant();
  if (!p) {
    root.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-seedling big-leaf"></i>
        <h2>No plant selected</h2>
        <p class="muted">Add a plant from the sidebar to begin.</p>
      </div>`;
    return;
  }
  root.innerHTML = `
    ${renderHero(p)}
    ${renderTabBar()}
    <div class="tab-content"><div class="panel">${renderTab(p)}</div></div>
  `;
  attachTabHandlers(p);
}

function renderHero(p) {
  const mood = p.mood?.current || 'content';
  const moodClass = mood === 'distressed' ? 'mood-distressed'
                  : mood === 'grumpy'     ? 'mood-grumpy'
                  : mood === 'sleeping'   ? 'mood-sleeping'
                  : 'mood-content';
  const sleeping = isSleeping(p);
  return `
    <div class="hero">
      <div class="row">
        <div>
          <h2>${escapeHtml(p.biology.common_name)}</h2>
          <div class="species">${escapeHtml(p.biology.species || '—')} · <span class="muted">${escapeHtml(p.biology.native_range || '')}</span></div>
        </div>
        <div class="badges">
          <span class="badge ${moodClass}"><i class="fa-solid fa-circle"></i> ${escapeHtml(mood)}</span>
          ${sleeping ? `<span class="badge mood-sleeping"><i class="fa-solid fa-moon"></i> sleeping</span>` : `<span class="badge"><i class="fa-solid fa-sun"></i> awake</span>`}
          ${p.personality ? `<span class="badge"><i class="fa-solid fa-mask"></i> persona ✓</span>` : `<span class="badge mood-grumpy"><i class="fa-solid fa-mask"></i> no persona</span>`}
        </div>
      </div>
      <div class="status-strip" data-status="${State.status}">
        <span class="dot"></span>
        <span class="status-text">${statusLabel(State.status)}</span>
        <span style="margin-left:auto;font-size:11px">v${p.version} · last update ${shortTs(p.updated_at)}</span>
      </div>
    </div>
  `;
}

function renderTabBar() {
  return `
    <div class="tab-bar">
      ${TABS.map(t => `
        <button class="tab ${State.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
          <i class="fa-solid ${t.icon}"></i> ${t.label}
        </button>
      `).join('')}
    </div>
  `;
}

function attachTabHandlers(plant) {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.onclick = () => setTab(btn.dataset.tab);
  });
  // Tab-specific wiring
  if (State.tab === 'conversation') wireConversation(plant);
  if (State.tab === 'biology') wireBiology(plant);
  if (State.tab === 'personality') wirePersonality(plant);
  if (State.tab === 'sensors') wireSensors(plant);
}

// ─── Conversation tab ───────────────────────────────────────────────────
function renderTab(plant) {
  switch (State.tab) {
    case 'conversation': return renderConversation(plant);
    case 'biology':      return renderBiology(plant);
    case 'personality':  return renderPersonality(plant);
    case 'memory':       return renderMemory(plant);
    case 'sensors':      return renderSensors(plant);
    case 'deploy':       return renderDeploy(plant);
  }
  return '';
}

function renderConversation(p) {
  if (!p.personality) {
    return `
      <div class="no-personality">
        <p><strong>${escapeHtml(p.biology.common_name)}</strong> doesn't have a persona yet.</p>
        <p>Open the <a href="#" onclick="setTab('personality');return false">Personality</a> tab and derive one from this plant's biology.</p>
      </div>
    `;
  }
  const recent = (p.memory || []).slice(-12);
  const bubbles = recent.map(m => {
    if (m.kind === 'silent') return `<div class="bubble silent">${escapeHtml(p.biology.common_name)} stayed silent.</div>`;
    return `<div class="bubble ${m.kind}">${escapeHtml(m.text)}<span class="ts">${shortTs(m.ts)}</span></div>`;
  }).join('');
  const interim = State.interim ? `<div class="bubble interim">${escapeHtml(State.interim)}</div>` : '';
  const llmReady = State.health?.anthropic_key;
  return `
    <div class="talk-area">
      <button class="talk-button ${State.listening ? 'listening' : ''} ${llmReady ? '' : 'disabled'}" id="talkBtn"
              ${llmReady ? '' : 'disabled title="ANTHROPIC_API_KEY not set"'}>
        <i class="fa-solid ${State.listening ? 'fa-stop' : 'fa-microphone'}"></i>
      </button>
      <div class="talk-hint">${State.listening ? 'click to stop' : 'click to talk'}</div>
      <form class="text-input-row" id="textForm" onsubmit="return false">
        <input type="text" id="textInput" placeholder="…or type to ${escapeHtml(p.biology.common_name)}" ${llmReady ? '' : 'disabled'} />
        <button type="submit" ${llmReady ? '' : 'disabled'}>send</button>
      </form>
    </div>
    <div class="bubbles">${bubbles}${interim}</div>
  `;
}

function wireConversation(plant) {
  const btn = document.getElementById('talkBtn');
  if (btn) btn.onclick = () => toggleListen(plant);
  const form = document.getElementById('textForm');
  if (form) {
    form.onsubmit = e => {
      e.preventDefault();
      const inp = document.getElementById('textInput');
      const text = inp.value.trim();
      if (!text) return false;
      inp.value = '';
      plantTalk(plant, text);
      return false;
    };
  }
}

// ─── Voice ──────────────────────────────────────────────────────────────
function ensureRecognition() {
  if (State.recognition) return State.recognition;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast('SpeechRecognition not available in this browser; use Chrome.', 'error');
    return null;
  }
  const r = new SR();
  r.continuous = false;
  r.interimResults = true;
  r.lang = 'en-US';
  r.onresult = e => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const s = e.results[i];
      if (s.isFinal) final += s[0].transcript;
      else interim += s[0].transcript;
    }
    State.interim = (final + ' ' + interim).trim();
    const cont = document.querySelector('.bubbles');
    if (cont) {
      let live = cont.querySelector('.bubble.interim');
      if (!live) {
        live = document.createElement('div');
        live.className = 'bubble interim';
        cont.appendChild(live);
      }
      live.textContent = State.interim;
    }
    if (final) {
      State._lastFinal = (State._lastFinal || '') + ' ' + final;
    }
  };
  r.onend = () => {
    State.listening = false;
    State.interim = '';
    setStatus('idle');
    const text = (State._lastFinal || '').trim();
    State._lastFinal = '';
    document.querySelectorAll('.bubble.interim').forEach(n => n.remove());
    const btn = document.getElementById('talkBtn');
    if (btn) {
      btn.classList.remove('listening');
      btn.querySelector('i').className = 'fa-solid fa-microphone';
    }
    document.querySelectorAll('.talk-hint').forEach(h => h.textContent = 'click to talk');
    if (text) {
      const p = getPlant();
      if (p) plantTalk(p, text);
    }
  };
  r.onerror = e => {
    toast(`speech error: ${e.error}`, 'error');
    State.listening = false;
    setStatus('idle');
  };
  State.recognition = r;
  return r;
}

function toggleListen(plant) {
  const r = ensureRecognition();
  if (!r) return;
  if (State.listening) {
    try { r.stop(); } catch {}
    return;
  }
  // cancel any ongoing TTS first
  window.speechSynthesis.cancel();
  State._lastFinal = '';
  State.interim = '';
  try {
    r.start();
    State.listening = true;
    setStatus('listening');
    const btn = document.getElementById('talkBtn');
    if (btn) {
      btn.classList.add('listening');
      btn.querySelector('i').className = 'fa-solid fa-stop';
    }
    document.querySelectorAll('.talk-hint').forEach(h => h.textContent = 'click to stop');
  } catch (e) {
    toast(`could not start listening: ${e.message}`, 'error');
  }
}

async function plantTalk(plant, text) {
  setStatus('thinking');
  // optimistic add to bubbles
  appendBubble({ kind: 'heard', text, ts: new Date().toISOString() });
  try {
    const { reply, spoke, plant: updated } = await api('POST', `/api/plants/${plant.id}/talk`, {
      text,
      sensors: State.sensors,
    });
    // update plant cache
    const i = State.plants.findIndex(p => p.id === updated.id);
    if (i >= 0) State.plants[i] = updated;
    if (spoke) {
      appendBubble({ kind: 'spoke', text: reply, ts: new Date().toISOString() });
      speakText(reply, updated);
    } else {
      appendBubble({ kind: 'silent' });
      setStatus('idle');
    }
  } catch (e) {
    toast(`talk failed: ${e.message}`, 'error');
    setStatus('error');
    setTimeout(() => setStatus('idle'), 1500);
  }
}

function appendBubble(b) {
  const cont = document.querySelector('.bubbles');
  if (!cont) return;
  const el = document.createElement('div');
  if (b.kind === 'silent') {
    el.className = 'bubble silent';
    el.textContent = `${getPlant()?.biology.common_name || 'plant'} stayed silent.`;
  } else {
    el.className = `bubble ${b.kind}`;
    el.innerHTML = `${escapeHtml(b.text)}<span class="ts">${shortTs(b.ts)}</span>`;
  }
  cont.appendChild(el);
  cont.scrollTop = cont.scrollHeight;
}

function speakText(text, plant) {
  if (!window.speechSynthesis) { setStatus('idle'); return; }
  const u = new SpeechSynthesisUtterance(text);
  const persona = plant.personality || {};
  u.pitch = ({ low: 0.7, mid: 1, high: 1.3 })[persona.voice_pitch] ?? 1;
  u.rate  = ({ slow: 0.85, normal: 1, brisk: 1.15 })[persona.voice_rate] ?? 1;
  u.volume = 1;
  // Best-effort voice selection
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) {
    const hint = (persona.voice_name || '').toLowerCase();
    let pick;
    if (hint.includes('male') && !hint.includes('female')) {
      pick = voices.find(v => /male/i.test(v.name) && !/female/i.test(v.name));
    } else if (hint.includes('female')) {
      pick = voices.find(v => /female|samantha|victoria|karen|tessa/i.test(v.name));
    }
    if (!pick) pick = voices.find(v => v.lang.startsWith('en') && v.localService);
    if (pick) u.voice = pick;
  }
  u.onstart = () => setStatus('speaking');
  u.onend = () => setStatus('idle');
  u.onerror = () => setStatus('idle');
  window.speechSynthesis.speak(u);
}

// ─── Biology tab ────────────────────────────────────────────────────────
function renderBiology(p) {
  const b = p.biology;
  return `
    <h3>Biology card</h3>
    <p class="muted">The species profile this plant's persona is grounded in. Edit and save, then re-derive the persona to refresh.</p>
    <form class="form-grid" id="bioForm">
      <div class="form-field">
        <label>common name</label>
        <input name="common_name" value="${escapeAttr(b.common_name)}" />
      </div>
      <div class="form-field">
        <label>species</label>
        <input name="species" value="${escapeAttr(b.species)}" />
      </div>
      <div class="form-field span2">
        <label>native range</label>
        <input name="native_range" value="${escapeAttr(b.native_range)}" />
      </div>
      <div class="form-field">
        <label>watering interval (days)</label>
        <input name="watering_days" type="number" min="1" value="${b.watering?.interval_days ?? 7}" />
      </div>
      <div class="form-field">
        <label>top-soil dry depth (cm)</label>
        <input name="dry_cm" type="number" min="0" step="0.5" value="${b.watering?.soil_dry_top_cm ?? 2}" />
      </div>
      <div class="form-field">
        <label>comfort temperature (°C)</label>
        <div class="range-row">
          <input name="temp_min" type="number" value="${b.comfort?.temp_c?.[0] ?? 18}" />
          <span>to</span>
          <input name="temp_max" type="number" value="${b.comfort?.temp_c?.[1] ?? 26}" />
        </div>
      </div>
      <div class="form-field">
        <label>comfort humidity (%)</label>
        <div class="range-row">
          <input name="hum_min" type="number" value="${b.comfort?.humidity_pct?.[0] ?? 40}" />
          <span>to</span>
          <input name="hum_max" type="number" value="${b.comfort?.humidity_pct?.[1] ?? 70}" />
        </div>
      </div>
      <div class="form-field">
        <label>preferred light</label>
        <input name="light_pref" value="${escapeAttr(b.light?.preferred || '')}" />
      </div>
      <div class="form-field">
        <label>tolerates</label>
        <input name="light_tol" value="${escapeAttr(b.light?.tolerates || '')}" />
      </div>
      <div class="form-field span2">
        <label>growth habit</label>
        <input name="growth" value="${escapeAttr(b.growth || '')}" />
      </div>
      <div class="form-field span2">
        <label>notes</label>
        <textarea name="notes">${escapeHtml(b.notes || '')}</textarea>
      </div>
    </form>
    <div class="button-row">
      <button class="btn btn-primary" id="saveBio"><i class="fa-solid fa-floppy-disk"></i> Save biology</button>
      <button class="btn btn-danger" id="delPlant"><i class="fa-solid fa-trash"></i> Delete plant</button>
      <span class="save-status" id="saveStatus"></span>
    </div>
  `;
}

function wireBiology(plant) {
  document.getElementById('saveBio').onclick = async () => {
    const form = document.getElementById('bioForm');
    const data = Object.fromEntries(new FormData(form));
    const updated = {
      ...plant.biology,
      common_name: data.common_name,
      species: data.species,
      native_range: data.native_range,
      watering: {
        interval_days: parseInt(data.watering_days) || 7,
        soil_dry_top_cm: parseFloat(data.dry_cm) || 2,
      },
      light: { preferred: data.light_pref, tolerates: data.light_tol },
      comfort: {
        temp_c: [parseFloat(data.temp_min), parseFloat(data.temp_max)],
        humidity_pct: [parseFloat(data.hum_min), parseFloat(data.hum_max)],
      },
      growth: data.growth,
      notes: data.notes,
    };
    try {
      const result = await api('PUT', `/api/plants/${plant.id}`, { biology: updated });
      const i = State.plants.findIndex(p => p.id === result.id);
      if (i >= 0) State.plants[i] = result;
      const ss = document.getElementById('saveStatus');
      ss.textContent = '✓ saved'; ss.classList.add('show');
      setTimeout(() => ss.classList.remove('show'), 1800);
      renderSidebar();
    } catch (e) {
      toast(`save failed: ${e.message}`, 'error');
    }
  };
  document.getElementById('delPlant').onclick = () => {
    if (!confirm(`Delete ${plant.biology.common_name}? This cannot be undone.`)) return;
    api('DELETE', `/api/plants/${plant.id}`).then(() => {
      State.currentId = null;
      loadPlants();
      toast(`deleted ${plant.biology.common_name}`, 'ok');
    }).catch(e => toast(`delete failed: ${e.message}`, 'error'));
  };
}

// ─── Personality tab ────────────────────────────────────────────────────
function renderPersonality(p) {
  if (!p.personality) {
    return `
      <h3>Personality</h3>
      <p>This plant doesn't have a derived persona yet. Click below to ask the LLM to read its biology card and compose one.</p>
      <div class="no-personality">
        <p class="muted">The persona is generated <strong>once</strong> and stored. The plant's memory grows; its character does not.</p>
        <button class="btn btn-primary" id="deriveBtn"><i class="fa-solid fa-wand-magic-sparkles"></i> Derive personality</button>
      </div>
    `;
  }
  const persona = p.personality;
  return `
    <h3>Personality</h3>
    <p class="muted">Derived from biology · stable across sessions · used as system prompt for every utterance.</p>

    <div class="persona-block">
      <h4>Tone</h4>
      <div class="value">${escapeHtml(persona.tone || '')}</div>
    </div>

    <div class="persona-block">
      <h4>Voice</h4>
      <div class="value">${escapeHtml(persona.voice_name || '')} · pitch <code>${escapeHtml(persona.voice_pitch || '')}</code> · rate <code>${escapeHtml(persona.voice_rate || '')}</code></div>
    </div>

    <div class="persona-block">
      <h4>Loves</h4>
      <div class="persona-tags">
        ${(persona.loves || []).map(x => `<span class="persona-tag love">${escapeHtml(x)}</span>`).join('')}
      </div>
    </div>

    <div class="persona-block">
      <h4>Fears</h4>
      <div class="persona-tags">
        ${(persona.fears || []).map(x => `<span class="persona-tag fear">${escapeHtml(x)}</span>`).join('')}
      </div>
    </div>

    <div class="persona-block">
      <h4>Sleep window</h4>
      <div class="value"><i class="fa-solid fa-moon"></i> ${escapeHtml(persona.sleep_window_local || '—')}</div>
    </div>

    <div class="persona-block">
      <h4>Stressed phrases</h4>
      <div class="persona-tags">
        ${(persona.stressed_phrases || []).map(x => `<span class="persona-tag fear">"${escapeHtml(x)}"</span>`).join('')}
      </div>
    </div>

    <div class="persona-block">
      <h4>System prompt</h4>
      <div class="system-prompt">${escapeHtml(persona.system_prompt || '')}</div>
    </div>

    <div class="button-row">
      <button class="btn btn-secondary" id="deriveBtn"><i class="fa-solid fa-arrows-rotate"></i> Re-derive from biology</button>
    </div>
  `;
}

function wirePersonality(plant) {
  const b = document.getElementById('deriveBtn');
  if (!b) return;
  b.onclick = async () => {
    if (plant.personality && !confirm('Re-derive will replace the current personality. Continue?')) return;
    b.disabled = true;
    b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> deriving…';
    setStatus('thinking');
    try {
      const result = await api('POST', `/api/plants/${plant.id}/derive`, {});
      const i = State.plants.findIndex(p => p.id === result.id);
      if (i >= 0) State.plants[i] = result;
      toast(`personality derived for ${result.biology.common_name}`, 'ok');
      setStatus('idle');
      renderMain();
    } catch (e) {
      toast(`derive failed: ${e.message}`, 'error');
      setStatus('error');
      b.disabled = false;
      b.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Derive personality';
      setTimeout(() => setStatus('idle'), 1500);
    }
  };
}

// ─── Memory tab ─────────────────────────────────────────────────────────
function renderMemory(p) {
  const mem = (p.memory || []).slice().reverse();
  if (mem.length === 0) {
    return `
      <h3>Memory</h3>
      <p class="muted">No memories yet. Talk to ${escapeHtml(p.biology.common_name)} on the Conversation tab to fill this in.</p>
    `;
  }
  return `
    <h3>Memory <span class="muted" style="font-size:13px;font-weight:normal">· ${mem.length} entries · newest first</span></h3>
    <div class="memory-log">
      ${mem.map(m => `
        <div class="memory-row ${m.kind}">
          <span class="ts">${shortTs(m.ts)}</span>
          <span class="kind">${m.kind === 'heard' ? '◀ heard' : '▶ spoke'}</span>
          <span class="text">${escapeHtml(m.text)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── Sensors tab ────────────────────────────────────────────────────────
function renderSensors(p) {
  const c = p.biology.comfort;
  const t = State.sensors.temp_c;
  const h = State.sensors.humidity_pct;
  return `
    <h3>Sensors</h3>
    <p class="muted">Mocked for v0.1. Adjust to drive ${escapeHtml(p.biology.common_name)}'s mood and what it says when it talks. Real sensor integration (Kiwrious / BME280) coming with the Pi tier.</p>

    <div class="sensor-block">
      <h4>
        <span><i class="fa-solid fa-temperature-half"></i> Temperature</span>
        <span class="reading" id="tempRead">${t.toFixed(1)}°C</span>
      </h4>
      <input type="range" id="tempSlider" min="0" max="40" step="0.5" value="${t}" />
      <div class="band">
        <span>0°</span>
        <span>comfort: ${c.temp_c[0]}–${c.temp_c[1]}°C</span>
        <span>40°</span>
      </div>
    </div>

    <div class="sensor-block">
      <h4>
        <span><i class="fa-solid fa-droplet"></i> Humidity</span>
        <span class="reading" id="humRead">${Math.round(h)}%</span>
      </h4>
      <input type="range" id="humSlider" min="0" max="100" step="1" value="${h}" />
      <div class="band">
        <span>0%</span>
        <span>comfort: ${c.humidity_pct[0]}–${c.humidity_pct[1]}%</span>
        <span>100%</span>
      </div>
    </div>

    <div class="comfort-status ${comfortClass(p)}" id="comfortStatus">${comfortMessage(p)}</div>
  `;
}

function wireSensors(plant) {
  const tSlider = document.getElementById('tempSlider');
  const hSlider = document.getElementById('humSlider');
  const tRead = document.getElementById('tempRead');
  const hRead = document.getElementById('humRead');
  const status = document.getElementById('comfortStatus');
  const update = () => {
    State.sensors.temp_c = parseFloat(tSlider.value);
    State.sensors.humidity_pct = parseFloat(hSlider.value);
    tRead.textContent = State.sensors.temp_c.toFixed(1) + '°C';
    hRead.textContent = Math.round(State.sensors.humidity_pct) + '%';
    status.className = `comfort-status ${comfortClass(plant)}`;
    status.textContent = comfortMessage(plant);
    // Update mood on plant for this session (not persisted)
    const m = comfortClass(plant) === 'ok' ? 'content'
            : comfortClass(plant) === 'drift' ? 'grumpy'
            : 'distressed';
    plant.mood = { current: m, since: new Date().toISOString() };
  };
  tSlider.oninput = update;
  hSlider.oninput = update;
}

function comfortClass(plant) {
  const c = plant.biology.comfort;
  const cr = plant.biology.critical || {};
  const t = State.sensors.temp_c, h = State.sensors.humidity_pct;
  const tCritical = (cr.temp_c_min !== undefined && t < cr.temp_c_min);
  const hCritical = (cr.humidity_pct_min !== undefined && h < cr.humidity_pct_min);
  if (tCritical || hCritical) return 'bad';
  const tOk = t >= c.temp_c[0] && t <= c.temp_c[1];
  const hOk = h >= c.humidity_pct[0] && h <= c.humidity_pct[1];
  if (tOk && hOk) return 'ok';
  return 'drift';
}

function comfortMessage(plant) {
  const c = comfortClass(plant);
  if (c === 'ok')    return '✓ Within comfort band — plant is content.';
  if (c === 'drift') return '○ Outside comfort band but not critical — plant is mildly grumpy.';
  return '✗ Critical limits exceeded — plant is distressed.';
}

// ─── Deploy tab (placeholder) ───────────────────────────────────────────
function renderDeploy(p) {
  return `
    <h3>Deploy to Raspberry Pi</h3>
    <div class="deploy-card">
      <span class="placeholder-tag">v0.1 placeholder</span>
      <p>The hive runtime you're using right now (<code>server.py</code>) is the same code that will run on a Pi Zero 2 W in the T3 kit. Deployment in a future version will:</p>
      <ol>
        <li>Discover Pis on your LAN via mDNS (<code>plant-2-plant.local</code>).</li>
        <li>Push <code>server.py</code> + <code>plants/</code> over SSH.</li>
        <li>Install systemd unit so the hive runs at boot.</li>
        <li>Wire the Pi's mic / speaker / camera / Kiwrious into the same kit slots the studio simulates here.</li>
      </ol>
      <p class="muted">For now, you can do this manually:</p>
      <pre># on your laptop
scp -r server.py plants/ pi@plant-2-plant.local:~/hive/

# on the pi
ssh pi@plant-2-plant.local
cd ~/hive
ANTHROPIC_API_KEY=sk-... python3 server.py</pre>
      <p>Then point your browser at <code>http://plant-2-plant.local:4450/studio.html</code> and you've got the same studio talking to the Pi.</p>
    </div>

    <div class="deploy-card">
      <span class="placeholder-tag">v0.1 placeholder</span>
      <h4 style="margin-top:0">Peer routing &amp; Hue signalling</h4>
      <p class="muted">Plant-to-plant talk and Hue light signalling will appear as separate tabs once a hive has more than one plant connected to actual hardware. The proximity bound (per the concept doc) is configured per pair on first setup.</p>
    </div>
  `;
}

// ─── New-plant modal ────────────────────────────────────────────────────
function openNewPlantModal() {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-header">
          <h3>Add a plant</h3>
          <button class="btn-ghost" onclick="closeModal()"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body">
          <p class="muted">Start with a common name. You'll fill in the biology card next, then derive a persona.</p>
          <div class="form-field">
            <label>common name</label>
            <input id="newPlantName" placeholder="e.g. Snake Plant" autofocus />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">cancel</button>
          <button class="btn btn-primary" id="createBtn">Create</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('createBtn').onclick = createPlant;
  document.getElementById('newPlantName').onkeydown = e => { if (e.key === 'Enter') createPlant(); };
  document.getElementById('newPlantName').focus();
}

function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
}

async function createPlant() {
  const name = document.getElementById('newPlantName').value.trim();
  if (!name) { toast('name required', 'error'); return; }
  try {
    const plant = await api('POST', '/api/plants', { common_name: name });
    closeModal();
    await loadPlants();
    selectPlant(plant.id);
    setTab('biology');
    toast(`created ${name} — fill in biology, then derive a persona`, 'ok', 5000);
  } catch (e) {
    toast(`create failed: ${e.message}`, 'error');
  }
}

// ─── Mobile menu ────────────────────────────────────────────────────────
function toggleMobileMenu() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ─── Helpers ────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
function escapeAttr(s) { return escapeHtml(s); }
function shortTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
function isSleeping(p) {
  const w = p.personality?.sleep_window_local;
  if (!w || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(w)) return false;
  const [a, b] = w.split('-');
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const start = toMin(a), end = toMin(b);
  if (start <= end) return cur >= start && cur < end;
  return cur >= start || cur < end; // wraps midnight
}

// ─── Boot ──────────────────────────────────────────────────────────────
(async function init() {
  // honor #plant-id in URL
  const initId = location.hash.replace('#', '');
  if (initId) State.currentId = initId;
  await loadHealth();
  await loadPlants();
  // SpeechSynthesis voice list takes a tick to populate
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => { /* trigger lazy reload */ };
  }
})();
