# PubMed Literature Review Tool — Build Spec

Brief สำหรับสร้าง web app ค้นหา + triage paper จาก PubMed แบบไม่ต้องพึ่ง AI
เขียนให้ implement **Phase 1–2 ก่อน** แล้วหยุดให้ผู้ใช้ดูผลจริง ก่อนทำ Phase 3+

> **หมายเหตุขอบเขต:** ไฟล์โปรเจกต์ทั้งหมดอยู่ใน `Temp. folder` นี้ (`Paper/Claude/`) เท่านั้น
> ห้ามแตะไฟล์นอกโฟลเดอร์นี้

---

## 1. เป้าหมาย

แทน workflow ที่ตอนนี้ทำผ่าน Claude (esearch → esummary → efetch → SCImago lookup → filter → present)
ด้วย **web app ไฟล์เดียว** ที่ผู้ใช้เปิด browser ทำเองได้ ไม่เปลือง token AI

**Non-goals (อย่าเพิ่งทำใน Phase 1-2):** triage persist, dedup ข้าม search, export, deploy — อยู่ Phase 3+

---

## 2. Stack & โครงไฟล์

- **Vanilla HTML + CSS + JS** ไม่มี build tool ไม่มี framework — เปิด `file://` ได้เลย
- ทำงานได้ทั้ง local และ (ภายหลัง) GitHub Pages โดยไม่แก้โค้ด

```
Claude/webapp/
  index.html      โครง UI + inline CSS (theme-aware light/dark)
  app.js          logic ทั้งหมด
  scimago.js      โหลด/parse/lookup SCImago CSV (แยกไฟล์เพราะ logic เยอะ)
  data/
    scimagojr_2025.csv   คัดลอกมาจาก ../database/scimagojr_2025.csv (bundle default)
```

> คัดลอก CSV เข้า `webapp/data/` — **อย่า** อ้างไฟล์ข้าม path ออกนอก webapp/ เพราะพอ deploy GitHub Pages ต้อง self-contained

---

## 3. UI — 3 ส่วน (มี mockup อนุมัติแล้ว ทำตามนั้น)

### 3.1 Query builder
- **Term rows**: row แรกมี label "Search" + text input. row ถัดไปมีปุ่ม `AND`/`OR` (toggle) + input + ปุ่มลบ. ปุ่ม "+ Add term" เพิ่ม row
- ทุก term ใช้ field tag `[Title/Abstract]` เป็น default (ไม่ต้องมี dropdown เลือก field — ตัดออกแล้ว ใครอยากได้ MeSH แก้ใน query preview เอง)
- **Pub type chips** แบ่ง 5 กลุ่ม (toggle ได้, default = SR/MA/RCT ติ๊กไว้):
  - Synthesis: `Systematic Review`, `Meta-Analysis`
  - Trials: `Randomized Controlled Trial`, `Clinical Trial`, `Controlled Clinical Trial`
  - Guidelines: `Practice Guideline`, `Guideline`
  - Reviews: `Review`, `Scoping Review`
  - Other: `Observational Study`, `Comparative Study`, `Case Reports`
- **Year range slider** (from year → ปัจจุบัน)
- **Max results**: segmented 50/100/200/500 (default 100)
- **Query preview**: แสดง PubMed query string ที่ generate real-time — copy ไปวางใน PubMed Advanced Search ได้ตรงๆ
- ปุ่ม **Search PubMed**

**Query string format** (generate ตามนี้เป๊ะ):
```
("hallux valgus"[Title/Abstract] AND "conservative"[Title/Abstract])
AND ("2015/01/01"[Date - Publication] : "3000"[Date - Publication])
AND ("Systematic Review"[Publication Type] OR "Meta-Analysis"[Publication Type])
```
- ครอบ term ทั้งชุดด้วยวงเล็บถ้ามีมากกว่า 1 term
- year filter ใส่เฉพาะเมื่อ from > 2000
- pub type filter ใส่เฉพาะเมื่อเลือกบางส่วน (ไม่ใช่ทั้งหมด/ไม่ใช่ศูนย์)

### 3.2 Results list
- Sort buttons: **Newest (default)** / Journal tier / Pub type
- แต่ละ paper card: badge `Q1/Q2/Q3` + badge pub type + ปี + journal (italic) + title + ปุ่ม Abstract (expand in-place) + Keep/Skip
- **Pagination** ล่างสุด: "1–20 of N" ซ้าย, per-page 20/50/100 (default 50) + ปุ่ม prev/next/เลขหน้า ขวา
- Title link ไป `https://pubmed.ncbi.nlm.nih.gov/{PMID}/`

### 3.3 Settings panel (พับได้ ไอคอนเฟือง)
สองอย่าง — **สำคัญ ทำใน Phase 1-2:**

**(a) NCBI API key**
- text input เก็บใน `localStorage` (key: `ncbi_api_key`) — ไม่ขึ้น git, อยู่ในเครื่องผู้ใช้แต่ละคน
- ถ้ามี key → ส่ง `&api_key=...` ทุก request, throttle 10 req/sec. ถ้าไม่มี → throttle 3 req/sec
- แสดงข้อความสอนใต้ช่อง (ดู §6)

**(b) Upload SCImago CSV ใหม่**
- file input รับ `.csv` → parse → เก็บใน IndexedDB (แทน bundle default)
- แสดงปีของไฟล์ที่ใช้อยู่ + ข้อความสอนวิธีหาไฟล์ (ดู §6)

---

## 4. PubMed E-utilities — data flow

Base: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`
ทุก request แนบ `&api_key={key}` ถ้ามี. Throttle ตาม key.

### Phase 1: search + เบา
1. **esearch** — ได้ list ของ PMID
   ```
   esearch.fcgi?db=pubmed&retmode=json&retmax={maxResults}&term={encodeURIComponent(query)}
   ```
   → `esearchresult.idlist` = array ของ PMID, `esearchresult.count` = total ทั้งหมด
2. **esummary** — meta เบาสำหรับแสดง list (batch PMID คั่นด้วย comma)
   ```
   esummary.fcgi?db=pubmed&retmode=json&id={pmids.join(",")}
   ```
   ดึงต่อ PMID: `title`, `fulljournalname` (หรือ `source`), `pubdate` (เอาปี), `authors[]` (`.name`), `pubtype[]`
   → พอสำหรับ render card + tier lookup แล้ว **ไม่ต้อง efetch ในขั้นนี้**

### Phase 2: abstract (lazy)
3. **efetch** — abstract เต็ม ดึง **เฉพาะตอนกด Abstract** (ไม่ดึงล่วงหน้าทั้งหมด — ประหยัด request)
   ```
   efetch.fcgi?db=pubmed&retmode=xml&id={pmid}
   ```
   → คืน **XML** ต้อง `DOMParser`. Abstract อยู่ที่ `//AbstractText` (อาจมีหลาย node = structured abstract, join ด้วย label)
   Cache abstract ที่ดึงแล้วใน memory ระหว่าง session

> **Throttle helper**: ทำ queue ที่ปล่อย request ตาม rate (3 หรือ 10/sec) — esummary batch ได้ทีละ ~200 PMID ต่อ call จึงยิงไม่กี่ครั้ง

---

## 5. SCImago tier lookup (`scimago.js`)

CSV จริง: **semicolon-delimited**, row 1 = header, **ทศนิยมใช้ comma** (`1,605` = 1.605)

| col (1-idx) | field | ใช้ทำ |
|---|---|---|
| 2 | Sourceid | ทำ source_url |
| 3 | Title | journal name (key ที่ match) |
| 6 | Publisher | เก็บแสดง |
| 9 | SJR | score (แปลง comma→dot) |
| 10 | SJR Best Quartile | Q1–Q4 badge |
| 25 | Categories | subject + Q รายสาขา |

**การ parse:**
- อ่านไฟล์ทั้งก้อน → split ต่อบรรทัด → split ต่อ `;` (ระวัง field ที่มี `"..."` ครอบและมี `;` ข้างใน เช่น ISSN, Categories — ใช้ CSV parser ที่ handle quoted field กับ delimiter `;`)
- สร้าง `Map` key = `title.toLowerCase().trim()` → `{sourceId, title, publisher, sjr, quartile, categories}`
- **Cache parsed Map ใน IndexedDB** (parse ครั้งเดียว ~30k แถว ช้าถ้าทำทุกครั้ง)

**Lookup:** journal name จาก esummary → lowercase → หาใน Map
- เจอ → แสดง Q + SJR + source_url `https://www.scimagojr.com/journalsearch.php?q={sourceId}&tip=sid`
- ไม่เจอ → badge "—" / "not indexed" (Phase 1-2 ยังไม่ต้อง fuzzy match; แค่ exact lowercase; ปรับปรุงทีหลัง)

> journal name จาก PubMed อาจไม่ตรง SCImago เป๊ะ (ตัวย่อ, เครื่องหมาย) — Phase 1-2 ยอมรับ miss ได้ แล้วค่อยเก็บ edge case ไปทำ normalization ใน phase หลัง

---

## 6. ข้อความสอนใน Settings (ใส่เป็น help text จริงในหน้าเว็บ)

### API key
> **เร็วขึ้น 3 เท่าด้วย NCBI API key (ฟรี, ไม่บังคับ)**
> ถ้าไม่กรอก เครื่องมือทำงานได้ปกติที่ 3 requests/วินาที กรอก key แล้วจะได้ 10/วินาที
> วิธีเอา key:
> 1. สมัคร/ล็อกอิน NCBI account ที่ https://account.ncbi.nlm.nih.gov/
> 2. ไปที่ Account settings → หัวข้อ "API Key Management"
> 3. กด "Create an API Key" → คัดลอกมาวางในช่องนี้
> key เก็บในเบราว์เซอร์ของคุณเท่านั้น (localStorage) ไม่ถูกส่งขึ้นเว็บหรือแชร์กับใคร

### SCImago upload
> **อัปเดตข้อมูล journal quartile ประจำปี**
> ไฟล์ที่ใช้อยู่: SCImago {ปีจากไฟล์ปัจจุบัน}
> วิธีหาไฟล์ปีใหม่:
> 1. เปิด https://www.scimagojr.com/journalrank.php
> 2. เลือกปีจาก dropdown "Year" (ข้อมูลออกช้ากว่าปีจริง ~1 ปี)
> 3. กดปุ่ม "Download data" (ไอคอนบนขวาของตาราง) → ได้ไฟล์ `scimagojr YYYY.csv`
> 4. กด Upload ด้านล่างเพื่อใช้ไฟล์ใหม่
> รูปแบบไฟล์ต้องเป็นของ SCImago แท้ (คั่นด้วย `;`, ทศนิยมเป็น `,`)

---

## 7. Security / privacy (ทำตามเป๊ะ)

- **อย่า hardcode API key ใดๆ ในโค้ด** — รับจากผู้ใช้ทาง localStorage เท่านั้น (พอ deploy GitHub Pages เป็น public source ใครก็เห็น)
- ไม่มี backend, ไม่ส่งข้อมูลผู้ใช้ไปที่ไหนนอกจาก eutils.ncbi.nlm.nih.gov โดยตรง
- CSV/cache อยู่ในเครื่องผู้ใช้ (IndexedDB) ทั้งหมด

---

## 8. ลำดับงาน

**Phase 1** — query builder + esearch + esummary + render list + pagination + sort + SCImago tier (exact lookup) + settings(API key). ยังไม่ต้อง abstract
**Phase 2** — efetch abstract lazy (กดถึงดึง) + SCImago upload เข้า IndexedDB + throttle queue
→ **หยุดให้ผู้ใช้ทดสอบ query จริง** ก่อนไป Phase 3

**Phase 3+ (ยังไม่ทำ):** Keep/Skip/Maybe persist (IndexedDB), "already decided" filter, dedup ข้าม search, export citation Vancouver + `.ris` + copy-all, saved searches, citation count (Europe PMC), GitHub Pages deploy

### Citation format (เก็บไว้ให้ Phase 3 — Vancouver/PubMed style)
```
{authors ทุกคน คั่น ", "}. {title}. {journalAbbrev}. {year} {month} {day};{vol}({issue}):{pages}. doi: {doi}. PMID: {pmid}.
```
ตัวอย่าง: `Klaue K, Hansen ST, Masquelet AC. Clinical, quantitative assessment of first tarsometatarsal mobility in the sagittal plane and its relation to hallux valgus deformity. Foot Ankle Int. 1994 Jan;15(1):9-13. doi: 10.1177/107110079401500103. PMID: 7981800.`
(ต้องดึง field เพิ่มจาก efetch XML: volume, issue, pages, doi, journal abbrev, month)

---

## 9. อ้างอิง workflow เดิม (context)

logic เดิมที่ Claude ทำ อยู่ใน `../README.md`. หลักที่ต้องคงไว้:
- **Filter order**: review ก่อน → ใหม่กว่า → Q ดีกว่า
- **Query กว้างไว้ก่อน** เลี่ยง exact adjacent phrase, ใช้ wildcard `*` กับคำที่มีพหูพจน์
- **SCImago lookup รายตัว journal** (ไม่ใช่ publisher) — เก็บ publisher คู่ไว้ด้วย
- Cache นโยบาย 6 เดือน (paper + tier)
