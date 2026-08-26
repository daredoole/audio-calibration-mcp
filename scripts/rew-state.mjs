import { rew } from "../core.mjs";
const paths = ["/measure/commands", "/measure/command", "/measure/status", "/measure/timing/reference", "/measure/sequential-channels", "/measure/sweep/repetitions", "/measure/sweep/configuration", "/measure/level", "/measure/protection-options", "/application/blocking"];
const state = {};
for (const path of paths) { try { state[path] = await rew(path); } catch (error) { state[path] = { error: error.message }; } }
console.log(JSON.stringify(state, null, 2));
