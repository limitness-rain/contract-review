"""Stage and publish human-reviewed dual-stance evaluation contracts."""

from hashlib import sha256
import json
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory
from time import sleep
from unicodedata import normalize
from urllib.parse import parse_qs, urlsplit

import review
import sources


def write_json(path, data):
    review.write_new(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def digest(path):
    return sha256(Path(path).read_bytes()).hexdigest()


def template_path():
    root = Path(__file__).resolve().parent.parent
    directory = root / "references" if (root / "SKILL.md").is_file() else root
    return directory / "风险预埋提示词.md"


def source_tokens(items):
    return sorted(item["file_token"] for item in items)


def live_batch(contract_type):
    plan_fields = (*sources.TABLES["plan"][2], *sources.RULE_SLOTS)
    plan = sources.class_record("plan", contract_type, fields=plan_fields)
    sample = sources.class_record("samples", contract_type)
    if not plan or not sample:
        raise ValueError("计划表 v07 或合同样本库找不到本批对应记录，请重新取件。")
    if plan.get("标注和评测集") or sources.select_text(plan.get("初标状态")) == "已完成":
        raise ValueError("计划表已有标注集内容或显示初标已完成，请核实后重新取件。")
    originals = sample.get(sources.ORIGINAL_FIELD) or sample.get("合同样本") or []
    rule_urls, rule_lookups = sources.plan_rule_links(plan)
    batch = {"contract_type": contract_type,
             "record_ids": {"plan": plan["record_id"], "samples": sample["record_id"]},
             "original_tokens": source_tokens(originals),
             "rule_urls": rule_urls}
    if rule_lookups:
        batch["rule_lookups"] = rule_lookups
    if not batch["original_tokens"] or len(set(batch["original_tokens"])) != len(originals):
        raise ValueError("合同样本缺失或附件标识重复，请核对本批样本。")
    return batch, sample.get(sources.EVALUATION_FIELD) or []


def read_rules(url, scratch_dir):
    address = urlsplit(url)
    if (address.path.startswith("/base/")
            or (address.path.startswith("/wiki/") and "table" in parse_qs(address.query))):
        return sources.rule_records(sources.read_base_table(url, scratch_dir=scratch_dir))
    payload = sources.run_cli("docs", "+fetch", "--doc", url)
    doc = payload["document"]
    if not doc.get("content", "").strip() or not doc.get("document_id") or doc.get("revision_id") is None:
        raise ValueError("未读到完整正文或文档版本。")
    return {"url": url, **payload}


def inputs(args):
    if not args.confirm:
        raise ValueError("请先取得用户同意，再读取本批预埋材料。")
    prompt = template_path().read_text(encoding="utf-8")
    if not re.sub(r"<!--.*?-->", "", prompt, flags=re.S).strip():
        raise ValueError("Skill 的「风险预埋提示词.md」尚未补充。请先补充正式提示词。")
    index = review.read_data(args.index)
    batch, existing = live_batch(index["contract_type"])
    if (source_tokens(existing) != source_tokens(index["attachments"]["evaluation"])
            or batch["original_tokens"] != source_tokens(index["attachments"]["original"])
            or any(index["record_ids"].get(key) != value for key, value in batch["record_ids"].items())):
        raise ValueError("样本或评测合同与取件时的状态不同，请重新取件。")
    for slot, urls in batch["rule_urls"].items():
        if len(urls) != 1 or not sources.is_feishu_url(urls[0]):
            raise ValueError(f"计划表 v07 的「{slot}」需能追溯到唯一的飞书正式规则链接。")
    original_items = index["attachments"]["original"]
    skip = set(args.skip_original or [])
    if skip - set(batch["original_tokens"]) or skip == set(batch["original_tokens"]):
        raise ValueError("跳过的附件必须属于本批，并且至少保留一份原始合同。")
    excluded = [{"name": item["name"], "file_token": item["file_token"]}
                for item in original_items if item["file_token"] in skip]
    selected = [item["file_token"] for item in original_items if item["file_token"] not in skip]
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    review.write_new(output / "风险预埋提示词.md", prompt)
    rules = {}
    for slot, urls in batch["rule_urls"].items():
        try:
            payload = read_rules(urls[0], output)
        except (ValueError, OSError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
            raise ValueError(f"读取计划表 v07 的「{slot}」失败：{urls[0]}。{exc}") from exc
        path = output / f"{slot}.json"
        write_json(path, payload)
        rules[slot] = str(path)
    downloaded = sources.download(args.index, "original", output, selected)
    if downloaded["failures"]:
        detail = "；".join(f"{item['name']}：{item['reason']}" for item in downloaded["failures"])
        raise ValueError(f"原始合同取件失败：{detail}")
    path = output / "预埋输入.json"
    materials = {"batch": batch, "rules": rules, "originals": downloaded["files"],
                 "prompt": str(output / "风险预埋提示词.md"), "existing_evaluation": existing}
    if excluded:
        materials["excluded_originals"] = excluded
    write_json(path, materials)
    print(path)


def require_samples(items, batch):
    if not items or source_tokens(items) != batch["original_tokens"]:
        raise ValueError("清单必须按附件 ID 覆盖本批每份合同样本，每份恰好一次。")


def contract_source(item, originals, drafts_dir):
    if "file_token" in item:
        if "source" in item:
            raise ValueError("原始样本使用 file_token，补充样本使用 source，请各自保留真实来源。")
        original = originals[item["file_token"]]
        path = Path(original["local_path"]).resolve(strict=True)
        if digest(path) != original["sha256"]:
            raise ValueError(f"原始合同已变化：{original['name']}")
        return original["name"], path, {"file_token": item["file_token"]}, original["sha256"]
    source = item["source"]
    if source["kind"] not in {"template", "simulated"} or not source["reference"].strip():
        raise ValueError("补充样本须注明 template 或 simulated，并说明模板来源或模拟场景。")
    path = (drafts_dir / source["path"]).resolve(strict=True)
    if not sources.docx_contract(path)["blocks"]:
        raise ValueError(f"补充样本底稿无可读取的正文：{path}")
    checksum = digest(path)
    return path.name, path, {"source": {"kind": source["kind"], "reference": source["reference"],
                                       "path": str(path), "sha256": checksum}}, checksum


def check_flip(flip, blocks, official_rules, name):
    roles = set(blocks)
    risks, judgments = flip["risks"], flip["judgments"]
    if (not flip["clause"].strip() or set(risks) != roles or set(judgments) != roles
            or any(not risk.strip() for risk in risks.values())):
        raise ValueError(f"{name} 的翻转须注明目标条款、两方正式风险和四项判断。")
    for variant, row in judgments.items():
        if row != {stance: "是" if stance == variant else "否" for stance in roles}:
            raise ValueError(f"{name} 未形成双向翻转，请按独立评测版本或正负对照记录。")
    if official_rules and any((stance, risk) not in official_rules for stance, risk in risks.items()):
        raise ValueError(f"{name} 的翻转风险与正式规则名称或立场不一致。")
    notes = flip.get("clause_blocks")
    if notes is None:
        before, after = blocks.values()
        if len(before) == len(after):
            changed = [i for i, (left, right) in enumerate(zip(before, after), 1) if left != right]
            if len(changed) == 1:
                return {stance: [changed[0], changed[0]] for stance in roles}
    elif set(notes) == roles:
        remainder = []
        for stance, content in blocks.items():
            first, last = notes[stance]
            if type(first) is not int or type(last) is not int or not 1 <= first <= last <= len(content):
                raise ValueError(f"{name} 的目标条款正文块位置无效：{stance}")
            remainder.append((content[:first - 1], content[first - 1:last], content[last:]))
        left, right = remainder
        if left[0] == right[0] and left[2] == right[2] and left[1] != right[1]:
            return notes
    raise ValueError(f"{name} 的两版 Word 须只有目标条款不同。跨多个正文块时请明确标出两版目标范围。")


def seal(args):
    materials = review.read_data(args.inputs)
    batch = materials["batch"]
    originals = {item["file_token"]: item for item in materials["originals"]}
    drafts = review.read_data(args.drafts)["samples"]
    excluded = materials.get("excluded_originals", [])
    require_samples([*materials["originals"], *excluded], batch)
    if not drafts or source_tokens(item for item in drafts if "file_token" in item) != sorted(originals):
        raise ValueError("清单须覆盖本次取到的每份合同样本，每份恰好一次。")
    official_rules = set()
    rule_sources = [review.read_data(Path(path)) for path in materials.get("rules", {}).values()]
    if rule_sources and all("rules" in source for source in rule_sources):
        official_rules = {(rule["stance"], rule["name"]) for source in rule_sources for rule in source["rules"]}
    stances, names, paths = set(), set(), set()
    source_hashes = {item["sha256"] for item in originals.values()}
    prepared = []
    for item in drafts:
        title, original_path, source, original_hash = contract_source(item, originals, args.drafts.parent)
        if "source" in source:
            if original_hash in source_hashes:
                raise ValueError(f"补充样本底稿与已纳入样本重复：{title}")
            source_hashes.add(original_hash)
        versions = item["versions"]
        roles = {version["stance"] for version in versions}
        if (len(versions) != 2 or len(roles) != 2
                or any(not role.strip() or role != sources.filename_for_attachment(role) for role in roles)
                or (stances and stances != roles)):
            raise ValueError(f"{title} 须包含本批相同的两个明确立场，各一份。")
        stances = roles
        checked, stems, blocks = [], set(), {}
        for version in versions:
            path = (args.drafts.parent / version["path"]).resolve(strict=True)
            suffix = "_" + version["stance"] + "版"
            name = filename_key(path.name)
            if (path.suffix != ".docx" or not path.stem.endswith(suffix) or path.stem == suffix
                    or name in names or path.name != sources.filename_for_attachment(path.name)
                    or path in paths or path == original_path):
                raise ValueError(f"评测 Word 必须独立且文件名唯一，并以「{suffix}.docx」结尾：{path}")
            contract = sources.docx_contract(path)
            if not contract["blocks"]:
                raise ValueError(f"评测 Word 无可读取的正文：{path}")
            stems.add(path.stem[:-len(suffix)])
            names.add(name)
            paths.add(path)
            blocks[version["stance"]] = contract["blocks"]
            checksum = contract["source_sha256"]
            checked.append({"stance": version["stance"], "path": str(path), "sha256": checksum,
                            "reuses_source": checksum == original_hash})
        if len(stems) != 1:
            raise ValueError(f"同份合同的两个版本需使用同一个文件名主体：{title}")
        report = (args.drafts.parent / item["report"]).resolve(strict=True)
        if report in paths or report.suffix.lower() != ".md" or not report.read_text(encoding="utf-8").strip():
            raise ValueError(f"每份合同需要独立的非空预埋报告（Markdown）：{report}")
        paths.add(report)
        sample = {**source, "name": title, "versions": checked,
                  "report": {"path": str(report), "sha256": digest(report)}}
        if "flip" in item:
            locations = check_flip(item["flip"], blocks, official_rules, title)
            sample["flip"] = {**item["flip"], "clause_blocks": locations}
        prepared.append(sample)
    target = f"{sources.BASE_URL}?table={sources.TABLES['samples'][0]}&record={batch['record_ids']['samples']}"
    manifest = {"batch": batch, "target": target, "field": sources.EVALUATION_FIELD, "samples": prepared}
    if excluded:
        manifest["excluded_originals"] = excluded
    write_json(args.out, manifest)
    print(args.out.resolve())


def evaluation_attachments(record_id):
    table_id = sources.TABLES["samples"][0]
    result = sources.run_cli("base", "+record-get", "--base-token", sources.BASE,
                             "--table-id", table_id, "--record-id", record_id,
                             "--field-id", sources.EVALUATION_FIELD, "--format", "json")
    rows = sources.unpack_records(result)
    if len(rows) != 1 or rows[0]["record_id"] != record_id:
        raise ValueError("未读回目标合同样本库记录。")
    return rows[0][sources.EVALUATION_FIELD] or []


def filename_key(name):
    return normalize("NFC", name).casefold()


def verified_attachments(attachments, expected, record_id, directory):
    verified, tokens = {}, set()
    names = {filename_key(name): name for name in expected}
    for item in attachments:
        name = names.get(filename_key(item["name"]))
        if name is None:
            continue
        if name in verified or item["file_token"] in tokens:
            raise ValueError(f"评测附件字段存在重名或重复文件标识：{name}。请先核对飞书现值。")
        downloaded = sources.download_attachment(item, directory, record_id)
        if downloaded["sha256"] != expected[name]["sha256"]:
            raise ValueError(f"飞书附件与用户审查版本内容不同：{name}")
        verified[name] = item["file_token"]
        tokens.add(item["file_token"])
    return verified


def upload(args):
    if not args.confirm:
        raise ValueError("请先交付双版本和预埋报告，取得用户确认可写回后再执行。")
    manifest = review.read_data(args.review)
    if manifest.get("excluded_originals"):
        raise ValueError("本次待审清单跳过了原件，仅供本地核验。回填须使用完整批次的人工审查清单。")
    batch = manifest["batch"]
    require_samples([sample for sample in manifest["samples"] if "file_token" in sample], batch)
    expected, names_seen = {}, set()
    for sample in manifest["samples"]:
        if len(sample["versions"]) != 2:
            raise ValueError("每份合同须有两份已审查的评测 Word。")
        files = [*sample["versions"], sample["report"]]
        if "file_token" not in sample:
            if sample["source"]["kind"] not in {"template", "simulated"}:
                raise ValueError("待审清单中的补充样本来源无效。")
            files.append(sample["source"])
        for entry in files:
            path = Path(entry["path"])
            if digest(path) != entry["sha256"]:
                raise ValueError(f"人工审查后的文件已变化，请重新交付审查：{path}")
        for entry in sample["versions"]:
            name = Path(entry["path"]).name
            signature = filename_key(name)
            if signature in names_seen:
                raise ValueError(f"评测文件名重复：{name}")
            names_seen.add(signature)
            expected[name] = entry
    current, _ = live_batch(batch["contract_type"])
    if current != batch:
        raise ValueError("样本库或计划表记录已变化，请重新取件并核对人工审查范围。")
    record_id = batch["record_ids"]["samples"]
    table_id = sources.TABLES["samples"][0]
    target = f"{sources.BASE_URL}?table={table_id}&record={record_id}"
    if manifest["target"] != target or manifest["field"] != sources.EVALUATION_FIELD:
        raise ValueError("清单目标与本批合同样本库附件字段不一致。")
    receipt = {"contract_type": batch["contract_type"], "target": target, "field": sources.EVALUATION_FIELD,
               "review_sha256": digest(args.review), "status": "pending", "verified": {}}
    write_json(args.out, receipt)
    try:
        with TemporaryDirectory() as temporary:
            scratch = Path(temporary)
            remote = scratch / "remote"
            files = scratch / "upload"
            files.mkdir()
            attachments = evaluation_attachments(record_id)
            original_attachments = {item["file_token"]: item["name"] for item in attachments}
            receipt["verified"] = verified_attachments(attachments, expected, record_id, remote)
            receipt["reused"] = dict(receipt["verified"])
            planned = [name for name in expected if name not in receipt["verified"]]
            for start in range(0, len(planned), 50):
                names = [name for name in planned[start:start + 50] if name not in receipt["verified"]]
                if not names:
                    continue
                for name in names:
                    shutil.copyfile(expected[name]["path"], files / name)
                    if digest(files / name) != expected[name]["sha256"]:
                        raise ValueError(f"上传副本与已审查版本不一致：{name}")
                file_args = [arg for name in names for arg in ("--file", "./" + name)]
                sources.run_cli("base", "+record-upload-attachment", "--base-token", sources.BASE,
                                "--table-id", table_id, "--record-id", record_id,
                                "--field-id", sources.EVALUATION_FIELD, *file_args, cwd=files)
                required = {*receipt["verified"], *names}
                for delay in (0, 1, 2, 4):
                    if delay:
                        sleep(delay)
                    attachments = evaluation_attachments(record_id)
                    actual_names = {filename_key(item["name"]) for item in attachments}
                    if {filename_key(name) for name in required} <= actual_names:
                        break
                receipt["verified"] = verified_attachments(attachments, expected, record_id, remote)
                if not required <= receipt["verified"].keys():
                    raise ValueError("飞书回读缺少本轮附件，先检查已写结果再继续。")
                retained = {item["file_token"]: item["name"] for item in attachments}
                if any(retained.get(token) != name for token, name in original_attachments.items()):
                    raise ValueError("评测字段中的已有附件在操作期间发生变化，请核对飞书记录。")
            reused_tokens = set(receipt["reused"].values())
            receipt["preserved"] = {token: name for token, name in original_attachments.items()
                                    if token not in reused_tokens}
            attachment_names = {item["file_token"]: item["name"] for item in attachments}
            receipt["actual_names"] = {name: attachment_names[token] for name, token in receipt["verified"].items()}
        receipt["status"] = "verified"
    except (ValueError, OSError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
        receipt["status"] = "unverified"
        receipt["issue"] = str(exc)
        raise ValueError(f"飞书附件写入未通过回读：{exc}。回执：{args.out.resolve()}") from exc
    finally:
        args.out.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(args.out.resolve())


def add_commands(commands):
    stage = commands.add_parser("risk-inputs", help="经确认后读取原始样本及计划表 v07 的双方规则")
    stage.add_argument("--index", type=Path, required=True)
    stage.add_argument("--confirm", action="store_true")
    stage.add_argument("--skip-original", action="append", metavar="FILE_TOKEN",
                       help="按附件 ID 跳过已确认缺件的原始样本，可重复指定")
    stage.add_argument("--out", type=Path, required=True)
    draft = commands.add_parser("risk-review", help="核验双版本与每份预埋报告并生成待审查清单")
    draft.add_argument("--inputs", type=Path, required=True)
    draft.add_argument("--drafts", type=Path, required=True)
    draft.add_argument("--out", type=Path, required=True)
    publish = commands.add_parser("risk-upload", help="人工确认后回填并回读样本库评测合同附件")
    publish.add_argument("--review", type=Path, required=True)
    publish.add_argument("--confirm", action="store_true")
    publish.add_argument("--out", type=Path, required=True)
    return {"risk-inputs": inputs, "risk-review": seal, "risk-upload": upload}
