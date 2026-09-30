# Goatmire Schedule

Installable, offline-capable web app showing the schedule of
[Goatmire Elixir & NervesConf EU 2026](https://goatmire.com/schedule).

Plain HTML/CSS/JS, no build step. All times are shown in Swedish time
(Europe/Stockholm), independent of the device timezone.

## Run locally

    python3 -m http.server 8000

Then open <http://localhost:8000>. Append `?now=2026-09-30T11:20` to simulate a
point in time during the conference.

## Update the schedule

    python3 scripts/fetch-schedule.py

This rewrites `data/schedule.json` and `img/speakers/` from goatmire.com and the
Sessionize data behind it (descriptions, speaker bios, taglines, photos).
Installed apps pick up a changed schedule in the background the next time they
are opened while online.

## Deploy

Copy the directory to any static host that serves HTTPS (required for the
service worker and for installing). All paths are relative, so a subdirectory
works too.
