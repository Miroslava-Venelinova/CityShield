// /api/tokens — port of TokensController.cs (device push tokens).

import { Hono } from "hono";
import { z } from "zod";
import * as q from "../db/queries";
import type { AppEnv } from "./middleware";
import { requireAuth } from "./middleware";

const registerSchema = z.object({
  token: z.string().min(1),
  platform: z.string().optional(),
  deviceName: z.string().optional(),
});

const unregisterSchema = z.object({ token: z.string().min(1) });

export const tokenRoutes = new Hono<AppEnv>()
  .use(requireAuth)

  .post("/", async (c) => {
    const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("Invalid token data", 400);
    const { token, platform, deviceName } = parsed.data;
    await q.upsertDeviceToken(c.env, c.get("userId"), token, platform ?? null, deviceName ?? null);
    return c.body(null, 204);
  })

  .delete("/", async (c) => {
    const parsed = unregisterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.text("Invalid token data", 400);
    await q.deleteDeviceToken(c.env, c.get("userId"), parsed.data.token);
    return c.body(null, 204);
  });
