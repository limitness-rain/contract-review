# Codex 合同复核工作流

## 开始前

在本机 Codex 打开项目，或解压「合同标注复核工具.zip」，或请 `$skill-installer` 从 [contract-review 仓库](https://github.com/limitness-rain/contract-review)安装 `contract-review`。仓库内的安装路径为 `skills/contract-review`。用本机 Python、Node.js 和 `lark-cli`。以下命令的 `$REVIEW_WORKFLOW` 是 `review_workflow.py` 的实际路径，开发项目在 `tools/`，Skill 内在 `scripts/`。示例中的 `work/` 使用可写目录。

优先复用用户已登录的飞书身份。授权或过期时用 `lark-cli auth status --json --verify` 确认；按错误反馈用 `lark-cli auth login --scope '<缺少的 scope>' --no-wait --json` 发起增量授权。给用户原始授权链接和由 `lark-cli auth qrcode` 生成的二维码，用户完成后用 `lark-cli auth login --device-code '<返回的 device_code>'` 完成授权。如果运行环境无法访问本机钥匙串，使用允许访问该钥匙串的本机执行环境。核对企业身份，然后继续原操作。取件用本人身份，只读取来源。

## 各阶段共用固定工具

建包或接收 ZIP 后，分别返回命令给出的「合同复核工具.html」和本批 ZIP 的绝对本地链接。已安装 Skill 使用 `assets/合同复核工具.html`，开发项目使用根目录的同名工具。实习生、律师和最终验收均复用这一入口。禁止为批次生成、复制或改写 HTML，禁止把 ZIP 嵌入页面。找不到固定工具时恢复分发文件或重新安装 Skill。

用 Chrome 或 Edge 打开固定工具，点「导入已有 ZIP」和「选择 ZIP」，选取下载的文件。用户希望 Codex 代导入时，可以用本机浏览器和文件选择器在固定页面导入该 ZIP，确认预览中的批次和阶段，留给使用者填写署名和进入工作台。导入在本机进行。浏览器或 ZIP 对 Codex 不可用时，交付两个链接和手动导入步骤。

## 按合同类型取件并生成初始 ZIP

用户只报「保管合同」时，从「二轮规则优化」定位计划、任务与样本记录。读取「计划表 v07」对应类型的「标注和评测集」和初标状态，取双方正式规则，从「合同样本库」的「用于评测的合同」下载本类型全部评测附件。多条候选无法消歧时，给出批次或来源候选。已有标注使用其实际对应的评测版本。

```sh
python3 "$REVIEW_WORKFLOW" collect --type 保管合同 --out work/保管合同
```

查看 `取件/取件结果.json`。取件全部成功时退出码为 0，报告为 `status: ready`、`route: type_check_required`。失败时退出码为 1，报告为 `status: failed`，`issues` 列出每个原因。直接向用户报告「取件失败」、合同类型、已知初标状态和具体缺项。区分尚未初标、初标已完成但链接缺失、链接无权限、标注集为空、缺列、样本库缺附件和附件下载失败。列出报告中的合同文件名，说明应补文件、链接还是授权。保留已成功下载的材料供核查，材料齐备后再生成初始 ZIP。

状态为 `ready` 时，在 `类型核验模板.json` 的基础上创建 `类型核验.json`。逐份读取 Word 正文、有效附件与证据，保留路径、文件名、附件标识和 SHA-256，按真实交易内容填写 `match` 和可核验的 `reason`。可用同一脚本目录下的 `sources.py docx <Word 路径> --out <新 JSON 路径>` 提取 Word 正文。同名文件也要核对版本。评测附件没有标注时仍随首包保留正文，告知使用者该附件暂无标注。文件类型不符或正文无法核验时，列出文件和理由，等材料齐备再建包。

标注或规则链接若通向飞书文档，用本机飞书文档工具读原链接及嵌入资源，然后将 `--annotation`、`--rule` 或 `--other-rule` 指向确认后的 Base 表重新取件。正式规则只提供 HTML 时，静态提取并校对立场、名称、等级和完整逻辑。可用 `prepare --annotations ... --rules ...` 从核验后的本地 Excel 或分页 JSON、规则 JSON 建包。

```sh
python3 "$REVIEW_WORKFLOW" prepare --type 保管合同 \
  --materials work/保管合同/取件/取件结果.json --type-check work/保管合同/类型核验.json \
  --zip work/保管合同/初始包.zip
```

覆盖清单准备好时可加 `--coverage`。双版本 Word 使用相同主体和实际立场后缀，标注集保留实际文件全名，程序自动识别可配对文件。重复或不匹配的文件由取件核验解决。返回固定工具和首包的独立链接。导入首包后，实习生选择视图、填写署名，点击「进入复核工作台」。完成后用「提交给律师」导出交接 ZIP。

## 接收各阶段 ZIP

```sh
python3 "$REVIEW_WORKFLOW" receive --zip work/实习生交接.zip --stage lawyer
python3 "$REVIEW_WORKFLOW" receive --zip work/律师终版.zip --stage final --out work/实习生验收
```

`receive` 核验输入 ZIP，并返回固定工具、输入 ZIP 的绝对路径和阶段。省略 `--stage` 时按包内清单识别。律师在固定工具导入交接 ZIP，填写署名进入，完成后点「导出律师终版 ZIP」。实习生在同一工具导入律师终版，即可进入只读验收。

接收律师终版时用 `--out` 指定新目录，生成 `预检.json`，结构检查通过时一并导出 `标注集.xlsx`。回复先给固定工具和终版 ZIP 的独立链接，再提供可用的 Excel 和预检，并询问是否将终版写入飞书。若用户尚未提供位置，请其给出目标 Base 或具体数据表链接，并确认是在 Base 新建表还是写入现有空表。

## 律师终版预检

依[标注与导出](./标注与导出.md)核对 15 列格式、正式规则原值、同版原文及切片、触发与排除、证据支持、漏标与重复、翻转后同步。报告按合同、Excel 行号、源记录、字段与原因定位。规则源在终版包中时自动核验，否则单独提供 `--rules`。覆盖文件中的 `applicability` 按 `contract_id` 定义适用规则 ID 数组。`paths` 逐项写 `contract_id`、`rule_id` 和 `mode`，全切片用 `slice`，相关切片用 `related` 并提供 `section_ids`，全文缺失用 `full_missing`，独立事项保留 `matter_id`。全文核验文件包含终版 `package_id`，`reviewed_rows` 是按源 ID 标注的实际核验依据，`issues` 中每项可填 `row_id`、`field`、`reason`。使用实际审查证据填写，未核完的项目留待检查。

```sh
python3 "$REVIEW_WORKFLOW" preflight --zip work/律师终版.zip --excel work/实习生验收/标注集.xlsx \
  --coverage work/覆盖路径.json --semantic work/全文核验.json --out work/预检通过.json
```

可用 `--export` 从同一终版重导到新路径。终版结构或字段有阻塞时先报告具体问题。有待核项目的报告状态为 `pending_review`，所有预检完成后为 `ready`。带 `ready` 且与同一 ZIP 和 Excel 匹配的报告可用于发布。

## 确认后写入飞书

预检完成后按用户提供的位置只读预览。具体表链接用于现有空表。用户要求在指定 Base 新建时，使用 Base 首页链接，并追加 `--new-table 标注集` 或用户确认的表名。向已有表写入前会校验标准列与判断字段。即使目标链接带筛选视图，也以完整数据表为目标；请在确认时说清。

```sh
python3 "$REVIEW_WORKFLOW" publish --zip work/律师终版.zip \
  --excel work/实习生验收/标注集.xlsx --report work/预检通过.json \
  --target '<用户指定的飞书链接>' --out work/写入预览.json
```

用户确认具体位置、操作及数据范围后，用相同参数重新运行，增加 `--confirm`，并将 `--out` 改为新的 `work/飞书写入回执.json`。现有表有不同记录时会停止。内容完全相同会只回读，避免重复写入。写入按标准列和类型分批新增，回读全部记录逐字段与 Excel 对照。成功返回 Excel、目标表链接、已核验行数与回执。失败返回已有结果和具体原因，先核对远端是否部分写入，再决定如何处理。
