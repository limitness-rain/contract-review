"""Read current Feishu sources and extract contract or expert rule text."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile


BASE = "DmmdbrlrbaRqs4syevVcvceznJd"
TABLES = {
    "plan": ("tblO9tMBTd4Jti0X", "合同类型",
             ("fldK3IVsJ1", "fldi1R4cLw", "fldvTSjN8y", "fldLLPviqj", "fldcqinlhb")),
    "tasks": ("tbl3SUXHI7f4ulf6", "二级合同类型", ("fldzD5IVzN", "fldHgnoXav", "fldkLEDxJs")),
    "samples": ("tblPMWDg3TUQMoPN", "二级合同类型", ("fldt5JNfcg", "fldz6JzTly", "fldYiu9Mry")),
}
BASE_URL = f"https://zhishuqifei.feishu.cn/base/{BASE}"
FEISHU_DOMAINS = ("feishu.cn", "larksuite.com", "larkoffice.com")
RULE_SLOTS = ("整理好的规则", "另一方立场规则")
ORIGINAL_FIELD = "合同样本（最低数量10）"
EVALUATION_FIELD = "用于评测的合同"


def save_json(path, data):
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(path)


def read_json(path):
    return Path(path).read_text(encoding="utf-8-sig")


def cli_path():
    if os.name == "nt":
        direct = shutil.which("lark-cli.exe")
        if direct:
            return direct
        # npm's Windows shim invokes this binary. Use it directly so URL ampersands
        # remain ordinary argv characters and never pass through cmd.exe.
        shim = shutil.which("lark-cli.cmd")
        if shim:
            binary = Path(shim).parent / "node_modules" / "@larksuite" / "cli" / "bin" / "lark-cli.exe"
            if binary.is_file():
                return str(binary)
    else:
        direct = shutil.which("lark-cli")
        if direct:
            return direct
    raise ValueError("找不到已安装的飞书 lark-cli。可用原有飞书连接器读取，或下载同版本材料后继续。")


def run_cli(*args, cwd=None, is_manifest=False):
    result = subprocess.run(
        [cli_path(), *args, "--as", "user"], cwd=cwd, capture_output=True,
        encoding="utf-8", errors="replace", timeout=180, check=False,
    )
    try:
        envelope = json.loads(result.stdout if result.returncode == 0 else result.stderr)
    except json.JSONDecodeError as exc:
        raise ValueError("飞书命令未返回可读取的 JSON，请检查登录和当前文件访问权限。") from exc
    if result.returncode:
        error = envelope.get("error", {})
        details = [error.get("message") or "飞书操作失败，请核对链接和访问权限。"]
        if error.get("missing_scopes"):
            details.append("缺少用户授权："+ "、".join(error["missing_scopes"]))
        if error.get("hint"):
            details.append(error["hint"])
        raise ValueError(" ".join(details))
    if is_manifest and envelope.get("format") == "ndjson":
        return envelope
    if envelope.get("ok"):
        return envelope["data"]
    raise ValueError("飞书返回格式异常。")


def unpack_records(page):
    fields, records = page["fields"], page["data"]
    if any(len(fields) != len(row) for row in records) or len(records) != len(page["record_id_list"]):
        raise ValueError("飞书返回的列和记录数不匹配，无法继续导入。")
    return [{"record_id": rid, **dict(zip(fields, row))}
            for rid, row in zip(page["record_id_list"], records)]


def list_arguments(base_token, table_id):
    return ("base", "+record-list", "--base-token", base_token, "--table-id", table_id)


def class_record(kind, contract_type, fields=None):
    table_id, key, field_ids = TABLES[kind]
    return matching_record(table_id, key, contract_type, fields or field_ids)


def matching_record(table_id, key, contract_type, fields):
    projection = [arg for field_id in fields for arg in ("--field-id", field_id)]
    matches, seen, offset = [], set(), 0
    while True:
        page = run_cli(*list_arguments(BASE, table_id), "--format", "json", "--limit", "200",
                       "--offset", str(offset), *projection)
        rows = unpack_records(page)
        ids = {row["record_id"] for row in rows}
        if len(ids) != len(rows) or ids & seen:
            raise ValueError(f"项目来源表 {table_id} 在读分页时返回重复记录，请重试。")
        seen.update(ids)
        matches.extend(row for row in rows if select_text(row[key]) == contract_type)
        if not page["has_more"]:
            break
        next_offset = page.get("next_offset", offset + len(rows))
        if not isinstance(next_offset, int) or next_offset <= offset:
            raise ValueError(f"项目来源表 {table_id} 缺少后续页定位。")
        offset = next_offset
    if len(matches) > 1:
        raise ValueError(f"“{contract_type}”在 {key} 中有多条记录，请先确定对应记录。")
    return matches[0] if matches else {}


def select_text(value):
    return value[0] if isinstance(value, list) and len(value) == 1 else value


def cell_links(cell):
    if isinstance(cell, list):
        return list(dict.fromkeys(url for item in cell for url in cell_links(item)))
    if isinstance(cell, dict):
        explicit = [url for key in ("url", "link", "href") for url in cell_links(cell.get(key))]
        return list(dict.fromkeys(explicit)) if explicit else cell_links(cell.get("text"))
    if not isinstance(cell, str):
        return []
    return list(dict.fromkeys(url.rstrip(".,;!。；，！）】")
                              for url in re.findall(r"""https?://[^\s<>()\[\]{}"'，。；]+""", cell)))


def task_rule_links(record):
    primary, other = RULE_SLOTS
    return {primary: cell_links(record.get(primary)),
            other: cell_links(record.get(other) or record.get("另一立场规则"))}


def plan_rule_links(plan):
    links = {slot: cell_links(plan.get(slot)) for slot in RULE_SLOTS}
    unresolved = [slot for slot, urls in links.items() if not urls]
    if not unresolved:
        return links, {}
    plan_table, plan_key, _ = TABLES["plan"]
    fields = run_cli("base", "+field-list", "--base-token", BASE, "--table-id", plan_table)["fields"]
    definitions = {field["name"]: field for field in fields}
    lookups = {}
    for slot in unresolved:
        field = definitions.get(slot, {})
        if field.get("type") != "lookup":
            continue
        conditions = field.get("where", {}).get("conditions", [])
        if (len(conditions) != 1 or len(conditions[0]) != 3
                or conditions[0][1:] != ["==", {"field": plan_key, "type": "field_ref"}]
                or field.get("aggregate") != "raw_value" or not field.get("from") or not field.get("select")):
            raise ValueError(f"计划表 v07 的「{slot}」查找引用无法按合同类型唯一追溯，请核对字段定义。")
        lookups[slot] = (field["from"], conditions[0][0], field["select"])
    if not lookups:
        return links, {}
    tables = run_cli("base", "+table-list", "--base-token", BASE)["tables"]
    groups = {}
    for slot, (source, key, column) in lookups.items():
        ids = {table["id"] for table in tables if source in (table["id"], table["name"])}
        if len(ids) != 1:
            raise ValueError(f"计划表 v07 的「{slot}」查找来源表无法唯一定位：{source}")
        groups.setdefault((ids.pop(), key), {})[slot] = column
    traces = {}
    for (table_id, key), columns in groups.items():
        projection = tuple(dict.fromkeys([key, *columns.values()]))
        row = matching_record(table_id, key, select_text(plan[plan_key]), projection)
        if not row:
            raise ValueError(f"计划表 v07 的查找来源表 {table_id} 没有本合同类型的记录。")
        for slot, column in columns.items():
            links[slot] = cell_links(row.get(column))
            traces[slot] = {"table_id": table_id, "record_id": row["record_id"], "field": column}
    return links, traces


def resolve(contract_type, annotation_override=False):
    labels = {"plan":"计划表", "tasks":"任务管理表", "samples":"合同样本库"}

    def read_source(kind):
        try:
            return class_record(kind, contract_type)
        except subprocess.TimeoutExpired as exc:
            raise ValueError(f"读取「{labels[kind]}」超时，请重试。") from exc
        except (ValueError, OSError, KeyError, TypeError) as exc:
            raise ValueError(f"读取「{labels[kind]}」失败：{exc}") from exc

    with ThreadPoolExecutor(max_workers=2) as pool:
        plan, samples = pool.map(read_source, ("plan", "samples"))
    if not plan:
        raise ValueError(f"计划表里没有找到合同类型“{contract_type}”。请使用表里的完整名称。")
    annotations = cell_links(plan.get("标注和评测集"))
    tasks = read_source("tasks") if annotations or annotation_override else {}
    rules = task_rule_links(tasks)
    original = samples.get(ORIGINAL_FIELD) or samples.get("合同样本") or []
    evaluation = samples.get(EVALUATION_FIELD) or []
    state = select_text(plan.get("初标状态"))
    issues = [
        f"任务管理表的“{name}”没有可读取的链接。"
        for name, links in rules.items() if (annotations or annotation_override) and not links
    ]
    if not original and not evaluation:
        issues.append("样本库没有合同附件。")
    if annotations and not evaluation:
        issues.append("已有标注入口，但样本库未挂评测合同。先核实标注使用的实际版本。")
    if state == "已完成" and not annotations:
        issues.append("计划表显示初标已完成，未找到标注集链接。")
    return {
        "contract_type": contract_type,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "statuses": {"initial": state, "rule": select_text(plan.get("规则编写状态")),
                     "review": select_text(plan.get("复核状态"))},
        "annotation_urls": annotations,
        "annotation_cell": plan.get("标注和评测集"),
        "rule_urls": rules,
        "attachments": {"original": original, "evaluation": evaluation},
        "record_ids": {"plan": plan["record_id"], "tasks": tasks.get("record_id"),
                       "samples": samples.get("record_id")},
        "table_urls": {key: f"{BASE_URL}?table={spec[0]}" for key, spec in TABLES.items()},
        "issues": issues,
    }


def is_feishu_url(url):
    address = urlsplit(url)
    host = address.hostname or ""
    return address.scheme == "https" and any(
        host == domain or host.endswith("." + domain) for domain in FEISHU_DOMAINS
    )


def table_coordinates(url, extra_table_id):
    if not is_feishu_url(url):
        raise ValueError("请输入已授权的飞书 Base 或 Wiki 链接。")
    info = run_cli("base", "+url-resolve", "--url", url, "--format", "json")
    if info.get("resource_type") != "bitable":
        raise ValueError("这个链接不是多维表格。飞书文档或规则 HTML 请从原入口读取。")
    base_token = info["base_token"]
    table_id = extra_table_id or info.get("table_id")
    if not table_id:
        tables = run_cli("base", "+table-list", "--base-token", base_token, "--format", "json")["tables"]
        if len(tables) != 1:
            names = "、".join(f"{table['name']} ({table['id']})" for table in tables)
            raise ValueError(f"此 Base 有多个数据表，请给具体表链接或 --table-id。可用表：{names}")
        table_id = tables[0]["id"]
    view_id = info.get("view_id") if not extra_table_id or extra_table_id == info.get("table_id") else None
    if not re.fullmatch(r"tbl[A-Za-z0-9]+", table_id):
        raise ValueError("请提供真实的 tbl 开头的数据表 ID。")
    return base_token, table_id, view_id


def read_base_table(url, table_id=None, scratch_dir=None):
    base_token, table_id, view_id = table_coordinates(url, table_id)
    return read_base_records(base_token, table_id, view_id, scratch_dir, url=url)


def read_base_records(base_token, table_id, view_id=None, scratch_dir=None, *, url=None, fields=()):
    arguments = list(list_arguments(base_token, table_id))
    if view_id:
        arguments += ["--view-id", view_id]
    for field in fields:
        arguments += ["--field-id", field]
    rows, row_ids, offset, first = [], set(), 0, None
    with TemporaryDirectory(dir=scratch_dir) as temporary:
        while True:
            filename = f"records-{offset}.ndjson"
            manifest = run_cli(*arguments, "--format", "ndjson", "--limit", "2000",
                               "--offset", str(offset), "--output", filename,
                               cwd=temporary, is_manifest=True)
            if first is None:
                first = manifest
            elif (first.get("rev"), first.get("query_context")) != (
                    manifest.get("rev"), manifest.get("query_context")):
                raise ValueError("读取期间飞书表版本或筛选范围变化，请重新执行。")
            path = Path(temporary) / filename
            batch = [json.loads(line) for line in path.read_text(encoding="utf-8").split("\n") if line]
            batch_ids = {row["record_id"] for row in batch}
            if (len(batch) != manifest["records_count"] or len(batch_ids) != len(batch)
                    or batch_ids & row_ids):
                raise ValueError("表格读取存在缺行或重复记录，请重新执行。")
            rows.extend(batch)
            row_ids.update(batch_ids)
            if not manifest["has_more"]:
                break
            next_offset = manifest.get("next_offset")
            if not isinstance(next_offset, int) or next_offset <= offset:
                raise ValueError("飞书未提供可用的下一页定位，请重试。")
            offset = next_offset
    return {
        "source": {"url": url, "base_token": base_token, "table_id": table_id,
                   "view_id": view_id, "rev": first.get("rev"), "query_context": first.get("query_context")},
        "fields": [column for column in first["columns"] if column != "record_id"],
        "rows": rows,
    }


RULE_COLUMNS = {
    "name": ("Name", "风险名称", "规则名称"),
    "stance": ("立场方", "立场", "审查立场", "Stance"),
    "level": ("Level", "风险等级", "等级"),
    "logic": ("Logic", "审查逻辑"),
}


def rule_records(table):
    columns = {}
    for key, names in RULE_COLUMNS.items():
        columns[key] = next((name for name in names if name in table["fields"]), None)
    if not all(columns.values()):
        missing = "、".join("/".join(RULE_COLUMNS[key]) for key in columns if not columns[key])
        raise ValueError(f"规则表缺少可识别的列 {missing}。核对实际列名后按专家原文整理。")
    result = []
    for row in table["rows"]:
        fields = {key: select_text(row.get(column)) for key, column in columns.items()}
        if not any(fields.values()):
            continue
        for key, value in fields.items():
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"规则原表 {row['record_id']} 的“{columns[key]}”缺少完整单一值。")
        result.append({"id": row["record_id"], **fields})
    if not result:
        raise ValueError("规则表没有可用规则，请核对数据表和视图。")
    return {"source": table["source"], "rules": result}


def filename_for_attachment(name):
    basename = re.split(r"[\\/]", name)[-1]
    basename = re.sub(r'[<>:"|?*\x00-\x1f]', "_", basename).strip(" .")
    if not basename:
        raise ValueError("附件名称无法用于本地文件。")
    return basename


def download_attachment(item, target, record_id):
    filename = filename_for_attachment(item["name"])
    token = item["file_token"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]+", token):
        raise ValueError("附件 ID 不是可识别的飞书文件标识。")
    # Separate paths prevent duplicate or reserved filenames from replacing each other.
    folder = target / token
    folder.mkdir(parents=True, exist_ok=True)
    local_file = folder / ("合同" + Path(filename).suffix.lower())
    if not local_file.exists():
        with TemporaryDirectory(dir=folder) as temporary:
            run_cli("base", "+record-download-attachment", "--base-token", BASE,
                    "--table-id", TABLES["samples"][0], "--record-id", record_id,
                    "--file-token", token, "--output", local_file.name, "--format", "json",
                    cwd=temporary)
            downloaded = Path(temporary) / local_file.name
            if not downloaded.is_file():
                raise ValueError("飞书命令返回成功，但未收到附件文件。")
            content = read_attachment(downloaded, item.get("size"))
            downloaded.replace(local_file)
    else:
        content = read_attachment(local_file, item.get("size"))
    return {**item, "local_path":str(local_file), "sha256":hashlib.sha256(content).hexdigest()}


def read_attachment(path, expected_size):
    content = path.read_bytes()
    if not content:
        raise ValueError("附件是空文件，请重新上传有效文件。")
    if expected_size and expected_size != len(content):
        raise ValueError(f"附件长度不一致，预期 {expected_size} 字节，实际 {len(content)} 字节。")
    return content


def download(index_path, version, out_dir, requested=None):
    index = json.loads(read_json(index_path))
    record_id = index["record_ids"]["samples"]
    source = index["attachments"][version]
    if not isinstance(record_id, str) or not re.fullmatch(r"rec[A-Za-z0-9]+", record_id) or not source:
        raise ValueError(f"样本库的 {version} 附件为空，请核对资料。")
    tokens = set(requested or [])
    if tokens - {item.get("file_token") for item in source}:
        raise ValueError("指定的附件不在本版本的样本库记录中。")
    selected = [item for item in source if not tokens or item.get("file_token") in tokens]
    target = Path(out_dir).resolve() / version
    files, failures = [], []
    for position, item in enumerate(selected, 1):
        try:
            files.append(download_attachment(item, target, record_id))
        except (ValueError, OSError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
            name = item.get("name") or f"第 {position} 个附件"
            if isinstance(exc, subprocess.TimeoutExpired):
                reason = "下载超时，请重试。"
            elif isinstance(exc, (KeyError, TypeError)):
                reason = "飞书附件信息不完整，请检查样本库中的附件。"
            else:
                reason = str(exc)
            failures.append({"name":name, "reason":reason})
    manifest = {"source_record":record_id, "version":version, "files":files, "failures":failures}
    save_json(target / "下载清单.json", manifest)
    return manifest


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
HEADING = re.compile(r"^\s*(?:第[〇零一二三四五六七八九十百千两0-9０-９]+条|[〇零一二三四五六七八九十百千两]+[、．.])(?:\s*.+)?$")
SIGNATURE = re.compile(r"^\s*(?:"
                       r"签署页|[（(]以下无(?:合同)?正文[）)]?[。.]?|(?:以下无(?:合同)?正文|签署栏)[：:]?"
                       r"|(?:甲方|乙方|丙方|委托方|受托方|双方|授权代表|法定代表人)"
                       r"\s*[（(]?\s*(?:签字|签名|签章|盖章|签署)"
                       r"(?:处|栏)?\s*[）)]?(?:\s*[：:]\s*.*|\s*[_＿\u3000 \t]*))\s*$")
WORD_STYLES = {"heading1", "标题1", "heading 1", "1"}
NESTED_BLOCKS = {"sdt", "sdtContent", "customXml", "ins"}


def tagname(node):
    return node.tag.rsplit("}", 1)[-1]


def value(node, path):
    element = node.find(path)
    return element.get(W + "val", "") if element is not None else ""


def paragraph_text(paragraph):
    tokens = {"tab": "\t", "br": "\n", "cr": "\n", "noBreakHyphen": "\u2011"}
    parts = []

    def walk(node):
        tag = tagname(node)
        if tag in {"del", "delText", "instrText", "txbxContent"}:
            return
        if tag == "t":
            parts.append(node.text or "")
        elif tag in tokens:
            parts.append(tokens[tag])
        else:
            for child in node:
                walk(child)

    walk(paragraph)
    return "".join(parts)


def table_text(table):
    rows = []
    for row in table.findall(W + "tr"):
        cells = []
        for cell in row.findall(W + "tc"):
            cells.append("\u2028".join(doc_text(child) for child in blocks(cell)))
            span = value(cell, "./" + W + "tcPr/" + W + "gridSpan")
            if span.isdecimal():
                cells.extend([""] * min(max(int(span) - 1, 0), 100))
        rows.append("\t".join(cells))
    return "\n".join(rows)


def doc_text(node):
    return paragraph_text(node) if tagname(node) == "p" else table_text(node)


def blocks(container):
    for node in container:
        tag = tagname(node)
        if tag in {"p", "tbl"}:
            yield node
        elif tag in NESTED_BLOCKS:
            yield from blocks(node)



class WordNumbering:
    def __init__(self, definition):
        self.levels = {}
        self.counts = {}
        self.unsupported = False
        if definition is None:
            return
        abstracts = {node.get(W + "abstractNumId"): node for node in definition.findall(W + "abstractNum")}
        for instance in definition.findall(W + "num"):
            abstract = abstracts.get(value(instance, W + "abstractNumId"))
            if abstract is None:
                continue
            levels = {lvl.get(W + "ilvl", "0"): (lvl, None) for lvl in abstract.findall(W + "lvl")}
            for override in instance.findall(W + "lvlOverride"):
                key = override.get(W + "ilvl", "0")
                override_level = override.find(W + "lvl")
                if override_level is None:
                    override_level = levels.get(key, (None, None))[0]
                if override_level is not None:
                    levels[key] = (override_level, value(override, W + "startOverride"))
            self.levels[instance.get(W + "numId")] = levels

    @staticmethod
    def render(number, formatting):
        if formatting in {"decimal", "decimalHalfWidth"}:
            return str(number)
        if formatting in {"decimalFullWidth", "decimalFullWidth2"}:
            return str(number).translate(str.maketrans("0123456789", "０１２３４５６７８９"))
        if formatting == "decimalZero":
            return f"{number:02}"
        if formatting in {"chineseCounting", "chineseCountingThousand"} and 0 <= number < 10000:
            symbols = "零一二三四五六七八九"
            if number < 10:
                return symbols[number]
            parts = []
            zero = False
            for place, unit in ((1000, "千"), (100, "百"), (10, "十"), (1, "")):
                digit, number = divmod(number, place)
                if not digit:
                    zero = bool(parts)
                else:
                    if zero:
                        parts.append("零")
                    if digit != 1 or unit != "十" or parts:
                        parts.append(symbols[digit])
                    parts.append(unit)
                    zero = False
            return "".join(parts)
        raise ValueError("Unsupported Word numbering format")

    def label(self, num_props):
        if num_props is None:
            return "", False
        number_id = value(num_props, W + "numId")
        level = value(num_props, W + "ilvl") or "0"
        if not number_id or number_id == "0":
            return "", False
        levels = self.levels.get(number_id, {})
        if level not in levels:
            self.unsupported = True
            return "", False
        node = levels[level][0]
        template = value(node, W + "lvlText")
        kind = value(node, W + "numFmt")
        if kind == "bullet" or not template:
            return "", False

        def start(key):
            level_node, overridden = levels[key]
            return int(overridden or value(level_node, W + "start") or "1")

        active = self.counts.setdefault(number_id, {})
        active[level] = active.get(level, start(level) - 1) + 1
        for key in list(active):
            if int(key) <= int(level):
                continue
            restart = value(levels[key][0], W + "lvlRestart")
            if restart != "0" and int(level) < int(restart or key):
                del active[key]
        def number_at(key):
            return self.render(active.get(key, start(key)), value(levels[key][0], W + "numFmt"))

        try:
            label = re.sub(r"%([1-9])", lambda match: number_at(str(int(match[1]) - 1)), template)
        except (ValueError, KeyError):
            self.unsupported = True
            return "", level == "0"

        def_suffix = value(node, W + "suff") or "tab"
        return label + {"tab": "\t", "space": " ", "nothing": ""}.get(def_suffix, "\t"), level == "0"



def docx_contract(path, contract_id=None, name=None):
    path = Path(path)
    if path.suffix.lower() != ".docx":
        raise ValueError("此命令读取 .docx。旧版 .doc 请用 Word 或 LibreOffice 转存为 .docx 后校对，PDF 请另行提取。")
    raw = path.read_bytes()
    with ZipFile(path) as package:
        document = ET.fromstring(package.read("word/document.xml"))
        try:
            style_xml = ET.fromstring(package.read("word/styles.xml"))
        except KeyError:
            style_xml = None
        try:
            numbering_xml = ET.fromstring(package.read("word/numbering.xml"))
        except KeyError:
            numbering_xml = None
    heading_styles = set(WORD_STYLES)
    if style_xml is not None:
        for style in style_xml.findall(W + "style"):
            style_name = value(style, W + "name").casefold().strip()
            if style_name in WORD_STYLES:
                heading_styles.add(style.get(W + "styleId", "").casefold())
    body = document.find(W + "body")
    if body is None:
        raise ValueError("Word 文件没有可读取的正文。")

    full_blocks, sections, sections_ended = [], [], False
    numbering = WordNumbering(numbering_xml)
    for node in blocks(body):
        text = doc_text(node)
        is_table = tagname(node) == "tbl"
        if not text.strip() and not is_table:
            continue

        props = node.find(W + "pPr")
        style = value(props, W + "pStyle").casefold() if props is not None else ""
        level = value(props, W + "outlineLvl") if props is not None else ""
        num_props = props.find(W + "numPr") if props is not None else None
        prefix, number_heading = numbering.label(num_props)
        is_heading = not is_table and (
            number_heading or HEADING.match(text)
            or bool(full_blocks) and (style in heading_styles or level == "0")
        )
        full_blocks.append({"kind": "table" if is_table else "paragraph", "text": prefix + text})
        if sections_ended:
            continue
        if sections and not is_table and not is_heading and SIGNATURE.fullmatch(text):
            sections_ended = True
            continue
        text = prefix + text
        if is_heading:
            sections.append({"id": f"S{len(sections) + 1:03d}", "heading": text.strip(), "text": text})
        elif sections:
            sections[-1]["text"] += "\n" + text
    warnings = ["切片为候选。请比照 Word 检查一级边界、签署页、正文中完整表格及已有附件。"]
    if not sections:
        warnings.append("未识别出一级标题，使用 blocks 对照 Word 手工确定正文切片。")
    if numbering.unsupported:
        warnings.append("发现 Word 自动编号，部分序号不在文字节点中。请对照 Word 补核显示序号和层级。")
    return {"id": contract_id or path.stem, "name": name or path.name, "sections": sections,
            "blocks": full_blocks, "source_sha256": hashlib.sha256(raw).hexdigest(), "warnings": warnings}


class ExpertHTML(HTMLParser):
    """Read the static contract and rule blocks in the expert's dual-stance HTML."""

    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
                 "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.contracts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set(attrs.get("class", "").split())
        parent = self.stack[-1][1] if self.stack else {}
        frame = dict(parent)
        if tag == "section" and "contract" in classes:
            data = {"title": [], "roles": {}, "rules": []}
            self.contracts.append(data)
            frame["contract"] = data
        contract = frame.get("contract")
        if contract is not None:
            if tag == "header" and "contract-heading" in classes:
                frame["contract_heading"] = True
            if tag == "h2" and frame.get("contract_heading"):
                frame["text"] = contract["title"]
            if tag == "section" and "role-card" in classes and attrs.get("data-side") and attrs.get("data-role"):
                contract["roles"][attrs["data-side"]] = attrs["data-role"]
            if "role-rules" in classes:
                frame["side"] = attrs.get("data-side")
            if tag == "details" and "rule" in classes:
                rule = {"id": attrs.get("id"), "side": frame.get("side"), "level": attrs.get("data-level"),
                        "title": [], "paragraphs": []}
                frame["rule"] = rule
                contract["rules"].append(rule)
            rule = frame.get("rule")
            if rule:
                if "rule-title" in classes:
                    frame["text"] = rule["title"]
                if "rule-meta" in classes or "sources" in classes:
                    frame.pop("text", None)
                    frame["omit"] = True
                if "body" in classes:
                    frame["logic"] = True
                if tag in {"h4", "p"} and frame.get("logic") and not frame.get("omit"):
                    frame["text"] = []
                    rule["paragraphs"].append((tag, frame["text"]))
        if tag == "br" and frame.get("text") is not None:
            frame["text"].append("\n")
        if tag not in self.VOID_TAGS:
            self.stack.append((tag, frame))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if self.stack:
            frame = self.stack[-1][1]
            if "text" in frame:
                frame["text"].append(data)


def html_rules(path, contract_type):
    path = Path(path)
    parser = ExpertHTML()
    parser.feed(read_json(path))
    parser.close()
    groups = [group for group in parser.contracts if "".join(group["title"]).strip() == contract_type]
    if len(groups) != 1 or not groups[0]["rules"]:
        raise ValueError("此 HTML 未发现对应合同类型的完整双立场规则结构。请核对正式规则表或请专家提供完整导出。")
    group = groups[0]
    result = []
    ids = set()
    for rule in group["rules"]:
        name = "".join(rule["title"]).strip()
        stance = group["roles"].get(rule["side"])
        logic = ""
        prior = None
        for tag, contents in rule["paragraphs"]:
            part = "".join(contents).strip()
            if tag == "h4" and logic:
                logic += "\n\n"
            elif tag == "p" and prior == "p":
                logic += "\n"
            logic += part
            prior = tag
        if not all((rule["id"], name, stance, rule["level"], logic)) or rule["id"] in ids:
            raise ValueError(f"规则 HTML 有重复 ID 或不完整规则，无法可靠提取：{name or rule['id']}")
        ids.add(rule["id"])
        result.append({"id": rule["id"], "name": name, "stance": stance,
                       "level": rule["level"], "logic": logic})
    return {"source": {"file": str(path.resolve()), "type": contract_type,
                       "note": "静态解析。使用前确认是专家最新正式规则版本。"}, "rules": result}


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="command", required=True)
    resolve_command = actions.add_parser("resolve", help="查找一个合同类型的样本、标注和规则链接")
    resolve_command.add_argument("--type", required=True)
    download_command = actions.add_parser("download", help="从索引下载合同样本到指定本地文件夹")
    download_command.add_argument("index")
    download_command.add_argument("--versions", required=True, choices=("original", "evaluation"))
    download_command.add_argument("--file-token", action="append")
    docx_command = actions.add_parser("docx", help="抽取 Word 正文及候选一级切片")
    docx_command.add_argument("path")
    docx_command.add_argument("--id")
    docx_command.add_argument("--name", help="下载后保留合同原附件名称")
    table_command = actions.add_parser("table", help="按指定飞书数据表/视图完整读取数据")
    table_command.add_argument("url")
    table_command.add_argument("--table-id")
    table_command.add_argument("--role", choices=("annotation", "rule"), default="annotation")
    html_command = actions.add_parser("rules-html", help="读取袁律双立场 HTML 风格的静态规则")
    html_command.add_argument("path")
    html_command.add_argument("--type", required=True)
    for command in (resolve_command, download_command, docx_command, table_command, html_command):
        command.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        if args.command == "resolve":
            save_json(args.out, resolve(args.type.strip()))
        elif args.command == "download":
            result = download(args.index, args.versions, args.out, args.file_token)
            if result["failures"]:
                reasons = "\n".join(f"「{item['name']}」：{item['reason']}" for item in result["failures"])
                raise ValueError("附件取件失败。\n"+reasons)
        elif args.command == "docx":
            save_json(args.out, docx_contract(args.path, args.id, args.name))
        elif args.command == "table":
            work = Path(args.out).resolve().parent
            work.mkdir(parents=True, exist_ok=True)
            table = read_base_table(args.url, args.table_id, scratch_dir=work)
            save_json(args.out, rule_records(table) if args.role == "rule" else table)
        else:
            save_json(args.out, html_rules(args.path, args.type.strip()))
    except (KeyError, ValueError, OSError, subprocess.TimeoutExpired, ET.ParseError, BadZipFile) as exc:
        print(f"读取失败：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())




