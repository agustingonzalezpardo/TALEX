"""
TALEX — Backend FastAPI
========================
Expone dos endpoints principales:

  POST /api/transcribe      -> recibe un archivo de audio y devuelve el texto transcrito (OpenAI Whisper)
  POST /api/generate-minuta -> recibe la transcripción + metadata y devuelve la minuta estructurada (Anthropic Claude)

Cómo correrlo localmente:
  1) cd talex-backend
  2) python -m venv venv && venv\Scripts\activate
  3) pip install -r requirements.txt
  4) copiar .env.example a .env y completar las API keys
  5) uvicorn main:app --reload --port 8000

La documentación interactiva queda disponible en http://localhost:8000/docs
"""

import os
import json
import logging
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from openai import OpenAI
from anthropic import Anthropic

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("talex-backend")

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

ALLOWED_ORIGINS = ["*"]


CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5")

if not OPENAI_API_KEY:
    logger.warning("OPENAI_API_KEY no está configurada. El endpoint /api/transcribe fallará.")
if not ANTHROPIC_API_KEY:
    logger.warning("ANTHROPIC_API_KEY no está configurada. El endpoint /api/generate-minuta fallará.")

openai_client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None
anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None

app = FastAPI(title="TALEX API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_AUDIO_BYTES = 25 * 1024 * 1024


# ---------------------------------------------------------------------------
# Modelos de datos
# ---------------------------------------------------------------------------

class MinutaRequest(BaseModel):
    transcript: str
    asunto: Optional[str] = ""
    participantes: Optional[str] = ""


class MinutaResponse(BaseModel):
    resumen: str
    puntos_tratados: List[str]
    acuerdos: List[str]
    proximos_pasos: List[str]


class TranscribeResponse(BaseModel):
    text: str


class ContactRequest(BaseModel):
    nombre: str
    correo: str
    despacho: Optional[str] = ""
    mensaje: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "openai_configured": openai_client is not None,
        "anthropic_configured": anthropic_client is not None,
    }


@app.post("/api/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(audio: UploadFile = File(...)):
    """Recibe un blob de audio (webm/mp3/wav/m4a) y devuelve la transcripción usando Whisper."""
    if openai_client is None:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY no configurada en el servidor.")

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="El archivo de audio llegó vacío.")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=400, detail="El audio supera el límite de 25MB por solicitud.")

    filename = audio.filename or "grabacion.webm"

    try:
        # Pasamos el archivo de audio con un formato de tupla limpio
        transcription = openai_client.audio.transcriptions.create(
            model="whisper-1",
            file=(filename, audio_bytes, "audio/webm"),
            lenguage="es"
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Error al transcribir audio")
        raise HTTPException(status_code=502, detail=f"Error al llamar a Whisper: {exc}") from exc

    return TranscribeResponse(text=transcription.text.strip())


MINUTA_SYSTEM_PROMPT = """Eres un asistente legal que redacta minutas de reunión a partir de \
transcripciones de conversaciones entre abogado y cliente en Chile.

A partir de la transcripción entregada, genera una minuta estructurada.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin explicaciones, \
sin marcadores de código (nada de ```), con exactamente esta forma:

{
  "resumen": "string: resumen ejecutivo de 2-4 oraciones",
  "puntos_tratados": ["string", "..."],
  "acuerdos": ["string", "..."],
  "proximos_pasos": ["string", "..."]
}

Reglas:
- Si la transcripción no menciona acuerdos explícitos, devuelve una lista vacía en "acuerdos".
- Si no hay próximos pasos identificables, devuelve una lista vacía en "proximos_pasos".
- Usa lenguaje jurídico claro y profesional, en español de Chile.
- No inventes hechos, montos, fechas ni nombres que no estén en la transcripción.
- El campo "resumen" nunca debe quedar vacío: si la transcripción es muy corta, resume lo poco que hay."""


def _extract_json(raw_text: str) -> dict:
    """Extrae el primer objeto JSON válido de la respuesta del modelo, por si agrega texto extra."""
    raw_text = raw_text.strip()
    if raw_text.startswith("```"):
        raw_text = raw_text.strip("`")
        if raw_text.lower().startswith("json"):
            raw_text = raw_text[4:]
    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("La respuesta del modelo no contiene un objeto JSON.")
    return json.loads(raw_text[start : end + 1])


@app.post("/api/generate-minuta", response_model=MinutaResponse)
async def generate_minuta(payload: MinutaRequest):
    """Recibe la transcripción (+ asunto/participantes opcionales) y devuelve la minuta estructurada."""
    if anthropic_client is None:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY no configurada en el servidor.")

    transcript = payload.transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="La transcripción está vacía.")

    user_message = (
        f"Asunto de la reunión: {payload.asunto or 'No especificado'}\n"
        f"Participantes: {payload.participantes or 'No especificado'}\n\n"
        f"Transcripción:\n{transcript}"
    )

    try:
        response = anthropic_client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=1500,
            system=MINUTA_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Error al generar la minuta con Claude")
        raise HTTPException(status_code=502, detail=f"Error al llamar a Claude: {exc}") from exc

    raw_text = "".join(block.text for block in response.content if block.type == "text")

    try:
        data = _extract_json(raw_text)
    except (ValueError, json.JSONDecodeError) as exc:
        logger.error("Respuesta de Claude no parseable: %s", raw_text)
        raise HTTPException(status_code=502, detail="El modelo no devolvió un JSON válido.") from exc

    return MinutaResponse(
        resumen=data.get("resumen", ""),
        puntos_tratados=data.get("puntos_tratados", []) or [],
        acuerdos=data.get("acuerdos", []) or [],
        proximos_pasos=data.get("proximos_pasos", []) or [],
    )


@app.post("/api/contact")
async def receive_contact(payload: ContactRequest):
    """Recibe el formulario de contacto. Por ahora solo lo registra en el log del servidor."""
    logger.info(
        "Nuevo contacto - nombre=%s correo=%s despacho=%s mensaje=%s",
        payload.nombre, payload.correo, payload.despacho, payload.mensaje,
    )
    return {"status": "received"}