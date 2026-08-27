import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root=resolve(import.meta.dirname,".."),pkg=JSON.parse(await readFile(resolve(root,"package.json"),"utf8")),manifest=JSON.parse(await readFile(resolve(root,"mcpb/manifest.json"),"utf8"));
if(manifest.version!==pkg.version) throw new Error("MCPB manifest version must match package.json");
const stage=resolve(root,"build/mcpb"),server=resolve(stage,"server"),output=resolve(root,`dist/${pkg.name}-${pkg.version}.mcpb`);
await rm(stage,{recursive:true,force:true}); await rm(output,{force:true}); await mkdir(server,{recursive:true});
await cp(resolve(root,"mcpb/manifest.json"),resolve(stage,"manifest.json")); await cp(resolve(root,"dist/server.mjs"),resolve(server,"index.mjs")); await cp(resolve(root,"dist/analysis-worker.mjs"),resolve(server,"analysis-worker.mjs"));
await cp(resolve(root,"README.md"),resolve(stage,"README.md")); await cp(resolve(root,"LICENSE"),resolve(stage,"LICENSE")); await cp(resolve(root,"assets/audio-calibration-mcp-icon.png"),resolve(stage,"icon.png"));
execFileSync("npx",["-y","@anthropic-ai/mcpb@2.1.2","validate",resolve(stage,"manifest.json")],{stdio:"inherit"});
execFileSync("npx",["-y","@anthropic-ai/mcpb@2.1.2","pack",stage,output],{stdio:"inherit"});
console.log(output);
