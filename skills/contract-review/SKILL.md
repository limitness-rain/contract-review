---
name: contract-review
description: Prepare ZIPs for the 二轮规则优化 contract review workflow, use the bundled offline tool for intern review, lawyer review and acceptance, and publish verified final annotations to an approved Feishu Base.
---

# 二轮合同复核

按[工作流与命令](references/Codex工作流.md)处理当前阶段。运行 `scripts/review_workflow.py`，把 ZIP、Excel 和报告写入用户可用的目录。

**实习生、律师和最终验收共用 [合同复核工具.html](assets/合同复核工具.html)。** 返回命令给出的固定工具和本批 ZIP 的绝对本地链接。任何批次都禁止生成或复制 HTML、嵌入 ZIP、用临时网页代替工具。用户可在固定工具点「导入已有 ZIP」和「选择 ZIP」。用户希望代导入时，用本机浏览器在同一工具选择该 ZIP，确认预览中的阶段后交由用户填写署名或进入；无法操作本机浏览器时提供手动导入步骤。

- **用户给出合同类型。** 用本机已授权的 `lark-cli` 用户身份运行 `collect`，检查退出码和 `取件/取件结果.json`。取件失败时说明合同类型、初标状态、缺失或无法读取的标注集、附件及需补材料，报告有文件名时照列。材料齐备后逐份核对评测 Word 和有效附件，记录类型及版本依据，再运行 `prepare`。类型不符时列出文件并暂停该批。
- **收到复核 ZIP。** 用 `receive` 校验清单并确认阶段。实习生或律师在固定工具中导入对应 ZIP。律师终版在同一工具只读验收，同时输出预检报告和可用的本地 Excel。按[标注与导出](references/标注与导出.md)完成四项检查，以实际材料记录核验依据。
- **终版交付。** 先给固定工具和终版 ZIP 的独立链接。询问是否写入飞书，缺少明确目标或操作时一并确认。取得用户同意后，使用同一终版 ZIP、Excel 和状态为 `ready` 的预检报告运行 `publish`，交付 Excel、目标表链接和回读回执。写入状态不明时先核对远端。 来源表仅用于取件。
