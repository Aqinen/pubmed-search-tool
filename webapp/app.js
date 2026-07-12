/**
 * app.js
 * -----------------------------------------------------------------------
 * All application logic for the PubMed Literature Review Tool.
 * Vanilla JS, no build step, no framework, no backend.
 *
 * Phase 1: query builder -> esearch -> esummary -> render list ->
 *          pagination -> sort -> SCImago tier (exact lookup) ->
 *          settings (API key).
 * Phase 2: efetch abstract (lazy, on click) -> SCImago CSV upload into
 *          IndexedDB -> throttle queue.
 * Phase 3: Keep/Maybe/Skip persisted per-PMID (IndexedDB) -> decision
 *          filter -> citation export (Vancouver + .ris) -> saved
 *          searches (localStorage) -> opt-in Europe PMC citation counts.
 *
 * Security / privacy (spec §7):
 *  - No hardcoded API key anywhere in this file.
 *  - eutils.ncbi.nlm.nih.gov is contacted for every core feature. The
 *    ONE exception is citation counts, which calls Europe PMC
 *    (ebi.ac.uk) and only when the user explicitly opts in via Settings
 *    (off by default, disclosed in the toggle's help text).
 *  - All SCImago data, decisions, saved searches, and the API key live
 *    entirely on the user's machine (localStorage / IndexedDB).
 * -----------------------------------------------------------------------
 */

(function () {
  'use strict';

  // =========================================================
  // Constants
  // =========================================================

  var EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
  var API_KEY_STORAGE_KEY = 'ncbi_api_key';

  var YEAR_MIN = 1950;
  var CURRENT_YEAR = new Date().getFullYear();

  var PUB_TYPE_GROUPS = [
    { name: 'Synthesis', types: ['Systematic Review', 'Meta-Analysis'] },
    { name: 'Trials', types: ['Randomized Controlled Trial', 'Clinical Trial', 'Controlled Clinical Trial'] },
    { name: 'Guidelines', types: ['Practice Guideline', 'Guideline'] },
    { name: 'Reviews', types: ['Review', 'Scoping Review'] },
    { name: 'Other', types: ['Observational Study', 'Comparative Study', 'Case Reports'] }
  ];

  var ALL_PUB_TYPES = PUB_TYPE_GROUPS.reduce(function (acc, g) {
    return acc.concat(g.types);
  }, []);

  var DEFAULT_PUB_TYPES = ['Systematic Review', 'Meta-Analysis', 'Randomized Controlled Trial'];

  var QUARTILE_ORDER = { Q1: 0, Q2: 1, Q3: 2, Q4: 3 };

  // =========================================================
  // State
  // =========================================================

  var state = {
    terms: [{ value: '', joiner: 'AND' }],
    pubTypes: new Set(DEFAULT_PUB_TYPES),
    yearFrom: 2000,
    yearTo: CURRENT_YEAR,
    maxResults: 100,
    perPage: 50,
    currentPage: 1,
    sortMode: 'newest',
    decisionFilter: 'all', // 'all' | 'undecided' | 'keep' | 'maybe' | 'skip'
    results: [],
    totalCount: 0,
    hasSearched: false,
    possiblyMissed: []
  };

  var scimagoMap = new Map();
  var scimagoMeta = null;
  var abstractCache = new Map(); // pmid -> abstract text, session-only (Phase 2)

  var dom = {};

  // =========================================================
  // localStorage helpers (API key) — spec §3.3a / §7
  // =========================================================

  function getApiKey() {
    try {
      return (localStorage.getItem(API_KEY_STORAGE_KEY) || '').trim();
    } catch (e) {
      return '';
    }
  }

  function setApiKey(key) {
    try {
      if (key) {
        localStorage.setItem(API_KEY_STORAGE_KEY, key);
      } else {
        localStorage.removeItem(API_KEY_STORAGE_KEY);
      }
    } catch (e) {
      // localStorage unavailable (e.g. private mode restrictions) - degrade silently.
    }
  }

  // =========================================================
  // Throttle queue — spec §4 / §3.3a (3 req/sec, 10 req/sec with key)
  // =========================================================

  function ThrottleQueue() {
    this.queue = [];
    this.processing = false;
  }

  ThrottleQueue.prototype.enqueue = function (taskFn) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self.queue.push({ taskFn: taskFn, resolve: resolve, reject: reject });
      self._process();
    });
  };

  ThrottleQueue.prototype._process = function () {
    var self = this;
    if (self.processing) return;
    self.processing = true;

    function step() {
      if (self.queue.length === 0) {
        self.processing = false;
        return;
      }
      var item = self.queue.shift();
      Promise.resolve()
        .then(item.taskFn)
        .then(item.resolve, item.reject)
        .then(function () {
          var rate = getApiKey() ? 10 : 3;
          var delayMs = Math.ceil(1000 / rate);
          setTimeout(step, delayMs);
        });
    }

    step();
  };

  var throttleQueue = new ThrottleQueue();

  // =========================================================
  // E-utilities network calls — spec §4
  // =========================================================

  function buildEutilsUrl(endpoint, params) {
    var url = new URL(EUTILS_BASE + endpoint);
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) {
        url.searchParams.set(k, params[k]);
      }
    });
    var key = getApiKey();
    if (key) url.searchParams.set('api_key', key);
    return url.toString();
  }

  function chunkArray(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  }

  function esearch(query, maxResults) {
    var url = buildEutilsUrl('esearch.fcgi', {
      db: 'pubmed',
      retmode: 'json',
      retmax: String(maxResults),
      term: query
    });
    return throttleQueue.enqueue(function () { return fetch(url); })
      .then(function (res) {
        if (!res.ok) throw new Error('esearch failed: HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var r = data.esearchresult || {};
        return {
          idlist: r.idlist || [],
          count: parseInt(r.count, 10) || 0
        };
      });
  }

  function esummaryBatch(pmids) {
    var batches = chunkArray(pmids, 200);
    var resultMap = {};
    var promises = batches.map(function (batch) {
      var url = buildEutilsUrl('esummary.fcgi', {
        db: 'pubmed',
        retmode: 'json',
        id: batch.join(',')
      });
      return throttleQueue.enqueue(function () { return fetch(url); })
        .then(function (res) {
          if (!res.ok) throw new Error('esummary failed: HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          var result = data.result || {};
          batch.forEach(function (pmid) {
            if (result[pmid]) resultMap[pmid] = result[pmid];
          });
        });
    });
    return Promise.all(promises).then(function () { return resultMap; });
  }

  function fetchAbstract(pmid) {
    if (abstractCache.has(pmid)) {
      return Promise.resolve(abstractCache.get(pmid));
    }
    var url = buildEutilsUrl('efetch.fcgi', {
      db: 'pubmed',
      retmode: 'xml',
      id: pmid
    });
    return throttleQueue.enqueue(function () { return fetch(url); })
      .then(function (res) {
        if (!res.ok) throw new Error('efetch failed: HTTP ' + res.status);
        return res.text();
      })
      .then(function (xmlText) {
        var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
        var parserError = doc.querySelector('parsererror');
        if (parserError) throw new Error('Failed to parse efetch XML response');

        var nodes = doc.querySelectorAll('AbstractText');
        var text;
        if (!nodes || nodes.length === 0) {
          text = '(No abstract available)';
        } else {
          var parts = [];
          nodes.forEach(function (n) {
            var label = n.getAttribute('Label') || n.getAttribute('NlmCategory');
            var t = (n.textContent || '').trim();
            if (!t) return;
            parts.push(label ? (label + ': ' + t) : t);
          });
          text = parts.length ? parts.join('\n\n') : '(No abstract available)';
        }
        abstractCache.set(pmid, text);
        return text;
      });
  }

  // =========================================================
  // Citation counts (Europe PMC) — spec §8 Phase 3, opt-in
  // The ONLY feature in this file that contacts a host other than
  // eutils.ncbi.nlm.nih.gov (spec §7). Off by default; only ever runs
  // when the user has explicitly enabled it in Settings, and the
  // Settings help text discloses exactly what's sent (PMIDs only).
  // =========================================================

  var EUROPEPMC_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/';
  var CITATION_COUNTS_KEY = 'citation_counts_enabled';
  var citationCountCache = new Map(); // pmid -> count, session-only

  function getCitationCountsEnabled() {
    try {
      return localStorage.getItem(CITATION_COUNTS_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setCitationCountsEnabled(enabled) {
    try {
      if (enabled) localStorage.setItem(CITATION_COUNTS_KEY, '1');
      else localStorage.removeItem(CITATION_COUNTS_KEY);
    } catch (e) {
      // localStorage unavailable - degrade silently, same as the API key helper.
    }
  }

  function fetchCitationCounts(pmids) {
    var batches = chunkArray(pmids, 25); // keeps each query URL a sane length
    var resultMap = new Map();
    var promises = batches.map(function (batch) {
      var query = '(' + batch.map(function (id) { return 'EXT_ID:' + id; }).join(' OR ') + ') AND SRC:MED';
      var url = EUROPEPMC_BASE + 'search?query=' + encodeURIComponent(query) +
        '&format=json&resultType=core&pageSize=' + batch.length;
      return fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('Europe PMC request failed: HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          var results = (data.resultList && data.resultList.result) || [];
          results.forEach(function (r) {
            if (r.pmid) resultMap.set(r.pmid, r.citedByCount || 0);
          });
        });
    });
    return Promise.all(promises).then(function () { return resultMap; });
  }

  function applyCitationBadges(papers, containerEl) {
    papers.forEach(function (paper) {
      if (!citationCountCache.has(paper.pmid)) return;
      var card = containerEl.querySelector('.paper-card[data-pmid="' + paper.pmid + '"]');
      var badge = card && card.querySelector('.badge-cited');
      if (badge) badge.textContent = 'Cited by ' + citationCountCache.get(paper.pmid);
    });
  }

  function fetchAndApplyCitationCounts(papers, containerEl) {
    if (!getCitationCountsEnabled() || !papers.length) return;
    applyCitationBadges(papers, containerEl); // paint whatever's already cached immediately
    var needed = papers.map(function (p) { return p.pmid; }).filter(function (pmid) { return !citationCountCache.has(pmid); });
    if (!needed.length) return;
    fetchCitationCounts(needed).then(function (countMap) {
      countMap.forEach(function (count, pmid) { citationCountCache.set(pmid, count); });
      applyCitationBadges(papers, containerEl);
    }).catch(function (err) {
      console.error('Europe PMC citation count fetch failed', err);
    });
  }

  // =========================================================
  // Query string generation — spec §3.1 (format must match exactly)
  // =========================================================

  function buildTermsClause(terms) {
    var parts = [];
    terms.forEach(function (t) {
      var val = (t.value || '').trim();
      if (!val) return;
      var clause = '"' + val.replace(/"/g, '') + '"[Title/Abstract]';
      if (parts.length === 0) {
        parts.push(clause);
      } else {
        var joiner = t.joiner === 'OR' ? 'OR' : 'AND';
        parts.push(joiner + ' ' + clause);
      }
    });
    if (parts.length === 0) return '';
    var joined = parts.join(' ');
    return parts.length > 1 ? '(' + joined + ')' : joined;
  }

  function buildYearClause(yearFrom, yearTo) {
    var fromActive = yearFrom > 2000;
    var toActive = yearTo < CURRENT_YEAR;
    if (!fromActive && !toActive) return '';
    var fromStr = fromActive ? (yearFrom + '/01/01') : '1500/01/01';
    var toStr = toActive ? (yearTo + '/12/31') : '3000';
    return '("' + fromStr + '"[Date - Publication] : "' + toStr + '"[Date - Publication])';
  }

  function buildPubTypeClause(selectedSet) {
    var selected = ALL_PUB_TYPES.filter(function (pt) { return selectedSet.has(pt); });
    if (selected.length === 0 || selected.length === ALL_PUB_TYPES.length) return '';
    var parts = selected.map(function (pt) { return '"' + pt + '"[Publication Type]'; });
    return '(' + parts.join(' OR ') + ')';
  }

  function generateQueryClauses() {
    var clauses = [];
    var termsClause = buildTermsClause(state.terms);
    if (termsClause) clauses.push(termsClause);
    var yearClause = buildYearClause(state.yearFrom, state.yearTo);
    if (yearClause) clauses.push(yearClause);
    var pubTypeClause = buildPubTypeClause(state.pubTypes);
    if (pubTypeClause) clauses.push(pubTypeClause);
    return clauses;
  }

  function generateQueryString(forDisplay) {
    var clauses = generateQueryClauses();
    if (clauses.length === 0) return '';
    return forDisplay ? clauses.join('\nAND ') : clauses.join(' AND ');
  }

  // =========================================================
  // SCImago tier application — spec §5
  // =========================================================

  function applyTierLookup(papers) {
    papers.forEach(function (p) {
      var entry = window.Scimago.lookupJournal(scimagoMap, p.journal);
      if (entry) {
        p.tier = {
          quartile: entry.quartile,
          sjr: entry.sjr,
          publisher: entry.publisher,
          sourceUrl: window.Scimago.sourceUrlFor(entry.sourceId)
        };
      } else {
        p.tier = null;
      }
    });
  }

  // =========================================================
  // esummary -> paper object mapping
  // =========================================================

  function parseYear(pubdate) {
    if (!pubdate) return null;
    var m = String(pubdate).match(/\d{4}/);
    return m ? parseInt(m[0], 10) : null;
  }

  function stripHtml(str) {
    var div = document.createElement('div');
    div.innerHTML = str;
    return div.textContent || div.innerText || '';
  }

  function extractDoi(articleids) {
    var found = (articleids || []).filter(function (a) { return a.idtype === 'doi'; })[0];
    return found ? found.value : null;
  }

  function buildPaperFromSummary(pmid, item) {
    var journal = item.fulljournalname || item.source || '';
    var authors = (item.authors || []).map(function (a) { return a.name; }).filter(Boolean);
    var pubtypes = item.pubtype || [];
    return {
      pmid: pmid,
      title: item.title ? stripHtml(item.title) : '(No title)',
      journal: journal,
      journalAbbrev: item.source || journal, // Vancouver citations use the abbreviated form
      year: parseYear(item.pubdate),
      pubdateRaw: item.pubdate || '', // kept for month/day parsing at export time
      volume: item.volume || '',
      issue: item.issue || '',
      pages: item.pages || '',
      doi: extractDoi(item.articleids),
      authors: authors,
      pubtypes: pubtypes,
      tier: null,
      decision: null // 'keep' | 'maybe' | 'skip' | null — persisted per-PMID in IndexedDB (spec §8 Phase 3)
    };
  }

  // =========================================================
  // Sorting — spec §3.2
  // =========================================================

  function quartileRank(paper) {
    var q = paper.tier && paper.tier.quartile;
    return (q && QUARTILE_ORDER.hasOwnProperty(q)) ? QUARTILE_ORDER[q] : 4;
  }

  function pubTypeRank(paper) {
    var types = paper.pubtypes || [];
    for (var i = 0; i < ALL_PUB_TYPES.length; i++) {
      if (types.indexOf(ALL_PUB_TYPES[i]) !== -1) return i;
    }
    return ALL_PUB_TYPES.length;
  }

  function sortResults(results, mode) {
    var copy = results.slice();
    copy.sort(function (a, b) {
      if (mode === 'tier') {
        var qa = quartileRank(a), qb = quartileRank(b);
        if (qa !== qb) return qa - qb;
        return (b.year || 0) - (a.year || 0);
      }
      if (mode === 'pubtype') {
        var pa = pubTypeRank(a), pb = pubTypeRank(b);
        if (pa !== pb) return pa - pb;
        return (b.year || 0) - (a.year || 0);
      }
      return (b.year || 0) - (a.year || 0); // newest (default)
    });
    return copy;
  }

  // =========================================================
  // Decision persistence (Keep / Maybe / Skip) — spec §8 Phase 3
  // Separate IndexedDB database from scimago.js's, since this isn't
  // SCImago data — keeps that file scoped to CSV parsing as spec'd.
  // =========================================================

  var DECISIONS_DB_NAME = 'pubmed_tool_decisions_db';
  var DECISIONS_DB_VERSION = 1;
  var DECISIONS_STORE = 'decisions';

  var decisionsCache = new Map(); // pmid -> 'keep' | 'maybe' | 'skip', loaded once at init

  function openDecisionsDB() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB not supported in this browser'));
        return;
      }
      var req = indexedDB.open(DECISIONS_DB_NAME, DECISIONS_DB_VERSION);
      req.onupgradeneeded = function (evt) {
        var db = evt.target.result;
        if (!db.objectStoreNames.contains(DECISIONS_STORE)) {
          db.createObjectStore(DECISIONS_STORE, { keyPath: 'pmid' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // Only the fields citation export actually needs are snapshotted — no
  // tier/decision, which are re-derived (tier from SCImago) or redundant
  // (decision is the record's own field) at read time.
  function snapshotPaper(paper) {
    return {
      pmid: paper.pmid,
      title: paper.title,
      journal: paper.journal,
      journalAbbrev: paper.journalAbbrev,
      year: paper.year,
      pubdateRaw: paper.pubdateRaw,
      volume: paper.volume,
      issue: paper.issue,
      pages: paper.pages,
      doi: paper.doi,
      authors: paper.authors
    };
  }

  function saveDecision(pmid, decision, paper) {
    return openDecisionsDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DECISIONS_STORE, 'readwrite');
        var store = tx.objectStore(DECISIONS_STORE);
        if (decision === null) {
          store.delete(pmid);
        } else {
          store.put({
            pmid: pmid,
            decision: decision,
            decidedAt: Date.now(),
            paper: paper ? snapshotPaper(paper) : null
          });
        }
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function (err) {
      console.error('Failed to save decision for PMID ' + pmid, err);
    });
  }

  function loadAllDecisionRecords() {
    return openDecisionsDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DECISIONS_STORE, 'readonly');
        var store = tx.objectStore(DECISIONS_STORE);
        var req = store.getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
        tx.oncomplete = function () { db.close(); };
      });
    }).catch(function (err) {
      console.error('Failed to load decision records from IndexedDB', err);
      return [];
    });
  }

  function loadAllDecisions() {
    return loadAllDecisionRecords().then(function (records) {
      var map = new Map();
      records.forEach(function (rec) { map.set(rec.pmid, rec.decision); });
      return map;
    });
  }

  function applySavedDecisions(papers) {
    papers.forEach(function (p) {
      if (decisionsCache.has(p.pmid)) p.decision = decisionsCache.get(p.pmid);
    });
  }

  // =========================================================
  // Citation export (Vancouver + .ris) — spec §8 Phase 3
  // Works off the persisted "keep" decisions across ALL past searches
  // (not just the current one), since that's the whole point of
  // persisting decisions in the first place — the Keep list survives
  // reloads and later searches, so export must too.
  // =========================================================

  function parsePubdateParts(pubdateRaw) {
    var m = /^(\d{4})(?:\s+([A-Za-z]+))?(?:\s+(\d{1,2}))?/.exec(pubdateRaw || '');
    if (!m) return { year: '', month: '', day: '' };
    return { year: m[1] || '', month: m[2] || '', day: m[3] || '' };
  }

  function formatVancouver(paper) {
    var bits = [];
    if (paper.authors && paper.authors.length) bits.push(paper.authors.join(', ') + '.');
    if (paper.title) bits.push(paper.title.replace(/\.+$/, '') + '.');
    if (paper.journalAbbrev) bits.push(paper.journalAbbrev + '.');

    var parts = parsePubdateParts(paper.pubdateRaw);
    var dateStr = [parts.year, parts.month, parts.day].filter(Boolean).join(' ');
    var volIssue = paper.volume ? (paper.volume + (paper.issue ? '(' + paper.issue + ')' : '')) : '';
    var tail = dateStr;
    if (volIssue) tail += ';' + volIssue;
    if (paper.pages) tail += ':' + paper.pages;
    if (tail) bits.push(tail + '.');

    if (paper.doi) bits.push('doi: ' + paper.doi + '.');
    bits.push('PMID: ' + paper.pmid + '.');

    return bits.join(' ');
  }

  function formatRISEntry(paper) {
    var lines = ['TY  - JOUR'];
    (paper.authors || []).forEach(function (a) { lines.push('AU  - ' + a); });
    if (paper.title) lines.push('TI  - ' + paper.title);
    if (paper.journalAbbrev) lines.push('T2  - ' + paper.journalAbbrev);
    if (paper.year) lines.push('PY  - ' + paper.year);
    if (paper.volume) lines.push('VL  - ' + paper.volume);
    if (paper.issue) lines.push('IS  - ' + paper.issue);
    if (paper.pages) {
      var pageParts = String(paper.pages).split('-');
      lines.push('SP  - ' + pageParts[0]);
      if (pageParts[1]) lines.push('EP  - ' + pageParts[1]);
    }
    if (paper.doi) lines.push('DO  - ' + paper.doi);
    lines.push('UR  - https://pubmed.ncbi.nlm.nih.gov/' + paper.pmid + '/');
    lines.push('AN  - ' + paper.pmid);
    lines.push('ER  - ');
    return lines.join('\n');
  }

  function csvField(value) {
    var s = value == null ? '' : String(value);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function formatCSVAll(papers) {
    var header = ['Title', 'Authors', 'Journal', 'Year', 'Volume', 'Issue', 'Pages', 'DOI', 'PMID', 'Link'];
    var rows = papers.map(function (p) {
      return [
        p.title,
        (p.authors || []).join('; '),
        p.journal || p.journalAbbrev || '',
        p.year || '',
        p.volume || '',
        p.issue || '',
        p.pages || '',
        p.doi || '',
        p.pmid,
        'https://pubmed.ncbi.nlm.nih.gov/' + p.pmid + '/'
      ].map(csvField).join(',');
    });
    // Leading BOM so Excel (especially on Windows) reliably detects UTF-8
    // instead of mis-rendering non-ASCII author/journal names.
    var BOM = String.fromCharCode(0xFEFF);
    return BOM + [header.join(',')].concat(rows).join('\r\n');
  }

  function getKeptPapers() {
    return loadAllDecisionRecords().then(function (records) {
      return records
        .filter(function (r) { return r.decision === 'keep' && r.paper; })
        .map(function (r) { return r.paper; })
        .sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
    });
  }

  function refreshExportBar() {
    getKeptPapers().then(function (papers) {
      dom.exportCount.textContent = String(papers.length);
      dom.exportCopyBtn.disabled = papers.length === 0;
      dom.exportCsvBtn.disabled = papers.length === 0;
      dom.exportRisBtn.disabled = papers.length === 0;
    });
  }

  function downloadTextFile(filename, text, mimeType) {
    var blob = new Blob([text], { type: mimeType || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function initExportBar() {
    dom.exportCopyBtn.addEventListener('click', function () {
      getKeptPapers().then(function (papers) {
        if (!papers.length) return;
        copyToClipboardWithFlash(papers.map(formatVancouver).join('\n\n'), dom.exportCopyBtn);
      });
    });

    dom.exportCsvBtn.addEventListener('click', function () {
      getKeptPapers().then(function (papers) {
        if (!papers.length) return;
        downloadTextFile('pubmed-keep-list.csv', formatCSVAll(papers), 'text/csv;charset=utf-8');
      });
    });

    dom.exportRisBtn.addEventListener('click', function () {
      getKeptPapers().then(function (papers) {
        if (!papers.length) return;
        var text = papers.map(formatRISEntry).join('\n\n');
        downloadTextFile('pubmed-keep-list.ris', text, 'application/x-research-info-systems');
      });
    });
  }

  // =========================================================
  // Search flow — spec §4 Phase 1
  // =========================================================

  // Pub-type filtering relies on PubMed's own Publication Type tags, which
  // are frequently missing or too generic ("Review" instead of "Systematic
  // Review") for newer / open-access-only-indexed journals — verified
  // directly against eutils on real records. This re-runs the same query
  // without the pub-type clause and flags any extra hits whose title reads
  // like a review PubMed didn't tag as one, instead of silently dropping them.
  var REVIEW_TITLE_RE = /systematic review|meta-analysis/i;

  function findPossiblyMissedReviews(primaryIds) {
    var pubTypeClause = buildPubTypeClause(state.pubTypes);
    if (!pubTypeClause) return Promise.resolve([]); // filter not active, nothing to catch

    var clauses = [];
    var termsClause = buildTermsClause(state.terms);
    if (termsClause) clauses.push(termsClause);
    var yearClause = buildYearClause(state.yearFrom, state.yearTo);
    if (yearClause) clauses.push(yearClause);
    if (!clauses.length) return Promise.resolve([]);
    var broadQuery = clauses.join(' AND ');

    var primarySet = new Set(primaryIds);

    return esearch(broadQuery, state.maxResults).then(function (searchResult) {
      var extraIds = searchResult.idlist.filter(function (id) { return !primarySet.has(id); });
      if (!extraIds.length) return [];
      return esummaryBatch(extraIds).then(function (summaryMap) {
        var papers = extraIds
          .filter(function (pmid) { return summaryMap[pmid]; })
          .map(function (pmid) { return buildPaperFromSummary(pmid, summaryMap[pmid]); })
          .filter(function (p) { return REVIEW_TITLE_RE.test(p.title); });
        applyTierLookup(papers);
        return papers;
      });
    });
  }

  function doSearch() {
    // A search always needs at least one real keyword — pub type / year
    // filters alone (which are shown in the live preview regardless) are
    // not a sufficient query on their own.
    if (!buildTermsClause(state.terms)) {
      showSearchError('Please enter at least one search term / กรุณากรอกคำค้นหาอย่างน้อย 1 term.');
      return;
    }
    var query = generateQueryString(false);

    clearSearchError();
    setSearchLoading(true);
    dom.searchBtn.disabled = true;
    state.possiblyMissed = [];
    renderPossiblyMissed();

    esearch(query, state.maxResults)
      .then(function (searchResult) {
        state.totalCount = searchResult.count;
        state.hasSearched = true;

        if (searchResult.idlist.length === 0) {
          state.results = [];
          state.currentPage = 1;
          renderResults();
          return null;
        }

        return esummaryBatch(searchResult.idlist).then(function (summaryMap) {
          var papers = searchResult.idlist
            .filter(function (pmid) { return summaryMap[pmid]; })
            .map(function (pmid) { return buildPaperFromSummary(pmid, summaryMap[pmid]); });
          applyTierLookup(papers);
          applySavedDecisions(papers);
          state.results = papers;
          state.currentPage = 1;
          renderResults();

          var primaryIds = papers.map(function (p) { return p.pmid; });
          return findPossiblyMissedReviews(primaryIds).catch(function (err) {
            console.error('Possibly-missed check failed', err);
            return [];
          }).then(function (extra) {
            applySavedDecisions(extra);
            state.possiblyMissed = extra;
            renderPossiblyMissed();
          });
        });
      })
      .catch(function (err) {
        console.error(err);
        showSearchError('Search failed: ' + err.message);
      })
      .then(function () {
        setSearchLoading(false);
        dom.searchBtn.disabled = false;
      });
  }

  function showSearchError(msg) {
    dom.searchError.textContent = msg;
    dom.searchError.classList.add('visible');
  }

  function clearSearchError() {
    dom.searchError.textContent = '';
    dom.searchError.classList.remove('visible');
  }

  function setSearchLoading(isLoading) {
    dom.searchLoading.innerHTML = '';
    if (isLoading) {
      var spinner = document.createElement('span');
      spinner.className = 'spinner';
      dom.searchLoading.appendChild(spinner);
      dom.searchLoading.appendChild(document.createTextNode('Searching PubMed…'));
    }
    dom.searchLoading.classList.toggle('visible', isLoading);
  }

  // =========================================================
  // Rendering — results list, cards, pagination — spec §3.2
  // =========================================================

  function filterByDecision(list) {
    if (state.decisionFilter === 'all') return list;
    if (state.decisionFilter === 'undecided') return list.filter(function (p) { return !p.decision; });
    return list.filter(function (p) { return p.decision === state.decisionFilter; });
  }

  function getPagedResults() {
    var filtered = filterByDecision(state.results);
    var sorted = sortResults(filtered, state.sortMode);
    var perPage = state.perPage;
    var totalItems = sorted.length;
    var totalPages = Math.max(1, Math.ceil(totalItems / perPage));
    if (state.currentPage > totalPages) state.currentPage = totalPages;
    if (state.currentPage < 1) state.currentPage = 1;
    var startIdx = (state.currentPage - 1) * perPage;
    var pageItems = sorted.slice(startIdx, startIdx + perPage);
    return { pageItems: pageItems, totalItems: totalItems, totalPages: totalPages, startIdx: startIdx };
  }

  function renderResults() {
    dom.resultsList.innerHTML = '';

    if (!state.results.length) {
      dom.resultsSummary.textContent = state.hasSearched
        ? 'No results found for this query.'
        : 'Run a search to see results here.';
      dom.paginationInfo.textContent = '';
      dom.pageButtons.innerHTML = '';
      return;
    }

    var paged = getPagedResults();

    var summary = 'PubMed reports ' + state.totalCount + ' total match(es).';
    if (state.results.length < state.totalCount) {
      summary += ' Showing first ' + state.results.length + ' (raise "Max results" to fetch more).';
    }
    if (state.decisionFilter !== 'all') {
      summary += ' ' + paged.totalItems + ' match the "' + state.decisionFilter + '" filter.';
    }
    dom.resultsSummary.textContent = summary;

    if (!paged.totalItems) {
      dom.resultsList.innerHTML = '<div class="empty-state">No papers match this filter.</div>';
      dom.paginationInfo.textContent = '';
      dom.pageButtons.innerHTML = '';
      return;
    }

    paged.pageItems.forEach(function (paper) {
      dom.resultsList.appendChild(renderCard(paper));
    });

    renderPagination(paged);
    fetchAndApplyCitationCounts(paged.pageItems, dom.resultsList);
  }

  function updatePossiblyMissedToggleLabel(visibleCount) {
    var isOpen = dom.possiblyMissedList.classList.contains('open');
    dom.possiblyMissedToggle.textContent = (isOpen ? '▾' : '▸') + ' Possibly missed (' + visibleCount +
      ') — title says review, but PubMed didn’t tag it that way';
    dom.possiblyMissedToggle.setAttribute('aria-expanded', String(isOpen));
  }

  function renderPossiblyMissed() {
    dom.possiblyMissedList.innerHTML = '';
    var list = state.possiblyMissed;
    dom.possiblyMissedBlock.classList.toggle('hidden', list.length === 0);
    var filtered = filterByDecision(list);
    updatePossiblyMissedToggleLabel(filtered.length);
    var sorted = sortResults(filtered, 'newest');
    sorted.forEach(function (paper) {
      dom.possiblyMissedList.appendChild(renderCard(paper));
    });
    fetchAndApplyCitationCounts(sorted, dom.possiblyMissedList);
  }

  function togglePossiblyMissed() {
    dom.possiblyMissedList.classList.toggle('open');
    updatePossiblyMissedToggleLabel(filterByDecision(state.possiblyMissed).length);
  }

  function renderCard(paper) {
    var card = document.createElement('article');
    card.className = 'paper-card';
    card.dataset.pmid = paper.pmid;
    if (paper.decision) card.classList.add('decision-' + paper.decision);

    var badges = document.createElement('div');
    badges.className = 'card-badges';

    var q = paper.tier && paper.tier.quartile;
    var tierBadge = document.createElement('span');
    tierBadge.className = 'badge badge-tier ' + (q ? 'tier-' + String(q).toLowerCase() : 'tier-none');
    tierBadge.textContent = q ? q : '—';
    tierBadge.title = paper.tier
      ? ('SJR ' + (paper.tier.sjr != null ? paper.tier.sjr : 'n/a') + (paper.tier.publisher ? ' · ' + paper.tier.publisher : ''))
      : 'not indexed (no matching SCImago data loaded)';
    badges.appendChild(tierBadge);

    var pubTypeBadge = document.createElement('span');
    pubTypeBadge.className = 'badge badge-pubtype';
    pubTypeBadge.textContent = (paper.pubtypes && paper.pubtypes[0]) || 'Article';
    badges.appendChild(pubTypeBadge);

    if (getCitationCountsEnabled()) {
      var citedBadge = document.createElement('span');
      citedBadge.className = 'badge badge-cited';
      citedBadge.textContent = citationCountCache.has(paper.pmid)
        ? 'Cited by ' + citationCountCache.get(paper.pmid)
        : 'Cited by …';
      badges.appendChild(citedBadge);
    }

    card.appendChild(badges);

    var meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.appendChild(document.createTextNode((paper.year || 'n.d.') + ' · '));
    var journalEl = document.createElement('span');
    journalEl.className = 'card-journal';
    journalEl.textContent = paper.journal || 'Unknown journal';
    meta.appendChild(journalEl);
    card.appendChild(meta);

    var titleEl = document.createElement('h3');
    titleEl.className = 'card-title';
    var link = document.createElement('a');
    link.href = 'https://pubmed.ncbi.nlm.nih.gov/' + paper.pmid + '/';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = paper.title;
    titleEl.appendChild(link);
    card.appendChild(titleEl);

    var actions = document.createElement('div');
    actions.className = 'card-actions';

    var abstractBtn = document.createElement('button');
    abstractBtn.type = 'button';
    abstractBtn.className = 'btn btn-abstract';
    abstractBtn.textContent = 'Abstract';
    actions.appendChild(abstractBtn);

    var keepBtn = document.createElement('button');
    keepBtn.type = 'button';
    keepBtn.className = 'btn btn-keep' + (paper.decision === 'keep' ? ' active' : '');
    keepBtn.textContent = 'Keep';
    actions.appendChild(keepBtn);

    var maybeBtn = document.createElement('button');
    maybeBtn.type = 'button';
    maybeBtn.className = 'btn btn-maybe' + (paper.decision === 'maybe' ? ' active' : '');
    maybeBtn.textContent = 'Maybe';
    actions.appendChild(maybeBtn);

    var copyCiteBtn = document.createElement('button');
    copyCiteBtn.type = 'button';
    copyCiteBtn.className = 'btn btn-copy-cite';
    copyCiteBtn.textContent = 'Copy citation';
    actions.appendChild(copyCiteBtn);

    card.appendChild(actions);

    var abstractBox = document.createElement('div');
    abstractBox.className = 'abstract-box hidden';
    card.appendChild(abstractBox);

    abstractBtn.addEventListener('click', function () {
      var isHidden = abstractBox.classList.contains('hidden');
      if (!isHidden) {
        abstractBox.classList.add('hidden');
        abstractBtn.textContent = 'Abstract';
        return;
      }
      abstractBox.classList.remove('hidden');
      abstractBtn.textContent = 'Hide abstract';
      if (!abstractBox.dataset.loaded) {
        abstractBox.textContent = 'Loading abstract…';
        fetchAbstract(paper.pmid).then(function (text) {
          abstractBox.textContent = text;
          abstractBox.dataset.loaded = '1';
        }).catch(function (err) {
          abstractBox.textContent = 'Failed to load abstract: ' + err.message;
        });
      }
    });

    function applyDecisionUI(decision) {
      card.classList.remove('decision-keep', 'decision-maybe', 'decision-skip');
      if (decision) card.classList.add('decision-' + decision);
      keepBtn.classList.toggle('active', decision === 'keep');
      maybeBtn.classList.toggle('active', decision === 'maybe');
    }

    function setDecision(newDecision) {
      var finalDecision = paper.decision === newDecision ? null : newDecision;
      paper.decision = finalDecision;
      if (finalDecision) decisionsCache.set(paper.pmid, finalDecision);
      else decisionsCache.delete(paper.pmid);
      saveDecision(paper.pmid, finalDecision, paper).then(refreshExportBar);

      // Filtering by decision can make this card disappear from view, so a
      // full re-render is needed; otherwise update this card in place so an
      // expanded abstract doesn't get collapsed by a needless re-render.
      if (state.decisionFilter === 'all') {
        applyDecisionUI(finalDecision);
      } else {
        renderResults();
        renderPossiblyMissed();
      }
    }

    keepBtn.addEventListener('click', function () { setDecision('keep'); });
    maybeBtn.addEventListener('click', function () { setDecision('maybe'); });
    copyCiteBtn.addEventListener('click', function () {
      copyToClipboardWithFlash(formatVancouver(paper), copyCiteBtn);
    });

    return card;
  }

  function getPageNumbersToShow(current, total, maxButtons) {
    if (total <= maxButtons) {
      var all = [];
      for (var i = 1; i <= total; i++) all.push(i);
      return all;
    }
    var pages = [1];
    var left = Math.max(2, current - 1);
    var right = Math.min(total - 1, current + 1);
    if (left > 2) pages.push('...');
    for (var j = left; j <= right; j++) pages.push(j);
    if (right < total - 1) pages.push('...');
    pages.push(total);
    return pages;
  }

  function renderPagination(paged) {
    var startDisplay = paged.totalItems === 0 ? 0 : paged.startIdx + 1;
    var endDisplay = Math.min(paged.startIdx + state.perPage, paged.totalItems);
    dom.paginationInfo.textContent = startDisplay + '–' + endDisplay + ' of ' + paged.totalItems;

    dom.pageButtons.innerHTML = '';

    var prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'page-btn';
    prevBtn.textContent = 'Prev';
    prevBtn.disabled = state.currentPage <= 1;
    prevBtn.addEventListener('click', function () {
      state.currentPage -= 1;
      renderResults();
    });
    dom.pageButtons.appendChild(prevBtn);

    var pages = getPageNumbersToShow(state.currentPage, paged.totalPages, 7);
    pages.forEach(function (p) {
      if (p === '...') {
        var ellipsis = document.createElement('span');
        ellipsis.className = 'page-ellipsis';
        ellipsis.textContent = '…';
        dom.pageButtons.appendChild(ellipsis);
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'page-btn' + (p === state.currentPage ? ' active' : '');
      btn.textContent = String(p);
      btn.addEventListener('click', function () {
        state.currentPage = p;
        renderResults();
      });
      dom.pageButtons.appendChild(btn);
    });

    var nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'page-btn';
    nextBtn.textContent = 'Next';
    nextBtn.disabled = state.currentPage >= paged.totalPages;
    nextBtn.addEventListener('click', function () {
      state.currentPage += 1;
      renderResults();
    });
    dom.pageButtons.appendChild(nextBtn);
  }

  // =========================================================
  // Query builder UI — spec §3.1
  // =========================================================

  function renderTermRows() {
    dom.termRows.innerHTML = '';
    state.terms.forEach(function (term, idx) {
      var row = document.createElement('div');
      row.className = 'term-row';
      row.dataset.index = String(idx);

      if (idx === 0) {
        var label = document.createElement('label');
        label.className = 'term-label';
        label.textContent = 'Search';
        row.appendChild(label);
      } else {
        var joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.className = 'joiner-toggle';
        joinBtn.textContent = term.joiner;
        joinBtn.addEventListener('click', function () {
          term.joiner = term.joiner === 'AND' ? 'OR' : 'AND';
          joinBtn.textContent = term.joiner;
          updateQueryPreview();
        });
        row.appendChild(joinBtn);
      }

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'term-input';
      input.placeholder = idx === 0 ? 'e.g. hallux valgus' : 'e.g. conservative';
      input.value = term.value;
      input.addEventListener('input', function () {
        term.value = input.value;
        updateQueryPreview();
      });
      row.appendChild(input);

      if (idx > 0) {
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-term-btn';
        removeBtn.setAttribute('aria-label', 'Remove term');
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', function () {
          state.terms.splice(idx, 1);
          renderTermRows();
          updateQueryPreview();
        });
        row.appendChild(removeBtn);
      }

      dom.termRows.appendChild(row);
    });
  }

  function initPubTypeChips() {
    var chips = dom.pubTypeChips.querySelectorAll('[data-pubtype]');
    chips.forEach(function (chip) {
      var pt = chip.dataset.pubtype;
      chip.classList.toggle('selected', state.pubTypes.has(pt));
      chip.setAttribute('aria-pressed', state.pubTypes.has(pt) ? 'true' : 'false');
      chip.addEventListener('click', function () {
        if (state.pubTypes.has(pt)) {
          state.pubTypes.delete(pt);
        } else {
          state.pubTypes.add(pt);
        }
        chip.classList.toggle('selected', state.pubTypes.has(pt));
        chip.setAttribute('aria-pressed', state.pubTypes.has(pt) ? 'true' : 'false');
        updateQueryPreview();
      });
    });
  }

  function yearToPercent(year) {
    return ((year - YEAR_MIN) / (CURRENT_YEAR - YEAR_MIN)) * 100;
  }

  function buildYearTicks() {
    var years = [];
    for (var y = YEAR_MIN; y < CURRENT_YEAR; y += 10) years.push(y);
    years.push(CURRENT_YEAR);
    dom.yearSliderTicks.innerHTML = '';
    years.forEach(function (y) {
      var tick = document.createElement('span');
      tick.className = 'year-tick';
      tick.style.left = yearToPercent(y) + '%';
      tick.textContent = y;
      dom.yearSliderTicks.appendChild(tick);
    });
  }

  function updateYearUI() {
    var toLabel = state.yearTo >= CURRENT_YEAR ? 'Present' : String(state.yearTo);
    dom.yearRangeLabel.textContent = state.yearFrom + ' – ' + toLabel;
    var pctFrom = yearToPercent(state.yearFrom);
    var pctTo = yearToPercent(state.yearTo);
    dom.yearSliderRange.style.left = pctFrom + '%';
    dom.yearSliderRange.style.width = Math.max(0, pctTo - pctFrom) + '%';
    dom.yearThumbFrom.style.left = pctFrom + '%';
    dom.yearThumbTo.style.left = pctTo + '%';
    dom.yearThumbFrom.setAttribute('aria-valuenow', String(state.yearFrom));
    dom.yearThumbFrom.setAttribute('aria-valuemax', String(state.yearTo));
    dom.yearThumbTo.setAttribute('aria-valuenow', String(state.yearTo));
    dom.yearThumbTo.setAttribute('aria-valuemax', String(CURRENT_YEAR));
  }

  function setYearFrom(year) {
    year = Math.max(YEAR_MIN, Math.min(CURRENT_YEAR, Math.round(year)));
    if (year > state.yearTo) year = state.yearTo;
    if (year === state.yearFrom) return;
    state.yearFrom = year;
    updateYearUI();
    updateQueryPreview();
  }

  function setYearTo(year) {
    year = Math.max(YEAR_MIN, Math.min(CURRENT_YEAR, Math.round(year)));
    if (year < state.yearFrom) year = state.yearFrom;
    if (year === state.yearTo) return;
    state.yearTo = year;
    updateYearUI();
    updateQueryPreview();
  }

  function initYearSlider() {
    var dragging = null; // 'from' | 'to' | null

    function yearFromClientX(clientX) {
      var rect = dom.yearSliderTrack.getBoundingClientRect();
      var pct = rect.width ? (clientX - rect.left) / rect.width : 0;
      pct = Math.min(1, Math.max(0, pct));
      return YEAR_MIN + pct * (CURRENT_YEAR - YEAR_MIN);
    }

    function beginDrag(which) {
      return function (evt) {
        dragging = which;
        if (evt.pointerId !== undefined && evt.target.setPointerCapture) {
          evt.target.setPointerCapture(evt.pointerId);
        }
        evt.preventDefault();
      };
    }

    function onMove(evt) {
      if (!dragging) return;
      var year = yearFromClientX(evt.clientX);
      if (dragging === 'from') setYearFrom(year); else setYearTo(year);
    }

    function endDrag() { dragging = null; }

    function jumpToNearest(evt) {
      var year = yearFromClientX(evt.clientX);
      var nearerFrom = Math.abs(year - state.yearFrom) <= Math.abs(year - state.yearTo);
      if (nearerFrom) setYearFrom(year); else setYearTo(year);
    }

    // Pointer Events cover mouse/touch/pen in one API and are supported by
    // all modern engines; plain mouse events are added alongside as a
    // fallback for any environment that doesn't dispatch pointer events,
    // and the two sets of handlers are idempotent so both firing is safe.
    dom.yearThumbFrom.addEventListener('pointerdown', beginDrag('from'));
    dom.yearThumbTo.addEventListener('pointerdown', beginDrag('to'));
    dom.yearThumbFrom.addEventListener('mousedown', beginDrag('from'));
    dom.yearThumbTo.addEventListener('mousedown', beginDrag('to'));

    window.addEventListener('pointermove', onMove);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    dom.yearSliderTrack.addEventListener('pointerdown', jumpToNearest);
    dom.yearSliderTrack.addEventListener('mousedown', jumpToNearest);

    function keyHandler(which) {
      return function (evt) {
        var step = evt.shiftKey ? 5 : 1;
        var current = which === 'from' ? state.yearFrom : state.yearTo;
        var next = null;
        if (evt.key === 'ArrowLeft' || evt.key === 'ArrowDown') next = current - step;
        else if (evt.key === 'ArrowRight' || evt.key === 'ArrowUp') next = current + step;
        else if (evt.key === 'Home') next = YEAR_MIN;
        else if (evt.key === 'End') next = CURRENT_YEAR;
        else return;
        evt.preventDefault();
        if (which === 'from') setYearFrom(next); else setYearTo(next);
      };
    }
    dom.yearThumbFrom.addEventListener('keydown', keyHandler('from'));
    dom.yearThumbTo.addEventListener('keydown', keyHandler('to'));
  }

  function updateQueryPreview() {
    var text = generateQueryString(true);
    dom.queryPreviewText.textContent = text || '(enter at least one search term)';
  }

  function toggleQueryPreview() {
    var isOpen = dom.queryPreviewBody.classList.toggle('open');
    dom.queryPreviewToggle.setAttribute('aria-expanded', String(isOpen));
    dom.queryPreviewToggle.textContent = (isOpen ? '▾' : '▸') + ' Query preview';
  }

  function copyQueryToClipboard() {
    var text = generateQueryString(true);
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flashCopyButton, function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text, onCopied) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    (onCopied || flashCopyButton)();
  }

  function flashCopyButton() {
    var original = dom.copyQueryBtn.textContent;
    dom.copyQueryBtn.textContent = 'Copied!';
    setTimeout(function () { dom.copyQueryBtn.textContent = original; }, 1200);
  }

  function copyToClipboardWithFlash(text, buttonEl) {
    var original = buttonEl.textContent;
    var flash = function () {
      buttonEl.textContent = 'Copied!';
      setTimeout(function () { buttonEl.textContent = original; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, function () { fallbackCopy(text, flash); });
    } else {
      fallbackCopy(text, flash);
    }
  }

  // =========================================================
  // Settings panel — spec §3.3 / §6
  // =========================================================

  function updateApiKeyStatus() {
    var key = getApiKey();
    dom.apiKeyStatus.textContent = key
      ? 'API key saved in this browser (10 requests/sec).'
      : 'No API key set — running at 3 requests/sec.';
  }

  function updateCsvStatusText() {
    if (scimagoMeta && scimagoMap && scimagoMap.size) {
      var prefix = scimagoMeta.bundled ? 'Currently using bundled default: SCImago ' : 'Currently using: SCImago ';
      var suffix = scimagoMeta.bundled ? ' (upload a newer CSV below anytime).' : '.';
      dom.csvStatus.textContent = prefix + (scimagoMeta.year || '(unknown year)') +
        ' — ' + (scimagoMeta.filename || 'uploaded file') + ' (' + scimagoMap.size + ' journals loaded)' + suffix;
    } else {
      dom.csvStatus.textContent = 'No SCImago data loaded yet. Journal tier badges will show "—" (not indexed) until you upload a CSV below.';
    }
  }

  function handleCsvUpload(file) {
    dom.csvStatus.textContent = 'Parsing ' + file.name + '…';
    var reader = new FileReader();
    reader.onerror = function () {
      dom.csvStatus.textContent = 'Failed to read file.';
    };
    reader.onload = function () {
      try {
        var map = window.Scimago.parseScimagoCSV(reader.result);
        if (map.size === 0) {
          dom.csvStatus.textContent = 'Could not parse any rows from this file. Make sure it is a genuine SCImago export (";"-delimited, decimals as ",").';
          return;
        }
        var year = window.Scimago.guessYearFromFilename(file.name);
        var meta = { filename: file.name, year: year, rowCount: map.size, uploadedAt: Date.now() };
        applyScimagoData(map, meta);
        window.Scimago.saveScimagoData(map, meta).catch(function (err) {
          console.error('Failed to cache SCImago data in IndexedDB', err);
        });
      } catch (err) {
        console.error(err);
        dom.csvStatus.textContent = 'Failed to parse CSV: ' + err.message;
      }
    };
    reader.readAsText(file);
  }

  function initSettings() {
    dom.apiKeyInput.value = getApiKey();
    updateApiKeyStatus();

    dom.apiKeyInput.addEventListener('input', function () {
      setApiKey(dom.apiKeyInput.value.trim());
      updateApiKeyStatus();
    });

    dom.settingsToggle.addEventListener('click', function () {
      var isOpen = dom.settingsPanel.classList.toggle('open');
      dom.settingsToggle.setAttribute('aria-expanded', String(isOpen));
    });

    dom.csvFileInput.addEventListener('change', function (evt) {
      var file = evt.target.files && evt.target.files[0];
      if (file) handleCsvUpload(file);
    });

    updateCsvStatusText();

    dom.citationCountsToggle.checked = getCitationCountsEnabled();
    dom.citationCountsToggle.addEventListener('change', function () {
      setCitationCountsEnabled(dom.citationCountsToggle.checked);
      renderResults();
      renderPossiblyMissed();
    });
  }

  // =========================================================
  // DOM caching + wiring
  // =========================================================

  function cacheDom() {
    dom.exportCount = document.getElementById('exportCount');
    dom.exportCopyBtn = document.getElementById('exportCopyBtn');
    dom.exportCsvBtn = document.getElementById('exportCsvBtn');
    dom.exportRisBtn = document.getElementById('exportRisBtn');

    dom.themeToggle = document.getElementById('themeToggle');
    dom.settingsToggle = document.getElementById('settingsToggle');
    dom.settingsPanel = document.getElementById('settingsPanel');
    dom.apiKeyInput = document.getElementById('apiKeyInput');
    dom.apiKeyStatus = document.getElementById('apiKeyStatus');
    dom.csvFileInput = document.getElementById('csvFileInput');
    dom.csvStatus = document.getElementById('csvStatus');
    dom.citationCountsToggle = document.getElementById('citationCountsToggle');

    dom.savedSearchesSelect = document.getElementById('savedSearchesSelect');
    dom.loadSavedSearchBtn = document.getElementById('loadSavedSearchBtn');
    dom.deleteSavedSearchBtn = document.getElementById('deleteSavedSearchBtn');
    dom.saveSearchBtn = document.getElementById('saveSearchBtn');

    dom.termRows = document.getElementById('termRows');
    dom.addTermBtn = document.getElementById('addTermBtn');
    dom.pubTypeChips = document.getElementById('pubTypeChips');
    dom.yearSliderTrack = document.getElementById('yearSliderTrack');
    dom.yearThumbFrom = document.getElementById('yearThumbFrom');
    dom.yearThumbTo = document.getElementById('yearThumbTo');
    dom.yearRangeLabel = document.getElementById('yearRangeLabel');
    dom.yearSliderRange = document.getElementById('yearSliderRange');
    dom.yearSliderTicks = document.getElementById('yearSliderTicks');
    dom.maxResultsGroup = document.getElementById('maxResultsGroup');
    dom.queryPreviewToggle = document.getElementById('queryPreviewToggle');
    dom.queryPreviewBody = document.getElementById('queryPreviewBody');
    dom.queryPreviewText = document.getElementById('queryPreviewText');
    dom.copyQueryBtn = document.getElementById('copyQueryBtn');
    dom.searchBtn = document.getElementById('searchBtn');
    dom.searchError = document.getElementById('searchError');
    dom.searchLoading = document.getElementById('searchLoading');

    dom.sortBar = document.getElementById('sortBar');
    dom.decisionFilterBar = document.getElementById('decisionFilterBar');
    dom.resultsSummary = document.getElementById('resultsSummary');
    dom.resultsList = document.getElementById('resultsList');
    dom.paginationInfo = document.getElementById('paginationInfo');
    dom.perPageSelect = document.getElementById('perPageSelect');
    dom.pageButtons = document.getElementById('pageButtons');

    dom.possiblyMissedBlock = document.getElementById('possiblyMissedBlock');
    dom.possiblyMissedToggle = document.getElementById('possiblyMissedToggle');
    dom.possiblyMissedList = document.getElementById('possiblyMissedList');
  }

  function initQueryBuilder() {
    dom.addTermBtn.addEventListener('click', function () {
      state.terms.push({ value: '', joiner: 'AND' });
      renderTermRows();
      updateQueryPreview();
    });

    initPubTypeChips();

    dom.yearThumbFrom.setAttribute('aria-valuemax', String(CURRENT_YEAR));
    buildYearTicks();
    updateYearUI();
    initYearSlider();

    var maxResultBtns = dom.maxResultsGroup.querySelectorAll('.segmented-btn');
    maxResultBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.maxResults = parseInt(btn.dataset.value, 10);
        maxResultBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        updateQueryPreview();
      });
    });

    dom.queryPreviewToggle.addEventListener('click', toggleQueryPreview);
    dom.copyQueryBtn.addEventListener('click', copyQueryToClipboard);
    dom.searchBtn.addEventListener('click', doSearch);
  }

  // =========================================================
  // Saved searches — spec §8 Phase 3
  // Stored in localStorage (small, synchronous, no parsing cost —
  // unlike the SCImago dataset or decisions, this is a handful of tiny
  // query-builder snapshots, not something that needs IndexedDB).
  // =========================================================

  var SAVED_SEARCHES_KEY = 'pubmed_tool_saved_searches';

  function getSavedSearches() {
    try {
      var raw = localStorage.getItem(SAVED_SEARCHES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function setSavedSearches(list) {
    try {
      localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(list));
    } catch (e) {
      console.error('Failed to save searches to localStorage', e);
    }
  }

  function currentSearchConfig() {
    return {
      terms: state.terms.map(function (t) { return { value: t.value, joiner: t.joiner }; }),
      pubTypes: Array.from(state.pubTypes),
      yearFrom: state.yearFrom,
      yearTo: state.yearTo,
      maxResults: state.maxResults
    };
  }

  function applySearchConfig(cfg) {
    state.terms = (cfg.terms && cfg.terms.length)
      ? cfg.terms.map(function (t) { return { value: t.value || '', joiner: t.joiner === 'OR' ? 'OR' : 'AND' }; })
      : [{ value: '', joiner: 'AND' }];
    state.pubTypes = new Set(cfg.pubTypes || DEFAULT_PUB_TYPES);
    state.yearFrom = typeof cfg.yearFrom === 'number' ? cfg.yearFrom : 2000;
    state.yearTo = typeof cfg.yearTo === 'number' ? cfg.yearTo : CURRENT_YEAR;
    state.maxResults = cfg.maxResults || 100;

    renderTermRows();

    dom.pubTypeChips.querySelectorAll('.chip').forEach(function (chip) {
      var selected = state.pubTypes.has(chip.dataset.pubtype);
      chip.classList.toggle('selected', selected);
      chip.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });

    updateYearUI();

    dom.maxResultsGroup.querySelectorAll('.segmented-btn').forEach(function (btn) {
      btn.classList.toggle('active', parseInt(btn.dataset.value, 10) === state.maxResults);
    });

    updateQueryPreview();
  }

  function refreshSavedSearchesSelect() {
    var list = getSavedSearches();
    dom.savedSearchesSelect.innerHTML = '<option value="">— Saved searches —</option>';
    list.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      dom.savedSearchesSelect.appendChild(opt);
    });
  }

  function initSavedSearches() {
    refreshSavedSearchesSelect();

    dom.saveSearchBtn.addEventListener('click', function () {
      var suggested = (state.terms[0] && state.terms[0].value) || 'search';
      var name = window.prompt('Name this saved search:', suggested);
      if (!name || !name.trim()) return;
      var list = getSavedSearches();
      list.push({
        id: String(Date.now()),
        name: name.trim(),
        config: currentSearchConfig(),
        savedAt: Date.now()
      });
      setSavedSearches(list);
      refreshSavedSearchesSelect();
      dom.savedSearchesSelect.value = list[list.length - 1].id;
    });

    dom.loadSavedSearchBtn.addEventListener('click', function () {
      var id = dom.savedSearchesSelect.value;
      if (!id) return;
      var entry = getSavedSearches().filter(function (s) { return s.id === id; })[0];
      if (!entry) return;
      applySearchConfig(entry.config);
    });

    dom.deleteSavedSearchBtn.addEventListener('click', function () {
      var id = dom.savedSearchesSelect.value;
      if (!id) return;
      setSavedSearches(getSavedSearches().filter(function (s) { return s.id !== id; }));
      refreshSavedSearchesSelect();
    });
  }

  function initSortBar() {
    var sortBtns = dom.sortBar.querySelectorAll('.sort-btn');
    sortBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.sortMode = btn.dataset.sort;
        sortBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        state.currentPage = 1;
        renderResults();
      });
    });
  }

  function initDecisionFilterBar() {
    var filterBtns = dom.decisionFilterBar.querySelectorAll('.sort-btn');
    filterBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.decisionFilter = btn.dataset.decision;
        filterBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        state.currentPage = 1;
        renderResults();
        renderPossiblyMissed();
      });
    });
  }

  function initPagination() {
    dom.perPageSelect.value = String(state.perPage);
    dom.perPageSelect.addEventListener('change', function () {
      state.perPage = parseInt(dom.perPageSelect.value, 10);
      state.currentPage = 1;
      renderResults();
    });
  }

  function initPossiblyMissed() {
    dom.possiblyMissedToggle.addEventListener('click', togglePossiblyMissed);
  }

  // Bundled default (spec §2) — a real SCImago 2025 export shipped in
  // webapp/data/. Only used the very first time, before anything is
  // cached in IndexedDB; once loaded it's cached there too so the 11MB
  // file is fetched and parsed at most once, not on every visit.
  var BUNDLED_SCIMAGO_PATH = 'data/scimagojr_2025.csv';
  var BUNDLED_SCIMAGO_YEAR = '2025';

  function applyScimagoData(map, meta) {
    scimagoMap = map;
    scimagoMeta = meta;
    applyTierLookup(state.results);
    applyTierLookup(state.possiblyMissed);
    renderResults();
    renderPossiblyMissed();
    updateCsvStatusText();
  }

  function loadBundledScimagoDefault() {
    return fetch(BUNDLED_SCIMAGO_PATH)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        var map = window.Scimago.parseScimagoCSV(text);
        if (!map.size) throw new Error('parsed 0 rows from bundled CSV');
        var meta = {
          filename: 'scimagojr_' + BUNDLED_SCIMAGO_YEAR + '.csv',
          year: BUNDLED_SCIMAGO_YEAR,
          rowCount: map.size,
          uploadedAt: Date.now(),
          bundled: true
        };
        applyScimagoData(map, meta);
        return window.Scimago.saveScimagoData(map, meta).catch(function (err) {
          console.error('Failed to cache bundled SCImago data in IndexedDB', err);
        });
      })
      .catch(function (err) {
        // No bundled file, or this browser can't fetch it (e.g. opened via
        // file:// instead of a local server) - fine, same graceful "no data
        // loaded yet" state as before the bundle existed.
        console.error('Failed to load bundled SCImago default CSV', err);
        updateCsvStatusText();
      });
  }

  function loadCachedScimagoData() {
    if (!window.Scimago) return Promise.resolve();
    return window.Scimago.loadScimagoData().then(function (data) {
      if (data && data.map && data.map.size) {
        applyScimagoData(data.map, data.meta);
        return;
      }
      return loadBundledScimagoDefault();
    }).catch(function (err) {
      console.error('Failed to load cached SCImago data from IndexedDB', err);
      return loadBundledScimagoDefault();
    });
  }

  // =========================================================
  // Theme toggle (light/dark) — explicit override on top of the
  // prefers-color-scheme default set by index.html's pre-paint script.
  // =========================================================

  var THEME_KEY = 'theme_preference';

  function getStoredTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return (t === 'light' || t === 'dark') ? t : null;
    } catch (e) {
      return null;
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      // localStorage unavailable - toggle still works this session, just won't persist.
    }
  }

  function effectiveTheme() {
    var stored = getStoredTheme();
    if (stored) return stored;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    dom.themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
    dom.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }

  function initTheme() {
    applyTheme(effectiveTheme());
    dom.themeToggle.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      setStoredTheme(next);
      applyTheme(next);
    });
  }

  function init() {
    cacheDom();
    initTheme();
    initSettings();
    initQueryBuilder();
    initSavedSearches();
    initSortBar();
    initDecisionFilterBar();
    initPagination();
    initPossiblyMissed();
    initExportBar();

    renderTermRows();
    updateQueryPreview();
    renderResults();
    renderPossiblyMissed();

    loadCachedScimagoData();
    loadAllDecisions().then(function (map) { decisionsCache = map; });
    refreshExportBar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
