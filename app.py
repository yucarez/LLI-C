import math
import random
import threading
import time

from flask import Flask, jsonify, render_template

app = Flask(__name__)

RATES = {
    "slow":      {"alpha": 0.00293, "cap": 3.2,  "label": "slow growth"},
    "medium":    {"alpha": 0.01172, "cap": 7.5,  "label": "medium growth"},
    "fast":      {"alpha": 0.04689, "cap": 13.0, "label": "fast growth"},
    "ultrafast": {"alpha": 0.18780, "cap": 19.0, "label": "ultra-fast growth"},
}

ALARM_THRESHOLD = 8.0   # MW
MAX_MW = 20.0           # gauge/chart ceiling
COLS, ROWS = 48, 28     # thermal grid resolution STOP MESSING THIS UP, IT'S HARD-CODED INTO THE CSS AND JS
PEAK_HOLD_SECONDS = 6.0
DECAY_TICK = 0.12
DECAY_RATE = 0.965

_lock = threading.Lock()

_state = {
    "app_start": time.monotonic(),
    "scenario": None,     # dict while a scenario is running/decaying
    "history": [],         # [{t, hrr}] rolling HRR trace for the chart
    "log": [],             # [{t, msg, cls}] newest first
}


def _fmt_clock(elapsed_seconds: float) -> str:
    s = int(max(0, elapsed_seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"T+{h:02d}:{m:02d}:{sec:02d}"


def _uptime() -> float:
    return time.monotonic() - _state["app_start"]


def _add_log(msg: str, cls: str = "info") -> None:
    _state["log"].insert(0, {"t": _fmt_clock(_uptime()), "msg": msg, "cls": cls})
    if len(_state["log"]) > 40:
        _state["log"].pop()


_add_log("EFS-3 console initialized. Standing by for scenario selection.", "info")

def _current_elapsed(sc: dict) -> float:
    """
    Elapsed *simulation* time for a scenario, respecting manual run/pause.
    While paused, this is frozen at whatever value it held at pause time.
    While running, it is the accumulated time plus time since the last resume.
    """
    if sc["running"]:
        return sc["accum_elapsed"] + (time.monotonic() - sc["resume_ts"])
    return sc["accum_elapsed"]


def _dynamics(elapsed: float, sc: dict):
    """Return (hrr, phase, t_cap) for a scenario dict at a given elapsed time."""
    alpha, cap = sc["alpha"], sc["cap"]

    t_cap = math.sqrt(cap * 8.0 / alpha) if alpha > 0 else 0.0

    if elapsed < t_cap:
        hrr = alpha * elapsed * elapsed / 8.0
        phase = "incipient" if hrr < 0.4 else "growth"
    elif elapsed < t_cap + PEAK_HOLD_SECONDS:
        hrr = cap + math.sin(elapsed * 3) * 0.05
        phase = "peak"
    else:
        decay_elapsed = elapsed - (t_cap + PEAK_HOLD_SECONDS)
        hrr = cap * (DECAY_RATE ** (decay_elapsed / DECAY_TICK))
        if hrr < 0.15:
            hrr = 0.0
            phase = "complete"
        else:
            phase = "decay"

    return hrr, phase, t_cap


def _advance_scenario():
    sc = _state["scenario"]
    if sc is None:
        return None

    flags = sc["flags"]
    alpha, cap, label = sc["alpha"], sc["cap"], sc["label"]

    if not flags["started"]:
        return "armed", 0.0, 0.0, cap, label, False, True

    elapsed = _current_elapsed(sc)
    hrr, phase, t_cap = _dynamics(elapsed, sc)

    if phase in ("growth", "peak", "decay", "complete") and not flags["growth"]:
        flags["growth"] = True
        _add_log("Thermal signature confirmed. Entering growth phase.", "growth")

    if not flags["alarm"] and cap >= ALARM_THRESHOLD:
        t_alarm = math.sqrt(ALARM_THRESHOLD * 8.0 / alpha)
        if elapsed >= t_alarm:
            flags["alarm"] = True
            _add_log(
                f"HRR exceeded alarm threshold ({ALARM_THRESHOLD:.1f} MW). "
                "Alarm condition simulated.",
                "alarm",
            )

    if phase in ("peak", "decay", "complete") and not flags["peak"]:
        flags["peak"] = True
        _add_log(
            f"Peak heat release reached: {cap:.1f} MW",
            "alarm" if cap >= ALARM_THRESHOLD else "growth",
        )

    if phase in ("decay", "complete") and not flags["decay"]:
        flags["decay"] = True
        _add_log("Entering decay phase. Modeling suppression / fuel depletion.", "info")

    if phase == "complete":
        if not flags["complete"]:
            flags["complete"] = True
            _add_log(
                "Scenario complete. Sensor field returned to ambient baseline.",
                "info",
            )
        _state["scenario"] = None
        return "standby", 0.0, elapsed, cap, label, False, False

    return phase, hrr, elapsed, cap, label, sc["running"], False


def _start_scenario(rate_key: str):
    r = RATES[rate_key]
    _state["scenario"] = {
        "rate_key": rate_key,
        "alpha": r["alpha"],
        "cap": r["cap"],
        "label": r["label"],
        "running": False,
        "accum_elapsed": 0.0,
        "resume_ts": None,
        "flags": {"started": False, "growth": False, "alarm": False, "peak": False,
                  "decay": False, "complete": False},
    }
    _state["history"] = []
    _add_log(f"Scenario armed: {r['label'].upper()} (target peak ~{r['cap']:.1f} MW). Press Run to begin.", "info")


def _run_scenario():
    sc = _state["scenario"]
    if sc is None or sc["running"]:
        return
    sc["running"] = True
    sc["resume_ts"] = time.monotonic()
    if not sc["flags"]["started"]:
        sc["flags"]["started"] = True
        _add_log(f"Simulation started: {sc['label']}.", "info")
    else:
        _add_log("Simulation resumed.", "info")


def _pause_scenario():
    sc = _state["scenario"]
    if sc is None or not sc["running"]:
        return
    sc["accum_elapsed"] += time.monotonic() - sc["resume_ts"]
    sc["running"] = False
    sc["resume_ts"] = None
    _add_log("Simulation paused.", "info")


def _reset_scenario():
    _state["scenario"] = None
    _state["history"] = []
    _add_log("Scenario cleared. Sensor field returned to ambient baseline.", "info")

def _build_state_payload():
    result = _advance_scenario()
    if result is None:
        phase, hrr, elapsed, cap, label, running, armed = "standby", 0.0, 0.0, 0.0, None, False, False
    else:
        phase, hrr, elapsed, cap, label, running, armed = result

    frac = hrr / MAX_MW
    # "active" gates the sensor readouts (temp/smoke/CO/flicker/range) and
    # the radar blip. It deliberately excludes "armed," a scenario that
    # has been selected but never Run should still read as ambient
    # baseline, not jump to life the instant it's picked.
    active = phase not in ("standby", "armed")
    paused = active and not running
    temp = 22 + frac * 430
    smoke = min(100, frac * 92 + (random.random() * 3 if active else 0))
    co = min(400, frac * 260 + (random.random() * 8 if active else 0))
    flicker = None if not active else (1.1 + frac * 2.6 + math.sin(elapsed * 7) * 0.15)
    rng = None if not active else max(0.6, 4.2 - frac * 3.1)

    # hotspot drift
    drift = 0.15 + frac * 0.4
    cx = 0.5 + math.sin(elapsed * 0.35) * 0.12 * drift
    cy = 0.62 + math.cos(elapsed * 0.28) * 0.08 * drift

    # thermal shit
    grid = []
    for y in range(ROWS):
        row = []
        ny = y / ROWS
        for x in range(COLS):
            nx = x / COLS
            dx = nx - cx
            dy = (ny - cy) * 1.3
            d = math.sqrt(dx * dx + dy * dy)
            flick = 1 + math.sin(elapsed * 9 + x * 0.7 + y * 0.5) * 0.06 * frac
            plume = max(0.0, 1 - d * (2.4 - frac * 1.1)) * flick
            val = 0.03 + plume * (0.25 + frac * 0.85)
            val += (random.random() - 0.5) * 0.015
            row.append(round(max(0.0, min(1.0, val)), 3))
        grid.append(row)

    # radar
    sweep_angle = (_uptime() * 2.1) % (2 * math.pi)
    blip = None
    if active:
        ang = (cx - 0.5) * math.pi * 1.4 + math.pi * 0.5
        dist = 0.75 - frac * 0.35
        pulse = 3 + frac * 7 + math.sin(elapsed * 6) * 1.2
        blip = {
            "angle": ang,
            "dist": dist,
            "pulse": pulse,
            "alarm": frac >= (ALARM_THRESHOLD / MAX_MW),
        }

    # Only record a point while the clock is actually running, so pausing
    # never adds duplicate/frozen samples. The full trace is sent to the
    # browser every poll, no rolling-window cutoff so the chart can show
    # the whole run in a horizontally scrollable panel instead of scrolling
    # its window forward on its own.
    if running:
        last = _state["history"][-1] if _state["history"] else None
        if last is None or round(elapsed, 2) != last["t"]:
            _state["history"].append({"t": round(elapsed, 2), "hrr": round(hrr, 3)})
        if len(_state["history"]) > 2000:
            _state["history"] = _state["history"][-2000:]

    # status pill (yooo blackpill)
    sc = _state["scenario"]
    if phase == "standby":
        status_cls, status_text = "", "STANDBY"
        phase_label = "Phase: standby"
    elif phase == "armed":
        status_cls, status_text = "armed", "ARMED"
        phase_label = f"Phase: armed — {label} (press Run to begin)"
    elif phase == "incipient":
        status_cls, status_text = "incipient", "INCIPIENT"
        phase_label = f"Phase: incipient — {label}"
    elif phase == "growth":
        alarmed = sc["flags"]["alarm"] if sc else False
        status_cls, status_text = ("alarm", "ALARM") if alarmed else ("growth", "GROWTH")
        phase_label = f"Phase: growth — {label}"
    elif phase == "peak":
        status_cls, status_text = ("alarm", "ALARM") if cap >= ALARM_THRESHOLD else ("growth", "GROWTH")
        phase_label = f"Phase: peak — holding {cap:.1f} MW"
    else:  # decay
        status_cls, status_text = "decay", "DECAY"
        phase_label = "Phase: decay — modeled suppression effect"

    if paused:
        status_cls = (status_cls + " paused").strip()
        phase_label += " — PAUSED"

    return {
        "phase": phase,
        "running": running,
        "armed": armed,
        "paused": paused,
        "status_cls": status_cls,
        "status_text": status_text,
        "phase_label": phase_label,
        "buttons_disabled": phase != "standby",
        "run_disabled": sc is None or running,
        "pause_disabled": sc is None or not running,
        "clock": _fmt_clock(_uptime()),
        "hrr": round(hrr, 2),
        "cap": round(cap, 2) if cap else 0,
        "max_mw": MAX_MW,
        "alarm_threshold": ALARM_THRESHOLD,
        "readouts": {
            "temp": round(temp, 1),
            "smoke": round(smoke),
            "co": round(co),
            "flicker": None if flicker is None else round(flicker, 1),
            "range": None if rng is None else round(rng, 1),
        },
        "grid": {"cols": COLS, "rows": ROWS, "values": grid},
        "radar": {"sweep_angle": sweep_angle, "blip": blip},
        "chart": {
            "points": _state["history"],
            "elapsed": round(elapsed, 2),
        },
        "log": _state["log"],
    }

@app.route("/")
def index():
    return render_template(
        "index.html",
        rates=RATES,
        alarm_threshold=ALARM_THRESHOLD,
    )


@app.route("/api/state")
def api_state():
    with _lock:
        return jsonify(_build_state_payload())


@app.route("/api/scenario/<rate_key>", methods=["POST"])
def api_start(rate_key):
    if rate_key not in RATES:
        return jsonify({"error": "unknown scenario"}), 400
    with _lock:
        _start_scenario(rate_key)
        return jsonify(_build_state_payload())


@app.route("/api/run", methods=["POST"])
def api_run():
    with _lock:
        _run_scenario()
        return jsonify(_build_state_payload())


@app.route("/api/pause", methods=["POST"])
def api_pause():
    with _lock:
        _pause_scenario()
        return jsonify(_build_state_payload())


@app.route("/api/reset", methods=["POST"])
def api_reset():
    with _lock:
        _reset_scenario()
        return jsonify(_build_state_payload())


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
