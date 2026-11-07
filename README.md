# Defense Strategy Brief

A self-hosted, fully automated daily email digest of U.S. national defense news. Every morning at **5:00 AM Pacific**, an n8n workflow:

1. pulls the last 24 hours from an **allowlist** of credible, low-bias outlets and official primary sources (`config/sources.json`);
2. keeps only stories relevant to the **2026 National Defense Strategy** and the **2022 NDS / Nuclear Posture Review / Missile Defense Review** (`config/topics.json`);
3. removes items it has already sent and clusters coverage of the same event across outlets;
4. applies **corroboration rules** (two independent outlets, or a primary source);
5. summarizes each story neutrally with a **local LLM via Ollama**, tagging which NDS priorities it relates to;
6. emails one HTML digest (with a plain-text part) from your Gmail account via **Gmail SMTP with an app password**, where every summary links its sources.

Failures, empty days and widespread feed outages trigger an **alert email**. A **monthly reminder** asks you to re-verify source bias ratings.

```
Schedule 5:00 AM PT ─► Load config ─► Fetch ~30 feeds (parallel, retries) ─► Parse · 24h window · drop opinion/sponsored
  ─► Drop already-sent URLs (Postgres) ─► Embeddings (nomic-embed-text) ─► Keyword + embedding prefilter
  ─► LLM classification {relevant, score, nds2026_tags, nds2022_tags, rationale} (validated, 1 retry) ─► score ≥ 0.6
  ─► Cluster by embedding ─► Corroboration ─► Rank & cap ─► Article text (robots.txt-aware) ─► LLM summaries (validated, 1 retry)
  ─► Compose email + balance check ─► Gmail SMTP ─► Record sent URLs + run stats ─► Alert if >30% feeds failed
Any error ─► Alerts workflow ─► email · No stories ─► alert email · 1st of each month ─► ratings re-verification reminder
```

---

## Contents
- [What's in the repo](#whats-in-the-repo)
- [Model choice and the tradeoff](#model-choice-and-the-tradeoff)
- [Setup](#setup)
- [Gmail app password (manual, one time)](#gmail-app-password-manual-one-time)
- [Test run and spot checks](#test-run-and-spot-checks)
- [Sourcing policy: bias and corroboration rules](#sourcing-policy-bias-and-corroboration-rules)
- [Editing sources, topics and prompts](#editing-sources-topics-and-prompts)
- [Changing the schedule or the model](#changing-the-schedule-or-the-model)
- [Reliability, alerts and logs](#reliability-alerts-and-logs)
- [Design decisions and deviations from the original spec](#design-decisions-and-deviations-from-the-original-spec)
- [Troubleshooting](#troubleshooting)
- [Development and tests](#development-and-tests)

## What's in the repo

| Path | Purpose |
|---|---|
| `docker-compose.yml` | n8n (2.46.6), Ollama, Postgres on a shared network (`defense-brief-net`); n8n reaches Ollama at `http://ollama:11434` |
| `docker-compose.gpu.yml` | NVIDIA GPU passthrough for Ollama (enabled automatically by `setup.sh` when usable) |
| `.env.example` | All settings and secrets (copy to `.env`; never committed) |
| `setup.sh` | One-time setup: secrets, hardware detection + model choice, model pulls, owner account, credentials, workflow import + publish |
| `config/sources.json` | Allowlist with ratings (AllSides, Ad Fontes Media, MBFC), dates checked, feed test results, exclusion rules |
| `config/topics.json` | Taxonomy derived from both NDS documents (verbatim quotes, page refs, keywords), divergences, digest limits |
| `config/prompts.json` | Classification/summary prompts, loaded-term blocklist, attribution check |
| `workflows/defense-brief-main.json` | Importable daily workflow (generated) |
| `workflows/defense-brief-alerts.json` | Importable error/alert/monthly-reminder workflow (generated) |
| `workflows/src/` | Source for the Code nodes (`lib.js` + `nodes/*.js`); `scripts/build-workflows.js` generates the JSON |
| `db/` | Postgres init: `n8n` and `dsb` databases, `sent_articles`, `run_log`, `run_summary` view |
| `scripts/run-now.sh` | Run immediately (`--dry-run` writes `previews/` instead of emailing) |
| `scripts/test-feeds.sh` | Tests every approved feed from your machine |
| `tests/` | Unit tests (`run-tests.js`) and the end-to-end harness (`e2e/`) |

## Model choice and the tradeoff

**I could not inspect your hardware from the cloud session that built this**, so `setup.sh` checks it on your machine (RAM available to Docker, NVIDIA GPU and VRAM, whether Docker can use the GPU) and picks the strongest summarization model that fits:

| Your hardware | Model chosen | Why |
|---|---|---|
| NVIDIA GPU ≥ 12 GB VRAM | `qwen2.5:14b` | Fits fully in VRAM (~9 GB at Q4). Best instruction-following and JSON reliability of the candidates, at good speed. |
| NVIDIA GPU 6–12 GB | `llama3.1:8b` | ~5 GB, fully on GPU. A 14B would spill to CPU and run several times slower. |
| No usable GPU, ≥ 30 GB RAM | `qwen2.5:14b` | Fits in RAM. Slow on CPU (very roughly 30–90 min per daily run), but it runs unattended at 5 AM. |
| No usable GPU, 14–30 GB RAM | `llama3.1:8b` | Leaves headroom for n8n and Postgres; a 14B would risk swapping. |
| < 14 GB for Docker | `qwen2.5:3b` | Largest that fits reliably; noticeably weaker summaries (setup warns you). |

Embeddings always use **`nomic-embed-text`** (~270 MB, fast on CPU). It powers the relevance prefilter and cross-outlet clustering.

**The tradeoff:** larger models follow the neutrality and attribution rules more reliably, produce valid JSON more often, and spot discrepancies between outlets better. They cost speed and memory, and on CPU the daily run can take an hour. The workflow limits the work: it classifies at most 90 items, summarizes at most 16 stories, and gives each Ollama call a 15-minute timeout. Every summary is also validated (sentence count, a loaded-term blocklist, required attribution), and weaker models get one corrective retry. To override the choice, set `OLLAMA_MODEL` in `.env` (see [Changing the model](#changing-the-schedule-or-the-model)).

**macOS:** Docker cannot use the Apple GPU, so Ollama in Docker runs on CPU. For Metal acceleration, install Ollama natively, set `OLLAMA_BASE_URL=http://host.docker.internal:11434` in `.env`, and pull the models natively.

## Setup

Prerequisites: Docker with Compose v2, `curl`, `python3`, about 15 GB of free disk (models), and optionally the NVIDIA Container Toolkit for GPU use.

```bash
git clone <this repo> && cd News-Aggregator-
```

```bash
./setup.sh
```

The script asks for your recipient address, an n8n owner email and password, and the sending Gmail address and app password. It then does everything else. It's safe to re-run.

Before running it, create a [Gmail app password](#gmail-app-password-manual-one-time) (the only manual step). Afterwards, do a [test run](#test-run-and-spot-checks).

Optional: get a free Congress.gov API key at <https://api.congress.gov/sign-up/>, put it in `.env` as `CONGRESS_API_KEY`, and run `docker compose up -d n8n`. This enables Congressional Research Service reports. Without the key, the CRS feed is skipped and the digest notes it.

## Gmail app password (manual, one time)

The digest is sent from your Gmail account over Gmail's SMTP server (`smtp.gmail.com:465`, SSL) using an **app password**: a 16-character password Google generates for one app. It does not expire, needs no Google Cloud project, and can be revoked at any time without changing your real password.

1. **Turn on 2-Step Verification** for the sending account at <https://myaccount.google.com/security> → *How you sign in to Google* → **2-Step Verification**. App passwords require it.
2. **Create the app password:** open <https://myaccount.google.com/apppasswords>, type a name such as `Defense Brief`, and click **Create**. Copy the 16 characters it shows; spaces don't matter. Google shows it only once.
   - If the page says app passwords aren't available: check that 2-Step Verification is on. Work or school (Workspace) accounts may have them disabled by an administrator, and accounts with Advanced Protection can't use them.
3. **Give it to setup:** `setup.sh` asks for `GMAIL_ADDRESS` (the sending account) and `GMAIL_APP_PASSWORD`. You can also put both in `.env` and re-run `./setup.sh`, which re-imports the SMTP credential on every run.

To change the password later, update `GMAIL_APP_PASSWORD` in `.env` and run `./setup.sh` again. The recipient can be any address (`DIGEST_RECIPIENT`). Alerts go to `ALERT_RECIPIENT`, or to `DIGEST_RECIPIENT` if that's unset.

## Test run and spot checks

1. **Feeds from your network:** `./scripts/test-feeds.sh`. Some publishers block datacenter IPs but allow home connections, or the reverse. Replace or remove any feed that fails here before relying on it.
2. **Dry run** (no email, nothing marked as sent): `./scripts/run-now.sh --dry-run`, then open `previews/digest-latest.html`. Run stats are in `previews/digest-latest.json`.
3. **Real run:** `./scripts/run-now.sh`. The email should arrive at `DIGEST_RECIPIENT`, with subject `Defense Strategy Brief: <Weekday, Month D>`.
4. **Spot-check three summaries** against their linked sources:
   - Every fact in the summary appears in a linked article; nothing comes from outside knowledge.
   - Claims are attributed ("the Pentagon said", "according to CRS").
   - No loaded or evaluative wording, and no judgment of either administration or strategy.
   - Where outlets differ on figures, "Where reports differ" says so.
5. **Verify the strategy-alignment tags** against the NDS text. Each tag maps to an entry in `config/topics.json` that carries a verbatim `source_quote` and a `source_ref` (page or section). Check that the story actually touches that priority, and that any "Where the strategies differ" note matches the quoted text (`divergences[*].short_2026/short_2022`, each quotation verified word-for-word against the PDFs). If a tag is consistently wrong, tighten that priority's `description` or `keywords`.

## Sourcing policy: bias and corroboration rules

**Allowlist only.** Nothing outside `sources.json` entries with `"status": "approved"` is fetched.

**Inclusion rule (default).** A news outlet qualifies if at least **2 of 3** raters rate it center/least-biased **and** high in factual reliability. Thresholds are recorded in `policy.rater_thresholds`:
- **AllSides:** "Center".
- **Ad Fontes Media:** bias between −6 and +6 *and* reliability ≥ 40.
- **MBFC:** "Least Biased" *and* factual reporting "High" or "Very High".

Each source records its rating from every rater, the URL, and the date checked (ratings checked 2026-11-06). **Owner-approved exceptions** carry `"approval_basis": "user_override"`, and the email footer discloses that the allowlist includes them.

**Current allowlist (26 sources)**
- **Pass the 2-of-3 rule (7):** BBC News, Defense News, Military Times, Stars and Stripes, Defense One, The Hill, NewsNation.
- **Owner-approved exceptions (11):** AP, NPR, PBS NewsHour, Breaking Defense, DefenseScoop, USNI News, The War Zone, Air & Space Forces Magazine, Task & Purpose, RAND, CSIS.
- **Primary sources (8):** war.gov releases, transcripts, speeches and news; GAO reports; Congressional Research Service reports (Congress.gov API); House and Senate Armed Services Committee press releases.
- **Dropped:** Reuters (no public feed) and war.gov contract announcements (your choice). AFP and the other evaluated outlets were not selected.

**Primary sources** are labeled "Primary source" and grouped under **Primary source updates**. They are authoritative for what the government said or did, not neutral analysis. Committee releases usually come from the committee chair.

**Corroboration.** A story goes in the main sections if it is reported by **at least two independent outlets**, or comes from a primary source (shown under Primary source updates). Independence is judged by `owner_group`:
- **Same owner counts once:** Defense News and Military Times (Sightline Media Group); The Hill and NewsNation (Nexstar).
- **Wire copy counts as the wire service:** an AP story republished by an allowlisted outlet counts toward "Associated Press", not the republishing outlet.
- **Research doesn't corroborate:** RAND and CSIS publish analysis, not event reporting. They can appear as sources but don't count toward the two-outlet rule (`policy.corroboration.research_tier_counts`).

Everything else appears under **Single-source reports**, clearly labeled.

**Opinion and sponsored content** are excluded in three ways: by URL pattern (`/opinion/`, `/commentary/`, `/sponsored/`, `/partner-content/`, …), by feed category, and, for CSIS, by its page type labels (Commentary, Newsletter, Transcript).

**Balance check.** Every digest logs the source mix (`run_log.stats.source_mix`). The footer flags any outlet that appears in more than 50% of stories.

**Scraping.** Article pages are fetched only where `robots.txt` allows, and when robots.txt can't be read, nothing is fetched. Fetching uses at least 3 seconds per host (more if the site sets a `Crawl-delay`), sends no cookies, never bypasses a paywall, and identifies itself with the User-Agent `DefenseStrategyBrief/1.0`. If only an excerpt is available, the story is labeled **Based on excerpt**.

## Editing sources, topics and prompts

The workflows read `config/*.json` on every run, so **edits take effect on the next run** with no re-import. JSON must stay valid; check with `python3 -m json.tool config/sources.json`.

- **Add or remove a source:** add an entry to `sources` with `id`, `name`, `tier` (`wire|trade|general|research|primary`), `owner_group`, `status: "approved"`, `approval_basis`, `ratings{allsides,adfontes,mbfc}` (each with `url` and `checked` date), and `feeds: [{url, type}]`. Feed types:
  - `rss`: RSS or Atom.
  - `api`: Congress.gov CRS JSON.
  - `html_list`: needs a site-specific parser in `workflows/src/lib.js` (`parseHtmlList`); after adding one, rebuild and re-import (see [Development](#development-and-tests)).

  Run `./scripts/test-feeds.sh` afterward. To stop using a source, set `"status": "excluded"`.
- **Topics:** each entry in `priorities` has `strategy` (`nds2026|nds2022|cross`), `label`, `short_label` (used in the alignment line), `group` (email section), `description`, `source_quote` and `keywords`. Keywords are case-insensitive whole words; acronyms of 5 characters or fewer are case-sensitive; wrap a regex in `/slashes/`. Other settings:
  - `prefilter.embedding_threshold`: embedding cutoff for the prefilter.
  - `classifier.relevance_threshold`: default 0.6.
  - `clustering`: similarity settings for grouping stories.
  - `digest`: story caps and limits.
  - `divergences`: the neutral "where the strategies differ" notes and their triggers.
- **Prompts and neutrality checks:** `config/prompts.json`, including `loaded_terms` (rejected words) and `attribution_markers`.

## Changing the schedule or the model

- **Schedule:** in n8n, open **Defense Strategy Brief — Daily → "Every day 5:00 AM PT"** and change the cron expression (`0 5 * * *`). The time zone comes from the workflow setting `America/Los_Angeles`. Save and publish. To make the change permanent in the repo, edit `scripts/build-workflows.js` and re-import.
- **Model:** set `OLLAMA_MODEL=<name>` in `.env`, then run:
  ```bash
  docker compose exec ollama ollama pull <name>
  ```
  ```bash
  docker compose up -d n8n
  ```
  Any Ollama chat model that supports structured outputs works (e.g. `qwen2.5:7b`, `mistral-small`). To change the embedding model, set `OLLAMA_EMBED_MODEL` and pull it; you may need to retune `prefilter.embedding_threshold` and `clustering.embedding_similarity_threshold`.
- **Re-pick automatically:** delete the `OLLAMA_MODEL=` value in `.env` and re-run `./setup.sh`.

## Reliability, alerts and logs

- **Alerts workflow** (`Defense Strategy Brief — Alerts`, set as the daily workflow's error workflow) emails you when:
  - a scheduled run fails (it names the failed node and the error);
  - no stories qualify (no empty digest is sent);
  - more than 30% of feeds fail (`FEED_FAILURE_ALERT_RATIO`). The digest still goes out, with a warning banner.
  - It also sends the **monthly ratings re-verification reminder** (1st of each month, 8:45 AM PT), listing each rated outlet with its rating links.
- **Retries:**
  - Feed fetches: 3 tries, 5 s apart, 30 s timeout. Failed feeds don't stop the run; they're counted and listed.
  - Ollama calls: 3 tries, 5 s apart, 15-minute timeout.
  - Article pages: 2 tries with exponential backoff.
  - Gmail and Postgres: 3 tries.
  - Malformed LLM JSON or rule violations: one corrective retry with the reasons.
  - n8n's built-in retry uses fixed intervals; exponential backoff applies only to the in-code article fetches.
- **Run stats** are logged to Postgres (`run_log`): feeds OK/failed (with errors), articles fetched / in window / excluded / deduplicated, prefilter and relevance pass counts, clusters, stories sent, source mix, model, and duration. To see recent runs:
  ```bash
  docker compose exec postgres psql -U dsb -d dsb -c "SELECT * FROM run_summary LIMIT 10;"
  ```
  Full stats: `SELECT stats FROM run_log ORDER BY started_at DESC LIMIT 1;`. n8n's own execution history (30 days) is under **Executions**.
- **Dedup store:** `sent_articles` holds normalized URLs (lowercase host, https, no fragment, no `utm_*`/`fbclid`/`at_*` and similar tracking parameters). The workflow checks the last 60 days.

## Design decisions and deviations from the original spec

| Spec | What was built | Why |
|---|---|---|
| Two compose services (n8n, Ollama) | **Three:** n8n, Ollama, **Postgres** | You asked me to choose SQLite or Postgres. n8n has no native SQLite node, so SQLite would need a custom image or shell workarounds. Postgres has a first-class n8n node with parameterized queries, handles concurrent writes safely, also serves as n8n's own database (recommended over SQLite for production), and is easy to back up (`pg_dump`). |
| Gmail node with OAuth2 | **Gmail SMTP with an app password**, through n8n's Send Email node (digest and alerts) | Changed at your request. Publishing a Google OAuth app to production required a homepage and privacy policy, and in Testing mode Google expires the sign-in every 7 days, which breaks unattended runs. An app password doesn't expire, and the Send Email node sends a true `multipart/alternative` email (HTML plus plain text). |
| "Retries with backoff" on HTTP/Ollama nodes | n8n built-in retries (fixed 5 s interval); exponential backoff in code for article fetches | n8n's node retry has no exponential option. |
| CRS via RSS | Congress.gov API (`CONGRESS_API_KEY`) | CRS publishes no official RSS feed. |
| AP feed | AP's verified Flipboard feeds | apnews.com RSS ended in 2024. These feeds are AP-curated but hosted by Flipboard. |
| HASC, SASC, CSIS feeds | Their listing pages are parsed (`html_list`), and robots.txt allows those pages | None of the three offers RSS. Site redesigns can break the parsers; failures are flagged in the alert and the footer. |
| Ollama GPU "with CPU fallback" | `docker-compose.gpu.yml` added only when Docker can use an NVIDIA GPU | Compose can't conditionally request a GPU; a GPU reservation on a machine without one fails to start. |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Alert: "Ollama: embeddings … refused the connection" | Check `docker compose ps` and `docker compose logs ollama`. Make sure the models are pulled: `docker compose exec ollama ollama list`. |
| Run error: `Invalid login` / `535 Username and Password not accepted` | The app password is wrong or was revoked, or 2-Step Verification was turned off. Create a new app password, put it in `GMAIL_APP_PASSWORD` in `.env`, and run `./setup.sh`. Use the app password, not your normal password. |
| Email not arriving, no error | Check the recipient's spam folder and mark the first digest "Not spam". Sending from and to the same Gmail account is fine. |
| Runs take hours | The model is too large for CPU. Set `OLLAMA_MODEL=llama3.1:8b` (or `qwen2.5:7b`), or lower `digest.max_classify` in `topics.json`. |
| Feed alert keeps listing the same source | Run `./scripts/test-feeds.sh`. The publisher may have moved the feed, or it blocks your IP. Update or exclude it in `sources.json`. |
| "no items parsed from list page" for HASC, SASC or CSIS | The site layout changed. Update `parseHtmlList` in `workflows/src/lib.js`, rebuild and re-import (see below). |
| Too few stories / everything is single-source | Lower `clustering.embedding_similarity_threshold` (e.g. 0.78) or `classifier.relevance_threshold`; add outlets with different owners. |
| Off-topic stories | Raise `relevance_threshold` or `prefilter.embedding_threshold`; tighten `keywords`. |
| Code node error "Cannot find module 'fs'/'url'" | Make sure `NODE_FUNCTION_ALLOW_BUILTIN=fs,url` is set (it is in `docker-compose.yml`), then run `docker compose up -d n8n`. |
| Changed config but nothing changed | Config is read at runtime; check JSON validity. For Code-node logic changes, rebuild and re-import. |
| Lost `N8N_ENCRYPTION_KEY` | n8n can't decrypt its stored credentials. Restore the old `.env` if you can. Otherwise reset n8n's data (`docker compose down -v` also deletes history and models) and run `./setup.sh`, which re-creates the credentials from `.env`. |
| Start over completely | Destructive: `docker compose down -v` deletes n8n data, history and models. Then run `./setup.sh`. |

## Development and tests

```bash
node tests/run-tests.js
```

`tests/run-tests.js` runs the unit tests: parsers against real feed and page samples, URL normalization, exclusions, keyword matching, clustering and corroboration, robots.txt, validation, alignment, email and MIME.

```bash
node scripts/build-workflows.js
```

`build-workflows.js` regenerates `workflows/*.json` after you edit `workflows/src/`. Then re-import:

```bash
docker compose exec n8n n8n import:workflow --input=/data/workflows/defense-brief-main.json
```

```bash
docker compose exec n8n n8n publish:workflow --id=DSBriefMain00001
```

```bash
docker compose restart n8n
```

`tests/e2e/run-e2e.sh` runs the end-to-end test. It needs an n8n CLI matching the image version and a Postgres with `db/01-schema.sql` loaded. It runs the real workflows against a mock feed and Ollama server in dry-run mode and checks:
- the dead-feed count;
- opinion, commentary and out-of-window exclusions;
- the classification and summary retry paths;
- robots.txt compliance;
- corroboration, including the same-owner rule;
- de-duplication;
- the no-stories alert;
- a scheduled production run that fails and triggers the error-workflow alert;
- a real send of the digest and of an alert through the Send Email node to a test SMTP server (`tests/e2e/smtp-sink.py`, needs `aiosmtpd`; point `SMTP_PYTHON` at a Python that has it).
