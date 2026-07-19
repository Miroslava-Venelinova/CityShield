// Proxy for the model-eval spike: POST {model, messages, response_format}
// → env.AI.run result. Guarded by the EVAL_TOKEN var set at deploy time.
export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("POST only", { status: 405 });
    if (!env.EVAL_TOKEN || request.headers.get("x-eval-token") !== env.EVAL_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
    }
    if (payload.list_models) {
      try {
        const models = await env.AI.models({ per_page: 100, task: "Text Generation" });
        return Response.json({ ok: true, models });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 502 });
      }
    }
    const { model, messages, response_format } = payload;
    const started = Date.now();
    try {
      const res = await env.AI.run(model, {
        messages,
        ...(response_format ? { response_format } : {}),
      });
      return Response.json({ ok: true, ms: Date.now() - started, res });
    } catch (err) {
      return Response.json({ ok: false, ms: Date.now() - started, error: String(err) }, { status: 502 });
    }
  },
};
