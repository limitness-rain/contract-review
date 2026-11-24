"use strict";

// Use the same clause locator and version pairing as the offline HTML.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const context = vm.createContext({TextEncoder, TextDecoder, input, packageFieldNames:input.fields});
  for (const file of ["package-codec.js", "package-intake.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context, {filename:file});
  }
  const result = vm.runInContext(input.check_clauses ? `
    JSON.stringify(input.contracts.map(({blocks,clauses})=>{
      const layout = intakeWordLayout(blocks);
      return clauses.map(clause=>findIntakeClause(layout,officeCompact(clause)).matches.length);
    }));
  ` : `
    locateIntakeContracts(input.contracts,input.rows);
    if (input.paired) input.version_pair = intakeVersionPair(input.contracts,input.rows);
    else {
      const pairs = detectIntakeVersionPairs(input.contracts,input.rows);
      if (pairs.length) input.version_pairs = pairs;
    }
    JSON.stringify(input);
  `, context);
  process.stdout.write(result);
} catch (error) {
  process.stderr.write(error.message+"\n");
  process.exitCode = 1;
}
