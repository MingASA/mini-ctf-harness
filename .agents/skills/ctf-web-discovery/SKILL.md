---
name: ctf-web-discovery
description: Find hidden HTTP paths, API parameters, and virtual hosts using ffuf and application-derived wordlists.
  Use when a web service responds but its useful endpoint or input names are missing. For TCP port discovery use
  ctf-network-recon; for a known request that behaves incorrectly use ctf-http-replay.
---

# Web Endpoint and Input Discovery

Find a small set of useful HTTP entry points and verify them individually.

## Start
Inspect the landing page, linked scripts, forms, and available source for candidate names. Record a normal response and two nonexistent-path controls before filtering scan output. Use a local wordlist that matches the specific task.

## Choose a reference
- Hidden files/directories, catch-all responses, or result filtering: [paths-and-filtering.md](references/paths-and-filtering.md).
- Host routing, missing parameter names, or an authenticated request: [hosts-and-parameters.md](references/hosts-and-parameters.md).

## Discover, then replay
1. Select one axis: path, Host, or a parameter name/value. Start with application-derived candidates, then a small relevant SecLists subset when needed.
2. Run a bounded ffuf job with JSON output. Tune concurrency to response stability; increasing timeout or threads is not a substitute for a working baseline.
3. Check filters against a known positive if available. Auto-calibration is useful for repeated noise, but a filter that hides valid pages must be changed.
4. Replay promising results with curl, preserving the Host, scheme, cookies, and method. Compare bodies and redirects, not status alone.
5. Turn the verified result into the next concrete request or source-analysis target.

Retain wordlist identity, fuzz position, filters, completion status, and verified discoveries. A response anomaly is a lead to test, not an automatic finding.
