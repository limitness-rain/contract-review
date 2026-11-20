---
name: contract-review
description: Run the 二轮规则优化 contract review workflow. Fetch Word attachments and the annotation dataset for a contract type such as 保管合同 through the local Feishu CLI, turn review ZIPs into local intern, lawyer, or acceptance pages, and publish a verified final annotation workbook to a user-confirmed Feishu Base table.
---

# 二轮合同复核

Read [Codex 工作流](references/Codex工作流.md) for the relevant stage. Resolve commands relative to this installed skill: `scripts/review_workflow.py` is the entry point. Use the user's writable work directory for inputs and outputs. Link generated HTML as an absolute local path. Batch pages contain the ZIP and require an explicit click to enter in the local browser.

- **User gives a contract type.** Run `collect` with their local `lark-cli` user identity. Check its exit code and `取件/取件结果.json`. On failure, tell the user “取件失败” with the contract type, the initial annotation status if known, each reason, and what to supply or authorize. Distinguish an unannotated batch, a completed batch with a missing or inaccessible annotation set, an empty set, and missing or failed attachments. Give names when the report lists them. Wait for usable materials before running `prepare`. On success, inspect each matching evaluation Word and its valid attachments; record the type and version evidence in the checklist. If the contract type mismatches, report the affected files and hold that batch.
- **User sends a ZIP.** Run `receive` to identify the phase from the internal package manifest and generate the local page. A lawyer-stage ZIP opens a lawyer review page. A final ZIP opens read-only intern acceptance and returns the local Excel and preflight report when available. Check the rules and all four validation dimensions in [标注与导出](references/标注与导出.md). Never invent document-review evidence.
- **Final delivery.** Return the acceptance link first. Ask whether to write the verified annotations into Feishu and ask for the exact destination and intended operation if missing. After the user approves the specific target, run confirmed `publish` only with the ready preflight report bound to the same final ZIP and workbook. Return the Excel and the Feishu receipt with the target link and read-back result. Receipt status controls whether delivery is complete. Do not silently retry an uncertain write or modify any sourcing tables.
