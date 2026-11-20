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
  const result = vm.runInContext(`
    for (const contract of input.contracts) {
      const rows = input.rows.filter(row=>row.contract_id===contract.id && row.scope==="slice");
      const clauses = new Map(rows.map(row=>[row.fields["条款原文"],row.id]));
      const sections = locateIntakeSections(contract,clauses);
      for (const row of rows) row.section_id = sections.get(row.fields["条款原文"]);
    }
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
