// ВиК Варна (vikvarna.com) — sequential-id crawler covering the whole
// municipality, not just the city (see id-probe.ts for why the listing can't).
//
// Note this also picks up planned repairs (type=repair), not only breakdowns:
// vikvarna ignores the type segment in the message path, so both share one id
// space and walking it returns both. That is a widening of what "vik" ingests,
// and the intended one — a planned shut-off leaves a street just as dry.

import type { Env } from "../../env";
import { vikParseMessage, vikParsePage } from "../scrape";
import { crawlIdProbe } from "./id-probe";

const VIK_URL_PATTERN = /(\d+)\.html/;

export async function run(env: Env, deadline: number): Promise<void> {
  await crawlIdProbe(env, deadline, {
    tag: "VIK",
    category: "vik",
    // Bare <id>.html. The query parameters the listing hangs off its links
    // (?region_id=…&sub_region_id=…) scope the page to one region; without them
    // the id resolves wherever in the municipality the message belongs.
    messageUrl: (id) => `${env.VIK_MESSAGE_BASE_URL}${id}.html`,
    listingUrl: env.VIK_URL,
    idPattern: VIK_URL_PATTERN,
    parsePage: vikParsePage,
    parseMessage: (html) => {
      const msg = vikParseMessage(html);
      return msg ? { title: msg.title, content: msg.content } : null;
    },
  });
}
