"use strict";

let packageSession;
let packageBusy = false;
let packageViewMode = "flip";
const packageCardLabels = new Map([
  ["related-hit","相关触发"],["related-clear","相关未触发"],
  ["no-clause","全文缺失风险"],["no-attention","无需关注"]
]);
const seenPackageHeads = new Map();
const lawyerSections = new Map();
const lawyerCards = new Map();
const packageDetailPages = new Map();
const packageVersionChoices = new Set();
const packageStanceChoices = new Map();
let packagePairByContract = new Map(), packageSharedPrimary = new Set();
let packageVersionBase, packageSectionSlots = new Map(), packageSharedRows = new Map();
let packageSectionsByContract = new Map();
const roleTitle = {student:"实习生",lawyer:"律师"};
const packageSide = {student:"right",lawyer:"lawyer-pane"};

function acceptPackageVersion(incoming) {
  const previous = seenPackageHeads.get(incoming.manifest.baseline_sha256);
  const next = incoming.manifest;
  return !previous || previous.package_id===next.package_id || next.parents.includes(previous.package_id)
    || window.confirm("这个包可能是旧版本或另一条交接分支。请核对文件来源。仍要打开吗？");
}
function actorForPackage(incoming,name) {
  const role = incoming.project.stage;
  if (role==="final") return null;
  const prior = incoming.events.findLast(event=>event.actor===name && event.role===role);
  return {id:prior?.actor_id || crypto.randomUUID(),name};
}
function confirmPackageWarnings(warnings,sources,action) {
  const title = "标注字段有空值";
  const dialog = dialogBox(title);
  dialog.setAttribute("aria-label",title);
  dialog.append(node("p","以下字段缺少值。可以继续，现有空值会保留。"));
  const list = node("ul");
  for (const {field,count,first} of warnings) {
    const row = packageSourceRow(first);
    const source = row && sources?.[row.index];
    const column = source?.columns?.[field];
    const location = typeof source?.sheet==="string" && /^[A-Z]+$/.test(column || "") ?
      "首个空值："+[source.name,"「"+source.sheet+"」!"+column+row.number].filter(Boolean).join(" · ") :
      "首条受影响记录："+(sourceRowLabel(first) || first)+"（包内未记录源单元格）";
    list.append(node("li",field+"缺失 "+count+" 条。"+location));
  }
  dialog.append(list);
  return new Promise(resolve=>{
    let confirmed = false;
    const cancel = button("取消",()=>dialog.close());
    const actions = node("div",null,"row-actions");
    actions.append(cancel,button(action,()=>{
      confirmed = true;
      dialog.close();
    },"primary"));
    dialog.append(actions);
    dialog.addEventListener("close",()=>resolve(confirmed),{once:true});
    cancel.focus();
  });
}
async function confirmPackageImport(incoming) {
  const warnings = missingPackageRuleFields(incoming.project.rows);
  if (!warnings.length) return true;
  let sources = incoming.manifest.annotation_sources;
  if (!Array.isArray(sources)) {
    // Older browser-generated packages kept the original workbooks but no column map.
    const files = incoming.manifest.sources.filter(source=>source.purpose==="AI 初标标注集" && source.entry.endsWith(".xlsx"));
    sources = await Promise.all(files.map(async source=>{
      try {
        const bytes = incoming.contents.get(source.entry);
        const {sheet,columns} = await readIntakeWorkbook(openOfficeArchive(bytes.slice().buffer));
        return {name:source.name,sheet,columns};
      } catch {
        return null;
      }
    }));
  }
  return confirmPackageWarnings(warnings,sources,"仍然进入");
}
function packageFileControl() {
  const input = node("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.onchange = async ()=>{
    const file = input.files[0];
    input.value = "";
    if (!file || packageBusy) return;
    if ((dirty || openEditor) && !window.confirm("当前有尚未导出的修改或打开的编辑表单。继续导入其他数据包？")) return;
    packageBusy = root.inert = true;
    setNotice("正在校验数据包…");
    try {
      const incoming = await loadReviewPackage(file);
      if (!acceptPackageVersion(incoming)) return setNotice("已保留当前工作。");
      if (!await confirmPackageImport(incoming)) return setNotice("导入已取消，保留当前工作。");
      if (incoming.project.stage==="final") {
        mountPackage(incoming,null);
      } else {
        identifyPackageActor(incoming);
      }
    } catch (error) {
      setNotice("导入失败。"+error.message);
    } finally {
      packageBusy = root.inert = false;
    }
  };
  input.hidden = true;
  input.setAttribute("aria-label","导入数据包");
  const control = node("span");
  control.append(input,button("导入 ZIP",()=>input.click()));
  return control;
}
function initialPackageForm(usePackage) {
  const form = node("form",null,"package-start-form");
  const word = node("input"), excel = node("input");
  word.type = excel.type = "file";
  word.accept = ".docx";
  word.multiple = true;
  excel.accept = ".xlsx";
  const hint = node("p","上传全部合同 Word 和一份统一标注集。工具按立场显示标注，并自动识别同名的两份立场版本。","small");
  const wordField = labelled("合同 Word（.docx）",word,"package-start-field");
  const excelField = labelled("标注集 Excel（.xlsx）",excel,"package-start-field");
  const result = node("div",null,"package-start-preview");
  result.hidden = true;
  const status = node("p","","package-start-status");
  status.setAttribute("role","status");
  const generate = node("button","生成初始 ZIP","primary");
  generate.type = "submit";
  generate.disabled = true;
  word.onchange = excel.onchange = ()=>{
    result.hidden = true;
    status.textContent = "";
    generate.disabled = !word.files.length || !excel.files.length;
  };
  form.onsubmit = async event=>{
    event.preventDefault();
    if (generate.disabled) return;
    word.disabled = excel.disabled = generate.disabled = true;
    status.textContent = "正在读取合同和标注集…";
    result.hidden = true;
    try {
      const generated = await generateInitialPackage([...word.files],[...excel.files],
        (warnings,sources)=>confirmPackageWarnings(warnings,sources,"仍然生成"));
      if (!generated) {
        status.textContent = "已取消生成初始包。";
        return;
      }
      const {zip,title,total,counts,pairedContracts,sharedReviews} = generated;
      const filename = packageExportName(title,"待署名","初始包","交实习生");
      const summary = ["共 "+total+" 条标注", ...[...packageCardLabels].map(([type,label])=>
        label+" "+(counts.get(type) || 0)+" 条")].join(" · ");
      result.replaceChildren(node("strong","初始包已生成"),node("span",summary,"small"),
        button("下载初始 ZIP",async ()=>{
          const chosen = await choosePackageFilename(filename,".zip");
          if (chosen) downloadPackageFile(zip,chosen);
        },"primary"),
        button("用此初始包开始复核",()=>usePackage(new File([zip],filename+".zip",{type:"application/zip"}))));
      if (pairedContracts) result.insertBefore(node("span",
        "已识别 "+pairedContracts+" 组双立场合同 · "+sharedReviews+" 对标注共用复核。","small"),result.children[2]);
      status.textContent = "";
      result.hidden = false;
    } catch (error) {
      status.textContent = "生成失败。"+error.message;
    } finally {
      word.disabled = excel.disabled = generate.disabled = false;
    }
  };
  form.append(
    hint,
    wordField,excelField,
    status,generate,result
  );
  return form;
}

function bootPackage(message="导入已有 ZIP，或用合同和 AI 标注集生成初始包。") {
  document.title = "合同复核工具";
  const start = node("main",null,"package-start");
  const intro = node("div",null,"package-start-intro");
  const heading = node("h1","合同复核工具");
  const lead = node("p",message,"package-start-lead");
  intro.append(heading,lead);
  const form = node("form",null,"package-start-form");
  const input = node("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.setAttribute("aria-label","选择数据包 ZIP");
  const fileButton = button("选择 ZIP",()=>input.click());
  input.hidden = true;
  const fileName = node("span","未选择文件","package-start-filename");
  const fileRow = node("div",null,"package-start-file");
  fileRow.append(input,fileButton,fileName);
  const zipLabel = node("span","复核数据包","package-start-label");
  const preview = node("div",null,"package-start-preview");
  preview.hidden = true;
  const name = node("input");
  name.type = "text";
  name.autocomplete = "name";
  name.maxLength = 80;
  name.placeholder = "填写本轮复核署名";
  const identity = labelled("姓名或工作代号",name,"package-start-field");
  const status = node("p","","package-start-status");
  status.id = "message";
  status.setAttribute("role","status");
  const open = node("button","进入复核工作台","primary");
  open.type = "submit";
  open.disabled = true;
  let incoming;
  let confirmedDuringBuild = false;
  let importAttempt = 0;
  function updateOpen() {
    open.disabled = !incoming || (incoming.project.stage!=="final" && !name.value.trim());
  }
  name.oninput = updateOpen;
  async function inspect(file,alreadyConfirmed=false,embedded=false) {
    const attempt = ++importAttempt;
    incoming = null;
    preview.hidden = true;
    identity.hidden = false;
    fileName.textContent = file.name;
    fileName.title = file.name;
    status.textContent = "正在校验数据包…";
    updateOpen();
    try {
      const loaded = await loadReviewPackage(file);
      if (attempt!==importAttempt) return;
      incoming = loaded;
      confirmedDuringBuild = alreadyConfirmed;
      const {stage,round,revision} = loaded.manifest;
      preview.replaceChildren(node("strong",loaded.project.title || "合同复核"),
        node("span",stageNames[stage]+" · 第 "+round+" 轮 · 包版本 "+revision,"small"));
      preview.hidden = false;
      identity.hidden = stage==="final";
      status.textContent = "";
      if (embedded) {
        heading.textContent = loaded.project.contract_type || loaded.project.title || "合同复核工具";
        lead.textContent = stage==="final" ? "律师终版已加载，确认后进入只读验收。" :
          "本批数据包已加载，填写署名后确认进入。";
        document.title = heading.textContent+" · "+stageNames[stage];
      }
      updateOpen();
    } catch (error) {
      if (attempt===importAttempt) {
        if (embedded) showFileControls();
        status.textContent = "导入失败。"+error.message;
      }
    }
  }
  input.onchange = ()=>{
    const file = input.files[0];
    input.value = "";
    if (file) inspect(file);
  };
  form.onsubmit = async event=>{
    event.preventDefault();
    if (!incoming || open.disabled || !acceptPackageVersion(incoming)) return;
    const candidate = incoming;
    if (!confirmedDuringBuild) {
      open.disabled = true;
      const confirmed = await confirmPackageImport(candidate);
      if (incoming!==candidate) return;
      updateOpen();
      if (!confirmed) return;
    }
    mountPackage(candidate,actorForPackage(candidate,name.value.trim()));
  };
  form.append(zipLabel,fileRow,preview,identity,status,open);
  const create = initialPackageForm(file=>{
    showCreate(false);
    inspect(file,true);
    name.focus();
  });
  const modes = node("div",null,"package-start-modes");
  const importMode = button("导入已有 ZIP",()=>showCreate(false));
  const createMode = button("生成初始包",()=>showCreate(true));
  const viewMode = choose("package-view-mode",[["flip","翻转视图"],["list","罗列视图"]]);
  viewMode.value = packageViewMode;
  viewMode.setAttribute("aria-label","复核视图");
  viewMode.onchange = ()=>{ packageViewMode = viewMode.value; };
  function showCreate(creating) {
    create.hidden = !creating;
    form.hidden = creating;
    importMode.setAttribute("aria-pressed",String(!creating));
    createMode.setAttribute("aria-pressed",String(creating));
  }
  function showFileControls() {
    modes.hidden = fileRow.hidden = zipLabel.hidden = false;
  }
  modes.append(importMode,createMode);
  start.append(intro,modes,labelled("复核视图",viewMode,"package-start-view"),form,create);
  showCreate(false);
  root.replaceChildren(start);
  const entry = byId("review-entry");
  if (entry) {
    entry.remove();
    try {
      const {name:filename,bytes} = JSON.parse(entry.textContent);
      const data = Uint8Array.fromBase64 ? Uint8Array.fromBase64(bytes) : Uint8Array.from(atob(bytes),char=>char.charCodeAt(0));
      modes.hidden = fileRow.hidden = zipLabel.hidden = true;
      inspect(new File([data],filename,{type:"application/zip"}),false,true);
    } catch (error) {
      status.textContent = "无法打开此复核页："+error.message;
    }
  }
}

function identifyPackageActor(incoming) {
  const dialog = dialogBox("确认本轮操作者");
  const name = node("input");
  name.type = "text";
  name.maxLength = 80;
  const role = incoming.project.stage;
  const error = node("p","","small");
  dialog.append(node("p","当前阶段为"+roleTitle[role]+"复核。请输入姓名或工作代号。"),labelled("姓名或工作代号",name),error,
    button("打开复核工作台",()=>{
      const actor = name.value.trim();
      if (!actor) { error.textContent = "请先填写操作者。"; return name.focus(); }
      dialog.close();
      mountPackage(incoming,actorForPackage(incoming,actor));
    },"primary"));
  dialog.addEventListener("close",()=>{
    if (packageSession!==incoming) setNotice("导入已取消，保留当前工作。");
  });
  name.focus();
}

function mountPackage(session,actor) {
  packageSession = session;
  session.actor = actor;
  session.handoffChanges = indexHandoffChanges(session.events);
  seenPackageHeads.set(session.manifest.baseline_sha256,session.manifest);
  model = session.project;
  packageVersionBase = undefined;
  const pairs = packagePairs(model);
  const shared = pairs.flatMap(pair=>pair.shared);
  packagePairByContract = new Map(pairs.flatMap(pair=>pair.contracts.map(id=>[id,pair])));
  packageSharedRows = new Map(shared.flatMap(([a,b])=>[[a,b],[b,a]]));
  packageSharedPrimary = new Set(shared.map(([a])=>a));
  packageVersionChoices.clear();
  packageStanceChoices.clear();
  const changedRows = model.stage==="final" ? session.baseline.rows.filter(row=>baselineLawyerChange(row,session.baseline.stage)) :
    model.rows.filter(row=>row.added_by || row.review_history?.length ||
    packageRoles.some(role=>row[role]?.note?.trim()) ||
    (row.original_fields && model.fields.some(field=>get(row,field)!==asText(row.original_fields[field]))));
  session.changedRows = new Set(changedRows.map(row=>row.id));
  for (const event of session.events) trackPackageChanges(event);
  bindModel();
  contractId = packagePairByContract.get(contractId)?.contracts[0] || contractId;
  selected = activeSectionId = openEditor = pendingSide = "";
  linked = true;
  lastUserSide = "left";
  packageDetailPages.clear();
  dirty = false;
  root.replaceChildren();
  launch();
  session.known = snapshotPackageChanges();
  setNotice("已打开 ZIP。修改后可随时导出当前进度。");
}

function snapshotPackageChanges(project=model) {
  return {
    rows:new Map(project.rows.map(row=>[row.id,structuredClone(row)])),
    state:Object.fromEntries(packageStateKeys.map(key=>[key,structuredClone(project[key] ?? null)]))
  };
}
function packageRecordVersion(row) {
  return structuredClone({
    fields:row.fields,contract_id:row.contract_id,rule_id:row.rule_id,
    scope:row.scope,section_id:row.section_id,matter_id:row.matter_id
  });
}
function fixedPackageBindingFields(row) {
  if (packageSharedRows.has(row.id)) return packageBoundFields;
  return packagePairByContract.has(row.contract_id) ? packageSourceFields : [];
}
function invalidatePackageReview(row,before) {
  if (samePackageValue(packageRecordVersion(row),packageRecordVersion(before))) return;
  const role = model.stage;
  const other = role==="student" ? "lawyer" : "student";
  if (other==="student" || packageSession.manifest.round>1 || before[other] || before[other+"_view"]) {
    row[other+"_view"] ||= roleProjection(before,other);
  }
  row[role+"_view"] = packageRecordVersion(row);
  if (role==="student" && row.lawyer?.reviewed) row.lawyer.reviewed = false;
  if (role==="lawyer" && !before.student?.reviewed && !requiresReview(before)) row.lawyer_review_only = true;
}
function roleProjection(row,role) {
  if (role==="lawyer" && model.stage==="lawyer" && packageCurrentRemoval(row)) return packageRecordVersion(row);
  const stored = row[role+"_view"];
  if (stored) return stored;
  const version = packageRecordVersion(row);
  if (role==="student" && row.submitted_fields) version.fields = structuredClone(row.submitted_fields);
  return version;
}
function packageEvent(action,before,next,seq) {
  const {id,name} = packageSession.actor;
  const rows = [];
  for (const [rowId,after] of next.rows) {
    const prior = before.rows.get(rowId) ?? null;
    if (!samePackageValue(prior,after)) rows.push({id:rowId,before:prior,after});
  }
  const state = [];
  for (const key of packageStateKeys) {
    if (!samePackageValue(before.state[key],next.state[key])) state.push({key,before:before.state[key],after:next.state[key]});
  }
  if (!rows.length && !state.length) return null;
  return {id:crypto.randomUUID(),seq,actor_id:id,actor:name,role:model.stage,round:packageSession.manifest.round,
    at:new Date().toISOString(),action,rows,state};
}
const packageBindingChanged = (before,after)=>["contract_id","rule_id","scope","section_id","matter_id"]
  .some(key=>before?.[key]!==after[key]);

function baselineLawyerChange(row,stage) {
  if (row.added_by==="lawyer" || row.lawyer?.note?.trim() ||
      row.review_history?.some(entry=>entry?.stage==="lawyer" && packageJudgmentActions.has(entry.action))) return true;
  const submitted = row.student_view?.fields ?? row.submitted_fields;
  const reviewed = row.lawyer_view ?? (stage==="final" ? row : null);
  return !!submitted && !!reviewed && (model.fields.some(field=>get(reviewed,field)!==asText(submitted[field])) ||
    (!!row.student_view && packageBindingChanged(row.student_view,reviewed)));
}
function trackPackageChanges(event) {
  const final = model.stage==="final";
  if (final && event.role!=="lawyer") return;
  const noteRoles = final ? ["lawyer"] : packageRoles;
  const changedRows = packageSession.changedRows;
  for (const {id,before,after} of event.rows) {
    if (changedRows.has(id)) continue;
    if (!before || !samePackageValue(before.fields,after.fields) || packageBindingChanged(before,after) ||
        !samePackageValue(before.review_history,after.review_history) ||
        noteRoles.some(role=>asText(before[role]?.note)!==asText(after[role]?.note))) changedRows.add(id);
  }
}
function capturePackageChange(action) {
  if (!packageSession?.actor || model.stage==="final") return;
  for (const a of packageSharedPrimary) {
    const b = packageSharedRows.get(a);
    const left = rowById.get(a), right = rowById.get(b);
    const previous = packageSession.known.rows;
    const changedLeft = !samePackageValue(left,previous.get(a));
    const changedRight = !samePackageValue(right,previous.get(b));
    if (changedLeft===changedRight) continue;
    const [source,target] = changedLeft ? [left,right] : [right,left];
    const sourceBefore = previous.get(source.id), targetBefore = previous.get(target.id);
    for (const field of packageFieldNames) {
      if (!packageBoundFields.includes(field)) target.fields[field] = source.fields[field];
    }
    for (const event of (source.review_history || []).slice(sourceBefore.review_history?.length || 0)) {
      (target.review_history ||= []).push({...event,before:{...targetBefore.fields}});
    }
    if (source.review_required) target.review_required = true;
    invalidatePackageReview(target,targetBefore);
    if (source[model.stage]) target[model.stage] = structuredClone(source[model.stage]);
  }
  for (const row of model.rows) {
    const wasReviewed = packageSession.known.rows.get(row.id)?.[model.stage]?.reviewed;
    if (row[model.stage]?.reviewed && !wasReviewed) row[model.stage+"_view"] = packageRecordVersion(row);
  }
  const next = snapshotPackageChanges();
  const event = packageEvent(action,packageSession.known,next,packageSession.events.length+1);
  if (event) {
    packageSession.events.push(event);
    trackPackageChanges(event);
    packageSession.known = next;
    dirty = true;
    const status = byId("package-save-state");
    if (status) status.textContent = "有修改待导出";
  }
}
function packageReviewRows() {
  return model.rows.filter(row=>requiresReview(row) &&
    (!packageSharedRows.has(row.id) || packageSharedPrimary.has(row.id)));
}
function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g,"_");
}
function packageExportName(contract,actor,stage,next) {
  const shorten = (value,limit)=>Array.from(safeName(value).replace(/[\s\-]+/g," ").trim()).slice(0,limit).join("").trim();
  const now = new Date();
  const two = value=>String(value).padStart(2,"0");
  const date = now.getFullYear()+two(now.getMonth()+1)+two(now.getDate());
  const time = two(now.getHours())+two(now.getMinutes())+two(now.getSeconds());
  return [shorten(contract,24)||"合同",shorten(actor,12)||"待署名",stage,date+"-"+time,next].join("-");
}
function choosePackageFilename(suggested,extension) {
  const dialog = dialogBox("确认导出文件名");
  dialog.classList.add("package-filename-dialog");
  dialog.setAttribute("aria-label","确认导出文件名");
  const form = node("form");
  const name = node("input");
  name.type = "text";
  name.value = suggested;
  name.required = true;
  name.size = 44;
  const confirm = node("button","下载","primary");
  confirm.type = "submit";
  const actions = node("div",null,"row-actions");
  actions.append(button("取消",()=>dialog.close()),confirm);
  form.append(labelled("文件名（"+extension+"）",name),actions);
  dialog.append(form);
  name.oninput = ()=>name.setCustomValidity("");
  return new Promise(resolve=>{
    let filename;
    form.onsubmit = event=>{
      event.preventDefault();
      let base = name.value.trim();
      if (base.toLowerCase().endsWith(extension)) base = base.slice(0,-extension.length).trim();
      if (!base || base.endsWith(".") || safeName(base)!==base ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base) ||
          utf8.encode(base+extension).length>240) {
        name.setCustomValidity("请输入有效的文件名，避免系统保留名称、斜杠和其他特殊字符，或缩短文件名。");
        return name.reportValidity();
      }
      filename = base+extension;
      dialog.close();
    };
    dialog.addEventListener("close",()=>resolve(filename),{once:true});
    name.focus();
    name.select();
  });
}
function downloadPackageFile(blob,filename) {
  const url = URL.createObjectURL(blob);
  const link = node("a");
  link.href = url;
  link.download = safeName(filename);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function packageInfo() {
  const bar = node("div",null,"package-info");
  const {manifest,actor} = packageSession;
  const version = node("span","第 "+manifest.round+" 轮 · 包版本 "+manifest.revision+" · "+manifest.package_id.slice(0,8),"small");
  version.id = "package-version";
  const status = node("span","无待导出的修改","small");
  status.id = "package-save-state";
  bar.append(version,node("span",actor ? "操作者 "+actor.name : "律师终版","small"),status);
  if (manifest.handoff?.actor) bar.append(node("span","上次交接 "+manifest.handoff.actor+" · "+manifest.handoff.action,"small"));
  if (manifest.handoff?.reason) bar.append(node("span","退回说明 "+manifest.handoff.reason,"wrap small"));
  if (manifest.handoff?.targets?.length) {
    bar.append(node("span",manifest.handoff.targets.length+" 条指定复核记录","small"));
  }
  return bar;
}
function packageMenu(label,items) {
  const menu = node("details",null,"package-menu");
  const panel = node("div",null,"package-menu-panel");
  for (const item of items) {
    item.addEventListener("click",()=>{ menu.open = false; },{capture:true});
    panel.append(item);
  }
  menu.append(node("summary",label),panel);
  menu.addEventListener("focusout",event=>{
    if (event.relatedTarget && !menu.contains(event.relatedTarget)) menu.open = false;
  });
  menu.addEventListener("keydown",event=>{
    if (event.key==="Escape") {
      menu.open = false;
      menu.querySelector("summary").focus();
      event.stopPropagation();
    }
  });
  return menu;
}
function packageHeader(actions) {
  actions.append(packageFileControl(),
    button("问题与律师建议",showPackageDiscussion),
    packageMenu("更多",[
      button("材料与来源",showPackageSources),
      button("复核记录",showLogs),
      button("预埋记录与检查报告",report)
    ]));
  if (model.stage==="final") {
    actions.append(button("导出标注集 Excel",exportPackageWorkbook,"primary"));
    return;
  }
  actions.append(button("导出当前进度",()=>saveHtml()));
  if (model.stage==="student") actions.append(button("提交给律师",()=>saveHtml("lawyer"),"primary"));
  else actions.append(button("导出律师终版 ZIP",()=>saveHtml("final"),"primary"));
}
function showPackageSources() {
  const dialog = dialogBox("材料与来源");
  const manifest = packageSession.manifest;
  dialog.append(node("p","批次 "+manifest.batch_id+" · 基线 "+manifest.baseline_sha256,"wrap small"));
  if (manifest.handoff?.reason) dialog.append(node("p","退回说明 "+manifest.handoff.reason,"wrap"));
  for (const source of manifest.sources) {
    const item = node("div",null,"card");
    item.append(node("strong",source.name),node("p",source.purpose,"small"),node("p","SHA-256 "+source.sha256,"wrap small"),
      button("下载原文件",()=>downloadPackageFile(new Blob([packageSession.contents.get(source.entry)]),source.name)));
    dialog.append(item);
  }
  if (!manifest.sources.length) dialog.append(node("p","本包没有附源文件。"));
}
function showPackageDiscussion() {
  if (openEditor) return setNotice("请先应用或取消当前编辑。");
  const dialog = dialogBox("问题与律师建议");
  if (model.stage==="student") dialog.append(button("提出合同问题",()=>{dialog.close();editDiscussion("question");}));
  if (model.stage==="lawyer") dialog.append(button("新建建议",()=>{dialog.close();editDiscussion("suggestion");}));
  appendDiscussion(dialog,model.stage==="lawyer");
}
function appendPackageLog(dialog) {
  const log = node("details",null,"package-history");
  log.append(node("summary","按人员和轮次查看操作（"+packageSession.events.length+"）"));
  for (const event of [...packageSession.events].reverse()) {
    const entry = node("details",null,"change");
    entry.append(node("summary","第 "+event.round+" 轮 · "+roleTitle[event.role]+" "+event.actor+" · "+event.action+" · "+event.at));
    entry.addEventListener("toggle",()=>{
      if (!entry.open || entry.children.length>1) return;
      for (const change of event.rows) {
        entry.append(node("strong",[change.id,...packageSourceFields.map(field=>change.after.fields[field])].filter(Boolean).join(" · ")));
        for (const key of model.fields) {
          const before = change.before?.fields?.[key],after = change.after.fields?.[key];
          if (before!==after) entry.append(node("p",key+"\n原值　"+(before||"（空）")+"\n改后　"+(after||"（空）"),"wrap small"));
        }
        for (const role of packageRoles) {
          if (!samePackageValue(change.before?.[role],change.after[role])) {
            entry.append(node("p",roleTitle[role]+"复核意见或确认\n原值　"+JSON.stringify(change.before?.[role] ?? null)+"\n改后　"+JSON.stringify(change.after[role] ?? null),"wrap small"));
          }
        }
      }
      for (const change of event.state) {
        entry.append(node("p",change.key+"\n原值　"+JSON.stringify(change.before)+"\n改后　"+JSON.stringify(change.after),"wrap small"));
      }
    });
    log.append(entry);
  }
  dialog.append(log);
}
async function savePackage(nextStage) {
  if (packageBusy || !packageSession?.actor) return;
  if (openEditor) return setNotice("请先应用或取消当前编辑。");
  const handoff = nextStage!==model.stage;
  const action = nextStage==="final" ? "保存律师终版" : handoff ? "提交给律师" : "导出当前进度";
  const required = model.rows.filter(requiresReview);
  if (handoff && nextStage!=="final" && required.some(row=>!isReviewed(row))) {
    return setNotice(required.some(row=>!isReviewed(row) && packageCurrentRemoval(row)) ?
      "还有删除事项待确认，请查看「更多」→「复核记录」。" : "还有标注待确认，可先导出当前进度。");
  }
  if (nextStage==="final") {
    const failures = finalPackageIssues(model,false);
    if (failures.length) return showPackageFailures(failures);
  }
  const student = model.stage==="student";
  const contractName = model.title;
  const stage = student ? "实习生初审" : "律师复核";
  const nextStep = handoff ? (student ? "交律师" : "交实习生验收") : (student ? "继续初审" : "继续复核");
  const filename = await choosePackageFilename(packageExportName(contractName,packageSession.actor.name,stage,nextStep),".zip");
  if (!filename) return;
  capturePackageChange("保存本轮修改");
  const prior = packageSession.manifest;
  const target = structuredClone(model);
  target.stage = nextStage;
  if (nextStage==="final") {
    target.lawyer_opinion_required = false;
    target.review_related = true;
  }
  const next = snapshotPackageChanges(target);
  const event = handoff ? packageEvent(action,packageSession.known,next,packageSession.events.length+1) : null;
  const events = event ? [...packageSession.events,event] : [...packageSession.events];
  const manifest = {
    ...prior,package_id:crypto.randomUUID(),parents:[prior.package_id],revision:prior.revision+1,
    stage:nextStage,
    handoff:handoff ? {action,actor:packageSession.actor.name,role:model.stage,at:new Date().toISOString()} : prior.handoff
  };
  packageBusy = root.inert = true;
  try {
    if (packagePairs(target).length) validatePackageVersionPair(packageSession.baseline,target);
    const zip = await exportReviewPackage(packageSession,manifest,events);
    downloadPackageFile(zip,filename);
    seenPackageHeads.set(manifest.baseline_sha256,manifest);
    dirty = false;
    if (handoff) {
      packageSession = null;
      bootPackage("已发起下载「"+action+"」ZIP。交接时发送这份文件。");
    } else {
      packageSession.manifest = manifest;
      byId("package-version").textContent = "第 "+manifest.round+" 轮 · 包版本 "+manifest.revision+" · "+manifest.package_id.slice(0,8);
      byId("package-save-state").textContent = "无待导出的修改";
      setNotice("已发起下载当前进度 ZIP。");
    }
  } catch (error) {
    setNotice("导出失败，当前修改仍保留。"+error.message);
  } finally {
    packageBusy = root.inert = false;
  }
}
const normalizeClauseText = value=>value.replace(/\r\n?/g,"\n");

function clauseMismatchIssue(row,contract,sectionId) {
  const actual = normalizeClauseText(row.fields[keyClause]);
  const section = contract?.sections.find(item=>item.id===sectionId);
  const exactElsewhere = contract?.sections.filter(item=>item.id!==sectionId && normalizeClauseText(item.text)===actual) || [];
  let reason, instruction;
  if (!contract) {
    reason = "这条标注没有对应到数据包中的合同，系统无法核对条款原文。";
    instruction = "进入“编辑字段”，展开“更正合同、规则或切片定位”。选对合同和条款后，工具会带出完整原文。";
  } else if (exactElsewhere.length===1) {
    reason = "字段里的原文完整对应另一条款「"+exactElsewhere[0].heading+"」（"+exactElsewhere[0].id+"），与当前定位不一致。";
    instruction = "核对本卡应该引用哪条，再从“编辑字段”确认或更正定位。工具会按定位带出完整原文。";
  } else if (!section) {
    reason = row.section_id ? "当前定位编号「"+row.section_id+"」在该合同中不存在。" :
      "这条标注未定位到具体条款，当前填写的原文也没有匹配到完整条款。";
    instruction = "进入“编辑字段”，展开“更正合同、规则或切片定位”。选中对应条款后，工具会带出完整原文。";
  } else if (!actual.trim()) {
    reason = "这条标注定位到了具体条款，但“条款原文”为空。";
    instruction = "如果定位正确，恢复该条款的完整原文。";
  } else {
    reason = "“条款原文”与左栏定位到的完整条款不一致。摘录、删字、改写或空白符变化都可能触发这项校验。";
    instruction = "如果定位正确，恢复该条款的完整原文。想摘录支持判断的句子，请放在“风险判断关键证据”；律师意见或拟改文字请分别填在复核意见或修订建议。";
  }
  return {field:keyClause,section,actual,reason,instruction,
    canRestore:!!section && !exactElsewhere.length && contract.name===row.fields["合同附件名称"]};
}

function clauseDifference(actual,expected) {
  const current = Array.from(actual), source = Array.from(normalizeClauseText(expected));
  let at = 0;
  while (at<current.length && at<source.length && current[at]===source[at]) at++;
  const visible = char=>{
    if (!char) return "（已到末尾）";
    const space = {" ":"␠","\t":"⇥","\n":"↵\n","　":"□","\u00a0":"⍽"};
    return space[char] ?? char;
  };
  const snippet = (title,characters)=>{
    const block = node("div",null,"package-issue-snippet");
    const start = Math.max(0,at-18), end = Math.min(characters.length,at+30);
    const line = node("p",null,"wrap");
    if (start) line.append("…");
    line.append(characters.slice(start,at).map(visible).join(""),
      node("mark",visible(characters[at])),characters.slice(at+1,end).map(visible).join(""));
    if (end<characters.length) line.append("…");
    block.append(node("strong",title+"（"+characters.length+" 字符）"),line);
    return block;
  };
  const comparison = node("div",null,"package-issue-comparison");
  comparison.append(node("p","首处差异在第 "+(at+1)+" 个字符。␠ 表示空格，⇥ 表示制表符，↵ 表示换行。","small"),
    snippet("当前标注原文",current),snippet("对应合同原文",source));
  return comparison;
}

function locatePackageIssue(issue,dialog,{restore,field,editBinding,rowId=issue.rowId}={}) {
  const row = rowById.get(rowId);
  if (openEditor) return;
  if (restore) {
    if (model.stage!=="lawyer" || !row || fixedPackageBindingFields(row).includes(keyClause) ||
        !restore.canRestore || row.section_id!==restore.section.id) return;
    const before = structuredClone(row);
    row.fields[keyClause] = restore.section.text;
    invalidatePackageReview(row,before);
    reviewData(row,"lawyer").reviewed = false;
    changed("恢复完整条款原文");
  }
  dialog.close();
  const contract = row?.contract_id ?? issue.contractId;
  const section = rowId===issue.rowId || !row ? issue.section?.id : row.section_id;
  resetRiskFilters(contract);
  revealPackageRowVersion(row || {contract_id:contract},section);
  render();
  if (row) {
    openPackageDetail(row,"lawyer");
    focusPackageRow(row.id,false,"lawyer");
    if ((field || editBinding) && model.stage==="lawyer") {
      const page = packageDetailPages.get("lawyer").element;
      const edit = page.querySelector(".package-field-toggle");
      if (edit) {
        edit.click();
        const binding = editBinding ? page.querySelector("#bind-rule")?.closest("details") : null;
        if (binding) binding.open = true;
        const control = binding?.querySelector("summary") ||
          [...page.querySelectorAll("[data-field]")].find(input=>input.dataset.field===field);
        control?.scrollIntoView({block:"center"});
        control?.focus({preventScroll:true});
      }
    }
  }
  if (section) {
    const slot = packageSectionSlots.get(packageSectionKey(contract,section));
    if (slot!==undefined) {
      align(byId("left"),leftSections.get(slot));
      activatePackageSection(slot);
    }
  }
  if (restore) setNotice("已恢复完整条款原文。请核对关键证据仍来自该条款，重新确认本条后再导出终版。");
}

function showPackageFailures(issues) {
  const dialog = dialogBox("终版校验未通过");
  dialog.setAttribute("aria-label","终版校验未通过");
  dialog.append(node("p","有 "+issues.length+" 项待处理。点下方按钮可直接跳转到对应条款、标注或复核记录。","small"));
  for (const issue of issues) {
    const row = rowById.get(issue.rowId);
    const fixedFields = row ? fixedPackageBindingFields(row) : [];
    const item = node("section",null,"card package-validation-issue");
    item.append(node("h3",[issue.riskName || issue.title,issue.stance].filter(Boolean).join(" · "),"wrap"));
    if (issue.contractName) item.append(node("p",issue.contractName,"wrap small"));
    if (issue.location) item.append(node("p",issue.location,"wrap small"));
    if (issue.question) item.append(node("p",issue.question.text,"wrap"));
    for (const problem of issue.problems) {
      const block = node("div",null,"package-validation-problem");
      if (problem.field) block.append(node("strong",problem.field));
      block.append(node("p",problem.reason,"wrap"));
      if (problem.instruction) block.append(node("p",problem.instruction,"wrap small"));
      if (problem.section && problem.actual!==normalizeClauseText(problem.section.text)) {
        block.append(clauseDifference(problem.actual,problem.section.text));
      }
      if (problem.relatedRowId) {
        const other = rowById.get(problem.relatedRowId);
        const label = sourceRowLabel(other?.id);
        block.append(button("查看另一条标注"+(label ? " · "+label : ""),()=>locatePackageIssue(issue,dialog,{rowId:problem.relatedRowId})));
      }
      if (row && model.stage==="lawyer" && problem.editField && !packageBoundFields.includes(problem.editField) && !packageCurrentRemoval(row)) {
        block.append(button("编辑"+problem.field,()=>locatePackageIssue(issue,dialog,{field:problem.editField})));
      }
      item.append(block);
    }
    const actions = node("div",null,"row-actions");
    if (issue.question) actions.append(button("查看并审核问题",()=>{
      dialog.close();
      const question = dialogBox("实习生问题");
      question.append(discussionCard(issue.question,"question",model.stage==="lawyer"));
    }));
    if (row && issue.problems.some(problem=>problem.logs)) {
      actions.append(button("查看复核记录",()=>{dialog.close();showLogs(row.id);}));
    }
    if (row) actions.append(button("定位并查看标注",()=>locatePackageIssue(issue,dialog)));
    else if (issue.section) actions.append(button("定位合同条款",()=>locatePackageIssue(issue,dialog)));
    if (row && model.stage==="lawyer" && !packageCurrentRemoval(row) && issue.problems.some(problem=>
        problem.editBinding || (packageBoundFields.includes(problem.field) && !fixedFields.includes(problem.field)))) {
      actions.append(button("核对合同、规则或切片定位",()=>locatePackageIssue(issue,dialog,{editBinding:true})));
    }
    const restore = issue.problems.find(problem=>problem.canRestore);
    if (model.stage==="lawyer" && restore && !fixedFields.includes(keyClause) && row?.section_id===restore.section.id) {
      actions.append(button("恢复此条完整原文",()=>locatePackageIssue(issue,dialog,{restore}),"primary"));
    }
    item.insertBefore(actions,item.querySelector(".package-validation-problem"));
    if (issue.rowId && !sourceRowLabel(issue.rowId)) {
      const reference = node("details",null,"small");
      reference.append(node("summary","记录编号"),node("p",issue.rowId,"wrap"));
      item.append(reference);
    }
    dialog.append(item);
  }
}
function sourceRowLabel(id) {
  const row = packageSourceRow(id);
  return row ? (row.workbook ? "来源表 "+row.workbook+" · " : "来源表 · ")+"第 "+row.number+" 行" : "";
}
async function exportPackageWorkbook() {
  if (model.stage!=="final") return setNotice("请导入律师终版 ZIP。");
  const issues = finalPackageIssues(model,model.lawyer_opinion_required===true);
  if (issues.length) return showPackageFailures(issues);
  const contractName = model.title;
  const reviewer = packageSession.manifest.handoff?.actor || "";
  const filename = await choosePackageFilename(packageExportName(contractName,reviewer,"只读验收","归档"),".xlsx");
  if (!filename) return;
  try {
    const {blob,count,removed} = workbookForProject(model);
    downloadPackageFile(blob,filename);
    setNotice("已发起下载 "+filename+"，共 "+count+" 条 × 15 列。"+
      (removed ? "已排除 "+removed+" 条确认删卡记录。" : ""));
  } catch (error) {
    setNotice("Excel 导出失败。"+error.message);
  }
}

function packageAnchors() {
  return [["left",leftSections],["right",rightSections],["lawyer-pane",lawyerSections]];
}
const packageSectionKey = (contract,section)=>JSON.stringify([contract,section]);
function activePackagePair() {
  return packagePairByContract.get(contractId);
}
function packagePairName(pair) {
  const [first,peer] = pair.contracts.map(id=>contractById.get(id).name.replace(/\.docx$/i,""));
  let length = 0;
  while (length<first.length && first[length]===peer[length]) length++;
  const common = first.slice(0,length).replace(/[\s_.·—–+（(【-]+$/u,"");
  return (common || first)+"（双版本）";
}
function packageVersionOptions() {
  const pair = activePackagePair();
  if (!pair) {
    const stances = new Set(model.rows.filter(row=>row.contract_id===contractId).map(row=>get(row,"立场")).filter(Boolean));
    if (stances.size<2) {
      const applicable = model.applicability?.[contractId];
      for (const rule of model.rules) {
        if (rule.stance && (!applicable || applicable.includes(rule.id))) stances.add(rule.stance);
      }
    }
    return [...stances].sort().map(stance=>[stance,stance]);
  }
  const versions = pair.contracts.map(id=>{
    const stances = new Set(model.rows.filter(row=>row.contract_id===id).map(row=>get(row,"立场")).filter(Boolean));
    return [id,stances.size===1 ? [...stances][0] : ""];
  });
  if (versions[0][1] && versions[1][1] && versions[0][1]!==versions[1][1]) return versions;
  return versions.map(([id])=>[id,contractById.get(id).name.replace(/\.docx$/i,"")]);
}
function configurePackageContract(id) {
  contractId = packagePairByContract.get(id)?.contracts[0] || (contractById.has(id) ? id : "");
  const input = byId("stance");
  input.replaceChildren();
  option(input,"","全部");
  for (const [value,label] of packageVersionOptions()) option(input,value,label);
  setPackageVersionFilter("");
}
function setPackageVersionFilter(version,keepChoices=false) {
  const input = byId("stance");
  input.value = input.dataset.past = version;
  if (keepChoices) return;
  packageStanceChoices.clear();
  packageVersionChoices.clear();
  const pair = activePackagePair();
  if (pair && version===pair.contracts[1]) {
    for (const [id] of pair.sections) packageVersionChoices.add(id);
  }
}
function stylePackageVersion(element,source,stanceIndex) {
  const version = packagePairByContract.get(source)?.contracts.indexOf(source) ?? stanceIndex;
  if (version===0 || version===1) element.dataset.contractVersion = version===0 ? "first" : "second";
}
function packageDistinctCardSections(contractIds) {
  const wanted = new Set(contractIds);
  const sections = new Set();
  const roles = showLawyerColumn() ? packageRoles : ["student"];
  for (const row of model.rows) {
    if (packageSharedRows.has(row.id) || (!requiresReview(row) && !showFinalPackageChange(row))) continue;
    for (const role of roles) {
      if (role==="student" && model.stage!=="student" && row.lawyer_review_only===true) continue;
      const view = roleProjection(row,role);
      if (!wanted.has(view.contract_id) || packageCardHidden(row,role,view)) continue;
      const source = packageSectionsByContract.get(view.contract_id) || [];
      const section = view.section_id || resolveSection(view,source);
      if (section) sections.add(packageSectionKey(view.contract_id,section));
    }
  }
  return sections;
}
function packageSectionPlan() {
  if (packageVersionBase!==contractId) {
    packageVersionBase = contractId;
    for (const [role,page] of packageDetailPages) {
      page.element.remove();
      byId(packageSide[role]).hidden = false;
    }
    packageDetailPages.clear();
  }
  packageSectionsByContract = new Map(model.contracts.map(contract=>[contract.id,currentSections(contract.id)]));
  const sections = packageSectionsByContract.get(contractId) || [];
  packageSectionSlots = new Map();
  const pair = activePackagePair();
  const version = pair ? byId("stance").value : "";
  const listVersions = packageViewMode==="list";
  const hasSingleWordFlip = !pair && !listVersions && packageVersionOptions().length>1;
  const distinct = hasSingleWordFlip ? packageDistinctCardSections([contractId]) : new Set();
  if (pair && !listVersions) for (const row of model.rows) {
    if (row.scope==="slice" && (requiresReview(row) || showFinalPackageChange(row)) && !packageSharedRows.has(row.id)) {
      distinct.add(packageSectionKey(row.contract_id,row.section_id));
    }
  }
  const side = pair ? pair.contracts.indexOf(contractId) : -1;
  const otherId = side<0 ? "" : pair.contracts[1-side];
  const counterparts = new Map(side<0 ? [] : pair.sections.map(ids=>[ids[side],ids[1-side]]));
  const otherSections = new Map((packageSectionsByContract.get(otherId) || []).map(section=>[section.id,section]));
  const plan = [];
  const peerSections = [...otherSections.values()];
  let nextPeer = 0;
  function appendSection(actual,source,id,details) {
    packageSectionSlots.set(packageSectionKey(source,actual.id),id);
    plan.push({id,actual,source,...details});
  }
  function appendPeerOnly(beforeId) {
    while (nextPeer<peerSections.length && peerSections[nextPeer].id!==beforeId) {
      const actual = peerSections[nextPeer++];
      if (version && version!==otherId) continue;
      appendSection(actual,otherId,otherId+":"+actual.id,{standalone:true});
    }
  }
  for (const section of sections) {
    const other = otherSections.get(counterparts.get(section.id));
    if (other) {
      appendPeerOnly(other.id);
      nextPeer++;
    }
    if (pair && listVersions) {
      if (!version || version===contractId) appendSection(section,contractId,section.id,{standalone:true});
      if (other && (!version || version===otherId)) appendSection(other,otherId,otherId+":"+other.id,{standalone:true});
      continue;
    }
    if (!other && version && version!==contractId) continue;
    const flipped = !!other && packageVersionChoices.has(section.id);
    const actual = flipped ? other : section;
    const source = flipped ? otherId : contractId;
    const hasOwnCards = distinct.has(packageSectionKey(contractId,section.id));
    const switchable = pair ? !!other && (section.text!==other.text || hasOwnCards ||
      distinct.has(packageSectionKey(otherId,other.id))) : hasSingleWordFlip && hasOwnCards;
    appendSection(actual,source,section.id,{otherId:flipped ? contractId : otherId,switchable,standalone:!!otherId && !other});
  }
  appendPeerOnly();
  return plan;
}
function revealPackageRowVersion(row,sectionId=row.section_id) {
  const pair = activePackagePair();
  const side = pair?.contracts.indexOf(row.contract_id);
  if (side!==0 && side!==1) return;
  const filtered = byId("stance").value;
  if (filtered && filtered!==row.contract_id) setPackageVersionFilter("",true);
  if (packageViewMode==="list") return;
  const ids = pair.sections.find(sections=>sections[side]===sectionId);
  if (!ids) return;
  if (side===1) packageVersionChoices.add(ids[0]);
  else packageVersionChoices.delete(ids[0]);
}
function packageSlot(view) {
  const pair = activePackagePair();
  if (!pair) {
    if (view.contract_id===contractId || (contractId==="" && !contractById.has(view.contract_id))) {
      return resolveSection(view,packageSectionsByContract.get(contractId) || []);
    }
    return;
  }
  const actual = packageSectionsByContract.get(view.contract_id);
  const section = actual?.some(section=>section.id===view.section_id) ? view.section_id : resolveSection(view,actual || []);
  if (section) return packageSectionSlots.get(packageSectionKey(view.contract_id,section));
  const version = byId("stance").value;
  if ((!version || version===view.contract_id) && pair.contracts.includes(view.contract_id)) return "";
}
function flipPackageVersion(id) {
  if (openEditor) return setNotice("请先应用或取消当前编辑，再切换立场。");
  if (packageDetailPages.size) capturePackageChange("保存复核意见");
  for (const role of [...packageDetailPages.keys()]) closePackageDetail(role);
  if (activePackagePair()) {
    setPackageVersionFilter("",true);
    if (!packageVersionChoices.delete(id)) packageVersionChoices.add(id);
  } else {
    const values = packageVersionOptions().map(([value])=>value);
    const current = packageStanceChoices.get(id) ?? byId("stance").value;
    packageStanceChoices.set(id,values[(values.indexOf(current)+1)%values.length]);
  }
  selected = "";
  render(true);
  animatePackageFlip(id);
  leftSections.get(id)?.querySelector(".package-flip")?.focus({preventScroll:true});
}
function animatePackageFlip(id) {
  if (!leftSections.has(id)) return;
  const flipped = packageAnchors().map(([side,anchors])=>{
    const section = anchors.get(id);
    align(byId(side),section);
    return section;
  });
  activatePackageSection(id);
  for (const section of flipped) section?.classList.add("package-version-enter");
}
function activatePackageSection(id) {
  if (id===activeSectionId) return;
  for (const [,anchors] of packageAnchors()) {
    anchors.get(activeSectionId)?.classList.remove("active");
    anchors.get(id)?.classList.add("active");
  }
  activeSectionId = id;
}
function syncPackagePanes(side) {
  const columns = packageAnchors();
  const origin = [...(columns.find(([id])=>id===side)?.[1] || [])];
  const from = byId(side);
  if (!from || from.hidden || !origin.length) return;
  const unpaired = from.querySelector(".row-section[data-section='']");
  if (unpaired && from.scrollTop>=anchorTop(from,unpaired)-0.5) return activatePackageSection("");
  const next = origin.findIndex(([,item])=>anchorTop(from,item)>from.scrollTop+0.5);
  const index = next<0 ? origin.length-1 : Math.max(0,next-1);
  const id = origin[index][0];
  const [begin,end] = sectionRange(from,origin,index);
  const progress = Math.max(0,Math.min(1,(from.scrollTop-begin)/(end-begin)));
  for (const [target,anchors] of columns) {
    if (side===target) continue;
    const pairs = [...anchors];
    const match = pairs.findIndex(([key])=>key===id);
    if (match<0) continue;
    const to = byId(target);
    if (to.hidden) continue;
    const [start,finish] = sectionRange(to,pairs,match);
    writeScroll(to,start+progress*(finish-start));
  }
  activatePackageSection(id);
}
function focusPackageRow(id,move=true,role) {
  const cards = role==="lawyer" ? [lawyerCards.get(id),rowElements.get(id)] : [rowElements.get(id),lawyerCards.get(id)];
  const row = rowById.get(id);
  if (!row) return false;
  selected = id;
  const section = cards.find(Boolean)?.closest(".row-section").dataset.section ?? packageSlot(row);
  let evidence;
  for (const mark of byId("left").querySelectorAll("mark")) {
    const active = JSON.parse(mark.dataset.rows).includes(id);
    mark.classList.toggle("target",active);
    if (active && !evidence) evidence = mark;
  }
  align(byId("left"),evidence || leftSections.get(section));
  if (move) {
    for (const [side,anchors] of packageAnchors().slice(1)) {
      const target = (side==="right" ? rowElements : lawyerCards).get(id);
      if (!byId(side).hidden) align(byId(side),target || anchors.get(section));
    }
  }
  for (const card of [...rowElements.values(),...lawyerCards.values()]) card.classList.toggle("selected",card.dataset.row===id);
  activatePackageSection(section);
  return true;
}

function indexHandoffChanges(events) {
  const result = new Map();
  for (const role of packageRoles) {
    const handoff = events.findLast(event=>event.role===role && event.state.some(change=>change.key==="stage"));
    if (!handoff) continue;
    const records = new Map();
    for (const event of events) {
      if (event.role!==role || event.round!==handoff.round || event.seq>handoff.seq) continue;
      for (const {id,before,after} of event.rows) {
        const prior = records.get(id);
        records.set(id,{before:prior ? prior.before : before,after});
      }
    }
    result.set(role,records);
  }
  return result;
}

function handoffMark(row,view,role) {
  if (model.stage===role) return null;
  const records = packageSession.handoffChanges.get(role);
  const change = records?.get(row.id);
  if (!change) {
    // Legacy snapshots lack a round boundary. Only label changes evidenced by a submitted snapshot.
    if (records || role!=="student" || !row.submitted_fields || !row.original_fields) return null;
    const fields = model.fields.filter(field=>get(view,field)!==asText(row.original_fields[field]));
    return fields.length ? {label:"历史提交有改动",tone:"edited",fields,before:row.original_fields} : null;
  }
  const before = change.before?.fields || {};
  const after = change.after.fields;
  const fields = model.fields.filter(field=>asText(before[field])!==asText(after[field]));
  const note = asText(change.before?.[role]?.note)!==asText(change.after[role]?.note);
  const binding = packageBindingChanged(change.before,change.after);
  const priorRisk = before[riskField], nextRisk = after[riskField];
  const removal = roleRemoval(change.after,change.after,role);
  const removed = removal && !samePackageValue(removal,roleRemoval(change.before || {},change.before || {},role));
  const latest = change.after.review_history?.at(-1);
  const judgmentChanged = (latest?.action==="restore" || Object.values(packageJudgmentLabels).includes(latest?.action)) &&
    !samePackageValue(latest,change.before?.review_history?.at(-1));
  const information = {fields,before,note,binding,judgmentChanged};
  if (judgmentChanged && latest.action==="restore") return {...information,label:"本轮恢复",tone:"edited"};
  if (removed || (priorRisk==="是" && nextRisk==="否" && !judgmentChanged)) return {...information,label:"本轮删除",tone:"removed"};
  if ((priorRisk!=="是" && nextRisk==="是") || (!packageCardType(before) && packageUntriggeredCard(after))) {
    return {...information,label:"本轮补标",tone:"edited"};
  }
  if (fields.length || binding || judgmentChanged) return {...information,label:"本轮有改动",tone:"edited"};
  if (note) return {...information,label:"补充意见",tone:"edited"};
  if (change.after[role]?.reviewed) return removal ? {...information,label:"已确认删除",tone:"removed"} :
    {...information,label:"仅确认",tone:"confirmed"};
  return null;
}
function roleRemoval(row,view,role) {
  if (role==="lawyer" && model.stage==="lawyer") {
    return packageCurrentRemoval(row) ? latestPackageJudgment(row) : null;
  }
  if (get(view,riskField)!=="否") return null;
  const effectiveRole = role==="lawyer" && model.stage==="final" ? undefined : role;
  const latest = latestPackageJudgment(row,effectiveRole);
  return latest?.action==="remove" ? latest : null;
}
function awaitingHandoffConfirmation(row,role) {
  if (model.stage!==role || row[role]?.reviewed) return false;
  const other = role==="student" ? "lawyer" : "student";
  const view = {...row,...roleProjection(row,other)};
  const change = handoffMark(row,view,other);
  return !!(change?.fields.length || change?.binding || change?.judgmentChanged || change?.tone==="removed");
}
function refreshPackageReviewBadges(row,role) {
  const card = (role==="student" ? rowElements : lawyerCards).get(row.id);
  const page = packageDetailPages.get(role);
  const detail = page?.rowId===row.id ? page.element : null;
  const view = {...row,...roleProjection(row,role)};
  for (const item of [card,detail]) {
    const previous = item?.querySelector(".package-card-badges");
    if (!previous) continue;
    const status = packageReviewStatus(row,role);
    previous.replaceWith(packageCardBadges(row,view,role,status));
  }
}
function packageCardBadges(row,view,role,status) {
  const box = node("div",null,"package-card-badges");
  const removal = roleRemoval(row,view,role);
  const judgment = removal?.before ? packageJudgmentBadge({...view,fields:removal.before},"删除前：") :
    packageJudgmentBadge(view);
  if (judgment) box.append(judgment);
  if (packageSharedRows.has(row.id)) box.append(node("span","通用 · 两版共用复核","badge"));
  const change = handoffMark(row,view,role);
  if (change) box.append(node("span",change.label,"badge package-change-"+change.tone));
  if (removal && change?.tone!=="removed") {
    const label = role==="lawyer" && removal.stage==="student" ? "实习生已删除" : "已删除";
    box.append(node("span",label,"badge package-change-removed"));
  }
  if (awaitingHandoffConfirmation(row,role)) {
    box.append(node("span","改动待确认","badge empty"));
  } else if (model.stage===role && packageSession.manifest.handoff?.targets?.includes(row.id) && !row[role]?.reviewed) {
    box.append(node("span","退回待核对","badge empty"));
  }
  box.append(status);
  return box;
}
function matchesPackageRiskFilter(row,scope) {
  return scope==="review" || packageCardType(row.fields)===scope;
}
function showFinalPackageChange(row) {
  return model.stage==="final" && byId("change-status").value==="changed" && packageSession.changedRows.has(row.id);
}
function packageCardHidden(row,role,view={...row,...roleProjection(row,role)}) {
  if (showFinalPackageChange(row)) return false;
  const removal = roleRemoval(row,view,role);
  if (removal && (role==="student" ? model.stage!=="student" : model.stage==="lawyer")) return false;
  const unrelated = item=>item.scope!=="full_missing" && get(item,keyRelevant)!=="是" && !packageCardType(item.fields);
  return unrelated(row) || packageCurrentRemoval(row) || unrelated(view) || !!removal;
}
function packageJudgmentBadge(view,prefix="") {
  const type = packageCardType(view.fields);
  if (type) {
    const tone = type==="no-attention" ? "package-no-attention" :
      type==="related-clear" ? "package-related-clear" : "risk";
    return node("span",prefix+packageCardLabels.get(type),"badge "+tone);
  }
  if (view.scope==="full_missing" && get(view,riskField)==="否") {
    return node("span",prefix+"全文缺失未触发","badge package-related-clear");
  }
  return null;
}
function packageReviewStatus(row,role) {
  const missingLegacyConfirmation = model.stage==="final" && model.review_related!==true && requiresUntriggeredReview(row) && !requiresRiskReview(row);
  const status = node("span",row[role]?.reviewed ? "已复核" : missingLegacyConfirmation ? "历史未确认" : "待复核","badge");
  status.dataset.reviewed = "";
  return status;
}

function showLawyerColumn() {
  return model.stage!=="student" || packageSession.handoffChanges.has("lawyer") ||
    model.rows.some(row=>row.lawyer?.reviewed || row.lawyer?.note || row.lawyer_view);
}
function canComparePackageRole(row,role,lawyerVisible=showLawyerColumn()) {
  return (role==="student" ? lawyerVisible : row.lawyer_review_only!==true) &&
    !packageCardHidden(row,oppositePackageRole(role));
}
function shownPackageRows(role) {
  const scope = byId("scope").value, status = byId("review-status").value;
  const pair = activePackagePair();
  const stance = pair ? "" : byId("stance").value;
  const search = byId("search").value.trim().toLowerCase();
  const changeStatus = byId("change-status").value;
  if (role==="lawyer" && !showLawyerColumn()) return [];
  return model.rows.flatMap(row=>{
    const changed = packageSession.changedRows.has(row.id);
    if (changeStatus && changed!==(changeStatus==="changed")) return [];
    if (model.stage!=="student" && role==="student" && row.lawyer_review_only===true) return [];
    const view = {...row,...roleProjection(row,role)};
    const pending = role===model.stage && get(row,riskField)==="是" && !row[role]?.reviewed && get(view,riskField)!=="是";
    if (pending && !get(view,"风险名称")) Object.assign(view,packageRecordVersion(row));
    if (packageCardHidden(row,role,view)) return [];
    const section = packageSlot(view);
    if (section===undefined) return [];
    const removal = roleRemoval(row,view,role);
    if (!pending && !packageCardType(view.fields) &&
        !requiresReview(row) && !removal && !awaitingHandoffConfirmation(row,role) && changeStatus!=="changed") return [];
    const desiredStance = packageStanceChoices.get(section) ?? stance;
    if (desiredStance && get(view,"立场")!==desiredStance) return [];
    if (!matchesPackageRiskFilter(removal?.before ? {...view,fields:removal.before} : view,scope)) return [];
    if (role===model.stage && status && !!row[role]?.reviewed!==(status==="reviewed")) return [];
    if (search && ![row.id,get(view,"风险名称"),get(view,keyEvidence)].some(text=>text.toLowerCase().includes(search))) return [];
    return [{row,view,section}];
  });
}
function packageRoleCards(role) {
  return role==="student" ? rowElements : lawyerCards;
}
function nextPackageRow(row,role) {
  const cards = packageRoleCards(role);
  const order = [...cards.keys()];
  const index = order.indexOf(row.id);
  if (index>=0) return rowById.get(order[index+1]);
  // The active filter can hide the open detail after confirmation or a status change.
  const sectionOrder = new Map([...leftSections.keys(),""].map((id,i)=>[id,i]));
  const view = {...row,...roleProjection(row,role)};
  const section = sectionOrder.get(packageSlot(view));
  const laterRows = new Set(model.rows.slice(model.rows.indexOf(row)+1).map(item=>item.id));
  return rowById.get(order.find(id=>{
    const position = sectionOrder.get(cards.get(id).closest(".row-section").dataset.section);
    return position>section || (position===section && laterRows.has(id));
  }));
}
function oppositePackageRole(role) {
  return role==="student" ? "lawyer" : "student";
}
function alignPackageCounterpart(row,role) {
  const other = oppositePackageRole(role);
  const card = packageRoleCards(other).get(row.id);
  if (!card) return setNotice("另一栏当前列表没有这条标注，请检查筛选条件。");
  if (!closePackageDetail(other)) return;
  align(byId(packageSide[other]),card);
  card.querySelector(".package-edit-button").focus({preventScroll:true});
}
function advancePackageList(next,role) {
  if (!closePackageDetail(oppositePackageRole(role))) return;
  focusPackageRow(next.id,true,role);
  packageRoleCards(role).get(next.id)?.querySelector(".package-edit-button").focus({preventScroll:true});
}
function packageCardMetadata(view,tail) {
  const info = node("p",null,"small");
  const stance = get(view,"立场");
  const attachment = packagePairByContract.has(view.contract_id) && view.scope==="full_missing" ? get(view,"合同附件名称") : "";
  const rest = [get(view,"风险等级"),tail,attachment].filter(Boolean).join(" · ");
  if (stance) info.append(node("strong",stance,"package-card-stance"));
  if (rest) info.append((stance ? " · " : "")+rest);
  return info;
}
function packageCard(row,view,role,lawyerVisible,next) {
  const card = node("article",null,"card package-card");
  card.dataset.row = row.id;
  stylePackageVersion(card,view.contract_id);
  const status = packageReviewStatus(row,role);
  const head = node("div",null,"card-head");
  head.append(node("strong",get(view,"风险名称") || "缺少风险名称"),packageCardBadges(row,view,role,status));
  const removal = roleRemoval(row,view,role);
  if (removal) card.classList.add("package-removed-card");
  const summary = node("dl",null,"summary-grid package-card-summary");
  for (const field of [keyEvidence,"风险说明","修订建议"]) detailItem(summary,field,get(view,field));
  const actions = node("div",null,"row-actions");
  actions.append(button("查看细节",()=>openPackageDetail(row,role),"package-edit-button"),
    button("定位原文",()=>focusPackageRow(row.id,false)));
  if (canComparePackageRole(row,role,lawyerVisible)) actions.append(button("对照另一栏",()=>alignPackageCounterpart(row,role)));
  const advance = button("下一条",()=>advancePackageList(next,role));
  advance.disabled = !next;
  actions.append(advance);
  card.append(head,packageCardMetadata(view,view.scope==="full_missing" ? "全文缺失" : ""));
  if (removal) card.append(node("p","删除理由："+asText(removal.reason),"wrap small package-removal-reason"));
  card.append(summary,actions);
  return card;
}
function closePackageDetail(role) {
  const page = packageDetailPages.get(role);
  if (!page) return true;
  if (model.stage===role && openEditor===page.rowId) {
    if (!window.confirm("放弃未应用的字段修改并返回标注列表？")) return false;
    openEditor = "";
  }
  page.element.remove();
  packageDetailPages.delete(role);
  const list = byId(packageSide[role]);
  list.hidden = false;
  refreshScrollTail();
  writeScroll(list,page.listScroll);
  const cards = role==="student" ? rowElements : lawyerCards;
  (cards.get(page.rowId)?.querySelector(".package-edit-button") || list).focus({preventScroll:true});
  return true;
}
function openPackageDetail(row,role) {
  const current = packageDetailPages.get(role);
  if (current?.rowId===row.id) {
    current.element.querySelector(".package-detail-nav button:not(:disabled)")?.focus({preventScroll:true});
    return;
  }
  if (current && model.stage===role && openEditor) {
    return setNotice("请先应用或取消当前栏的字段修改。");
  }
  const list = byId(packageSide[role]);
  const page = {
    rowId:row.id, role, listScroll:current?.listScroll ?? list.scrollTop,
    element:node("div",null,"scroller package-detail-page")
  };
  page.element.dataset.row = row.id;
  page.element.setAttribute("role","region");
  page.element.setAttribute("aria-label",roleTitle[role]+"标注字段");
  if (current) current.element.replaceWith(page.element);
  else list.after(page.element);
  list.hidden = true;
  packageDetailPages.set(role,page);
  updatePackageDetail(page,row);
  page.element.querySelector(".package-detail-back").focus({preventScroll:true});
}
function openPackageCounterpart(row,role) {
  openPackageDetail(row,oppositePackageRole(role));
  focusPackageRow(row.id,false,role);
}
function canRemovePackageRow(row) {
  return get(row,riskField)==="是" || (get(row,riskField)==="否" &&
    (requiresUntriggeredReview(row) || (row.scope==="full_missing" && requiresRiskReview(row))));
}
function packageRowRemoved(row) {
  const latest = latestPackageJudgment(row);
  if (latest?.action==="remove") return true;
  if (latest?.action==="restore" ||
      (latest?.action===packageJudgmentLabels.clear && relatedUntriggered(row.fields)) ||
      ([packageJudgmentLabels.unrelated,packageJudgmentLabels.missingClear].includes(latest?.action) &&
        get(row,keyRelevant)==="否")) return false;
  return wasRisk(row);
}
function updatePackageJudgment(row,action,evidence="") {
  if (openEditor) return setNotice("请先应用或取消当前字段修改。");
  const triggered = action==="triggered";
  const label = packageJudgmentLabels[action];
  for (const part of sameJudgment(row)) {
    const before = structuredClone(part);
    remember(part,label,"");
    Object.assign(part.fields,{
      [keyRelevant]:part.scope==="full_missing"?"否":"是",
      [riskField]:triggered?"是":"否",
      [keyEvidence]:action==="clear" ? get(part,keyEvidence) : evidence
    });
    if (!triggered) Object.assign(part.fields,{"风险说明":"","修订建议":""});
    invalidatePackageReview(part,before);
    reviewData(part,model.stage).reviewed = false;
  }
  changed(label);
  render(true);
  setNotice("已"+label+"，请确认本条复核。");
}
function markPackageTriggered(row) {
  if (openEditor) return setNotice("请先应用或取消当前字段修改。");
  if (row.scope==="full_missing") return updatePackageJudgment(row,"triggered");
  const dialog = dialogBox("标记为触发");
  const evidence = node("textarea");
  evidence.value = get(row,keyEvidence);
  evidence.rows = 3;
  const message = node("p","","small");
  dialog.append(labelled("风险判断关键证据（必填）",evidence),message,button("确认标记为触发",()=>{
    const text = evidence.value.trim();
    const excerpts = text.split(/\n\s*\n/).filter(part=>part.trim());
    const compact = value=>value.replace(/[\r\n\t \u3000\u00a0]+/g,"");
    const clause = compact(get(row,keyClause));
    if (!compact(text) || (!clause.includes(compact(text)) && excerpts.some(part=>!clause.includes(compact(part))))) {
      message.textContent = "请填写能在本条款原文中定位的关键证据。";
      return evidence.focus();
    }
    dialog.close();
    updatePackageJudgment(row,"triggered",text);
  },"primary"));
  evidence.focus();
}
function confirmAllPackageAnnotations() {
  const pending = packageReviewRows().filter(row=>!isReviewed(row));
  if (!pending.length) return setNotice("本包所有标注已复核。");
  for (const row of pending) reviewData(row,model.stage).reviewed = true;
  changed("确认所有未复核的标注");
  render(true);
  setNotice("已确认本包所有 "+pending.length+" 条未复核标注。");
}
function latestPackageFieldEdit(row) {
  const version = packageRecordVersion(row);
  for (let index = packageSession.events.length-1; index>=0; index--) {
    const event = packageSession.events[index];
    if (event.round!==packageSession.manifest.round || event.role!==model.stage) break;
    const change = event.rows.find(item=>item.id===row.id);
    if (!change) continue;
    if (!change.before || !samePackageValue(change.before.review_history,change.after.review_history)) break;
    const after = packageRecordVersion(change.after);
    if (samePackageValue(packageRecordVersion(change.before),after)) continue;
    if (event.action==="编辑标注字段" && samePackageValue(version,after)) return event;
    break;
  }
}
function undoPackageFieldEdit(row) {
  if (openEditor) return setNotice("请先应用或取消当前字段修改。");
  const edit = latestPackageFieldEdit(row);
  if (!edit) return;
  const peer = packageSharedRows.get(row.id);
  for (const {id,before} of edit.rows) {
    if (id!==row.id && id!==peer) continue;
    const current = rowById.get(id);
    const applied = structuredClone(current);
    for (const [key,value] of Object.entries(packageRecordVersion(before))) {
      if (value===undefined) delete current[key];
      else current[key] = value;
    }
    invalidatePackageReview(current,applied);
    for (const key of ["review_required","lawyer_review_only"]) {
      if (before[key]===undefined) delete current[key];
      else current[key] = before[key];
    }
    if (requiresReview(current)) reviewData(current,model.stage).reviewed = false;
  }
  changed("撤回已应用的字段修改");
  render(true);
  const detail = packageDetailPages.get(model.stage)?.element;
  (detail?.querySelector(".package-field-toggle") || detail?.querySelector(".package-detail-back"))?.focus({preventScroll:true});
  setNotice("已恢复上次应用前的字段。"+(requiresReview(row) ? "请重新确认这张风险卡。" : ""));
}
function packageReviewPanel(row,role) {
  const review = row[role] || {reviewed:false,note:""};
  const panel = node("div",null,"review package-review-panel");
  const note = node("textarea");
  note.rows = 2;
  note.value = review.note || "";
  note.setAttribute("aria-label",roleTitle[role]+"复核意见");
  note.oninput = ()=>{
    row[role] = review;
    review.note = note.value;
    dirty = true;
  };
  note.onchange = ()=>changed("复核意见");
  const removed = packageCurrentRemoval(row);
  const label = review.reviewed ? "撤销复核确认" : removed ? "确认删除结果" : "确认本条已复核";
  const confirm = button(label,()=>{
    row[role] = review;
    review.reviewed = !review.reviewed;
    changed(removed ? "确认删除结果" : "复核确认");
    render(true);
    setNotice(review.reviewed ? (removed ? "已确认本条删除结果。" : "已确认本条复核。") : "已撤销本条复核确认。");
  },review.reviewed ? "package-review-confirm" : "primary package-review-confirm");
  panel.append(node("strong",roleTitle[role]+"复核"),labelled("复核意见（选填）",note),confirm);
  return panel;
}
function updatePackageDetail(page,row,force=false) {
  const {role,element} = page;
  const next = nextPackageRow(row,role);
  const version = JSON.stringify([row,next?.id]);
  if (!force && page.version===version) return;
  page.version = version;
  const offset = element.scrollTop;
  const view = {...row,...roleProjection(row,role)};
  const editable = model.stage===role && packageSlot(row)!==undefined;
  const deleted = packageCurrentRemoval(row);
  const canEdit = editable && !deleted;
  const navigation = node("div",null,"package-detail-nav");
  navigation.append(button("返回标注列表",()=>closePackageDetail(role),"package-detail-back"),
    button("定位原文",()=>focusPackageRow(row.id,false)));
  if (canComparePackageRole(row,role)) navigation.append(button("对照另一栏",()=>openPackageCounterpart(row,role)));
  const advance = button("下一条",()=>{
    openPackageDetail(next,role);
    focusPackageRow(next.id,false,role);
  });
  advance.disabled = !next;
  navigation.append(advance);
  const body = node("article",null,"card package-detail-content");
  stylePackageVersion(body,view.contract_id);
  const status = packageReviewStatus(row,role);
  const heading = node("div",null,"card-head");
  heading.append(node("h3",get(view,"风险名称") || "缺少风险名称"),packageCardBadges(row,view,role,status));
  const change = handoffMark(row,view,role);
  const removal = editable && deleted ? lastRiskRemoval(row) : roleRemoval(row,view,role);
  body.append(heading,packageCardMetadata(view,row.id));
  if (page.editing && canEdit) {
    const editor = node("div",null,"package-edit-form");
    editPanel(row,editor,{
      toolbar:navigation,
      onExit:()=>{
        page.editing = false;
        updatePackageDetail(page,row,true);
        element.querySelector(".package-field-toggle")?.focus({preventScroll:true});
      }
    });
    body.append(editor);
    element.replaceChildren(navigation,body);
    element.scrollTop = 0;
    navigation.querySelector("button:not(:disabled)")?.focus({preventScroll:true});
    return;
  }
  if (canEdit) navigation.append(button("编辑字段",()=>{
    if (openEditor) return setNotice("请先应用或取消当前字段修改。");
    openEditor = row.id;
    page.editing = true;
    updatePackageDetail(page,row,true);
  },"primary package-field-toggle"));
  if (model.stage===role && !deleted && latestPackageFieldEdit(row)) {
    navigation.append(button("撤回上次应用",()=>undoPackageFieldEdit(row)));
  }
  const commands = node("div",null,"row-actions");
  if (editable && role==="lawyer" && deleted && removal?.before) {
    commands.append(button("撤销删除",()=>{
      restoreRiskCard(row);
      element.querySelector(".package-field-toggle")?.focus({preventScroll:true});
    },"primary"));
  }
  if (removal) commands.append(button("查看删除记录",()=>showLogs(row.id)));
  if (canEdit) {
    if (canRemovePackageRow(row)) {
      commands.append(button("删除风险卡",()=>removeRow(row),"danger"));
    }
    const triggered = get(row,riskField)==="是";
    if (triggered) commands.append(button("标记为未触发",()=>updatePackageJudgment(row,row.scope==="full_missing"?"missingClear":"clear")));
    else commands.append(button(packageJudgmentLabels.triggered,()=>markPackageTriggered(row)));
    if (role==="student") commands.append(button("提出问题",()=>editDiscussion("question",{row})));
  }
  if (commands.children.length) body.append(commands);
  if (removal) body.append(node("p","删除理由："+asText(removal.reason),"wrap package-removal-reason"));
  const opinion = editable ? packageReviewPanel(row,role) : notePanel(row,role,false);
  if (change?.note) opinion.classList.add("package-diff-value");
  body.append(opinion);
  if (change?.binding) body.append(node("p","本轮调整了合同、规则或条款定位。","small package-diff-value"));
  const values = node("dl",null,"summary-grid package-fields");
  const shown = canEdit ? row : view;
  if (role==="student") {
    appendReviewFields(values,row.original_fields,shown,["AI 初标","实习生复核"]);
  } else {
    const submitted = model.stage==="lawyer" ? null : row.student_view?.fields ?? row.submitted_fields ?? change?.before;
    appendReviewFields(values,submitted,shown,["实习生复核","律师复核"]);
  }
  body.append(node("h3",role==="student" && !row.student_view && !row.submitted_fields && !row.added_by ? "AI 初标字段" : "标注字段"),values);
  if (canEdit && !samePackageValue(row.fields,view.fields)) {
    const previous = node("details");
    const fields = node("dl",null,"summary-grid package-fields");
    for (const field of model.fields) detailItem(fields,field,get(view,field));
    previous.append(node("summary","本栏此前的标注"),fields);
    body.append(previous);
  }
  element.replaceChildren(navigation,body);
  element.scrollTop = offset;
}

function renderPackage(keepScroll) {
  const columns = packageAnchors();
  const lawyerVisible = showLawyerColumn();
  const scroll = columns.map(([id])=>keepScroll ? byId(id).scrollTop : 0);
  const sections = packageSectionPlan();
  const grouped = {};
  const visible = {};
  for (const role of packageRoles) {
    visible[role] = shownPackageRows(role);
    const index = new Map([...sections.map(section=>[section.id,[]]),["",[]]]);
    for (const item of visible[role]) index.get(item.section).push(item);
    grouped[role] = index;
  }
  const fragments = columns.map(()=>document.createDocumentFragment());
  const [,middle,lawyer] = fragments;
  for (const [,anchors] of columns) anchors.clear();
  rowElements.clear();
  lawyerCards.clear();
  const pair = activePackagePair();
  const version = pair ? byId("stance").value : "";
  const stanceOptions = packageVersionOptions();
  const stanceLabels = new Map(stanceOptions);
  const sameWordFlip = packageViewMode==="flip" && !pair && stanceOptions.length>1;
  const stanceIndices = new Map(stanceOptions.map(([value],index)=>[value,index]));
  if (!pair && contractById.has(contractId) &&
      !model.rows.some(row=>row.contract_id===contractId)) {
    fragments[0].append(node("p","本包保留了这份评测合同，现有标注集没有该附件的记录。","package-lane-empty"));
  }
  for (const id of version ? [version] : pair?.contracts || [contractId]) {
    const contract = contractById.get(id);
    if (contract) appendPackageContractContext(fragments[0],contract);
  }
  for (const {id,actual:section,source,otherId,switchable,standalone} of sections) {
    const block = node("section",null,"doc-section");
    const stance = packageStanceChoices.get(id) ?? byId("stance").value;
    const sideIndex = sameWordFlip ? stanceIndices.get(stance) ?? 0 : undefined;
    stylePackageVersion(block,source,sideIndex);
    const marks = packageRoles.flatMap(role=>grouped[role].get(id).filter(item=>get(item.view,riskField)==="是").map(item=>item.view));
    if (switchable || standalone) {
      const bar = node("div",null,"package-version-switch");
      const filename = contractById.get(source).name;
      const label = sameWordFlip ? stance || "全部立场" : [stanceLabels.get(source),filename].filter(Boolean).join(" · ");
      bar.append(node("span",label,"small"));
      if (switchable) {
        const flip = button("切换立场",()=>flipPackageVersion(id),"package-flip");
        flip.title = sameWordFlip ? "切换本条的标注立场" : "查看 "+contractById.get(otherId).name+" 的对应条款";
        bar.append(flip);
      }
      block.append(bar);
    }
    if (!section.text.trimStart().startsWith(section.heading)) block.append(node("h3",section.heading));
    const text = markedText(section,marks);
    block.append(text);
    if (model.stage!=="final") {
      const actions = node("div",null,"row-actions package-clause-actions");
      for (const [label,triggered] of [["新增风险批注",true],["新增未触发风险批注",false]]) {
        let selection = "";
        const add = button(label,()=>addAnnotation(section,selection,false,triggered,source));
        add.onpointerdown = event=>{
          const source = selectedClauseEvidence();
          selection = source?.sectionId===id ? source.text : "";
          if (selection) event.preventDefault();
        };
        actions.append(add);
      }
      block.append(actions);
    }
    leftSections.set(id,block);
    fragments[0].append(block);
  }
  for (const [role,fragment,anchors,cards] of [["student",middle,rightSections,rowElements],["lawyer",lawyer,lawyerSections,lawyerCards]]) {
    if (role==="lawyer" && !lawyerVisible) {
      fragment.append(node("p","实习生提交后，由律师在此复核。","package-lane-empty"));
      continue;
    }
    const ordered = [...grouped[role].values()].flat();
    if (!ordered.length) fragment.append(node("p","当前筛选下暂无批注卡片。","package-lane-empty"));
    let cardIndex = 0;
    for (const {id,actual,source} of [...sections,{id:"",actual:{heading:"整份合同与未定位批注"},source:contractId}]) {
      const entries = grouped[role].get(id);
      if (!entries.length) continue;
      const group = node("section",null,"row-section");
      group.dataset.section = id;
      const stance = packageStanceChoices.get(id) ?? byId("stance").value;
      stylePackageVersion(group,source,sameWordFlip ? stanceIndices.get(stance) : undefined);
      const heading = node("h3",actual.heading);
      if (pair && packageViewMode==="list" && id) {
        group.append(node("p",[stanceLabels.get(source),contractById.get(source).name].filter(Boolean).join(" · "),"package-list-source small"));
      }
      group.append(heading);
      for (const {row,view} of entries) {
        const card = packageCard(row,view,role,lawyerVisible,ordered[++cardIndex]?.row);
        if (sameWordFlip) stylePackageVersion(card,source,stanceIndices.get(get(view,"立场")));
        group.append(card);
        cards.set(row.id,card);
      }
      if (id) anchors.set(id,group);
      fragment.append(group);
    }
  }
  columns.forEach(([id],index)=>{
    const tail = node("div",null,"scroll-tail");
    tail.setAttribute("aria-hidden","true");
    fragments[index].append(tail);
    byId(id).replaceChildren(fragments[index]);
  });
  pendingSide = activeSectionId = "";
  refreshScrollTail();
  columns.forEach(([id],index)=>{ if (!byId(id).hidden) writeScroll(byId(id),scroll[index]); });
  if (byId("scope").value==="no-clause" && !keepScroll) {
    for (const side of Object.values(packageSide)) align(byId(side),byId(side).querySelector(".row-section[data-section='']"));
  }
  for (const page of packageDetailPages.values()) {
    const row = rowById.get(page.rowId);
    if (!row || (model.stage===page.role && openEditor===page.rowId)) continue;
    if (packageCardHidden(row,page.role)) closePackageDetail(page.role);
    else updatePackageDetail(page,row);
  }
  byId("match").textContent = visible.student.length+" 条";
  progress();
}

function appendPackageContractContext(fragment,contract) {
  const context = contract.context_blocks || [];
  const texts = context.map(block=>block.text);
  for (const extra of [contract.preamble,contract.signature]) {
    if (typeof extra==="string" && extra.trim()) texts.push(extra);
  }
  if (texts.length) {
    const details = node("details",null,"doc-section");
    stylePackageVersion(details,contract.id);
    const title = packagePairByContract.has(contract.id) ? contract.name+" · 合同上下文" : "合同前言、签署及补充上下文";
    details.append(node("summary",title),node("p",texts.join("\n"),"doc-text"));
    fragment.append(details);
  }
}

function finalPackageIssues(project,requireOpinion=true) {
  const issues = [];
  const contracts = new Map(project.contracts.map(contract=>[contract.id,contract]));
  const rules = new Map(project.rules.map(rule=>[rule.id,rule]));
  const keyFor = (contract,rule,matter)=>JSON.stringify([contract,rule,matter || ""]);
  const paths = new Map();
  const groups = new Map();
  const judgments = new Map();
  const normalize = normalizeClauseText;
  const compact = text=>text.replace(/[\r\n\t \u3000\u00a0]+/g,"");
  const units = new Map(project.contracts.map(contract=>[contract.id,
    new Map(contract.sections.map(section=>[section.id,normalize(section.text)]))]));
  function issueContext(contractId,ruleId,sectionId,scope,row) {
    const contract = contracts.get(contractId), rule = rules.get(ruleId);
    const section = contract?.sections.find(item=>item.id===sectionId);
    const location = scope==="full_missing" ? "全文缺失 · 整份合同" : section?.heading || (row ? "尚未定位条款" : "");
    return {
      title:row ? "标注记录" : "规则覆盖校验",rowId:row?.id,contractId,section,
      contractName:contract?.name || (row && get(row,"合同附件名称")) || "合同未匹配",
      riskName:(row && get(row,"风险名称")) || rule?.name,stance:(row && get(row,"立场")) || rule?.stance,
      location:[location,sourceRowLabel(row?.id)].filter(Boolean).join(" · "),problems:[]
    };
  }
  function coverageIssue(path,reason,sectionId) {
    const item = issueContext(path.contract_id,path.rule_id,sectionId,path.mode);
    item.problems.push({field:"规则覆盖",reason,instruction:"请对照建包时的覆盖清单，核对该规则应有的记录。"});
    issues.push(item);
  }
  for (const path of project.paths || []) {
    const key = keyFor(path.contract_id,path.rule_id,path.matter_id);
    if (paths.has(key) || !contracts.has(path.contract_id) || !rules.has(path.rule_id) ||
        !["slice","related","full_missing"].includes(path.mode)) coverageIssue(path,"覆盖清单中的规则、合同或审查方式无效，或重复配置了同一条覆盖路径。");
    paths.set(key,path);
  }
  for (const [contractId,ruleIds] of Object.entries(project.applicability || {})) {
    for (const ruleId of ruleIds) {
      if (![...paths.values()].some(path=>path.contract_id===contractId && path.rule_id===ruleId)) {
        coverageIssue({contract_id:contractId,rule_id:ruleId},"这条适用规则在该合同上没有配置覆盖路径。");
      }
    }
  }
  for (const row of project.rows) {
    const fields = row.fields;
    const contract = contracts.get(row.contract_id), rule = rules.get(row.rule_id);
    const contractUnits = units.get(row.contract_id);
    const groupKey = keyFor(row.contract_id,row.rule_id,row.matter_id);
    const clauseText = normalize(get(row,keyClause));
    const section = row.section_id || (contractUnits ? [...contractUnits].findLast(([,text])=>text===clauseText)?.[0] : undefined);
    let scope = row.scope || (clauseText ? "slice" : "unlinked");
    const type = packageCardType(fields);
    if (scope==="unlinked" && (paths.get(groupKey)?.mode==="full_missing" ||
        (!clauseText.trim() && (type==="no-clause" || type==="no-attention")))) scope="full_missing";
    const item = issueContext(row.contract_id,row.rule_id,section,scope,row);
    const problems = item.problems;
    const add = (field,reason,options={})=>{
      if (!problems.some(problem=>problem.field===field && problem.reason===reason)) problems.push({field,reason,...options});
    };
    const badFields = packageFieldNames.filter(field=>typeof fields?.[field]!=="string");
    if (badFields.length || !fields || Object.keys(fields).length!==packageFieldNames.length) {
      add("标注字段格式",badFields.length ? "以下字段缺少有效的文本值："+badFields.join("、")+"。" :
        "记录中有标准 15 列以外的字段。",{instruction:"请核对来源标注集的表头和单元格格式。"});
      issues.push(item);
      continue;
    }
    const [file,category,clause,risk,stance,relevant,trigger,level,logic,relatedType,attribute,related,evidence] =
      packageFieldNames.map(field=>normalize(fields[field]));
    if (!contract) add("合同附件名称","这条标注尚未绑定到包内的合同。",{
      instruction:"在「编辑字段」中展开「更正合同、规则或切片定位」，选择对应的合同。"});
    else if (contract.name!==file) add("合同附件名称","当前填的是「"+(file || "留空")+"」，对应的合同文件名应为「"+contract.name+"」。",{editField:"合同附件名称"});
    if (!rule) add("专家规则定位","这条标注尚未绑定到包内的专家规则。",{
      instruction:"在「编辑字段」中展开「更正合同、规则或切片定位」，选择对应规则和立场。",editBinding:true});
    else for (const [field,actual,expected] of [
      ["风险名称",risk,rule.name],["立场",stance,rule.stance],["风险等级",level,rule.level],["审查逻辑",logic,rule.logic]
    ]) {
      if (actual!==normalize(expected || "")) add(field,field==="审查逻辑" ?
        "当前审查逻辑与绑定的专家规则不一致。" :
        "当前填的是「"+(actual || "留空")+"」，绑定规则要求「"+(expected || "留空")+"」。",
      {instruction:"核对规则绑定和正式规则原值。",editField:field});
    }
    for (const [field,value] of [[keyRelevant,relevant],[riskField,trigger]]) {
      if (value!=="是" && value!=="否") add(field,"当前值为「"+(value || "留空")+"」。这里只能填「是」或「否」。",{
        instruction:"请核对初始标注集，或通过标注卡片的判断操作修正。"});
    }
    for (const [field,value] of [["条款类型",category],["关联条款类型",relatedType]]) {
      if (/^[A-Z]+\d+(?:\s|[.、：:]|$)/.test(value) || (value && project.clause_types?.length && !project.clause_types.includes(value))) {
        add(field,"「"+value+"」不是该批次使用的中文条款分类名称。",{editField:field});
      }
    }
    if (attribute && !["引用","例外","生效条件","定义来源","优先适用"].includes(attribute)) {
      add("关联条款属性","「"+attribute+"」不是有效属性。可选引用、例外、生效条件、定义来源或优先适用。",{editField:"关联条款属性"});
    }
    if (scope==="full_missing") {
      for (const [field,value] of [[keyClause,clause],[keyEvidence,type==="no-attention" ? "" : evidence.trim()],["条款类型",category]]) {
        if (value) add(field,"全文缺失记录的这个字段应留空。",{editField:field});
      }
      if (relevant!=="否") add(keyRelevant,"全文缺失记录没有主条款，相关性应为「否」。");
      if (row.section_id) add("条款定位","全文缺失记录应以整份合同为审查对象。");
    } else {
      if (!clause || contractUnits?.get(section)!==clause) problems.push(clauseMismatchIssue(row,contract,section));
      if (relevant==="是" && trigger==="是" && !evidence) {
        add(keyEvidence,"这条标注已判为触发，需要从左侧对应条款摘录支持判断的原文。",{editField:keyEvidence});
      }
    }
    if (clause && evidence && !compact(clause).includes(compact(evidence)) &&
        evidence.split(/\n\s*\n/).filter(part=>part.trim()).some(part=>!compact(clause).includes(compact(part)))) {
      add(keyEvidence,"至少一段证据在当前主条款中找不到。请逐段核对并摘录左侧原文字句。",{editField:keyEvidence});
    }
    if (!groups.has(groupKey)) groups.set(groupKey,new Map());
    const logical = JSON.stringify([scope,section,related]);
    const members = groups.get(groupKey);
    const duplicate = members.get(logical);
    if (duplicate) add("重复标注","同一合同、规则、主条款和关联条款已有另一条记录。",{relatedRowId:duplicate.rowId});
    members.set(logical,{scope,section,rowId:row.id});
    const key = JSON.stringify([groupKey,scope,section]);
    if (section || scope==="full_missing") {
      const value = JSON.stringify([relevant,trigger,evidence]);
      const other = judgments.get(key);
      if (other && other.value!==value) {
        add("关联条款拆行","同一主条款的两条记录在相关性、触发结论或关键证据上不一致。",{relatedRowId:other.rowId});
      }
      judgments.set(key,{value,rowId:row.id});
    }
    if (!Array.isArray(row.review_history ?? [])) add("复核记录","复核历史的格式有误。",{logs:true});
    else for (const event of row.review_history || []) {
      if (!packageRoles.includes(event?.stage)) add("复核记录","有一条历史操作缺少有效的复核人角色。",{logs:true});
      if (event?.action==="remove" && (typeof event.reason!=="string" || !event.reason.trim() ||
          !canRemovePackageRow({...row,fields:event.before}) || !packageFieldNames.every(field=>Object.hasOwn(event.before || {},field)))) {
        add("删除记录","删卡记录缺少原因或删除前的完整标注。",{logs:true});
      }
    }
    if (requiresReview(row)) {
      if (!row.student?.reviewed && row.lawyer_review_only!==true) {
        add("实习生复核","这条记录缺少实习生确认，请核对实习生提交的 ZIP。",{logs:packageCurrentRemoval(row)});
      }
      if (!row.lawyer?.reviewed) add("律师复核",packageCurrentRemoval(row) ?
        "这条卡已删除，请到复核记录确认删除结果。" : "这条记录尚未确认，请打开律师栏标注并确认。",{logs:packageCurrentRemoval(row)});
      const needsOpinion = project.review_related===true ? wasRisk(row) : requiresRiskReview(row);
      if (requireOpinion && needsOpinion && !hasLawyerOpinion(row)) {
        add("律师复核意见","这条历史终版记录需要有律师复核意见。",{logs:packageCurrentRemoval(row)});
      }
    }
    if (problems.length) issues.push(item);
  }
  for (const [key,path] of paths) {
    const scope = path.mode==="full_missing" ? "full_missing" : "slice";
    const expected = new Set(scope==="full_missing" ? [undefined] :
      path.mode==="slice" ? units.get(path.contract_id)?.keys() : path.section_ids || []);
    const actual = new Set();
    for (const member of groups.get(key)?.values() || []) {
      if (member.scope!==scope || !expected.has(member.section)) {
        const row = project.rows.find(item=>item.id===member.rowId);
        const issue = issueContext(path.contract_id,path.rule_id,member.section,member.scope,row);
        issue.problems.push({field:"规则覆盖",reason:"这条记录的审查范围或主条款与覆盖清单不一致。"});
        issues.push(issue);
      } else actual.add(member.section);
    }
    if (!expected.size) coverageIssue(path,"覆盖清单没有列出应检查的条款。");
    for (const section of expected) {
      if (!actual.has(section)) coverageIssue(path,"该位置缺少这条规则要求的标注。",section);
    }
  }
  if (!Array.isArray(project.review_questions ?? [])) {
    issues.push({title:"实习生问题",problems:[{reason:"问题记录的格式无效，请核对接收的 ZIP。"}]});
  } else for (const question of project.review_questions || []) {
    if (questionReviewed(question)) continue;
    const row = project.rows.find(item=>item.id===question.row_id);
    const item = issueContext(row?.contract_id ?? question.contract_id,row?.rule_id,row?.section_id,row?.scope,row);
    issues.push({...item,title:"实习生问题待审核",riskName:undefined,question,
      problems:[{reason:"请填写律师答复，并勾选「确认此问题已审核」。"}]});
  }
  return issues;
}

function splitReviewSentences(value) {
  return value.match(/[^。！？!?；;\r\n]*(?:[。！？!?；;]+[”’」』）】]*|\r?\n+|\r|$)/g)?.filter(Boolean) || [];
}

function sentenceChanges(before,after) {
  let start = 0;
  let oldEnd = before.length, newEnd = after.length;
  while (start<oldEnd && start<newEnd && before[start]===after[start]) start++;
  while (oldEnd>start && newEnd>start && before[oldEnd-1]===after[newEnd-1]) {
    oldEnd--;
    newEnd--;
  }
  const oldSize = oldEnd-start, newSize = newEnd-start;
  if (!oldSize && !newSize) return [];
  if (!oldSize || !newSize || oldSize*newSize>250000) return [[start,oldEnd,start,newEnd]];
  const width = newSize+1;
  const lengths = new Uint32Array((oldSize+1)*width);
  for (let i=oldSize-1;i>=0;i--) {
    for (let j=newSize-1;j>=0;j--) {
      const cell = i*width+j;
      lengths[cell] = before[start+i]===after[start+j] ? 1+lengths[cell+width+1] :
        Math.max(lengths[cell+width],lengths[cell+1]);
    }
  }
  const changes = [];
  let i = 0, j = 0, pending;
  while (i<oldSize || j<newSize) {
    if (i<oldSize && j<newSize && before[start+i]===after[start+j]) {
      if (pending) changes.push([pending[0],start+i,pending[1],start+j]);
      pending = null;
      i++;
      j++;
    } else {
      pending ||= [start+i,start+j];
      if (j===newSize || (i<oldSize && lengths[(i+1)*width+j]>=lengths[i*width+j+1])) i++;
      else j++;
    }
  }
  if (pending) changes.push([pending[0],oldEnd,pending[1],newEnd]);
  return changes;
}

function sentenceExcerpt(sentences,changes,side) {
  const start = Math.max(0,changes[0][side]-2);
  const end = Math.min(sentences.length,changes.at(-1)[side+1]+2);
  const paragraph = node("p",null,"wrap");
  if (start) paragraph.append("…\n");
  let position = start;
  for (const change of changes) {
    const [from,to] = change.slice(side,side+2);
    paragraph.append(sentences.slice(position,from).join(""));
    paragraph.append(from===to ? node("span","（此处无对应文字）","small") :
      node("mark",sentences.slice(from,to).join("")));
    position = to;
  }
  paragraph.append(sentences.slice(position,end).join(""));
  if (end<sentences.length) paragraph.append("\n…");
  return paragraph;
}

function appendReviewFields(values,original,view,[beforeTitle,afterTitle]) {
  original ||= {};
  for (const field of model.fields) {
    const before = asText(original[field]), after = get(view,field);
    if (!Object.hasOwn(original,field) || before===after) {
      detailItem(values,field,after);
      continue;
    }
    const oldSentences = splitReviewSentences(before);
    const newSentences = splitReviewSentences(after);
    const changes = sentenceChanges(oldSentences,newSentences);
    const groups = [];
    for (const change of changes) {
      const previous = groups.at(-1);
      if (previous && change[0]-previous.at(-1)[1]<=4 && change[2]-previous.at(-1)[3]<=4) previous.push(change);
      else groups.push([change]);
    }
    const label = node("dt",field,"package-diff-label");
    label.append(node("span","有改动","badge package-change-edited"));
    const value = node("dd",null,"package-diff-value");
    for (const group of groups) {
      const comparison = node("div",null,"package-sentence-diff");
      for (const [headline,sentences,side] of [[beforeTitle,oldSentences,0],[afterTitle,newSentences,2]]) {
        const excerpt = node("div");
        excerpt.append(node("strong",headline),sentenceExcerpt(sentences,group,side));
        comparison.append(excerpt);
      }
      value.append(comparison);
    }
    if (groups.length>1 || groups.some(group=>group[0][0]>2 || group.at(-1)[1]+2<oldSentences.length ||
      group[0][2]>2 || group.at(-1)[3]+2<newSentences.length)) {
      const full = node("details");
      full.append(node("summary","查看完整字段"),node("strong",beforeTitle),
        node("p",before || "（留空）","wrap small"),node("strong",afterTitle),node("p",after || "（留空）","wrap small"));
      value.append(full);
    }
    values.append(label,value);
  }
}
