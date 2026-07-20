// Lists text-generation models visible to the eval proxy Worker's AI binding.
const url = process.env.EVAL_WORKER_URL;
const token = process.env.EVAL_TOKEN;
const res = await fetch(url, {
  method: "POST",
  headers: { "x-eval-token": token, "Content-Type": "application/json" },
  body: JSON.stringify({ list_models: true }),
  signal: AbortSignal.timeout(60_000),
});
const data = await res.json();
if (!data.ok) {
  console.error("FAILED:", data.error);
  process.exit(1);
}
for (const m of data.models) {
  const props = Object.fromEntries((m.properties ?? []).map((p) => [p.property_id, p.value]));
  console.log(m.name, "|", props.function_calling ? "fc" : "", props.lora ? "lora" : "", m.description?.slice(0, 60) ?? "");
}
