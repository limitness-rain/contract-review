"use strict";

// Office files use compressed ZIP entries. The review ZIP codec stays stored-only.
function openOfficeArchive(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const u16 = offset=>view.getUint16(offset,true);
  const u32 = offset=>view.getUint32(offset,true);
  let end = buffer.byteLength-22;
  const earliest = Math.max(0,end-65535);
  while (end>=earliest && (u32(end)!==0x06054b50 || end+22+u16(end+20)!==bytes.length)) end--;
  requirePackage(end>=earliest && !u16(end+4) && !u16(end+6) && u16(end+8)===u16(end+10),
    "无法读取 Office 文件。请检查文件是否损坏或带有密码。");
  const count = u16(end+10), directory = u32(end+16);
  requirePackage(count<=10000 && directory+u32(end+12)===end,"Office 文件目录无效。");
  const entries = new Map();
  let pos = directory, totalRead = 0;
  for (let i=0;i<count;i++) {
    requirePackage(pos+46<=end && u32(pos)===0x02014b50,"Office 文件目录无效。");
    const nameEnd = pos+46+u16(pos+28);
    const next = nameEnd+u16(pos+30)+u16(pos+32);
    requirePackage(next<=end,"Office 文件目录无效。");
    const path = fromUtf8.decode(bytes.subarray(pos+46,nameEnd));
    requirePackage(!entries.has(path),"Office 文件包含重复的内部部件。");
    entries.set(path,{flags:u16(pos+8),method:u16(pos+10),crc:u32(pos+16),
      packed:u32(pos+20),size:u32(pos+24),local:u32(pos+42)});
    pos = next;
  }
  requirePackage(pos===end,"Office 文件目录长度无效。");
  return {
    has:path=>entries.has(path),
    async xml(path) {
      const item = entries.get(path);
      requirePackage(item && !(item.flags&1) && [0,8].includes(item.method),"缺少或无法读取内部部件 "+path+"。");
      requirePackage(item.size<=64*1024*1024 && totalRead+item.size<=packageLimit,"Office 文档正文或工作表过大。");
      totalRead += item.size;
      const local = item.local;
      requirePackage(local+30<=directory && u32(local)===0x04034b50 && u16(local+8)===item.method,
        "Office 文件部件无效。");
      const start = local+30+u16(local+26)+u16(local+28);
      requirePackage(start+item.packed<=directory,"Office 文件部件长度无效。");
      let data = bytes.subarray(start,start+item.packed);
      if (item.method===8) {
        let inflate;
        try {
          inflate = new DecompressionStream("deflate-raw");
        } catch {
          throw new Error("当前浏览器无法解压 Office 文件，请使用新版 Chrome 或 Edge。");
        }
        const reader = new Blob([data]).stream().pipeThrough(inflate).getReader();
        data = new Uint8Array(item.size);
        let offset = 0;
        while (true) {
          const {value,done} = await reader.read();
          if (done) break;
          if (offset+value.length>data.length) {
            await reader.cancel();
            throw new Error("Office 文件部件解压长度无效。");
          }
          data.set(value,offset);
          offset += value.length;
        }
        requirePackage(offset===item.size,"Office 文件部件解压长度无效。");
      }
      requirePackage(data.length===item.size && zipCRC(data)===item.crc,"Office 文件部件校验失败。");
      const xml = fromUtf8.decode(data);
      requirePackage(!/<!DOCTYPE/i.test(xml),"Office 文档含不受支持的 XML 定义。");
      const doc = new DOMParser().parseFromString(xml,"application/xml");
      requirePackage(!doc.getElementsByTagNameNS("*","parsererror").length,"Office 文件 XML 无法读取。");
      return doc.documentElement;
    }
  };
}

const officeChildren = (element,tag)=>Array.from(element?.children || []).filter(child=>child.localName===tag);
const officeChild = (element,tag)=>officeChildren(element,tag)[0];
const officeText = (element,tag)=>Array.from(element?.getElementsByTagNameNS("*",tag) || [],part=>part.textContent).join("");
const officeLF = value=>value.replace(/\r\n?/g,"\n");
const officeCompact = value=>value.replace(/[\s\u2028]+/gu,"");
const intakeFileName = value=>value.normalize("NFC");

const wordAttr = (element,key)=>element?.getAttributeNS(element.namespaceURI,key);
const wordValue = (element,tag)=>wordAttr(officeChild(element,tag),"val");

function wordNumberText(number,format) {
  if (format==="decimalZero") return String(number).padStart(2,"0");
  if (format==="decimalFullWidth" || format==="decimalFullWidth2") {
    return String(number).replace(/[0-9]/g,digit=>"０１２３４５６７８９"[Number(digit)]);
  }
  if (["chineseCounting","chineseCountingThousand"].includes(format) &&
      Number.isInteger(number) && number>=0 && number<10000) {
    const digits = "零一二三四五六七八九";
    if (number<10) return digits[number];
    let text = "", zero = false;
    for (const [place,unit] of [[1000,"千"],[100,"百"],[10,"十"],[1,""]]) {
      const digit = Math.floor(number/place)%10;
      if (!digit) { zero = Boolean(text); continue; }
      if (zero) text += digits[0];
      if (digit!==1 || place!==10 || text) text += digits[digit];
      text += unit;
      zero = false;
    }
    return text;
  }
  if (format==="lowerLetter" || format==="upperLetter") {
    const letter = String.fromCharCode((format==="lowerLetter"?97:65)+(number-1)%26);
    if (number>0 && number<=2600) return letter.repeat(Math.ceil(number/26));
  }
  if (format==="decimal" || format==="decimalHalfWidth" || !format) return String(number);
  return "";
}
function wordNumbering(definition) {
  const abstracts = new Map(officeChildren(definition,"abstractNum").map(element=>[wordAttr(element,"abstractNumId"),element]));
  const lists = new Map();
  for (const num of officeChildren(definition,"num")) {
    const abstract = abstracts.get(wordValue(num,"abstractNumId"));
    const levels = new Map(officeChildren(abstract,"lvl").map(level=>[Number(wordAttr(level,"ilvl")),{level}]));
    for (const override of officeChildren(num,"lvlOverride")) {
      const index = Number(wordAttr(override,"ilvl"));
      const level = officeChild(override,"lvl") || levels.get(index)?.level;
      if (level) levels.set(index,{level,start:wordValue(override,"startOverride")});
    }
    lists.set(wordAttr(num,"numId"),{levels,active:new Map()});
  }
  return paragraph=>{
    const props = officeChild(officeChild(paragraph,"pPr"),"numPr");
    const list = lists.get(wordValue(props,"numId"));
    const index = Number(wordValue(props,"ilvl") || 0);
    const entry = list?.levels.get(index);
    if (!entry) return "";
    const {levels,active} = list;
    const start = number=>Number(levels.get(number)?.start ?? wordValue(levels.get(number)?.level,"start") ?? 1);
    active.set(index,(active.get(index) ?? start(index)-1)+1);
    for (const sub of active.keys()) {
      const restart = wordValue(levels.get(sub).level,"lvlRestart");
      if (sub>index && restart!=="0" && index<Number(restart || sub)) active.delete(sub);
    }
    const template = wordValue(entry.level,"lvlText") || "";
    const format = wordValue(entry.level,"numFmt");
    if (!template || format==="bullet" || format==="none") return "";
    let supported = true;
    const label = template.replace(/%([1-9])/g,(_,digit)=>{
      const level = Number(digit)-1;
      const text = wordNumberText(active.get(level) ?? start(level),wordValue(levels.get(level)?.level,"numFmt"));
      if (!text) supported = false;
      return text;
    });
    if (!supported) return "";
    const suffix = wordValue(entry.level,"suff");
    return label+(suffix==="nothing"?"":suffix==="space"?" ":"\t");
  };
}

function wordBodyBlocks(container,numberLabel,keepEmpty=false) {
  const result = [];
  for (const item of container.children) {
    const tag = item.localName;
    if (tag==="p" || tag==="tbl") {
      const body = tag==="p" ? wordParagraphText(item) : wordTableText(item,numberLabel);
      const text = tag==="p" && body.trim() ? numberLabel(item)+body : body;
      if (keepEmpty || text.trim()) result.push({kind:tag==="p"?"paragraph":"table",text});
    } else if (["sdt","sdtContent","customXml","ins"].includes(tag)) {
      result.push(...wordBodyBlocks(item,numberLabel,keepEmpty));
    }
  }
  return result;
}
function wordParagraphText(element) {
  const separators = {tab:"\t",br:"\n",cr:"\n",noBreakHyphen:"\u2011"};
  const parts = [];
  function read(item) {
    const tag = item.localName;
    if (["del","delText","instrText","txbxContent"].includes(tag)) return;
    if (tag==="t") parts.push(item.textContent);
    else if (Object.hasOwn(separators,tag)) parts.push(separators[tag]);
    else for (const child of item.children) read(child);
  }
  read(element);
  return parts.join("");
}
function wordTableText(table,numberLabel) {
  return officeChildren(table,"tr").map(row=>{
    const values = [];
    for (const cell of officeChildren(row,"tc")) {
      values.push(wordBodyBlocks(cell,numberLabel,true).map(block=>block.text).join("\u2028"));
      const span = officeChild(officeChild(cell,"tcPr"),"gridSpan");
      const width = Number(span?.getAttributeNS(span.namespaceURI,"val"));
      if (Number.isInteger(width) && width>1) values.push(...Array(Math.min(width-1,100)).fill(""));
    }
    return values.join("\t");
  }).join("\n");
}
async function readIntakeWord(archive) {
  const document = await archive.xml("word/document.xml");
  const body = officeChild(document,"body");
  const definition = archive.has("word/numbering.xml") ? await archive.xml("word/numbering.xml") : null;
  const blocks = body ? wordBodyBlocks(body,wordNumbering(definition)) : [];
  requirePackage(blocks.length,"未找到可读取的 Word 正文。请上传有可选中文字的 .docx。");
  return blocks;
}

async function readIntakeWorkbook(archive) {
  const workbook = await archive.xml("xl/workbook.xml");
  const sheets = officeChildren(officeChild(workbook,"sheets"),"sheet");
  const named = sheets.filter(sheet=>sheet.getAttribute("name")==="标注集");
  const sheet = named.length===1 ? named[0] : sheets.length===1 ? sheets[0] : null;
  requirePackage(sheet,"请在 Excel 中保留一个名为「标注集」的工作表。");
  const relId = Array.from(sheet.attributes).find(attr=>attr.localName==="id")?.value;
  const rels = await archive.xml("xl/_rels/workbook.xml.rels");
  const relation = officeChildren(rels,"Relationship").find(item=>item.getAttribute("Id")===relId);
  const target = relation?.getAttribute("Target");
  requirePackage(target && relation.getAttribute("TargetMode")!=="External" && /^[\w./-]+$/.test(target)
    && !target.split("/").includes(".."),"无法定位 Excel 的标注工作表。");
  const data = officeChild(await archive.xml(target.startsWith("/")?target.slice(1):"xl/"+target),"sheetData");
  const shared = archive.has("xl/sharedStrings.xml")
    ? officeChildren(await archive.xml("xl/sharedStrings.xml"),"si").map(item=>officeText(item,"t"))
    : [];
  let columns;
  const rows = [];
  for (const row of officeChildren(data,"row")) {
    const rowNumber = row.getAttribute("r");
    requirePackage(/^\d+$/.test(rowNumber || ""),"Excel 包含无法定位的标注行。");
    const cells = new Map();
    for (const cell of officeChildren(row,"c")) {
      const address = cell.getAttribute("r") || "";
      const column = /^([A-Z]+)\d+$/.exec(address)?.[1];
      requirePackage(column && !cells.has(column),"标注集第 "+rowNumber+" 行含无效或重复的单元格。");
      if (columns && !columns.includes(column)) continue;
      const kind = cell.getAttribute("t");
      let value = officeChild(cell,"v")?.textContent || "";
      requirePackage(!officeChild(cell,"f") && kind!=="e","单元格 "+address+" 含公式或错误值，请改为文本。");
      if (kind==="s") {
        requirePackage(/^\d+$/.test(value) && Number(value)<shared.length,"单元格 "+address+" 的共享文本无效。");
        value = shared[Number(value)];
      } else if (kind==="inlineStr") value = officeText(cell,"t");
      cells.set(column,officeLF(value.replace(/_x([0-9a-f]{4})_/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)))));
    }
    if (![...cells.values()].some(value=>value.trim())) continue;
    if (!columns) {
      const header = [...cells];
      const missing = packageFieldNames.filter(field=>header.filter(([,value])=>value.trim()===field).length!==1);
      requirePackage(!missing.length,"Excel 缺少以下标注字段或存在同名列："+missing.join("、")+"。");
      columns = packageFieldNames.map(field=>header.find(([,value])=>value.trim()===field)[0]);
      continue;
    }
    rows.push({id:"row-"+rowNumber,fields:Object.fromEntries(packageFieldNames.map((field,index)=>[field,cells.get(columns[index]) || ""]))});
  }
  requirePackage(rows.length,"Excel 中没有可用的标注行。");
  requirePackage(new Set(rows.map(row=>row.id)).size===rows.length,"Excel 中存在重复的行号。");
  return {rows,sheet:sheet.getAttribute("name"),columns:Object.fromEntries(packageFieldNames.map((field,index)=>[field,columns[index]]))};
}

// Match complete clauses at Word paragraph/table boundaries in document order.
function locateIntakeSections(contract,clauses) {
  const offsets = [0];
  const text = contract.blocks.map(block=>{
    const value = officeCompact(block.text);
    offsets.push(offsets.at(-1)+value.length);
    return value;
  }).join("");
  const boundaries = new Map(offsets.map((offset,index)=>[offset,index]));
  const spans = [];
  for (const [clause,rowId] of clauses) {
    const needle = officeCompact(clause);
    const matches = [];
    for (let at=text.indexOf(needle);at!==-1;at=text.indexOf(needle,at+1)) {
      if (boundaries.has(at) && boundaries.has(at+needle.length)) {
        matches.push([boundaries.get(at),boundaries.get(at+needle.length)]);
        if (matches.length===2) break;
      }
    }
    requirePackage(matches.length===1,
      "标注集第 "+rowId.slice(4)+" 行的「条款原文」"+(matches.length?"在 Word 中有多处相同内容":"无法与 Word 中的完整段落对应")+"。请核对合同版本和切片："+clause.trim().slice(0,45));
    spans.push({start:matches[0][0],end:matches[0][1],clause,rowId});
  }
  spans.sort((a,b)=>a.start-b.start);
  const ids = new Map();
  const sections = [];
  function addSection(start,end,text) {
    const heading = contract.blocks[start].text.trim().split("\n")[0].slice(0,90);
    const id = "S"+String(sections.length+1).padStart(3,"0");
    sections.push({id,heading,text:text ?? contract.blocks.slice(start,end).map(block=>block.text).join("\n")});
    return id;
  }
  let cursor = 0;
  for (const {start,end,clause,rowId} of spans) {
    requirePackage(start>=cursor,"标注集第 "+rowId.slice(4)+" 行的条款切片与其他行重叠。请统一这些行的完整条款原文。");
    if (start>cursor) addSection(cursor,start);
    ids.set(clause,addSection(start,end,clause));
    cursor = end;
  }
  if (cursor<contract.blocks.length) addSection(cursor,contract.blocks.length);
  contract.sections = sections;
  return ids;
}

function alignIntakeVersions(left,right) {
  const heading = section=>officeCompact(section.heading).normalize("NFKC");
  const number = section=>heading(section).match(/^(?:第[一二三四五六七八九十百零〇两\d]+条|[一二三四五六七八九十百零〇两\d]+、|\d+\.(?!\d))/)?.[0] || "";
  const title = section=>heading(section).slice(number(section).length);
  function orderedMatches(first,second,key) {
    function unique(sections) {
      const index = new Map();
      for (const [i,section] of sections.entries()) {
        const value = key(section);
        if (value) index.set(value,index.has(value) ? -1 : i);
      }
      return index;
    }
    const a = unique(first), b = unique(second);
    const candidates = [...a].flatMap(([value,i])=>i>=0 && b.get(value)>=0 ? [[i,b.get(value)]] : []);
    let firstLater = Infinity;
    const later = [];
    for (let i=candidates.length-1;i>=0;i--) {
      later[i] = firstLater;
      firstLater = Math.min(firstLater,candidates[i][1]);
    }
    let lastEarlier = -1;
    return candidates.filter(([,j],i)=>{
      const ordered = j>lastEarlier && j<later[i];
      lastEarlier = Math.max(lastEarlier,j);
      return ordered;
    });
  }
  const a = left.sections, b = right.sections;
  const pairs = [];
  let fromA = 0, fromB = 0;
  for (const [i,j] of [...orderedMatches(a,b,title),[a.length,b.length]]) {
    if (i-fromA===j-fromB) {
      for (const [x,y] of orderedMatches(a.slice(fromA,i),b.slice(fromB,j),number)) {
        pairs.push([a[fromA+x].id,b[fromB+y].id]);
      }
    }
    if (i<a.length) pairs.push([a[i].id,b[j].id]);
    fromA = i+1;
    fromB = j+1;
  }
  return pairs;
}

function matchIntakeSharedRows(group,other) {
  const comparable = row=>JSON.stringify(packageFieldNames.filter(field=>!packageSourceFields.includes(field))
    .map(field=>row.fields[field]));
  const byFields = new Map(other.map(row=>[comparable(row),row.id]));
  const signatures = group.map(comparable);
  if (group.length!==other.length || byFields.size!==other.length ||
      new Set(signatures).size!==group.length || !signatures.every(signature=>byFields.has(signature))) return [];
  return group.map((row,i)=>[row.id,byFields.get(signatures[i])]);
}

function intakeVersionPair(contracts,rows) {
  const [left,right] = contracts;
  const sections = alignIntakeVersions(left,right);
  const sectionMap = new Map(sections);
  const leftText = new Map(left.sections.map(section=>[section.id,section.text]));
  const rightText = new Map(right.sections.map(section=>[section.id,section.text]));
  const ruleGroups = new Map();
  for (const row of rows) {
    if (row.scope!=="slice" || packageRuleFields.some(field=>!row.fields[field].trim())) continue;
    const leftVersion = row.contract_id===left.id;
    const section = leftVersion ? sectionMap.get(row.section_id) : row.section_id;
    if (!section || (leftVersion && leftText.get(row.section_id)!==rightText.get(section))) continue;
    const key = JSON.stringify([section,row.fields["风险名称"],row.fields["风险等级"],row.fields["审查逻辑"],row.matter_id || ""]);
    if (!ruleGroups.has(key)) ruleGroups.set(key,[new Map(),new Map()]);
    const groups = ruleGroups.get(key)[leftVersion ? 0 : 1];
    if (!groups.has(row.rule_id)) groups.set(row.rule_id,[]);
    groups.get(row.rule_id).push(row);
  }
  const shared = [];
  for (const [first,second] of ruleGroups.values()) {
    // Pair complete judgment groups so an association split cannot be shared only in part.
    for (const group of first.values()) {
      const other = second.get(group[0].rule_id) || (first.size===1 && second.size===1 ? second.values().next().value : null);
      if (!other) continue;
      shared.push(...matchIntakeSharedRows(group,other));
    }
  }
  return {contracts:[left.id,right.id],sections,shared};
}

function detectIntakeVersionPairs(contracts,rows) {
  const stances = new Map(contracts.map(contract=>[contract.id,new Set()]));
  for (const row of rows) {
    const stance = row.fields["立场"].trim();
    if (stance) stances.get(row.contract_id).add(stance);
  }
  const groups = new Map();
  for (const contract of contracts) {
    const [stance] = stances.get(contract.id);
    if (stances.get(contract.id).size!==1) continue;
    const stem = contract.name.normalize("NFC").replace(/\.docx$/i,"");
    const suffix = stance.normalize("NFC").replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?:版|立场版)?";
    const base = stem.replace(new RegExp("(?:[ _·－—-]+"+suffix+"|[（(【]"+suffix+"[）)】])$","u"),"").trim();
    if (!base || base===stem) continue;
    if (!groups.has(base)) groups.set(base,[]);
    groups.get(base).push({contract,stance});
  }
  return [...groups.values()].flatMap(group=>{
    if (group.length!==2 || group[0].stance===group[1].stance) return [];
    const versions = group.map(item=>item.contract);
    const pair = intakeVersionPair(versions,rows.filter(row=>versions.some(contract=>contract.id===row.contract_id)));
    return pair.sections.length ? [pair] : [];
  });
}

async function generateInitialPackage(wordFiles,excelFiles,confirmWarnings) {
  requirePackage(wordFiles.length && wordFiles.every(file=>/\.docx$/i.test(file.name)) &&
    excelFiles.length && excelFiles.every(file=>/\.xlsx$/i.test(file.name)),"请选择用于 AI 标注的合同 .docx 和标注集 .xlsx。");
  requirePackage(excelFiles.length===1,"请上传一份统一标注集。");
  requirePackage([...wordFiles,...excelFiles].reduce((sum,file)=>sum+file.size,0)<packageLimit,"所选文件合计超出 200 MiB。");
  const contents = new Map(), sources = [];
  const contracts = new Map(), rules = new Map();
  async function ingest(file,purpose,read) {
    try {
      const buffer = await file.arrayBuffer();
      const value = await read(openOfficeArchive(buffer));
      const entry = "sources/"+(sources.length+1)+file.name.slice(-5).toLowerCase();
      const sha256 = await hexHash(buffer);
      sources.push({entry,name:file.name,purpose,sha256});
      contents.set(entry,new Uint8Array(buffer));
      return {value,sha256};
    } catch (error) {
      throw new Error(file.name+"："+error.message);
    }
  }

  const rows = [], annotationSources = [];
  for (const [index,file] of excelFiles.entries()) {
    const {value:{rows:records,sheet,columns}} = await ingest(file,"AI 初标标注集",readIntakeWorkbook);
    annotationSources.push({name:file.name,sheet,columns});
    for (const row of records) {
      if (excelFiles.length>1) row.id += "-表"+(index+1);
      rows.push(row);
    }
  }
  for (const file of wordFiles) {
    const key = intakeFileName(file.name);
    requirePackage(!contracts.has(key),"合同文件名重复："+file.name);
    const {value:blocks,sha256} = await ingest(file,"用于 AI 标注的合同 Word",readIntakeWord);
    contracts.set(key,{id:"C"+(contracts.size+1),name:null,filename:file.name,blocks,source_sha256:sha256});
  }
  const clauses = new Map([...contracts.values()].map(contract=>[contract.id,new Map()]));
  const [fileKey,categoryKey,clauseKey,riskKey,stanceKey,relevantKey,triggerKey,levelKey,logicKey,,,,evidenceKey] = packageFieldNames;
  for (const row of rows) {
    const f = row.fields;
    const where = "标注集第 "+row.id.slice(4)+" 行";
    const contract = contracts.get(intakeFileName(f[fileKey]));
    requirePackage(contract,where+"需要合同「"+f[fileKey]+"」。请上传 AI 标注实际使用的同名 Word。");
    requirePackage(!contract.name || contract.name===f[fileKey],where+"的合同附件名称写法与其他行不一致。");
    contract.name = f[fileKey];
    requirePackage([relevantKey,triggerKey].every(key=>["是","否"].includes(f[key])),where+"的相关性和触发判断须填「是」或「否」。");
    row.contract_id = contract.id;
    row.rule_id = "";
    if (f[riskKey].trim() && f[stanceKey].trim()) {
      const ruleKey = JSON.stringify([f[riskKey],f[stanceKey]]);
      if (!rules.has(ruleKey)) rules.set(ruleKey,{id:"R"+(rules.size+1),name:f[riskKey],stance:f[stanceKey],level:"",logic:""});
      const rule = rules.get(ruleKey);
      for (const [key,field] of [["level",levelKey],["logic",logicKey]]) {
        if (!f[field].trim()) continue;
        requirePackage(!rule[key] || rule[key]===f[field],where+"的同名同立场规则在不同标注行的等级或审查逻辑不一致："+rule.name+"／"+rule.stance);
        rule[key] = f[field];
      }
      row.rule_id = rule.id;
    }
    row.original_fields = {...f};
    if (f[clauseKey].trim()) {
      row.scope = "slice";
      const selected = clauses.get(contract.id);
      if (!selected.has(f[clauseKey])) selected.set(f[clauseKey],row.id);
    } else {
      requirePackage(f[clauseKey]==="" && !f[categoryKey] && f[relevantKey]==="否" &&
        (f[triggerKey]==="否" || !f[evidenceKey].trim()),
        where+"缺少主条款原文。全文缺失标注的相关性须为「否」，条款类型留空；关键证据应留空。");
      row.scope = "full_missing";
    }
  }
  const sectionByContract = new Map();
  for (const contract of contracts.values()) {
    contract.name ||= contract.filename;
    delete contract.filename;
    sectionByContract.set(contract.id,locateIntakeSections(contract,clauses.get(contract.id)));
  }
  for (const row of rows) {
    if (row.scope==="slice") row.section_id = sectionByContract.get(row.contract_id).get(row.fields[clauseKey]);
  }
  const first = contracts.values().next().value;
  const title = first.name.replace(/\.docx$/i,"")+(contracts.size>1?" 等 "+contracts.size+" 份合同":"");
  const project = {
    title,stage:"student",fields:[...packageFieldNames],contracts:[...contracts.values()],rules:[...rules.values()],rows,
    checks:[{check:"建包来源",message:"规则字段取自上传的 Excel。未提供独立规则库或覆盖清单，漏标需对照合同和正式规则另行核查。",blocking:false}]
  };
  const pairs = detectIntakeVersionPairs(project.contracts,rows);
  if (pairs.length) project.version_pairs = pairs;
  const warnings = missingPackageRuleFields(rows);
  if (warnings.length && !await confirmWarnings(warnings,annotationSources)) return null;
  const baseline = packJSON(project);
  const baselineHash = await hexHash(baseline);
  contents.set("baseline.json",baseline);
  const manifest = {
    format:packageFormat,version:pairs.length ? pairedPackageVersion : packageVersion,batch_id:baselineHash.slice(0,20),package_id:crypto.randomUUID(),
    parents:[],revision:0,round:1,stage:"student",baseline_sha256:baselineHash,sources,annotation_sources:annotationSources,
    handoff:{action:"网页生成初始包",source:excelFiles.map(file=>file.name).join("、"),at:new Date().toISOString()}
  };
  const zip = await exportReviewPackage({contents},manifest,[]);
  const counts = new Map();
  for (const {fields} of rows) {
    const type = packageCardType(fields);
    counts.set(type,(counts.get(type) || 0)+1);
  }
  const shared = pairs.flatMap(pair=>pair.shared);
  const pairedRows = new Set(shared.map(([,id])=>id));
  const sharedReviews = rows.filter(row=>pairedRows.has(row.id) && packageCardType(row.fields)).length;
  return {zip,title,total:rows.length,counts,sharedReviews,
    pairedContracts:pairs.length};
}
