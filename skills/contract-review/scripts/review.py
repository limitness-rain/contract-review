"""Build an offline review page and export reviewed annotations."""
import argparse
from collections import Counter, defaultdict
from hashlib import sha256
import json
from pathlib import Path
import re
import sys
from zipfile import ZIP_DEFLATED, ZipFile
from xml.sax.saxutils import escape

FIELDS = (
    "合同附件名称", "条款类型", "条款原文", "风险名称", "立场",
    "条款与规则是否相关", "是否触发该风险", "风险等级", "审查逻辑",
    "关联条款类型", "关联条款属性", "关联条款原文", "风险判断关键证据",
    "风险说明", "修订建议",
)
CONTRACT, CLAUSE_TYPE, CLAUSE, RISK, STANCE, REL, HIT, LEVEL, LOGIC, ATYPE, ATTR, ASSOCIATED, EVIDENCE, EXPLAIN, FIX = FIELDS
RULE_FIELDS = {RISK: "name", STANCE: "stance", LEVEL: "level", LOGIC: "logic"}
ATTRIBUTES = {"引用", "例外", "生效条件", "定义来源", "优先适用"}
FORMAT = "一、固定格式"
RULE = "二、规则原值"
JUDGMENT = "三、全文判断"
COVERAGE = "四、漏标、重复与版本同步"
HTML_DATA = re.compile(r"<script\b[^>]*\bid=['\"]review-data['\"][^>]*>(.*?)</script\s*>", re.I | re.S)
BLANK_LAYOUT = re.compile(r"[\r\n\t \u3000\u00a0]+")
TEMPLATE = Path(__file__).with_name("review.html")


def same_text(value):
    return str(value).replace("\r\n", "\n").replace("\r", "\n")


def layout_text(value):
    return BLANK_LAYOUT.sub("", value)


def value_of(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return same_text(value)
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict) and "text" in item:
                parts.append(str(item["text"]))
            elif isinstance(item, str):
                parts.append(item)
            else:
                raise ValueError("字段含无法原样保留的值，请先核对源记录")
        if all(isinstance(item, dict) for item in value):
            return same_text("".join(parts))
        if len(parts) <= 1:
            return same_text("".join(parts))
        return same_text("\n".join(parts))
    if isinstance(value, dict) and "text" in value:
        return same_text(value["text"])
    raise ValueError(f"字段值应为文字，收到 {type(value).__name__}")


def read_data(path):
    raw = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() in {".html", ".htm"}:
        candidates = HTML_DATA.findall(raw)
        if len(candidates) != 1:
            raise ValueError("HTML 缺少唯一的复核数据，请使用本包保存的页面")
        raw = candidates[0]
    return json.loads(raw)


def write_new(path, contents, binary=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    if binary:
        with path.open("xb") as file:
            file.write(contents)
    else:
        with path.open("x", encoding="utf-8", newline="\n") as file:
            file.write(contents)


def index_records(records, label):
    if not isinstance(records, list):
        raise ValueError(f"{label}须为数组")
    index = {}
    for record in records:
        key = record.get("id")
        if not isinstance(key, str) or not key or key in index:
            raise ValueError(f"{label}含空或重复的 ID")
        index[key] = record
    return index


def load_project(path):
    project = read_data(path)
    contracts = index_records(project.get("contracts"), "合同")
    rules = index_records(project.get("rules"), "规则")
    if not contracts or not rules:
        raise ValueError("生成复核页面需要合同原文及当前适用规则")
    for contract in contracts.values():
        sections = contract.get("sections")
        if not contract.get("name") or not sections:
            raise ValueError(f"合同 {contract['id']} 缺文件名或正文切片")
        for i, section in enumerate(sections, 1):
            if not isinstance(section.get("text"), str) or not section["text"].strip():
                raise ValueError(f"合同 {contract['id']} 切片 {i} 缺原文")
            section.setdefault("id", f"s{i}")
            section.setdefault("heading", section["text"].splitlines()[0])
        index_records(sections, f"合同 {contract['id']} 的切片")
    for rule in rules.values():
        if any(not isinstance(rule.get(k), str) or not rule[k].strip() for k in RULE_FIELDS.values()):
            raise ValueError(f"规则 {rule['id']} 缺规则表原值")
    if project.get("stage", "student") not in {"student", "lawyer", "final"}:
        raise ValueError("复核阶段无效")
    project.setdefault("stage", "student")
    return project, contracts, rules


def imported_rows(path):
    payload = read_data(path)
    if isinstance(payload, list):
        for i, row in enumerate(payload, 2):
            yield row.get("id") or row.get("record_id") or f"row-{i}", row.get("fields", row)
        return
    if isinstance(payload.get("rows"), list):
        for i, row in enumerate(payload["rows"], 2):
            yield row.get("id") or row.get("record_id") or f"row-{i}", row.get("fields", row)
        return
    data = payload.get("data", payload)
    header = data.get("fields", [])
    records = data.get("data")
    ids = data.get("record_id_list")
    if isinstance(records, list) and all(isinstance(row, list) for row in records):
        if not header or not (set(header) >= set(FIELDS)):
            raise ValueError("源多维表缺少标准标注字段，请核对来源与字段名")
        if data.get("has_more"):
            raise ValueError("导入文件仅含飞书第一页，请先取齐全部分页")
        for i, row in enumerate(records):
            yield ids[i] if ids else f"row-{i + 2}", dict(zip(header, row))
        return
    raise ValueError("标注 JSON 应为记录数组或已经合并全部分页的飞书记录响应")


def read_xlsx(path, require_annotation_sheet=False):
    """Read text and basic cells from the named workbook sheet."""
    from xml.etree import ElementTree as ET
    from posixpath import join, normpath
    main = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    doc_rel = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    rel = "{http://schemas.openxmlformats.org/package/2006/relationships}"
    with ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = workbook.findall(f".//{main}sheet")
        matches = [sheet for sheet in sheets if sheet.get("name") == "标注集"]
        if not matches and len(sheets) == 1 and not require_annotation_sheet:
            matches = sheets
        if len(matches) != 1:
            raise ValueError("请提供含「标注集」工作表的 Excel")
        target_id = matches[0].get(f"{doc_rel}id")
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = next(item.get("Target") for item in relationships.findall(f"{rel}Relationship") if item.get("Id") == target_id)
        sheet_path = target.lstrip("/") if target.startswith("/") else normpath(join("xl", target))
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared = [
                "".join(t.text or "" for t in item.iter(f"{main}t"))
                for item in ET.fromstring(archive.read("xl/sharedStrings.xml"))
            ]
        rows = ET.fromstring(archive.read(sheet_path)).findall(f".//{main}row")
    header = {}
    for row in rows:
        items = {}
        for cell in row.findall(f"{main}c"):
            letters = re.match(r"^[A-Z]+", cell.get("r", ""))
            if not letters:
                raise ValueError("工作表含无法定位的单元格")
            type_ = cell.get("t")
            text = cell.findtext(f"{main}v", "")
            if type_ == "s":
                text = shared[int(text)]
            elif type_ == "inlineStr":
                text = "".join(t.text or "" for t in cell.iter(f"{main}t"))
            if cell.find(f"{main}f") is not None or type_ == "e":
                raise ValueError(f"标注表 {cell.get('r')} 包含公式或错误，请提供原始文本值")
            items[letters[0]] = same_text(text)
        if not any(items.values()):
            continue
        if not header:
            header = items
            if not (set(header.values()) >= set(FIELDS)):
                raise ValueError("Excel 缺少标准标注字段")
            if any(list(header.values()).count(field) != 1 for field in FIELDS):
                raise ValueError("Excel 有重复的标注字段列")
        else:
            yield f"row-{row.get('r')}", {name: items.get(col, "") for col, name in header.items()}


def no_attention(fields):
    evidence = (fields or {}).get(EVIDENCE)
    return bool(fields and fields.get(REL) == "否" and fields.get(HIT) == "否"
                and isinstance(evidence, str) and evidence.strip())


def reviewable_untriggered(fields):
    return bool(fields and fields.get(HIT) == "否" and (fields.get(REL) == "是" or no_attention(fields)))


def attach_rows(project, contracts, rules, label_path):
    if project.get("rows"):
        raise ValueError("项目已有标注行，请使用空 rows 以导入已有标注")
    by_name = defaultdict(list)
    by_rule = defaultdict(list)
    for contract in contracts.values():
        by_name[contract["name"]].append(contract)
    for rule in rules.values():
        by_rule[(rule["name"], rule["stance"])].append(rule)
    values = read_xlsx(label_path) if label_path.suffix.lower() == ".xlsx" else imported_rows(label_path)
    project["rows"] = []
    for row_id, original in values:
        if not set(FIELDS) <= original.keys():
            raise ValueError(f"{row_id} 未包含全部标注字段；须保留空字段")
        fields = {field: value_of(original[field]) for field in FIELDS}
        c = by_name[fields[CONTRACT]]
        r = by_rule[(fields[RISK], fields[STANCE])]
        entry = {"id": row_id, "fields": fields, "contract_id": c[0]["id"] if len(c) == 1 else "",
                 "rule_id": r[0]["id"] if len(r) == 1 else ""}
        if not fields[CLAUSE].strip() and fields[REL] == "否":
            if fields[HIT] == "是" or no_attention(fields):
                entry["scope"] = "full_missing"
            elif not fields[EVIDENCE]:
                entry["scope"] = "unlinked"
        project["rows"].append(entry)
    return project


def validate(project, contracts, rules, final=False):
    rows = index_records(project.get("rows"), "标注行")
    if not rows:
        raise ValueError("没有标注记录")
    issues = []
    paths = {}
    for path in project.get("paths", []):
        key = (path.get("contract_id"), path.get("rule_id"), path.get("matter_id", ""))
        if key in paths or key[0] not in contracts or key[1] not in rules:
            raise ValueError("覆盖清单的合同或规则无效或重复")
        if path.get("mode") not in {"slice", "related", "full_missing"}:
            raise ValueError("覆盖清单的判断路径无效")
        paths[key] = path

    def add(row_id, group, message, blocking=True, *, field=None, contract_id=None, expected=None):
        issue = {"row_id": row_id, "check": group, "message": message, "blocking": blocking}
        for key, value in (("field", field), ("contract_id", contract_id), ("expected", expected)):
            if value is not None:
                issue[key] = value
        issues.append(issue)

    for c_id, expected_rules in project.get("applicability", {}).items():
        if c_id not in contracts or any(r_id not in rules for r_id in expected_rules):
            raise ValueError("适用规则清单引用了不存在的合同或规则")
        for r_id in expected_rules:
            if not any(key[:2] == (c_id, r_id) for key in paths):
                add(None, COVERAGE, f"合同 {contracts[c_id]['name']} 缺规则 {rules[r_id]['name']}／{rules[r_id]['stance']} 的覆盖判断", field="规则覆盖", contract_id=c_id)

    selected = {}
    full_texts = {}
    for key, contract in contracts.items():
        sections = contract["sections"]
        full_texts[key] = {same_text(item["text"]): item["id"] for item in sections}
        selected[key] = {item["id"]: same_text(item["text"]) for item in sections}

    row_groups = defaultdict(list)
    duplicates = defaultdict(set)
    split_judgments = {}
    for row_id, row in rows.items():
        fields = row.get("fields", {})
        if not isinstance(fields, dict):
            raise ValueError(f"{row_id} 的 fields 应为对象")
        if set(fields) != set(FIELDS):
            add(row_id, FORMAT, "标注字段应为模板中的 15 列，保留空字段")
        if any(not isinstance(fields.get(field, ""), str) for field in FIELDS):
            raise ValueError(f"{row_id} 的字段值须为文本，空字段用空字符串")
        f = {field: same_text(fields.get(field, "")) for field in FIELDS}
        c_id, r_id = row.get("contract_id"), row.get("rule_id")
        contract, rule = contracts.get(c_id), rules.get(r_id)
        if not contract or contract["name"] != f[CONTRACT]:
            add(row_id, FORMAT, "合同附件名称无法与实际使用的源文件唯一对应", field=CONTRACT, expected=contract and contract["name"])
        if not rule:
            add(row_id, RULE, "风险名称和立场无法对应正式规则，请核对后重新绑定", field=f"{RISK}／{STANCE}")
        else:
            for field, key in RULE_FIELDS.items():
                if f[field] != same_text(rule[key]):
                    add(row_id, RULE, f"「{field}」与正式规则原值不一致", field=field, expected=rule[key])
        for binary_field in (REL, HIT):
            if f[binary_field] not in {"是", "否"}:
                add(row_id, FORMAT, "判断字段只填「是」或「否」", field=binary_field)
        for name in (CLAUSE_TYPE, ATYPE):
            if re.match(r"^[A-Z]+\d+(?:\s|[.、：:]|$)", f[name]):
                add(row_id, FORMAT, f"「{name}」填写中文分类名称，去掉编号", field=name)
            if f[name] and project.get("clause_types") and f[name] not in project["clause_types"]:
                add(row_id, FORMAT, f"「{name}」不在项目提供的 V1 分类名称中", field=name)
        if f[ATTR] and f[ATTR] not in ATTRIBUTES:
            add(row_id, FORMAT, "关联条款属性填写五种关系之一的中文名称")
        if bool(f[ASSOCIATED]) != bool(f[ATYPE] or f[ATTR]) or (f[ASSOCIATED] and not (f[ATYPE] and f[ATTR])):
            add(row_id, FORMAT, "关联条款原文、类型和属性请一起核对", False)

        clause, evidence = f[CLAUSE], f[EVIDENCE]
        section_id = row.get("section_id") or full_texts.get(c_id, {}).get(clause)
        group = (c_id, r_id, row.get("matter_id", ""))
        scope = row.get("scope") or ("slice" if clause else "unlinked")
        if scope == "unlinked" and (paths.get(group, {}).get("mode") == "full_missing"
                                    or (not clause.strip() and f[REL] == "否" and (f[HIT] == "是" or no_attention(f)))):
            scope = "full_missing"
        if scope == "full_missing":
            if clause or (evidence.strip() and not no_attention(f)) or f[REL] != "否" or row.get("section_id"):
                add(row_id, FORMAT, "合同级记录相关性填否，主条款和切片定位留空。全文缺失风险的关键证据留空")
            if f[CLAUSE_TYPE]:
                add(row_id, FORMAT, "全文缺失独立记录没有主切片，条款类型留空")
        else:
            if not clause:
                add(row_id, JUDGMENT, "无主切片，需用规则及全文核对是否为独立全文缺失记录")
            elif contract and selected[c_id].get(section_id) != clause:
                add(row_id, COVERAGE, "条款原文无法与合同版本的完整一级切片精确对应", field=CLAUSE)
            if f[REL] == "是" and not evidence:
                add(row_id, JUDGMENT, "相关记录请检查主切片是否有支持判断的原文", f[HIT] == "是", field=EVIDENCE)
        if evidence and clause:
            collapsed = layout_text(clause)
            excerpts = [layout_text(part) for part in re.split(r"\n\s*\n", evidence) if part.strip()]
            if layout_text(evidence) not in collapsed and any(part not in collapsed for part in excerpts):
                add(row_id, FORMAT, "关键证据不能在本行主切片中定位，请核对摘录", field=EVIDENCE)
        if f[ASSOCIATED] and contract and not any(
            layout_text(f[ASSOCIATED]) == layout_text(text) for text in full_texts[c_id]
        ):
            add(row_id, COVERAGE, "关联条款原文无法匹配合同中完整一级切片，请核对版本和切片", False, field=ASSOCIATED)
        logical_row = (scope, section_id, f[ASSOCIATED])
        if contract and rule and logical_row in duplicates[group]:
            add(row_id, COVERAGE, "同一合同、规则和切片下有重复记录，请核对是否重复或关联条款拆行", field="重复标注")
        if contract and rule:
            duplicates[group].add(logical_row)
            if section_id or scope == "full_missing":
                slice_key = (*group, scope, section_id)
                original = split_judgments.setdefault(slice_key, (row_id, f[REL], f[HIT], f[EVIDENCE]))
                if original[1:] != (f[REL], f[HIT], f[EVIDENCE]):
                    add(row_id, COVERAGE, f"同一规则、事项和主切片的关联拆行与 {original[0]} 的相关性、风险结论或关键证据不一致")
        row_groups[group].append((row_id, scope, section_id))
        risk_card = row.get("review_required") is True or any(
            (snapshot or {}).get(HIT) == "是"
            for snapshot in (fields, row.get("original_fields"), row.get("submitted_fields"))
        )
        history = row.get("review_history", [])
        related_snapshots = [fields, row.get("original_fields"), row.get("submitted_fields"),
                             (row.get("student_view") or {}).get("fields"),
                             (row.get("lawyer_view") or {}).get("fields")]
        if isinstance(history, list):
            related_snapshots.extend(event.get("before") for event in history if isinstance(event, dict))
        was_reviewable_untriggered = any(isinstance(snapshot, dict) and reviewable_untriggered(snapshot)
                                         for snapshot in related_snapshots)
        if not isinstance(history, list):
            add(row_id, JUDGMENT, "复核操作记录应为列表")
        else:
            for event in history:
                if not isinstance(event, dict) or event.get("stage") not in {"student", "lawyer"}:
                    add(row_id, JUDGMENT, "复核操作记录缺少有效的操作人身份")
                    continue
                if event.get("action") == "remove":
                    before = event.get("before")
                    if not isinstance(event.get("reason"), str) or not event["reason"].strip():
                        add(row_id, JUDGMENT, "删去风险批注须保留操作原因")
                    if (not isinstance(before, dict) or not set(FIELDS) <= before.keys()
                            or (before.get(HIT) != "是" and (before.get(HIT) != "否"
                                or not (was_reviewable_untriggered or (scope == "full_missing" and risk_card))))):
                        add(row_id, JUDGMENT, "删去风险批注须保留删除前的标注字段和原风险结论")
        untriggered_review = project.get("review_related") is True and was_reviewable_untriggered
        if final and (risk_card or untriggered_review):
            for role, label in (("student", "同学"), ("lawyer", "律师")):
                if role == "student" and row.get("lawyer_review_only") is True:
                    continue
                if row.get(role, {}).get("reviewed") is not True:
                    add(row_id, JUDGMENT, f"缺少{label}复核确认")
        if final:
            lawyer_note = (row.get("lawyer") or {}).get("note")
            has_lawyer_opinion = isinstance(lawyer_note, str) and bool(lawyer_note.strip())
            student_snapshot = row.get("submitted_fields")
            if not has_lawyer_opinion:
                opinion_required = risk_card
                if project.get("review_related") is True:
                    opinion_required = any(
                        (snapshot or {}).get(HIT) == "是"
                        for snapshot in (fields, row.get("original_fields"), row.get("submitted_fields"),
                                         (row.get("student_view") or {}).get("fields"),
                                         (row.get("lawyer_view") or {}).get("fields"))
                    ) or any(isinstance(event, dict) and (event.get("before") or {}).get(HIT) == "是"
                             for event in (history if isinstance(history, list) else []))
                if opinion_required and project.get("lawyer_opinion_required") is True:
                    add(row_id, JUDGMENT, "缺少律师复核意见")
                elif student_snapshot and student_snapshot != fields:
                    add(row_id, JUDGMENT, "律师修改了同学提交的字段，需记录修改意见", False)

    for key, path in paths.items():
        actual = row_groups[key]
        expected_scope = "full_missing" if path["mode"] == "full_missing" else "slice"
        expected_sections = {None} if expected_scope == "full_missing" else set(
            selected[key[0]] if path["mode"] == "slice" else path.get("section_ids", [])
        )
        name = f"{contracts[key[0]]['name']} / {rules[key[1]]['name']} / {rules[key[1]]['stance']}"
        if expected_scope == "slice" and not expected_sections:
            raise ValueError(f"{name} 的相关切片清单为空")
        if expected_scope == "slice" and not expected_sections <= selected[key[0]].keys():
            raise ValueError(f"{name} 的覆盖清单含不存在的切片")
        actual_sections = {section for _, scope, section in actual if scope == expected_scope}
        for section in sorted(expected_sections - actual_sections, key=str):
            add(None, COVERAGE, f"按已核实的判断路径，缺少 {name} 的 {section or '全文缺失'} 记录", field="规则覆盖", contract_id=key[0])
        for row_id, scope, section in actual:
            if scope != expected_scope or section not in expected_sections:
                add(row_id, COVERAGE, "记录与核实后的判断路径不一致，请检查是否混用缺失和切片分支")
    if not paths:
        add(None, COVERAGE, "未提供逐合同、逐规则覆盖清单，漏标需对照合同和规则另查", False)
    if final:
        questions = project.get("review_questions", [])
        if not isinstance(questions, list) or any(not isinstance(item, dict) for item in questions):
            add(None, JUDGMENT, "实习生问题记录格式无效")
        else:
            for question in questions:
                response = question.get("response")
                if question.get("reviewed") is not True or not isinstance(response, str) or not response.strip():
                    add(question.get("row_id"), JUDGMENT, "存在未审核的实习生问题")
    if final and project["stage"] != "final":
        add(None, JUDGMENT, "请使用律师保存的最终复核 HTML")
    return issues


def validation_report(project, issues):
    report = {
        "rows": len(project["rows"]),
        "counts": dict(Counter(issue["check"] for issue in issues)),
        "blocking": sum(issue["blocking"] for issue in issues),
        "issues": issues,
        "note": "自动检查能核对格式、原值、结构、证据定位及已提供的覆盖清单。相关性、触发、排除和证据能否支撑判断须结合全文复核。",
    }
    return json.dumps(report, ensure_ascii=False, indent=2)


def build_review(project, contracts, rules, output):
    for row in project["rows"]:
        row.setdefault("original_fields", row.get("fields", {}).copy())
    project["fields"] = list(FIELDS)
    project["checks"] = list(project.get("semantic_checks", [])) + validate(project, contracts, rules)
    project.setdefault("snapshot_id", sha256(json.dumps(project, ensure_ascii=False).encode()).hexdigest()[:20])
    template = TEMPLATE.read_text(encoding="utf-8-sig")
    slot = ">__REVIEW_DATA__</script>"
    if template.count(slot) != 1:
        raise ValueError("复核模板缺少唯一的数据位置")
    payload = json.dumps(project, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    write_new(output, template.replace(slot, f">{payload}</script>"))



def count_positives(project, contracts, rules):
    by_rule = defaultdict(set)
    for row in project["rows"]:
        fields = row["fields"]
        c_id, r_id = row.get("contract_id"), row.get("rule_id")
        contract, rule = contracts.get(c_id), rules.get(r_id)
        if contract and rule and fields[HIT] == "是":
            by_rule[r_id].add(c_id)
    return [
        {"rule_id": rule_id, "risk_name": rule["name"], "stance": rule["stance"],
         "contracts": [contracts[c_id]["name"] for c_id in sorted(by_rule[rule_id])],
         "positive_contracts": len(by_rule[rule_id]), "short_of_six": max(0, 6 - len(by_rule[rule_id]))}
        for rule_id, rule in rules.items()
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="结构化原文、规则和标注生成复核 HTML")
    build.add_argument("project", type=Path)
    build.add_argument("--labels", type=Path, help="已做好的标注 JSON 或 XLSX，用于替代项目里的空 rows")
    build.add_argument("--out", required=True, type=Path)
    check = sub.add_parser("check", help="自动检查项目 JSON 或已保存的复核 HTML")
    check.add_argument("project", type=Path)
    check.add_argument("--out", type=Path)
    stats = sub.add_parser("positives", help="按规则和立场汇总不同合同的有风险记录")
    stats.add_argument("project", type=Path)
    stats.add_argument("--out", type=Path)
    export = sub.add_parser("export", help="从律师最终确认的 HTML 导出标准 Excel")
    export.add_argument("project", type=Path)
    export.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    project, contracts, rules = load_project(args.project)
    if args.command == "build":
        if args.labels:
            attach_rows(project, contracts, rules, args.labels)
        build_review(project, contracts, rules, args.out)
        print(f"复核页含 {len(project['rows'])} 条记录，{len(project['checks'])} 条检查提示")
    elif args.command == "positives":
        issues = validate(project, contracts, rules)
        if any(issue["blocking"] for issue in issues):
            raise ValueError("请先修正标注结构和原值，再统计正例")
        report = json.dumps(count_positives(project, contracts, rules), ensure_ascii=False, indent=2)
        if args.out:
            write_new(args.out, report)
        else:
            print(report)
    elif args.command == "check":
        report = validation_report(project, validate(project, contracts, rules))
        if args.out:
            write_new(args.out, report)
        else:
            print(report)
    else:
        issues = validate(project, contracts, rules, final=True)
        if any(issue["blocking"] for issue in issues):
            print(validation_report(project, issues))
            raise ValueError("还有会影响正式导出的检查项")
        rows = [[row["fields"][field] for field in FIELDS] for row in project["rows"]]
        args.out.parent.mkdir(parents=True, exist_ok=True)
        xlsx(args.out, list(FIELDS), rows)
        print(f"已导出标注集 {len(rows)} 行 × {len(FIELDS)} 列。")



def xlsx(path, headers, rows):
    """Inline strings prevent formula execution, even when input starts with '='."""
    def column(n):
        s = ''
        while n:
            n, r = divmod(n - 1, 26)
            s = chr(65 + r) + s
        return s
    def clean(v):
        s = str(v)
        if len(s.encode('utf-16-le')) // 2 > 32767:
            raise ValueError('单元格超过 Excel 字数限制，请拆分字段后导出；未截断内容')
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", s):
            raise ValueError("单元格包含 Excel 不支持的控制字符，请定位源字段")
        return escape(s)
    data = []
    for n, row in enumerate([headers] + rows, 1):
        cells = ''.join(f'<c r="{column(j)}{n}" t="inlineStr" s="{1 if n == 1 else 0}"><is><t xml:space="preserve">{clean(v)}</t></is></c>' for j, v in enumerate(row, 1))
        data.append(f'<row r="{n}">{cells}</row>')
    end = f'{column(len(headers))}{len(rows) + 1}'
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    files = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="标注集" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        'xl/styles.xml': f'<styleSheet xmlns="{ns}"><fonts count="2"><font><sz val="11"/><name val="等线"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="等线"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173D51"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{ns}"><dimension ref="A1:{end}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="{len(headers)}" width="28" customWidth="1"/></cols><sheetData>{"".join(data)}</sheetData><autoFilter ref="A1:{end}"/></worksheet>'
    }
    with ZipFile(path, 'x', ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + text)




if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError) as exc:
        sys.exit(str(exc))
