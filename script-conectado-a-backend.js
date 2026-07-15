document.getElementById('year').textContent = new Date().getFullYear();

/* =========================================================================
   VERSIÓN CONECTADA A BACKEND
   Graba audio real del micrófono, lo envía a /api/transcribe (Whisper) y
   luego /api/generate-minuta (Claude) para obtener la minuta estructurada.
   Requiere que el backend de TALEX esté corriendo (ver talex-backend/README.md).
   ========================================================================= */

// Cambia esto si tu backend corre en otra URL/puerto.
const API_BASE_URL = 'http://localhost:8000';

/* ===================== NAV MOBILE TOGGLE ===================== */
const navToggle = document.getElementById('navToggle');
const navMobile = document.getElementById('navMobile');
navToggle.addEventListener('click', () => {
  const expanded = navToggle.getAttribute('aria-expanded') === 'true';
  navToggle.setAttribute('aria-expanded', String(!expanded));
  navMobile.classList.toggle('open');
});
navMobile.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navToggle.setAttribute('aria-expanded', 'false');
    navMobile.classList.remove('open');
  });
});

/* ===================== GRABADORA (audio real) ===================== */
const recordBtn = document.getElementById('recordBtn');
const statusText = document.getElementById('statusText');
const timerEl = document.getElementById('timer');
const transcriptEl = document.getElementById('transcript');

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let timerInterval = null;
let secondsElapsed = 0;

function formatTime(totalSeconds) {
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function startTimer() {
  secondsElapsed = 0;
  timerEl.textContent = '00:00';
  timerInterval = setInterval(() => {
    secondsElapsed++;
    timerEl.textContent = formatTime(secondsElapsed);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// Elige el primer mimeType soportado por el navegador para MediaRecorder.
function pickSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusText.textContent = 'Este navegador no permite acceder al micrófono.';
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusText.textContent = 'No se pudo acceder al micrófono. Revise los permisos del navegador.';
    return;
  }

  const mimeType = pickSupportedMimeType();
  audioChunks = [];

  try {
    mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
  } catch (err) {
    statusText.textContent = 'No se pudo iniciar la grabación en este navegador.';
    stream.getTracks().forEach(t => t.stop());
    return;
  }

  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  });

  mediaRecorder.addEventListener('stop', () => {
    stream.getTracks().forEach(t => t.stop());
    handleRecordingStopped(mediaRecorder.mimeType || mimeType || 'audio/webm');
  });

  mediaRecorder.start();
  isRecording = true;
  recordBtn.classList.add('is-recording');
  statusText.textContent = 'Grabando… presione para detener';
  startTimer();
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  isRecording = false;
  recordBtn.classList.remove('is-recording');
  stopTimer();
  statusText.textContent = 'Deteniendo grabación…';
  mediaRecorder.stop();
}

async function handleRecordingStopped(mimeType) {
  if (!audioChunks.length) {
    statusText.textContent = 'No se capturó audio. Intente grabar nuevamente.';
    return;
  }

  statusText.textContent = 'Transcribiendo con IA…';

  const audioBlob = new Blob(audioChunks, { type: mimeType });
  const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const formData = new FormData();
  formData.append('audio', audioBlob, `grabacion.${extension}`);

  try {
    const res = await fetch(`${API_BASE_URL}/api/transcribe`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.detail || `Error ${res.status} al transcribir`);
    }

    const data = await res.json();
    const textoNuevo = (data.text || '').trim();
    const existente = transcriptEl.textContent.trim();
    transcriptEl.textContent = existente && textoNuevo
      ? `${existente} ${textoNuevo}`
      : (existente || textoNuevo);

    statusText.textContent = textoNuevo
      ? 'Transcripción lista. Puede grabar más o generar la minuta.'
      : 'No se detectó voz en el audio grabado.';
  } catch (err) {
    console.error(err);
    statusText.textContent = `Error al transcribir: ${err.message}. Verifique que el backend esté corriendo.`;
  }
}

recordBtn.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

/* ===================== GENERACIÓN DE MINUTA (Claude vía backend) ===================== */
const generateBtn = document.getElementById('generateBtn');
const generateError = document.getElementById('generateError');
const resultWrap = document.getElementById('resultWrap');
const resultText = document.getElementById('resultText');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');

function formatearMinuta(data, asunto, participantes) {
  const fecha = new Date().toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });

  const listaOVacio = (arr, vacioMsg) =>
    arr && arr.length ? arr.map(item => `  •  ${item}`).join('\n') : `  •  ${vacioMsg}`;

  return `MINUTA DE REUNIÓN

Fecha: ${fecha}
Asunto: ${asunto || 'Sin especificar'}
Participantes: ${participantes || 'Sin especificar'}

RESUMEN
  ${data.resumen || '(Sin resumen disponible)'}

PUNTOS TRATADOS
${listaOVacio(data.puntos_tratados, '(Sin puntos identificados)')}

ACUERDOS
${listaOVacio(data.acuerdos, 'No se registraron acuerdos explícitos en esta reunión.')}

PRÓXIMOS PASOS
${listaOVacio(data.proximos_pasos, 'No se identificaron próximos pasos en esta reunión.')}
`;
}

generateBtn.addEventListener('click', async () => {
  if (isRecording) stopRecording();

  const asunto = document.getElementById('asunto').value.trim();
  const participantes = document.getElementById('participantes').value.trim();
  const transcript = transcriptEl.textContent.trim();

  generateError.classList.add('hidden');

  if (!transcript) {
    generateError.textContent = 'Grabe o escriba una transcripción antes de generar la minuta.';
    generateError.classList.remove('hidden');
    return;
  }

  generateBtn.disabled = true;
  const originalMarkup = generateBtn.innerHTML;
  generateBtn.textContent = 'Generando con IA…';

  try {
    const res = await fetch(`${API_BASE_URL}/api/generate-minuta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, asunto, participantes }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.detail || `Error ${res.status} al generar la minuta`);
    }

    const data = await res.json();
    resultText.textContent = formatearMinuta(data, asunto, participantes);
    resultWrap.classList.remove('hidden');
    resultWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    generateError.textContent = `No se pudo generar la minuta: ${err.message}`;
    generateError.classList.remove('hidden');
  } finally {
    generateBtn.disabled = false;
    generateBtn.innerHTML = originalMarkup;
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(resultText.textContent);
    copyBtn.textContent = 'Copiado ✓';
    setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1800);
  } catch (e) {
    alert('No se pudo copiar automáticamente. Seleccione el texto manualmente.');
  }
});

downloadBtn.addEventListener('click', () => {
  const asunto = document.getElementById('asunto').value.trim() || 'minuta';
  const filename = `minuta-${asunto.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.txt`;
  const blob = new Blob([resultText.textContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

/* ===================== CONTACTO ===================== */
const contactForm = document.getElementById('contactForm');
const formNote = document.getElementById('formNote');

contactForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formNote.textContent = 'Enviando…';

  const formData = new FormData(contactForm);
  const payload = Object.fromEntries(formData.entries());

  try {
    const res = await fetch(`${API_BASE_URL}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('El servidor no pudo procesar el mensaje.');
    formNote.textContent = 'Mensaje enviado. Le responderemos a la brevedad.';
    contactForm.reset();
  } catch (err) {
    formNote.textContent = 'No se pudo enviar el mensaje. Intente nuevamente más tarde.';
  }
});

/* ===================== SCROLL REVEAL ===================== */
const revealEls = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && revealEls.length) {
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

  revealEls.forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 4, 3) * 90}ms`;
    revealObserver.observe(el);
  });
} else {
  revealEls.forEach((el) => el.classList.add('is-visible'));
}
