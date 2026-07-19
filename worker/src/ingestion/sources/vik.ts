// ВиК Варна (vikvarna.com) — id-listing crawler, port of vik_service.py.

import type { Env } from "../../env";
import { vikParseMessage, vikParsePage } from "../scrape";
import { crawlIdListing } from "./id-listing";

const VIK_URL_PATTERN = /(\d+)\.html/;

export async function run(env: Env, deadline: number): Promise<void> {
  await crawlIdListing(env, deadline, {
    tag: "VIK",
    category: "vik",
    listingUrl: env.VIK_URL,
    idPattern: VIK_URL_PATTERN,
    parsePage: vikParsePage,
    parseMessage: (html) => {
      const msg = vikParseMessage(html);
      return msg ? { title: msg.title, content: msg.content } : null;
    },
  });
}
