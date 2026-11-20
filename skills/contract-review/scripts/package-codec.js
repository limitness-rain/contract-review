"use strict";

const packageFormat = "contract-review-package";
const packageVersion = 1;
const pairedPackageVersion = 2;
const packagePairs = project=>project.version_pairs ?? (project.version_pair ? [project.version_pair] : []);
const packageSourceFields = ["合同附件名称","立场"];
const packageBoundFields = [...packageSourceFields,"风险名称","风险等级","审查逻辑","条款原文"];
const packageRuleFields = ["风险名称","立场","风险等级","审查逻辑"];
const packageJudgmentLabels = {
  triggered:"标记为触发",clear:"标记为相关未触发",unrelated:"标记为不相关",missingClear:"标记为未触发"
};
const packageJudgmentActions = new Set(["remove","restore","add",...Object.values(packageJudgmentLabels)]);
const packageLimit = 200 * 1024 * 1024;
const packageMember = /^(?:manifest\.json|baseline\.json|activity\/[0-9a-f-]{36}\.json|sources\/\d+\.[a-z0-9]+)$/;
const packageStateKeys = ["stage","review_questions","lawyer_suggestions","lawyer_opinion_required","role_views","review_related"];
const packageRoles = ["student","lawyer"];
const packageStages = [...packageRoles,"final"];
const packageUuid = /^[0-9a-f-]{36}$/;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8",{fatal:true});
const packJSON = value=>utf8.encode(JSON.stringify(value));
const unpackJSON = bytes=>JSON.parse(fromUtf8.decode(bytes));
const samePackageValue = (left,right)=>JSON.stringify(left ?? null)===JSON.stringify(right ?? null);
const hexHash = async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("");
const requirePackage = (condition,message)=>{ if (!condition) throw new Error(message); };

function missingPackageRuleFields(rows) {
  const missing = new Map();
  for (const row of rows) {
    for (const field of packageRuleFields) {
      if (row.fields[field]?.trim()) continue;
      const issue = missing.get(field);
      if (issue) issue.count++;
      else missing.set(field,{field,count:1,first:row.id});
    }
  }
  return [...missing.values()];
}

function packageSourceRow(id) {
  const match = /^row-(\d+)(?:-表(\d+))?$/.exec(id || "");
  return match ? {number:match[1],workbook:match[2],index:Number(match[2] || 1)-1} : null;
}

function latestPackageJudgment(row,role) {
  return row.review_history?.findLast(entry=>entry && (!role || entry.stage===role) && packageJudgmentActions.has(entry.action));
}
function packageCurrentRemoval(row) {
  return row.fields["是否触发该风险"]==="否" && latestPackageJudgment(row)?.action==="remove";
}
function packageWorkbookSelection(project) {
  if (project.stage!=="final") return {rows:project.rows,removed:0};
  const paired = new Set(packagePairs(project).flatMap(pair=>pair.contracts));
  const rows = project.rows.filter(row=>!(paired.has(row.contract_id) &&
    row.lawyer?.reviewed===true && packageCurrentRemoval(row)));
  return {rows,removed:project.rows.length-rows.length};
}

const crcTable = Uint32Array.from({length:256},(_,index)=>{
  for (let i=0;i<8;i++) index = (index>>>1) ^ (index&1 ? 0xedb88320 : 0);
  return index;
});
function zipCRC(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc>>>8) ^ crcTable[(crc ^ byte)&255];
  return (crc ^ 0xffffffff)>>>0;
}
function zipView(length) {
  return new DataView(new ArrayBuffer(length));
}
function makeStoredZip(entries,type="application/zip") {
  const chunks = [], directory = [];
  let offset = 0, directorySize = 0;
  requirePackage(entries.size<=2000,"数据包文件数量超出上限。");
  for (const [name,bytes] of entries) {
    const path = utf8.encode(name);
    const crc = zipCRC(bytes);
    const local = zipView(30);
    const central = zipView(46);
    local.setUint32(0,0x04034b50,true);
    local.setUint16(4,20,true);
    local.setUint16(6,0x800,true);
    local.setUint16(12,33,true);
    local.setUint32(14,crc,true);
    local.setUint32(18,bytes.length,true);
    local.setUint32(22,bytes.length,true);
    local.setUint16(26,path.length,true);
    central.setUint32(0,0x02014b50,true);
    central.setUint16(4,20,true);
    central.setUint16(6,20,true);
    central.setUint16(8,0x800,true);
    central.setUint16(14,33,true);
    central.setUint32(16,crc,true);
    central.setUint32(20,bytes.length,true);
    central.setUint32(24,bytes.length,true);
    central.setUint16(28,path.length,true);
    central.setUint32(42,offset,true);
    chunks.push(local.buffer,path,bytes);
    directory.push(central.buffer,path);
    offset += 30+path.length+bytes.length;
    directorySize += 46+path.length;
  }
  requirePackage(offset+directorySize+22<=packageLimit,"文件超出 200 MiB 支持上限。");
  const end = zipView(22);
  end.setUint32(0,0x06054b50,true);
  end.setUint16(8,entries.size,true);
  end.setUint16(10,entries.size,true);
  end.setUint32(12,directorySize,true);
  end.setUint32(16,offset,true);
  return new Blob([...chunks,...directory,end.buffer],{type});
}
function readStoredZip(buffer) {
  const length = buffer.byteLength;
  requirePackage(length>=22 && length<=packageLimit,"ZIP 不完整或超出 200 MiB。");
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const u16 = at=>view.getUint16(at,true);
  const u32 = at=>view.getUint32(at,true);
  const end = length-22;
  requirePackage(u32(end)===0x06054b50 && u16(end+4)===0 && u16(end+6)===0 && u16(end+20)===0,"请选择工具生成的复核 ZIP。");
  const count = u16(end+10);
  const start = u32(end+16);
  requirePackage(count<=2000 && u16(end+8)===count && start+u32(end+12)===end,"ZIP 目录无效。");
  let at = start;
  const files = new Map();
  const ranges = [];
  for (let i=0;i<count;i++) {
    requirePackage(at+46<=end && u32(at)===0x02014b50,"ZIP 文件条目不完整。");
    const flags = u16(at+8), size = u32(at+24), crc = u32(at+16);
    requirePackage((flags===0 || flags===0x800) && u16(at+10)===0 && u32(at+20)===size && u16(at+34)===0,"ZIP 压缩方式不受支持，请使用本工具原样导出的 ZIP。");
    const nameLength = u16(at+28);
    const next = at+46+nameLength+u16(at+30)+u16(at+32);
    requirePackage(next<=end,"ZIP 文件名不完整。");
    const name = fromUtf8.decode(bytes.subarray(at+46,at+46+nameLength));
    requirePackage(packageMember.test(name) && !files.has(name),"ZIP 含未知路径或重复文件。");
    const local = u32(at+42);
    requirePackage(local+30<=start && u32(local)===0x04034b50 && u16(local+6)===flags && u16(local+8)===0
      && u32(local+14)===crc && u32(local+18)===size && u32(local+22)===size && u16(local+26)===nameLength,"ZIP 文件信息不一致。");
    const dataStart = local+30+nameLength+u16(local+28);
    requirePackage(dataStart+size<=start && fromUtf8.decode(bytes.subarray(local+30,local+30+nameLength))===name,"ZIP 文件内容不完整。");
    const content = bytes.subarray(dataStart,dataStart+size);
    requirePackage(zipCRC(content)===crc,"ZIP 文件损坏："+name);
    files.set(name,content);
    ranges.push([local,dataStart+size]);
    at = next;
  }
  requirePackage(at===end,"ZIP 文件目录有多余数据。");
  ranges.sort((a,b)=>a[0]-b[0]);
  requirePackage(ranges.every(([offset],i)=>offset===(i ? ranges[i-1][1] : 0)) && ranges.at(-1)?.[1]===start,"ZIP 文件区域重叠或含多余数据。");
  return files;
}

function replayPackage(baseline,events) {
  const project = structuredClone(baseline);
  requirePackage(packageStages.includes(project.stage) && Array.isArray(project.rows) && project.rows.length &&
    samePackageValue(project.fields,packageFieldNames) && Array.isArray(project.contracts) && project.contracts.length &&
    Array.isArray(project.rules),"数据包缺少有效的合同、规则或标注。");
  for (const contract of project.contracts) {
    requirePackage(typeof contract.id==="string" && typeof contract.name==="string" && Array.isArray(contract.sections) &&
      contract.sections.length && contract.sections.every(s=>typeof s.id==="string" && typeof s.text==="string"),"合同切片格式无效。");
  }
  const rows = new Map(project.rows.map(row=>[row.id,row]));
  requirePackage(rows.size===project.rows.length && project.rows.every(row=>typeof row.id==="string" && row.fields),"基线含重复或无效的标注 ID。");
  const ids = new Set();
  for (const [index,event] of events.entries()) {
    requirePackage(event.seq===index+1 && packageUuid.test(event.id) && !ids.has(event.id) && event.role===project.stage &&
      packageRoles.includes(event.role) && typeof event.actor==="string" && event.actor.trim() &&
      Array.isArray(event.rows) && Array.isArray(event.state),"操作编号、顺序或复核角色无效。");
    ids.add(event.id);
    for (const {id,before,after} of event.rows) {
      requirePackage(samePackageValue(rows.get(id),before) && after?.id===id && after.fields,"操作中的标注原值不匹配："+id);
      rows.set(id,structuredClone(after));
    }
    for (const {key,before,after} of event.state) {
      requirePackage(packageStateKeys.includes(key) && samePackageValue(project[key],before),"操作中的交接原值不匹配："+key);
      if (after==null) delete project[key];
      else project[key] = structuredClone(after);
    }
  }
  project.rows = [...rows.values()];
  requirePackage(new Set(project.contracts.map(contract=>contract.id)).size===project.contracts.length &&
    project.contracts.every(contract=>new Set(contract.sections.map(section=>section.id)).size===contract.sections.length
      && (contract.context_blocks == null || Array.isArray(contract.context_blocks))),"合同或切片存在重复 ID 或无效上下文。");
  requirePackage(project.rules.every(rule=>rule && ["id","name","stance","level","logic"].every(key=>typeof rule[key]==="string"))
    && new Set(project.rules.map(rule=>rule.id)).size===project.rules.length,"正式规则结构不完整或 ID 重复。");
  const isFieldMap = fields=>fields && typeof fields==="object" && !Array.isArray(fields)
    && Object.values(fields).every(value=>typeof value==="string");
  requirePackage(project.rows.every(row=>isFieldMap(row.fields) && ["original_fields","submitted_fields"].every(key=>row[key]==null || isFieldMap(row[key]))
    && packageRoles.every(role=>row[role+"_view"]==null || isFieldMap(row[role+"_view"].fields))),"标注字段或角色快照的结构无效。");
  for (const key of ["review_questions","lawyer_suggestions","paths","checks","risk_changes"]) {
    requirePackage(project[key]==null || Array.isArray(project[key]),"复核 JSON 的 "+key+" 应为数组。");
  }
  requirePackage([...(project.review_questions || []),...(project.lawyer_suggestions || [])].every(item=>item && typeof item.text==="string"),"问答或建议格式无效。");
  if (project.version_pairs!=null || project.version_pair) validatePackageVersionPair(baseline,project);
  delete project.shared_rows;
  return project;
}

function validatePackageVersionPair(baseline,project) {
  const pairs = packagePairs(baseline);
  requirePackage(Array.isArray(pairs) && pairs.length &&
    (!baseline.version_pair || (baseline.contracts.length===2 && !baseline.version_pairs)),
    "双版本合同的配对清单无效。");
  const contracts = new Map(baseline.contracts.map(contract=>[contract.id,contract]));
  const used = new Set();
  const initial = new Map(baseline.rows.map(row=>[row.id,row]));
  const current = new Map(project.rows.map(row=>[row.id,row]));
  for (const [index,pair] of pairs.entries()) {
    const ids = pair?.contracts;
    requirePackage(Array.isArray(ids) && ids.length===2 && ids[0]!==ids[1] &&
      ids.every(id=>contracts.has(id) && !used.has(id)),"双版本合同的配对清单无效。");
    ids.forEach(id=>used.add(id));
    const [left,right] = ids.map(id=>contracts.get(id));
    packagePairs(project)[index].shared = validatePackagePair(pair,left,right,initial,current);
  }
  for (const [id,before] of initial) {
    if (!used.has(before.contract_id)) continue;
    const row = current.get(id);
    requirePackage(row.contract_id===before.contract_id && packageSourceFields.every(field=>row.fields[field]===before.fields[field]),
      "双版本标注的来源文件或立场已改变："+id);
  }
}

function validatePackagePair(pair,left,right,initial,current) {
  requirePackage(
    Array.isArray(pair.sections) && Array.isArray(pair.shared),"双版本合同的配对清单无效。");
  const positions = [left,right].map(contract=>new Map(contract.sections.map((section,i)=>[section.id,i])));
  const sectionMap = new Map();
  let previous = [-1,-1];
  for (const ids of pair.sections) {
    requirePackage(Array.isArray(ids) && ids.length===2,"双版本切片配对无效。");
    const indices = positions.map((index,i)=>index.get(ids[i]));
    requirePackage(indices.every((index,i)=>index>previous[i]),"双版本切片配对有重复、无效引用或顺序交叉。");
    previous = indices;
    sectionMap.set(ids[0],ids[1]);
  }
  const seen = new Set();
  const shared = [];
  for (const ids of pair.shared) {
    requirePackage(Array.isArray(ids) && ids.length===2 && ids[0]!==ids[1] && ids.every(id=>!seen.has(id)),
      "共享标注配对有重复或无效引用。");
    const [a,b] = ids.map(id=>initial.get(id));
    requirePackage(a?.contract_id===left.id && b?.contract_id===right.id && a.scope==="slice" && b.scope==="slice" &&
      sectionMap.has(a.section_id) && sectionMap.get(a.section_id)===b.section_id &&
      left.sections[positions[0].get(a.section_id)].text===right.sections[positions[1].get(b.section_id)].text &&
      packageFieldNames.every(field=>packageSourceFields.includes(field) || field==="审查逻辑" || a.fields[field]===b.fields[field]),
      "共享标注与原始合同切片或初标字段不匹配。");
    ids.forEach(id=>seen.add(id));
    // Some earlier packages declared sharing despite different formal logic.
    // Retain both rows and their history, and apply the strict sharing rule on reopen.
    if (a.fields["审查逻辑"]!==b.fields["审查逻辑"]) continue;
    validateSharedReview([a,b],ids.map(id=>current.get(id)));
    shared.push(ids);
  }
  return shared;
}

function validateSharedReview(prior,updated) {
  const [x,y] = updated;
  requirePackage(x && y && packageFieldNames.every(field=>packageSourceFields.includes(field) || x.fields[field]===y.fields[field]) &&
    packageRoles.every(role=>samePackageValue(x[role],y[role])) &&
    packageCurrentRemoval(x)===packageCurrentRemoval(y) &&
    updated.every((row,i)=>["contract_id","rule_id","scope","section_id","matter_id"].every(key=>row[key]===prior[i][key]) &&
      packageBoundFields.every(field=>row.fields[field]===prior[i].fields[field])),"共享标注的复核结果或版本绑定不一致。");
}

async function loadReviewPackage(file) {
  requirePackage(file.size<=packageLimit,"数据包超出 200 MiB。");
  const contents = readStoredZip(await file.arrayBuffer());
  requirePackage(contents.has("manifest.json") && contents.has("baseline.json"),"缺少清单或基线文件。");
  const manifest = unpackJSON(contents.get("manifest.json"));
  requirePackage(manifest.format===packageFormat && [packageVersion,pairedPackageVersion].includes(manifest.version),"不支持的数据包格式或版本。");
  requirePackage(packageUuid.test(manifest.package_id) && typeof manifest.batch_id==="string" && Array.isArray(manifest.parents)
    && manifest.parents.every(value=>packageUuid.test(value)) && Number.isInteger(manifest.revision) && manifest.revision>=0
    && Number.isInteger(manifest.round) && manifest.round>=1 && Array.isArray(manifest.sources),"包编号、轮次或来源信息无效。");
  contents.delete("manifest.json");
  const checks = Object.entries(manifest.files);
  requirePackage(checks.length===contents.size && checks.every(([name])=>contents.has(name)),"ZIP 内容与清单不一致。");
  await Promise.all(checks.map(async ([name,hash])=>{
    requirePackage(await hexHash(contents.get(name))===hash,"文件校验失败："+name);
  }));
  requirePackage(manifest.files["baseline.json"]===manifest.baseline_sha256,"基线校验失败。");
  const events = [], sourceEntries = new Set();
  for (const source of manifest.sources) {
    requirePackage(source.entry?.startsWith("sources/") && !sourceEntries.has(source.entry) &&
      manifest.files[source.entry]===source.sha256 && typeof source.name==="string" && typeof source.purpose==="string","源文件清单无效。");
    sourceEntries.add(source.entry);
  }
  for (const [name,bytes] of contents) {
    if (name.startsWith("sources/")) requirePackage(sourceEntries.has(name),"源文件缺少用途说明。");
    if (name.startsWith("activity/")) {
      const actorId = name.slice(9,-5);
      const group = unpackJSON(bytes);
      requirePackage(Array.isArray(group) && group.every(event=>event.actor_id===actorId),"人员日志与文件名不一致。");
      events.push(...group);
    }
  }
  events.sort((a,b)=>a.seq-b.seq);
  const baseline = unpackJSON(contents.get("baseline.json"));
  requirePackage(!!(baseline.version_pair || baseline.version_pairs)===(manifest.version===pairedPackageVersion),"双版本配对清单与数据包版本不一致。");
  const project = replayPackage(baseline,events);
  requirePackage(project.stage===manifest.stage,"复核阶段与操作历史不一致。");
  return {manifest,contents,events,project,baseline};
}

async function exportReviewPackage(session,manifest,events) {
  const contents = new Map([...session.contents].filter(([name])=>!name.startsWith("activity/")));
  const actors = new Map();
  for (const event of events) {
    if (!actors.has(event.actor_id)) actors.set(event.actor_id,[]);
    actors.get(event.actor_id).push(event);
  }
  for (const [id,group] of actors) contents.set("activity/"+id+".json",packJSON(group));
  manifest.files = Object.fromEntries(await Promise.all([...contents].map(async ([name,bytes])=>[name,await hexHash(bytes)])));
  contents.set("manifest.json",packJSON(manifest));
  return makeStoredZip(contents);
}

function workbookForProject(project) {
  function xml(value) {
    requirePackage(typeof value==="string" && value.length<=32767 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(value),"Excel 字段长度或字符超出支持范围。");
    return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll("\r","&#13;");
  }
  const {rows,removed} = packageWorkbookSelection(project);
  const lines = [project.fields,...rows.map(row=>project.fields.map(field=>row.fields[field]))];
  const data = lines.map((values,index)=>{
    const row = index+1;
    const cells = values.map((value,i)=>'<c r="'+String.fromCharCode(65+i)+row+'" t="inlineStr" s="'+(index ? 0 : 1)+'"><is><t xml:space="preserve">'+xml(value)+'</t></is></c>').join("");
    return '<row r="'+row+'">'+cells+'</row>';
  }).join("");
  const name = "xl/worksheets/sheet1.xml";
  const entries = {...packageXlsxParts};
  entries[name] = entries[name].replace(/<sheetData>.*?<\/sheetData>/s,()=>"<sheetData>"+data+"</sheetData>").replaceAll("A1:O1","A1:O"+lines.length);
  const blob = makeStoredZip(new Map(Object.entries(entries).map(([entry,value])=>[entry,utf8.encode(value)])),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  return {blob,count:rows.length,removed};
}
