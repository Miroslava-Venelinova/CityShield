// Veolia Energy Varna (energy-varna.bg) — id-listing crawler with
// base-URL-relative node links, port of heating_service.py.

import type { Env } from "../../env";
import { heatingParseMessage, heatingParsePage } from "../scrape";
import { crawlIdListing } from "./id-listing";

const NODE_URL_PATTERN = /\/node\/(\d+)/;

export async function run(env: Env, deadline: number): Promise<void> {
  await crawlIdListing(env, deadline, {
    tag: "HEATING",
    category: "heating",
    listingUrl: env.HEATING_URL,
    idPattern: NODE_URL_PATTERN,
    parsePage: (html) => heatingParsePage(html, env.HEATING_BASE_URL),
    parseMessage: heatingParseMessage,
  });
}
