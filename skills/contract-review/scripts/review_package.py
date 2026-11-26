"""Migrate old review files and verify ZIP exports."""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import sys
from uuid import uuid4
from zipfile import BadZipFile, ZIP_STORED, ZipFile

import review

FORMAT = "contract-review-package"
VERSION = 1
PAIRED_VERSION = 2
SOURCE_FIELDS = {"合同附件名称", "立场"}
SHARED_FIXED_FIELDS = SOURCE_FIELDS | {"风险名称", "风险等级", "审查逻辑", "条款原文"}
LIMIT = 200 * 1024 * 1024
STATE_KEYS = {"stage", "review_questions", "lawyer_suggestions", "lawyer_opinion_required", "role_views", "review_related"}
REOPEN_STAGES = {"lawyer": "student", "final": "lawyer"}
ID = re.compile(r"[0-9a-f-]{36}")
MEMBER = re.compile(r"(?:manifest\.json|baseline\.json|activity/[0-9a-f-]{36}\.json|sources/[0-9]+\.[a-z0-9]+)")


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def digest(data):
    return sha256(data).hexdigest()


@dataclass
class Package:
    manifest: dict
    project: dict


def apply_event(project, rows, event):
    for change in event["rows"]:
        row_id, before, after = (change[k] for k in ("id", "before", "after"))
        if rows.get(row_id) != before or not isinstance(after, dict) or after.get("id") != row_id:
            raise ValueError(f"操作中的标注原值不匹配：{row_id}")
        rows[row_id] = after
    for change in event["state"]:
        key, before, after = (change[k] for k in ("key", "before", "after"))
        if key not in STATE_KEYS or project.get(key) != before:
            raise ValueError(f"操作中的交接原值不匹配：{key}")
        if after is None:
            project.pop(key, None)
        else:
            project[key] = after


def event_matches_stage(event, stage):
    kind, role = event.get("kind"), event["role"]
    if kind not in {"reopen", "role-switch"}:
        return role == stage
    valid_role = role == REOPEN_STAGES.get(stage) if kind == "reopen" else role != stage
    changes = event["state"]
    if not valid_role or event["rows"] != [] or not isinstance(changes, list) or len(changes) != 1:
        return False
    change = changes[0]
    return (isinstance(change, dict) and change.get("key") == "stage"
            and change.get("before") == stage and change.get("after") == event["role"])


def is_current_removal(row):
    history = row.get("review_history") or []
    if (row.get("lawyer") or {}).get("override") is True:
        history = [entry for entry in history if isinstance(entry, dict) and entry.get("stage") == "lawyer"]
    return row["fields"][review.HIT] == "否" and review.latest_judgment(history).get("action") == "remove"


def version_pairs(project):
    if "version_pairs" in project:
        pairs = project["version_pairs"]
        if "version_pair" in project or not isinstance(pairs, list) or not pairs:
            raise ValueError("双版本合同的配对清单无效")
        return pairs
    return [project["version_pair"]] if "version_pair" in project else []


def workbook_rows(project):
    rows = project["rows"]
    paired = {contract_id for pair in version_pairs(project) for contract_id in pair["contracts"]}
    return [row for row in rows if not row.get("replaced_by") and not (is_current_removal(row) and
            (project["stage"] != "final" or (row["contract_id"] in paired
             and (row.get("lawyer") or {}).get("reviewed") is True)))]


def validate_version_pair(project, initial_rows, rows):
    contracts = review.index_records(project["contracts"], "合同")
    if "version_pair" in project and len(contracts) != 2:
        raise ValueError("旧版双立场包须含两份合同")
    used = set()
    for pair in version_pairs(project):
        ids = pair["contracts"]
        if len(ids) != 2 or ids[0] == ids[1] or any(cid in used or cid not in contracts for cid in ids):
            raise ValueError("双版本合同的配对清单无效")
        used.update(ids)
        validate_pair(pair, [contracts[cid] for cid in ids], initial_rows, rows)
    for row_id, initial in initial_rows.items():
        if initial["contract_id"] not in used:
            continue
        row = rows[row_id]
        if (row["contract_id"] != initial["contract_id"]
                or any(row["fields"][field] != initial["fields"][field] for field in SOURCE_FIELDS)):
            raise ValueError(f"双版本标注的来源文件或立场已改变：{row_id}")


def validate_pair(pair, contracts, initial_rows, rows):
    sections = [{section["id"]: (index, section["text"]) for index, section in enumerate(contract["sections"])}
                for contract in contracts]
    previous = (-1, -1)
    matches = {}
    for left, right in pair["sections"]:
        indices = (sections[0][left][0], sections[1][right][0])
        if any(index <= prior for index, prior in zip(indices, previous)):
            raise ValueError("双版本切片配对重复或顺序交叉")
        previous = indices
        matches[left] = right
    comparable = [field for field in review.FIELDS if field not in SOURCE_FIELDS]
    seen = set()
    shared = []
    for left, right in pair["shared"]:
        a, b = initial_rows[left], initial_rows[right]
        sa, sb = a.get("section_id"), b.get("section_id")
        if (left == right or left in seen or right in seen or a["contract_id"] != contracts[0]["id"]
                or b["contract_id"] != contracts[1]["id"] or a.get("scope") != "slice" or b.get("scope") != "slice"
                or sa not in matches or matches[sa] != sb or sections[0][sa][1] != sections[1][sb][1]
                or any(a["fields"][field] != b["fields"][field] for field in comparable if field != review.LOGIC)):
            raise ValueError(f"共享标注 {left}／{right} 与原始合同切片或初标字段不匹配")
        seen.update((left, right))
        # Earlier packages can name a pair whose formal logic differs. Keep both source rows.
        if a["fields"][review.LOGIC] != b["fields"][review.LOGIC]:
            continue
        validate_shared_review(a, b, rows[left], rows[right])
        shared.append([left, right])
    pair["shared"] = shared


def validate_shared_review(a, b, x, y):
    differences = [field for field in review.FIELDS if field not in SOURCE_FIELDS
                   and x["fields"][field] != y["fields"][field]]
    differences.extend(label for role, label in (("student", "实习生复核"), ("lawyer", "律师复核"))
                       if x.get(role) != y.get(role))
    if is_current_removal(x) != is_current_removal(y):
        differences.append("删除状态")
    if differences:
        raise ValueError(f"共享标注 {a['id']}／{b['id']} 的字段未同步：{'、'.join(differences)}")
    for row, before in ((x, a), (y, b)):
        if (any(row.get(key) != before.get(key) for key in
                ("contract_id", "rule_id", "scope", "section_id", "matter_id"))
                or any(row["fields"][field] != before["fields"][field] for field in SHARED_FIXED_FIELDS)):
            raise ValueError("共享标注的合同版本或规则绑定已改变")


def read_package(path):
    with ZipFile(path) as archive:
        infos = archive.infolist()
        names = {item.filename for item in infos}
        if (len(infos) > 2000 or len(names) != len(infos)
                or sum(item.file_size for item in infos) > LIMIT
                or any(item.compress_type != ZIP_STORED or not MEMBER.fullmatch(item.filename) for item in infos)):
            raise ValueError("ZIP 文件列表、压缩方式或大小不符合复核数据包规范")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("format") != FORMAT or manifest.get("version") not in {VERSION, PAIRED_VERSION}:
            raise ValueError("不支持的复核数据包版本")
        if names != set(manifest["files"]) | {"manifest.json"} or "manifest.json" in manifest["files"]:
            raise ValueError("ZIP 内容与清单不一致")
        contents = {}
        for name, expected in manifest["files"].items():
            data = archive.read(name)
            if digest(data) != expected:
                raise ValueError(f"文件校验失败：{name}")
            contents[name] = data
    if digest(contents["baseline.json"]) != manifest["baseline_sha256"]:
        raise ValueError("基线校验失败")
    project = json.loads(contents["baseline.json"])
    if bool(version_pairs(project)) != (manifest["version"] == PAIRED_VERSION):
        raise ValueError("双版本配对清单与数据包版本不一致")
    rows = review.index_records(project["rows"], "标注行")
    initial_rows = rows.copy()
    histories = {}
    seen_ids = set()
    for name, data in contents.items():
        if not name.startswith("activity/"):
            continue
        actor_id = Path(name).stem
        for event in json.loads(data):
            if (not ID.fullmatch(event["id"]) or event["id"] in seen_ids or event["actor_id"] != actor_id
                    or event["role"] not in {"student", "lawyer"} or not event["actor"].strip()
                    or event["seq"] in histories):
                raise ValueError("发现重复的操作或无效的操作者")
            seen_ids.add(event["id"])
            histories[event["seq"]] = event
    if sorted(histories) != list(range(1, len(histories) + 1)):
        raise ValueError("操作序号不连续")
    for _, event in sorted(histories.items()):
        if not event_matches_stage(event, project["stage"]):
            raise ValueError("操作角色与当时的复核阶段不一致")
        apply_event(project, rows, event)
    project["rows"] = list(rows.values())
    for row in project["rows"]:
        if not row.get("replaced_by"):
            continue
        replacement = rows.get(row["replaced_by"], {})
        if (review.card_type(row["fields"]) != "unrelated" or not replacement.get("added_by") or replacement.get("replaced_by")
                or any((row.get(key) or "") != (replacement.get(key) or "") for key in ("contract_id", "rule_id", "matter_id"))
                or (row.get("section_id") and row["section_id"] != replacement.get("section_id"))):
            raise ValueError(f"新增卡片与原切片记录未能对应：{row['id']}")
    if project["stage"] != manifest["stage"]:
        raise ValueError("复核阶段与操作历史不一致")
    if manifest["version"] == PAIRED_VERSION:
        validate_version_pair(project, initial_rows, rows)
    project.pop("shared_rows", None)
    return Package(manifest, project)


def seed(project_path, output, sources=(), labels=None, family=None):
    project, contracts, rules = review.load_project(project_path)
    if labels:
        review.attach_rows(project, contracts, rules, labels)
    files = []
    for source_spec in sources:
        purpose, sep, name = source_spec.partition("=")
        if not sep or not purpose.strip():
            raise ValueError("源文件请使用「用途=路径」")
        path = Path(name)
        files.append((purpose.strip(), path, path.name))
    seed_project(project, contracts, rules, output, files, family, source=project_path.name,
                 migrated=project_path.suffix.lower() == ".html")


def seed_project(project, contracts, rules, output, files, family=None, source="", migrated=False):
    project.setdefault("fields", list(review.FIELDS))
    project.setdefault("checks", list(project.get("semantic_checks", [])) + review.validate(project, contracts, rules))
    if tuple(project["fields"]) != review.FIELDS:
        raise ValueError("输入项目缺少标准 15 列")
    for row in project["rows"]:
        row.setdefault("original_fields", row["fields"].copy())

    source_meta = []
    contents = {}
    for purpose, path, original_name in files:
        if not re.fullmatch(r"\.[a-z0-9]+", path.suffix.lower()):
            raise ValueError(f"源文件扩展名无效：{path.name}")
        data = path.read_bytes()
        member = f"sources/{len(source_meta)+1}{path.suffix.lower()}"
        contents[member] = data
        source_meta.append({"entry": member, "name": original_name, "purpose": purpose, "sha256": digest(data)})
    if source_meta:
        source_digests = {item["sha256"] for item in source_meta}
        for contract in contracts.values():
            if contract.get("source_sha256") and contract["source_sha256"] not in source_digests:
                raise ValueError(f"源文件中缺少标注使用的合同版本：{contract['name']}")
    paired = bool(version_pairs(project))
    project.pop("shared_rows", None)
    if paired:
        rows = review.index_records(project["rows"], "标注行")
        validate_version_pair(project, rows, rows)
    contents["baseline.json"] = json_bytes(project)
    baseline_hash = digest(contents["baseline.json"])
    manifest = {
        "format": FORMAT, "version": PAIRED_VERSION if paired else VERSION, "batch_id": family or baseline_hash[:20],
        "package_id": str(uuid4()), "parents": [], "revision": 0, "round": 1,
        "stage": project["stage"], "baseline_sha256": baseline_hash, "sources": source_meta,
        "handoff": {"action": "迁移旧复核页" if migrated else "创建初始包",
                    "source": source, "at": datetime.now(timezone.utc).isoformat()},
        "files": {name: digest(data) for name, data in contents.items()},
    }
    contents["manifest.json"] = json_bytes(manifest)
    if sum(map(len, contents.values())) > LIMIT:
        raise ValueError("数据包超出 200 MiB 文件内容上限")
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "x", ZIP_STORED) as archive:
        for name, data in contents.items():
            archive.writestr(name, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="command", required=True)
    create = actions.add_parser("seed", help="从旧复核 HTML 或项目 JSON 生成首包或迁移包")
    create.add_argument("project", type=Path)
    create.add_argument("--labels", type=Path)
    create.add_argument("--source", action="append", default=[])
    create.add_argument("--batch")
    create.add_argument("--out", type=Path, required=True)
    for action in ("check", "export"):
        cmd = actions.add_parser(action)
        cmd.add_argument("package", type=Path)
        if action == "export":
            cmd.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "seed":
        seed(args.project, args.out, args.source, args.labels, args.batch)
        return
    package = read_package(args.package)
    project = package.project
    contracts = review.index_records(project["contracts"], "合同")
    rules = review.index_records(project["rules"], "规则")
    issues = review.validate(project, contracts, rules, final=project["stage"] == "final",
                             review_card_types=project["stage"] != "final" or package.manifest.get("review_card_types") is True)
    print(review.validation_report(project, issues))
    if any(i["blocking"] for i in issues):
        raise ValueError("复核数据存在阻塞问题")
    if args.command == "export":
        args.out.parent.mkdir(parents=True, exist_ok=True)
        rows = workbook_rows(project)
        review.xlsx(args.out, list(review.FIELDS), [[row["fields"][field] for field in review.FIELDS] for row in rows])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, BadZipFile) as error:
        sys.exit(str(error))
