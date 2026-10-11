// 엑셀(.xlsx) 파일 만들기: 외부 라이브러리 없이 시트 하나짜리 통합 문서를 만든다.
// .xlsx는 XML 파일 몇 개를 zip으로 묶은 것이라, 압축 없이(store) 묶어 Blob으로 돌려준다.

const enc = new TextEncoder();
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  // XML에 넣을 수 없는 제어 문자는 뺀다
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** 열 번호(0부터) → A, B, …, Z, AA … */
function colName(i) {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/**
 * rows: 2차원 배열. 숫자는 숫자 칸(천 단위 쉼표 서식), 나머지는 글자 칸.
 * widths: 열 너비(글자 수 기준, 선택)
 */
function sheetXml(rows, widths = [], { heads = [0], freeze = true } = {}) {
  const head = new Set(heads); // 회색 바탕으로 칠할 줄(제목 줄)
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    const ref = `${colName(c)}${r + 1}`;
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" s="${Number.isInteger(v) ? 1 : 3}"><v>${v}</v></c>`; // 정수 #,##0 / 소수 #,##0.00
    return `<c r="${ref}" t="inlineStr"${head.has(r) ? ' s="2"' : ""}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : ""}
${cols}<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="맑은 고딕"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEDED"/></patternFill></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="4"><xf/><xf numFmtId="3" applyNumberFormat="1"/><xf fillId="2" applyFill="1"/><xf numFmtId="4" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

/** sheets: [{ name, rows, widths, heads?, freeze? }] — 시트 여러 개 */
function workbookFiles(sheets) {
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((sh, i) => `<sheet name="${xmlEsc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "xl/styles.xml": STYLES,
  };
  sheets.forEach((sh, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sh.rows, sh.widths, sh)));
  return files;
}

// ---------------- zip (압축 없이 묶기) ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);         // 필요한 버전
    local.setUint16(6, 0x0800, true);     // 파일 이름 UTF-8
    local.setUint16(8, 0, true);          // 압축 없음
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cenSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** 시트 하나짜리 .xlsx Blob */
export function makeXlsx(sheetName, rows, widths) {
  return zip(workbookFiles([{ name: sheetName, rows, widths }]));
}
/** 시트 여러 개짜리 .xlsx Blob. sheets: [{ name, rows, widths, heads?(회색 줄 번호들), freeze?(첫 줄 고정) }] */
export function makeXlsxBook(sheets) {
  return zip(workbookFiles(sheets));
}
