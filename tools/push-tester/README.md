# Push tester

A local web UI for `POST /api/alerts/test-push` — the ingest-key-gated debug endpoint that
sends a real OneSignal push without storing an alert. Use it to answer "are pushes actually
being delivered?" end to end: Worker → OneSignal → phone.

```
python tools/push-tester/app.py
```

It prints a tokenized `http://127.0.0.1:<port>/?t=<token>` URL and opens it. Standard library
only — no pip install.

## What it does

1. **Target** — local (`wrangler dev`, default `http://127.0.0.1:8787`) or the deployed Worker.
   The base URL is remembered in `config.json` (gitignored). The ingest key is not: for local
   it is read from `backend/.dev.vars`, and anything you type is held in the tool's memory for
   that session only. The key is never sent to the browser, and never written to disk.
2. **Recipient** — one user or a broadcast. "Load users" shells out to `wrangler d1 execute`
   so you can pick by email instead of pasting a UUID; the Worker itself has no user-listing
   API and shouldn't. Which database it reads is its own control, independent of the target —
   see below.
3. **Notification** — title and message, with a preview and the same 240-character body cap
   the real sender applies. Sending a remote broadcast asks for confirmation first.

The result panel shows `sent` / `failed` / `target` exactly as the endpoint returned them.

## "Local" still sends a real push

There is no sandbox. `wrangler dev` loads the live `ONESIGNAL_API_KEY` / `ONESIGNAL_APP_ID`
from `.dev.vars` and calls OneSignal's production API over the internet, exactly as the deployed
Worker does. Local describes where the *code* runs, not where the notification goes.

What actually differs between the two targets is the database:

- A **local broadcast** reads local D1, which is normally empty. `sendPushToUsers` returns early
  on an empty list without a network call, so nothing is sent and nothing is proven.
- A **local single-user send** goes out for real. `sendPushToUsers` never looks the id up in D1 —
  it hands the string to OneSignal as an `external_id` and delivery depends only on whether
  OneSignal knows that alias.

That last point is the useful one, and why the user-list scope is a separate control: your phone
is registered against the account it signed into, which lives in the **remote** database, but you
can send to it through the **local** Worker. Load users from remote, target the local Worker, and
you get a genuine end-to-end delivery test without needing the deployed Worker's ingest key at all.

## Reading the result

`sent` is OneSignal's `recipients` — a count of **devices**, not users. `failed` is
users-minus-devices, so it moves for reasons that aren't failures: a user who has never opened
the app while signed in has no `external_id` registered and counts as failed, while a user with
two phones counts twice on the other side. Treat it as a delivery report, not a per-user verdict.

`HTTP 200` with `sent: 0` is the interesting case, and almost always one of:

- the target has never signed in on a device, so OneSignal has no alias for that `external_id`;
- the Worker has no `ONESIGNAL_APP_ID` / `ONESIGNAL_API_KEY` (the sender warns and skips rather
  than failing — check `wrangler tail`);
- the deployment you hit isn't the one the phone is registered against.

A `401` means the ingest key doesn't match that Worker's `INGEST_API_KEY`.

## Why the loopback guards

Same trust model as `tools/osm-seed-builder`: the Host header is pinned to loopback and every
call carries the printed token. This process holds an ingest key and can broadcast to every
registered user of the production deployment, so no other page in your browser gets to reach it.
