# 合同标注复核工具

从「二轮规则优化」读取合同与标注集，生成实习生复核、律师复核和最终验收的本地页面。审核人员使用 ZIP 交接，最终可导出 15 列 Excel，确认目标后由 Codex 提交飞书。

## 在 Codex 中使用

- **从 GitHub 安装 Skill**。把下面这句话发给 Codex，然后在新对话中调用 `$contract-review`。

  > 请用 `$skill-installer` 从 https://github.com/limitness-rain/contract-review 安装 `contract-review` 技能。

  Skill 在仓库的 `skills/contract-review` 目录。直接运行安装脚本时，用仓库首页 URL 搭配 `--path skills/contract-review`。仓库为私有时，使用有访问权限的 GitHub 账号。
- **把工具 ZIP 交给 Codex**。在可访问本机文件和终端的 Codex 中提供 ZIP，告诉 Codex「解压并使用其中的 contract-review 技能，复核保管合同」。也可以把解压目录直接作为 Codex 工作区。工具 ZIP 与每个批次的复核 ZIP 各有用途。
- **离线手动处理**。双击 [合同复核工具.html](./合同复核工具.html)，导入复核数据 ZIP，或从本地 Word 与 Excel 建包。

Codex 取件和写入用当前机器的 `lark-cli` 登录身份。需要 Python 3.9+、Node.js 和 Chrome 或 Edge。飞书授权由本人在本机完成，仓库没有账号凭据、真实合同、标注集或交接包。

## 三句可直接使用

1. 「用 $contract-review 复核保管合同。」
2. 「这是实习生交接 ZIP，用 $contract-review 生成律师复核页。」
3. 「这是律师终版 ZIP，用 $contract-review 生成实习生验收页和 Excel。」

第三步先生成本地验收链接。Codex 会询问是否提交飞书，并核对目标位置。经确认后才写入并回读。

[Skill 入口](./skills/contract-review/SKILL.md) · [流程与命令](./skills/contract-review/references/Codex工作流.md) · [标注字段与交付口径](./skills/contract-review/references/标注与导出.md)
