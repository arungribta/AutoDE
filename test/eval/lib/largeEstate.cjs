'use strict';
/**
 * Generated large estate (Phase K2; docs/specs/context-layer.md §11 Phase K, "Fixtures").
 *
 * Deterministic: the same seed always yields the same DDL. Four systems in the shapes AutoDE's
 * engagements meet — a readable order-management system, an ERP, a legacy EDW with cryptic
 * abbreviated names, and an acquired company's CRM that uses its own vocabulary ("client",
 * "patron") — about 2 000 tables and 50 000 columns, with the same table name in several
 * schemas and systems.
 *
 * Besides the DDL it returns `needles`: tables planted with a known meaning, and a question for
 * each phrased in words that differ from the physical name (synonym, abbreviation, the other
 * organisation's term). The eval reports how many of those questions resolve to the right table.
 */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// entity: readable name, legacy abbreviation, the acquired org's word (if different)
const ENTITIES = [
  ['customer', 'CUST', 'client'], ['order', 'ORD', 'purchase'], ['invoice', 'INV', 'bill'], ['payment', 'PMT', 'remittance'],
  ['product', 'PROD', 'item'], ['shipment', 'SHPMT', 'delivery'], ['supplier', 'SUPP', 'vendor'], ['employee', 'EMP', 'associate'],
  ['account', 'ACCT', 'account'], ['transaction', 'TXN', 'transaction'], ['contract', 'CNTRCT', 'agreement'], ['claim', 'CLM', 'claim'],
  ['policy', 'PLCY', 'policy'], ['warehouse', 'WHSE', 'depot'], ['inventory', 'INVTY', 'stock'], ['price', 'PRC', 'rate'],
  ['discount', 'DISC', 'markdown'], ['campaign', 'CMPGN', 'engagement'], ['store', 'STR', 'outlet'], ['region', 'RGN', 'territory'],
  ['currency', 'CCY', 'currency'], ['budget', 'BDGT', 'budget'], ['return', 'RTN', 'return'], ['refund', 'RFND', 'reimbursement'],
  ['promotion', 'PROMO', 'offer'], ['subscription', 'SUBSCR', 'membership'], ['address', 'ADDR', 'location'], ['vehicle', 'VEH', 'vehicle'],
  ['asset', 'AST', 'asset'], ['ticket', 'TKT', 'case'], ['quote', 'QT', 'proposal'], ['forecast', 'FCST', 'projection'],
  ['receipt', 'RCPT', 'receipt'], ['journal', 'JRNL', 'journal'], ['ledger', 'LDGR', 'book'], ['carrier', 'CARR', 'shipper'],
  ['route', 'RTE', 'lane'], ['schedule', 'SCHED', 'plan'], ['tax', 'TAX', 'levy'], ['commission', 'COMM', 'incentive']
];
const SUFFIXES = [
  ['', '', ''], ['header', 'HDR', 'Header records'], ['line', 'LN', 'Line-level detail'], ['detail', 'DTL', 'Detail records'],
  ['history', 'HIST', 'Change history'], ['snapshot', 'SNAP', 'Periodic snapshot'], ['staging', 'STG', 'Staging copy'],
  ['xref', 'XREF', 'Cross-reference'], ['daily', 'DLY', 'Daily aggregate'], ['monthly', 'MTHLY', 'Monthly aggregate'],
  ['audit', 'AUD', 'Audit trail'], ['archive', 'ARCH', 'Archived records'], ['status', 'STAT', 'Status tracking'], ['type', 'TYP', 'Type codes']
];
const COLUMN_KINDS = [
  ['amount', 'AMT', 'NUMBER(18,2)'], ['quantity', 'QTY', 'INTEGER'], ['date', 'DT', 'DATE'], ['created_at', 'CRT_TS', 'TIMESTAMP'],
  ['updated_at', 'UPD_TS', 'TIMESTAMP'], ['status_code', 'STAT_CD', 'VARCHAR(10)'], ['description', 'DESC_TXT', 'VARCHAR(400)'],
  ['name', 'NM', 'VARCHAR(200)'], ['number', 'NO', 'VARCHAR(30)'], ['type_code', 'TYP_CD', 'VARCHAR(10)'], ['is_active', 'ACTV_FLG', 'CHAR(1)'],
  ['percent', 'PCT', 'NUMBER(5,2)'], ['count', 'CNT', 'INTEGER'], ['balance', 'BAL', 'NUMBER(18,2)'], ['currency_code', 'CCY_CD', 'CHAR(3)']
];

// system: id, schemas, style, tables per schema
const SYSTEMS = [
  { id: 'oms', schemas: ['sales', 'fulfilment', 'catalog', 'billing', 'returns'], style: 'readable', perSchema: 100 },
  { id: 'erp', schemas: ['fin', 'proc', 'inv', 'hr', 'assets'], style: 'readable', perSchema: 100 },
  { id: 'edw', schemas: ['EDW_SALES', 'EDW_FIN', 'EDW_OPS', 'EDW_REF', 'EDW_STG'], style: 'legacy', perSchema: 100 },
  { id: 'acquired', schemas: ['core', 'mkt', 'svc', 'loyalty', 'web'], style: 'acquired', perSchema: 100 }
];

function tableName(style, ent, suf) {
  if (style === 'legacy') return [ent[1], suf[1]].filter(Boolean).join('_');
  const word = style === 'acquired' ? ent[2] : ent[0];
  return [word, suf[0]].filter(Boolean).join('_');
}

function columnName(style, ent, kind) {
  if (style === 'legacy') return `${ent[1]}_${kind[1]}`;
  const word = style === 'acquired' ? ent[2] : ent[0];
  return `${word}_${kind[0]}`;
}

/**
 * @returns {{ files: Array<{ name: string, system: string, environment: string, ddl: string }>,
 *   tables: number, columns: number, needles: Array<{ id: string, question: string, expect: string, kind: string }> }}
 */
function generateLargeEstate({ seed = 20261015 } = {}) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const files = [];
  let tables = 0;
  let columns = 0;
  for (const sys of SYSTEMS) {
    const out = [`-- Generated large estate: system ${sys.id} (seed ${seed})`];
    for (const schema of sys.schemas) {
      const used = new Set();
      let made = 0;
      let guard = 0;
      while (made < sys.perSchema && guard++ < 10000) {
        const ent = pick(ENTITIES);
        const suf = pick(SUFFIXES);
        let name = tableName(sys.style, ent, suf);
        if (used.has(name)) name = `${name}${sys.style === 'legacy' ? '_' : '_v'}${2 + Math.floor(rand() * 8)}`;
        if (used.has(name)) continue;
        used.add(name);
        made++;
        const nCols = 8 + Math.floor(rand() * 35);
        const cols = [`  ${columnName(sys.style, ent, ['id', sys.style === 'legacy' ? 'ID' : 'id'])} BIGINT NOT NULL PRIMARY KEY`];
        const colNames = new Set([cols[0].trim().split(' ')[0]]);
        // foreign keys to 1–3 other entities
        const fks = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < fks; k++) {
          const other = pick(ENTITIES);
          const c = sys.style === 'legacy' ? `${other[1]}_ID` : `${sys.style === 'acquired' ? other[2] : other[0]}_id`;
          if (colNames.has(c)) continue;
          colNames.add(c);
          cols.push(`  ${c} BIGINT`);
        }
        while (cols.length < nCols) {
          const kind = pick(COLUMN_KINDS);
          const subject = rand() < 0.6 ? ent : pick(ENTITIES);
          let c = columnName(sys.style, subject, kind);
          if (colNames.has(c)) c = `${c}_${cols.length}`;
          colNames.add(c);
          const comment = sys.style === 'legacy' && rand() < 0.3 ? ` COMMENT '${subject[0]} ${kind[0].replace(/_/g, ' ')}'` : '';
          cols.push(`  ${c} ${kind[2]}${comment}`);
        }
        const fqn = `${schema}.${name}`;
        out.push(`CREATE TABLE ${fqn} (`, cols.join(',\n'), ');');
        // Legacy and acquired tables usually carry a comment in the readable vocabulary.
        if (sys.style !== 'readable' && rand() < 0.5) out.push(`COMMENT ON TABLE ${fqn} IS '${[ent[0], suf[0]].filter(Boolean).join(' ')} — ${suf[2] || 'Master records'}';`);
        tables++;
        columns += cols.length;
      }
    }
    files.push({ name: `${sys.id}.ddl`, system: sys.id, environment: 'prod', ddl: out.join('\n') + '\n' });
  }

  // ── Planted tables with a known meaning, and a question in other words ──
  const plant = [
    { system: 'edw', schema: 'EDW_SALES', name: 'CUST_ORD_HDR', cols: ['CUST_ORD_ID BIGINT NOT NULL PRIMARY KEY', 'CUST_ID BIGINT', 'ORD_DT DATE', 'ORD_TOT_AMT NUMBER(18,2)', 'STAT_CD VARCHAR(10)'], question: 'Which table holds customer order headers in the legacy warehouse?', kind: 'abbreviation' },
    { system: 'edw', schema: 'EDW_FIN', name: 'GL_JRNL_LN', cols: ['GL_JRNL_LN_ID BIGINT NOT NULL PRIMARY KEY', 'ACCT_NO VARCHAR(30)', 'DR_AMT NUMBER(18,2)', 'CR_AMT NUMBER(18,2)', 'POST_DT DATE'], question: 'Where are general ledger journal lines with debit and credit amounts?', kind: 'abbreviation' },
    { system: 'edw', schema: 'EDW_OPS', name: 'WHSE_INVTY_SNAP', cols: ['WHSE_INVTY_SNAP_ID BIGINT NOT NULL PRIMARY KEY', 'WHSE_ID BIGINT', 'PROD_ID BIGINT', 'ON_HND_QTY INTEGER', 'SNAP_DT DATE'], question: 'Show the warehouse inventory snapshot with on-hand quantity', kind: 'abbreviation' },
    { system: 'acquired', schema: 'core', name: 'client_master_record', cols: ['client_master_record_id BIGINT NOT NULL PRIMARY KEY', 'client_name VARCHAR(200)', 'client_email VARCHAR(200)', 'onboarded_at TIMESTAMP'], question: 'Find the customer master in the acquired CRM', kind: 'cross-org' },
    { system: 'acquired', schema: 'loyalty', name: 'patron_reward_ledger', cols: ['patron_reward_ledger_id BIGINT NOT NULL PRIMARY KEY', 'patron_id BIGINT', 'points_earned INTEGER', 'points_redeemed INTEGER', 'posted_at TIMESTAMP'], question: 'Which table tracks loyalty points for members?', kind: 'cross-org' },
    { system: 'oms', schema: 'returns', name: 'money_back_requests', cols: ['money_back_request_id BIGINT NOT NULL PRIMARY KEY', 'order_id BIGINT', 'requested_amount NUMBER(18,2)', 'reason_code VARCHAR(10)'], question: 'Where are refund requests recorded?', kind: 'synonym', comment: 'Customer refund requests awaiting approval' },
    { system: 'erp', schema: 'proc', name: 'po_hdr', cols: ['po_hdr_id BIGINT NOT NULL PRIMARY KEY', 'supplier_id BIGINT', 'po_dt DATE', 'po_tot_amt NUMBER(18,2)'], question: 'List the purchase order headers sent to suppliers', kind: 'abbreviation' },
    { system: 'acquired', schema: 'svc', name: 'case_escalations', cols: ['case_escalation_id BIGINT NOT NULL PRIMARY KEY', 'case_id BIGINT', 'escalated_at TIMESTAMP', 'severity_cd VARCHAR(4)'], question: 'Which support tickets were escalated?', kind: 'cross-org' }
  ];
  const needles = [];
  for (const p of plant) {
    const f = files.find((x) => x.system === p.system);
    const fqn = `${p.schema}.${p.name}`;
    f.ddl += `CREATE TABLE ${fqn} (\n  ${p.cols.join(',\n  ')}\n);\n` + (p.comment ? `COMMENT ON TABLE ${fqn} IS '${p.comment}';\n` : '');
    tables++;
    columns += p.cols.length;
    needles.push({ id: `L${needles.length + 1}`, question: p.question, expect: `obj:${p.system}/prod/${fqn}`.toLowerCase(), kind: p.kind });
  }
  return { files, tables, columns, needles };
}

module.exports = { generateLargeEstate };

if (require.main === module) {
  const e = generateLargeEstate();
  console.log(`${e.files.length} files, ${e.tables} tables, ${e.columns} columns, ${e.files.reduce((n, f) => n + f.ddl.length, 0)} bytes`);
}
