import { rew } from "../core.mjs";
const operations = [
  ["timing-none", "/measure/timing/reference", "None"],
  ["sequential-single", "/measure/sequential-channels", { channels: ["L"] }],
  ["level-safe", "/measure/level", { value: -30, unit: "dBFS" }]
];
const results = [];
for (const [name, path, body] of operations) {
  try { const response = await rew(path, { method: "POST", body }); results.push({ name, response, verified: await rew(path) }); }
  catch (error) { results.push({ name, error: error.message, verified: await rew(path).catch(e => ({ error: e.message })) }); }
}
console.log(JSON.stringify(results, null, 2));
