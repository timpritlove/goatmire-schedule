#!/usr/bin/env python3
"""Fetch the Goatmire schedule and write data/schedule.json + speaker photos.

Sources:
  - https://goatmire.com/schedule       embedded Sessionize grid (ids, rooms, UTC times, tags)
  - https://goatmire.com/schedule.json  day labels, talk and speaker page URLs
  - Sessionize modal endpoints          session descriptions, speaker tagline/bio/photo

Only the Python standard library is used. Run from anywhere:
  python3 scripts/fetch-schedule.py
"""

import html
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SITE = "https://goatmire.com"
TZ = ZoneInfo("Europe/Stockholm")
ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "schedule.json"
PHOTO_DIR = ROOT / "img" / "speakers"
UA = {"User-Agent": "goatmire-schedule-pwa/1.0"}


def fetch(url, post=False):
    req = urllib.request.Request(url, headers=UA, data=b"" if post else None)
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read()


def text(fragment):
    """HTML fragment -> plain text, keeping line breaks."""
    fragment = re.sub(r"<br\s*/?>", "\n", fragment)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return html.unescape(fragment).strip()


def first(pattern, s, default=None):
    m = re.search(pattern, s, re.S)
    return m.group(1) if m else default


def local(utc):
    # Sessionize prints 7 fractional digits, which fromisoformat rejects on older Pythons
    dt = datetime.strptime(utc[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    return dt.astimezone(TZ)


def parse_grid(page):
    """Return (sessionize event id, days) from the embedded Sessionize grid."""
    event_id = first(r"showModal\('([^']+)'", page)
    days = []
    chunks = re.split(r'<h1 class="sz-day__title"', page)[1:]
    for chunk in chunks:
        day_start = local(first(r'data-sztz="DayDate\|[^|]*\|([^|"]+)', chunk))
        rooms = []
        for rid, name in re.findall(
            r'sz-cssgrid__track-label sz-room sz-room--(\d+)"[^>]*>(.*?)</', chunk, re.S
        ):
            if rid not in [r["id"] for r in rooms]:
                rooms.append({"id": rid, "name": text(name)})
        sessions = []
        for block in re.split(r"<div data-sessionid=", chunk)[1:]:
            kind, sid = re.search(r"showModal\('[^']+', '(\w+)', '([^']+)'\)", block).groups()
            start, end = re.search(
                r'sz-session__time" data-sztz="[^|]*\|[^|]*\|([^|"]+)\|([^|"]+)"', block
            ).groups()
            start, end = local(start), local(end)
            speakers_html = first(r'<ul class="sz-session__speakers">(.*?)</ul>', block, "")
            sessions.append(
                {
                    "id": sid,
                    "service": kind == "servicesession",
                    "title": text(first(r'sz-session__title">\s*<a[^>]*>(.*?)</a>', block)),
                    "room": first(r'data-roomid="(\d+)"', block),
                    "start": start.strftime("%H:%M"),
                    "end": end.strftime("%H:%M"),
                    "startUtc": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "endUtc": end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "speakers": re.findall(r"'speaker', '([^']+)'", speakers_html),
                    "tags": [
                        text(t)
                        for t in re.findall(r'<li class="sz-tag[^>]*>(.*?)</li>', block, re.S)
                    ],
                }
            )
        for r in rooms:
            r_sessions = sorted(
                (s for s in sessions if s["room"] == r["id"]), key=lambda s: s["startUtc"]
            )
            for a, b in zip(r_sessions, r_sessions[1:]):
                if b["startUtc"] < a["endUtc"]:
                    print(f"warning: overlap in {r['name']}: {a['title']} / {b['title']}")
        days.append({"date": day_start.strftime("%Y-%m-%d"), "rooms": rooms, "sessions": sessions})
    return event_id, days


def session_details(event_id, s):
    kind = "servicesession" if s["service"] else "session"
    modal = fetch(f"https://sessionize.com/api/v2/{event_id}/{kind}?id={s['id']}", post=True).decode()
    desc = first(r'<p class="sz-session__description">(.*?)</p>', modal)
    return text(desc) if desc else ""


def speaker_details(event_id, sid):
    modal = fetch(f"https://sessionize.com/api/v2/{event_id}/speaker?id={sid}", post=True).decode()
    speaker = {
        "id": sid,
        "name": text(first(r'sz-speaker__name">(.*?)</h3>', modal, "")),
        "tagline": text(first(r'sz-speaker__tagline">(.*?)</h4>', modal, "")),
        "bio": text(first(r'sz-speaker__bio">(.*?)</p>', modal, "")),
        "photo": None,
    }
    photo_url = first(r'sz-speaker__photo">\s*<img src="([^"]+)"', modal)
    if photo_url:
        ext = Path(photo_url.split("?")[0]).suffix.lower() or ".jpg"
        target = PHOTO_DIR / f"{sid}{ext}"
        target.write_bytes(fetch(html.unescape(photo_url)))
        speaker["photo"] = f"img/speakers/{target.name}"
    return speaker


def main():
    event_id, days = parse_grid(fetch(f"{SITE}/schedule").decode())
    if not days:
        sys.exit("error: no schedule days found in the Sessionize grid")
    site_json = json.loads(fetch(f"{SITE}/schedule.json"))

    # Goatmire's own JSON knows the day labels and the canonical talk/speaker pages
    labels, talk_urls, speaker_urls = {}, {}, {}
    for day in site_json["days"]:
        labels[day["date"]] = day.get("label")
        for space in day["spaces"]:
            for s in space["sessions"]:
                if s.get("url"):
                    talk_urls[(day["date"], s["start_time"], s["title"].strip())] = s["url"]
                for sp in s.get("speakers", []):
                    if sp.get("url"):
                        speaker_urls[sp["name"].strip()] = sp["url"]

    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    for old in PHOTO_DIR.iterdir():
        old.unlink()

    all_sessions = [s for d in days for s in d["sessions"]]
    speaker_ids = sorted({sid for s in all_sessions for sid in s["speakers"]})
    with ThreadPoolExecutor(8) as pool:
        descriptions = list(pool.map(lambda s: session_details(event_id, s), all_sessions))
        speakers = list(pool.map(lambda sid: speaker_details(event_id, sid), speaker_ids))

    for s, desc in zip(all_sessions, descriptions):
        s["description"] = desc
    for d in days:
        d["label"] = labels.get(d["date"])
        for s in d["sessions"]:
            s["url"] = talk_urls.get((d["date"], s["start"], s["title"]))
    for sp in speakers:
        sp["url"] = speaker_urls.get(sp["name"])

    out = {
        "event": site_json.get("event", "Goatmire"),
        "site": site_json.get("site", SITE),
        "timezone": "Europe/Stockholm",
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "days": days,
        "speakers": {sp["id"]: sp for sp in speakers},
    }
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")

    talks = [s for s in all_sessions if not s["service"]]
    print(f"{len(days)} days, {len(all_sessions)} sessions ({len(talks)} talks/workshops), "
          f"{len(speakers)} speakers")
    print(f"missing: {sum(not s['description'] for s in talks)} descriptions, "
          f"{sum(not s['url'] for s in talks)} talk urls, "
          f"{sum(not sp['photo'] for sp in speakers)} photos, "
          f"{sum(not sp['bio'] for sp in speakers)} bios")


if __name__ == "__main__":
    main()
