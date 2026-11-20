"""Write verified annotation rows to an explicitly selected Feishu Base table."""

from collections import Counter
import json
from pathlib import Path
import re
from subprocess import TimeoutExpired
from tempfile import NamedTemporaryFile, TemporaryDirectory
from time import sleep
from urllib.parse import urlencode, urlsplit, urlunsplit

import review
import sources


JUDGMENTS = {review.REL, review.HIT}
BATCH_SIZE = 50


def table_schema():
    return [{"name":field, "type":"select", "multiple":False,
             "options":[{"name":"是"}, {"name":"否"}]} if field in JUDGMENTS
            else {"name":field, "type":"text"} for field in review.FIELDS]


def check_schema(base, table):
    fields = sources.run_cli("base", "+field-list", "--base-token", base,
                             "--table-id", table, "--format", "json")["fields"]
    by_name = {field["name"]:field for field in fields}
    if len(fields) != len(review.FIELDS) or set(by_name) != set(review.FIELDS):
        raise ValueError("目标数据表须有标准 15 列。请检查字段名称或在指定 Base 新建数据表。")
    for name, field in by_name.items():
        if name in JUDGMENTS:
            correct = (field["type"] == "select" and field.get("multiple") is False
                       and sorted(option["name"] for option in field.get("options", [])) == ["否", "是"])
        else:
            correct = field["type"] == "text" and field.get("style", {}).get("type", "plain") == "plain"
        if not correct:
            raise ValueError(f"飞书字段「{name}」的类型或单选选项与标准不符。")


def count_values(rows):
    return Counter(tuple(review.value_of(row.get(field)) for field in review.FIELDS) for row in rows)


def read_values(base, table):
    return count_values(sources.read_base_records(base, table, fields=review.FIELDS)["rows"])


def deliver(args, rows, package_id):
    if args.out.exists():
        raise ValueError("飞书回执已存在，请另选输出路径。")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    expected = count_values(row["fields"] for row in rows)
    if not sources.is_feishu_url(args.target):
        raise ValueError("请提供用户确认的飞书 Base 或具体数据表链接。")
    resolved = sources.run_cli("base", "+url-resolve", "--url", args.target, "--format", "json")
    if resolved.get("resource_type") != "bitable":
        raise ValueError("发布目标须为飞书多维表格。")
    base, table = resolved["base_token"], resolved.get("table_id")
    if args.new_table:
        if not args.new_table.strip() or table or resolved.get("block_type") not in (None, "", "base"):
            raise ValueError("在 Base 内新建数据表时，请提供 Base 首页链接和有效表名。")
    elif not isinstance(table, str) or not re.fullmatch(r"tbl[A-Za-z0-9]+", table):
        raise ValueError("请提供具体数据表链接，或指定在 Base 中创建的新表名。")
    if base == sources.BASE and table in {spec[0] for spec in sources.TABLES.values()}:
        raise ValueError("该表是项目取件来源，请指定交付位置。")

    address = urlsplit(args.target)
    receipt = {"status":"preview", "package_id":package_id, "rows":len(rows), "columns":len(review.FIELDS),
               "excel":str(args.excel.resolve()), "target":args.target, "base_token":base,
               "table_id":table, "new_table":args.new_table, "accepted_rows":0}
    if args.confirm:
        review.write_new(args.out, json.dumps({**receipt, "status":"in_progress"}, ensure_ascii=False) + "\n")
    result = 0
    try:
        if args.new_table:
            existing = sources.run_cli("base", "+table-list", "--base-token", base, "--format", "json")["tables"]
            if any(item["name"] == args.new_table for item in existing):
                raise ValueError("目标 Base 已有同名表，请核对该表并提供具体链接，或指定其他表名。")
            if args.confirm:
                created = sources.run_cli("base", "+table-create", "--base-token", base, "--name", args.new_table,
                                          "--fields", json.dumps(table_schema(), ensure_ascii=False), "--format", "json")
                table = created.get("table_id") or (created.get("table") or {}).get("id") or created.get("id")
                if not table:
                    raise ValueError("飞书已响应创建请求，但未返回表 ID。请检查目标 Base，避免重复建表。")
                receipt["table_id"] = table
        if table:
            receipt["url"] = urlunsplit(("https", address.hostname, "/base/" + base,
                                         urlencode({"table":table}), ""))
            check_schema(base, table)
            current = read_values(base, table)
            if current and current != expected:
                raise ValueError("目标表已有不同数据，可能包含此前部分写入。请核对表内记录或选择空表。")
            if args.confirm and current == expected:
                receipt.update(status="already_delivered", verified_rows=len(rows))
            elif args.confirm:
                with TemporaryDirectory() as directory:
                    payload = Path(directory) / "records.json"
                    for start in range(0, len(rows), BATCH_SIZE):
                        batch = [{field:([value] if field in JUDGMENTS else value)
                                  for field in review.FIELDS if (value := review.same_text(row["fields"][field]))}
                                 for row in rows[start:start+BATCH_SIZE]]
                        payload.write_text(json.dumps({"create_records":batch}, ensure_ascii=False), encoding="utf-8")
                        response = sources.run_cli("base", "+record-batch-create", "--base-token", base,
                                                   "--table-id", table, "--json", "@records.json", "--format", "json",
                                                   cwd=directory)
                        if len(set(response.get("record_id_list", []))) != len(batch):
                            raise ValueError("飞书返回的新增记录数与本批不一致，已暂停后续写入。")
                        receipt["accepted_rows"] += len(batch)
                for attempt in range(3):
                    if attempt:
                        sleep(2)
                    current = read_values(base, table)
                    if current == expected:
                        break
                if current != expected:
                    receipt.update(missing_rows=sum((expected-current).values()),
                                   unexpected_rows=sum((current-expected).values()))
                    raise ValueError("飞书数据逐行回读与终版不一致，请先核对回执和目标表。")
                receipt.update(status="delivered", verified_rows=len(rows))
    except (ValueError, OSError, KeyError, TypeError, TimeoutExpired) as error:
        receipt.update(status="needs_check", reason=str(error))
        result = 1
    contents = json.dumps(receipt, ensure_ascii=False, indent=2) + "\n"
    if args.confirm:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=args.out.parent, delete=False) as completed:
            completed.write(contents)
        Path(completed.name).replace(args.out)
    else:
        review.write_new(args.out, contents)
    print(f"{receipt['status']} · {args.out}")
    return result
