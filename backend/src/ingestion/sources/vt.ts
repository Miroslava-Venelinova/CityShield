// VarnaTraffic (varnatraffic.com) — port of varnatraffic_service.py.
// Accordion messages → LLM bus-line extraction → city-wide "vt" alert
// narrowed by the API to subscribed users. null bus_lines = irrelevant;
// ["0"] = route change with no line identified (full vt audience).

import type { Env } from "../../env";
import { VT_AI_PROMPT } from "../../shared/constants";
import { VT_JSON_SCHEMA, vtAiSchema } from "../../shared/schemas";
import { aiParse } from "../ai";
import { ingestAlert } from "../pipeline";
import { fetchPage, vtParse, type VtMessage } from "../scrape";
import { addSeenIds, getSeenIds, hasStateRow } from "../state";
import { MAX_MESSAGES_PER_TICK } from "./id-listing";

const TAG = "VT";
const CATEGORY = "vt";

/** The accordion's data-id, or a content hash so id-less entries still dedup. */
async function messageId(msg: VtMessage): Promise<string> {
  if (msg.data_id) return msg.data_id;
  const digest = await crypto.subtle.digest(
    "SHA-1", new TextEncoder().encode(`${msg.header}\n${msg.body}`));
  return "sha1:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function run(env: Env, deadline: number): Promise<void> {
  let pageHtml: string;
  try {
    pageHtml = await (await fetchPage(env.VT_URL)).text();
  } catch (e) {
    console.error(`[VT] Failed to fetch page: ${e}. Stopping.`);
    return;
  }

  const rawMessages = vtParse(pageHtml);
  if (rawMessages === null) {
    console.error("[VT] Page parsing returned no data. Stopping.");
    return;
  }

  // First run ever: mark the current accordion as seen without processing.
  if (!(await hasStateRow(env, CATEGORY))) {
    const ids = await Promise.all(rawMessages.map(messageId));
    console.log(`[VT] First run — bootstrapping ${ids.length} seen id(s) without processing.`);
    await addSeenIds(env, CATEGORY, ids.length > 0 ? ids : ["bootstrap"]);
    return;
  }

  const seenIds = new Set(await getSeenIds(env, CATEGORY));
  let processed = 0;

  for (const msg of rawMessages) {
    if (processed >= MAX_MESSAGES_PER_TICK || Date.now() >= deadline) break;

    const id = await messageId(msg);
    if (seenIds.has(id)) continue;

    processed++;
    const parsed = await aiParse(env, VT_AI_PROMPT, `${msg.header}\n${msg.body}`, VT_JSON_SCHEMA, vtAiSchema);
    if (parsed === null) continue; // AI failure — retried next tick

    const markSeen = async () => {
      seenIds.add(id);
      await addSeenIds(env, CATEGORY, [id]);
    };

    // A null array means the message is irrelevant (no route change info).
    if (parsed.bus_lines === null) {
      console.log(`[VT] Message id=${id} judged irrelevant. Skipping.`);
      await markSeen();
      continue;
    }

    // Route changes have no residential address — submit city-wide; the alert
    // service narrows the audience to users subscribed to an affected line.
    const title = msg.header || "Промяна в градския транспорт";
    let content = msg.body;
    if (parsed.bus_lines.length > 0 && !(parsed.bus_lines.length === 1 && parsed.bus_lines[0] === "0")) {
      content = `${content}\n\nЗасегнати линии: ${parsed.bus_lines.join(", ")}`;
    }

    const submitted = await ingestAlert(env, TAG, CATEGORY, title, content, {
      locations: [],
      start_time: null,
      end_time: null,
      city_wide: true,
      bus_lines: parsed.bus_lines,
    }, `id=${id}`);
    if (submitted) await markSeen();
  }
}
