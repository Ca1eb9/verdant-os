// check_nav.mjs
// Compares the firmware's routes, headings and turns (written by nav_test)
// with navigation.ts, the code the orchestrator plans with. Any difference,
// even a different route of equal cost, would make the orchestrator flag the
// robot's real route as a deviation.
//
//   node check_nav.mjs <nav_test output.json> <topology.json> [...more pairs]
//
// Imports the built @farm/shared package: run `npm run build:shared` at the
// repo root first. Run via ./run.sh.

import { readFileSync } from "node:fs";

const shared = new URL("../../../farm-controller/shared/dist/navigation.js", import.meta.url);
let nav;
try {
  nav = await import(shared);
} catch {
  console.error("check_nav: @farm/shared isn't built. Run `npm install && npm run build:shared` at the repo root.");
  process.exit(1);
}
const { buildGraph, dijkstra, computeHeading, computeTurn, nodeByTag } = nav;

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 2) {
  console.error("usage: node check_nav.mjs <nav_test.json> <topology.json> [...]");
  process.exit(2);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failed = false;

for (let i = 0; i < args.length; i += 2) {
  const fw = JSON.parse(readFileSync(args[i], "utf8"));
  const topology = JSON.parse(readFileSync(args[i + 1], "utf8"));
  const graph = buildGraph(topology);
  const problems = [];
  const expect = (what, got, want) => {
    if (!same(got, want)) problems.push(`${what}: firmware ${JSON.stringify(got)}, navigation.ts ${JSON.stringify(want)}`);
  };

  expect("node order", fw.nodes, topology.nodes.map((n) => n.id));
  expect("dock", fw.dock, topology.nodes.find((n) => n.type === "dock")?.id);
  for (const [tag, id] of fw.tags) expect(`tag ${tag}`, id, nodeByTag(graph, tag)?.id ?? null);

  for (const [from, to, path] of fw.paths) expect(`path ${from} -> ${to}`, path, dijkstra(graph, from, to));
  expect("path count", fw.paths.length, topology.nodes.length ** 2);

  for (const [from, to, heading] of fw.headings)
    expect(`heading ${from} -> ${to}`, heading, computeHeading(graph.nodes.get(from), graph.nodes.get(to)));

  for (const [cur, want, turn] of fw.turns) expect(`turn ${cur} -> ${want}`, turn, computeTurn(cur, want));
  expect("turn count", fw.turns.length, 16);

  const routed = fw.paths.filter((p) => p[2]).length;
  console.log(`nav: ${args[i + 1]}: ${fw.paths.length} routes (${routed} reachable), headings and turns checked`);
  for (const p of problems.slice(0, 20)) console.log("  FAIL " + p);
  if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`);
  if (problems.length) failed = true;
}

if (failed) {
  console.log("NAV CHECK FAILED: the firmware would plan differently from the orchestrator");
  process.exit(1);
}
console.log("nav check passed");
