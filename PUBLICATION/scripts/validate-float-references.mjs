#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const manuscriptPath = new URL("../manuscript.qmd", import.meta.url);
const source = await readFile(manuscriptPath, "utf8");
const lines = source.split(/\r?\n/);
const definitions = [];

for (const [lineIndex, line] of lines.entries()) {
  for (const match of line.matchAll(/\{#((?:tbl|fig)-[A-Za-z0-9_-]+)\b/g)) {
    definitions.push({
      id: match[1],
      lineIndex,
      offset: match.index,
    });
  }
}

const errors = [];
const seenDefinitions = new Set();

for (const definition of definitions) {
  if (seenDefinitions.has(definition.id)) {
    errors.push(
      `${definition.id}: duplicate definition at line ${definition.lineIndex + 1}`,
    );
    continue;
  }
  seenDefinitions.add(definition.id);

  const referencePattern = new RegExp(`@${definition.id}(?![A-Za-z0-9_-])`);
  let proseReferenceLine = -1;

  for (let index = 0; index <= definition.lineIndex; index += 1) {
    const candidate =
      index === definition.lineIndex
        ? lines[index].slice(0, definition.offset)
        : lines[index];
    const trimmed = candidate.trimStart();

    if (
      referencePattern.test(candidate) &&
      trimmed !== "" &&
      !trimmed.startsWith("|") &&
      !trimmed.startsWith(":") &&
      !trimmed.startsWith("![") &&
      !trimmed.startsWith("#")
    ) {
      proseReferenceLine = index;
      break;
    }
  }

  if (proseReferenceLine < 0 || proseReferenceLine >= definition.lineIndex) {
    errors.push(
      `${definition.id}: add @${definition.id} to a prose paragraph before ` +
        `its table/figure definition at line ${definition.lineIndex + 1}`,
    );
  }
}

for (const [lineIndex, line] of lines.entries()) {
  for (const match of line.matchAll(/@((?:tbl|fig)-[A-Za-z0-9_-]+)/g)) {
    if (!definitions.some(({ id }) => id === match[1])) {
      errors.push(`${match[1]}: reference at line ${lineIndex + 1} has no definition`);
    }
  }
}

if (errors.length > 0) {
  console.error("Table/figure reference validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${definitions.length} table/figure definitions: every object is cited in prose before it appears.`,
  );
}
