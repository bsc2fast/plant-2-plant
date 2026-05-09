#!/usr/bin/env python3
"""
plant-2-plant hive — local runtime.

Serves the studio UI (static files) AND the plant API.
Bound to 127.0.0.1. Plant data lives in ./plants/*.json.

Endpoints:
  GET    /api/plants                  list all plants
  GET    /api/plants/<id>             get one plant
  POST   /api/plants                  create new plant {common_name: "..."}
  PUT    /api/plants/<id>             update biology / personality / mood
  DELETE /api/plants/<id>             delete plant
  POST   /api/plants/<id>/derive      derive personality from biology via LLM
  POST   /api/plants/<id>/talk        plant hears text -> responds
  GET    /api/health                  diagnostic

LLM calls require ANTHROPIC_API_KEY in env. Default model: claude-sonnet-4-6.
"""

import http.server
import json
import os
import re
import socketserver
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

PORT = int(os.environ.get('PORT', 4450))
ROOT = Path(__file__).resolve().parent
PLANTS_DIR = ROOT / 'plants'
PLANTS_DIR.mkdir(exist_ok=True)

ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY')
ANTHROPIC_MODEL = os.environ.get('ANTHROPIC_MODEL', 'claude-sonnet-4-6')

VALID_ID = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
MAX_BODY = 256 * 1024


DERIVATION_PROMPT = """\
You are designing a believable inner voice for a real plant species, for an art \
project where each houseplant gets an LLM-driven persona grounded in its biology.

Given the biological card below, derive a stable PERSONALITY PROFILE for this \
specific plant. Output STRICT JSON (no prose, no markdown fences) with these keys:

  "tone":              one short phrase describing baseline tone
  "voice_pitch":       one of: "low" | "mid" | "high"
  "voice_rate":        one of: "slow" | "normal" | "brisk"
  "voice_name":        a short hint for picking a Web Speech API voice
  "loves":             array of 3-5 short strings — things this plant gravitates toward
  "fears":             array of 3-5 short strings — things this plant dreads
  "sleep_window_local": "HH:MM-HH:MM" — when this plant is dormant (derive from photoperiod)
  "stressed_phrases":  array of 3-5 short utterances when comfort band is exceeded
  "system_prompt":     4-7 sentence prompt describing how this plant speaks. Reference \
species, native habitat, physical habits, recognizable voice. Used as system prompt \
for every utterance. Never break character; do not mention being an LLM or a model.

Biological card:
{card}
"""


TALK_TEMPLATE = """\
Someone nearby just said: "{heard}"

Recent things you remember (oldest first):
{memory}

Current conditions in your pot right now:
- temperature: {temp_c}°C   (your comfort band: {comfort_temp})
- humidity:    {humidity_pct}%   (your comfort band: {comfort_humidity})
- mood drift: {mood}

Reply in 1-2 short sentences, in character. Do not repeat what was said back at the speaker. \
Do not explain that you are a plant. If the speaker said nothing meaningful and you have \
nothing to say, return only the single word: SILENCE
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def call_anthropic(system, user, max_tokens=400):
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY env var not set on the hive process")
    payload = {
        "model": ANTHROPIC_MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": user}],
    }
    if system:
        payload["system"] = system
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors='ignore')
        raise RuntimeError(f"Anthropic API {e.code}: {msg[:300]}")
    parts = [b["text"] for b in resp.get("content", []) if b.get("type") == "text"]
    return "".join(parts).strip()


def atomic_write_json(path: Path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    os.replace(tmp, path)


def load_plant(plant_id):
    if not VALID_ID.match(plant_id):
        return None
    p = PLANTS_DIR / f"{plant_id}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())


def save_plant(plant):
    if not VALID_ID.match(plant["id"]):
        raise ValueError(f"invalid plant id: {plant['id']!r}")
    plant["version"] = int(plant.get("version", 0)) + 1
    plant["updated_at"] = now_iso()
    atomic_write_json(PLANTS_DIR / f"{plant['id']}.json", plant)


def list_plants():
    out = []
    for f in sorted(PLANTS_DIR.glob("*.json")):
        try:
            out.append(json.loads(f.read_text()))
        except Exception as e:
            print(f"  ! failed to load {f.name}: {e}", file=sys.stderr)
    return out


def slugify(name, taken):
    base = re.sub(r'[^a-z0-9-]', '-', name.lower()).strip('-')[:32] or "plant"
    candidate = base
    n = 1
    while candidate in taken:
        n += 1
        candidate = f"{base}-{n}"
    return candidate


def empty_plant_template(name):
    existing = {p.stem for p in PLANTS_DIR.glob("*.json")}
    return {
        "id": slugify(name, existing),
        "version": 0,
        "biology": {
            "common_name": name,
            "species": "",
            "native_range": "",
            "watering": {"interval_days": 7, "soil_dry_top_cm": 2},
            "light": {"preferred": "bright indirect", "tolerates": "low"},
            "comfort": {"temp_c": [18, 26], "humidity_pct": [40, 70]},
            "critical": {"temp_c_min": 5, "humidity_pct_min": 25},
            "growth": "",
            "lifespan_years": None,
            "notes": "",
        },
        "personality": None,
        "memory": [],
        "mood": {"current": "content", "since": now_iso()},
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


# ─── HTTP handler ──────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):

    def log_message(self, fmt, *args):
        sys.stderr.write(f"  {self.address_string()}  {fmt % args}\n")

    # ---- helpers ----------------------------------------------------------

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length", "0") or "0")
        if n > MAX_BODY:
            raise ValueError("body too large")
        if n == 0:
            return {}
        return json.loads(self.rfile.read(n).decode())

    def _path_only(self):
        return self.path.split("?", 1)[0]

    # ---- routing ----------------------------------------------------------

    def do_GET(self):
        p = self._path_only()
        if p == "/api/health":
            return self._send_json(200, {
                "ok": True,
                "model": ANTHROPIC_MODEL,
                "anthropic_key": bool(ANTHROPIC_API_KEY),
                "plants_dir": str(PLANTS_DIR),
                "plant_count": len(list(PLANTS_DIR.glob("*.json"))),
            })
        if p == "/api/plants":
            return self._send_json(200, {"plants": list_plants()})
        m = re.match(r"^/api/plants/([a-z0-9-]+)$", p)
        if m:
            plant = load_plant(m.group(1))
            if not plant:
                return self._send_json(404, {"error": "plant not found"})
            return self._send_json(200, plant)
        return super().do_GET()

    def do_POST(self):
        try:
            p = self._path_only()
            if p == "/api/plants":
                return self._handle_create()
            m = re.match(r"^/api/plants/([a-z0-9-]+)/(derive|talk)$", p)
            if m:
                pid, action = m.group(1), m.group(2)
                plant = load_plant(pid)
                if not plant:
                    return self._send_json(404, {"error": "plant not found"})
                body = self._read_body()
                if action == "derive":
                    return self._derive(plant)
                if action == "talk":
                    return self._talk(plant, body)
        except Exception as e:
            return self._send_json(500, {"error": str(e)})
        self._send_json(404, {"error": "not found"})

    def do_PUT(self):
        try:
            m = re.match(r"^/api/plants/([a-z0-9-]+)$", self._path_only())
            if not m:
                return self._send_json(404, {"error": "not found"})
            existing = load_plant(m.group(1))
            if not existing:
                return self._send_json(404, {"error": "plant not found"})
            body = self._read_body()
            for k in ("biology", "personality", "mood"):
                if k in body:
                    existing[k] = body[k]
            save_plant(existing)
            self._send_json(200, existing)
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def do_DELETE(self):
        m = re.match(r"^/api/plants/([a-z0-9-]+)$", self._path_only())
        if not m:
            return self._send_json(404, {"error": "not found"})
        f = PLANTS_DIR / f"{m.group(1)}.json"
        if not f.exists():
            return self._send_json(404, {"error": "plant not found"})
        f.unlink()
        self._send_json(200, {"deleted": m.group(1)})

    # ---- actions ----------------------------------------------------------

    def _handle_create(self):
        body = self._read_body()
        name = body.get("common_name", "").strip()
        if not name:
            return self._send_json(400, {"error": "common_name required"})
        plant = empty_plant_template(name)
        save_plant(plant)
        self._send_json(201, plant)

    def _derive(self, plant):
        prompt = DERIVATION_PROMPT.format(card=json.dumps(plant["biology"], indent=2))
        try:
            raw = call_anthropic(
                system="You output strict JSON only. No markdown, no prose, no code fences.",
                user=prompt,
                max_tokens=900,
            )
            cleaned = re.sub(r'^```(?:json)?\s*', '', raw).rstrip('`').strip()
            persona = json.loads(cleaned)
        except json.JSONDecodeError as e:
            return self._send_json(500, {"error": f"LLM returned non-JSON: {raw[:200]}"})
        except Exception as e:
            return self._send_json(500, {"error": f"derivation failed: {e}"})
        plant["personality"] = persona
        save_plant(plant)
        self._send_json(200, plant)

    def _talk(self, plant, body):
        if not plant.get("personality"):
            return self._send_json(400, {"error": "personality not derived yet"})
        heard = (body.get("text") or "").strip()
        if not heard:
            return self._send_json(400, {"error": "text required"})
        sensors = body.get("sensors") or {}
        memory = plant.get("memory", [])
        recent = memory[-8:]
        memory_str = "\n".join(
            f"  - {m['kind']}: \"{m['text']}\"" for m in recent
        ) or "  (none yet)"
        comfort = plant["biology"]["comfort"]
        prompt = TALK_TEMPLATE.format(
            heard=heard,
            memory=memory_str,
            temp_c=sensors.get("temp_c", "—"),
            comfort_temp=f"{comfort['temp_c'][0]}–{comfort['temp_c'][1]}°C",
            humidity_pct=sensors.get("humidity_pct", "—"),
            comfort_humidity=f"{comfort['humidity_pct'][0]}–{comfort['humidity_pct'][1]}%",
            mood=plant.get("mood", {}).get("current", "neutral"),
        )
        try:
            reply = call_anthropic(
                system=plant["personality"]["system_prompt"],
                user=prompt,
                max_tokens=200,
            )
        except Exception as e:
            return self._send_json(500, {"error": f"LLM call failed: {e}"})
        ts = now_iso()
        memory.append({"ts": ts, "kind": "heard", "text": heard})
        spoke = reply.strip().upper() != "SILENCE"
        if spoke:
            memory.append({"ts": ts, "kind": "spoke", "text": reply})
        plant["memory"] = memory[-200:]
        save_plant(plant)
        self._send_json(200, {"reply": reply, "spoke": spoke, "plant": plant})


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.chdir(ROOT)
    server = ThreadingServer(("127.0.0.1", PORT), Handler)
    print(f"\n  plant-2-plant hive  →  http://127.0.0.1:{PORT}")
    print(f"    studio:    http://127.0.0.1:{PORT}/studio.html")
    print(f"    concept:   http://127.0.0.1:{PORT}/index.html")
    print(f"    api:       http://127.0.0.1:{PORT}/api/health")
    print(f"    plants:    {PLANTS_DIR}  ({len(list(PLANTS_DIR.glob('*.json')))} loaded)")
    print(f"    model:     {ANTHROPIC_MODEL}")
    print(f"    api key:   {'set ✓' if ANTHROPIC_API_KEY else 'NOT SET ✗  (derive/talk will 500)'}")
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")


if __name__ == "__main__":
    main()
