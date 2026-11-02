#!/usr/bin/env python3
"""Fetch base EPEX prices directly and atomically refresh OptiVolt's forecast feed."""

from __future__ import annotations

import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


API_URL = os.environ.get(
    "EPEX_PREDICTOR_URL", "http://192.168.1.117:8000/prices_short"
)
REGION = os.environ.get("EPEX_REGION", "NL")
HOURS = int(os.environ.get("EPEX_FORECAST_HOURS", "168"))
OUTPUT_PATH = Path(
    os.environ.get("OPTIVOLT_FORECAST_PATH", "/home/optivolt/forecast.json")
)
REQUEST_TIMEOUT_SECONDS = 240  # EpexPredictor may need time for a cold model start.
SLOT_SECONDS = 15 * 60
MINIMUM_SLOTS = 96  # Retain the previous good feed if less than a day is returned.


def api_url() -> str:
    parts = urlsplit(API_URL)
    query = dict(item.split("=", 1) for item in parts.query.split("&") if "=" in item)
    query.update(
        {
            "region": REGION,
            "hours": str(HOURS),
            "unit": "CT_PER_KWH",
            "timezone": "Europe/Amsterdam",
        }
    )
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )


def fetch_points() -> list[dict[str, object]]:
    request = Request(api_url(), headers={"Accept": "application/json"})
    with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        payload = json.load(response)

    if not isinstance(payload, dict):
        raise ValueError("EpexPredictor returned a non-object response")
    timestamps = payload.get("s")
    prices = payload.get("t")
    if not isinstance(timestamps, list) or not isinstance(prices, list):
        raise ValueError("EpexPredictor response is missing the s/t price arrays")
    if len(timestamps) != len(prices) or len(prices) < MINIMUM_SLOTS:
        raise ValueError(f"EpexPredictor returned an incomplete series ({len(prices)} slots)")

    points: list[dict[str, object]] = []
    previous_timestamp: int | None = None
    for raw_timestamp, raw_price in zip(timestamps, prices):
        if isinstance(raw_timestamp, bool) or not isinstance(raw_timestamp, (int, float)):
            raise ValueError("EpexPredictor returned an invalid timestamp")
        timestamp = int(raw_timestamp)
        if timestamp != raw_timestamp:
            raise ValueError("EpexPredictor returned a fractional timestamp")
        if previous_timestamp is not None and timestamp != previous_timestamp + SLOT_SECONDS:
            raise ValueError("EpexPredictor returned a gap or out-of-order price slot")
        if isinstance(raw_price, bool) or not isinstance(raw_price, (int, float)):
            raise ValueError("EpexPredictor returned a non-numeric price")
        price = float(raw_price)
        if not math.isfinite(price):
            raise ValueError("EpexPredictor returned a non-finite price")

        time_iso = datetime.fromtimestamp(timestamp, timezone.utc).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        # Keep EpexPredictor's numeric precision; OptiVolt applies its own tariffs.
        points.append({"time": time_iso, "price": price})
        previous_timestamp = timestamp

    return points


def write_atomically(points: list[dict[str, object]]) -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "consumption_data": points,
        "injection_data": [dict(point) for point in points],
    }
    fd, temporary_path = tempfile.mkstemp(prefix=f".{OUTPUT_PATH.name}.", dir=OUTPUT_PATH.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(payload, output, allow_nan=False, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary_path, 0o644)
        os.replace(temporary_path, OUTPUT_PATH)
    except Exception:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise


def main() -> None:
    points = fetch_points()
    write_atomically(points)
    print(
        f"[fetch_epexprediction] saved {len(points)} base-price slots "
        f"({points[0]['time']} through {points[-1]['time']}) to {OUTPUT_PATH}"
    )


if __name__ == "__main__":
    main()
