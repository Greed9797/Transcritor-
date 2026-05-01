const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const dropArea = document.getElementById('dropArea');
const uploadZone = document.getElementById('uploadZone');
const selectedFilesEl = document.getElementById('selectedFiles');
const jobsList = document.getElementById('jobsList');
const statsBar = document.getElementById('statsBar');
const clearDoneBtn = document.getElementById('clearDoneBtn');
const langSelect = document.getElementById('language');
const settingsBtn = document.getElementById('settingsBtn');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsClose = document.getElementById('settingsClose');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const saveStatus = document.getElementById('saveStatus');

let selectedFiles = [];
let jobsMap = {};

// ── Provider badge ──────────────────────────────────────────────────────────

async function loadProvider() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const badge = document.getElementById('providerBadge');
    const labels = { gemini: 'Gemini 2.5 Flash-Lite', groq: 'Groq Whisper' };
    badge.textContent = labels[cfg.provider] || cfg.provider;
    badge.className = `provider-badge ${cfg.provider}`;
  } catch {}
}

// ── Settings modal ──────────────────────────────────────────────────────────

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) closeSettings(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettings(); });

// ── Gemini key list ─────────────────────────────────────────────────────────

function renderGeminiKeys(savedKeys) {
  const list = document.getElementById('geminiKeysList');
  list.innerHTML = '';

  const rows = savedKeys.length > 0
    ? savedKeys.map((k, i) => ({ placeholder: k.masked || 'Configurado', value: '' }))
    : [{ placeholder: 'AIza...', value: '' }];

  rows.forEach((row, i) => addKeyRow(row.placeholder, row.value, i + 1));
}

function addKeyRow(placeholder = 'AIza...', value = '', num) {
  const list = document.getElementById('geminiKeysList');
  const idx = num || list.children.length + 1;
  const row = document.createElement('div');
  row.className = 'key-row';
  row.innerHTML = `
    <span class="key-badge">#${idx}</span>
    <div class="key-input-wrap">
      <input type="password" class="field-input gemini-key-input" placeholder="${placeholder}" value="${value}" autocomplete="off" />
      <button class="btn-eye" type="button" title="Mostrar/ocultar">👁</button>
    </div>
    <button class="btn-remove-key" type="button" title="Remover">✕</button>
  `;

  row.querySelector('.btn-eye').addEventListener('click', () => {
    const inp = row.querySelector('.gemini-key-input');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  row.querySelector('.btn-remove-key').addEventListener('click', () => {
    row.remove();
    reindexKeyRows();
  });

  list.appendChild(row);
}

function reindexKeyRows() {
  document.querySelectorAll('.key-row').forEach((row, i) => {
    row.querySelector('.key-badge').textContent = `#${i + 1}`;
  });
}

document.getElementById('addGeminiKeyBtn').addEventListener('click', () => addKeyRow());

async function openSettings() {
  settingsOverlay.classList.remove('hidden');
  saveStatus.textContent = '';
  saveStatus.className = 'save-status';

  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();

    document.querySelector(`input[name="provider"][value="${cfg.provider}"]`).checked = true;

    const fbVal = cfg.fallbackProvider || 'none';
    const fbEl = document.querySelector(`input[name="fallback"][value="${fbVal}"]`);
    if (fbEl) fbEl.checked = true;

    renderGeminiKeys(cfg.geminiKeys || []);

    if (cfg.groqKeySet) {
      document.getElementById('groqKey').placeholder = cfg.groqKeyMasked || 'Configurado';
      document.getElementById('groqKeyHint').textContent = 'Chave salva. Deixe em branco para manter.';
      document.getElementById('groqKeyHint').className = 'field-hint ok';
    }

    document.getElementById('delayMs').value = cfg.delayMs || 2000;
  } catch (e) {
    saveStatus.textContent = 'Erro ao carregar configurações.';
    saveStatus.className = 'save-status err';
  }
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
  document.getElementById('groqKey').value = '';
}

saveSettingsBtn.addEventListener('click', async () => {
  saveSettingsBtn.disabled = true;
  saveStatus.textContent = 'Salvando...';
  saveStatus.className = 'save-status';

  const provider = document.querySelector('input[name="provider"]:checked')?.value;
  const fallbackProvider = document.querySelector('input[name="fallback"]:checked')?.value || 'none';
  const groqKey = document.getElementById('groqKey').value.trim();
  const delayMs = parseInt(document.getElementById('delayMs').value) || 2000;

  // Collect all gemini keys (only non-empty values)
  const geminiKeys = [...document.querySelectorAll('.gemini-key-input')]
    .map(inp => inp.value.trim())
    .filter(v => v.length > 0);

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, fallbackProvider, geminiKeys, groqKey, delayMs }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error('Falha ao salvar');

    saveStatus.textContent = '✓ Salvo com sucesso';
    saveStatus.className = 'save-status ok';
    await loadProvider();
    setTimeout(closeSettings, 1200);
  } catch (e) {
    saveStatus.textContent = 'Erro: ' + e.message;
    saveStatus.className = 'save-status err';
  } finally {
    saveSettingsBtn.disabled = false;
  }
});

// Eye toggle for groq key
document.querySelectorAll('.btn-eye[data-target]').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  });
});

// ── File selection ──────────────────────────────────────────────────────────

fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));
dropArea.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
dropArea.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
dropArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  handleFiles([...e.dataTransfer.files]);
});

function handleFiles(files) {
  const audio = files.filter(f => f.type.startsWith('audio/') || f.type.startsWith('video/'));
  selectedFiles = [...selectedFiles, ...audio];
  renderSelectedFiles();
  uploadBtn.disabled = selectedFiles.length === 0;
}

function renderSelectedFiles() {
  selectedFilesEl.innerHTML = selectedFiles
    .map(f => `<span class="file-tag" title="${f.name}">${f.name}</span>`)
    .join('');
}

// ── Upload ──────────────────────────────────────────────────────────────────

uploadBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;
  uploadBtn.disabled = true;
  const fd = new FormData();
  selectedFiles.forEach(f => fd.append('files', f));
  fd.append('language', langSelect.value);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    selectedFiles = [];
    fileInput.value = '';
    renderSelectedFiles();
  } catch (err) {
    alert('Erro ao enviar: ' + err.message);
    uploadBtn.disabled = false;
  }
});

// ── SSE live updates ────────────────────────────────────────────────────────

const es = new EventSource('/events');
es.onmessage = e => {
  const data = JSON.parse(e.data);

  if (data.type === 'job_start') { loadJobs(); return; }

  if (data.type === 'gemini_key_rotation') {
    showToast(`🔑 Gemini key #${data.keyIndex} esgotou — rotacionando para key #${data.keyIndex + 1} de ${data.total}`);
    return;
  }

  if (data.type === 'fallback_activated') {
    showToast(`⚡ Todas as keys ${data.from} esgotadas — usando ${data.to} como fallback`);
    loadProvider();
    return;
  }

  if (data.type === 'job_progress' && jobsMap[data.id]) {
    const job = jobsMap[data.id];
    job.progress = data.progress;
    job.done_chunks = data.done;
    job.total_chunks = data.total;
    updateCardProgress(data.id);
    return;
  }

  if (['job_done', 'job_error'].includes(data.type)) { loadJobs(); return; }
};

// ── Toast notification ──────────────────────────────────────────────────────

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast-show'));
  setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 400); }, 4000);
}

// ── Jobs render ─────────────────────────────────────────────────────────────

async function loadJobs() {
  const res = await fetch('/api/jobs');
  const jobs = await res.json();
  jobsMap = {};
  jobs.forEach(j => jobsMap[j.id] = j);
  renderJobs(jobs);
  updateStats(jobs);
  uploadBtn.disabled = selectedFiles.length === 0;
}

function renderJobs(jobs) {
  if (jobs.length === 0) {
    jobsList.innerHTML = '<p class="empty-state">Nenhuma transcrição ainda. Carregue arquivos acima.</p>';
    statsBar.hidden = true;
    clearDoneBtn.hidden = true;
    return;
  }
  statsBar.hidden = false;
  clearDoneBtn.hidden = !jobs.some(j => j.status === 'done');
  jobsList.innerHTML = jobs.map(j => cardHTML(j)).join('');
}

function cardHTML(j) {
  const label = { pending: 'Aguardando', processing: 'Processando', done: 'Concluído', error: 'Erro' }[j.status] || j.status;
  const showBar = j.status === 'processing' || j.status === 'done';
  const progress = j.progress || 0;
  const meta = j.status === 'processing' && j.total_chunks > 0
    ? `Chunk ${j.done_chunks}/${j.total_chunks}`
    : j.status === 'done' ? 'Transcrição pronta' : '';

  return `
    <div class="job-card ${j.status}" id="card-${j.id}">
      <div class="job-top">
        <span class="job-name" title="${j.original_name}">${j.original_name}</span>
        <span class="job-status status-${j.status}">${label}</span>
        <div class="job-actions">
          ${j.status === 'done' ? `<button class="btn-icon" title="Baixar .txt" onclick="download(${j.id})">⬇</button>` : ''}
          <button class="btn-icon danger" title="Remover" onclick="removeJob(${j.id})" ${j.status === 'processing' ? 'disabled' : ''}>✕</button>
        </div>
      </div>
      ${showBar ? `<div class="job-progress-bar"><div class="job-progress-fill" id="fill-${j.id}" style="width:${progress}%"></div></div>` : ''}
      ${meta ? `<div class="job-meta">${meta}</div>` : ''}
      ${j.error ? `<div class="job-error-msg">Erro: ${j.error}</div>` : ''}
    </div>`;
}

function updateCardProgress(id) {
  const fill = document.getElementById(`fill-${id}`);
  if (fill) fill.style.width = (jobsMap[id].progress || 0) + '%';
  const card = document.getElementById(`card-${id}`);
  if (card) {
    const meta = card.querySelector('.job-meta');
    if (meta) {
      const j = jobsMap[id];
      meta.textContent = j.total_chunks > 0 ? `Chunk ${j.done_chunks}/${j.total_chunks}` : '';
    }
  }
}

function updateStats(jobs) {
  document.getElementById('statTotal').textContent = jobs.length;
  document.getElementById('statDone').textContent = jobs.filter(j => j.status === 'done').length;
  document.getElementById('statProc').textContent = jobs.filter(j => j.status === 'processing').length;
  document.getElementById('statError').textContent = jobs.filter(j => j.status === 'error').length;
}

async function download(id) { window.location.href = `/api/download/${id}`; }

async function removeJob(id) {
  await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
  loadJobs();
}

clearDoneBtn.addEventListener('click', async () => {
  const done = Object.values(jobsMap).filter(j => j.status === 'done');
  await Promise.all(done.map(j => fetch(`/api/jobs/${j.id}`, { method: 'DELETE' })));
  loadJobs();
});

// ── Init ────────────────────────────────────────────────────────────────────

loadProvider();
loadJobs();
setInterval(loadJobs, 5000);
