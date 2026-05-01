const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const dropArea = document.getElementById('dropArea');
const uploadZone = document.getElementById('uploadZone');
const selectedFilesEl = document.getElementById('selectedFiles');
const jobsList = document.getElementById('jobsList');
const statsBar = document.getElementById('statsBar');
const clearDoneBtn = document.getElementById('clearDoneBtn');
const langSelect = document.getElementById('language');

let selectedFiles = [];
let jobsMap = {};

// --- Provider badge ---
async function loadProvider() {
  try {
    const res = await fetch('/api/config');
    const { provider } = await res.json();
    const badge = document.getElementById('providerBadge');
    badge.textContent = provider === 'gemini' ? 'Gemini 1.5 Flash' : 'Groq Whisper';
    badge.className = `provider-badge ${provider}`;
  } catch {}
}

// --- File selection ---
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

// --- Upload ---
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

// --- SSE live updates ---
const es = new EventSource('/events');
es.onmessage = e => {
  const data = JSON.parse(e.data);

  if (data.type === 'job_start') {
    loadJobs();
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

  if (['job_done', 'job_error'].includes(data.type)) {
    loadJobs();
    return;
  }
};

// --- Load & render jobs ---
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
  const hasDone = jobs.some(j => j.status === 'done');
  clearDoneBtn.hidden = !hasDone;

  jobsList.innerHTML = jobs.map(j => cardHTML(j)).join('');
  attachCardListeners(jobs);
}

function cardHTML(j) {
  const statusLabel = { pending: 'Aguardando', processing: 'Processando', done: 'Concluído', error: 'Erro' }[j.status] || j.status;
  const showBar = j.status === 'processing' || j.status === 'done';
  const progress = j.progress || 0;
  const meta = j.status === 'processing' && j.total_chunks > 0
    ? `Chunk ${j.done_chunks}/${j.total_chunks}`
    : j.status === 'done' ? 'Transcrição pronta' : '';

  return `
    <div class="job-card ${j.status}" id="card-${j.id}">
      <div class="job-top">
        <span class="job-name" title="${j.original_name}">${j.original_name}</span>
        <span class="job-status status-${j.status}">${statusLabel}</span>
        <div class="job-actions">
          ${j.status === 'done' ? `<button class="btn-icon" title="Baixar .txt" onclick="download(${j.id})">⬇</button>` : ''}
          <button class="btn-icon danger" title="Remover" onclick="removeJob(${j.id})" ${j.status === 'processing' ? 'disabled' : ''}>✕</button>
        </div>
      </div>
      ${showBar ? `<div class="job-progress-bar"><div class="job-progress-fill" id="fill-${j.id}" style="width:${progress}%"></div></div>` : ''}
      ${meta ? `<div class="job-meta">${meta}</div>` : ''}
      ${j.error ? `<div class="job-error-msg">Erro: ${j.error}</div>` : ''}
    </div>
  `;
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

function attachCardListeners(jobs) {}

function updateStats(jobs) {
  document.getElementById('statTotal').textContent = jobs.length;
  document.getElementById('statDone').textContent = jobs.filter(j => j.status === 'done').length;
  document.getElementById('statProc').textContent = jobs.filter(j => j.status === 'processing').length;
  document.getElementById('statError').textContent = jobs.filter(j => j.status === 'error').length;
}

// --- Actions ---
async function download(id) {
  window.location.href = `/api/download/${id}`;
}

async function removeJob(id) {
  await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
  loadJobs();
}

clearDoneBtn.addEventListener('click', async () => {
  const done = Object.values(jobsMap).filter(j => j.status === 'done');
  await Promise.all(done.map(j => fetch(`/api/jobs/${j.id}`, { method: 'DELETE' })));
  loadJobs();
});

// --- Init ---
loadProvider();
loadJobs();
setInterval(loadJobs, 5000);
