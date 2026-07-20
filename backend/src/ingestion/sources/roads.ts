// Road Infrastructure Agency news (api.bg) — port of roads_service.py.
// Country-wide news: cheap "Варна" text pre-check, then the LLM relevance
// judgement; relevant articles become city-wide "roads" alerts carrying the
// LLM summary. Articles have no numeric id; the URL path is the seen-id.

import type { Env } from "../../env";
import { ROADS_AI_PROMPT } from "../../shared/constants";
import { ROADS_JSON_SCHEMA, roadsAiSchema } from "../../shared/schemas";
import { aiParse } from "../ai";
import { ingestAlert } from "../pipeline";
import { fetchPage, roadsParseArticle, roadsParsePage } from "../scrape";
import { addSeenIds, getSeenIds, hasStateRow } from "../state";
import { MAX_MESSAGES_PER_TICK } from "./id-listing";

const TAG = "ROADS";
const CATEGORY = "roads";

// Article fetches also consume the cron invocation's subrequest budget, so
// cap them separately from the (more expensive) AI calls.
const MAX_ARTICLE_FETCHES_PER_TICK = 5;

export async function run(env: Env, deadline: number): Promise<void> {
  let listingHtml: string;
  try {
    listingHtml = await (await fetchPage(env.ROADS_URL)).text();
  } catch (e) {
    console.error(`[ROADS] Failed to fetch news listing: ${e}. Stopping.`);
    return;
  }

  const newsItems = roadsParsePage(listingHtml);
  if (newsItems === null) {
    console.error("[ROADS] Could not parse news listing. Stopping.");
    return;
  }

  // First run ever: mark the current listing as seen without processing.
  if (!(await hasStateRow(env, CATEGORY))) {
    const ids = newsItems.map((item) => new URL(item.url, env.ROADS_URL).pathname);
    console.log(`[ROADS] First run — bootstrapping ${ids.length} seen id(s) without processing.`);
    await addSeenIds(env, CATEGORY, ids.length > 0 ? ids : ["bootstrap"]);
    return;
  }

  const seenIds = new Set(await getSeenIds(env, CATEGORY));
  let fetches = 0;
  let aiCalls = 0;

  for (const item of newsItems) {
    if (fetches >= MAX_ARTICLE_FETCHES_PER_TICK || aiCalls >= MAX_MESSAGES_PER_TICK) break;
    if (Date.now() >= deadline) break;

    const articleId = new URL(item.url, env.ROADS_URL).pathname;
    if (seenIds.has(articleId)) continue;

    const markSeen = async () => {
      seenIds.add(articleId);
      await addSeenIds(env, CATEGORY, [articleId]);
    };

    fetches++;
    let articleHtml: string;
    try {
      articleHtml = await (await fetchPage(item.url)).text();
    } catch (e) {
      console.error(`[ROADS] Failed to fetch article ${item.url}: ${e}. Skipping.`);
      continue; // transient — retried next tick
    }

    const article = roadsParseArticle(articleHtml);
    if (article === null) {
      console.warn(`[ROADS] Could not parse article ${item.url}. Skipping.`);
      await markSeen();
      continue;
    }

    const fullText = `${article.title}\n${article.content}`;

    // Cheap pre-filter: most АПИ news never mentions Varna — don't waste an
    // LLM call (or neurons) on those.
    if (!fullText.includes("Варна")) {
      await markSeen();
      continue;
    }

    aiCalls++;
    const aiOutput = await aiParse(env, ROADS_AI_PROMPT, fullText, ROADS_JSON_SCHEMA, roadsAiSchema);
    if (aiOutput === null) continue; // AI failure — retried next tick

    if (!aiOutput.is_relevant || !aiOutput.summary) {
      console.log(`[ROADS] Article judged not relevant to Varna: ${item.url}`);
      await markSeen();
      continue;
    }

    // Broadcast alert: city_wide → all users with "roads" enabled.
    const submitted = await ingestAlert(env, TAG, CATEGORY, article.title, aiOutput.summary, {
      locations: [],
      start_time: null,
      end_time: null,
      city_wide: true,
    }, articleId);
    if (submitted) await markSeen();
  }
}
