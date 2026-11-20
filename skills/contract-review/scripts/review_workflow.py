"""Retrieve a review batch, create local review links, and check a lawyer's final delivery."""

import argparse
from collections import defaultdict
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import NamedTemporaryFile, TemporaryDirectory
from unicodedata import normalize
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile, ZipFile

import review
import review_package as package
import review_publish
import sources

MATERIAL_ERRORS = (ValueError, OSError, KeyError, TypeError, BadZipFile, ParseError, subprocess.TimeoutExpired)


def write_report(path, report):
    review.write_new(path, json.dumps(report, ensure_ascii=False, indent=2) + "\n")


def file_hash(path):
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def material_route(index):
    if index.get("annotation_urls"):
        return "existing"
    state = index.get("statuses", {}).get("initial")
    if state == "已完成":
        return "missing_completed"
    if state in {"未开始", "未初标", "未标注", "未完成", "待初标", "未进行", "进行中"}:
        return "pending_initial"
    return "unknown_initial"


def discover(contract_type, output):
    index = sources.resolve(contract_type)
    index["route"] = material_route(index)
    write_report(output, index)


def selected_link(candidates, override, description):
    if override:
        return override
    if len(candidates) != 1:
        detail = "没有链接" if not candidates else "有多个候选链接，请先确认批次或数据表"
        raise ValueError(f"{description}{detail}")
    return candidates[0]


def has_annotation_values(values):
    return any(review.value_of(values.get(field)).strip() for field in review.FIELDS)


def fetched_contracts(index_path, index, names, output):
    requested = {normalize("NFC", name) for name in names}
    if not index["attachments"]["evaluation"]:
        raise ValueError("样本库「用于评测的合同」字段没有附件")
    sources.download(index_path, "evaluation", output)
    files = review.read_data(output / "evaluation" / "下载清单.json")["files"]
    available = {normalize("NFC", item["name"]) for item in files}
    return files, sorted(requested - available), [item["name"] for item in files
                                                 if normalize("NFC", item["name"]) not in requested]


def fetch(args):
    index = review.read_data(args.index)
    route = material_route(index) if not args.annotation else "existing"
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {"contract_type":index["contract_type"], "initial_status":index["statuses"]["initial"],
              "route":route, "record_ids":index["record_ids"], "table_urls":index.get("table_urls", {}), "issues":[]}
    stage = {"missing_completed":"计划表显示初标已完成，但缺少可读取的标注集入口。请补链接、附件或对应访问权限。",
             "pending_initial":"已识别为初标待处理。等待双立场预埋和初标规则。",
             "unknown_initial":"初标状态无法确认。请核对计划表与标注集链接。"}
    table = None
    if route in stage:
        report["issues"].append(stage[route])
    else:
        target = None
        try:
            target = selected_link(index["annotation_urls"], args.annotation, "计划表标注集")
            candidate = sources.read_base_table(target, scratch_dir=output)
            missing = set(review.FIELDS) - set(candidate["fields"])
            if missing:
                raise ValueError("未读到完整标注集，缺列 " + "、".join(sorted(missing)))
            populated = [row for row in candidate["rows"] if has_annotation_values(row)]
            if not populated:
                raise ValueError("标注集没有非空记录")
            table = {**candidate, "rows":populated}
            report["empty_annotation_records"] = len(candidate["rows"]) - len(populated)
            write_report(output / "标注来源.json", table)
            report["annotations"] = str(output / "标注来源.json")
        except MATERIAL_ERRORS as exc:
            report["route"] = "missing_completed" if report["initial_status"] == "已完成" else "materials_needed"
            report["issues"].append(f"标注集入口 {target or index['annotation_urls']}：{exc}")
    if route not in {"pending_initial", "unknown_initial"}:
        try:
            names = [review.value_of(row[review.CONTRACT]) for row in table["rows"]] if table else []
            files, missing, unannotated = fetched_contracts(args.index, index, names, output)
            report["contracts"] = files
            if table:
                report["without_annotations"] = unannotated
            if "" in missing:
                report["issues"].append("标注集存在空合同附件名称")
                missing.remove("")
            if missing:
                report["issues"].append("标注集引用的下列合同不在「用于评测的合同」字段中：" + "、".join(missing))
        except MATERIAL_ERRORS as exc:
            report["issues"].append(f"合同附件：{exc}")
        for slot, urls in index.get("rule_urls", {}).items():
            override = args.rule if slot == "整理好的规则" else args.other_rule
            if not urls and not override:
                report["issues"].append(f"任务管理表缺正式规则链接：{slot}")
                continue
            target = None
            try:
                target = selected_link(urls, override, slot)
                rules = sources.rule_records(sources.read_base_table(target, scratch_dir=output))
                dest = output / f"{slot}.json"
                write_report(dest, rules)
                report.setdefault("rules", []).append(str(dest))
            except MATERIAL_ERRORS as exc:
                report["issues"].append(f"{slot} {target or urls}：{exc}")
        if table:
            report["route"] = "materials_needed" if report["issues"] else "type_check_required"
    write_report(output / "取件结果.json", report)
    print(output / "取件结果.json")


def collect(args):
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    index = output / "材料索引.json"
    discover(args.type, index)
    fetch(argparse.Namespace(index=index, out=output / "取件", annotation=args.annotation,
                             rule=args.rule, other_rule=args.other_rule))
    receipt = review.read_data(output / "取件" / "取件结果.json")
    if receipt["route"] != "type_check_required":
        print("材料待核对，详见取件结果。")
        return
    checks = [{"path":item["local_path"], "name":item["name"], "sha256":item["sha256"],
               "file_token":item["file_token"], "match":None, "reason":""} for item in receipt["contracts"]]
    path = output / "类型核验模板.json"
    write_report(path, {"contract_type":args.type, "contracts":checks})
    print(path)


def rule_set(paths):
    by_key = {}
    ids = set()
    for path in paths:
        payload = review.read_data(path)
        for row in payload["rules"] if isinstance(payload, dict) else payload:
            key = row["name"], row["stance"]
            if any(not isinstance(row.get(field), str) or not row[field].strip() for field in ("name", "stance", "level", "logic")):
                raise ValueError(f"正式规则缺少完整原值：{key}")
            previous = by_key.get(key)
            if previous:
                if any(row[field] != previous[field] for field in ("level", "logic")):
                    raise ValueError(f"正式规则有多个不同版本：{key}")
                continue
            item = dict(row)
            if isinstance(payload, dict) and payload.get("source"):
                item.setdefault("source", payload["source"])
            if item["id"] in ids:
                raise ValueError(f"不同正式规则使用同一 ID：{item['id']}")
            ids.add(item["id"])
            by_key[key] = item
    if not by_key:
        raise ValueError("未提供正式规则")
    return by_key


def contract_paths(checks, contract_type):
    if checks["contract_type"] != contract_type:
        raise ValueError("合同类型核验记录与当前批次不一致")
    results = []
    for i, item in enumerate(checks["contracts"], 1):
        name, path = item["name"], Path(item["path"])
        if item.get("match") is not True or not item.get("reason", "").strip():
            raise ValueError(f"{name} 未确认属于「{contract_type}」：{item.get('reason', '缺少类型核验依据')}。本批未生成复核页")
        if package.digest(path.read_bytes()) != item["sha256"]:
            raise ValueError(f"{name} 的文件内容与类型核验时不同")
        contract = sources.docx_contract(path, f"C{i}", name)
        if not contract["blocks"]:
            raise ValueError(f"{name} 缺少可定位的正文")
        results.append((contract, path, item))
    return results


def annotation_rows(paths, contracts, rule_keys):
    rows = []
    for index, path in enumerate(paths, 1):
        is_excel = path.suffix.lower() == ".xlsx"
        records = review.read_xlsx(path) if is_excel else review.imported_rows(path)
        for identifier, values in records:
            if not has_annotation_values(values):
                continue
            suffix = f"-表{index}" if is_excel and len(paths) > 1 else ""
            rid = identifier + suffix
            if not set(review.FIELDS) <= values.keys():
                raise ValueError(f"{path.name} {rid} 缺少标准标注字段")
            fields = {field:review.value_of(values[field]) for field in review.FIELDS}
            contract = contracts.get(normalize("NFC", fields[review.CONTRACT]))
            if not contract:
                raise ValueError(f"{path.name} {rid} 指向未核验的合同版本：{fields[review.CONTRACT]}")
            rule = rule_keys.get((fields[review.RISK], fields[review.STANCE]))
            if not rule:
                raise ValueError(f"{path.name} {rid} 无法唯一对应正式规则：{fields[review.RISK]}／{fields[review.STANCE]}")
            scope = "slice" if fields[review.CLAUSE].strip() else "full_missing"
            if scope == "full_missing" and (fields[review.REL] != "否" or fields[review.CLAUSE_TYPE] or fields[review.EVIDENCE]):
                raise ValueError(f"{path.name} {rid} 不能作为无主条款的全文缺失记录")
            rows.append({"id":rid, "contract_id":contract["id"], "rule_id":rule["id"],
                         "fields":fields, "scope":scope})
    if not rows:
        raise ValueError("标注集没有可复核的记录")
    review.index_records(rows, "标注行")
    return rows


def prepare(args):
    if args.zip.resolve() == args.html.resolve() or args.zip.exists() or args.html.exists():
        raise ValueError("请为初始 ZIP 和复核页指定两个新的输出文件")
    type_check = review.read_data(args.type_check)
    if args.materials:
        if args.annotations or args.rules:
            raise ValueError("使用取件结果时，原标注集和正式规则从取件结果读取。")
        materials = review.read_data(args.materials)
        if (materials["contract_type"] != args.type or materials["route"] != "type_check_required"
                or materials.get("issues")):
            raise ValueError("取件结果仍有缺项或与本合同类型不符，请先核对材料。")
        fetched = {(str(Path(item["local_path"]).resolve()), item["name"], item["sha256"], item["file_token"])
                   for item in materials["contracts"]}
        reviewed = {(str(Path(item["path"]).resolve()), item["name"], item["sha256"], item.get("file_token"))
                    for item in type_check["contracts"]}
        if fetched != reviewed or len(type_check["contracts"]) != len(materials["contracts"]):
            raise ValueError("类型核验须包含本次取件的全部评测合同及对应附件标识、名称和哈希。")
        args.annotations = [Path(materials["annotations"])]
        args.rules = [Path(path) for path in materials["rules"]]
    if not args.annotations or not args.rules:
        raise ValueError("请提供取件结果，或同时提供原标注集和正式规则。")
    checks = contract_paths(type_check, args.type)
    contracts = {normalize("NFC", c["name"]):c for c, _, _ in checks}
    if not contracts or len(contracts) != len(checks) or (args.paired and len(contracts) != 2):
        raise ValueError("合同文件名须唯一；双版本须提供两份已核验合同")
    rules = rule_set(args.rules)
    rows = annotation_rows(args.annotations, contracts, rules)
    annotated = {row["contract_id"] for row in rows}
    if args.paired and any(contract["id"] not in annotated for contract in contracts.values()):
        raise ValueError("双版本同时复核要求两份合同都已有标注")
    result = subprocess.run(["node", str(Path(__file__).with_name("workflow-intake.cjs"))],
                            input=json.dumps({"fields":review.FIELDS, "contracts":list(contracts.values()),
                                              "rows":rows, "paired":args.paired}, ensure_ascii=False),
                            capture_output=True, encoding="utf-8", timeout=120, check=False)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "合同与标注切片未能对应")
    project = json.loads(result.stdout)
    project.pop("paired")
    title = args.type + (" · 双版本复核" if args.paired else "")
    project.update(title=title, contract_type=args.type, stage="student", rules=list(rules.values()),
                   type_checks=[{k:item[k] for k in ("name", "sha256", "reason", "file_token") if k in item}
                                for _, _, item in checks],
                   formal_rule_sources=[{"name":path.name, "sha256":package.digest(path.read_bytes())} for path in args.rules])
    if args.coverage:
        coverage = review.read_data(args.coverage)
        project.update(paths=coverage["paths"], applicability=coverage.get("applicability", {}))
    documents = [("实际用于标注的合同", path, contract["name"]) for contract, path, _ in checks]
    supporting = [("原标注集", path, path.name) for path in args.annotations] + [
        ("正式规则", path, path.name) for path in args.rules]
    if args.coverage:
        supporting.append(("规则覆盖清单", args.coverage, args.coverage.name))
    package.seed_project(project, review.index_records(project["contracts"], "合同"),
                         review.index_records(project["rules"], "正式规则"), args.zip, documents+supporting,
                         source="、".join(path.name for path in args.annotations))
    package.build_tool(args.html, args.zip)


def entry(args):
    incoming = package.read_package(args.zip)
    if incoming.project["stage"] != args.stage:
        raise ValueError(f"需要 {args.stage} 阶段的 ZIP，当前包处于 {incoming.project['stage']} 阶段")
    package.build_tool(args.html, args.zip)


def receive(args):
    incoming = package.read_package(args.zip)
    stage = incoming.project["stage"]
    if args.stage and args.stage != stage:
        raise ValueError(f"需要 {args.stage} 阶段的 ZIP，当前包处于 {stage} 阶段")
    args.out.mkdir(parents=True, exist_ok=False)
    names = {"student":"实习生复核", "lawyer":"律师复核", "final":"实习生验收"}
    page = args.out / (names[stage] + ".html")
    package.build_tool(page, args.zip)
    print(page.resolve(), flush=True)
    if stage == "final":
        report, workbook = args.out / "预检.json", args.out / "标注集.xlsx"
        result = preflight(argparse.Namespace(zip=args.zip, coverage=args.coverage, rules=args.rules,
                                             semantic=args.semantic, excel=None, export=workbook, out=report))
        if workbook.is_file():
            print(workbook.resolve())
        return result


def check_embedded_sources(zip_path, incoming, rows, add):
    project = incoming.project
    manifest = incoming.manifest
    by_contract = defaultdict(list)
    for row in rows:
        by_contract[row["contract_id"]].append(row)
    by_identity = {(item["sha256"], item["name"]):item for item in manifest["sources"]}
    with ZipFile(zip_path) as archive, TemporaryDirectory() as temporary:
        for contract in project["contracts"]:
            source = by_identity.get((contract.get("source_sha256"), contract["name"]))
            if not source or not source["entry"].lower().endswith(".docx"):
                add(review.CONTRACT, "终版 ZIP 未携带文件名和哈希均与标注版本相符的 Word。",
                    contract=contract["name"], blocking=True)
                continue
            destination = Path(temporary) / "合同.docx"
            destination.write_bytes(archive.read(source["entry"]))
            blocks = [review.layout_text(block["text"]) for block in sources.docx_contract(destination)["blocks"]]
            offsets = {0}
            end = 0
            for block in blocks:
                end += len(block)
                offsets.add(end)
            full_text = "".join(blocks)
            matches = {}
            for row in by_contract[contract["id"]]:
                for field in (review.CLAUSE, review.ASSOCIATED):
                    clause = review.layout_text(row["fields"].get(field, ""))
                    if not clause:
                        continue
                    if clause not in matches:
                        matches[clause] = 0
                        start = full_text.find(clause)
                        while start != -1:
                            if start in offsets and start + len(clause) in offsets:
                                matches[clause] += 1
                            start = full_text.find(clause, start + 1)
                    if matches[clause] != 1:
                        add(field, "无法在随包 Word 的完整段落或表格边界唯一定位。",
                            row_id=row["id"], blocking=True)

        rule_sources = project.get("formal_rule_sources") or []
        if not rule_sources:
            return False
        paths = []
        for count, ref in enumerate(rule_sources):
            candidate = by_identity.get((ref["sha256"], ref["name"]))
            if not candidate:
                add("正式规则来源", f"缺少正式规则原值附件 {ref['name']} 或哈希不符。", blocking=True)
                return False
            path = Path(temporary) / f"rule-{count}.json"
            path.write_bytes(archive.read(candidate["entry"]))
            paths.append(path)
        rule_keys = rule_set(paths)
        compare_formal_rules(rows, rule_keys, add)
        return True


def compare_formal_rules(rows, keys, add):
    for row in rows:
        fields = row["fields"]
        rule = keys.get((fields.get(review.RISK), fields.get(review.STANCE)))
        if not rule:
            add(f"{review.RISK}／{review.STANCE}", "未在独立正式规则源找到同名同立场规则。",
                row_id=row["id"], blocking=True)
        else:
            for field, key in review.RULE_FIELDS.items():
                if fields.get(field) != review.same_text(rule[key]):
                    add(field, "与独立正式规则原值不一致。", row_id=row["id"],
                        expected=rule[key], blocking=True)


def compare_workbook(path, rows, add):
    actual = list(review.read_xlsx(path, require_annotation_sheet=True))
    if len(actual) != len(rows):
        add("记录数", f"Excel 有 {len(actual)} 条，终版 ZIP 应导出 {len(rows)} 条。", blocking=True)
    for (rid, fields), row in zip(actual, rows):
        line = int(rid[4:])
        if list(fields) != list(review.FIELDS):
            add("列名及顺序", "工作表应按规定顺序保留 15 列。", line=line, blocking=True)
            break
    for (rid, fields), row in zip(actual, rows):
        line = int(rid[4:])
        for field in review.FIELDS:
            expected = review.same_text(row["fields"][field])
            if fields.get(field) != expected:
                add(field, "Excel 值与律师终版 ZIP 不一致。", row_id=row["id"], line=line,
                    value=fields.get(field), expected=expected, blocking=True)


def preflight(args):
    try:
        incoming = package.read_package(args.zip)
    except MATERIAL_ERRORS as exc:
        write_report(args.out, {"status":"blocked", "blocking":1,
                                "issues":[{"field":"ZIP 与版本同步", "reason":str(exc), "blocking":True}]})
        return 1
    project = incoming.project
    if project["stage"] != "final":
        raise ValueError("预检需要律师终版 ZIP")
    if args.coverage:
        coverage = review.read_data(args.coverage)
        project = {**project, "paths":coverage["paths"], "applicability":coverage.get("applicability", {})}
    rows = package.workbook_rows(project)
    index = review.index_records(project["rows"], "标注行")
    row_lines = {row["id"]:line for line, row in enumerate(rows, 2)}
    issues = []

    def add(field, reason, row_id=None, line=None, contract=None, value=None, expected=None, blocking=False):
        fields = index.get(row_id, {}).get("fields", {})
        issues.append({"contract":contract or fields.get(review.CONTRACT), "excel_row":line or row_lines.get(row_id),
                       "source_row":row_id, "field":field, "value":fields.get(field) if value is None else value,
                       "expected":expected, "reason":reason, "blocking":blocking})

    contracts = review.index_records(project["contracts"], "合同")
    rules = review.index_records(project["rules"], "正式规则")
    for issue in review.validate(project, contracts, rules, final=True):
        identity = contracts.get(issue.get("contract_id"), {})
        add(issue.get("field") or issue["check"], issue["message"], row_id=issue["row_id"],
            contract=identity.get("name"), expected=issue.get("expected"), blocking=issue["blocking"])
    for row in rows:
        if not row["fields"].get(review.LEVEL, "").strip():
            add(review.LEVEL, "风险等级为空，正式发布前须核对专家规则。", row_id=row["id"], blocking=True)
    independent_rules = check_embedded_sources(args.zip, incoming, project["rows"], add)
    if args.rules:
        compare_formal_rules(project["rows"], rule_set(args.rules), add)
        independent_rules = True
    if args.excel:
        try:
            compare_workbook(args.excel, rows, add)
        except MATERIAL_ERRORS as exc:
            add("工作表格式", str(exc), blocking=True)
    else:
        add("标注集 Excel", "本次从律师终版重导时，以回放后的全部可导出记录为基线。")
    row_set = set(index)
    pending = ["全文、适用前提、触发、排除及证据支持性"]
    if args.semantic:
        semantic = review.read_data(args.semantic)
        if semantic["package_id"] != incoming.manifest["package_id"]:
            raise ValueError("人工或 Codex 全文核验记录与律师终版 ZIP 不一致")
        assessed = semantic["reviewed_rows"]
        if not isinstance(assessed, dict) or any(rid not in row_set or not isinstance(reason, str) or not reason.strip()
                                                for rid, reason in assessed.items()):
            raise ValueError("全文核验清单含未知记录或没有核对依据")
        if set(assessed) == row_set:
            pending.clear()
        for issue in semantic.get("issues", []):
            if issue["row_id"] not in row_set:
                raise ValueError("全文核验问题指向未知标注行")
            add(issue["field"], issue["reason"], row_id=issue["row_id"], blocking=issue.get("blocking", True))
    if not project.get("paths") or any(c["id"] not in {p["contract_id"] for p in project["paths"]}
                                       for c in project["contracts"]):
        pending.append("逐合同、适用规则及立场的覆盖路径")
    if not independent_rules:
        pending.append("从独立正式规则核原值")
    blocking = sum(issue["blocking"] for issue in issues)
    if args.export and not blocking:
        args.export.parent.mkdir(parents=True, exist_ok=True)
        review.xlsx(args.export, list(review.FIELDS), [[row["fields"][field] for field in review.FIELDS] for row in rows])
        compare_workbook(args.export, rows, add)
        blocking = sum(issue["blocking"] for issue in issues)
    workbook = args.export if args.export and args.export.is_file() else args.excel
    report = {"status":"blocked" if blocking else "pending_review" if pending else "ready",
              "package_id":incoming.manifest["package_id"], "export_rows":len(rows),
              "zip_sha256":file_hash(args.zip), "excel_sha256":file_hash(workbook) if workbook else None,
              "columns":len(review.FIELDS), "blocking":blocking, "pending":pending, "issues":issues}
    write_report(args.out, report)
    print(f"{report['status']} · {len(rows)} 条 × {len(review.FIELDS)} 列 · {args.out}")
    return 1 if blocking else 0


def publish(args):
    incoming = package.read_package(args.zip)
    if incoming.project["stage"] != "final":
        raise ValueError("只可从律师终版 ZIP 提交飞书。")
    rows = package.workbook_rows(incoming.project)
    report = review.read_data(args.report)
    if (report.get("status") != "ready" or report.get("blocking") != 0 or report.get("pending")
            or report.get("package_id") != incoming.manifest["package_id"]
            or report.get("zip_sha256") != file_hash(args.zip)
            or report.get("excel_sha256") != file_hash(args.excel)):
        raise ValueError("需要对应这份终版 ZIP 和 Excel 的 ready 预检报告。")
    problems = []
    compare_workbook(args.excel, rows, lambda field, reason, **details: problems.append(f"{field}：{reason}"))
    if problems or not rows:
        raise ValueError(problems[0] if problems else "Excel 没有可提交的标注。")
    return review_publish.deliver(args, rows, report["package_id"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    scan = commands.add_parser("discover", help="用已授权的飞书 CLI 定位合同类型、状态和来源")
    scan.add_argument("--type", required=True)
    scan.add_argument("--out", type=Path, required=True)
    pull = commands.add_parser("fetch", help="读取标注和正式规则 Base、下载相应样本")
    pull.add_argument("--index", type=Path, required=True)
    pull.add_argument("--annotation")
    pull.add_argument("--rule")
    pull.add_argument("--other-rule")
    pull.add_argument("--out", type=Path, required=True)
    collect_materials = commands.add_parser("collect", help="用合同类型取件并生成类型核验模板")
    collect_materials.add_argument("--type", required=True)
    collect_materials.add_argument("--out", type=Path, required=True)
    collect_materials.add_argument("--annotation")
    collect_materials.add_argument("--rule")
    collect_materials.add_argument("--other-rule")
    create = commands.add_parser("prepare", help="以已核验合同、现有标注及正式规则生成本地首包")
    create.add_argument("--type", required=True)
    create.add_argument("--type-check", type=Path, required=True)
    create.add_argument("--materials", type=Path)
    create.add_argument("--annotations", type=Path, action="append")
    create.add_argument("--rules", type=Path, action="append")
    create.add_argument("--coverage", type=Path)
    create.add_argument("--paired", action="store_true")
    create.add_argument("--zip", type=Path, required=True)
    create.add_argument("--html", type=Path, required=True)
    page = commands.add_parser("entry", help="检查角色阶段并生成直接装载 ZIP 的本地复核页")
    page.add_argument("--zip", type=Path, required=True)
    page.add_argument("--stage", choices=("student", "lawyer", "final"), required=True)
    page.add_argument("--html", type=Path, required=True)
    receive_package = commands.add_parser("receive", help="按 ZIP 阶段生成复核页；律师终版另导出 Excel 和预检")
    receive_package.add_argument("--zip", type=Path, required=True)
    receive_package.add_argument("--out", type=Path, required=True)
    receive_package.add_argument("--stage", choices=("student", "lawyer", "final"))
    receive_package.add_argument("--coverage", type=Path)
    receive_package.add_argument("--rules", type=Path, action="append")
    receive_package.add_argument("--semantic", type=Path)
    check = commands.add_parser("preflight", help="从律师终版 ZIP 检查字段、来源及 Excel，对外写入前留报告")
    check.add_argument("--zip", type=Path, required=True)
    check.add_argument("--excel", type=Path)
    check.add_argument("--rules", type=Path, action="append")
    check.add_argument("--coverage", type=Path)
    check.add_argument("--semantic", type=Path)
    check.add_argument("--export", type=Path)
    check.add_argument("--out", type=Path, required=True)
    upload = commands.add_parser("publish", help="预览或确认后提交终版 Excel 到指定飞书数据表")
    upload.add_argument("--zip", type=Path, required=True)
    upload.add_argument("--excel", type=Path, required=True)
    upload.add_argument("--report", type=Path, required=True)
    upload.add_argument("--target", required=True, help="具体数据表链接；创建新表时提供 Base 链接")
    upload.add_argument("--new-table", help="在目标 Base 新建此名称的数据表")
    upload.add_argument("--confirm", action="store_true", help="用户已明确确认本次目标与写入方式")
    upload.add_argument("--out", type=Path, required=True, help="保存飞书写入回执或只读预览")
    args = parser.parse_args()
    if args.command == "discover":
        discover(args.type, args.out)
        return 0
    return {"fetch":fetch, "collect":collect, "prepare":prepare, "entry":entry, "receive":receive,
            "preflight":preflight, "publish":publish}[args.command](args) or 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except MATERIAL_ERRORS as error:
        sys.exit(str(error))
